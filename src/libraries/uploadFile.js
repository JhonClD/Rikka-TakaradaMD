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
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
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
  const res = await fetchWithTimeout('https://litterbox.catbox.moe/resources/php/upload.php', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
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

async function uploadToFileDitch(buffer, ext, mime) {
  const form = new FormData();
  form.append('file[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout('https://up.fileditch.com/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('FileDitch falló');
}

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
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const homeRes = await fetchWithTimeout('https://imgbox.com', { headers: { 'User-Agent': UA } });
  const html = await homeRes.text();
  const tokenMatch = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
  const cookieHeader = homeRes.headers.get('set-cookie') || '';
  const sessionMatch = cookieHeader.match(/_imgbox_session=([^;]+)/);
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
      'X-CSRF-Token': csrfToken
    }
  });
  const json = await upRes.json();
  const url = json?.files?.[0]?.original_url;
  if (url) return url;
  throw new Error('Imgbox: no devolvió URL');
}

async function uploadToPostimages(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  form.append('upload_session', Date.now().toString());
  const res = await fetchWithTimeout('https://postimages.org/json/rr', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Referer': 'https://postimages.org/',
      'Origin': 'https://postimages.org'
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
  throw new Error('Adoolab: sin URL en respuesta');
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

async function uploadToPixeldrain(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetchWithTimeout(`https://pixeldrain.com/api/file/`, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const json = await res.json();
  if (json?.success && json?.id) return `https://pixeldrain.com/api/file/${json.id}`;
  throw new Error(`Pixeldrain: ${json?.message || 'falló'}`);
}

export const SERVICES = [
  { name: '0x0.st', fn: uploadTo0x0, direct: true },
  { name: 'Adoolab', fn: uploadToAdoolab, direct: true },
  { name: 'Catbox', fn: uploadToCatbox, direct: true },
  { name: 'Dix.lat', fn: uploadToDixLat, direct: true },
  { name: 'EvoGB', fn: uploadToEvoGB, direct: true },
  { name: 'FileDitch', fn: uploadToFileDitch, direct: true },
  { name: 'Graph.org', fn: uploadToGraph, direct: false },
  { name: 'ImgBB', fn: uploadToImgBB, direct: false },
  { name: 'Imgbox', fn: uploadToImgbox, direct: false },
  { name: 'Litterbox', fn: uploadToLitterbox, direct: true },
  { name: 'Pixeldrain', fn: uploadToPixeldrain, direct: true },
  { name: 'Postimages', fn: uploadToPostimages, direct: false },
  { name: 'Qu.ax', fn: uploadToQuax, direct: true },
  { name: 'Tmpfile', fn: uploadToTmpfile, direct: true },
  { name: 'Uguu.se', fn: uploadToUguu, direct: true }
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
  
