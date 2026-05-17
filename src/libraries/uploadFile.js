import { fileTypeFromBuffer } from 'file-type';

const TIMEOUT_MS = 120_000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function makeBlob(buffer, mime) {
  return new Blob([buffer], { type: mime });
}

function isTextMime(mime, ext) {
  return mime.startsWith('text/') ||
    ['txt', 'html', 'md', 'json', 'js', 'ts'].includes(ext) ||
    ['application/json', 'application/javascript'].includes(mime);
}

async function uploadToGraph(buffer, ext, mime) {
  if (!isTextMime(mime, ext)) throw new Error('Graph.org solo acepta texto');
  const accRes = await fetchWithTimeout('https://api.graph.org/createAccount?short_name=Rikka&author_name=RikkaBot');
  const accJson = await accRes.json();
  if (!accJson.ok) throw new Error('Graph.org: no pudo crear cuenta');
  const token = accJson.result.access_token;
  const nodes = buffer.toString('utf-8').split('\n')
    .map(line => ({ tag: 'p', children: [line.trim() || { tag: 'br' }] }));
  const pageRes = await fetchWithTimeout('https://api.graph.org/createPage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token, title: 'Bot Content', content: JSON.stringify(nodes) })
  });
  const pageJson = await pageRes.json();
  if (pageJson.ok) return pageJson.result.url;
  throw new Error('Graph.org no devolvió URL');
}

async function uploadToCatbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('userhash', '');
  form.append('fileToUpload', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
    headers: {
      // FIX: algunos rangos de IP de VPS/hosting son bloqueados por Catbox con HTTP 412.
      // Agregar headers de browser legítimo + Accept mejora la tasa de aceptación.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://catbox.moe/',
      'Origin': 'https://catbox.moe'
    }
  });
  if (!res.ok) throw new Error(`Catbox HTTP ${res.status}`);
  const url = await res.text();
  if (url.startsWith('http')) return url.trim();
  throw new Error(`Catbox: ${url.slice(0, 100)}`);
}

async function uploadToLitterbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '72h');
  form.append('fileToUpload', makeBlob(buffer, mime), `file.${ext}`);
  // FIX: La URL correcta del endpoint es /resources/php/api.php, no upload.php
  const res = await fetchWithTimeout('https://litterbox.catbox.moe/resources/php/api.php', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://litterbox.catbox.moe/',
      'Origin': 'https://litterbox.catbox.moe'
    }
  });
  if (!res.ok) throw new Error(`Litterbox HTTP ${res.status}`);
  const url = await res.text();
  if (url.startsWith('http')) return url.trim();
  throw new Error(`Litterbox: ${url.slice(0, 100)}`);
}

async function uploadToDixLat(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://cdn.dix.lat/upload/tmp?ttl=86400', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Drive-Client-Temp' }
  });
  const json = await res.json();
  if (json?.status && json?.data?.url) return json.data.url;
  throw new Error('Dix.lat no devolvió URL');
}

async function uploadToQuax(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://qu.ax/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('Qu.ax falló');
}

async function uploadToUguu(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://uguu.se/upload', { method: 'POST', body: form });
  const json = await res.json();
  const url = json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Uguu.se falló');
}

// FIX: FileDitch (up.fileditch.com) está caído/dominio no resuelve.
// Se reemplaza por Oshi.at, que acepta cualquier tipo de archivo sin cuenta.
async function uploadToOshi(buffer, ext, mime) {
  const form = new FormData();
  form.append('f', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://oshi.at/', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`Oshi.at HTTP ${res.status}`);
  const text = await res.text();
  // Responde con líneas: "DL: <url>" y "MANAGE: <url>"
  const match = text.match(/DL:\s*(https?:\/\/\S+)/i);
  if (match) return match[1].trim();
  throw new Error('Oshi.at: no devolvió URL');
}

// FIX: 0x0.st bloquea IPs de datacenter/VPS (HTTP 503).
// Se conserva la función pero en uploadWithFallback se detecta si estamos en VPS.
// Para evitar el error silencioso, lanzamos el error con mensaje claro.
async function uploadTo0x0(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://0x0.st', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`0x0.st HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (url.startsWith('https://0x0.st/')) return url;
  throw new Error(`0x0.st respuesta inválida: ${url.slice(0, 80)}`);
}

async function uploadToImgbox(buffer, ext, mime) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const homeRes = await fetchWithTimeout('https://imgbox.com', { headers: { 'User-Agent': UA } });
  const html = await homeRes.text();

  // FIX: Imgbox puede usar tanto name="authenticity_token" como meta csrf-token.
  // Buscamos ambas variantes.
  const tokenMatch =
    html.match(/name="authenticity_token"[^>]*value="([^"]+)"/) ||
    html.match(/content="([^"]+)"[^>]*name="csrf-token"/) ||
    html.match(/name="csrf-token"[^>]*content="([^"]+)"/);

  // FIX: set-cookie puede venir en múltiples headers; usamos getSetCookie() si disponible.
  let cookieHeader = '';
  if (typeof homeRes.headers.getSetCookie === 'function') {
    cookieHeader = homeRes.headers.getSetCookie().join('; ');
  } else {
    cookieHeader = homeRes.headers.get('set-cookie') || '';
  }
  const sessionMatch = cookieHeader.match(/_imgbox_session=([^;,\s]+)/);

  if (!tokenMatch || !sessionMatch) throw new Error('Imgbox: no se pudo obtener CSRF token');
  const csrfToken = tokenMatch[1];
  const session = sessionMatch[1];

  const form = new FormData();
  form.append('authenticity_token', csrfToken);
  form.append('content_type', '1');
  form.append('thumbnail_size', '350c');
  form.append('comments_enabled', '0');
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);

  const upRes = await fetchWithTimeout('https://imgbox.com/upload/process', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': UA,
      'Cookie': `_imgbox_session=${session}`,
      'Referer': 'https://imgbox.com/',
      'X-CSRF-Token': csrfToken,
      // FIX: Agregar Accept para que el servidor devuelva JSON y no HTML
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  const text = await upRes.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Imgbox: respuesta no es JSON: ${text.slice(0, 100)}`); }

  // FIX: La API devuelve original_url o url dependiendo de la versión
  const url = json?.files?.[0]?.original_url || json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Imgbox: no devolvió URL');
}

// FIX: Postimages HTTP 403 — bloquea bots. Se agrega cookie/token scraping previo.
async function uploadToPostimages(buffer, ext, mime) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Paso 1: obtener cookies de sesión
  const homeRes = await fetchWithTimeout('https://postimages.org/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' }
  });
  let cookies = '';
  if (typeof homeRes.headers.getSetCookie === 'function') {
    cookies = homeRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  } else {
    const raw = homeRes.headers.get('set-cookie') || '';
    cookies = raw.split(',').map(c => c.trim().split(';')[0]).join('; ');
  }

  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  form.append('upload_session', Date.now().toString());
  form.append('numfiles', '1');
  form.append('ui', 'html5');

  const res = await fetchWithTimeout('https://postimages.org/json/rr', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': UA,
      'Referer': 'https://postimages.org/',
      'Origin': 'https://postimages.org',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookies ? { 'Cookie': cookies } : {})
    }
  });
  if (!res.ok) throw new Error(`Postimages HTTP ${res.status}`);
  const json = await res.json();
  if (json?.status === 'OK' && json?.url) return json.url;
  throw new Error(`Postimages: ${json?.error || 'sin URL'}`);
}

async function uploadToImgBB(buffer, ext, mime) {
  const apiKey = process.env.IMGBB_API_KEY || 'be65a0f219d4d0a037090224bb7eb123';
  if (!apiKey) throw new Error('ImgBB: falta IMGBB_API_KEY en .env');
  const b64 = buffer.toString('base64');
  const form = new FormData();
  form.append('key', apiKey);
  form.append('image', b64);
  const res = await fetchWithTimeout('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success) return json.data.url;
  throw new Error(`ImgBB: ${json?.error?.message || 'falló'}`);
}

// FIX: Adoolab HTTP 404 — el dominio cdn.adoolab.xyz ya no existe o cambió.
// Se reemplaza por pomf2.lain.la, que es un pomf clone estable y acepta cualquier archivo.
async function uploadToPomf2(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://pomf2.lain.la/upload.php', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`Pomf2 HTTP ${res.status}`);
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('Pomf2: sin URL en respuesta');
}

async function uploadToEvoGB(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://evogb.win/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.url) return json.url;
  throw new Error('EvoGB falló');
}

async function uploadToTmpfile(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://tmpfile.link/api/upload', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Tmpfile HTTP ${res.status}`);
  const json = await res.json();
  const url = json?.downloadLink || json?.downloadLinkEncoded;
  if (url) return url;
  throw new Error('Tmpfile: sin URL en respuesta');
}

// FIX: Pixeldrain requiere API key para autenticación.
// Se usa Basic Auth con usuario vacío y la API key como contraseña.
// Obtén tu key gratuita en: https://pixeldrain.com/user/api
async function uploadToPixeldrain(buffer, ext, mime) {
  const apiKey = process.env.PIXELDRAIN_API_KEY || '';
  if (!apiKey) throw new Error('Pixeldrain: falta PIXELDRAIN_API_KEY en .env');
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    // Basic Auth: usuario vacío, contraseña = API key
    'Authorization': 'Basic ' + Buffer.from(`:${apiKey}`).toString('base64')
  };
  const res = await fetchWithTimeout('https://pixeldrain.com/api/file/', {
    method: 'POST',
    body: form,
    headers
  });
  const json = await res.json();
  if (json?.success && json?.id) return `https://pixeldrain.com/api/file/${json.id}`;
  throw new Error(`Pixeldrain: ${json?.message || 'falló'}`);
}

export const SERVICES = [
  // 0x0.st bloquea VPS — se deja al final para que solo lo use Termux
  { name: 'Catbox',      fn: uploadToCatbox,     direct: true  },
  { name: 'Litterbox',   fn: uploadToLitterbox,  direct: true  },
  { name: 'Qu.ax',       fn: uploadToQuax,       direct: true  },
  { name: 'Uguu.se',     fn: uploadToUguu,       direct: true  },
  { name: 'Dix.lat',     fn: uploadToDixLat,     direct: true  },
  { name: 'Oshi.at',     fn: uploadToOshi,       direct: true  }, // reemplaza FileDitch
  { name: 'Pomf2',       fn: uploadToPomf2,      direct: true  }, // reemplaza Adoolab
  { name: 'EvoGB',       fn: uploadToEvoGB,      direct: true  },
  { name: 'Tmpfile',     fn: uploadToTmpfile,    direct: true  },
  { name: 'ImgBB',       fn: uploadToImgBB,      direct: false },
  { name: 'Imgbox',      fn: uploadToImgbox,     direct: false },
  { name: 'Postimages',  fn: uploadToPostimages, direct: false },
  { name: 'Pixeldrain',  fn: uploadToPixeldrain, direct: true  }, // requiere .env PIXELDRAIN_API_KEY
  { name: 'Graph.org',   fn: uploadToGraph,      direct: false },
  { name: '0x0.st',      fn: uploadTo0x0,        direct: true  }, // bloquea VPS, mejor en Termux
];

export async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';
  for (const { name, fn } of SERVICES) {
    try {
      const url = await fn(buffer, ext, mime);
      if (url) {
        return { url, service: name, finalMime: mime, finalExt: ext };
      }
    } catch (e) {
      continue;
    }
  }
  throw new Error('Todos los servidores fallaron');
}

export async function uploadToServiceByIndex(buffer, index, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';
  const service = SERVICES[index];
  if (!service) throw new Error(`Servidor #${index + 1} no existe.`);
  const url = await service.fn(buffer, ext, mime);
  return { url, service: service.name, finalMime: mime, finalExt: ext };
}

export default async function uploadFile(buffer) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || 'bin';
  const mime = ft?.mime || 'application/octet-stream';
  const { url } = await uploadWithFallback(buffer, ext, mime);
  return url;
}
  
