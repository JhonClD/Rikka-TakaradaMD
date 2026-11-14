import { execFile } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { fetch as wreqFetch } from 'wreq-js'
import ffmpegStatic from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const FFMPEG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 25000
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 1500 * 1024 * 1024
const FFMPEG_BIN = ffmpegStatic || 'ffmpeg'

// Dominios activos (incluyendo los espejos actuales detectados en tu servidor)
const VOE_MIRRORS = [
  'kathyinformationwhether.com',
  'stevenfamilyedge.com',
  'walterprettytheir.com',
  'voe.sx',
  'markstyleall.com',
  'lukecomparetwo.com',
  'jilliandescribecompany.com'
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

function isFakeVideoUrl(value) {
  return /bigbuckbunny|test[-_]?video|sample[-_]?video|placeholder/i.test(String(value || ''))
}

function addMediaCandidate(candidates, value) {
  const decoded = decodeUrl(value)
  if (!decoded || isFakeVideoUrl(decoded)) return
  try {
    const url = new URL(decoded)
    if (url.protocol !== 'https:') return
    if (/\.(?:mp4|m3u8)(?:[?#]|$)|\/hls(?:[/?#]|$)/i.test(url.href) && !candidates.includes(url.toString())) {
      candidates.push(url.toString())
    }
  } catch (e) {}
}

function extractJsRedirect(pageHtml, currentUrl) {
  const patterns = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'\s>]+)/i
  ]

  for (let i = 0; i < patterns.length; i++) {
    const match = pageHtml.match(patterns[i])
    if (match && match[1]) {
      try {
        const resolved = new URL(decodeUrl(match[1]), currentUrl).toString()
        if (/^https?:\/\//i.test(resolved)) return resolved
      } catch (e) {}
    }
  }
  return null
}

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

function deobfuscateVoePayload(rawStr) {
  try {
    let step1 = rot13(rawStr)
    const junkPatterns = ['@$', '^^', '~@', '%?', '*~', '!!', '#&']
    for (let i = 0; i < junkPatterns.length; i++) {
      step1 = step1.split(junkPatterns[i]).join('')
    }
    step1 = step1.replace(/_/g, '')

    const step2 = Buffer.from(step1, 'base64').toString('utf8')

    let step3 = ''
    for (let i = 0; i < step2.length; i++) {
      step3 += String.fromCharCode(step2.charCodeAt(i) - 3)
    }

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

  // 1. Formato JSON ofuscado <script type="application/json">["..."]</script>
  const jsonScriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/gi
  while ((match = jsonScriptRegex.exec(pageHtml)) !== null) {
    const decodedObj = deobfuscateVoePayload(match[1])
    if (decodedObj) {
      if (decodedObj.source) addMediaCandidate(candidates, decodedObj.source)
      if (decodedObj.file) addMediaCandidate(candidates, decodedObj.file)
      if (decodedObj.hls) addMediaCandidate(candidates, decodedObj.hls)
      if (decodedObj.direct_access_url) addMediaCandidate(candidates, decodedObj.direct_access_url)
      if (Array.isArray(decodedObj.sources)) {
        for (let j = 0; j < decodedObj.sources.length; j++) {
          const s = decodedObj.sources[j]
          if (s && (s.hls || s.file || s.src)) {
            addMediaCandidate(candidates, s.hls || s.file || s.src)
          }
        }
      }
    }
  }

  // 2. Cualquier string largo cifrado con el algoritmo de Voe
  const longStrings = pageHtml.match(/["']([A-Za-z0-9+/=@$^~%*!#&_]{60,})["']/g) || []
  for (let i = 0; i < longStrings.length; i++) {
    const raw = longStrings[i].slice(1, -1)
    const decodedObj = deobfuscateVoePayload(raw)
    if (decodedObj && (decodedObj.source || decodedObj.hls || decodedObj.file)) {
      addMediaCandidate(candidates, decodedObj.source || decodedObj.hls || decodedObj.file)
    }
  }

  // 3. Propiedad 'hls' / 'source' / 'file' en texto plano o Base64
  const hlsRegex = /["'](?:hls|source|file)["']\s*:\s*["']([^"']+)["']/gi
  while ((match = hlsRegex.exec(pageHtml)) !== null) {
    if (match[1]) addMediaCandidate(candidates, match[1])
  }

  // 4. Variables en atob(...)
  const b64Regex = /atob\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/gi
  while ((match = b64Regex.exec(pageHtml)) !== null) {
    if (match[1]) addMediaCandidate(candidates, match[1])
  }

  // 5. Enlaces .m3u8 directos en el HTML
  const rawManifests = pageHtml.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi) || []
  for (let i = 0; i < rawManifests.length; i++) {
    addMediaCandidate(candidates, rawManifests[i])
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      const url = new URL(candidates[i])
      if (url.protocol === 'https:' && /\.m3u8/i.test(url.pathname) && !isFakeVideoUrl(url.href)) {
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

  const directFields = pageHtml.matchAll(/(?:direct_access_url|source|file|src|url|video_url)\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+\.mp4(?:\?[^"']*)?)["']/gi)
  for (const field of directFields) {
    const url = decodeUrl(field[1])
    if (url && !isFakeVideoUrl(url)) return url
  }

  const mp4Match = pageHtml.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.mp4(?:\?[^\s"'<>]*)?/i)
  if (mp4Match && !isFakeVideoUrl(mp4Match[0])) return decodeUrl(mp4Match[0])

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

// Navegador con control manual de redirecciones y cookies para evitar el error "maximum redirect reached"
async function fetchSingleCandidate(startUrl) {
  let currentUrl = startUrl
  const visited = new Set()
  let cookieHeader = ''

  for (let hop = 0; hop < 12; hop++) {
    const reqHeaders = {}
    if (cookieHeader) reqHeaders['Cookie'] = cookieHeader

    const response = await wreqFetch(currentUrl, {
      browser: 'chrome_136',
      os: 'windows',
      headers: Object.keys(reqHeaders).length ? reqHeaders : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })

    // Guardar cookies si el servidor las envía
    const setCookie = response.headers && response.headers.get ? response.headers.get('set-cookie') : null
    if (setCookie) {
      const cookiePair = setCookie.split(';')[0].trim()
      if (cookiePair) {
        cookieHeader = cookieHeader ? (cookieHeader + '; ' + cookiePair) : cookiePair
      }
    }

    // Manejar redirección HTTP (301, 302, 303, 307, 308)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers && response.headers.get ? response.headers.get('location') : null
      if (!location) {
        throw new Error('Redirección HTTP ' + response.status + ' sin cabecera Location')
      }
      const nextUrl = new URL(location, currentUrl).toString()
      if (visited.has(nextUrl)) {
        // Si redirige a una URL ya visitada, hacemos una petición directa con follow
        const finalRes = await wreqFetch(nextUrl, {
          browser: 'chrome_136',
          os: 'windows',
          redirect: 'follow',
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
        })
        if (!finalRes.ok) throw new Error('HTTP ' + finalRes.status + ' en ' + new URL(nextUrl).hostname)
        const finalHtml = await finalRes.text()
        return { html: finalHtml, finalUrl: finalRes.url || nextUrl, cookieHeader }
      }
      visited.add(nextUrl)
      currentUrl = nextUrl
      continue
    }

    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' en ' + new URL(currentUrl).hostname)
    }

    const html = await response.text()
    if (html.length > MAX_PAGE_CHARS) {
      throw new Error('La página de Voe es demasiado grande.')
    }

    // Comprobar si primero ya tiene el stream antes de seguir redirecciones JS
    if (extractVoeManifest(html) || extractVoeDirectMp4(html)) {
      return { html: html, finalUrl: currentUrl, cookieHeader }
    }

    // Manejar redirección en JavaScript (window.location.href = '...')
    const jsRedirect = extractJsRedirect(html, currentUrl)
    if (jsRedirect && jsRedirect !== currentUrl && !visited.has(jsRedirect)) {
      visited.add(jsRedirect)
      currentUrl = jsRedirect
      continue
    }

    return { html: html, finalUrl: currentUrl, cookieHeader }
  }

  throw new Error('Demasiados saltos de redirección en ' + new URL(currentUrl).hostname)
}

async function fetchVoePageWithFallback(voe) {
  const errors = []
  const mirrors = VOE_MIRRORS.concat([voe.originalHost]).filter(function (v, idx, arr) {
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
          streamUrl: manifestUrl || directMp4,
          cookieHeader: data.cookieHeader || '',
          referer: voe.pageUrl
        }
      }

      const titlePreview = extractVoeTitle(data.html, voe.id)
      errors.push(new URL(data.finalUrl).hostname + ': sin stream (título: ' + titlePreview.slice(0, 25) + ')')
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

    const headers = [
      'Referer: ' + (pageData.referer || voe.pageUrl),
      pageData.cookieHeader ? 'Cookie: ' + pageData.cookieHeader : ''
    ].filter(Boolean).join('\r\n') + '\r\n'

    await execFileAsync(FFMPEG_BIN, [
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
                                
