import uploadImage from '../src/libraries/uploadImage.js'
import { fileTypeFromBuffer } from 'file-type'
import { format } from 'util'

async function uploadToGraph(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res = await fetch('https://graph.org/upload', { method: 'POST', body: form })
  const json = await res.json()
  const url = json?.[0]?.src
  if (url) return `https://graph.org${url}`
  throw new Error('graph.org falló')
}

async function uploadTo0x0(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res = await fetch('https://0x0.st', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`0x0.st HTTP ${res.status}`)
  const url = (await res.text()).trim()
  if (url.startsWith('http')) return url
  throw new Error('0x0.st falló')
}

async function uploadToUguu(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('files[]', blob, `file.${ext}`)
  const res  = await fetch('https://uguu.se/upload', { method: 'POST', body: form })
  const json = await res.json()
  const url  = json?.files?.[0]?.url
  if (url) return url
  throw new Error('uguu.se falló')
}

async function uploadToTmpfiles(buffer, ext, mime) {
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res  = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form })
  const json = await res.json()
  const url  = json?.data?.url
  if (url) return url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
  throw new Error('tmpfiles.org falló')
}

async function uploadToGoFile(buffer, ext, mime) {
  const srv  = await fetch('https://api.gofile.io/servers')
  const srvJ = await srv.json()
  const server = srvJ?.data?.servers?.[0]?.name
  if (!server) throw new Error('GoFile: no server')
  const blob = new Blob([buffer], { type: mime })
  const form = new FormData()
  form.append('file', blob, `file.${ext}`)
  const res  = await fetch(`https://${server}.gofile.io/contents/uploadfile`, { method: 'POST', body: form })
  const json = await res.json()
  const url  = json?.data?.downloadPage
  if (url) return url
  throw new Error('GoFile falló')
}

async function uploadWithFallback(buffer, forcedExt, forcedMime) {
  const ft = await fileTypeFromBuffer(buffer)
  const ext = ft?.ext || forcedExt || 'txt'
  const mime = ft?.mime || forcedMime || 'text/plain'

  const services = [
    { name: 'Graph.org',      fn: () => uploadToGraph(buffer, ext, mime) },
    { name: 'Catbox / Qu.ax', fn: () => uploadImage(buffer) },
    { name: '0x0.st',         fn: () => uploadTo0x0(buffer, ext, mime) },
    { name: 'uguu.se',        fn: () => uploadToUguu(buffer, ext, mime) },
    { name: 'tmpfiles.org',   fn: () => uploadToTmpfiles(buffer, ext, mime) },
    { name: 'GoFile',         fn: () => uploadToGoFile(buffer, ext, mime) },
  ]

  const errors = []
  for (const { name, fn } of services) {
    try {
      const url = await fn()
      if (url) return { url, service: name, finalMime: mime }
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
  let forcedExt = 'txt'

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

  if (!buffer || buffer.length === 0) throw '❌ El contenido está vacío o no se pudo descargar.'

  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚  Subiendo...')
  
  try {
    const pesoTxt = buffer.length >= 1024 * 1024
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
      : `${(buffer.length / 1024).toFixed(1)} KB`

    const { url: link, service, finalMime } = await uploadWithFallback(buffer, forcedExt, mime)

    const urlObj = (() => { try { return new URL(link) } catch { return null } })()
    const fileName = urlObj?.pathname?.split('/').pop() || 'file_' + Date.now() + '.' + forcedExt

    await conn.sendMessage(m.chat, { 
      text: `ִֶָ𓂃 ࣪˖ ִֶָ  *FILE UPLOADED* ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
            `⭑ ₊ ⭒  *NAME* ꩜  \`${fileName}\`\n` +
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

handler.help    = ['tourl', 'upload']
handler.tags    = ['converter']
handler.command = /^(upload|uploader|tourl)$/i

export default handler
    
