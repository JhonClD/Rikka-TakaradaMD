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

// ─── Cloudflare bypass User-Agents ──────────────────────────────────────────
// Android 14 Chrome (más efectivo contra CF JS challenge)
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
// Android TV (evita detección de scraping en sitios con CF)
const UA_ANDROID_TV = 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K UR3 Build/STTB.211019.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.5304.105 Safari/537.36 CrKey/1.56.500000 AFTT';

const CF_HEADERS_ANDROID = {
  'User-Agent':      UA_ANDROID,
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
  'Sec-Fetch-User':  '?1',
  'Cache-Control':   'max-age=0',
};

const CF_HEADERS_ANDROID_TV = {
  'User-Agent':      UA_ANDROID_TV,
  'Accept':          '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'cross-site',
  'Origin':          'https://www.google.com',
  'Referer':         'https://www.google.com/',
};

// ─── Intentar fetch con múltiples estrategias ────────────────────────────────
async function fetchWithBypass(url) {
  const strategies = [
    // 1. Directo sin headers (algunos sitios no tienen CF)
    { headers: { 'User-Agent': UA_ANDROID }, label: 'direct' },
    // 2. Android Chrome completo
    { headers: CF_HEADERS_ANDROID, label: 'android' },
    // 3. Android TV
    { headers: CF_HEADERS_ANDROID_TV, label: 'android-tv' },
    // 4. Android + cookie vacía (bypass ligero)
    { headers: { ...CF_HEADERS_ANDROID, 'Cookie': '' }, label: 'android+cookie' },
    // 5. Googlebot (algunos CF lo dejan pasar)
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': '*/*',
        'Accept-Language': 'en',
      },
      label: 'googlebot',
    },
  ];

  let lastErr;
  for (const { headers, label } of strategies) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });

      // Cloudflare bloqueado devuelve 403 o 503 con página HTML de CF
      if (res.status === 403 || res.status === 503) {
        const txt = await res.text();
        if (/cloudflare|cf-ray|just a moment|checking your browser/i.test(txt)) {
          lastErr = new Error(`CF bloqueó con ${label} (${res.status})`);
          continue;
        }
      }

      return { res, label };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Todas las estrategias fallaron');
}

// ─── Handler principal ───────────────────────────────────────────────────────
const handler = async (m, { conn, text }) => {
  if (!/^https?:\/\//.test(text)) throw '❌ La URL debe comenzar con http:// o https://';

  const _url  = new URL(text);
  const url   = global.API(_url.origin, _url.pathname, Object.fromEntries(_url.searchParams.entries()), 'APIKEY');

  let res, label;
  try {
    ({ res, label } = await fetchWithBypass(url));
  } catch (e) {
    throw `❌ No se pudo acceder a la URL: ${e.message}`;
  }

  const contentType   = res.headers.get('content-type') || '';
  const contentLength = parseInt(res.headers.get('content-length') || '0');

  if (contentLength > 100 * 1024 * 1024) {
    throw `❌ El archivo es demasiado grande (${(contentLength / 1024 / 1024).toFixed(1)} MB)`;
  }

  // Detectar tipo por content-type o extensión
  const ext = _url.pathname.split('.').pop()?.toLowerCase();
  const mediaType = Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(t => contentType.includes(t)))
                    || EXT_MAP[ext]
                    || null;

  const buf = Buffer.from(await res.arrayBuffer());

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

  // Texto o JSON
  if (/text|json/.test(contentType)) {
    let txt = buf.toString();
    try { txt = format(JSON.parse(txt)); } catch { /* dejar como texto */ }
    return m.reply(`${txt.slice(0, 65536)}\n\n_bypass: ${label}_`);
  }

  // Cualquier otro: documento
  const fileName = _url.pathname.split('/').pop() || 'file';
  conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
};

handler.help    = ['fetch', 'get'].map(v => v + ' <url>');
handler.tags    = ['internet'];
handler.command = /^(fetch|get)$/i;
handler.rowner  = false;
export default handler;
