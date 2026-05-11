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

async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer)
  const ext = ft?.ext || forcedExt || 'txt'
  const mime = ft?.mime || forcedMime || 'text/plain'
  const services = [
    { name: 'Graph.org', fn: () => uploadToGraph(buffer, ext, mime) },
    { name: 'Catbox', fn: () => uploadImage(buffer) },
    { name: '0x0.st', fn: () => uploadTo0x0(buffer, ext, mime) },
    { name: 'Uguu.se', fn: () => uploadToUguu(buffer, ext, mime) }
  ]
  for (const { name, fn } of services) {
    try {
      const url = await fn()
      if (url) return { url, service: name, finalMime: mime }
    } catch (e) {}
  }
  throw new Error('Todos los servicios fallaron')
}

const handler = async (m, { conn, text }) => {
  const q = m.quoted ? m.quoted : m
  let buffer
  let mime = (q.msg || q).mimetype || ''

  if (text && !m.quoted) {
    buffer = Buffer.from(text, 'utf-8')
    mime = 'text/plain'
  } else {
    // Intento de descarga de media
    buffer = await q.download?.().catch(() => null)
    
    // Si no es media, buscamos texto en cualquier rincón del mensaje citado
    if (!buffer) {
      const content = q.text || 
                      q.caption || 
                      (q.msg && (q.msg.text || q.msg.caption || q.msg.contentText || q.msg.selectedDisplayText)) || 
                      (m.quoted && m.quoted.text) || 
                      ''
      
      if (content) {
        buffer = Buffer.from(content, 'utf-8')
        mime = 'text/plain'
      }
    }
  }

  if (!buffer || buffer.length === 0) throw '❌ No se encontró texto o archivo para subir.'
  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚ Subiendo...')
  
  try {
    const { url: link, service, finalMime } = await uploadWithFallback(buffer, 'txt', mime)
    const pesoTxt = buffer.length >= 1024 * 1024
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
      : `${(buffer.length / 1024).toFixed(1)} KB`

    await conn.sendMessage(m.chat, { 
      text: `ִֶָ𓂃 ࣪˖ ִֶָ *FILE UPLOADED* ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
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
    
