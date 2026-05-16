import axios from 'axios';
import { format } from 'util';

const MIME_MAP = {
  video: ['video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/3gpp'],
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml', 'image/x-icon', 'image/avif'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav', 'audio/webm', 'audio/amr'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
    'text/plain', 'application/json']
};

const EXT_MAP = {
  mp4: 'video', webm: 'video', avi: 'video', mkv: 'video', mov: 'video', wmv: 'video', '3gp': 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp3: 'audio', ogg: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', amr: 'audio', m4a: 'audio',
  pdf: 'document', zip: 'document', rar: 'document', '7z': 'document', doc: 'document', docx: 'document',
  xls: 'document', xlsx: 'document', txt: 'document', json: 'document', exe: 'document', apk: 'document'
};

const MAX_VIDEO_SIZE = 60 * 1024 * 1024; // 60 MB

const react = (conn, m, emoji) =>
  conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });

async function fetchBuffer(url) {
  const HEADERS_LIST = [
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'es-ES,es;q=0.9'
    }
  ];

  const PROXIES = [
    (u) => u,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  let lastError;

  for (const headers of HEADERS_LIST) {
    for (const proxy of PROXIES) {
      try {
        const res = await axios.get(proxy(url), {
          headers,
          responseType: 'arraybuffer',
          timeout: 30000, // 30 segundos (más margen para archivos grandes)
          maxContentLength: 200 * 1024 * 1024, // 200 MB máximo
          validateStatus: (s) => s >= 200 && s < 300,
        });

        return {
          buf: Buffer.from(res.data),
          contentType: res.headers['content-type'] || '',
        };
      } catch (e) {
        lastError = e;
        // continua al siguiente intento
      }
    }
  }

  throw new Error(lastError?.message || 'No se pudo acceder al recurso tras múltiples intentos');
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) throw `❌ Uso: ${usedPrefix + command} <url>`;
  if (!/^https?:\/\//.test(text.trim())) throw '❌ URL inválida';

  const url = text.trim();
  await react(conn, m, '⏳');

  try {
    const { buf, contentType } = await fetchBuffer(url);

    const urlObj = new URL(url);
    const ext = urlObj.pathname.split('.').pop()?.toLowerCase() || 'bin';
    const rawName = urlObj.pathname.split('/').pop() || `file_${Date.now()}.${ext}`;
    const fileName = decodeURIComponent(rawName);

    // Determinar tipo: primero por MIME, luego por extensión
    const mediaType =
      Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(t => contentType.includes(t))) ||
      EXT_MAP[ext] ||
      null;

    await react(conn, m, '📥');

    if (mediaType === 'video') {
      const isMp4 = ext === 'mp4' || contentType.includes('video/mp4');
      if (isMp4 && buf.length > MAX_VIDEO_SIZE) {
        const mkvName = fileName.replace(/\.mp4$/i, '.mkv');
        await conn.sendMessage(m.chat,
          { document: buf, mimetype: 'application/x-matroska', fileName: mkvName.endsWith('.mkv') ? mkvName : mkvName + '.mkv' },
          { quoted: m }
        );
      } else {
        await conn.sendMessage(m.chat,
          { video: buf, mimetype: contentType || 'video/mp4', fileName },
          { quoted: m }
        );
      }
    } else if (mediaType === 'image') {
      // .webp puede ser un sticker animado; se envía como imagen normal
      await conn.sendMessage(m.chat,
        { image: buf, mimetype: contentType.includes('image/') ? contentType : 'image/jpeg' },
        { quoted: m }
      );
    } else if (mediaType === 'audio') {
      await conn.sendMessage(m.chat,
        { audio: buf, mimetype: contentType || 'audio/mpeg', ptt: false },
        { quoted: m }
      );
    } else if (/text|json/.test(contentType) && buf.length < 100000) {
      let txt = buf.toString();
      if (contentType.includes('json')) {
        try { txt = format(JSON.parse(txt)); } catch { /* déjalo como texto */ }
      }
      await m.reply(txt.slice(0, 50000));
    } else {
      // Tipo desconocido → documento genérico
      await conn.sendMessage(m.chat,
        { document: buf, mimetype: contentType || 'application/octet-stream', fileName },
        { quoted: m }
      );
    }

    await react(conn, m, '✅');

  } catch (e) {
    await react(conn, m, '❌');
    throw `❌ Error: ${e?.message || e}`;
  }
};

handler.help = ['fetch <url>', 'get <url>'];
handler.tags = ['tools'];
handler.command = /^(fetch|get)$/i;

export default handler;
          
