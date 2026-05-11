import { format } from 'util';

const MIME_MAP = {
  video:    ['video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/quicktime'],
  image:    ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
  audio:    ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac'],
  sticker:  ['image/webp'],
};

const EXT_MAP = {
  mp4: 'video', webm: 'video', avi: 'video', mkv: 'video', mov: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  mp3: 'audio', ogg: 'audio', wav: 'audio', aac: 'audio',
  pdf: 'document', zip: 'document', rar: 'document', docx: 'document'
};

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

const HEADERS_ANDROID = {
  'User-Agent': UA_ANDROID,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9',
  'Connection': 'keep-alive'
};

const HEADERS_FIREFOX = {
  'User-Agent': UA_FIREFOX,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
  'Connection': 'keep-alive'
};

async function isCFBlocked(res) {
  if ([403, 503, 429].includes(res.status)) {
    const txt = await res.clone().text().catch(() => '');
    return /cloudflare|cf-ray|just a moment|checking your browser/i.test(txt);
  }
  return false;
}

async function tryDirect(url, headers, label) {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (await isCFBlocked(res)) throw new Error('CF');
  return { res, label };
}

async function tryCorsProxy(url) {
  const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(80000) });
  if (!res.ok) throw new Error('Proxy');
  return { res, label: 'Proxy-Bypass' };
}

async function fetchWithBypass(url) {
  try { return await tryDirect(url, HEADERS_ANDROID, 'Android'); } catch {
    try { return await tryDirect(url, HEADERS_FIREFOX, 'Firefox'); } catch {
      return await tryCorsProxy(url);
    }
  }
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) throw `❌ Uso: ${usedPrefix + command} <url>`;
  if (!/^https?:\/\//.test(text)) throw '❌ URL inválida';

  await m.reply('⏳ Descargando...');

  let res, label;
  try {
    ({ res, label } = await fetchWithBypass(text));
  } catch (e) {
    throw `❌ Error: ${e.message}`;
  }

  const contentType = res.headers.get('content-type') || '';
  const urlObj = new URL(text);
  const ext = urlObj.pathname.split('.').pop()?.toLowerCase();
  const fileName = urlObj.pathname.split('/').pop() || 'file_' + Date.now();
  
  const buf = Buffer.from(await res.arrayBuffer());
  const sizeMB = (buf.length / (1024 * 1024)).toFixed(2);
  const commonCap = `✅ *Peso:* ${sizeMB} MB\n_Agente: ${label}_`;

  const FORCE_DOC_SIZE = 20 * 1024 * 1024;
  const mediaType = Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(t => contentType.includes(t)))
                    || EXT_MAP[ext]
                    || null;

  if (buf.length > FORCE_DOC_SIZE) {
    return conn.sendMessage(m.chat, { 
      document: buf, 
      mimetype: contentType || 'application/octet-stream', 
      fileName, 
      caption: `📦 *Documento (>20MB)*\n${commonCap}` 
    }, { quoted: m });
  }

  if (mediaType === 'video') {
    return conn.sendMessage(m.chat, { video: buf, mimetype: contentType || 'video/mp4', caption: commonCap }, { quoted: m });
  }
  if (mediaType === 'image') {
    return conn.sendMessage(m.chat, { image: buf, mimetype: contentType || 'image/jpeg', caption: commonCap }, { quoted: m });
  }
  if (mediaType === 'audio') {
    return conn.sendMessage(m.chat, { audio: buf, mimetype: contentType || 'audio/mpeg', ptt: false }, { quoted: m });
  }

  if (/text|json/.test(contentType) && buf.length < 100000) {
    let txt = buf.toString();
    if (contentType.includes('json')) {
        try { txt = format(JSON.parse(txt)); } catch { }
    }
    return m.reply(`${txt.slice(0, 50000)}\n\n${commonCap}`);
  }

  return conn.sendMessage(m.chat, { 
    document: buf, 
    mimetype: contentType || 'application/octet-stream', 
    fileName, 
    caption: commonCap 
  }, { quoted: m });
};

handler.help = ['fetch <url>', 'get <url>'];
handler.tags = ['tools'];
handler.command = /^(fetch|get)$/i;

export default handler;
      
