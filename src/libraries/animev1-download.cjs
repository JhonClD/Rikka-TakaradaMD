// Adaptado de https://github.com/FxxMorgan/anime1v-api (MIT License).
// Aviso de copyright y licencia: ./ANIMEV1-LICENSE
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isIP } = require('node:net')
const { spawn } = require('node:child_process')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const axios = require('axios')
const cheerio = require('cheerio')
const animeV1 = require('./animev1.cjs')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_DOWNLOAD_BYTES = Math.min(2048, Math.max(20, Number(process.env.ANIMEV1_MAX_DOWNLOAD_MB) || 2048)) * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.ANIMEV1_DOWNLOAD_TIMEOUT_MS) || 15 * 60_000)
const MIN_VALID_BYTES = 256 * 1024
const PRIORITY = ['yourupload', 'pixeldrain', 'pdrain', '1fichier', 'mp4upload', 'upnshare', 'hls', 'zilla']
const TEMP_DIR = path.resolve(process.env.ANIMEV1_TEMP_DIR || path.join(os.tmpdir(), 'rikka-animev1'))

function safePart(value) {
  return String(value || 'anime')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'anime'
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
    if (isPrivateAddress(host)) return null
    return url.href
  } catch (_) {
    return null
  }
}

function isPrivateAddress(host) {
  const address = String(host).replace(/^\[|\]$/g, '')
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe80:') ||
      (normalized.startsWith('::ffff:') && isPrivateAddress(normalized.slice(7)))
  }
  return false
}

function normalizeCandidateUrl(rawUrl, server) {
  const url = safeHttpUrl(rawUrl)
  if (!url) return null
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
  const token = String(server || '').toLowerCase()

  if (host.includes('zilla-networks.com') && parsed.pathname.startsWith('/play/')) {
    const id = parsed.pathname.split('/').filter(Boolean).pop()
    if (id) return `https://player.zilla-networks.com/m3u8/${encodeURIComponent(id)}`
  }
  if (host.includes('pixeldrain.com')) {
    const parts = parsed.pathname.split('/').filter(Boolean)
    const id = parts[0] === 'api' && parts[1] === 'file' ? parts[2] : parts[0] === 'u' ? parts[1] : null
    if (id) return `https://pixeldrain.com/api/file/${encodeURIComponent(id)}?download`
  }
  if (token.includes('zilla') && /\/play\//i.test(parsed.pathname)) {
    const id = parsed.pathname.split('/').filter(Boolean).pop()
    if (id) return `https://player.zilla-networks.com/m3u8/${encodeURIComponent(id)}`
  }
  return url
}

function isHlsUrl(url, contentType = '') {
  return /\.m3u8(?:[?#]|$)|\/m3u8\//i.test(url) || /mpegurl|vnd\.apple\.mpegurl/i.test(contentType)
}

function extensionFor(url, contentType) {
  const type = String(contentType || '').toLowerCase()
  if (/video\/webm/.test(type) || /\.webm(?:[?#]|$)/i.test(url)) return '.webm'
  if (/video\/x-matroska/.test(type) || /\.mkv(?:[?#]|$)/i.test(url)) return '.mkv'
  if (/video\/quicktime/.test(type) || /\.mov(?:[?#]|$)/i.test(url)) return '.mov'
  return '.mp4'
}

function getFfmpegPath() {
  try {
    const ffmpegPath = require('ffmpeg-static')
    if (ffmpegPath && fs.existsSync(ffmpegPath)) return ffmpegPath
  } catch (_) {}
  const fallback = process.env.FFMPEG_PATH || 'ffmpeg'
  return fallback
}

async function downloadHls(url, filePath, referer, extraHeaders = {}) {
  const extra = Object.entries(extraHeaders)
    .filter(([name, value]) => value && !/^(user-agent|referer)$/i.test(name))
    .map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]/g, '')}\r\n`)
    .join('')
  const headers = `User-Agent: ${UA}\r\nReferer: ${referer}\r\n${extra}`
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-headers', headers,
    '-i', url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-fs', String(MAX_DOWNLOAD_BYTES),
    '-y', filePath,
  ]
  const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
  const timer = setTimeout(() => child.kill('SIGKILL'), DOWNLOAD_TIMEOUT_MS)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`FFmpeg no pudo descargar el stream (código ${code}): ${stderr.trim().slice(-700)}`))
      })
    })
  } finally {
    clearTimeout(timer)
  }
  return filePath
}

async function resolveWithBrowser(url, referer, onStatus) {
  let puppeteer
  try { puppeteer = require('puppeteer') } catch (_) { return null }
  let browser
  let page
  try {
    onStatus?.('El servidor bloqueó el acceso directo; intentando resolverlo con navegador…')
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage()
    await page.setUserAgent(UA)
    await page.setExtraHTTPHeaders({ Referer: referer || new URL(url).origin + '/' })
    await page.setRequestInterception(true)
    let mediaUrl = null
    page.on('request', request => {
      const requestUrl = request.url()
      const type = request.resourceType()
      if (!mediaUrl && !requestUrl.startsWith('blob:') && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(requestUrl)) mediaUrl = requestUrl
      if (['image', 'stylesheet', 'font'].includes(type)) request.abort().catch(() => {})
      else request.continue().catch(() => {})
    })
    page.on('response', response => {
      const responseUrl = response.url()
      if (!mediaUrl && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(responseUrl)) mediaUrl = responseUrl
    })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    for (const selector of ['.play-button', '.vjs-big-play-button', '.plyr__control--overlaid', '[role="button"]']) {
      try {
        const button = await page.$(selector)
        if (button) { await button.click(); break }
      } catch (_) {}
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
    const context = browser.defaultBrowserContext?.()
    const cookies = await context?.cookies?.().catch(() => null) || await page.cookies().catch(() => [])
    const headers = {
      Referer: url,
      Origin: new URL(url).origin,
      ...(cookies.length ? { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}),
    }
    return mediaUrl ? { url: mediaUrl, headers } : null
  } catch (error) {
    console.warn('[animev1 browser resolver]', error.message)
    return null
  } finally {
    try { if (page) await page.close() } catch (_) {}
    try { if (browser) await browser.close() } catch (_) {}
  }
}

async function downloadHlsWithFallback(candidate, url, basePath, referer, onStatus) {
  try {
    return await downloadHls(url, `${basePath}.mp4`, referer, candidate.headers)
  } catch (firstError) {
    const browserResult = await resolveWithBrowser(candidate.url || url, referer, onStatus)
    if (!browserResult?.url) throw firstError
    if (browserResult.url === url || isHlsUrl(browserResult.url)) {
      return downloadHls(browserResult.url, `${basePath}.mp4`, browserResult.headers?.Referer || referer, browserResult.headers)
    }
    const resolved = await fetchCandidate({ ...candidate, url: browserResult.url }, basePath, onStatus)
    return resolved.filePath
  }
}

function extractMediaUrl(html, baseUrl) {
  const $ = cheerio.load(html)
  const candidates = []
  $('video[src], video source[src], source[src], [data-src], [data-file], [data-video], [data-source]').each((_, element) => {
    const value = $(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-file') || $(element).attr('data-video') || $(element).attr('data-source')
    if (value) candidates.push(value)
  })
  const patterns = [
    /sources?\s*:\s*\[\s*\{[^}]*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i,
    /"(?:file|source|video)"\s*:\s*"([^"]+)"/i,
    /(?:file|videoSrc|video_url)\s*[:=]\s*['"]([^'"]+)['"]/i,
    /(https?:\\?\/\\?\/[^\s"'<>]+\.(?:mp4|m3u8)(?:\?[^\s"'<>]*)?)/i,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) candidates.push(match[1])
  }
  for (const raw of candidates) {
    const decoded = String(raw).replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&')
    try {
      const absolute = new URL(decoded, baseUrl).href
      if (/\.(?:mp4|m3u8|webm|mkv)(?:[?#]|$)|\/m3u8\//i.test(absolute)) return absolute
    } catch (_) {}
  }
  return null
}

async function readLimitedText(stream, maxBytes = 4 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxBytes) {
      stream.destroy?.()
      throw new Error('La página del servidor es demasiado grande para analizarla.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchCandidate(candidate, basePath, onStatus) {
  let url = normalizeCandidateUrl(candidate.url, candidate.server)
  if (!url) throw new Error('URL de servidor no válida.')
  const origin = new URL(url).origin
  const referer = `${origin}/`
  let filePath = `${basePath}.mp4`

  if (isHlsUrl(url)) {
    onStatus?.(`Convirtiendo stream HLS de ${candidate.server}…`)
    return { filePath: await downloadHlsWithFallback(candidate, url, basePath, referer, onStatus), extension: '.mp4', mimetype: 'video/mp4' }
  }

  onStatus?.(`Abriendo servidor ${candidate.server}…`)
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: Math.min(DOWNLOAD_TIMEOUT_MS, 180_000),
    maxRedirects: 8,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      Referer: candidate.url ? `${new URL(candidate.url).origin}/` : referer,
      ...(candidate.headers || {}),
    },
    validateStatus: status => status >= 200 && status < 400,
  })
  const finalUrl = response.request?.res?.responseUrl || url
  const contentType = String(response.headers['content-type'] || '').toLowerCase()
  const contentLength = Number(response.headers['content-length'] || 0)
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    response.data.destroy()
    throw new Error(`El archivo supera el límite configurado de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`)
  }

  if (isHlsUrl(finalUrl, contentType)) {
    response.data.destroy()
    filePath = `${basePath}.mp4`
    onStatus?.(`Convirtiendo stream HLS de ${candidate.server}…`)
    return { filePath: await downloadHlsWithFallback(candidate, finalUrl, basePath, referer, onStatus), extension: '.mp4', mimetype: 'video/mp4' }
  }

  if (/text\/html|application\/json|application\/javascript|text\/plain/i.test(contentType)) {
    const html = await readLimitedText(response.data)
    const mediaUrl = extractMediaUrl(html, finalUrl)
    if (mediaUrl && mediaUrl !== finalUrl) return fetchCandidate({ ...candidate, url: mediaUrl }, basePath, onStatus)
    const browserResult = await resolveWithBrowser(finalUrl, referer, onStatus)
    if (browserResult?.url && browserResult.url !== finalUrl) {
      return fetchCandidate({ ...candidate, url: browserResult.url, headers: browserResult.headers }, basePath, onStatus)
    }
    throw new Error(`No pude extraer un video directo de ${candidate.server}.`)
  }

  const extension = extensionFor(finalUrl, contentType)
  filePath = `${basePath}${extension}`
  let downloadedBytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length
      if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
        callback(new Error(`El archivo supera el límite configurado de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`))
      } else callback(null, chunk)
    },
  })
  try {
    await pipeline(response.data, limiter, fs.createWriteStream(filePath))
  } catch (error) {
    await fs.promises.rm(filePath, { force: true })
    throw error
  }
  const stat = await fs.promises.stat(filePath)
  if (stat.size < MIN_VALID_BYTES) {
    await fs.promises.rm(filePath, { force: true })
    throw new Error(`La descarga de ${candidate.server} quedó incompleta o no era un video.`)
  }
  const mimetype = extension === '.webm' ? 'video/webm' : extension === '.mkv' ? 'video/x-matroska' : extension === '.mov' ? 'video/quicktime' : 'video/mp4'
  return { filePath, extension, mimetype }
}

function listCandidates(data, variant) {
  const key = String(variant || 'SUB').toUpperCase() === 'DUB' ? 'DUB' : 'SUB'
  const stream = data?.streamLinks?.[key] || data?.servers?.[key.toLowerCase()] || []
  const downloads = data?.downloadLinks?.[key] || []
  const candidates = [
    ...stream.map(item => ({ ...item, kind: 'stream' })),
    ...downloads.map(item => ({ ...item, kind: 'descarga' })),
  ]
    .filter(item => item?.url && !/mega/i.test(`${item.server || ''} ${item.url}`))
  const seen = new Set()
  return candidates
    .filter(item => {
      const url = safeHttpUrl(item.url)
      if (!url || seen.has(url)) return false
      seen.add(url)
      return true
    })
    .sort((a, b) => {
      const rank = item => {
        const text = `${item.server || ''} ${item.url || ''}`.toLowerCase()
        const index = PRIORITY.findIndex(token => text.includes(token))
        const kindBonus = item.kind === 'descarga' ? 0 : 1
        return index < 0 ? PRIORITY.length * 2 + kindBonus : index * 2 + kindBonus
      }
      return rank(a) - rank(b)
    })
}

async function downloadEpisodeFile(episodeUrl, options = {}) {
  const normalizedEpisodeUrl = safeHttpUrl(episodeUrl)
  if (!normalizedEpisodeUrl) throw new Error('La URL del episodio no es válida.')
  const variant = String(options.variant || 'SUB').toUpperCase() === 'DUB' ? 'DUB' : 'SUB'
  const response = await animeV1.getEpisodeLinks(normalizedEpisodeUrl, false)
  const candidates = listCandidates(response?.data, variant)
  if (!candidates.length) throw new Error(`AnimeV1 no encontró enlaces para la variante ${variant}.`)

  await fs.promises.mkdir(TEMP_DIR, { recursive: true })
  const basePath = path.join(TEMP_DIR, `${safePart(options.title)}-ep${safePart(options.episode || response?.data?.episode || 'x')}-${randomUUID()}`)
  const errors = []
  for (const candidate of candidates) {
    options.onStatus?.(`Probando ${candidate.server || 'servidor'} (${variant})…`)
    try {
      const file = await fetchCandidate(candidate, basePath, options.onStatus)
      const stat = await fs.promises.stat(file.filePath)
      if (stat.size < MIN_VALID_BYTES || stat.size >= MAX_DOWNLOAD_BYTES) {
        await fs.promises.rm(file.filePath, { force: true })
        throw new Error('El archivo descargado no tiene un tamaño válido.')
      }
      return {
        ...file,
        fileName: `${safePart(options.title)}-ep${safePart(options.episode || response?.data?.episode || 'x')}${file.extension}`,
        fileSize: stat.size,
        server: candidate.server || 'servidor',
        variant,
      }
    } catch (error) {
      errors.push(`${candidate.server || 'servidor'}: ${error.message}`)
      for (const extension of ['.mp4', '.webm', '.mkv', '.mov']) {
        await fs.promises.rm(`${basePath}${extension}`, { force: true })
      }
    }
  }
  throw new Error(`No pude completar la descarga desde los servidores disponibles. ${errors.slice(0, 4).join(' | ')}`)
}

async function cleanupDownloadFile(filePath) {
  if (!filePath) return
  try { await fs.promises.rm(filePath, { force: true }) } catch (_) {}
}

module.exports = { downloadEpisodeFile, cleanupDownloadFile, MAX_DOWNLOAD_BYTES }
