import { fileTypeFromBuffer } from 'file-type';

function makeBlob(buffer, mime) {
  return new Blob([buffer], { type: mime });
}

async function uploadToGraph(buffer, ext, mime) {
  const isText = mime.startsWith('text/') || ['txt', 'html', 'md'].includes(ext)
    || ['application/json', 'application/javascript'].includes(mime);
  if (isText) {
    const accRes = await fetch('https://api.graph.org/createAccount?short_name=Manus&author_name=ManusBot');
    const accJson = await accRes.json();
    if (accJson.ok) {
      const token = accJson.result.access_token;
      const nodes = buffer.toString('utf-8').split('\n')
        .map(line => ({ tag: 'p', children: [line.trim() || { tag: 'br' }] }));
      const pageRes = await fetch('https://api.graph.org/createPage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: token, title: 'WhatsApp Content', content: JSON.stringify(nodes) })
      });
      const pageJson = await pageRes.json();
      if (pageJson.ok) return pageJson.result.url;
    }
  }
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://graph.org/upload', { method: 'POST', body: form });
  const json = await res.json();
  const url = json?.[0]?.src;
  if (url) return `https://graph.org${url}`;
  throw new Error('Graph.org no devolvió URL');
}

async function uploadToCatbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', makeBlob(buffer, mime), `tmp.${ext}`);
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Catbox HTTP ${res.status}`);
  const url = await res.text();
  if (url.startsWith('http')) return url.trim();
  throw new Error('Catbox no devolvió un enlace válido');
}

async function uploadToQuax(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `tmp.${ext}`);
  const res = await fetch('https://qu.ax/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success && json?.files?.[0]?.url) return json.files[0].url;
  throw new Error('Qu.ax no devolvió respuesta exitosa');
}

async function uploadToDixLat(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch(`https://cdn.dix.lat/upload/tmp?ttl=86400`, {
    method: 'POST', body: form,
    headers: { 'User-Agent': 'Drive-Client-Temp' }
  });
  const json = await res.json();
  if (json?.status && json?.data?.url) return json.data.url;
  throw new Error('Dix.lat no devolvió URL');
}

async function uploadTo0x0(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://0x0.st', { method: 'POST', body: form });
  if (res.ok) {
    const url = (await res.text()).trim();
    if (url.startsWith('http')) return url;
  }
  throw new Error('0x0.st falló');
}

async function uploadToUguu(buffer, ext, mime) {
  const form = new FormData();
  form.append('files[]', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form });
  const json = await res.json();
  const url = json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Uguu.se falló');
}

async function uploadToLitterbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  form.append('time', '12h');
  const res = await fetch('https://litterbox.catbox.moe/resources/php/upload.php', { method: 'POST', body: form });
  const url = await res.text();
  if (url.startsWith('http')) return url;
  throw new Error('Litterbox falló');
}

async function uploadToFileDitch(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://new.fileditch.com/upload.php', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success) return json.url;
  throw new Error('FileDitch falló');
}

async function uploadToImgbox(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://imgbox.com/upload/process', { method: 'POST', body: form });
  const json = await res.json();
  const url = json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Imgbox falló');
}

async function uploadToEvoGB(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://evogb.win/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success) return json.url;
  throw new Error('EvoGB falló');
}

async function uploadToImgBB(buffer, ext, mime) {
  const apiKey = 'YOUR_IMGBB_API_KEY';
  const form = new FormData();
  form.append('image', makeBlob(buffer, mime), `file.${ext}`);
  form.append('key', apiKey);
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.success) return json.data.url;
  throw new Error('ImgBB falló');
}

async function uploadToPicsur(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://picsur.org/api/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json?.status === 'success') return json.url;
  throw new Error('Picsur falló');
}

async function uploadToPostimages(buffer, ext, mime) {
  const form = new FormData();
  form.append('file', makeBlob(buffer, mime), `file.${ext}`);
  const res = await fetch('https://postimages.org/upload', { method: 'POST', body: form });
  const text = await res.text();
  const match = text.match(/"url":"(.*?)"/);
  if (match?.[1]) return match[1].replace(/\\/g, '');
  throw new Error('Postimages falló');
}

export async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext || forcedExt || 'txt';
  const mime = ft?.mime || forcedMime || 'text/plain';

  const services = [
    { name: 'Graph.org',  fn: () => uploadToGraph(buffer, ext, mime)     },
    { name: 'Catbox',     fn: () => uploadToCatbox(buffer, ext, mime)     },
    { name: 'Qu.ax',      fn: () => uploadToQuax(buffer, ext, mime)       },
    { name: 'Dix.lat',    fn: () => uploadToDixLat(buffer, ext, mime)     },
    { name: '0x0.st',     fn: () => uploadTo0x0(buffer, ext, mime)        },
    { name: 'Uguu.se',    fn: () => uploadToUguu(buffer, ext, mime)       },
    { name: 'Litterbox',  fn: () => uploadToLitterbox(buffer, ext, mime)  },
    { name: 'FileDitch',  fn: () => uploadToFileDitch(buffer, ext, mime)  },
    { name: 'Imgbox',     fn: () => uploadToImgbox(buffer, ext, mime)     },
    { name: 'EvoGB',      fn: () => uploadToEvoGB(buffer, ext, mime)      },
    { name: 'ImgBB',      fn: () => uploadToImgBB(buffer, ext, mime)      },
    { name: 'Picsur',     fn: () => uploadToPicsur(buffer, ext, mime)     },
    { name: 'Postimages', fn: () => uploadToPostimages(buffer, ext, mime) },
  ];

  for (const { name, fn } of services) {
    try {
      const url = await fn();
      if (url) {
        console.log(`✅ [uploadImage] Subido en ${name}`);
        return { url, service: name, finalMime: mime, finalExt: ext };
      }
    } catch (e) {
      console.log(`⚠️ [uploadImage] ${name} falló: ${e.message}`);
    }
  }

  throw new Error('Todos los servidores fallaron');
}

export default async (buffer) => {
  const { ext, mime } = await fileTypeFromBuffer(buffer) || { ext: 'jpg', mime: 'image/jpeg' };
  try {
    return await uploadToCatbox(buffer, ext, mime);
  } catch (e) {
    console.log('⚠️ [uploadImage] Catbox falló, intentando Qu.ax:', e.message);
    try {
      return await uploadToQuax(buffer, ext, mime);
    } catch (err2) {
      console.error('❌ [uploadImage] Catbox y Qu.ax fallaron:', err2.message);
      throw 'Fallo general al subir la imagen a la nube.';
    }
  }
};
    
