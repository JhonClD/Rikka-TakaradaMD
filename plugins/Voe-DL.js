import { execFile } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { fetch as wreqFetch } from 'wreq-js'

const execFileAsync = promisify(execFile)
const FFMPEG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 25000
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 1500 * 1024 * 1024

const KNOWN_VOE_HOSTS = [
  'voe.sx',
  'voe-network.net',
  'walterprettytheir.com',
  'markstyleall.com',
  'shannonpersonalcost.com',
  'lukecomparetwo.com',
  'jilliandescribecompany.com',
  'christopheruntilpoint.com'
]

function isSupportedVoeInputHost(hostname) {
  const host = hostname.toLowerCase()
  for (let i = 0; i < KNOWN_VOE_HOSTS.length; i++) {
    const domain = KNOWN_VOE_HOSTS[i]
    if (host === domain || host.endsWith('.' + domain)) return true
  }
  return false
}

export function parseVoeUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch (e) {
    throw new Error('El enlace no es una URL válida.')
  }

  if (url.protocol !== 'https:' || !isSupportedVoeInputHost(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Solo se aceptan enlaces HTTPS válidos de Voe (ej: voe.sx).')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  let id = null
  if (parts.length === 2 && /^(e|v|d)$/i.test(parts[0])) {
    id = parts[1]
  } else if (parts.length === 1) {
    id = parts[0]
  }

  if (!id || !/^[a-z0-9_-]{6,64}$/i.test(id)) {
    throw new Error('No pude reconocer el identificador del video de Voe.')
  }

  return { id: id, pageUrl: 'https://voe.sx/e/' + id }
}

function decodeUrl(value) {
  const cleaned = String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .trim()

  // Si no empieza con http, probar decodificar desde Base64 (Voe codifica 'hls' en Base64 frecuentemente)
  if (!/^https?:\/\//i.test(cleaned) && /^[A-Za-z0-9+/=]{16,}$/.test(cleaned)) {
    try {
      const decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim()
      if (/^https?:\/\//i.test(decoded)) {
        return decoded
      }
    } catch (e) {
      // Continuar con el valor original si falla
    }
  }

  return cleaned
}

function extractJsRedirect(pageHtml) {
  const patterns = [
    /window\.location\.href\s*=\s*["'](https:\/\/[^"']+)["']/i,
    /location\.replace\(\s*["'](https:\/\/[^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=(https:\/\/[^"'\s>]+)/i
  ]

  for (let i = 0; i < patterns.length; i++) {
    const match = pageHtml.match(patterns[i])
    if (match && match[1]) return decodeUrl(match[1])
  }
  return null
}

export function extractVoeManifest(pageHtml) {
  const candidates = []

  // 1. Buscar propiedad 'hls' (texto plano o Base64)
  const hlsRegex = /["']hls["']\s*:\s*["']([^"']+)["']/gi
  let match
  while ((match = hlsRegex.exec(pageHtml)) !== null) {
    if (match[1]) candidates.push(decodeUrl(match[1]))
  }

  // 2. Buscar funcion prompt("Node", "...") o variables base64 largas
  const b64Regex = /atob\(\s*["']([A-Za-z0-9+/=]{24,})["']\s*\)/gi
  while ((match = b64Regex.exec(pageHtml)) !== null) {
    if (match[1]) candidates.push(decodeUrl(match[1]))
  }

  // 3. Buscar URLs .m3u8 directas en el HTML
  const rawManifests = pageHtml.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi) || []
  for (let i = 0; i < rawManifests.length; i++) {
    candidates.push(decodeUrl(rawManifests[i]))
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      const url = new URL(candidates[i])
      if (url.protocol === 'https:' && /\.m3u8$/i.test(url.pathname)) {
        return url.toString()
      }
    } catch (e) {
      // Ignorar candidatos inválidos
    }
  }
  return null
}

function extractVoeTitle(pageHtml, fallbackId) {
  const ogMatch = pageHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  const titleMatch = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/i)
  let rawTitle = (ogMatch && ogMatch[1]) || (titleMatch && titleMatch[1]) || ('voe_' + fallbackId)

  rawTitle = rawTitle
    .replace(/^Watch\s+/i, '')
    .replace(/\s*-\s*VOE.*$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()

  if (!rawTitle) return 'voe_' + fallbackId
  return rawTitle.slice(0, 80)
}

function getVoeUrl(m, text, args) {
  const quotedText = (m.quoted && (m.quoted.text || m.quoted.caption)) ? (m.quoted.text || m.quoted.caption) : ''
  const firstArg = (args && args[0]) ? args[0] : ''
  const input = String(text || firstArg || quotedText || '')
  const match = input.match(/https?:\/\/[^\s<>]+/i)
  const candidate = (match ? match[0] : '') || String(firstArg || '')
  return candidate.replace(/[),.!?;:'"\]}>]+$/g, '')
}

async function fetchVoePage(initialUrl) {
  let currentUrl = initialUrl

  // Sigue hasta 3 redirecciones basadas en JS (muy común en Voe)
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await wreqFetch(currentUrl, {
      browser: 'chrome_149',
      os: 'windows',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': 'https://voe.sx/'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })

    if (!response.ok) {
      throw new Error('Voe respondió HTTP ' + response.status + '.')
    }

    const html = await response.text()
    if (html.length > MAX_PAGE_CHARS) {
      throw new Error('La página de Voe es demasiado grande para procesarla.')
    }

    const jsRedirect = extractJsRedirect(html)
    if (jsRedirect && jsRedirect !== currentUrl) {
      currentUrl = jsRedirect
      continue
    }

    return { html: html, finalUrl: response.url || currentUrl }
  }

  throw new Error('Demasiadas redirecciones al intentar abrir el enlace de Voe.')
}

const handler = async (m, { conn, args, text, usedPrefix, command }) => {
  const inputUrl = getVoeUrl(m, text, args)
  if (!inputUrl) {
    const prefix = usedPrefix || '.'
    const cmd = command || 'voe'
    return m.reply('⚠️ Envía o responde a un enlace de Voe.\nEjemplo: *' + prefix + cmd + ' https://voe.sx/e/abc123xyz789*')
  }

  let voe
  try {
    voe = parseVoeUrl(inputUrl)
  } catch (error) {
    return m.reply('❌ ' + error.message)
  }

  if (!global.voeActiveDownloads) {
    global.voeActiveDownloads = new Set()
  }

  const downloadKey = m.chat + ':' + m.sender
  if (global.voeActiveDownloads.has(downloadKey)) {
    return m.reply('⏳ Ya tienes una descarga de Voe en curso en este chat. Espera a que termine.')
  }
  global.voeActiveDownloads.add(downloadKey)

  let tempDir
  try {
    if (m.react) await m.react('⏳').catch(function () {})
    await m.reply('🔎 Obteniendo y procesando el video de Voe...')

    const pageData = await fetchVoePage(voe.pageUrl)
    const manifestUrl = extractVoeManifest(pageData.html)

    if (!manifestUrl) {
      throw new Error('No encontré el stream HLS. El video puede haber sido eliminado o requiere captcha.')
    }

    const videoTitle = extractVoeTitle(pageData.html, voe.id)
    const cleanFileName = videoTitle.endsWith('.mp4') ? videoTitle : (videoTitle + '.mp4')

    tempDir = await mkdtemp(join(tmpdir(), 'rikka-voe-'))
    const outputPath = join(tempDir, 'voe_' + voe.id + '.mp4')

    const finalOrigin = new URL(pageData.finalUrl).origin
    const headers = 'Referer: ' + pageData.finalUrl + '\r\nOrigin: ' + finalOrigin + '\r\n'

    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
      '-user_agent', FFMPEG_USER_AGENT,
      '-headers', headers,
      '-rw_timeout', '20000000',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', manifestUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ], {
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024
    })

    const file = await stat(outputPath)
    if (!file.size) throw new Error('FFmpeg no generó un archivo de video válido.')
    if (file.size > MAX_VIDEO_SIZE) {
      throw new Error('El video supera el límite máximo permitido de 1.5 GB.')
    }

    const sizeMB = (file.size / (1024 * 1024)).toFixed(1)

    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName: cleanFileName,
      mimetype: 'video/mp4',
      caption: '✅ *' + videoTitle + '*\n📦 Tamaño: ' + sizeMB + ' MB'
    }, { quoted: m })

    if (m.react) await m.react('✅').catch(function () {})
  } catch (error) {
    const errMsg = (error && error.message) ? error.message : String(error)
    console.error('[Voe-DL]', errMsg)
    if (m.react) await m.react('❌').catch(function () {})
    await m.reply('❌ ' + (errMsg || 'No se pudo descargar el video de Voe.'))
  } finally {
    global.voeActiveDownloads.delete(downloadKey)
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(function () {})
    }
  }
}

handler.help = ['voe <enlace>']
handler.tags = ['downloader']
handler.command = /^(voe|voedl|voedownload)$/i

export default handler
                          
