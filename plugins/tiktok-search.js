/*
 ☆ Plugin: TikTok Search — Búsqueda rápida de videos e imágenes en álbum
 ☆ Uso:
 ☆   .tts <búsqueda>            → 1 resultado rápido
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ─── Capa HTTP con huella Chrome (wreq-js → impit → axios) ────

let wreqMod = null;
let wreqFailed = false;
async function getWreq() {
  if (wreqMod || wreqFailed) return wreqMod;
  try {
    wreqMod = await import('wreq-js');
  } catch {
    wreqFailed = true;
  }
  return wreqMod;
}

let impitClient = null;
let impitFailed = false;
async function getImpit() {
  if (impitClient || impitFailed) return impitClient;
  try {
    const { Impit } = await import('impit');
    impitClient = new Impit({ browser: 'chrome136', timeout: 15_000 });
  } catch {
    impitFailed = true;
  }
  return impitClient;
}

function combineSignal(signal, timeoutMs) {
  const own = AbortSignal.timeout(timeoutMs);
  if (!signal) return own;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, own]);
  return signal;
}

const isAbortError = (err) =>
  err?.name === 'AbortError' ||
  err?.name === 'CanceledError' ||
  err?.code === 'ERR_CANCELED' ||
  err?.code === 'ABORT_ERR';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = 15_000, signal } = {}) {
  const reqHeaders = { Accept: 'application/json, text/plain, */*', ...headers };
  let lastErr = null;

  const wreq = await getWreq();
  if (wreq?.fetch) {
    try {
      const res = await wreq.fetch(url, {
        browser: 'chrome_136',
        os: 'windows',
        method,
        headers: reqHeaders,
        redirect: 'follow',
        ...(body == null ? {} : { body }),
        signal: combineSignal(signal, timeout),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`wreq HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
      lastErr = err;
    }
  }

  const impit = await getImpit();
  if (impit) {
    try {
      const res = await impit.fetch(url, {
        method,
        headers: reqHeaders,
        ...(body == null ? {} : { body }),
        signal: combineSignal(signal, timeout),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`impit HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
      lastErr = err;
    }
  }

  try {
    const res = await axios.request({
      url,
      method,
      headers: { 'User-Agent': UA, ...reqHeaders },
      data: body ?? undefined,
      timeout,
      signal,
    });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
    throw lastErr || err;
  }
}

// ─── Utilidades ───────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const toAbsoluteUrl = (u, base = 'https://www.tikwm.com') => {
  if (!u || typeof u !== 'string') return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${base}${trimmed}`;
  return null;
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

function buildDownloadHeaders(url) {
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('tikwm.com')) {
      headers.Referer = 'https://www.tikwm.com/';
    } else if (
      host.includes('tiktok.com') ||
      host.includes('tiktokcdn') ||
      host.includes('byteoversea') ||
      host.includes('muscdn')
    ) {
      headers.Referer = 'https://www.tiktok.com/';
    }
  } catch {}
  return headers;
}

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return;
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
  } catch {}
}

// ─── Compresión segura (solo si supera 50 MB) ─────────────────

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

// ─── Búsqueda multi-fuente con TLS de Chrome ──────────────────

function extractListFromPayload(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data?.videos)) return data.data.videos;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result?.videos)) return data.result.videos;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function parseSearchList(list, base = 'https://www.tikwm.com') {
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const rawImages = v.images || v.slides || v.photos;
    if (Array.isArray(rawImages) && rawImages.length) {
      for (const raw of rawImages) {
        const imgUrl = toAbsoluteUrl(
          typeof raw === 'string' ? raw : raw?.url || raw?.image_url,
          base,
        );
        if (imgUrl) items.push({ kind: 'photo', url: imgUrl, title: v.title || '' });
      }
      continue;
    }

    // Priorizamos `play`/`nowm` (sin marca de agua y ligero) para entrega rápida
    const candidates = [
      v.play,
      v.nowm,
      v.no_watermark,
      v.hdplay,
      v.hd,
      v.video_url,
      typeof v.video === 'string' ? v.video : v.video?.play || v.video?.noWatermark,
      v.media?.play,
      v.wm,
      v.wmplay,
    ]
      .map((u) => toAbsoluteUrl(u, base))
      .filter((u) => u && !/\.mp3(\?|$)/i.test(u));

    if (candidates.length) {
      items.push({ kind: 'video', urls: [...new Set(candidates)], title: v.title || '' });
    }
  }
  return items;
}

async function searchTikwm(query, fetchCount, signal) {
  const url = `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(query)}&count=${fetchCount}&cursor=0&hd=1`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await requestJson(url, { timeout: 15_000, signal });
    const items = parseSearchList(extractListFromPayload(data), 'https://www.tikwm.com');
    if (items.length) return items;
    if (data?.code === -1 && attempt === 0 && !signal?.aborted) {
      await sleep(1100);
      continue;
    }
    // Respaldo POST a TikWM (formato web)
    if (attempt === 0 && !signal?.aborted) {
      const form = new URLSearchParams({
        keywords: query,
        count: String(fetchCount),
        cursor: '0',
        web: '1',
        hd: '1',
      });
      const postData = await requestJson('https://www.tikwm.com/api/feed/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: 'https://www.tikwm.com',
          Referer: 'https://www.tikwm.com/',
        },
        body: form.toString(),
        timeout: 15_000,
        signal,
      });
      const postItems = parseSearchList(extractListFromPayload(postData), 'https://www.tikwm.com');
      if (postItems.length) return postItems;
    }
    throw new Error(data?.msg || 'TikWM vacío');
  }
  throw new Error('TikWM vacío');
}

async function searchTikTok(query, count, signal) {
  const fetchCount = Math.min(30, Math.max(15, count + 6));
  const encoded = encodeURIComponent(query);

  const providers = [
    {
      name: 'TikWM',
      run: () => searchTikwm(query, fetchCount, signal),
    },
    {
      name: 'Ryzumi',
      run: async () => {
        const data = await requestJson(
          `https://api.ryzumi.vip/api/search/tiktok?query=${encoded}`,
          { timeout: 12_000, signal },
        );
        const items = parseSearchList(extractListFromPayload(data));
        if (!items.length) throw new Error('Ryzumi vacío');
        return items;
      },
    },
    {
      name: 'Vreden',
      run: async () => {
        const data = await requestJson(
          `https://api.vreden.my.id/api/tiktoksearch?query=${encoded}`,
          { timeout: 12_000, signal },
        );
        const items = parseSearchList(extractListFromPayload(data));
        if (!items.length) throw new Error('Vreden vacío');
        return items;
      },
    },
  ];

  try {
    return await Promise.any(
      providers.map(async ({ name, run }) => {
        try {
          return await run();
        } catch (err) {
          if (!signal?.aborted) {
            console.warn(`[TikTok-TTS] ${name} falló:`, err?.message || err);
          }
          throw err;
        }
      }),
    );
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    return [];
  }
}

// ─── Descarga rápida de resultados ────────────────────────────

async function fetchMediaBuffer(url, { signal, maxBytes }) {
  const headers = buildDownloadHeaders(url);
  let lastErr = null;

  // 1. Axios directo (más rápido para binarios grandes si no hay bloqueo TLS)
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 60_000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (s) => s >= 200 && s < 300,
      signal,
    });
    const buffer = Buffer.from(res.data);
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (!buffer.length || isLikelyHtml(buffer, contentType)) {
      throw new Error('Respuesta inválida');
    }
    return { buffer, contentType };
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
    lastErr = err;
  }

  // 2. Respaldo con huella Chrome (wreq-js) si el CDN devolvió 403 a axios
  const wreq = await getWreq();
  if (wreq?.fetch) {
    try {
      const res = await wreq.fetch(url, {
        browser: 'chrome_136',
        os: 'windows',
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: combineSignal(signal, 60_000),
      });
      if (!res.ok) throw new Error(`wreq HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (!buffer.length || buffer.length > maxBytes || isLikelyHtml(buffer, contentType)) {
        throw new Error('Respuesta inválida');
      }
      return { buffer, contentType };
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
      lastErr = err;
    }
  }

  throw lastErr || new Error('Error al descargar');
}

async function downloadResult(item, index, ts, signal) {
  if (item.kind === 'photo') {
    const { buffer, contentType } = await fetchMediaBuffer(item.url, {
      signal,
      maxBytes: VIDEO_INLINE_LIMIT,
    });
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
        const { buffer: candidate, contentType } = await fetchMediaBuffer(url, {
          signal,
          maxBytes: MAX_DOCUMENT_LIMIT,
        });
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

    // Solo recomprime si realmente supera el límite inline de WhatsApp (50 MB)
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

/** Descarga exactamente `targetCount` resultados sin desperdiciar ancho de banda. */
async function downloadExactCount(results, targetCount, ts, signal) {
  const downloaded = [];
  let cursor = 0;

  while (downloaded.length < targetCount && cursor < results.length) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const needed = targetCount - downloaded.length;
    const batch = results.slice(cursor, cursor + needed);
    const startIdx = cursor;
    cursor += batch.length;

    const settled = await Promise.allSettled(
      batch.map((item, i) => downloadResult(item, startIdx + i, ts, signal)),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') downloaded.push(r.value);
      else if (isAbortError(r.reason) && signal?.aborted) throw r.reason;
    }
  }

  return downloaded;
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
    const downloaded = await downloadExactCount(results, cantidad, ts, controller.signal);

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
