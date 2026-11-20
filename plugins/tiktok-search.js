/*
 ☆ Plugin: TikTok Search — Búsqueda de videos e imágenes agrupados en álbum
 ☆ Uso:
 ☆   .tts <búsqueda>            → 1 resultado
 ☆   .tts <cantidad> <búsqueda> → hasta 20 resultados enviados juntos en un solo álbum
*/

import axios from 'axios';
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  downloadKey,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js';

const execFileAsync = promisify(execFile);

const SERVICE = 'tiktok-search';
const MAX_RESULTS = 20;
const MAX_ALBUM_ITEMS = 100;
const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024;
const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.tikwm.com/',
};

// ─── Utilidades ───────────────────────────────────────────────

const isAbortError = (err) =>
  err?.name === 'AbortError' ||
  err?.name === 'CanceledError' ||
  err?.code === 'ERR_CANCELED' ||
  err?.code === 'ABORT_ERR';

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const isMp4 = (buffer) =>
  Buffer.isBuffer(buffer) &&
  buffer.length > 12 &&
  buffer.subarray(4, 12).toString('ascii').includes('ftyp');

const isLikelyHtml = (buffer, contentType = '') => {
  if (String(contentType).toLowerCase().includes('text/html')) return true;
  const head = buffer.subarray(0, 32).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
};

const detectImageMime = (buffer, contentType = '') => {
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
      return 'image/gif';
    }
  }
  return 'image/jpeg';
};

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return;
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
  } catch {}
}

// ─── Compresión segura (solo si supera el límite inline) ──────

async function compressForWhatsApp(inputPath, outputPath, targetMB) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ],
    { timeout: 30_000 },
  );

  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No se pudo obtener la duración del video');
  }

  const targetBits = targetMB * 1024 * 1024 * 8;
  const audioBitrate = 96;
  const videoBitrate = Math.floor(targetBits / duration / 1000) - audioBitrate;
  if (videoBitrate < 100) {
    throw new Error('Video demasiado largo para comprimir con calidad mínima');
  }

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.floor(videoBitrate * 1.5)}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart',
      '-preset', 'fast',
      outputPath,
    ],
    { timeout: 300_000 },
  );

  return readFileSync(outputPath);
}

// ─── Búsqueda multi-fuente (videos + imágenes) ────────────────

async function searchTikTok(query, count, signal) {
  const providers = [
    async () => {
      const { data } = await axios.get('https://www.tikwm.com/api/feed/search', {
        params: { keywords: query, count: Math.min(30, count + 8), cursor: 0, hd: 1 },
        headers: REQUEST_HEADERS,
        timeout: 15_000,
        signal,
      });
      const list = data?.data?.videos;
      if (!Array.isArray(list)) return [];
      const items = [];
      for (const v of list) {
        if (Array.isArray(v.images) && v.images.length) {
          for (const imgUrl of v.images) {
            if (imgUrl) items.push({ kind: 'photo', url: imgUrl, title: v.title || '' });
          }
        } else if (v.hdplay || v.play) {
          items.push({
            kind: 'video',
            urls: [v.hdplay, v.play].filter(Boolean),
            title: v.title || '',
          });
        }
      }
      return items;
    },
    async () => {
      const { data } = await axios.get(
        `https://api.siputzx.my.id/api/s/tiktok?query=${encodeURIComponent(query)}`,
        { headers: REQUEST_HEADERS, timeout: 15_000, signal },
      );
      const list = Array.isArray(data?.data) ? data.data : [];
      const items = [];
      for (const v of list) {
        if (Array.isArray(v.images) && v.images.length) {
          for (const imgUrl of v.images) {
            if (imgUrl) items.push({ kind: 'photo', url: imgUrl, title: v.title || '' });
          }
        } else if (v.hdplay || v.play || v.video) {
          items.push({
            kind: 'video',
            urls: [v.hdplay, v.play, v.video].filter(Boolean),
            title: v.title || '',
          });
        }
      }
      return items;
    },
  ];

  for (const provider of providers) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const results = await provider();
      if (results.length) return results;
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
    }
  }
  return [];
}

// ─── Descarga de resultados ───────────────────────────────────

async function downloadResult(item, index, ts, signal) {
  if (item.kind === 'photo') {
    const res = await axios.get(item.url, {
      responseType: 'arraybuffer',
      headers: REQUEST_HEADERS,
      timeout: 45_000,
      maxContentLength: VIDEO_INLINE_LIMIT,
      maxBodyLength: VIDEO_INLINE_LIMIT,
      signal,
    });
    const buffer = Buffer.from(res.data);
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (!buffer.length || isLikelyHtml(buffer, contentType)) {
      throw new Error('Imagen inválida');
    }
    return {
      kind: 'photo',
      buffer,
      size: buffer.length,
      mimetype: detectImageMime(buffer, contentType),
      oversized: false,
    };
  }

  const tmpInput = join(tmpdir(), `tts_in_${process.pid}_${ts}_${index}.mp4`);
  const tmpComp = join(tmpdir(), `tts_comp_${process.pid}_${ts}_${index}.mp4`);

  try {
    let buffer = null;
    let lastErr = null;

    for (const url of item.urls || []) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      try {
        const res = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: REQUEST_HEADERS,
          timeout: 90_000,
          maxContentLength: MAX_DOCUMENT_LIMIT,
          maxBodyLength: MAX_DOCUMENT_LIMIT,
          signal,
        });
        const candidate = Buffer.from(res.data);
        const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
        if (!candidate.length || isLikelyHtml(candidate, contentType)) {
          throw new Error('Respuesta no es un video válido');
        }
        if (!isMp4(candidate) && !contentType.includes('video/')) {
          throw new Error(`Contenido inesperado (${contentType || 'desconocido'})`);
        }
        buffer = candidate;
        break;
      } catch (err) {
        if (isAbortError(err) && signal?.aborted) throw err;
        lastErr = err;
      }
    }

    if (!buffer) throw lastErr || new Error('No se pudo descargar el video');

    // Solo recomprime si realmente supera el límite inline de WhatsApp
    if (buffer.length > VIDEO_INLINE_LIMIT) {
      writeFileSync(tmpInput, buffer);
      try {
        buffer = await compressForWhatsApp(tmpInput, tmpComp, 45);
      } catch (err) {
        console.warn(`[TikTok-TTS] Compresión falló video ${index + 1}:`, err?.message || err);
      }
    }

    return {
      kind: 'video',
      buffer,
      size: buffer.length,
      mimetype: 'video/mp4',
      oversized: buffer.length > VIDEO_INLINE_LIMIT,
    };
  } finally {
    for (const f of [tmpInput, tmpComp]) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
  }
}

async function sendMediaGroup(conn, chat, items, caption, quoted) {
  if (!items.length) return;

  if (items.length === 1) {
    const only = items[0];
    if (only.kind === 'photo') {
      await conn.sendMessage(
        chat,
        { image: only.buffer, mimetype: only.mimetype, caption },
        { quoted },
      );
    } else {
      await conn.sendMessage(
        chat,
        { video: only.buffer, mimetype: 'video/mp4', caption },
        { quoted },
      );
    }
    return;
  }

  for (let i = 0; i < items.length; i += MAX_ALBUM_ITEMS) {
    const slice = items.slice(i, i + MAX_ALBUM_ITEMS);
    const entries = slice.map((item, idx) => {
      const withCaption = i === 0 && idx === 0 && caption ? { caption } : {};
      if (item.kind === 'photo') {
        return { image: item.buffer, mimetype: item.mimetype, ...withCaption };
      }
      return { video: item.buffer, mimetype: 'video/mp4', ...withCaption };
    });

    if (entries.length === 1) {
      await conn.sendMessage(chat, entries[0], { quoted });
      continue;
    }

    try {
      await conn.sendMessage(
        chat,
        { album: entries },
        { quoted, albumContinueOnError: true },
      );
    } catch (err) {
      console.warn('[TikTok-TTS] Falló envío en álbum, enviando por separado:', err?.message || err);
      for (const entry of entries) {
        await conn.sendMessage(chat, entry, { quoted });
      }
    }
  }
}

function describeResults(items) {
  let photos = 0;
  let videos = 0;
  for (const it of items) {
    if (it.kind === 'photo') photos++;
    else videos++;
  }
  const parts = [];
  if (videos) parts.push(`${videos} ${videos === 1 ? 'video' : 'videos'}`);
  if (photos) parts.push(`${photos} ${photos === 1 ? 'imagen' : 'imágenes'}`);
  return parts.join(' + ') || 'N/A';
}

// ─── Handler ─────────────────────────────────────────────────

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text?.trim()) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `🎵 *Uso:* ${usedPrefix + command} [cantidad] <búsqueda>\n` +
          `*Ejemplo:* ${usedPrefix + command} 5 gatos graciosos`,
      },
      { quoted: m },
    );
  }

  let cantidad = 1;
  let query = text.trim();

  if (args?.length > 1 && /^\d+$/.test(args[0])) {
    cantidad = Math.max(1, Math.min(parseInt(args[0], 10), MAX_RESULTS));
    query = args.slice(1).join(' ').trim();
  }

  if (!query) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `🎵 Ingresa un término de búsqueda.\n` +
          `*Ejemplo:* ${usedPrefix + command} 3 baile viral`,
      },
      { quoted: m },
    );
  }

  const key = downloadKey(m);
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una búsqueda de TikTok en curso. Usa *cancelar* si deseas detenerla.' },
      { quoted: m },
    );
  }

  const controller = new AbortController();
  const finish = startDownload(key, SERVICE, controller, { label: 'TikTok Search' });

  try {
    await safeReact(conn, m, '🔍');

    const results = await searchTikTok(query, cantidad, controller.signal);
    if (!results.length) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        { text: `❌ No se encontraron resultados en TikTok para: *${query}*` },
        { quoted: m },
      );
    }

    await safeReact(conn, m, '⬇️');

    const ts = Date.now();
    const candidates = results.slice(0, Math.min(results.length, cantidad + 3));
    const settled = await Promise.allSettled(
      candidates.map((item, i) => downloadResult(item, i, ts, controller.signal)),
    );

    const downloaded = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        downloaded.push(r.value);
        if (downloaded.length >= cantidad) break;
      } else if (isAbortError(r.reason) && controller.signal.aborted) {
        throw r.reason;
      }
    }

    if (!downloaded.length) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        { text: '❌ No se pudo descargar ningún resultado de esa búsqueda.' },
        { quoted: m },
      );
    }

    const inlineItems = downloaded.filter((it) => !it.oversized);
    const docItems = downloaded.filter((it) => it.oversized);
    const totalSize = downloaded.reduce((acc, it) => acc + (it.size || 0), 0);

    const caption =
      `🎵 *TIKTOK SEARCH*\n\n` +
      `⭑ *Búsqueda:* ${query}\n` +
      `⭑ *Contenido:* ${describeResults(downloaded)}\n` +
      `⭑ *Peso total:* ${formatBytes(totalSize)}`;

    if (inlineItems.length) {
      await sendMediaGroup(conn, m.chat, inlineItems, caption, m);
    }

    for (let i = 0; i < docItems.length; i++) {
      await conn.sendMessage(
        m.chat,
        {
          document: docItems[i].buffer,
          mimetype: 'video/mp4',
          fileName: `tiktok_${ts}_${i + 1}.mp4`,
          caption: inlineItems.length ? undefined : caption,
        },
        { quoted: m },
      );
    }

    await safeReact(conn, m, '✅');
  } catch (err) {
    if (isAbortError(err) && controller.signal.aborted) {
      await safeReact(conn, m, '🛑');
      return conn.sendMessage(
        m.chat,
        { text: '🛑 Búsqueda de TikTok cancelada.' },
        { quoted: m },
      );
    }
    console.error('[TikTok-TTS]', err?.message || err);
    await safeReact(conn, m, '❌');
    return conn.sendMessage(
      m.chat,
      { text: `❌ Error en la búsqueda de TikTok.\n\`${err?.message || err}\`` },
      { quoted: m },
    );
  } finally {
    finish();
  }
};

handler.help = ['tts [cantidad] <búsqueda>'];
handler.tags = ['downloader'];
handler.command = /^tts$/i;

export default handler;
