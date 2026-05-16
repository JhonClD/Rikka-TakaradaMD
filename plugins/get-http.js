
import { format } from 'util';

const MIME_MAP = {
  video: ['video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/3gpp'],
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml', 'image/x-icon', 'image/avif'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav', 'audio/webm', 'audio/amr'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'text/plain', 'application/json']
};

const EXT_MAP = {
  mp4: 'video', webm: 'video', avi: 'video', mkv: 'video', mov: 'video', wmv: 'video', '3gp': 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp3: 'audio', ogg: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', amr: 'audio', m4a: 'audio',
  pdf: 'document', zip: 'document', rar: 'document', '7z': 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document', txt: 'document', json: 'document', exe: 'document', apk: 'document'
};

const HEADERS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  },
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9'
  }
];

const PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://proxy.cors.sh/${url}`
];

const MAX_VIDEO_SIZE = 60 * 1024 * 1024; // 60 MB

// Palabras clave que identifican un botón/enlace de descarga
const DOWNLOAD_KEYWORDS = /descargar|download|baixar|télécharger|scarica|unduh|pobierz|скачать/i;

// Extensiones de archivo descargable
const DOWNLOADABLE_EXT = /\.(mp4|webm|mkv|avi|mov|mp3|ogg|wav|aac|flac|m4a|pdf|zip|rar|7z|apk|exe|doc|docx|xls|xlsx|png|jpg|jpeg|gif|webp)(\?.*)?$/i;

async function fetchWithBypass(url) {
  for (const headers of HEADERS) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (res.ok && ![403, 503, 429].includes(res.status)) return res;
    } catch {}
  }
  for (const proxyFn of PROXIES) {
    try {
      const res = await fetch(proxyFn(url), { signal: AbortSignal.timeout(20000) });
      if (res.ok) return res;
    } catch {}
  }
  throw new Error('No se pudo acceder al recurso');
}

/**
 * Busca en el HTML un enlace de descarga directo.
 * Estrategia (en orden de prioridad):
 *  1. <a download href="..."> con extensión descargable
 *  2. <a href="..."> cuyo texto/atributos coincidan con palabras clave de descarga
 *  3. Cualquier href con extensión descargable
 *  4. <source src="..."> o <video src="...">
 */
function extractDownloadUrl(html, baseUrl) {
  const base = new URL(baseUrl);

  const toAbsolute = (href) => {
    if (!href) return null;
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  };

  // 1. <a download href="..."> con extensión descargable
  const dlAttrRe = /<a[^>]+download[^>]*href=["']([^"']+)["'][^>]*>|<a[^>]+href=["']([^"']+)["'][^>]*download[^>]*>/gi;
  let m;
  while ((m = dlAttrRe.exec(html)) !== null) {
    const href = m[1] || m[2];
    if (href && DOWNLOADABLE_EXT.test(href)) {
      const abs = toAbsolute(href);
      if (abs) return abs;
    }
  }

  // 2. <a href="..."> con texto o atributos que indiquen descarga + extensión descargable
  const linkRe = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2].replace(/<[^>]+>/g, '').trim();
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if ((DOWNLOAD_KEYWORDS.test(inner) || DOWNLOAD_KEYWORDS.test(attrs)) && DOWNLOADABLE_EXT.test(href)) {
      const abs = toAbsolute(href);
      if (abs) return abs;
    }
  }

  // 3. Cualquier href con extensión descargable
  const anyHrefRe = /href=["']([^"']+)["']/gi;
  while ((m = anyHrefRe.exec(html)) !== null) {
    if (DOWNLOADABLE_EXT.test(m[1])) {
      const abs = toAbsolute(m[1]);
      if (abs) return abs;
    }
  }

  // 4. <source src> / <video src>
  const srcRe = /(?:source|video)[^>]+src=["']([^"']+)["']/gi;
  while ((m = srcRe.exec(html)) !== null) {
    const abs = toAbsolute(m[1]);
    if (abs) return abs;
  }

  return null;
}

async function sendMedia(conn, m, buf, contentType, fileName) {
  const urlExt = fileName.split('.').pop()?.toLowerCase();
  const mediaType = Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(t => contentType.includes(t))) || EXT_MAP[urlExt] || null;

  if (mediaType === 'video') {
    const isMp4 = urlExt === 'mp4' || contentType.includes('video/mp4');
    if (isMp4 && buf.length > MAX_VIDEO_SIZE) {
      const mkvName = fileName.replace(/\.mp4$/i, '.mkv');
      return conn.sendMessage(m.chat, { document: buf, mimetype: 'application/x-matroska', fileName: mkvName.endsWith('.mkv') ? mkvName : mkvName + '.mkv' }, { quoted: m });
    }
    return conn.sendMessage(m.chat, { video: buf, mimetype: contentType, fileName }, { quoted: m });
  }
  if (mediaType === 'image') {
    return conn.sendMessage(m.chat, { image: buf, mimetype: contentType || 'image/jpeg' }, { quoted: m });
  }
  if (mediaType === 'audio') {
    return conn.sendMessage(m.chat, { audio: buf, mimetype: contentType || 'audio/mpeg', ptt: false }, { quoted: m });
  }
  if (/text|json/.test(contentType) && buf.length < 100000) {
    let txt = buf.toString();
    if (contentType.includes('json')) {
      try { txt = format(JSON.parse(txt)); } catch {}
    }
    return m.reply(txt.slice(0, 50000));
  }
  return conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) throw `❌ Uso: ${usedPrefix + command} <url>`;
  if (!/^https?:\/\//.test(text)) throw '❌ URL inválida';

  try {
    const res = await fetchWithBypass(text);
    let contentType = res.headers.get('content-type') || '';
    const urlObj = new URL(text);
    let ext = urlObj.pathname.split('.').pop()?.toLowerCase();
    let fileName = urlObj.pathname.split('/').pop() || `file_${Date.now()}.${ext || 'bin'}`;

    // ── Si la respuesta es HTML, buscar botón/enlace de descarga ──
    if (contentType.includes('text/html')) {
      const html = await res.text();
      const downloadUrl = extractDownloadUrl(html, text);

      if (!downloadUrl) throw 'No se encontró ningún enlace de descarga en la página.';

      await m.reply(`🔍 Enlace de descarga encontrado:\n${downloadUrl}\n\n⏬ Descargando...`);

      const dlRes = await fetchWithBypass(downloadUrl);
      contentType = dlRes.headers.get('content-type') || '';
      const dlUrlObj = new URL(downloadUrl);
      ext = dlUrlObj.pathname.split('.').pop()?.toLowerCase();
      fileName = dlUrlObj.pathname.split('/').pop() || `file_${Date.now()}.${ext || 'bin'}`;

      const buf = Buffer.from(await dlRes.arrayBuffer());
      return sendMedia(conn, m, buf, contentType, fileName);
    }

    // ── URL directa a un archivo ──
    const buf = Buffer.from(await res.arrayBuffer());
    return sendMedia(conn, m, buf, contentType, fileName);

  } catch (e) {
    throw `❌ Error: ${e.message || e}`;
  }
};

handler.help = ['fetch <url>', 'get <url>'];
handler.tags = ['tools'];
handler.command = /^(fetch|get)$/i;

export default handler;
                               
