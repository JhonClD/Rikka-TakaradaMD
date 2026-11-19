import { createWriteStream } from 'fs'
import { mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { isIP } from 'net'
import { Readable, Transform } from 'stream'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { fetch as wreqFetch } from 'wreq-js'
import { fetch as nodeFetch } from 'undici'
import ffmpegStatic from 'ffmpeg-static'

const FFMPEG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 25000
const DIRECT_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
const RANGE_REQUEST_TIMEOUT_MS = 45 * 1000
const RANGE_CONNECTIONS = 4
const RANGE_CHUNK_SIZE = 8 * 1024 * 1024
const RANGE_RETRIES = 3
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 1500 * 1024 * 1024
const FFMPEG_BIN = ffmpegStatic || 'ffmpeg'
const VOE_MIRROR_CACHE_PATH = join(tmpdir(), 'rikka-voe-mirrors.json')
const VOE_MIRROR_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_LEARNED_VOE_MIRRORS = 20

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = -1
  do { value /= 1024; unit++ } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function logVoe(message) {
  console.log(`[Voe-DL ${new Date().toISOString()}] ${message}`)
}

// Dominios activos (incluyendo los espejos actuales detectados en tu servidor)
const VOE_MIRRORS = [
  'susanexpectcare.com',
  'kathyinformationwhether.com',
  'stevenfamilyedge.com',
  'walterprettytheir.com',
  'voe.sx',
  'markstyleall.com',
  'lukecomparetwo.com',
  'jilliandescribecompany.com'
]
const KNOWN_VOE_MIRRORS = new Set(['voe.sx', ...VOE_MIRRORS])
let learnedVoeMirrors = null
let mirrorCacheWriteQueue = Promise.resolve()

function normalizeVoeMirrorHost(value) {
  try {
    const raw = String(value || '')
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return ''
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return ''
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) return ''
    return host
  } catch (_) {
    return ''
  }
}

export function isKnownVoeMirrorUrl(value) {
  const host = normalizeVoeMirrorHost(value)
  if (!host) return false
  const candidates = host.startsWith('www.') ? [host, host.slice(4)] : [host]
  return candidates.some(candidate => KNOWN_VOE_MIRRORS.has(candidate)
    || learnedVoeMirrors?.some(entry => entry.host === candidate && entry.expiresAt > Date.now()))
}

function safeVoeRedirectUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    if (!normalizeVoeMirrorHost(url.hostname)) return null
    return url
  } catch (_) {
    return null
  }
}

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason)
  }
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error(`La solicitud superó ${Math.round(timeoutMs / 60000)} min`))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }
}

async function loadLearnedVoeMirrorEntries() {
  const now = Date.now()
  if (learnedVoeMirrors) {
    learnedVoeMirrors = learnedVoeMirrors.filter(entry => entry.expiresAt > now)
    return learnedVoeMirrors
  }
  let entries = []
  try {
    const cached = JSON.parse(await readFile(VOE_MIRROR_CACHE_PATH, 'utf8'))
    entries = (Array.isArray(cached.mirrors) ? cached.mirrors : [])
      .map(entry => ({ host: normalizeVoeMirrorHost(entry?.host), expiresAt: Number(entry?.expiresAt) }))
      .filter(entry => entry.host && entry.expiresAt > now && !KNOWN_VOE_MIRRORS.has(entry.host))
  } catch (_) {}
  learnedVoeMirrors = entries
  return entries
}

async function loadLearnedVoeMirrors() {
  return (await loadLearnedVoeMirrorEntries()).map(entry => entry.host)
}

function rememberVoeMirror(value) {
  const host = normalizeVoeMirrorHost(value)
  if (!host || KNOWN_VOE_MIRRORS.has(host)) return Promise.resolve()
  mirrorCacheWriteQueue = mirrorCacheWriteQueue.then(async () => {
    const current = await loadLearnedVoeMirrorEntries()
    const entries = [
      { host, expiresAt: Date.now() + VOE_MIRROR_CACHE_TTL_MS },
      ...current.filter(existing => existing.host !== host)
    ].slice(0, MAX_LEARNED_VOE_MIRRORS)
    learnedVoeMirrors = entries
    const tempPath = `${VOE_MIRROR_CACHE_PATH}.${process.pid}.tmp`
    try {
      await writeFile(tempPath, JSON.stringify({ mirrors: entries }), { mode: 0o600 })
      await rename(tempPath, VOE_MIRROR_CACHE_PATH)
      logVoe(`Mirror aprendido temporalmente: ${host} (TTL 6 h)`)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      logVoe(`No se pudo guardar el mirror ${host}: ${error.message}`)
    }
  }).catch(error => {
    logVoe(`Error al actualizar el caché de mirrors: ${error.message}`)
  })
  return mirrorCacheWriteQueue
}

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
  const safeStartUrl = safeVoeRedirectUrl(startUrl)
  if (!safeStartUrl) throw new Error('La URL inicial del mirror no es HTTPS segura.')
  let currentUrl = safeStartUrl.toString()
  const visited = new Set([currentUrl])
  let cookieHeader = ''
  let cookieHost = safeStartUrl.hostname

  for (let hop = 0; hop < 12; hop++) {
    const currentHost = new URL(currentUrl).hostname
    const reqHeaders = {}
    if (cookieHeader && cookieHost === currentHost) reqHeaders['Cookie'] = cookieHeader
    reqHeaders['Referer'] = hop === 0 ? 'https://tioanime.com/' : startUrl
    reqHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    reqHeaders['User-Agent'] = FFMPEG_USER_AGENT

    let response
    for (let retry = 0; retry < 3; retry++) {
      try {
        response = await wreqFetch(currentUrl, {
          browser: 'chrome_136',
          os: 'windows',
          headers: reqHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
        })
      } catch (primaryError) {
        // Algunos mirrors cierran la conexión de wreq-js con EOF. Reintentar
        // con undici mantiene el control manual de redirects y suele superar
        // ese fallo transitorio sin descartar inmediatamente el mirror.
        try {
          response = await nodeFetch(currentUrl, {
            headers: reqHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
          })
        } catch (fallbackError) {
          if (retry === 2) throw fallbackError
          await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)))
          continue
        }
      }

      // Si wreq-js recibió un 403/5xx, dar una oportunidad al cliente
      // explícito antes de abandonar el mirror.
      if ([403, 429, 500, 502, 503, 504].includes(response.status)) {
        try {
          const fallbackResponse = await nodeFetch(currentUrl, {
            headers: reqHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
          })
          if (fallbackResponse.ok || fallbackResponse.status < response.status) {
            response = fallbackResponse
          }
        } catch (_) {}
      }
      if (![403, 429, 500, 502, 503, 504].includes(response.status) || retry === 2) break
      await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)))
    }

    // Guardar cookies si el servidor las envía
    if (cookieHost !== currentHost) {
      cookieHeader = ''
      cookieHost = currentHost
    }
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
      const safeNextUrl = safeVoeRedirectUrl(location, currentUrl)
      if (!safeNextUrl) throw new Error('Redirección HTTP bloqueada: destino no HTTPS o host no válido.')
      const nextUrl = safeNextUrl.toString()
      if (visited.has(nextUrl)) {
        throw new Error('Bucle de redirección detectado en ' + safeNextUrl.hostname)
      }
      if (safeNextUrl.hostname !== currentHost) {
        cookieHeader = ''
        cookieHost = safeNextUrl.hostname
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
    if (jsRedirect && jsRedirect !== currentUrl) {
      const safeJsRedirect = safeVoeRedirectUrl(jsRedirect, currentUrl)
      if (!safeJsRedirect) throw new Error('Redirección JavaScript bloqueada: destino no HTTPS o host no válido.')
      const nextUrl = safeJsRedirect.toString()
      if (visited.has(nextUrl)) throw new Error('Bucle de redirección JavaScript detectado en ' + safeJsRedirect.hostname)
      if (safeJsRedirect.hostname !== currentHost) {
        cookieHeader = ''
        cookieHost = safeJsRedirect.hostname
      }
      visited.add(nextUrl)
      currentUrl = nextUrl
      continue
    }

    return { html: html, finalUrl: currentUrl, cookieHeader }
  }

  throw new Error('Demasiados saltos de redirección en ' + new URL(currentUrl).hostname)
}

async function fetchVoePageWithFallback(voe, triedMirrors = new Set()) {
  const errors = []
  const learnedMirrors = await loadLearnedVoeMirrors()
  const knownHosts = new Set([...learnedMirrors, ...KNOWN_VOE_MIRRORS]
    .map(normalizeVoeMirrorHost).filter(Boolean))
  const originalHost = normalizeVoeMirrorHost(voe.originalHost)
  if (originalHost && !knownHosts.has(originalHost)) {
    errors.push(`${originalHost}: host inicial desconocido; se omitió por seguridad`)
  }
  const mirrors = [...new Set([
    ...(originalHost && knownHosts.has(originalHost) ? [originalHost] : []),
    ...learnedMirrors,
    'voe.sx',
    ...VOE_MIRRORS
  ].map(normalizeVoeMirrorHost).filter(Boolean))]

  for (let i = 0; i < mirrors.length; i++) {
    const mirror = mirrors[i]
    if (triedMirrors.has(mirror)) continue
    const mirrorUrl = 'https://' + mirror + '/e/' + voe.id
    try {
      const data = await fetchSingleCandidate(mirrorUrl)
      const finalUrl = safeVoeRedirectUrl(data.finalUrl, mirrorUrl)
      if (!finalUrl) throw new Error('La URL final del mirror no es HTTPS segura.')
      const finalHost = normalizeVoeMirrorHost(finalUrl.hostname)
      if (finalHost && finalHost !== mirror && triedMirrors.has(finalHost)) {
        errors.push(`${mirror}: redirige al mirror ya probado ${finalHost}`)
        continue
      }
      const manifestUrl = extractVoeManifest(data.html)
      const rawDirectMp4 = extractVoeDirectMp4(data.html)
      const safeDirectMp4 = rawDirectMp4 && safeVoeRedirectUrl(rawDirectMp4, finalUrl.toString())
      if (rawDirectMp4 && !safeDirectMp4) {
        errors.push(`${mirror}: URL MP4 rechazada por no ser HTTPS segura`)
        continue
      }
      const directMp4 = safeDirectMp4 ? safeDirectMp4.toString() : null

      if (manifestUrl || directMp4) {
        await rememberVoeMirror(mirror)
        await rememberVoeMirror(finalHost)
        return {
          html: data.html,
          finalUrl: finalUrl.toString(),
          sourceMirror: mirror,
          mirrorHost: finalHost,
          // El MP4 firmado evita los fallos intermitentes de segmentos HLS en algunas CDN.
          // HLS queda como fallback cuando Voe no ofrece direct_access_url.
          streamUrl: directMp4 || manifestUrl,
          streamType: directMp4 ? 'mp4' : 'hls',
          cookieHeader: data.cookieHeader || '',
          referer: finalUrl.toString() || voe.pageUrl
        }
      }

      const titlePreview = extractVoeTitle(data.html, voe.id)
      errors.push(new URL(data.finalUrl).hostname + ': sin stream (título: ' + titlePreview.slice(0, 25) + ')')
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err)
      errors.push(mirrors[i] + ': ' + msg)
    }
  }

  throw new Error('No se pudo extraer el video. Detalles: ' + errors.slice(0, 8).join(' | '))
}

function getDownloadHeaders(pageData) {
  const headers = {
    'User-Agent': FFMPEG_USER_AGENT,
    Referer: pageData.referer,
    Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8'
  }
  if (pageData.cookieHeader) headers.Cookie = pageData.cookieHeader
  return headers
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i)
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null
}

async function downloadDirectMp4Sequential(streamUrl, pageData, outputPath, response, total) {
  if (!response.body) throw new Error('La respuesta MP4 no contiene un stream')
  const responseStream = typeof response.body.getReader === 'function'
    ? Readable.fromWeb(response.body)
    : response.body
  let downloaded = 0
  let lastLog = Date.now()
  let lastBytes = 0
  const startedAt = Date.now()
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length
      if (downloaded > MAX_VIDEO_SIZE) {
        const error = new Error('El video supera el límite máximo permitido de 1.5 GB.')
        error.nonRetryable = true
        callback(error)
        return
      }
      const now = Date.now()
      if (now - lastLog >= 1000) {
        const elapsed = (now - startedAt) / 1000
        const speed = (downloaded - lastBytes) / Math.max((now - lastLog) / 1000, 0.001)
        const percent = total ? ` ${((downloaded / total) * 100).toFixed(1)}%` : ''
        const eta = total && speed > 0 ? ` ETA ${formatDuration((total - downloaded) / speed)}` : ''
        logVoe(`Descarga MP4: ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}${percent} · ${formatBytes(speed)}/s · ${formatDuration(elapsed)}${eta}`)
        lastLog = now
        lastBytes = downloaded
      }
      callback(null, chunk)
    }
  })
  await pipeline(responseStream, progress, createWriteStream(outputPath))
  logVoe(`MP4 terminado: ${formatBytes(downloaded)} en ${formatDuration((Date.now() - startedAt) / 1000)}`)
}

async function downloadDirectMp4Parallel(streamUrl, pageData, outputPath, total, headers, attemptSignal) {
  const file = await open(outputPath, 'w')
  const parts = Math.ceil(total / RANGE_CHUNK_SIZE)
  const abortController = new AbortController()
  const abortFromAttempt = () => {
    if (!abortController.signal.aborted) abortController.abort(attemptSignal.reason)
  }
  if (attemptSignal?.aborted) abortFromAttempt()
  else attemptSignal?.addEventListener('abort', abortFromAttempt, { once: true })
  let nextPart = 0
  let completed = 0
  let downloaded = 0
  let lastLog = Date.now()
  let lastBytes = 0
  const startedAt = Date.now()
  let report
  try {
    await file.truncate(total)
    report = setInterval(() => {
      const now = Date.now()
      const speed = (downloaded - lastBytes) / Math.max((now - lastLog) / 1000, 0.001)
      const elapsed = (now - startedAt) / 1000
      const eta = speed > 0 ? ` ETA ${formatDuration((total - downloaded) / speed)}` : ''
      logVoe(`Descarga MP4 paralela: ${completed}/${parts} bloques · ${formatBytes(downloaded)} / ${formatBytes(total)} ${(downloaded / total * 100).toFixed(1)}% · ${formatBytes(speed)}/s · ${formatDuration(elapsed)}${eta}`)
      lastLog = now
      lastBytes = downloaded
    }, 1000)

    const downloadPart = async part => {
      const start = part * RANGE_CHUNK_SIZE
      const end = Math.min(total - 1, start + RANGE_CHUNK_SIZE - 1)
      let lastError
      for (let retry = 1; retry <= RANGE_RETRIES; retry++) {
        const requestTimeout = createTimeoutSignal(abortController.signal, RANGE_REQUEST_TIMEOUT_MS)
        try {
          const response = await nodeFetch(streamUrl, {
            headers: { ...headers, Range: `bytes=${start}-${end}` },
            redirect: 'follow',
            signal: requestTimeout.signal
          })
          const range = parseContentRange(response.headers.get('content-range'))
          const contentType = String(response.headers.get('content-type') || '').toLowerCase()
          if (response.status !== 206 || !range || range.start !== start || range.end !== end || range.total !== total || contentType.includes('text/html') || contentType.includes('application/json')) {
            await response.body?.cancel().catch(() => {})
            throw new Error(`respuesta Range inválida (HTTP ${response.status})`)
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          if (buffer.length !== end - start + 1) throw new Error(`bloque incompleto (${buffer.length} bytes)`)
          let written = 0
          while (written < buffer.length) {
            const result = await file.write(buffer, written, buffer.length - written, start + written)
            if (!result.bytesWritten) throw new Error('No se pudo escribir el bloque completo en disco')
            written += result.bytesWritten
          }
          downloaded += buffer.length
          completed++
          return
        } catch (error) {
          lastError = error
          if (abortController.signal.aborted) throw abortController.signal.reason || error
          if (retry < RANGE_RETRIES) await new Promise(resolve => setTimeout(resolve, retry * 1000))
        } finally {
          requestTimeout.cleanup()
        }
      }
      throw new Error(`bloque ${part + 1}/${parts}: ${lastError?.message || 'fallo desconocido'}`)
    }

    const workers = Array.from({ length: Math.min(RANGE_CONNECTIONS, parts) }, async () => {
      try {
        while (true) {
          const part = nextPart++
          if (part >= parts) return
          await downloadPart(part)
        }
      } catch (error) {
        if (!abortController.signal.aborted) abortController.abort(error)
        throw error
      }
    })
    const results = await Promise.allSettled(workers)
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  } finally {
    if (report) clearInterval(report)
    attemptSignal?.removeEventListener('abort', abortFromAttempt)
    await file.close()
  }
  logVoe(`MP4 paralelo terminado: ${formatBytes(downloaded)} en ${formatDuration((Date.now() - startedAt) / 1000)}`)
}

async function downloadDirectMp4(streamUrl, pageData, outputPath, attemptSignal) {
  const headers = getDownloadHeaders(pageData)

  // wreq-js tiene un timeout interno para el cuerpo de la respuesta; para
  // archivos grandes usamos el fetch nativo de Node y conservamos sus headers.
  const probeTimeout = createTimeoutSignal(attemptSignal, PAGE_TIMEOUT_MS)
  let probe
  try {
    probe = await nodeFetch(streamUrl, {
      headers: { ...headers, Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: probeTimeout.signal
    })
  } finally {
    probeTimeout.cleanup()
  }
  const probeRange = parseContentRange(probe.headers.get('content-range'))
  const probeLength = Number(probe.headers.get('content-length') || 0)
  const probeContentType = String(probe.headers.get('content-type') || '').toLowerCase()
  try { await probe.body?.cancel() } catch (_) {}

  if (probeContentType.includes('text/html') || probeContentType.includes('application/json')) {
    throw new Error(`La CDN devolvió ${probeContentType} en lugar de MP4`)
  }
  const total = probeRange?.total || probeLength
  if (total > MAX_VIDEO_SIZE) {
    const error = new Error('El video supera el límite máximo permitido de 1.5 GB.')
    error.nonRetryable = true
    throw error
  }
  if (probe.status === 206 && probeRange && probeRange.start === 0 && probeRange.end === 0 && total > 0) {
    logVoe(`Iniciando MP4 paralelo: ${formatBytes(total)} · ${RANGE_CONNECTIONS} conexiones · bloques de ${formatBytes(RANGE_CHUNK_SIZE)}`)
    try {
      await downloadDirectMp4Parallel(streamUrl, pageData, outputPath, total, headers, attemptSignal)
      return
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {})
      logVoe(`Descarga MP4 paralela falló (${error.message}); reintentando en modo secuencial.`)
    }
  }

  const downloadTimeout = createTimeoutSignal(attemptSignal, DIRECT_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await nodeFetch(streamUrl, {
      headers,
      redirect: 'follow',
      signal: downloadTimeout.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar MP4 directo`)

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase()
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new Error(`La CDN devolvió ${contentType || 'contenido no válido'} en lugar de MP4`)
    }
    if (!response.body) throw new Error('La respuesta MP4 no contiene un stream')

    const sequentialTotal = Number(response.headers?.get?.('content-length') || 0)
    logVoe(`Iniciando MP4 directo${sequentialTotal ? ` (${formatBytes(sequentialTotal)})` : ''}`)
    await downloadDirectMp4Sequential(streamUrl, pageData, outputPath, response, sequentialTotal)
  } finally {
    downloadTimeout.cleanup()
  }
}

function runFfmpegWithProgress(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let lastProgress = 0
    let outTime = '00:00:00'
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill(options.killSignal || 'SIGKILL')
    }, options.timeout || FFMPEG_TIMEOUT_MS)
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-4 * 1024 * 1024)
      const now = Date.now()
      const timeMatch = text.match(/out_time=([^\r\n]+)/)
      if (timeMatch) outTime = timeMatch[1]
      if (now - lastProgress >= 1000) {
        const speedMatch = text.match(/speed=([^\s\r\n]+)/)
        logVoe(`FFmpeg HLS: procesado ${outTime}${speedMatch ? ` · velocidad ${speedMatch[1]}` : ''}`)
        lastProgress = now
      }
    })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timeout)
      if (timedOut) reject(Object.assign(new Error(`FFmpeg superó el límite de ${Math.round((options.timeout || FFMPEG_TIMEOUT_MS) / 60000)} minutos`), { stderr }))
      else if (code === 0) resolve()
      else reject(Object.assign(new Error(`FFmpeg terminó con código ${code}`), { stderr }))
    })
  })
}

async function downloadVoeStream(pageData, outputPath, voe, attemptSignal, options = {}) {
  if (pageData.streamType === 'mp4') {
    await downloadDirectMp4(pageData.streamUrl, pageData, outputPath, attemptSignal)
    return
  }

  const extraHeaders = Object.entries(pageData.extraHeaders || {})
    .filter(([name, value]) => value && !/^(user-agent|referer|origin|cookie)$/i.test(name))
    .map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]/g, '')}`)
  const headers = [
    'Referer: ' + (pageData.referer || voe.pageUrl),
    pageData.origin ? 'Origin: ' + pageData.origin : '',
    pageData.cookieHeader ? 'Cookie: ' + pageData.cookieHeader : '',
    ...extraHeaders
  ].filter(Boolean).join('\r\n') + '\r\n'

  try {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
      '-user_agent', FFMPEG_USER_AGENT,
      '-headers', headers,
      '-rw_timeout', '20000000',
      '-http_persistent', '0',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_on_network_error', '1',
      ...(options.reconnectHttpErrors === '' ? [] : ['-reconnect_on_http_error', options.reconnectHttpErrors || '403,408,429,500,502,503,504']),
      '-reconnect_delay_max', '5',
      '-progress', 'pipe:2',
      '-stats_period', '1',
      '-i', pageData.streamUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ]
    await runFfmpegWithProgress(args, { timeout: options.timeoutMs || FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'Error desconocido de FFmpeg').trim()
    throw new Error(`FFmpeg no pudo descargar el HLS: ${detail.slice(-2500)}`)
  }
}

export async function downloadHlsManifest(url, outputPath, referer, headers = {}) {
  const parsed = new URL(String(url || ''))
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('La URL HLS debe usar HTTP o HTTPS.')
  if (!/\.m3u8(?:[?#]|$)|\/m3u8\//i.test(parsed.href)) throw new Error('La URL no parece ser un manifiesto HLS.')
  const { timeoutMs, reconnectHttpErrors, ...requestHeaders } = headers
  const pageUrl = referer || `${parsed.origin}/`
  const cookieHeader = requestHeaders.Cookie || requestHeaders.cookie || ''
  await downloadVoeStream({
    streamType: 'hls',
    streamUrl: parsed.href,
    referer: pageUrl,
    origin: requestHeaders.Origin || requestHeaders.origin || parsed.origin,
    cookieHeader,
    extraHeaders: requestHeaders,
  }, outputPath, { pageUrl }, null, {
    timeoutMs,
    reconnectHttpErrors,
  })
  return { filePath: outputPath, extension: '.mp4', mimetype: 'video/mp4' }
}

export async function downloadVoeWithMirrorFailover(voe, tempDir) {
  const triedMirrors = new Set()
  const errors = []
  const outputPath = join(tempDir, 'voe_' + voe.id + '.mp4')

  while (true) {
    let pageData
    try {
      pageData = await fetchVoePageWithFallback(voe, triedMirrors)
    } catch (error) {
      errors.push(error.message)
      break
    }

    if (pageData.sourceMirror) triedMirrors.add(pageData.sourceMirror)
    if (pageData.mirrorHost) triedMirrors.add(pageData.mirrorHost)
    await rm(outputPath, { force: true }).catch(() => {})

    try {
      const attemptTimeout = createTimeoutSignal(null, DIRECT_DOWNLOAD_TIMEOUT_MS)
      try {
        await downloadVoeStream(pageData, outputPath, voe, attemptTimeout.signal)
      } finally {
        attemptTimeout.cleanup()
      }
      const file = await stat(outputPath)
      if (!file.size) throw new Error('El mirror no generó un archivo de video válido.')
      if (file.size > MAX_VIDEO_SIZE) {
        const error = new Error('El video supera el límite máximo permitido de 1.5 GB.')
        error.nonRetryable = true
        throw error
      }
      logVoe(`Descarga completada usando mirror ${pageData.sourceMirror} → ${pageData.mirrorHost}`)
      return { pageData, outputPath, file }
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {})
      if (error.nonRetryable) throw error
      const mirrorLabel = `${pageData.sourceMirror}${pageData.mirrorHost && pageData.mirrorHost !== pageData.sourceMirror ? ` → ${pageData.mirrorHost}` : ''}`
      errors.push(`${mirrorLabel}: ${error.message}`)
      logVoe(`Falló la descarga desde ${mirrorLabel}; probando el siguiente mirror.`)
    }
  }

  throw new Error('No se pudo descargar desde los mirrors disponibles. ' + errors.slice(-8).join(' | '))
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

    tempDir = await mkdtemp(join(tmpdir(), 'rikka-voe-'))
    const { pageData, outputPath, file } = await downloadVoeWithMirrorFailover(voe, tempDir)
    const videoTitle = extractVoeTitle(pageData.html, voe.id)
    const cleanFileName = videoTitle.endsWith('.mp4') ? videoTitle : (videoTitle + '.mp4')

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
                                
