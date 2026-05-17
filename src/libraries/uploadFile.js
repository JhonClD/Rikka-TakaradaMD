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
  if (!accJson.ok) throw new Error('Graph.org no pudo crear cuenta');
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
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Catbox HTTP ${res.status}`);
  const url = await res.text();
  if (url.startsWith('http')) return url.trim();
  throw new Error('Catbox no devolvió enlace válido');
}

async function uploadToLitterbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '72h');
  form.append('fileToUpload', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://litterbox.catbox.moe/resources/php/upload.php', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Litterbox HTTP ${res.status}`);
  const url = await res.text();
  if (url.startsWith('http')) return url.trim();
  throw new Error('Litterbox no devolvió enlace válido');
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

async function uploadToFileDitch(buffer, ext, mime) {
  const form = new FormData();
  form.append('file[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://up.fileditch.com/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('FileDitch falló');
}

async function uploadToAdoolab(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://cdn.adoolab.xyz/upload', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Adoolab HTTP ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    const url = json?.url || json?.data?.url || json?.file?.url || json?.link;
    if (url) return url;
  } catch {
    if (text.startsWith('http')) return text.trim();
  }
  throw new Error('Adoolab no devolvió URL válida');
}

async function uploadToEvoGB(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://evogb.win/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.url) return json.url;
  throw new Error('EvoGB falló');
}

export const SERVICES = [
  { name: 'Dix.lat',    fn: uploadToDixLat    },
  { name: 'Catbox',     fn: uploadToCatbox    },
  { name: 'Litterbox',  fn: uploadToLitterbox },
  { name: 'Qu.ax',      fn: uploadToQuax      },
  { name: 'Uguu.se',    fn: uploadToUguu      },
  { name: 'FileDitch',  fn: uploadToFileDitch },
  { name: 'Adoolab',    fn: uploadToAdoolab   },
  { name: 'EvoGB',      fn: uploadToEvoGB     },
  { name: 'Graph.org',  fn: uploadToGraph     },
];

export async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';
  for (const { name, fn } of SERVICES) {
    try {
      const url = await fn(buffer, ext, mime);
      if (url) {
        console.log(`✅ [uploadFile] Subido en ${name}`);
        return { url, service: name, finalMime: mime, finalExt: ext };
      }
    } catch (e) {
      console.log(`⚠️ [uploadFile] ${name} falló: ${e.message}`);
    }
  }
  throw new Error('Todos los servidores fallaron');
}

export async function uploadToServiceByIndex(buffer, index, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';
  const service = SERVICES[index];
  if (!service) throw new Error(`Servidor #${index + 1} no existe. Máximo: ${SERVICES.length}`);
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
  
