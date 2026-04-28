/*
 ☆ Plugin: Pinterest — Búsqueda + Descarga
 ☆ Adaptado para KanaArima-MD (@whiskeysockets/Baileys)
 ☆ Modos:
 ☆   .pin <texto>   → carrusel de imágenes (búsqueda)
 ☆   .pin <url>     → descarga directa (imagen o video)
*/

import axios from 'axios';

const { proto, generateWAMessageFromContent, generateWAMessageContent } =
  await import('@whiskeysockets/baileys');

// ─── Utilidades ───────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

const isUrl = text => {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
};

const isPinterestUrl = text =>
  /pinterest\.(com|es|co\.uk|fr|de)|pin\.it/i.test(text);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer': 'https://www.pinterest.com/'
};

// ─── Download helpers ─────────────────────────────────────────

/** Resuelve redirecciones (pin.it → pinterest.com/pin/...) */
async function resolveShortUrl(url) {
  let current = url;
  try {
    for (let i = 0; i < 10; i++) {
      const res = await axios.get(current, {
        maxRedirects: 0,
        timeout: 10000,
        headers: HEADERS,
        validateStatus: () => true
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location) {
        current = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://www.pinterest.com' + res.headers.location;
      } else break;
    }
  } catch {}
  return current;
}

const extractPinId = url => url.match(/\/pin\/(\d+)/)?.[1] || null;

/** Búsqueda profunda de una key en un objeto anidado */
function deepSearch(obj, keys, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  for (const key of keys) if (obj[key]) return obj[key];
  for (const val of Object.values(obj)) {
    const found = deepSearch(val, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

// ─── Download ─────────────────────────────────────────────────

/**
 * Estrategia 1: scraping directo del HTML del pin.
 * No requiere API key.
 */
async function downloadPinDirect(inputUrl) {
  const resolved = await resolveShortUrl(inputUrl);
  const pinId    = extractPinId(resolved);
  if (!pinId) return null;

  try {
    const { data: html } = await axios.get(
      `https://www.pinterest.com/pin/${pinId}/`,
      { timeout: 15000, headers: HEADERS }
    );

    // Estrategia A: __PWS_DATA__ script tag
    const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (pwsMatch?.[1]) {
      try {
        const json = JSON.parse(pwsMatch[1]);
        const allPins =
          json?.props?.initialReduxState?.pins ||
          json?.initialReduxState?.pins ||
          json?.props?.pageProps?.pins || {};
        const pin = allPins[pinId] || Object.values(allPins)[0] || null;
        if (pin) {
          const videos   = pin?.videos?.video_list || {};
          const videoUrl = videos?.V_720P?.url || videos?.V_480P?.url || videos?.V_240P?.url || null;
          const imageUrl = pin?.images?.orig?.url || pin?.images?.['736x']?.url || null;
          const title    = pin?.title || pin?.description || 'Pinterest';
          if (videoUrl || imageUrl) return { video: videoUrl, image: imageUrl, title };
        }
      } catch {}
    }

    // Estrategia B: cualquier script tag que contenga el pinId
    for (const [, scriptContent] of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]) {
      if (!scriptContent.includes(pinId)) continue;
      try {
        const parsed  = JSON.parse(scriptContent);
        const imageUrl = deepSearch(parsed, ['orig'])?.url || null;
        const videoList = deepSearch(parsed, ['video_list']);
        const videoUrl  = videoList?.V_720P?.url || videoList?.V_480P?.url || null;
        if (imageUrl || videoUrl) return { video: videoUrl || null, image: imageUrl, title: 'Pinterest' };
      } catch { continue; }
    }

    // Estrategia C: regex sobre el HTML crudo
    const patterns = [
      { type: 'video', regex: /"url"\s*:\s*"(https:\/\/v\.pinimg\.com[^"]+\.mp4[^"]*)"/ },
      { type: 'image', regex: /"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/ },
      { type: 'image', regex: /property="og:image"\s+content="(https:\/\/i\.pinimg\.com[^"]+)"/ }
    ];
    let imageUrl = null, videoUrl = null;
    for (const { type, regex } of patterns) {
      const match = html.match(regex);
      if (match?.[1]) {
        const u = match[1].replace(/\\\//g, '/');
        if (type === 'video' && !videoUrl) videoUrl = u;
        if (type === 'image' && !imageUrl) imageUrl = u;
      }
    }
    if (videoUrl || imageUrl) return { video: videoUrl, image: imageUrl, title: 'Pinterest' };

  } catch {}
  return null;
}

/**
 * Estrategia 2: APIs públicas con fallback.
 * Usa global.APIs si están configuradas en el bot.
 */
async function downloadPinAPIs(url) {
  const A = global.APIs || {};

  const apis = [
    A.stellar && {
      endpoint: `${A.stellar.url}/dl/pinterest?url=${encodeURIComponent(url)}&key=${A.stellar.key}`,
      extractor: res => {
        if (!res.status || !res.data?.dl) return null;
        return {
          type: res.data.type, title: res.data.title || null,
          author: res.data.author || null, username: res.data.username || null,
          uploadDate: res.data.uploadDate || null,
          url: res.data.dl, thumbnail: res.data.thumbnail || null
        };
      }
    },
    A.vreden && {
      endpoint: `${A.vreden.url}/api/v1/download/pinterest?url=${encodeURIComponent(url)}`,
      extractor: res => {
        if (!res.status || !res.result?.media_urls?.length) return null;
        const media = res.result.media_urls.find(m => m.quality === 'original') || res.result.media_urls[0];
        if (!media?.url) return null;
        return {
          type: media.type, title: res.result.title || null,
          author: res.result.uploader?.full_name || null,
          username: res.result.uploader?.username || null,
          uploadDate: res.result.created_at || null,
          likes: res.result.statistics?.likes || null,
          views: res.result.statistics?.views || null,
          url: media.url
        };
      }
    },
    A.delirius && {
      endpoint: `${A.delirius.url}/download/pinterestdl?url=${encodeURIComponent(url)}`,
      extractor: res => {
        if (!res.status || !res.data?.download?.url) return null;
        return {
          type: res.data.download.type, title: res.data.title || null,
          author: res.data.author_name || null, username: res.data.username || null,
          followers: res.data.followers || null, uploadDate: res.data.upload || null,
          likes: res.data.likes || null, comments: res.data.comments || null,
          url: res.data.download.url
        };
      }
    },
    A.nekolabs && {
      endpoint: `${A.nekolabs.url}/downloader/pinterest?url=${encodeURIComponent(url)}`,
      extractor: res => {
        if (!res.success || !res.result?.medias?.length) return null;
        const media = res.result.medias.find(m => m.extension === 'mp4' || m.extension === 'jpg');
        if (!media?.url) return null;
        return {
          type: media.extension === 'mp4' ? 'video' : 'image',
          title: res.result.title || null, url: media.url
        };
      }
    },
    A.ootaizumi && {
      endpoint: `${A.ootaizumi.url}/downloader/pinterest?url=${encodeURIComponent(url)}`,
      extractor: res => {
        if (!res.status || !res.result?.download) return null;
        return {
          type: res.result.download.includes('.mp4') ? 'video' : 'image',
          title: res.result.title || null,
          author: res.result.author?.name || null,
          url: res.result.download
        };
      }
    }
  ].filter(Boolean);

  for (const { endpoint, extractor } of apis) {
    try {
      const res = await axios.get(endpoint, { timeout: 10000 }).then(r => r.data);
      const result = extractor(res);
      if (result) return result;
    } catch {}
    await sleep(300);
  }
  return null;
}

/** Intenta descarga directa primero; si falla, cae en APIs */
async function downloadPin(url) {
  const direct = await downloadPinDirect(url);
  if (direct) return direct;
  const api = await downloadPinAPIs(url);
  if (api) return { video: api.type === 'video' ? api.url : null, image: api.type !== 'video' ? api.url : null, title: api.title || 'Pinterest', ...api };
  return null;
}

// ─── Search ───────────────────────────────────────────────────

async function searchPinterest(query) {
  const A = global.APIs || {};

  // Causa API — cambia CAUSA_BASE por el host real si no usas global.APIs
  const CAUSA_BASE = A?.causa?.url ?? 'https://rest.apicausas.xyz';
  const CAUSA_KEY  = A?.causa?.key ?? 'causa-db9690e010e31139';

  const apis = [
    // Causa API (prioridad máxima)
    {
      url: `${CAUSA_BASE}/api/v1/buscadores/pinterest?apikey=${CAUSA_KEY}&q=${encodeURIComponent(query)}`,
      parse: d => {
        // Formato { status, data: [{hd, image, title, ...}] }
        if (Array.isArray(d?.data) && d.data.length)
          return d.data.map(i => ({
            image: i.hd || i.image || i.image_url || i.url || null,
            video: i.video_url || null,
            title: i.title || i.description || '',
            pin:   i.pin   || i.link || ''
          })).filter(i => i.image || i.video);
        // Formato alternativo { results: ["url1", ...] }
        if (Array.isArray(d?.results) && d.results.length)
          return d.results.map(u =>
            typeof u === 'string'
              ? { image: u, video: null, title: '', pin: '' }
              : { image: u.image || u.url || null, video: u.video || null, title: u.title || '', pin: u.pin || '' }
          ).filter(i => i.image || i.video);
        return [];
      }
    },
    // APIs públicas (sin key)
    {
      url: `https://api.siputzx.my.id/api/s/pinterest?query=${encodeURIComponent(query)}`,
      parse: d => (d?.data || []).map(i => ({
        image: i.image_url || null, video: i.video_url || null,
        title: i.grid_title || i.description || '', pin: i.pin || ''
      })).filter(i => i.image || i.video)
    },
    {
      url: `https://api.ryzendesu.vip/api/search/pinterest?query=${encodeURIComponent(query)}`,
      parse: d => (Array.isArray(d?.data) ? d.data : []).map(i =>
        typeof i === 'string'
          ? { image: i, video: null, title: '', pin: '' }
          : { image: i.image_url || i.url || null, video: i.video_url || null, title: i.title || '', pin: i.pin || '' }
      ).filter(i => i.image || i.video)
    },
    // APIs del bot (si están configuradas)
    A.stellar && {
      url: `${A.stellar.url}/search/pinterest?query=${encodeURIComponent(query)}&key=${A.stellar.key}`,
      parse: d => (d?.data || []).map(i => ({ image: i.hd || i.image || null, video: null, title: i.title || '', pin: '' })).filter(i => i.image)
    },
    A.delirius && {
      url: `${A.delirius.url}/search/pinterest?text=${encodeURIComponent(query)}`,
      parse: d => (d?.data || []).map(i => ({ image: i.hd || i.image || null, video: null, title: i.title || '', pin: '' })).filter(i => i.image)
    },
    A.vreden && {
      url: `${A.vreden.url}/api/v1/search/pinterest?query=${encodeURIComponent(query)}`,
      parse: d => {
        if (d?.response?.pins?.length) return d.response.pins.map(p => ({ image: p.media?.images?.orig?.url || null, video: null, title: p.title || '', pin: '' })).filter(i => i.image);
        if (d?.result?.result?.length) return d.result.result.map(i => ({ image: i.media_urls?.[0]?.url || null, video: i.media_urls?.[0]?.type === 'video' ? i.media_urls[0].url : null, title: i.title || '', pin: '' })).filter(i => i.image || i.video);
        return [];
      }
    }
  ].filter(Boolean);

  for (const api of apis) {
    try {
      const { data } = await axios.get(api.url, { timeout: 10000 });
      const results = api.parse(data);
      console.log(`[Pinterest] ${api.url.split('?')[0]} → ${results.length} resultados`);
      if (results.length) return results;
    } catch (e) {
      console.log(`[Pinterest] API falló: ${api.url.split('?')[0]} — ${e.message}`);
    }
  }
  return [];
}

// ─── Handler ─────────────────────────────────────────────────

const handler = async (m, { conn, usedPrefix, command, text }) => {
  if (!text)
    return conn.sendMessage(
      m.chat,
      {
        text:
          `✦ ˚  ₊ · 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 · ₊  ˚ ✦\n\n` +
          `◦ ❝ *Buscar* ❞ ⌁ ${usedPrefix + command} gatos aesthetic\n` +
          `◦ ❝ *Descargar* ❞ ⌁ ${usedPrefix + command} https://pin.it/xxxxx\n\n` +
          `˗ˏˋ 📌 Encuentra lo que imaginas ˎˊ˗`
      },
      { quoted: m }
    );

  // ── Modo descarga ──────────────────────────────────────────
  if (isUrl(text) && isPinterestUrl(text)) {
    await conn.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

    const pin = await downloadPin(text);

    if (!pin || (!pin.video && !pin.image)) {
      await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
      return conn.sendMessage(
        m.chat,
        { text: `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n⌁ No pude obtener el contenido de ese pin.\n˗ˏˋ Verifica el enlace e intenta de nuevo ˎˊ˗` },
        { quoted: m }
      );
    }

    const meta =
      `✦ ˚  ₊ · 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 · ₊  ˚ ✦\n\n` +
      (pin.title      ? `⌁ *Título*      › ${pin.title}\n`      : '') +
      (pin.author     ? `⌁ *Autor*       › ${pin.author}\n`      : '') +
      (pin.username   ? `⌁ *Usuario*     › @${pin.username}\n`   : '') +
      (pin.uploadDate ? `⌁ *Fecha*       › ${pin.uploadDate}\n`  : '') +
      (pin.likes      ? `⌁ *Likes*       › ${pin.likes}\n`       : '') +
      (pin.views      ? `⌁ *Vistas*      › ${pin.views}\n`       : '') +
      (pin.comments   ? `⌁ *Comentarios* › ${pin.comments}\n`    : '') +
      `\n˗ˏˋ 📌 ${text} ˎˊ˗`;

    if (pin.video) {
      await conn.sendMessage(
        m.chat,
        { video: { url: pin.video }, caption: meta, mimetype: 'video/mp4', fileName: 'pin.mp4' },
        { quoted: m }
      );
    } else {
      await conn.sendMessage(
        m.chat,
        { image: { url: pin.image }, caption: meta },
        { quoted: m }
      );
    }

    return conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
  }

  // ── Modo búsqueda ──────────────────────────────────────────
  await conn.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });

  const results = await searchPinterest(text);

  if (!results.length) {
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
    return conn.sendMessage(
      m.chat,
      { text: `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n⌁ Sin resultados para: *${text}*\n˗ˏˋ Intenta con otras palabras ˎˊ˗` },
      { quoted: m }
    );
  }

  const shuffled = results.sort(() => Math.random() - 0.5);
  const images   = shuffled.filter(i => i.image && !i.video).slice(0, 10);
  const video    = shuffled.find(i => i.video);

  const userName =
    global.db?.data?.users?.[m.sender]?.name ??
    m.pushName ??
    m.sender.split('@')[0];

  // Construir carrusel
  const cards = [];
  for (let i = 0; i < images.length; i++) {
    let imageMessage;
    try {
      imageMessage = await generateWAMessageContent(
        { image: { url: images[i].image } },
        { upload: conn.waUploadToServer }
      ).then(r => r.imageMessage);
    } catch (e) {
      console.log(`[Pinterest] Falló upload imagen ${i + 1}: ${e.message}`);
      continue;
    }

    cards.push({
      body: proto.Message.InteractiveMessage.Body.fromObject({
        text: images[i].title?.trim() || `✦ Resultado ${i + 1} de ${images.length}`
      }),
      footer: proto.Message.InteractiveMessage.Footer.fromObject({
        text: `˗ˏˋ 📌 ${global.botName ?? 'Rikka-TakaradaMD'} ˎˊ˗`
      }),
      header: proto.Message.InteractiveMessage.Header.fromObject({
        title: '𖡼.𖤣𖥧 ᴘɪɴᴛᴇʀᴇsᴛ 𖡼.𖤣𖥧',
        hasMediaAttachment: true,
        imageMessage
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
        buttons: [{
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: '✦ Ver en Pinterest',
            url: images[i].pin || `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(text)}`,
            merchant_url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(text)}`
          })
        }]
      })
    });
  }

  if (cards.length) {
    const bot = generateWAMessageFromContent(
      m.chat,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: proto.Message.InteractiveMessage.fromObject({
              body: proto.Message.InteractiveMessage.Body.create({
                text: '✦ ˚ 𖡼.𖤣𖥧 ᴘɪɴᴛᴇʀᴇsᴛ 𖡼.𖤣𖥧 ˚ ✦'
              }),
              footer: proto.Message.InteractiveMessage.Footer.create({
                text: `⌁ *Búsqueda* › ${text}\n⌁ *Solicitante* › ${userName}`
              }),
              header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
              carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards })
            })
          }
        }
      },
      { quoted: m }
    );
    await conn.relayMessage(m.chat, bot.message, { messageId: bot.key.id });
  } else if (images.length > 0) {
    // Fallback: carrusel falló → imágenes sueltas
    console.log('[Pinterest] Carrusel falló, enviando imágenes sueltas...');
    let sent = 0;
    for (const img of images.slice(0, 6)) {
      try {
        await conn.sendMessage(
          m.chat,
          { image: { url: img.image }, caption: sent === 0 ? `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n⌁ *Búsqueda* › ${text}` : img.title?.trim() || '' },
          { quoted: sent === 0 ? m : undefined }
        );
        sent++;
        await sleep(600);
      } catch {}
    }
  }

  // Video separado si existe
  if (video) {
    await sleep(1500);
    try {
      await conn.sendMessage(
        m.chat,
        { video: { url: video.video }, caption: `✦ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧\n\n⌁ ${video.title?.trim() || 'Video'}` },
        { quoted: m }
      );
    } catch {}
  }

  if (!cards.length && images.length === 0 && !video)
    return conn.sendMessage(
      m.chat,
      { text: `✦ ˚ 𖡼.𖤣𖥧 *ᴘɪɴᴛᴇʀᴇsᴛ* 𖡼.𖤣𖥧 ˚ ✦\n\n⌁ No se pudieron cargar los resultados.\n˗ˏˋ Intenta de nuevo ˎˊ˗` },
      { quoted: m }
    );

  await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
};

handler.help    = ['pinterest <búsqueda | enlace>'];
handler.tags    = ['search'];
handler.command = ['pinterest', 'pin'];

export default handler;
