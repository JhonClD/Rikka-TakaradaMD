// plugins/terabox.js
// Descarga videos de Terabox — Rikka-TakaradaMD
// Usa APIs públicas gratuitas (sin necesidad de cuenta Terabox)

import fetch from 'node-fetch'

// ── APIs con fallback ─────────────────────────────────────
const APIS = [
  // API 1: terabox-downloader worker
  async (url) => {
    const res = await fetch('https://terabox.hnn.workers.dev/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    if (!d?.downloadLink && !d?.url && !d?.link) throw new Error('Sin link')
    const link = d.downloadLink || d.url || d.link
    const name = d.name || d.filename || d.title || 'video.mp4'
    const size = d.size || d.fileSize || 0
    return { link, name, size, thumb: d.thumbnail || d.thumb || null }
  },

  // API 2: ytshorts.savetube.me
  async (url) => {
    const res = await fetch('https://ytshorts.savetube.me/api/v1/terabox-downloader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://ytshorts.savetube.me/' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    if (!d?.response?.[0]?.resolutions) throw new Error('Sin resoluciones')
    const resolutions = d.response[0].resolutions
    const link = resolutions['Fast Download'] || resolutions['HD Video'] || Object.values(resolutions)[0]
    if (!link) throw new Error('Sin link')
    const name = d.response[0].name || 'video.mp4'
    const size = d.response[0].size || 0
    const thumb = d.response[0].thumbnail || null
    return { link, name, size, thumb }
  },

  // API 3: teraboxlink.nexus
  async (url) => {
    const res = await fetch(`https://teraboxlink.nexus/api/get?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    if (!d?.dlink && !d?.download_link) throw new Error('Sin link')
    const link = d.dlink || d.download_link
    const name = d.name || d.filename || 'video.mp4'
    const size = d.size || 0
    return { link, name, size, thumb: d.thumb || null }
  },

  // API 4: terabox-app worker
  async (url) => {
    const res = await fetch(`https://terabox-app.hnn.workers.dev/?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    if (!d?.direct_link && !d?.url) throw new Error('Sin link')
    const link = d.direct_link || d.url
    const name = d.name || d.filename || 'video.mp4'
    const size = d.size || 0
    return { link, name, size, thumb: d.thumbnail || null }
  }
]

// ── Helper: formatear bytes ───────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ── Helper: obtener info de descarga con fallback ─────────
async function getTeraboxInfo(url) {
  const errors = []
  for (let i = 0; i < APIS.length; i++) {
    try {
      console.log(`[terabox] Intentando API ${i + 1}...`)
      const info = await APIS[i](url)
      console.log(`[terabox] ✅ API ${i + 1} OK → ${info.name}`)
      return info
    } catch (e) {
      console.warn(`[terabox] ⚠️ API ${i + 1} falló: ${e.message}`)
      errors.push(`API ${i + 1}: ${e.message}`)
    }
  }
  throw new Error(`Todas las APIs fallaron:\n${errors.join('\n')}`)
}

// ── Helper: descargar buffer desde URL ───────────────────
async function downloadBuffer(url, name) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.terabox.com/'
    },
    signal: AbortSignal.timeout(120_000) // 2 minutos para archivos grandes
  })
  if (!res.ok) throw new Error(`Error descargando: HTTP ${res.status}`)
  const buffer = await res.buffer()
  return buffer
}

// ── Detectar si es URL de Terabox ────────────────────────
function isTeraboxUrl(url) {
  return /terabox\.com|1024terabox\.com|terafileshare\.com|4funbox\.com|teraboxapp\.com|mirrobox\.com|nephobox\.com|freeterabox\.com/i.test(url)
}

// ── Extraer URL del texto ─────────────────────────────────
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/)
  return match ? match[0] : null
}

// ── Handler principal ─────────────────────────────────────
const handler = async (m, { conn, text, args }) => {
  const input = text?.trim() || args?.[0] || ''

  // Intentar extraer URL del texto o del mensaje citado
  let url = extractUrl(input)

  if (!url && m.quoted?.text) {
    url = extractUrl(m.quoted.text)
  }

  if (!url) {
    return m.reply(`❌ *¡Ne ne! Necesito un link de Terabox.*

*Uso:*
• .terabox https://terabox.com/s/...
• Responde a un mensaje con el link y escribe .terabox

*Dominios soportados:*
terabox.com, 1024terabox.com, teraboxapp.com, y más.`)
  }

  if (!isTeraboxUrl(url)) {
    return m.reply('❌ ¡Ese link no es de Terabox! Envía un link válido de terabox.com.')
  }

  await m.conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })
  const waitMsg = await m.reply('⏳ Obteniendo info del archivo...')

  let info
  try {
    info = await getTeraboxInfo(url)
  } catch (e) {
    await m.conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    return m.reply(`❌ No pude obtener el link de descarga.\n\n_${e.message}_`)
  }

  const sizeText = formatBytes(info.size)
  const isVideo = /\.(mp4|mkv|webm|mov|avi|flv|m4v|ts)$/i.test(info.name)
  const isAudio = /\.(mp3|m4a|flac|wav|ogg|opus|aac)$/i.test(info.name)

  // Límite de WhatsApp: ~200MB aprox
  const MAX_SIZE = 200 * 1024 * 1024
  if (info.size && info.size > MAX_SIZE) {
    await m.conn.sendMessage(m.chat, { react: { text: '⚠️', key: m.key } })
    return m.reply(`⚠️ *Archivo demasiado grande para enviar por WhatsApp*

📁 *Nombre:* ${info.name}
📦 *Tamaño:* ${sizeText}

Usa este link para descargarlo directamente:
${info.link}`)
  }

  try {
    await m.reply(`📥 Descargando *${info.name}*${sizeText ? ` (${sizeText})` : ''}...`)

    const buffer = await downloadBuffer(info.link, info.name)

    await m.conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } })

    if (isVideo) {
      await conn.sendMessage(m.chat, {
        video: buffer,
        caption: `🎬 *${info.name}*${sizeText ? `\n📦 ${sizeText}` : ''}`,
        mimetype: 'video/mp4',
        fileName: info.name
      }, { quoted: m })

    } else if (isAudio) {
      await conn.sendMessage(m.chat, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        ptt: false,
        fileName: info.name
      }, { quoted: m })

    } else {
      await conn.sendMessage(m.chat, {
        document: buffer,
        mimetype: 'application/octet-stream',
        fileName: info.name,
        caption: `📁 *${info.name}*${sizeText ? `\n📦 ${sizeText}` : ''}`
      }, { quoted: m })
    }

  } catch (e) {
    console.error('[terabox] Error descargando:', e.message)
    await m.conn.sendMessage(m.chat, { react: { text: '⚠️', key: m.key } })
    // Si falla la descarga directa → enviar el link
    await m.reply(`⚠️ No pude descargar el archivo directamente. Aquí tienes el link:

📁 *${info.name}*${sizeText ? `\n📦 ${sizeText}` : ''}

🔗 ${info.link}`)
  }
}

handler.help = ['terabox <url>']
handler.tags = ['downloader']
handler.command = ['terabox', 'tb', 'tera']
handler.description = 'Descarga videos/archivos de Terabox'

export default handler
      
