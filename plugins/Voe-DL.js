import { execFile } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { fetch as wreqFetch } from 'wreq-js'

const execFileAsync = promisify(execFile)
const FFMPEG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 25000
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 1500 * 1024 * 1024

// Dominios activos de Voe (eliminados los espejos caídos que daban unexpected EOF)
const VOE_MIRRORS = [
  'voe.sx',
  'walterprettytheir.com',
  'shannonpersonalcost.com',
  'markstyleall.com',
  'lukecomparetwo.com',
  'jilliandescribecompany.com',
  'alejandrocenturyoil.com',
  'richardsignfish.com'
]

export function parseVoeUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch (e) {
    throw new Error('El enlace no es una URL válida.')
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Solo se aceptan enlaces HTTPS válidos de Voe.')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  let id = null
  if (parts.length >= 2 && /^(e|v|d)$/i.test(parts[0])) {
    id = parts[1]
  } else if (parts.length === 1) {
    id = parts[0]
  }

  if (!id || !/^[a-z0-9_-]{6,64}$/i.test(id)) {
    throw new Error('No pude reconocer el identificador del video de Voe.')
  }

  return { id: id, originalHost: url.hostname, pageUrl: 'https://voe.sx/e/' + id }
}

function decodeUrl(value) {
  const cleaned = String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .trim()

  if (!/^https?:\/\//i.test(cleaned) && /^[A-Za-z0-9+/=]{16,}$/.test(cleaned)) {
    try {
      const decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim()
      if (/^https?:\/\//i.test(decoded)) return decoded
    } catch (e) {}
  }

  return cleaned
}

function extractJsRedirect(pageHtml) {
  const patterns = [
    /window\.location\.href\s*=\s*["'](https:\/\/[^"']+)["']/i,
    /window\.location\s*=\s*["'](https:\/\/[^"']+)["']/i,
    /location\.replace\(\s*["'](https:\/\/[^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=(https:\/\/[^"'\s>]+)/i
  ]

  for (let i = 0; i < patterns.length; i++) {
    const match = pageHtml.match(patterns[i])
    if (match && match[1]) return decodeUrl(match[1])
  }
  return null
}

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

// Nuevo desofuscador oficial para el cifrado de Voe (2025-2026)
function deobfuscateVoePayload(rawStr) {
  try {
    // Paso 1: ROT13
    let step1 = rot13(rawStr)
    // Paso 2: Eliminar tokens basura que Voe inyecta
    const junkPatterns = ['@$', '^^', '~@', '%?', '*~', '!!', '#&']
    for (let i = 0; i < junkPatterns.length; i++) {
      step1 = step1.split(junkPatterns[i]).join('')
    }
    step1 = step1.replace(/_/g, '')

    // Paso 3: Base64 decode #1
    const step2 = Buffer.from(step1, 'base64').toString('utf8')

    // Paso 4: Shift de caracteres (-3 en código ASCII)
    let step3 = ''
    for (let i = 0; i < step2.length; i++) {
      step3 += String.fromCharCode(step2.charCodeAt(i) - 3)
    }

    // Paso 5: Invertir cadena y Base64 decode #2
    const reversed = step3.split('').reverse().join('')
    const finalJson = Buffer.from(reversed, 'base64').toString('utf8')
    return JSON.parse(finalJson)
  } catch (e) {
    return null
  }
}

export function extractVoeManifest(pageHtml) {
  const candidates = []
  let match

  // 1. Nuevo formato Voe: <script type="application/json">["..."]</script>
  const jsonScriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/gi
  while ((match = jsonScriptRegex.exec(pageHtml)) !== null) {
    const decodedObj = deobfuscateVoePayload(match[1])
    if (decodedObj) {
      if (decodedObj.source) candidates.push(decodeUrl(decodedObj.source))
      if (decodedObj.file) candidates.push(decodeUrl(decodedObj.file))
      if (decodedObj.hls) candidates.push(decodeUrl(decodedObj.hls))
      if (Array.isArray(decodedObj.sources)) {
        for (let j = 0; j < decodedObj.sources.length; j++) {
          const s = decodedObj.sources[j]
          if (s && (s.hls || s.file || s.src)) {
            candidates.push(decodeUrl(s.hls || s.file || s.src))
          }
        }
      }
    }
  }

  // 2. Probar cualquier string largo potencialmente cifrado con el algoritmo de Voe
  const longStrings = pageHtml.match(/["']([A-Za-z0-9+/=@$^~%*!#&_]{80,})["']/g) || []
  for (let i = 0; i < longStrings.length; i++) {
    const raw = longStrings[i].slice(1, -1)
    const decodedObj = deobfuscateVoePayload(raw)
    if (decodedObj && (decodedObj.source || decodedObj.hls || decodedObj.file)) {
      candidates.push(decodeUrl(decodedObj.source || decodedObj.hls || decodedObj.file))
    }
  }

  // 3. Propiedad 'hls' o 'source' en texto plano o Base64
  const hlsRegex = /["'](?:hls|source|file)["']\s*:\s*["']([^"']+)["']/gi
  while ((match = hlsRegex.exec(pageHtml)) !== null) {
    if (match[1]) candidates.push(decodeUrl(match[1]))
  }

  // 4. Variables en atob(...)
  const b64Regex = /atob\(\s*["']([A-Za-z0-9+/=]{24,})["']\s*\)/gi
  while ((match = b64Regex.exec(pageHtml)) !== null) {
    if (match[1]) candidates.push(decodeUrl(match[1]))
  }

  // 5. Enlaces .m3u8 directos en el HTML
  const rawManifests = pageHtml.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi) || []
  for (let i = 0; i < rawManifests.length; i++) {
    candidates.push(decodeUrl(rawManifests[i]))
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      const url = new URL(candidates[i])
      if (url.protocol === 'https:' && /\.m3u8/i.test(url.pathname)) {
        return url.toString()
      }
    } catch (e) {}
  }
  return null
}

function extractVoeDirectMp4(pageHtml) {
  let match
  const jsonScriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/gi
  while ((match = jsonScriptRegex.exec(pageHtml)) !== null) {
    const decodedObj = deobfuscateVoePayload(match[1])
    if (decodedObj && Array.isArray(decodedObj.direct_access_url)) {
      return decodeUrl(decodedObj.direct_access_url[0])
    }
    if (decodedObj && typeof decodedObj.direct_access_url === 'string') {
      return decodeUrl(decodedObj.direct_access_url)
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

async function fetchHtmlOnce(targetUrl) {
  // Intentar primero con wreq-js usando perfil Chrome 136 estable
  try {
    const response = await wreqFetch(targetUrl, {
      browser: 'chrome_136',
      os: 'windows',
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })

    if (response.ok) {
      const html = await response.text()
      return { html: html, finalUrl: response.url || targetUrl }
    }
  } catch (e) {
    // Si wreq-js falla o da EOF, probamos con fetch nativo
  }

  const fallbackRes = await fetch(targetUrl, {
    headers: {
      'User-Agent': FFMPEG_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
  })

  if (!fallbackRes.ok) {
    throw new Error('HTTP ' + fallbackRes.status + ' en ' + new URL(targetUrl).hostname)
  }

  const html = await fallbackRes.text()
  return { html: html, finalUrl: fallbackRes.url || targetUrl }
}

async function fetchSingleCandidate(startUrl) {
  let currentUrl = startUrl

  for (let hop = 0; hop < 5; hop++) {
    const data = await fetchHtmlOnce(currentUrl)
    if (data.html.length > MAX_PAGE_CHARS) {
      throw new Error('La página de Voe es demasiado grande.')
    }

    const jsRedirect = extractJsRedirect(data.html)
    if (jsRedirect && jsRedirect !== currentUrl) {
      currentUrl = jsRedirect
      continue
    }

    return data
  }

  throw new Error('Demasiadas redirecciones en Voe.')
}

async function fetchVoePageWithFallback(voe) {
  const errors = []
  const mirrors = [voe.originalHost].concat(VOE_MIRRORS).filter(function (v, idx, arr) {
    return v && arr.indexOf(v) === idx
  })

  for (let i = 0; i < mirrors.length; i++) {
    const mirrorUrl = 'https://' + mirrors[i] + '/e/' + voe.id
    try {
      const data = await fetchSingleCandidate(mirrorUrl)
      const manifestUrl = extractVoeManifest(data.html)
      const directMp4 = extractVoeDirectMp4(data.html)

      if (manifestUrl || directMp4) {
        return {
          html: data.html,
          finalUrl: data.finalUrl,
          streamUrl: manifestUrl || directMp4
        }
      }
      errors.push(mirrors[i] + ': cargó HTML (' + data.html.length + ' chars) pero sin stream reconocible')
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err)
      errors.push(mirrors[i] + ': ' + msg)
    }
  }

  throw new Error('No se pudo extraer el video. Detalles: ' + errors.slice(0, 3).join(' | '))
}

const handler = async (m, { conn, args, text, usedPrefix, command }) => {
  const inputUrl = getVoeUrl(m, text, args)
  if (!inputUrl) {
    const prefix = usedPrefix || '.'
    const cmd = command || 'voe'
    return m.reply('⚠️ Envía o responde a un enlace de Voe.\nEjemplo: *' + prefix + cmd + ' https://voe.sx/e/ptbsbbw040gc*')
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

    const pageData = await fetchVoePageWithFallback(voe)
    const streamUrl = pageData.streamUrl
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
      '-i', streamUrl,
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
      
