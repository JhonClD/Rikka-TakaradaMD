import uploadImage from '../src/libraries/uploadImage.js'
import { fileTypeFromBuffer } from 'file-type'

async function uploadToGraph(buffer, ext, mime) {
  try {
    const isText = mime.startsWith('text/') || ext === 'txt' || ext === 'html' || ext === 'md' || mime === 'application/json' || mime === 'application/javascript'
    if (isText) {
      const accRes = await fetch('https://api.graph.org/createAccount?short_name=Manus&author_name=ManusBot')
      const accJson = await accRes.json()
      if (accJson.ok) {
        const token = accJson.result.access_token
        const text = buffer.toString('utf-8')
        const nodes = text.split('\n').map(line => ({ tag: 'p', children: [line.trim() || { tag: 'br' }] }))
        const pageRes = await fetch('https://api.graph.org/createPage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            access_token: token,
            title: 'WhatsApp Content',
            content: JSON.stringify(nodes)
          })
        })
        const pageJson = await pageRes.json()
        if (pageJson.ok) return pageJson.result.url
      }
    }
    const blob = new Blob([buffer], { type: mime })
    const form = new FormData()
    form.append('file', blob, `file.${ext}`)
    const res = await fetch('https://graph.org/upload', { method: 'POST', body: form })
    const json = await res.json()
    const url = json?.[0]?.src
    if (url) return `https://graph.org${url}`
  } catch (e) {}
  throw new Error('Error en graph.org')
}

async function uploadTo0x0(buffer, ext, mime) {
  try {
    const blob = new Blob([buffer], { type: mime })
    const form = new FormData()
    form.append('file', blob, `file.${ext}`)
    const res = await fetch('https://0x0.st', { method: 'POST', body: form })
    if (res.ok) {
      const url = (await res.text()).trim()
      if (url.startsWith('http')) return url
    }
  } catch (e) {}
  throw new Error('Error en 0x0.st')
}

async function uploadToUguu(buffer, ext, mime) {
  try {
    const blob = new Blob([buffer], { type: mime })
    const form = new FormData()
    form.append('files[]', blob, `file.${ext}`)
    const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form })
    const json = await res.json()
    return json?.files?.[0]?.url
  } catch (e) {}
  throw new Error('Error en uguu.se')
}

// Nuevas funciones de subida
async function uploadToImgBB(buffer, ext, mime) {
  const apiKey = 'YOUR_IMGBB_API_KEY'; // Reemplazar con una API key real
  try {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), `file.${ext}`);
    form.append('key', apiKey);
    const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (json.success) return json.data.url;
  } catch (e) {}
  throw new Error('Error en ImgBB');
}

async function uploadToPicsur(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    const res = await fetch('https://picsur.org/api/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (json.status === 'success') return json.url;
  } catch (e) {}
  throw new Error('Error en Picsur');
}

async function uploadToPostimages(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    const res = await fetch('https://postimages.org/upload', { method: 'POST', body: form });
    const text = await res.text();
    const match = text.match(/"url":"(.*?)"/);
    if (match && match[1]) return match[1].replace(/\\/g, '');
  } catch (e) {}
  throw new Error('Error en Postimages');
}

async function uploadToLitterbox(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    form.append('time', '12h'); // Por defecto 12 horas
    const res = await fetch('https://litterbox.catbox.moe/resources/php/upload.php', { method: 'POST', body: form });
    const url = await res.text();
    if (url.startsWith('http')) return url;
  } catch (e) {}
  throw new Error('Error en Litterbox');
}

async function uploadToImgbox(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    const res = await fetch('https://imgbox.com/upload/process', { method: 'POST', body: form });
    const json = await res.json();
    if (json.files && json.files[0] && json.files[0].url) return json.files[0].url;
  } catch (e) {}
  throw new Error('Error en Imgbox');
}

async function uploadToEvoGB(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    const res = await fetch('https://evogb.win/api/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (json.success) return json.url;
  } catch (e) {}
  throw new Error('Error en EvoGB');
}

async function uploadToFileDitch(buffer, ext, mime) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `file.${ext}`);
    const res = await fetch('https://new.fileditch.com/upload.php', { method: 'POST', body: form });
    const json = await res.json();
    if (json.success) return json.url;
  } catch (e) {}
  throw new Error('Error en FileDitch');
}

async function uploadToDixLat(buffer, ext, mime) {
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mime });
    form.append('file', blob, `file.${ext}`);
    
    const ttl = 86400; // 24 horas por defecto
    const res = await fetch(`https://cdn.dix.lat/upload/tmp?ttl=${ttl}`, {
      method: 'POST',
      body: form,
      headers: { 'User-Agent': 'Drive-Client-Temp' }
    });
    
    const json = await res.json();
    if (json.status && json.data && json.data.url) return json.data.url;
  } catch (e) {}
  throw new Error('Error en Dix.lat');
}

async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer)
  const ext = ft?.ext || forcedExt || 'txt'
  const mime = ft?.mime || forcedMime || 'text/plain'
  const services = [
    { name: 'Graph.org', fn: () => uploadToGraph(buffer, ext, mime) },
    { name: 'Catbox', fn: () => uploadImage(buffer) },
    { name: 'Dix.lat', fn: () => uploadToDixLat(buffer, ext, mime) },
    { name: '0x0.st', fn: () => uploadTo0x0(buffer, ext, mime) },
    { name: 'Uguu.se', fn: () => uploadToUguu(buffer, ext, mime) },
    { name: 'ImgBB', fn: () => uploadToImgBB(buffer, ext, mime) },
    { name: 'Picsur', fn: () => uploadToPicsur(buffer, ext, mime) },
    { name: 'Postimages', fn: () => uploadToPostimages(buffer, ext, mime) },
    { name: 'Litterbox', fn: () => uploadToLitterbox(buffer, ext, mime) },
    { name: 'Imgbox', fn: () => uploadToImgbox(buffer, ext, mime) },
    { name: 'EvoGB', fn: () => uploadToEvoGB(buffer, ext, mime) },
    { name: 'FileDitch', fn: () => uploadToFileDitch(buffer, ext, mime) }
  ]
  for (const { name, fn } of services) {
    try {
      const url = await fn()
      if (url) return { url, service: name, finalMime: mime, finalExt: ext }
    } catch (e) {}
  }
  throw new Error('Servidores fuera de servicio')
}

const handler = async (m, { conn, text }) => {
  const q = m.quoted ? m.quoted : m
  let buffer
  let mime = (q.msg || q).mimetype || ''
  let originalName = (q.msg || q).fileName || ''

  if (text) {
    buffer = Buffer.from(text, 'utf-8')
    mime = 'text/plain'
  } else if (!mime || mime === 'text/plain' || (!/image|video|audio|sticker|document/.test(mime))) {
    const content = q.text || q.caption || (q.msg && (q.msg.text || q.msg.caption)) || ''
    if (content) {
      buffer = Buffer.from(content, 'utf-8')
      mime = 'text/plain'
    }
  }

  if (!buffer) {
    buffer = await q.download?.().catch(() => null)
  }

  if (!buffer || buffer.length === 0) throw '❌ No se encontró contenido.'
  
  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚ Subiendo...')
  
  try {
    const { url: link, service, finalMime, finalExt } = await uploadWithFallback(buffer, 'txt', mime)
    
    const urlObj = (() => { try { return new URL(link) } catch { return null } })()
    const displayFileName = originalName || urlObj?.pathname?.split('/').pop() || `file_${Date.now()}.${finalExt}`
    
    const pesoTxt = buffer.length >= 1024 * 1024
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
      : `${(buffer.length / 1024).toFixed(1)} KB`

    await conn.sendMessage(m.chat, { 
      text: `ִֶָ𓂃 ࣪˖ ִֶָ *FILE UPLOADED* ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
            `⭑ ₊ ⭒ *NAME* ꩜ \`${displayFileName}\`\n` +
            `⭑ ₊ ⭒ *SIZE* ꩜ \`${pesoTxt}\`\n` +
            `⭑ ₊ ⭒ *TYPE* ꩜ \`${finalMime}\`\n` +
            `⭑ ₊ ⭒ *SERVER* ꩜ \`${service}\`\n\n` +
            `˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗ *URL*\n` +
            `${link}\n\n` +
            `✧˚ ༘ ⋆｡˚ 𖥔 ࣪˖`,
      edit: statusKey 
    }, { quoted: m })
  } catch (e) {
    await conn.sendMessage(m.chat, { text: `❌ Error: ${e.message}`, edit: statusKey }, { quoted: m })
  }
}

handler.help = ['tourl']
handler.tags = ['converter']
handler.command = /^(upload|uploader|tourl)$/i

export default handler
      
