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

function isImageMime(mime) {
  return mime.startsWith('image/');
}

async function uploadToAdoolab(buffer, ext, mime) {
  const b64 = buffer.toString('base64');
  const res = await fetchWithTimeout('https://cdn.adoolab.xyz/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: `file.${ext}`, data: b64, expiration: 'never' })
  });
  if (!res.ok) throw new Error(`Adoolab HTTP ${res.status}`);
  const json = await res.json();
  const url = json?.url || json?.data?.url || json?.file?.url || json?.link;
  if (url) return url;
  throw new Error('Adoolab: sin URL en respuesta');
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

async function uploadToEvoGB(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://evogb.win/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.url) return json.url;
  throw new Error('EvoGB falló');
}

async function uploadToFreeimageHost(buffer, ext, mime) {
  if (!isImageMime(mime)) throw new Error('Freeimage.host solo acepta imágenes');
  const apiKey = process.env.FREEIMAGE_API_KEY || '6d207e02198a847aa98d0a2a901485a5';
  const form = new FormData();
  form.append('key', apiKey);
  form.append('action', 'upload');
  form.append('source', makeBlob(buffer, mime), `file.${ext}`);
  form.append('format', 'json');
  const res = await fetchWithTimeout('https://freeimage.host/api/1/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.status_code === 200 && json?.image?.url) return json.image.url;
  throw new Error(`Freeimage.host: ${json?.error?.message || 'falló'}`);
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

async function uploadToImghippo(buffer, ext, mime) {
  if (!isImageMime(mime)) throw new Error('Imghippo solo acepta imágenes');
  const apiKey = process.env.IMGHIPPO_API_KEY || '';
  if (!apiKey) throw new Error('Imghippo: falta IMGHIPPO_API_KEY en .env');
  const form = new FormData();
  form.append('api_key', apiKey);
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://api.imghippo.com/v1/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.status === 200 && json?.data?.url) return json.data.url;
  throw new Error(`Imghippo: ${json?.message || 'falló'}`);
}

async function uploadToQuax(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://qu.ax/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('Qu.ax falló');
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

async function uploadToUguu(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://uguu.se/upload', { method: 'POST', body: form });
  const json = await res.json();
  const url = json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Uguu.se falló');
}

export const SERVICES = [
  { name: 'Adoolab',        fn: uploadToAdoolab,       direct: true  },
  { name: 'Dix.lat',        fn: uploadToDixLat,        direct: true  },
  { name: 'EvoGB',          fn: uploadToEvoGB,         direct: true  },
  { name: 'Freeimage.host', fn: uploadToFreeimageHost, direct: true  },
  { name: 'Graph.org',      fn: uploadToGraph,         direct: false },
  { name: 'ImgBB',          fn: uploadToImgBB,         direct: false },
  { name: 'Imghippo',       fn: uploadToImghippo,      direct: true  },
  { name: 'Qu.ax',          fn: uploadToQuax,          direct: true  },
  { name: 'Tmpfile',        fn: uploadToTmpfile,       direct: true  },
  { name: 'Uguu.se',        fn: uploadToUguu,          direct: true  }
];

export async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';
  for (const { name, fn } of SERVICES) {
    try {
      const url = await fn(buffer, ext, mime);
      if (url) return { url, service: name, finalMime: mime, finalExt: ext };
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
      
