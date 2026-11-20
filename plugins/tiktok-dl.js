/*
 ☆ Plugin: TikTok Downloader — Rápido y limpio (sin caption)
 ☆ Comandos:
 ☆   .tt <url>           → video sin marca de agua o imágenes agrupadas en un solo álbum
 ☆   .tiktokaudio <url>  → solo el audio MP3 del TikTok
*/

import axios from 'axios';
import {
  downloadKey,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js';

const SERVICE = 'tiktok';
const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024;
const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024;
const MAX_ALBUM_ITEMS = 100;

const TIKTOK_URL_REGEX =
  /https?:\/\/(?:(?:www|m|vm|vt|t|lite)\.)?tiktok\.com\/[^\s<>]+/i;

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

async function requestText(url, { headers = {}, timeout = 12_000, signal } = {}) {
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
        method: 'GET',
        headers: reqHeaders,
        redirect: 'follow',
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
        method: 'GET',
        headers: reqHeaders,
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
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, ...reqHeaders },
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

// ─── Proveedores rápidos (carrera en paralelo) ────────────────

async function fetchTikTokDirect(url, signal) {
  const { text: html, cookies } = await requestText(url, { timeout: 12_000, signal });
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
    images,
    videoCandidates,
    audio,
    downloadHeaders: {
      Referer: 'https://www.tiktok.com/',
      Origin: 'https://www.tiktok.com',
      ...(cookies ? { Cookie: cookies } : {}),
    },
  };
}

async function fetchTiklydown(url, signal) {
  const data = await requestJson(
    `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
    { timeout: 10_000, signal },
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
  return { images, videoCandidates, audio, downloadHeaders: {} };
}

async function fetchTikwm(url, signal) {
  const data = await requestJson(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
    { timeout: 10_000, signal },
  );
  const d = data?.code === 0 ? data.data : null;
  if (!d) return null;

  const images = flattenUrls(d.images, 'https://www.tikwm.com');
  const videoCandidates = flattenUrls(
    [d.play, d.hdplay, d.wmplay],
    'https://www.tikwm.com',
  ).filter((u) => !/\.mp3(\?|$)/i.test(u));
  const audio = toAbsoluteUrl(d.music || d.music_info?.play, 'https://www.tikwm.com');

  if (!images.length && !videoCandidates.length && !audio) return null;
  return { images, videoCandidates, audio, downloadHeaders: {} };
}

// ─── Descarga rápida de media ─────────────────────────────────

function buildDownloadHeaders(url, extra = {}) {
  const base = { 'User-Agent': UA, Accept: '*/*' };
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('tikwm.com')) {
      base.Referer = 'https://www.tikwm.com/';
    } else if (
      host.includes('tiktok.com') ||
      host.includes('tiktokcdn') ||
      host.includes('byteoversea') ||
      host.includes('muscdn')
    ) {
      base.Referer = 'https://www.tiktok.com/';
      base.Origin = 'https://www.tiktok.com';
    }
  } catch {}
  return { ...base, ...extra };
}

async function fetchBuffer(url, { headers = {}, signal, maxBytes = MAX_DOCUMENT_LIMIT } = {}) {
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

  // 2. Respaldo Chrome TLS (wreq-js) si axios recibe 403
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

  throw lastErr || new Error('No se pudo descargar el archivo');
}

async function downloadFromProvider(info, { audioOnly, signal }) {
  const headers = info.downloadHeaders || {};

  if (audioOnly) {
    if (!info.audio) throw new Error('Sin pista de audio');
    const { buffer } = await fetchBuffer(info.audio, {
      headers,
      signal,
      maxBytes: VIDEO_INLINE_LIMIT,
    });
    return { kind: 'audio', buffer };
  }

  if (info.images.length) {
    const settled = await Promise.allSettled(
      info.images.map(async (imgUrl) => {
        const { buffer, contentType } = await fetchBuffer(imgUrl, {
          headers,
          signal,
          maxBytes: VIDEO_INLINE_LIMIT,
        });
        return { buffer, mimetype: detectImageMime(buffer, contentType) };
      }),
    );
    const images = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') images.push(r.value);
      else if (isAbortError(r.reason) && signal?.aborted) throw r.reason;
    }
    if (images.length) return { kind: 'images', images };
  }

  if (info.videoCandidates.length) {
    let oversizedFallback = null;
    for (const videoUrl of info.videoCandidates) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      try {
        const { buffer, contentType } = await fetchBuffer(videoUrl, {
          headers,
          signal,
          maxBytes: MAX_DOCUMENT_LIMIT,
        });
        if (!isMp4(buffer) && !contentType.includes('video/')) continue;
        if (buffer.length <= VIDEO_INLINE_LIMIT) {
          return { kind: 'video', buffer, oversized: false };
        }
        if (!oversizedFallback || buffer.length < oversizedFallback.buffer.length) {
          oversizedFallback = { kind: 'video', buffer, oversized: true };
        }
      } catch (err) {
        if (isAbortError(err) && signal?.aborted) throw err;
      }
    }
    if (oversizedFallback) return oversizedFallback;
  }

  throw new Error('No se pudo descargar la media');
}

async function sendImageGroup(conn, chat, images, quoted) {
  if (images.length === 1) {
    await conn.sendMessage(
      chat,
      { image: images[0].buffer, mimetype: images[0].mimetype },
      { quoted },
    );
    return;
  }

  for (let i = 0; i < images.length; i += MAX_ALBUM_ITEMS) {
    const slice = images.slice(i, i + MAX_ALBUM_ITEMS);
    const entries = slice.map((img) => ({
      image: img.buffer,
      mimetype: img.mimetype,
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
    } catch {
      for (const entry of entries) {
        await conn.sendMessage(chat, entry, { quoted });
      }
    }
  }
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
        text: `🎵 Envía un enlace de TikTok.\n*Ejemplo:* ${usedPrefix + command} https://vt.tiktok.com/xxxxxxx/`,
      },
      { quoted: m },
    );
  }

  const key = downloadKey(m);
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una descarga de TikTok en curso.' },
      { quoted: m },
    );
  }

  const controller = new AbortController();
  const finish = startDownload(key, SERVICE, controller, { label: 'TikTok' });
  const audioOnly = /^tiktokaudio$/i.test(command || '');

  try {
    await safeReact(conn, m, '⏳');

    // Carrera en paralelo: resuelve y descarga con el proveedor más rápido que funcione
    const providers = [
      () => fetchTikTokDirect(url, controller.signal),
      () => fetchTiklydown(url, controller.signal),
      () => fetchTikwm(url, controller.signal),
    ];

    let result;
    try {
      result = await Promise.any(
        providers.map(async (run) => {
          const info = await run();
          if (!info) throw new Error('Sin datos');
          return downloadFromProvider(info, { audioOnly, signal: controller.signal });
        }),
      );
    } catch (aggErr) {
      if (controller.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      const firstReason = aggErr?.errors?.[0]?.message || aggErr?.message || 'Error desconocido';
      throw new Error(firstReason);
    }

    if (result.kind === 'audio') {
      await conn.sendMessage(
        m.chat,
        { audio: result.buffer, mimetype: 'audio/mpeg', fileName: `tiktok_${Date.now()}.mp3` },
        { quoted: m },
      );
    } else if (result.kind === 'images') {
      await sendImageGroup(conn, m.chat, result.images, m);
    } else if (result.oversized) {
      await conn.sendMessage(
        m.chat,
        {
          document: result.buffer,
          mimetype: 'video/mp4',
          fileName: `tiktok_${Date.now()}.mp4`,
        },
        { quoted: m },
      );
    } else {
      await conn.sendMessage(
        m.chat,
        { video: result.buffer, mimetype: 'video/mp4' },
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
      { text: `❌ No se pudo descargar ese TikTok.\n\`${e?.message || e}\`` },
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
