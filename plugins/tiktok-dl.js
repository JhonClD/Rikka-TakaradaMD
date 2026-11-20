/*
 ☆ Plugin: TikTok Downloader — Videos HD, Imágenes (álbum) y Audio
 ☆ Comandos:
 ☆   .tt <url>           → descarga video HD sin marca de agua o imágenes en un solo álbum
 ☆   .tiktokaudio <url>  → descarga solo el audio MP3 del TikTok
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

const SERVICE = 'tiktok';
const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024;
const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024;
const MAX_ALBUM_ITEMS = 100;

const TIKTOK_URL_REGEX =
  /https?:\/\/(?:(?:www|m|vm|vt|t|lite)\.)?tiktok\.com\/[^\s<>]+/i;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const MEDIA_HEADERS = {
  ...REQUEST_HEADERS,
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

const formatCount = (n) => {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
};

const cleanText = (str = '', maxLen = 90) => {
  const s = String(str).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen).trim()}…` : s;
};

const sanitizeFileName = (str = '') => {
  const s = String(str)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
  return s || 'tiktok_media';
};

const extractTikTokUrl = (...sources) => {
  for (const src of sources) {
    if (!src) continue;
    const match = String(src).match(TIKTOK_URL_REGEX);
    if (match) return match[0].replace(/[),.!?;:'"\]}>]+$/g, '');
  }
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

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return;
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
  } catch {}
}

// ─── Proveedores de TikTok (videos + imágenes + audio) ────────

const toAbsoluteUrl = (u, base = 'https://www.tikwm.com') => {
  if (!u || typeof u !== 'string') return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${base}${trimmed}`;
  return null;
};

const flattenUrls = (value, base) => {
  const out = [];
  const walk = (item) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const el of item) walk(el);
    } else if (typeof item === 'string') {
      const abs = toAbsoluteUrl(item, base);
      if (abs) out.push(abs);
    } else if (typeof item === 'object') {
      const candidate =
        item.url || item.image_url || item.play || item.hdplay || item.noWatermark || item.src;
      if (candidate) walk(candidate);
      if (Array.isArray(item.urlList)) walk(item.urlList[0]);
    }
  };
  walk(value);
  return [...new Set(out)];
};

async function expandTikTokUrl(rawUrl, signal) {
  if (!/^https?:\/\/(?:vm|vt|t|lite)\.tiktok\.com\//i.test(rawUrl)) {
    return rawUrl;
  }
  try {
    const res = await axios.get(rawUrl, {
      maxRedirects: 5,
      timeout: 12_000,
      headers: {
        'User-Agent': REQUEST_HEADERS['User-Agent'],
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: () => true,
      signal,
    });
    const finalUrl = res.request?.res?.responseUrl || res.headers?.location || rawUrl;
    if (finalUrl && /tiktok\.com\/.*\/(?:video|photo)\/\d+/i.test(finalUrl)) {
      return finalUrl.split('?')[0];
    }
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
  }
  return rawUrl;
}

function normalizeTikwmData(d) {
  if (!d) return null;
  const images = flattenUrls(d.images, 'https://www.tikwm.com');
  const videoCandidates = flattenUrls(
    [d.hdplay, d.play, d.wmplay, d.video],
    'https://www.tikwm.com',
  ).filter((u) => !/\.mp3(\?|$)/i.test(u));
  const audio = toAbsoluteUrl(d.music || d.music_info?.play, 'https://www.tikwm.com');

  if (!images.length && !videoCandidates.length && !audio) return null;

  return {
    title: cleanText(d.title, 100),
    author: cleanText(d.author?.nickname || d.author?.unique_id, 50),
    username: d.author?.unique_id || null,
    duration: Number.isFinite(d.duration) ? d.duration : null,
    stats: {
      likes: Number.isFinite(d.digg_count) ? d.digg_count : null,
      views: Number.isFinite(d.play_count) ? d.play_count : null,
      comments: Number.isFinite(d.comment_count) ? d.comment_count : null,
    },
    images,
    videoCandidates,
    audio,
  };
}

async function fetchTikwmGet(url, signal) {
  const { data } = await axios.get('https://www.tikwm.com/api/', {
    params: { url, hd: 1 },
    headers: MEDIA_HEADERS,
    timeout: 20_000,
    signal,
  });
  if (data?.code !== 0) return null;
  return normalizeTikwmData(data.data);
}

async function fetchTikwmPost(url, signal) {
  const form = new URLSearchParams({ url, hd: '1' });
  const { data } = await axios.post('https://www.tikwm.com/api/', form.toString(), {
    headers: {
      ...MEDIA_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    timeout: 20_000,
    signal,
  });
  if (data?.code !== 0) return null;
  return normalizeTikwmData(data.data);
}

async function fetchTiklydown(url, signal) {
  const { data } = await axios.get(
    `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
    { headers: REQUEST_HEADERS, timeout: 15_000, signal },
  );
  if (!data) return null;

  const images = flattenUrls(data.images);
  const videoCandidates = flattenUrls([
    data.video?.noWatermark,
    data.video?.watermark,
    data.videoUrl,
  ]).filter((u) => !/\.mp3(\?|$)/i.test(u));
  const audio = toAbsoluteUrl(data.music?.play_url || data.music?.url);

  if (!images.length && !videoCandidates.length && !audio) return null;

  return {
    title: cleanText(data.title, 100),
    author: cleanText(data.author?.name || data.author?.unique_id, 50),
    username: data.author?.unique_id || null,
    duration: null,
    stats: {
      likes: Number.isFinite(data.stats?.likeCount) ? data.stats.likeCount : null,
      views: Number.isFinite(data.stats?.playCount) ? data.stats.playCount : null,
      comments: Number.isFinite(data.stats?.commentCount) ? data.stats.commentCount : null,
    },
    images,
    videoCandidates,
    audio,
  };
}

async function fetchSiputzx(url, signal) {
  const { data } = await axios.get(
    `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`,
    { headers: REQUEST_HEADERS, timeout: 15_000, signal },
  );
  const d = data?.data;
  if (!d) return null;

  const flatUrls = flattenUrls(d.urls);
  const explicitImages = flattenUrls([d.images, d.slides, d.slide, d.photos]);
  const isPhoto =
    d.type === 'image' ||
    d.type === 'slide' ||
    explicitImages.length > 0 ||
    (flatUrls.length > 1 && flatUrls.every((u) => !/\.mp4(\?|$)/i.test(u)));

  const images = explicitImages.length ? explicitImages : isPhoto ? flatUrls : [];
  const videoCandidates = isPhoto
    ? []
    : flattenUrls([d.hdplay, d.play, d.video, d.videos, flatUrls]).filter(
        (u) => !/\.mp3(\?|$)/i.test(u),
      );
  const audio = toAbsoluteUrl(d.music || d.audio);

  if (!images.length && !videoCandidates.length && !audio) return null;

  return {
    title: cleanText(d.metadata?.title || d.title, 100),
    author: cleanText(d.metadata?.creator || d.author, 50),
    username: null,
    duration: null,
    stats: { likes: null, views: null, comments: null },
    images,
    videoCandidates,
    audio,
  };
}

async function fetchRyzendesu(url, signal) {
  const { data } = await axios.get(
    `https://api.ryzendesu.vip/api/downloader/ttdl?url=${encodeURIComponent(url)}`,
    { headers: REQUEST_HEADERS, timeout: 15_000, signal },
  );
  const d = data?.data?.data || data?.data;
  if (!d) return null;
  return normalizeTikwmData(d);
}

async function fetchTikTokDirect(url, signal) {
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': REQUEST_HEADERS['User-Agent'],
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    timeout: 15_000,
    signal,
  });

  if (typeof html !== 'string') return null;
  const match = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) return null;

  const json = JSON.parse(match[1]);
  const detail =
    json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct ||
    json?.__DEFAULT_SCOPE__?.['webapp.photo-detail']?.itemInfo?.itemStruct;
  if (!detail) return null;

  const images = flattenUrls(detail.imagePost?.images?.map((img) => img?.imageURL?.urlList?.[0]));
  const videoCandidates = flattenUrls([
    detail.video?.playAddr,
    detail.video?.downloadAddr,
  ]).filter((u) => !/\.mp3(\?|$)/i.test(u));
  const audio = toAbsoluteUrl(detail.music?.playUrl);

  if (!images.length && !videoCandidates.length && !audio) return null;

  return {
    title: cleanText(detail.desc, 100),
    author: cleanText(detail.author?.nickname || detail.author?.uniqueId, 50),
    username: detail.author?.uniqueId || null,
    duration: Number.isFinite(detail.video?.duration) ? detail.video.duration : null,
    stats: {
      likes: Number.isFinite(detail.stats?.diggCount) ? detail.stats.diggCount : null,
      views: Number.isFinite(detail.stats?.playCount) ? detail.stats.playCount : null,
      comments: Number.isFinite(detail.stats?.commentCount) ? detail.stats.commentCount : null,
    },
    images,
    videoCandidates,
    audio,
  };
}

async function resolveTikTok(rawUrl, { audioOnly = false, signal } = {}) {
  const expandedUrl = await expandTikTokUrl(rawUrl, signal);
  const urlsToTry = expandedUrl !== rawUrl ? [expandedUrl, rawUrl] : [rawUrl];

  const hasWantedMedia = (info) =>
    audioOnly
      ? Boolean(info?.audio)
      : Boolean(info?.images?.length || info?.videoCandidates?.length);

  let audioFallback = null;

  for (const targetUrl of urlsToTry) {
    const providers = [
      () => fetchTikwmGet(targetUrl, signal),
      () => fetchTikwmPost(targetUrl, signal),
      () => fetchTiklydown(targetUrl, signal),
      () => fetchSiputzx(targetUrl, signal),
      () => fetchRyzendesu(targetUrl, signal),
      () => fetchTikTokDirect(targetUrl, signal),
    ];

    for (const provider of providers) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      try {
        const result = await provider();
        if (!result) continue;
        if (hasWantedMedia(result)) return result;
        if (!audioFallback && result.audio) audioFallback = result;
      } catch (err) {
        if (isAbortError(err) && signal?.aborted) throw err;
      }
    }
  }

  return audioOnly ? audioFallback : null;
}

// ─── Descarga y procesamiento de media ────────────────────────

async function fetchBuffer(url, { signal, maxBytes = MAX_DOCUMENT_LIMIT } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: MEDIA_HEADERS,
    timeout: 90_000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: (s) => s >= 200 && s < 300,
    signal,
  });

  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error('Respuesta vacía');
  if (buffer.length > maxBytes) throw new Error(`Archivo supera ${formatBytes(maxBytes)}`);

  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  if (isLikelyHtml(buffer, contentType)) {
    throw new Error('La fuente devolvió HTML en lugar de media');
  }

  return { buffer, contentType };
}

async function downloadBestVideo(candidates, signal) {
  let oversizedFallback = null;
  let lastError = null;

  for (const videoUrl of candidates) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const { buffer, contentType } = await fetchBuffer(videoUrl, {
        signal,
        maxBytes: MAX_DOCUMENT_LIMIT,
      });
      if (!isMp4(buffer) && !contentType.includes('video/')) {
        throw new Error(`Contenido no multimedia (${contentType || 'desconocido'})`);
      }
      if (buffer.length <= VIDEO_INLINE_LIMIT) {
        return { buffer, oversized: false };
      }
      if (!oversizedFallback || buffer.length < oversizedFallback.buffer.length) {
        oversizedFallback = { buffer, oversized: true };
      }
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
      lastError = err;
    }
  }

  if (oversizedFallback) return oversizedFallback;
  throw lastError || new Error('No se pudo descargar el video.');
}

async function remuxFaststart(buffer) {
  const ts = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpInput = join(tmpdir(), `tiktok_in_${ts}.mp4`);
  const tmpOutput = join(tmpdir(), `tiktok_out_${ts}.mp4`);
  try {
    writeFileSync(tmpInput, buffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', tmpInput,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        tmpOutput,
      ],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (existsSync(tmpOutput)) {
      const remuxed = readFileSync(tmpOutput);
      if (isMp4(remuxed)) return remuxed;
    }
  } catch (err) {
    console.warn('[TikTok-DL] Remux omitido, usando MP4 original:', err?.message || err);
  } finally {
    for (const file of [tmpInput, tmpOutput]) {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {}
      }
    }
  }
  return buffer;
}

async function sendImageGroup(conn, chat, images, caption, quoted) {
  if (images.length === 1) {
    await conn.sendMessage(
      chat,
      { image: images[0].buffer, mimetype: images[0].mimetype, caption },
      { quoted },
    );
    return;
  }

  for (let i = 0; i < images.length; i += MAX_ALBUM_ITEMS) {
    const slice = images.slice(i, i + MAX_ALBUM_ITEMS);
    const entries = slice.map((img, idx) => ({
      image: img.buffer,
      mimetype: img.mimetype,
      ...(i === 0 && idx === 0 && caption ? { caption } : {}),
    }));

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
      console.warn('[TikTok-DL] Falló envío en álbum, enviando por separado:', err?.message || err);
      for (const entry of entries) {
        await conn.sendMessage(chat, entry, { quoted });
      }
    }
  }
}

function buildCaption(info, { size, typeLabel, url }) {
  const userLabel = info.author && info.username && info.author !== info.username
    ? `${info.author} (@${info.username})`
    : info.author || (info.username ? `@${info.username}` : null);

  const statParts = [];
  const likes = formatCount(info.stats?.likes);
  const views = formatCount(info.stats?.views);
  const comments = formatCount(info.stats?.comments);
  if (likes) statParts.push(`♥ ${likes}`);
  if (views) statParts.push(`👁 ${views}`);
  if (comments) statParts.push(`💬 ${comments}`);

  const lines = ['🎵 *TIKTOK*', ''];
  if (userLabel) lines.push(`⭑ *Autor:* ${userLabel}`);
  if (info.title) lines.push(`⭑ *Título:* ${info.title}`);
  lines.push(`⭑ *Tipo:* ${typeLabel}`);
  lines.push(`⭑ *Peso:* ${size}`);
  if (statParts.length) lines.push(`⭑ *Stats:* ${statParts.join(' · ')}`);
  lines.push(`⭑ *URL:* ${url}`);
  return lines.join('\n');
}

// ─── Handler ─────────────────────────────────────────────────

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const url = extractTikTokUrl(
    text,
    args?.join(' '),
    m.quoted?.text,
    m.quoted?.caption,
  );

  if (!url) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `🎵 Envía un enlace de TikTok (video o fotos) junto al comando, o responde a un mensaje con el enlace.\n\n` +
          `*Ejemplo:*\n${usedPrefix + command} https://vt.tiktok.com/xxxxxxx/`,
      },
      { quoted: m },
    );
  }

  const key = downloadKey(m);
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una descarga de TikTok en curso. Usa *cancelar* si deseas detenerla.' },
      { quoted: m },
    );
  }

  const controller = new AbortController();
  const finish = startDownload(key, SERVICE, controller, { label: 'TikTok' });
  const audioOnly = /^tiktokaudio$/i.test(command || '');

  try {
    await safeReact(conn, m, '⏳');

    const info = await resolveTikTok(url, { audioOnly, signal: controller.signal });
    if (!info) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        { text: '❌ No se pudo obtener el contenido de ese TikTok. Verifica el enlace e intenta de nuevo.' },
        { quoted: m },
      );
    }

    // ── Modo solo audio (.tiktokaudio) ───────────────────────
    if (audioOnly) {
      if (!info.audio) {
        await safeReact(conn, m, '❌');
        return conn.sendMessage(
          m.chat,
          { text: '❌ Este TikTok no tiene pista de audio descargable.' },
          { quoted: m },
        );
      }

      const { buffer } = await fetchBuffer(info.audio, {
        signal: controller.signal,
        maxBytes: VIDEO_INLINE_LIMIT,
      });

      await conn.sendMessage(
        m.chat,
        {
          audio: buffer,
          mimetype: 'audio/mpeg',
          fileName: `${sanitizeFileName(info.title || info.username)}.mp3`,
        },
        { quoted: m },
      );
      await safeReact(conn, m, '✅');
      return;
    }

    // ── Modo imágenes / slideshow (álbum único) ──────────────
    if (info.images.length) {
      const settled = await Promise.allSettled(
        info.images.map(async (imgUrl) => {
          const { buffer, contentType } = await fetchBuffer(imgUrl, {
            signal: controller.signal,
            maxBytes: VIDEO_INLINE_LIMIT,
          });
          return {
            buffer,
            size: buffer.length,
            mimetype: detectImageMime(buffer, contentType),
          };
        }),
      );

      const downloadedImages = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') downloadedImages.push(r.value);
        else if (isAbortError(r.reason) && controller.signal.aborted) throw r.reason;
      }

      if (!downloadedImages.length) {
        await safeReact(conn, m, '❌');
        return conn.sendMessage(
          m.chat,
          { text: '❌ No se pudieron descargar las imágenes de ese TikTok.' },
          { quoted: m },
        );
      }

      const totalBytes = downloadedImages.reduce((acc, img) => acc + img.size, 0);
      const caption = buildCaption(info, {
        size: formatBytes(totalBytes),
        typeLabel:
          downloadedImages.length > 1
            ? `Álbum (${downloadedImages.length} imágenes)`
            : downloadedImages[0].mimetype,
        url,
      });

      await sendImageGroup(conn, m.chat, downloadedImages, caption, m);
      await safeReact(conn, m, '✅');
      return;
    }

    // ── Modo video ───────────────────────────────────────────
    if (!info.videoCandidates.length) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        { text: '❌ No se encontró ningún video ni imagen en ese enlace de TikTok.' },
        { quoted: m },
      );
    }

    const { buffer: rawVideo, oversized } = await downloadBestVideo(
      info.videoCandidates,
      controller.signal,
    );
    const finalBuffer = await remuxFaststart(rawVideo);
    const caption = buildCaption(info, {
      size: formatBytes(finalBuffer.length),
      typeLabel: 'Video HD (MP4)',
      url,
    });

    if (oversized || finalBuffer.length > VIDEO_INLINE_LIMIT) {
      await conn.sendMessage(
        m.chat,
        {
          document: finalBuffer,
          mimetype: 'video/mp4',
          fileName: `${sanitizeFileName(info.title || info.username)}.mp4`,
          caption,
        },
        { quoted: m },
      );
    } else {
      await conn.sendMessage(
        m.chat,
        {
          video: finalBuffer,
          mimetype: 'video/mp4',
          caption,
        },
        { quoted: m },
      );
    }

    await safeReact(conn, m, '✅');
  } catch (e) {
    if (isAbortError(e) && controller.signal.aborted) {
      await safeReact(conn, m, '🛑');
      return conn.sendMessage(
        m.chat,
        { text: '🛑 Descarga de TikTok cancelada.' },
        { quoted: m },
      );
    }
    console.error('[TikTok-DL]', e?.message || e);
    await safeReact(conn, m, '❌');
    return conn.sendMessage(
      m.chat,
      { text: `❌ Error al descargar el TikTok.\n\`${e?.message || e}\`` },
      { quoted: m },
    );
  } finally {
    finish();
  }
};

handler.help = ['tiktok <url>', 'tiktokaudio <url>'];
handler.tags = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;
