import uploadImage from '../src/libraries/uploadImage.js'
import { fileTypeFromBuffer } from 'file-type'

async function uploadToGraphText(buffer) {
  const text = buffer.toString('utf-8')
  const body = {
    title: 'Text Content',
    author_name: 'Bot',
    content: [{ tag: 'p', children: [text] }],
    return_content: false
  }
  const res = await fetch('https://api.graph.org/createPage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await res.json()
  if (json.ok && json.result?.url) return json.result.url
  throw new Error('Graph Text falló')
}

async function uploadToGraphFile(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res = await fetch('https://graph.org/upload', { method: 'POST', body: form })
  const json = await res.json()
  const url = json?.[0]?.src
  if (url) return `https://graph.org${url}`
  throw new Error('Graph File falló')
}

async function uploadTo0x0(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res = await fetch('https://0x0.st', { method: 'POST', body: form })
  const url = (await res.text()).trim()
  if (url.startsWith('http')) return url
  throw new Error('0x0.st falló')
}

async function uploadToUguu(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('files[]', blob, `file.${ext}`)
  const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form })
  const json = await res.json()
  return json?.files?.[0]?.url
}

async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer)
  const ext = ft?.ext || forcedExt || 'txt'
  const mime = ft?.mime || forcedMime || 'text/plain'

  const services = []

  if (mime.startsWith('text/') || ext === 'txt') {
    services.push({ name: 'Graph (Telegraph)', fn: () => uploadToGraphText(buffer) })
  }

  services.push(
    { name: 'Graph.org (File)', fn: () => uploadToGraphFile(buffer, ext, mime) },
    { name: 'Catbox', fn: () => uploadImage(buffer) },
    { name: '0x0.st', fn: () => uploadTo0x0(buffer, ext, mime) },
    { name: 'uguu.se', fn: () => uploadToUguu(buffer, ext, mime) }
  )

  const errors = []
  for (const { name, fn } of services) {
    try {
      const url = await fn()
      if (url) return { url, service: name, finalMime: mime, finalExt: ext }
    } catch (e) {
      errors.push(`${name}: ${e.message}`)
    }
  }
  throw new Error('Fallo total:\n' + errors.join('\n'))
}

const handler = async (m, { conn, text }) => {
  const q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || ''
  let buffer

  if (text && !m.quoted) {
    buffer = Buffer.from(text, 'utf-8')
    mime = 'text/plain'
  } else {
    buffer = await q.download?.().catch(() => null)
    if (!buffer && (q.text || q.caption)) {
      buffer = Buffer.from(q.text || q.caption, 'utf-8')
      mime = 'text/plain'
    }
  }

  if (!buffer || buffer.length === 0) throw '❌ Contenido vacío.'
  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚  Subiendo...')
  
  try {
    const { url: link, service, finalMime } = await uploadWithFallback(buffer, 'txt', mime)
    const pesoTxt = buffer.length >= 1024 * 1024 
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB` 
      : `${(buffer.length / 1024).toFixed(1)} KB`

    await conn.sendMessage(m.chat, { 
      text: `ִֶָ𓂃 ࣪˖ ִֶָ  *FILE UPLOADED* ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
            `⭑ ₊ ⭒  *SIZE* ꩜  \`${pesoTxt}\`\n` +
            `⭑ ₊ ⭒  *TYPE* ꩜  \`${finalMime}\`\n` +
            `⭑ ₊ ⭒  *SERVER* ꩜  \`${service}\`\n\n` +
            `˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  *URL*\n` +
            `${link}\n\n` +
            `✧˚ ༘ ⋆｡˚  𖥔 ࣪˖`,
      edit: statusKey 
    }, { quoted: m })
  } catch (e) {
    await conn.sendMessage(m.chat, { text: `❌ Error: ${e.message}`, edit: statusKey }, { quoted: m })
  }
}

handler.help = ['tourl', 'upload']
handler.tags = ['converter']
handler.command = /^(upload|uploader|tourl)$/i

export default handler
