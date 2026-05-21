// plugins/terabox-dowloader.js
// Descarga videos/archivos de Terabox — Rikka-TakaradaMD
// Estrategia: scraper nativo (extrae jsToken del HTML) + APIs externas de fallback

import fetch from 'node-fetch'

// ── Config ────────────────────────────────────────────────
// Opcional: si tienes cookie de sesión propia de Terabox, pégala aquí
// para aumentar la tasa de éxito del scraper nativo.
// Déjala vacía para modo anónimo (funciona con links públicos).
const TERABOX_COOKIE = process.env.TERABOX_COOKIE || ''

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Scraper nativo (no depende de APIs externas) ─────────
/**
 * Extrae jsToken y logid del HTML de la página de Terabox
 * luego llama a la API interna /share/list para obtener el dlink directo.
 * Funciona igual que los bots Python más conocidos.
 */
async function scrapTeraboxDirect(url) {
  // 1) Fetch de la página compartida
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  }
  if (TERABOX_COOKIE) headers['Cookie'] = TERABOX_COOKIE

  const pageRes = await fetch(url, { headers, signal: AbortSignal.timeout(25_000), redirect: 'follow' })
  if (!pageRes.ok) throw new Error(`Página devolvió HTTP ${pageRes.status}`)
  const html = await pageRes.text()

  // 2) Extraer jsToken
  let jsToken = ''
  const jsTokenMatch = html.match(/window\.jsToken\s*=\s*["']([^"']+)["']/)
    || html.match(/"jsToken"\s*:\s*"([^"]+)"/)
    || html.match(/jsToken['"]\s*[:=]\s*['"]([^'"]+)['"]/)
    || html.match(/fn%28%22([^%]+)/)
  if (jsTokenMatch) {
    jsToken = jsTokenMatch[1]
  } else {
    // Último recurso: buscarlo en cookies de respuesta
    const setCookie = pageRes.headers.get('set-cookie') || ''
    const ck = setCookie.match(/(?:^|;\s*)ELIST=([^;]+)/i)
    if (!ck) throw new Error('No se pudo extraer jsToken del HTML')
  }

  // 3) Extraer logid (dp-logid)
  let logid = ''
  const logidMatch = html.match(/dp-logid['"]\s*:\s*['"]([^'"]+)['"]/)
    || html.match(/logid['"]\s*:\s*['"]([^'"]+)['"]/)
  if (logidMatch) logid = logidMatch[1]

  // 4) Extraer shorturl del path
  const shorturlMatch = url.match(/\/s\/([a-zA-Z0-9_-]+)/)
  if (!shorturlMatch) throw new Error('No se pudo extraer shorturl del link')
  const shorturl = shorturlMatch[1]

  // 5) Extraer thumbnail por si acaso
  const thumbMatch = html.match(/"thumbnail"\s*:\s*"([^"]+)"/)
    || html.match(/og:image[^>]+content="([^"]+)"/)
    || html.match(/<meta[^>]+content="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/)
  const thumb = thumbMatch ? thumbMatch[1].replace(/\\u002F/g, '/') : null

  // 6) Llamar a la API interna de Terabox: /api/shorturlinfo
  const infoUrl = `https://www.1024terabox.com/api/shorturlinfo?app_id=250528&shorturl=${shorturl}&root=1`
  const infoHeaders = { ...headers, 'Referer': url }
  const infoRes = await fetch(infoUrl, { headers: infoHeaders, signal: AbortSignal.timeout(15_000) })
  
  let fileList = []
  if (infoRes.ok) {
    const infoData = await infoRes.json()
    if (infoData?.list?.length) fileList = infoData.list
  }

  // 7) Si no hay info todavía, usar /share/list con jsToken
  if (!fileList.length && jsToken) {
    const logidParam = logid ? `&dp-logid=${logid}` : ''
    const shareUrl = `https://www.1024terabox.com/share/list?app_id=250528&web=1&channel=0&jsToken=${jsToken}${logidParam}&page=1&num=20&by=name&order=asc&shorturl=${shorturl}&root=1`
    const shareRes = await fetch(shareUrl, { headers: infoHeaders, signal: AbortSignal.timeout(15_000) })
    if (!shareRes.ok) throw new Error(`/share/list devolvió HTTP ${shareRes.status}`)
    const shareData = await shareRes.json()
    if (shareData?.errno) throw new Error(`Error Terabox errno=${shareData.errno}`)
    fileList = shareData?.list || []
  }

  if (!fileList.length) throw new Error('No se encontraron archivos en el link')

  const file = fileList[0]
  let dlink = file.dlink || file.download_link || ''

  // 8) Si hay dlink, intentar resolver la redirección para obtener la URL final
  if (dlink) {
    try {
      const dlRes = await fetch(dlink, {
        method: 'HEAD',
        headers: { ...headers, 'Referer': 'https://www.terabox.com/' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000)
      })
      if (dlRes.ok || dlRes.status === 206) dlink = dlRes.url || dlink
    } catch (_) { /* usar dlink original */ }
  }

  if (!dlink) throw new Error('El archivo no tiene dlink disponible')

  return {
    link: dlink,
    name: file.server_filename || file.filename || 'archivo',
    size: parseInt(file.size) || 0,
    thumb: file.thumbs?.url3 || file.thumbs?.url1 || thumb
  }
}

// ── APIs externas de fallback ─────────────────────────────
const FALLBACK_APIS = [

  // API A: teraboxapp.xyz/api (mirror público activo)
  async (url) => {
    const res = await fetch('https://teraboxapp.xyz/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Referer': 'https://teraboxapp.xyz/'
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(25_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const link = d?.downloadLink || d?.download_link || d?.url || d?.link
    if (!link) throw new Error('Sin link en respuesta')
    return {
      link,
      name: d.name || d.filename || d.title || 'video.mp4',
      size: parseInt(d.size || d.fileSize || 0) || 0,
      thumb: d.thumbnail || d.thumb || null
    }
  },

  // API B: terabox.fun/api (endpoint alternativo conocido)
  async (url) => {
    const res = await fetch('https://terabox.fun/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': 'https://terabox.fun',
        'Referer': 'https://terabox.fun/'
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(25_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const link = d?.downloadLink || d?.download_link || d?.dlink || d?.url
    if (!link) throw new Error('Sin link en respuesta')
    return {
      link,
      name: d.name || d.filename || 'video.mp4',
      size: parseInt(d.size || 0) || 0,
      thumb: d.thumbnail || null
    }
  },

  // API C: terabox-dl.replit.app (worker de comunidad)
  async (url) => {
    const enc = encodeURIComponent(url)
    const res = await fetch(`https://terabox-dl.replit.app/api/download?url=${enc}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const link = d?.downloadUrl || d?.download_url || d?.url || d?.link
    if (!link) throw new Error('Sin link')
    return {
      link,
      name: d.filename || d.name || 'video.mp4',
      size: parseInt(d.size || d.fileSize || 0) || 0,
      thumb: d.thumbnail || null
    }
  },

  // API D: mirrorbox.cc/api (espejo alternativo)
  async (url) => {
    const res = await fetch('https://mirrorbox.cc/api/getlink', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Origin': 'https://mirrorbox.cc',
        'Referer': 'https://mirrorbox.cc/'
      },
      body: `url=${encodeURIComponent(url)}`,
      signal: AbortSignal.timeout(25_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const link = d?.url || d?.download || d?.link || d?.dlink
    if (!link) throw new Error('Sin link')
    return {
      link,
      name: d.name || d.filename || 'video.mp4',
      size: parseInt(d.size || 0) || 0,
      thumb: d.thumb || d.thumbnail || null
    }
  }
]

// ── Helper: obtener info con scraper nativo + fallbacks ───
async function getTeraboxInfo(url) {
  const errors = []

  // Intento 1: scraper nativo (el más confiable a largo plazo)
  try {
    console.log('[terabox] Intentando scraper nativo...')
    const info = await scrapTeraboxDirect(url)
    console.log(`[terabox] ✅ Scraper nativo OK → ${info.name}`)
    return info
  } catch (e) {
    console.warn(`[terabox] ⚠️ Scraper nativo falló: ${e.message}`)
    errors.push(`Scraper nativo: ${e.message}`)
  }

  // Intentos 2-5: APIs externas de fallback
  for (let i = 0; i < FALLBACK_APIS.length; i++) {
    try {
      console.log(`[terabox] Intentando API externa ${i + 1}...`)
      const info = await FALLBACK_APIS[i](url)
      console.log(`[terabox] ✅ API ${i + 1} OK → ${info.name}`)
      return info
    } catch (e) {
      console.warn(`[terabox] ⚠️ API ${i + 1} falló: ${e.message}`)
      errors.push(`API ${i + 1}: ${e.message}`)
    }
  }

  throw new Error(`Todas las fuentes fallaron:\n${errors.join('\n')}`)
}

// ── Helper: formatear bytes ───────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ── Helper: descargar buffer ──────────────────────────────
async function downloadBuffer(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.terabox.com/'
    },
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) throw new Error(`Error descargando: HTTP ${res.status}`)
  return res.buffer()
}

// ── Detectar dominio Terabox ──────────────────────────────
function isTeraboxUrl(url) {
  return /terabox\.com|1024terabox\.com|terafileshare\.com|4funbox\.co[m]?|teraboxapp\.com|mirrorbox\.com|nephobox\.com|freeterabox\.com|terabox\.fun|terabox\.app/i.test(url)
}

function extractUrl(text) {
  const match = text?.match(/https?:\/\/[^\s]+/)
  return match ? match[0] : null
}

// ── Handler principal ─────────────────────────────────────
const handler = async (m, { conn, text, args }) => {
  const input = text?.trim() || args?.[0] || ''

  let url = extractUrl(input)
  if (!url && m.quoted?.text) url = extractUrl(m.quoted.text)

  if (!url) {
    return m.reply(`❌ *¡Ne ne! Necesito un link de Terabox.*

*Uso:*
• .terabox https://terabox.com/s/...
• Responde a un mensaje con el link y escribe .terabox

*Dominios soportados:*
terabox.com, 1024terabox.com, teraboxapp.com, mirrorbox.com y más.`)
  }

  if (!isTeraboxUrl(url)) {
    return m.reply('❌ ¡Ese link no es de Terabox! Envía un link válido de terabox.com.')
  }

  await m.conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })
  await m.reply('⏳ Obteniendo info del archivo...')

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

  const MAX_SIZE = 200 * 1024 * 1024
  if (info.size && info.size > MAX_SIZE) {
    await m.conn.sendMessage(m.chat, { react: { text: '⚠️', key: m.key } })
    return m.reply(`⚠️ *Archivo demasiado grande para WhatsApp*

📁 *Nombre:* ${info.name}
📦 *Tamaño:* ${sizeText}

🔗 Link directo:
${info.link}`)
  }

  try {
    await m.reply(`📥 Descargando *${info.name}*${sizeText ? ` (${sizeText})` : ''}...`)

    const buffer = await downloadBuffer(info.link)

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
    console.error('[terabox] Error descargando buffer:', e.message)
    await m.conn.sendMessage(m.chat, { react: { text: '⚠️', key: m.key } })
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
      
