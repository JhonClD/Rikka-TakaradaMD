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

function extractCookies(headersObj) {
  if (!headersObj) return '';
  if (typeof headersObj.getSetCookie === 'function') {
    const list = headersObj.getSetCookie();
    if (Array.isArray(list) && list.length) {
      return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    }
  }
  const raw =
    typeof headersObj.get === 'function'
      ? headersObj.get('set-cookie')
      : headersObj['set-cookie'];
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  }
  return String(raw)
    .split(/,(?=\s*[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function requestText(
  url,
  { method = 'GET', headers = {}, body = null, timeout = 15_000, signal } = {},
) {
  const reqHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    ...headers,
  };
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
      return { text, cookies: extractCookies(res.headers) };
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
      return { text, cookies: extractCookies(res.headers) };
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
      responseType: 'text',
      timeout,
      signal,
    });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return { text, cookies: extractCookies(res.headers) };
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
    throw lastErr || err;
  }
}

async function requestJson(url, opts = {}) {
  const { text } = await requestText(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) },
  });
  return JSON.parse(text);
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

function buildDownloadHeaders(url, extra = {}) {
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
      headers.Origin = 'https://www.tiktok.com';
    }
  } catch {}
  return { ...headers, ...extra };
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

// ─── Búsqueda multi-fuente (TikWM + DuckDuckGo + Bing + TikTok) ─

function extractTikTokPostUrls(html) {
  const seenIds = new Set();
  const urls = [];

  const addUrl = (raw) => {
    if (!raw) return;
    let clean = raw;
    try {
      clean = decodeURIComponent(raw);
    } catch {}
    const m = clean.match(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9._-]+)\/(video|photo)\/(\d{10,25})/i);
    if (!m) return;
    const id = m[3];
    if (seenIds.has(id)) return;
    seenIds.add(id);
    urls.push(`https://www.tiktok.com/@${m[1]}/${m[2].toLowerCase()}/${id}`);
  };

  // Enlaces directos en HTML
  for (const m of html.matchAll(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[A-Za-z0-9._-]+\/(?:video|photo)\/\d{10,25}/gi)) {
    addUrl(m[0]);
  }
  // Enlaces codificados (ej. DuckDuckGo uddg=https%3A%2F%2Fwww.tiktok.com...)
  for (const m of html.matchAll(/https%3A%2F%2F(?:www\.|m\.)?tiktok\.com%2F%40[A-Za-z0-9._%-]+%2F(?:video|photo)%2F\d{10,25}/gi)) {
    addUrl(m[0]);
  }

  return urls;
}

function parseTikwmList(list) {
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v.images) && v.images.length) {
      for (const raw of v.images) {
        const imgUrl = toAbsoluteUrl(typeof raw === 'string' ? raw : raw?.url);
        if (imgUrl) items.push({ kind: 'photo', url: imgUrl, title: v.title || '' });
      }
      continue;
    }
    const candidates = [v.play, v.hdplay, v.wmplay]
      .map((u) => toAbsoluteUrl(u))
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
    const data = await requestJson(url, { timeout: 10_000, signal });
    const items = parseTikwmList(data?.data?.videos);
    if (items.length) return items;
    if (data?.code === -1 && attempt === 0 && !signal?.aborted) {
      await sleep(1100);
      continue;
    }
    throw new Error(data?.msg || 'TikWM vacío');
  }
  throw new Error('TikWM vacío');
}

async function searchDuckDuckGo(query, signal) {
  const q = encodeURIComponent(`site:tiktok.com ${query}`);
  const { text: html } = await requestText(`https://html.duckduckgo.com/html/?q=${q}`, {
    timeout: 12_000,
    signal,
  });
  const urls = extractTikTokPostUrls(html);
  if (!urls.length) throw new Error('DuckDuckGo sin enlaces de TikTok');
  return urls.map((url) => ({ kind: 'post', url }));
}

async function searchBing(query, signal) {
  const q = encodeURIComponent(`site:tiktok.com ${query}`);
  const { text: html } = await requestText(`https://www.bing.com/search?q=${q}&count=30`, {
    timeout: 12_000,
    signal,
  });
  const urls = extractTikTokPostUrls(html);
  if (!urls.length) throw new Error('Bing sin enlaces de TikTok');
  return urls.map((url) => ({ kind: 'post', url }));
}

async function searchTikTokTag(query, signal) {
  const tag = query
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();
  if (!tag) throw new Error('Tag vacío');

  const { text: html } = await requestText(`https://www.tiktok.com/tag/${encodeURIComponent(tag)}`, {
    timeout: 12_000,
    signal,
  });
  const urls = extractTikTokPostUrls(html);
  if (!urls.length) throw new Error('TikTok tag sin resultados');
  return urls.map((url) => ({ kind: 'post', url }));
}

async function searchTikTok(query, count, signal) {
  const fetchCount = Math.min(30, Math.max(15, count + 6));

  const providers = [
    { name: 'TikWM', run: () => searchTikwm(query, fetchCount, signal) },
    { name: 'DuckDuckGo', run: () => searchDuckDuckGo(query, signal) },
    { name: 'Bing', run: () => searchBing(query, signal) },
    { name: 'TikTokTag', run: () => searchTikTokTag(query, signal) },
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

// ─── Resolución directa de un post de TikTok (video o fotos) ──

async function resolvePostUrl(postUrl, signal) {
  // 1. Scraping directo del HTML del post (con cookies para el CDN oficial)
  try {
    const { text: html, cookies } = await requestText(postUrl, { timeout: 15_000, signal });
    const match = html.match(
      /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (match?.[1]) {
      const json = JSON.parse(match[1]);
      const detail =
        json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct ||
        json?.__DEFAULT_SCOPE__?.['webapp.photo-detail']?.itemInfo?.itemStruct;

      if (detail) {
        const dlHeaders = {
          Referer: 'https://www.tiktok.com/',
          Origin: 'https://www.tiktok.com',
          ...(cookies ? { Cookie: cookies } : {}),
        };

        const photos = (detail.imagePost?.images || [])
          .map((img) => img?.imageURL?.urlList?.[0])
          .filter(Boolean);
        if (photos.length) {
          return { kind: 'photo', url: photos[0], headers: dlHeaders };
        }

        const videoUrls = [detail.video?.playAddr, detail.video?.downloadAddr].filter(Boolean);
        if (videoUrls.length) {
          return { kind: 'video', urls: videoUrls, headers: dlHeaders };
        }
      }
    }
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
  }

  // 2. Respaldo Tiklydown
  try {
    const data = await requestJson(
      `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(postUrl)}`,
      { timeout: 12_000, signal },
    );
    const photos = (Array.isArray(data?.images) ? data.images : [])
      .map((i) => (typeof i === 'string' ? i : i?.url))
      .filter(Boolean);
    if (photos.length) return { kind: 'photo', url: photos[0], headers: {} };

    const videoUrls = [data?.video?.noWatermark, data?.video?.watermark].filter(Boolean);
    if (videoUrls.length) return { kind: 'video', urls: videoUrls, headers: {} };
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
  }

  throw new Error('No se pudo extraer media del post');
}

// ─── Descarga rápida de resultados ────────────────────────────

async function fetchMediaBuffer(url, { headers = {}, signal, maxBytes }) {
  const reqHeaders = buildDownloadHeaders(url, headers);
  let lastErr = null;

  // 1. Axios directo (más rápido para binarios)
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: reqHeaders,
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
        headers: reqHeaders,
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

async function downloadResult(rawItem, index, ts, signal) {
  const item = rawItem.kind === 'post' ? await resolvePostUrl(rawItem.url, signal) : rawItem;
  const headers = item.headers || {};

  if (item.kind === 'photo') {
    const { buffer, contentType } = await fetchMediaBuffer(item.url, {
      headers,
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
          headers,
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
