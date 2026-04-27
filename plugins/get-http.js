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
  pdf: 'document', zip: 'document', rar: 'document',
};

const handler = async (m, { conn, text }) => {
  if (!/^https?:\/\//.test(text)) throw '❌ La URL debe comenzar con http:// o https://';

  const _url = new URL(text);
  const url = global.API(_url.origin, _url.pathname, Object.fromEntries(_url.searchParams.entries()), 'APIKEY');

  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  const contentLength = parseInt(res.headers.get('content-length') || '0');

  if (contentLength > 100 * 1024 * 1024) throw `❌ El archivo es demasiado grande (${(contentLength / 1024 / 1024).toFixed(1)} MB)`;

  // Detectar tipo por content-type o extensión de URL
  const ext = _url.pathname.split('.').pop()?.toLowerCase();
  let mediaType = Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(m => contentType.includes(m)))
                  || EXT_MAP[ext]
                  || null;

  const buf = Buffer.from(await res.arrayBuffer());

  // Enviar según tipo detectado
  if (mediaType === 'video') {
    return conn.sendMessage(m.chat, { video: buf, mimetype: contentType || 'video/mp4' }, { quoted: m });
  }
  if (mediaType === 'image') {
    return conn.sendMessage(m.chat, { image: buf, mimetype: contentType || 'image/jpeg' }, { quoted: m });
  }
  if (mediaType === 'audio') {
    return conn.sendMessage(m.chat, { audio: buf, mimetype: contentType || 'audio/mpeg', ptt: false }, { quoted: m });
  }
  if (mediaType === 'document') {
    const fileName = _url.pathname.split('/').pop() || 'file';
    return conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
  }

  // Si es texto o JSON, mostrar contenido
  if (/text|json/.test(contentType)) {
    let txt = buf.toString();
    try { txt = format(JSON.parse(txt)); } catch { /* dejar como texto */ }
    return m.reply(txt.slice(0, 65536));
  }

  // Cualquier otro archivo: enviar como documento
  const fileName = _url.pathname.split('/').pop() || 'file';
  conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
};

handler.help = ['fetch', 'get'].map((v) => v + ' <url>');
handler.tags = ['internet'];
handler.command = /^(fetch|get)$/i;
handler.rowner = true;
export default handler;
