/*
 ☆ Plugin: Pinterest — Búsqueda en álbum + Descarga directa
 ☆ Modos:
 ☆   .pin <texto>            → búsqueda agrupada en un solo álbum (10 por defecto)
 ☆   .pin <texto> | <1-30>   → búsqueda con cantidad personalizada
 ☆   .pin <url>              → descarga directa de pin (imagen, video o pin múltiple)
*/

import axios from 'axios';
import {
  downloadKey,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js';

const SERVICE = 'pinterest';
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 30;
const MAX_ALBUM_ITEMS = 100;
const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024;
const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024;

const PIN_URL_REGEX =
  /https?:\/\/(?:(?:[a-z]{2}|www|m)\.)?(?:pinterest\.[a-z.]{2,6}|pin\.it)\/[^\s<>]+/i;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Referer: 'https://www.pinterest.com/',
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

const cleanText = (str = '', maxLen = 90) => {
  const s = String(str).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen).trim()}…` : s;
};

const extractPinterestUrl = (...sources) => {
  for (const src of sources) {
    if (!src) continue;
    const match = String(src).match(PIN_URL_REGEX);
    if (match) return match[0].replace(/[),.!?;:'"\]}>]+$/g, '');
  }
  return null;
};

const extractPinId = (url) => {
  if (!url) return null;
  const match = String(url).match(/\/pin\/(?:[^/?#]+--)?(\d{5,25})/i);
  return match ? match[1] : null;
};

const parseSearchInput = (rawText) => {
  const parts = String(rawText || '').split('|');
  const query = parts[0].trim();
  let limit = DEFAULT_SEARCH_LIMIT;
  if (parts.length > 1) {
    const parsed = parseInt(parts[1].trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      limit = Math.min(parsed, MAX_SEARCH_LIMIT);
    }
  }
  return { query, limit };
};

const shuffle = (arr) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const buildImageCandidates = (url) => {
  if (!url) return [];
  const candidates = [];
  if (/i\.pinimg\.com\/(?:236x|474x|564x|736x|1200x)\//i.test(url)) {
    candidates.push(url.replace(/\/(?:236x|474x|564x|736x|1200x)\//i, '/originals/'));
  }
  if (!candidates.includes(url)) candidates.push(url);
  return candidates;
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

const isLikelyHtml = (buffer, contentType = '') => {
  if (String(contentType).toLowerCase().includes('text/html')) return true;
  const head = buffer.subarray(0, 32).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
};

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return;
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
  } catch {}
}

function deepSearch(obj, keys, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key]) return obj[key];
  }
  for (const val of Object.values(obj)) {
    const found = deepSearch(val, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function pickBestVideoUrl(videoList) {
  if (!videoList || typeof videoList !== 'object') return null;
  const preferredKeys = ['V_1080P', 'V_720P', 'V_480P', 'V_EXP7', 'V_240P'];
  for (const key of preferredKeys) {
    const url = videoList[key]?.url;
    if (url && !/\.m3u8(\?|$)/i.test(url)) return url;
  }
  for (const entry of Object.values(videoList)) {
    if (entry?.url && /\.mp4(\?|$)/i.test(entry.url)) return entry.url;
  }
  return null;
}

function extractPinMediaFromObject(pin) {
  const media = [];
  const seen = new Set();

  const pushVideo = (url) => {
    if (!url || seen.has(url) || /\.m3u8(\?|$)/i.test(url)) return;
    seen.add(url);
    media.push({ kind: 'video', url });
  };

  const pushPhoto = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    media.push({ kind: 'photo', url });
  };

  // Video principal
  const mainVideo = pickBestVideoUrl(pin?.videos?.video_list);
  if (mainVideo) pushVideo(mainVideo);

  // Carousel pins (múltiples slots)
  if (Array.isArray(pin?.carousel_data?.carousel_slots)) {
    for (const slot of pin.carousel_data.carousel_slots) {
      const img =
        slot?.images?.orig?.url ||
        slot?.images?.['736x']?.url ||
        slot?.images?.['564x']?.url;
      pushPhoto(img);
    }
  }

  // Idea / Story pins (múltiples páginas con fotos o videos)
  if (Array.isArray(pin?.story_pin_data?.pages)) {
    for (const page of pin.story_pin_data.pages) {
      for (const block of page?.blocks || []) {
        const blockVideo = pickBestVideoUrl(block?.video?.video_list);
        if (blockVideo) pushVideo(blockVideo);
        const blockImg =
          block?.image?.images?.orig?.url ||
          block?.image?.images?.['736x']?.url;
        if (blockImg && !blockVideo) pushPhoto(blockImg);
      }
      if (!page?.blocks?.length) {
        const pageImg =
          page?.image?.images?.orig?.url ||
          page?.image?.images?.['736x']?.url;
        pushPhoto(pageImg);
      }
    }
  }

  // Imagen principal si no había media todavía
  if (!media.length) {
    const mainImg =
      pin?.images?.orig?.url ||
      pin?.images?.['736x']?.url ||
      pin?.images?.['564x']?.url;
    pushPhoto(mainImg);
  }

  return media;
}

// ─── Descarga de buffers ──────────────────────────────────────

async function fetchBuffer(url, { signal, maxBytes = MAX_DOCUMENT_LIMIT } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 45_000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: { 'User-Agent': HEADERS['User-Agent'], Referer: HEADERS.Referer },
    signal,
  });

  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error('Respuesta vacía');
  if (buffer.length > maxBytes) throw new Error(`Archivo supera ${formatBytes(maxBytes)}`);

  const contentType = res.headers?.['content-type'] || '';
  if (isLikelyHtml(buffer, contentType)) {
    throw new Error('La URL devolvió HTML en lugar de media');
  }

  return { buffer, contentType };
}

async function downloadMediaItem(item, { signal }) {
  if (item.kind === 'video') {
    const { buffer } = await fetchBuffer(item.url, { signal, maxBytes: MAX_DOCUMENT_LIMIT });
    return {
      kind: 'video',
      buffer,
      size: buffer.length,
      mimetype: 'video/mp4',
      oversized: buffer.length > VIDEO_INLINE_LIMIT,
      title: item.title || '',
    };
  }

  const candidates = buildImageCandidates(item.url);
  let lastErr = null;
  for (const url of candidates) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const { buffer, contentType } = await fetchBuffer(url, {
        signal,
        maxBytes: VIDEO_INLINE_LIMIT,
      });
      return {
        kind: 'photo',
        buffer,
        size: buffer.length,
        mimetype: detectImageMime(buffer, contentType),
        oversized: false,
        title: item.title || '',
      };
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('No se pudo descargar la imagen');
}

async function sendMediaGroup(conn, chat, items, caption, quoted) {
  if (!items.length) return;

  if (items.length === 1) {
    const only = items[0];
    if (only.kind === 'video') {
      await conn.sendMessage(
        chat,
        { video: only.buffer, mimetype: 'video/mp4', caption },
        { quoted },
      );
    } else {
      await conn.sendMessage(
        chat,
        { image: only.buffer, mimetype: only.mimetype || 'image/jpeg', caption },
        { quoted },
      );
    }
    return;
  }

  for (let i = 0; i < items.length; i += MAX_ALBUM_ITEMS) {
    const slice = items.slice(i, i + MAX_ALBUM_ITEMS);
    const entries = slice.map((item, idx) => {
      const withCaption = i === 0 && idx === 0 && caption ? { caption } : {};
      if (item.kind === 'video') {
        return { video: item.buffer, mimetype: 'video/mp4', ...withCaption };
      }
      return {
        image: item.buffer,
        mimetype: item.mimetype || 'image/jpeg',
        ...withCaption,
      };
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
      console.warn('[Pinterest] Falló envío en álbum, enviando por separado:', err?.message || err);
      for (const entry of entries) {
        await conn.sendMessage(chat, entry, { quoted });
      }
    }
  }
}

// ─── Modo descarga (pin URL) ──────────────────────────────────

async function resolveShortUrl(url, signal) {
  let current = url;
  try {
    for (let i = 0; i < 8; i++) {
      const res = await axios.get(current, {
        maxRedirects: 0,
        timeout: 10_000,
        headers: HEADERS,
        validateStatus: () => true,
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location) {
        current = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, current).href;
      } else {
        break;
      }
    }
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
  }
  return current;
}

async function downloadPinDirect(inputUrl, signal) {
  const resolved = await resolveShortUrl(inputUrl, signal);
  const pinId = extractPinId(resolved);
  if (!pinId) return null;

  try {
    const { data: html } = await axios.get(`https://www.pinterest.com/pin/${pinId}/`, {
      timeout: 15_000,
      headers: HEADERS,
      signal,
    });

    // Estrategia A: __PWS_DATA__
    const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (pwsMatch?.[1]) {
      try {
        const json = JSON.parse(pwsMatch[1]);
        const allPins =
          json?.props?.initialReduxState?.pins ||
          json?.initialReduxState?.pins ||
          json?.props?.pageProps?.pins ||
          {};
        const pin = allPins[pinId] || Object.values(allPins)[0] || null;
        if (pin) {
          const media = extractPinMediaFromObject(pin);
          if (media.length) {
            return {
              media,
              title: cleanText(pin.title || pin.grid_title || pin.description, 100) || 'Pinterest',
              author: cleanText(pin.pinner?.full_name || pin.native_creator?.full_name, 60) || null,
              username: pin.pinner?.username || pin.native_creator?.username || null,
              resolvedUrl: `https://www.pinterest.com/pin/${pinId}/`,
            };
          }
        }
      } catch {}
    }

    // Estrategia B: cualquier script JSON que contenga el pinId
    for (const [, scriptContent] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!scriptContent.includes(pinId)) continue;
      try {
        const parsed = JSON.parse(scriptContent);
        const videoUrl = pickBestVideoUrl(deepSearch(parsed, ['video_list']));
        const imageUrl = deepSearch(parsed, ['orig'])?.url || null;
        const media = [];
        if (videoUrl) media.push({ kind: 'video', url: videoUrl });
        else if (imageUrl) media.push({ kind: 'photo', url: imageUrl });
        if (media.length) {
          return {
            media,
            title: 'Pinterest',
            author: null,
            username: null,
            resolvedUrl: `https://www.pinterest.com/pin/${pinId}/`,
          };
        }
      } catch {}
    }

    // Estrategia C: regex sobre HTML crudo
    const videoMatch = html.match(/"url"\s*:\s*"(https:\/\/v\d*\.pinimg\.com[^"]+\.mp4[^"]*)"/);
    const origMatch = html.match(/"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/);
    const ogMatch = html.match(/property="og:image"\s+content="(https:\/\/i\.pinimg\.com[^"]+)"/);
    const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1] || 'Pinterest';

    const media = [];
    if (videoMatch?.[1]) {
      media.push({ kind: 'video', url: videoMatch[1].replace(/\\\//g, '/') });
    } else if (origMatch?.[1] || ogMatch?.[1]) {
      media.push({ kind: 'photo', url: (origMatch?.[1] || ogMatch[1]).replace(/\\\//g, '/') });
    }

    if (media.length) {
      return {
        media,
        title: cleanText(ogTitle, 100) || 'Pinterest',
        author: null,
        username: null,
        resolvedUrl: `https://www.pinterest.com/pin/${pinId}/`,
      };
    }
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) throw err;
  }

  return null;
}

async function downloadPinFallbackAPIs(url, signal) {
  const endpoints = [
    {
      url: `https://api.siputzx.my.id/api/d/pinterest?url=${encodeURIComponent(url)}`,
      parse: (d) => {
        const mediaUrl = d?.data?.url || d?.data?.media_urls?.[0]?.url;
        if (!mediaUrl) return null;
        const isVideo = d?.data?.type === 'video' || /\.mp4(\?|$)/i.test(mediaUrl);
        return {
          media: [{ kind: isVideo ? 'video' : 'photo', url: mediaUrl }],
          title: cleanText(d?.data?.title, 100) || 'Pinterest',
          author: d?.data?.author || null,
          username: null,
          resolvedUrl: url,
        };
      },
    },
    {
      url: `https://api.ryzendesu.vip/api/downloader/pinterest?url=${encodeURIComponent(url)}`,
      parse: (d) => {
        const list = d?.media || d?.data?.media || [];
        const best = list.find((m) => /\.mp4(\?|$)/i.test(m?.url || '')) || list[0];
        const mediaUrl = best?.url || d?.url || d?.data?.url;
        if (!mediaUrl) return null;
        const isVideo = /\.mp4(\?|$)/i.test(mediaUrl);
        return {
          media: [{ kind: isVideo ? 'video' : 'photo', url: mediaUrl }],
          title: cleanText(d?.title || d?.data?.title, 100) || 'Pinterest',
          author: null,
          username: null,
          resolvedUrl: url,
        };
      },
    },
  ];

  for (const api of endpoints) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const { data } = await axios.get(api.url, { timeout: 12_000, signal });
      const parsed = api.parse(data);
      if (parsed?.media?.length) return parsed;
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
    }
  }
  return null;
}

// ─── Modo búsqueda ────────────────────────────────────────────

async function searchPinterestDirect(query, signal) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
  const dataParam = JSON.stringify({
    options: { query, scope: 'pins', auto_correction_disabled: false, page_size: 40 },
    context: {},
  });

  const { data } = await axios.get(
    'https://www.pinterest.com/resource/BaseSearchResource/get/',
    {
      params: { source_url: sourceUrl, data: dataParam },
      timeout: 12_000,
      headers: {
        ...HEADERS,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-APP-VERSION': 'a9522f',
        'X-Pinterest-AppState': 'active',
        'X-Pinterest-Source-Url': sourceUrl,
      },
      signal,
    },
  );

  const pins = data?.resource_response?.data?.results;
  if (!Array.isArray(pins)) return [];

  const results = [];
  for (const pin of pins) {
    const img =
      pin?.images?.orig?.url ||
      pin?.images?.['736x']?.url ||
      pin?.images?.['564x']?.url;
    if (!img) continue;
    results.push({
      kind: 'photo',
      url: img,
      title: cleanText(pin.grid_title || pin.title || pin.description, 80),
    });
  }
  return results;
}

async function searchPinterest(query, signal) {
  const providers = [
    () => searchPinterestDirect(query, signal),
    async () => {
      const { data } = await axios.get(
        `https://rest.apicausas.xyz/api/v1/buscadores/pinterest?apikey=causa-db9690e010e31139&q=${encodeURIComponent(query)}`,
        { timeout: 10_000, signal },
      );
      const list = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.results)
          ? data.results
          : [];
      return list
        .map((i) => {
          if (typeof i === 'string') return { kind: 'photo', url: i, title: '' };
          const url = i.hd || i.image || i.image_url || i.url || null;
          return url ? { kind: 'photo', url, title: cleanText(i.title || i.description, 80) } : null;
        })
        .filter(Boolean);
    },
    async () => {
      const { data } = await axios.get(
        `https://api.siputzx.my.id/api/s/pinterest?query=${encodeURIComponent(query)}`,
        { timeout: 10_000, signal },
      );
      return (Array.isArray(data?.data) ? data.data : [])
        .map((i) => {
          const url = i.image_url || i.url || null;
          return url ? { kind: 'photo', url, title: cleanText(i.grid_title || i.description, 80) } : null;
        })
        .filter(Boolean);
    },
    async () => {
      const { data } = await axios.get(
        `https://api.ryzendesu.vip/api/search/pinterest?query=${encodeURIComponent(query)}`,
        { timeout: 10_000, signal },
      );
      return (Array.isArray(data?.data) ? data.data : [])
        .map((i) => {
          if (typeof i === 'string') return { kind: 'photo', url: i, title: '' };
          const url = i.image_url || i.url || null;
          return url ? { kind: 'photo', url, title: cleanText(i.title, 80) } : null;
        })
        .filter(Boolean);
    },
  ];

  for (const provider of providers) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const results = await provider();
      if (results.length) {
        // Deduplicar por URL
        const seen = new Set();
        return results.filter((item) => {
          if (!item?.url || seen.has(item.url)) return false;
          seen.add(item.url);
          return true;
        });
      }
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err;
    }
  }
  return [];
}

// ─── Handler ─────────────────────────────────────────────────

const handler = async (m, { conn, usedPrefix, command, text, args }) => {
  const pinUrl = extractPinterestUrl(
    text,
    args?.join(' '),
    m.quoted?.text,
    m.quoted?.caption,
  );

  if (!pinUrl && !text?.trim()) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `✦ ˚  ₊ · 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 · ₊  ˚ ✦\n\n` +
          `◦ ❝ *Buscar* ❞ ⌁ ${usedPrefix + command} gatos aesthetic\n` +
          `◦ ❝ *Cantidad* ❞ ⌁ ${usedPrefix + command} gatos aesthetic | 15\n` +
          `◦ ❝ *Descargar* ❞ ⌁ ${usedPrefix + command} https://pin.it/xxxxx\n\n` +
          `˗ˏˋ 📌 Imágenes agrupadas en un solo álbum ˎˊ˗`,
      },
      { quoted: m },
    );
  }

  const key = downloadKey(m);
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una petición de Pinterest en curso. Usa *cancelar* si deseas detenerla.' },
      { quoted: m },
    );
  }

  const controller = new AbortController();
  const finish = startDownload(key, SERVICE, controller, { label: 'Pinterest' });

  try {
    // ── Modo descarga de pin ─────────────────────────────────
    if (pinUrl) {
      await safeReact(conn, m, '⏳');

      const pin =
        (await downloadPinDirect(pinUrl, controller.signal)) ||
        (await downloadPinFallbackAPIs(pinUrl, controller.signal));

      if (!pin?.media?.length) {
        await safeReact(conn, m, '❌');
        return conn.sendMessage(
          m.chat,
          {
            text:
              `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n` +
              `⌁ No pude obtener el contenido de ese pin.\n` +
              `˗ˏˋ Verifica el enlace e intenta de nuevo ˎˊ˗`,
          },
          { quoted: m },
        );
      }

      const settled = await Promise.allSettled(
        pin.media.map((item) => downloadMediaItem(item, { signal: controller.signal })),
      );
      const downloaded = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') downloaded.push(r.value);
        else if (isAbortError(r.reason) && controller.signal.aborted) throw r.reason;
      }

      if (!downloaded.length) {
        await safeReact(conn, m, '❌');
        return conn.sendMessage(
          m.chat,
          { text: '❌ No se pudo descargar la media de ese pin.' },
          { quoted: m },
        );
      }

      const inlineItems = downloaded.filter((it) => !it.oversized);
      const docItems = downloaded.filter((it) => it.oversized);
      const totalSize = downloaded.reduce((acc, it) => acc + (it.size || 0), 0);

      const meta =
        `✦ ˚  ₊ · 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 · ₊  ˚ ✦\n\n` +
        (pin.title ? `⌁ *Título*  › ${pin.title}\n` : '') +
        (pin.author ? `⌁ *Autor*   › ${pin.author}\n` : '') +
        (pin.username ? `⌁ *Usuario* › @${pin.username}\n` : '') +
        `⌁ *Peso*    › ${formatBytes(totalSize)}\n` +
        (downloaded.length > 1 ? `⌁ *Archivos* › ${downloaded.length}\n` : '') +
        `\n˗ˏˋ 📌 ${pin.resolvedUrl || pinUrl} ˎˊ˗`;

      if (inlineItems.length) {
        await sendMediaGroup(conn, m.chat, inlineItems, meta, m);
      }

      for (let i = 0; i < docItems.length; i++) {
        const doc = docItems[i];
        await conn.sendMessage(
          m.chat,
          {
            document: doc.buffer,
            mimetype: 'video/mp4',
            fileName: `pinterest_${i + 1}.mp4`,
            caption: inlineItems.length ? undefined : meta,
          },
          { quoted: m },
        );
      }

      await safeReact(conn, m, '✅');
      return;
    }

    // ── Modo búsqueda (álbum único) ──────────────────────────
    const { query, limit } = parseSearchInput(text);
    if (!query) {
      return conn.sendMessage(
        m.chat,
        { text: `⌁ Escribe qué deseas buscar.\n*Ejemplo:* ${usedPrefix + command} paisajes anime | 12` },
        { quoted: m },
      );
    }

    await safeReact(conn, m, '🔍');

    const results = await searchPinterest(query, controller.signal);
    if (!results.length) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        {
          text:
            `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n` +
            `⌁ Sin resultados para: *${query}*\n` +
            `˗ˏˋ Intenta con otras palabras ˎˊ˗`,
        },
        { quoted: m },
      );
    }

    // Tomamos un pequeño margen extra por si alguna imagen falla al descargar
    const candidates = shuffle(results).slice(0, Math.min(results.length, limit + 5));
    const settled = await Promise.allSettled(
      candidates.map((item) => downloadMediaItem(item, { signal: controller.signal })),
    );

    const downloaded = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        downloaded.push(r.value);
        if (downloaded.length >= limit) break;
      } else if (isAbortError(r.reason) && controller.signal.aborted) {
        throw r.reason;
      }
    }

    if (!downloaded.length) {
      await safeReact(conn, m, '❌');
      return conn.sendMessage(
        m.chat,
        {
          text:
            `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n` +
            `⌁ No se pudieron descargar las imágenes encontradas.\n` +
            `˗ˏˋ Intenta de nuevo ˎˊ˗`,
        },
        { quoted: m },
      );
    }

    const userName =
      global.db?.data?.users?.[m.sender]?.name ??
      m.pushName ??
      m.sender.split('@')[0];
    const totalSize = downloaded.reduce((acc, it) => acc + (it.size || 0), 0);

    const caption =
      `✦ ˚  ₊ · 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 · ₊  ˚ ✦\n\n` +
      `⌁ *Búsqueda*    › ${query}\n` +
      `⌁ *Imágenes*    › ${downloaded.length}\n` +
      `⌁ *Peso total*  › ${formatBytes(totalSize)}\n` +
      `⌁ *Solicitante* › ${userName}\n\n` +
      `˗ˏˋ 📌 ${global.wm || 'Rikka Takarada - Bot'} ˎˊ˗`;

    await sendMediaGroup(conn, m.chat, downloaded, caption, m);
    await safeReact(conn, m, '✅');
  } catch (err) {
    if (isAbortError(err) && controller.signal.aborted) {
      await safeReact(conn, m, '🛑');
      return conn.sendMessage(
        m.chat,
        { text: '🛑 Operación de Pinterest cancelada.' },
        { quoted: m },
      );
    }
    console.error('[Pinterest]', err);
    await safeReact(conn, m, '❌');
    return conn.sendMessage(
      m.chat,
      { text: `❌ Error al procesar Pinterest.\n\`${err?.message || err}\`` },
      { quoted: m },
    );
  } finally {
    finish();
  }
};

handler.help = ['pinterest <búsqueda | enlace>'];
handler.tags = ['search'];
handler.command = ['pinterest', 'pin'];

export default handler;
