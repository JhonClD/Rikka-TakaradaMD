import { format } from 'util';

const MIME_MAP = {
  video:   ['video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/quicktime'],
  image:   ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
  audio:   ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac'],
};

const EXT_MAP = {
  mp4: 'video', webm: 'video', avi: 'video', mkv: 'video', mov: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  mp3: 'audio', ogg: 'audio', wav: 'audio', aac: 'audio',
  pdf: 'document', zip: 'document', rar: 'document',
};

const UA_ANDROID    = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_ANDROID_TV = 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K UR3 Build/STTB.211019.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.5304.105 Safari/537.36 CrKey/1.56.500000 AFTT';

const CF_HEADERS_ANDROID = {
  'User-Agent':                UA_ANDROID,
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'es-419,es;q=0.9,en;q=0.8',
  'Accept-Encoding':           'gzip, deflate, br',
  'Connection':                'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'Cache-Control':             'max-age=0',
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

// ─── Detectar bloqueo CF en el body (funciona también cuando el proxy retorna 200) ──
function isCFHtml(buf) {
  const txt = buf.toString('utf8', 0, 4096); // solo primeros 4KB, suficiente
  return /cloudflare|cf-ray|just a moment|checking your browser|sorry.*blocked|you have been blocked|enable cookies.*cf/i.test(txt);
}

// ─── Estrategia 1: Directo con headers Android / Android TV ──────────────────
async function tryDirect(url) {
  for (const [headers, label] of [
    [CF_HEADERS_ANDROID,    'android'],
    [CF_HEADERS_ANDROID_TV, 'android-tv'],
  ]) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 503 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return { res, label };
    } catch { continue; }
  }
  throw new Error('directo bloqueado');
}

// ─── Estrategia 2: AllOrigins ─────────────────────────────────────────────────
async function tryAllOrigins(url) {
  const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res   = await fetch(proxy, { headers: { 'User-Agent': UA_ANDROID }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`allorigins ${res.status}`);
  return { res, label: 'allorigins' };
}

// ─── Estrategia 3: corsproxy.io ───────────────────────────────────────────────
async function tryCorsProxy(url) {
  const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const res   = await fetch(proxy, { headers: { 'User-Agent': UA_ANDROID }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`corsproxy ${res.status}`);
  return { res, label: 'corsproxy.io' };
}

// ─── Estrategia 4: thingproxy ─────────────────────────────────────────────────
async function tryThingProxy(url) {
  const proxy = `https://thingproxy.freeboard.io/fetch/${url}`;
  const res   = await fetch(proxy, { headers: { 'User-Agent': UA_ANDROID_TV }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`thingproxy ${res.status}`);
  return { res, label: 'thingproxy' };
}

// ─── Estrategia 5: codetabs ───────────────────────────────────────────────────
async function tryCodetabs(url) {
  const proxy = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
  const res   = await fetch(proxy, { headers: { 'User-Agent': UA_ANDROID }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`codetabs ${res.status}`);
  return { res, label: 'codetabs' };
}

// ─── Orquestador ─────────────────────────────────────────────────────────────
async function fetchWithBypass(url) {
  const strategies = [tryDirect, tryAllOrigins, tryCorsProxy, tryThingProxy, tryCodetabs];
  let lastErr;
  for (const fn of strategies) {
    try {
      const result = await fn(url);
      // Leer el buffer aquí para poder inspeccionar el body
      const buf = Buffer.from(await result.res.arrayBuffer());
      if (isCFHtml(buf)) {
        lastErr = new Error(`${result.label}: respuesta bloqueada por Cloudflare WAF`);
        continue;
      }
      return { buf, res: result.res, label: result.label };
    } catch (e) { lastErr = e; }
  }
  // Todos fallaron — error claro
  throw new Error(
    '🛡️ El sitio está protegido por Cloudflare WAF y bloqueó todas las estrategias.\n' +
    'Este nivel de protección requiere un navegador real con JavaScript.\n' +
    'Prueba con otra URL o un sitio sin Cloudflare agresivo.'
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────
const handler = async (m, { conn, text }) => {
  if (!/^https?:\/\//.test(text)) throw '❌ La URL debe comenzar con http:// o https://';

  const _url = new URL(text);
  const url  = global.API(_url.origin, _url.pathname, Object.fromEntries(_url.searchParams.entries()), 'APIKEY');

  let buf, res, label;
  try {
    ({ buf, res, label } = await fetchWithBypass(url));
  } catch (e) {
    throw `❌ ${e.message}`;
  }

  const contentType   = res.headers.get('content-type') || '';
  const contentLength = buf.length;

  if (contentLength > 100 * 1024 * 1024) {
    throw `❌ El archivo es demasiado grande (${(contentLength / 1024 / 1024).toFixed(1)} MB)`;
  }

  const ext       = _url.pathname.split('.').pop()?.toLowerCase();
  const mediaType = Object.keys(MIME_MAP).find(k => MIME_MAP[k].some(t => contentType.includes(t)))
                    || EXT_MAP[ext] || null;

  if (mediaType === 'video')
    return conn.sendMessage(m.chat, { video: buf, mimetype: contentType || 'video/mp4' }, { quoted: m });
  if (mediaType === 'image')
    return conn.sendMessage(m.chat, { image: buf, mimetype: contentType || 'image/jpeg' }, { quoted: m });
  if (mediaType === 'audio')
    return conn.sendMessage(m.chat, { audio: buf, mimetype: contentType || 'audio/mpeg', ptt: false }, { quoted: m });
  if (mediaType === 'document') {
    const fileName = _url.pathname.split('/').pop() || 'file';
    return conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
  }

  if (/text|json/.test(contentType)) {
    let txt = buf.toString();
    try { txt = format(JSON.parse(txt)); } catch { /* texto plano */ }
    return m.reply(`${txt.slice(0, 65536)}\n\n_bypass: ${label}_`);
  }

  const fileName = _url.pathname.split('/').pop() || 'file';
  conn.sendMessage(m.chat, { document: buf, mimetype: contentType || 'application/octet-stream', fileName }, { quoted: m });
};

handler.help    = ['fetch', 'get'].map(v => v + ' <url>');
handler.tags    = ['internet'];
handler.command = /^(fetch|get)$/i;
handler.rowner  = false;
export default handler;
                                     
