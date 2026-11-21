import {
  CarouselCardType,
  generateWAMessageFromContent,
  getBizBinaryNode,
  getDevice,
  prepareWAMessageMedia,
} from 'baileys'
import * as cheerio from 'cheerio'
import ffmpegStatic from 'ffmpeg-static'
import { File as MegaFile } from 'megajs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { downloadKey, hasDownload, startDownload } from '../src/funcion/download-registry.js'
import { cleanJid, getLidForJidAsync, resolveAnyJid, resolveJidToPhone } from '../src/funcion/lid-resolver.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'

const BASE = 'https://hentaila.com'
const SERVICE = 'hentaila'

const WREQ_BROWSER = 'chrome_142'
const IMPIT_BROWSER = 'chrome142'
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const BASE_HEADERS = { 'Accept-Language': 'es-419,es;q=0.9,en-US;q=0.8,en;q=0.7' }
const FFMPEG_BIN = (ffmpegStatic && fs.existsSync(ffmpegStatic)) ? ffmpegStatic : (process.env.FFMPEG_PATH || 'ffmpeg')
const VOE_MIRRORS = [
  'susanexpectcare.com',
  'kathyinformationwhether.com',
  'walterprettytheir.com',
  'stevenfamilyedge.com',
  'voe.sx',
]

const PROXY_URL = String(process.env.HDL_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
const ONEFICHIER_API_KEY = String(process.env.ONEFICHIER_API_KEY || '').trim()

const PAGE_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const IDLE_TIMEOUT_MS = 60_000
const REQUEST_PACING_MS = 350

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 150
const SESSION_TTL_MS = 3 * 60 * 1000
const EXPIRED_MEMORY_MS = 30 * 60 * 1000

const MIN_VALID_BYTES = 16 * 1024
const MAX_FILE_BYTES = 2 * 1024 ** 3
const MEGA_MAX_CONNECTIONS = 10
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const BUTTON_TOKEN_PREFIX = 'hdl_btn:'

let wreqSessionPromise = null
let wreqUnavailable = false
let impitClientPromise = null
let impitUnavailable = false

const htmlCache = new Map()
const sessions = new Map()
const expiredSessions = new Map()

let lastPacedRequestAt = 0
let pacingChain = Promise.resolve()

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(message = 'Operación cancelada') {
  const err = new Error(message)
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function isAbortError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'CanceledError' ||
    err?.code === 'ABORT_ERR' ||
    err?.code === 'ERR_CANCELED'
  )
}

function combineSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal])
  return signal
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function sanitizeFilename(name, fallback = 'video.mp4') {
  const cleaned = String(name || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return cleaned || fallback
}

function buildDocumentFilename(title, slug, episode) {
  const epNum = String(episode).padStart(2, '0')
  const safeTitle = sanitizeFilename(title, slug)
  return `${epNum} ${safeTitle} Sub Español (1080p) [[𝗖𝗜𝗗]].mp4`
}

function waitRequestSlot(signal) {
  const slot = pacingChain.then(async () => {
    const wait = Math.max(0, lastPacedRequestAt + REQUEST_PACING_MS - Date.now())
    if (wait > 0) await sleep(wait, signal)
    lastPacedRequestAt = Date.now()
  })
  pacingChain = slot.catch(() => {})
  return slot
}

async function getWreqSession() {
  if (wreqUnavailable) return null
  if (!wreqSessionPromise) {
    wreqSessionPromise = import('wreq-js')
      .then((mod) => mod.createSession({
        browser: WREQ_BROWSER,
        os: 'windows',
        timeout: PAGE_TIMEOUT_MS,
        ...(PROXY_URL ? { proxy: PROXY_URL } : {}),
      }))
      .catch((err) => {
        wreqUnavailable = true
        wreqSessionPromise = null
        console.warn(`[HDL] wreq-js no disponible: ${err.message}`)
        return null
      })
  }
  return wreqSessionPromise
}

async function getImpitClient() {
  if (impitUnavailable) return null
  if (!impitClientPromise) {
    impitClientPromise = import('impit')
      .then(({ Impit }) => new Impit({
        browser: IMPIT_BROWSER,
        timeout: PAGE_TIMEOUT_MS,
        ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}),
      }))
      .catch((err) => {
        impitUnavailable = true
        impitClientPromise = null
        console.warn(`[HDL] impit no disponible: ${err.message}`)
        return null
      })
  }
  return impitClientPromise
}

function toNodeReadable(body) {
  if (!body) throw new Error('Respuesta HTTP sin cuerpo')
  if (body instanceof Readable || typeof body.pipe === 'function') return body
  if (typeof body.getReader === 'function') {
    try {
      return Readable.fromWeb(body)
    } catch {
      if (typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body)
      throw new Error('Cuerpo HTTP Web ReadableStream incompatible')
    }
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body)
  throw new Error('Cuerpo HTTP incompatible')
}

async function cancelBodyQuietly(res) {
  try {
    if (typeof res?.body?.cancel === 'function') await res.body.cancel()
    else if (typeof res?.body?.destroy === 'function') res.body.destroy()
  } catch { }
}

async function httpFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = PAGE_TIMEOUT_MS,
    signal,
    redirect = 'follow',
  } = options

  const reqHeaders = { ...BASE_HEADERS, ...headers }
  let fallbackResponse = null
  let lastError = null

  const wreqSession = await getWreqSession()
  if (wreqSession) {
    try {
      const res = await wreqSession.fetch(url, {
        method,
        headers: reqHeaders,
        body,
        timeout,
        redirect,
        signal: combineSignal(signal, timeout),
      })
      if (res.status !== 403 && res.status !== 503) return res
      fallbackResponse = res
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastError = err
    }
  }

  const impit = await getImpitClient()
  if (impit) {
    try {
      const res = await impit.fetch(url, {
        method,
        headers: reqHeaders,
        body,
        timeout,
        redirect,
        signal: combineSignal(signal, timeout),
      })
      if (res.ok || !fallbackResponse) {
        if (fallbackResponse) await cancelBodyQuietly(fallbackResponse)
        return res
      }
      await cancelBodyQuietly(res)
      return fallbackResponse
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastError = err
    }
  }

  if (fallbackResponse) return fallbackResponse

  try {
    return await globalThis.fetch(url, {
      method,
      headers: { 'User-Agent': FALLBACK_UA, ...reqHeaders },
      body,
      redirect,
      signal: combineSignal(signal, timeout),
    })
  } catch (err) {
    if (signal?.aborted) throw createAbortError()
    throw lastError || err
  }
}

function isCloudflareBlocked(html) {
  if (!html || html.length < 200) return true
  return (
    html.includes('cf-browser-verification') ||
    html.includes('Just a moment') ||
    html.includes('challenge-platform') ||
    html.includes('Enable JavaScript and cookies') ||
    /<title>\s*Attention Required/i.test(html)
  )
}

function cacheGet(url) {
  const entry = htmlCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    htmlCache.delete(url)
    return null
  }
  htmlCache.delete(url)
  htmlCache.set(url, entry)
  return entry.html
}

function cacheSet(url, html) {
  if (htmlCache.has(url)) htmlCache.delete(url)
  else if (htmlCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = htmlCache.keys().next().value
    if (oldestKey !== undefined) htmlCache.delete(oldestKey)
  }
  htmlCache.set(url, { html, ts: Date.now() })
}

export async function fetchText(url, options = {}) {
  const { cache = true, headers = {}, timeout = PAGE_TIMEOUT_MS, signal } = options
  if (cache) {
    const cached = cacheGet(url)
    if (cached) return cached
  }

  const isHentaiLa = url.startsWith(BASE)
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt++) {
    if (isHentaiLa) await waitRequestSlot(signal)
    try {
      const res = await httpFetch(url, { headers, timeout, signal })
      const html = await res.text()

      if (res.status === 404) {
        const err = new Error('HTTP 404')
        err.status = 404
        throw err
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        if (!RETRYABLE_STATUSES.has(res.status)) throw err
        lastError = err
      } else if (isCloudflareBlocked(html)) {
        const err = new Error('Bloqueado por desafío anti-bot (Cloudflare)')
        err.status = 403
        lastError = err
      } else {
        if (cache) cacheSet(url, html)
        return html
      }
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      if (err?.status === 404) throw err
      lastError = err
    }

    if (attempt === 0) await sleep(700, signal)
  }

  throw lastError || new Error(`No se pudo obtener ${url}`)
}

async function fetchBuffer(url, signal) {
  const res = await httpFetch(url, {
    headers: { Referer: `${BASE}/`, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    timeout: 15_000,
    signal,
  })
  if (!res.ok) {
    await cancelBodyQuietly(res)
    throw new Error(`No se pudo obtener imagen (HTTP ${res.status})`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function parseHentaiInput(rawText) {
  const trimmed = String(rawText || '').trim()
  const urlMatch = trimmed.match(/https?:\/\/(?:www\.)?hentaila\.com\/media\/([^/?#\s]+)(?:\/(\d+))?(?:\s+(all))?/i)
  if (urlMatch) {
    const slug = decodeURIComponent(urlMatch[1]).toLowerCase()
    const ep = urlMatch[2] || null
    const all = !ep && Boolean(urlMatch[3])
    return { slug, episode: ep, all, query: slug.replace(/-/g, ' ') }
  }

  let query = trimmed
  let episode = null
  let all = false

  const allMatch = query.match(/\s+all\s*$/i)
  if (allMatch) {
    const candidateQuery = query.slice(0, allMatch.index).trim()
    if (candidateQuery) {
      all = true
      query = candidateQuery
    }
  }

  if (!all) {
    const epMatch = query.match(/(?:\s+(?:(?:ep(?:isodio)?|cap(?:[ií]tulo)?)\.?|#)\s*|\s+)(\d+)\s*$/i)
    if (epMatch) {
      const candidateQuery = query.slice(0, epMatch.index).trim()
      if (candidateQuery) {
        episode = epMatch[1]
        query = candidateQuery
      }
    }
  }

  const cleanQuery = query.replace(/[?!¡¿]/g, '').replace(/\s+/g, ' ').trim()
  return { slug: null, episode, all, query: cleanQuery }
}

function buildSlugVariations(query) {
  const base = String(query || '').toLowerCase().trim()
  const variations = new Set()
  const toSlug = (str) => str.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')

  variations.add(toSlug(base))

  const words = base.split(/\s+/).filter(Boolean)
  const stopWords = new Set(['the', 'and', 'for', 'with', 'una', 'los', 'las', 'del'])
  variations.add(toSlug(words.filter((w) => w.length > 2 && !stopWords.has(w)).join(' ')))
  if (words.length > 3) variations.add(toSlug(words.slice(0, 3).join(' ')))
  if (words.length > 2) variations.add(toSlug(words.slice(0, 2).join(' ')))

  const sinParticulas = base.replace(/\b(wa|no|ga|wo|ni|ha|de|mo|ka)\b/g, ' ').replace(/\s+/g, ' ').trim()
  variations.add(toSlug(sinParticulas))

  return [...variations].filter((v) => v.length > 1)
}

function parseSeriesInfo(html, slug) {
  const $ = cheerio.load(html)

  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim()
  const rawTitle = $('title').first().text().trim()
  const cleanedTitle = rawTitle
    .replace(/\s*(?:online\s+gratis.*|[-–|].*)$/i, '')
    .trim()
  const title = h1 || cleanedTitle || slug.replace(/-/g, ' ')

  const cover = $('meta[property="og:image"]').attr('content')?.trim() || null
  const desc = (
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    ''
  ).replace(/\s+/g, ' ').trim() || 'Sin descripción.'

  const epSet = new Set()
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const epRe = new RegExp(`/media/${escapedSlug}/(\\d+)`, 'g')
  let match
  while ((match = epRe.exec(html)) !== null) epSet.add(Number(match[1]))
  const episodes = [...epSet].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)

  const genreSet = new Set()
  $('a[href*="genre="]').each((_, el) => {
    const g = $(el).text().replace(/\s+/g, ' ').trim()
    if (g) genreSet.add(g)
  })

  return { slug, title, cover, desc, episodes, generos: [...genreSet] }
}

function parseSearchResults(html) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()

  const add = (slug, title) => {
    const cleanSlug = String(slug || '').trim().replace(/^\/+|\/+$/g, '')
    if (!cleanSlug || cleanSlug.includes('/') || seen.has(cleanSlug)) return
    seen.add(cleanSlug)
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim() || cleanSlug.replace(/-/g, ' ')
    results.push({ slug: cleanSlug, title: cleanTitle })
  }

  $('article').each((_, el) => {
    const $el = $(el)
    const href = $el.find('a[href^="/media/"]').first().attr('href') || ''
    const m = href.match(/^\/media\/([^/?#]+)$/)
    if (!m) return
    const title = $el.find('h2, h3, h4, header').first().text() || $el.find('img').first().attr('alt')?.replace(/^Portada de\s+/i, '')
    add(m[1], title)
  })

  if (results.length > 0) return results

  const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
  for (const m of decoded.matchAll(/"slug"\s*:\s*"([^"]+)"(?:[^}]{0,300}?"title"\s*:\s*"([^"]+)")?/g)) {
    add(m[1], m[2])
  }
  for (const m of decoded.matchAll(/href="\/media\/([^/"]+)(?:\/\d+)?"/g)) {
    add(m[1], null)
  }

  return results
}

function parseLatestReleases(html, limit = 10) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()

  const add = (slug, episode, title, rawThumb = null) => {
    const cleanSlug = String(slug || '').trim()
    const epNum = Number(episode)
    if (!cleanSlug || !Number.isFinite(epNum) || epNum <= 0 || seen.has(cleanSlug)) return
    seen.add(cleanSlug)
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim() || cleanSlug.replace(/-/g, ' ')
    let thumb = null
    if (rawThumb) {
      try { thumb = new URL(rawThumb, BASE).href } catch { }
    }
    results.push({ slug: cleanSlug, title: cleanTitle, episode: epNum, thumb })
  }

  $('article').each((_, el) => {
    const $el = $(el)
    const href = $el.find('a[href^="/media/"]').first().attr('href') || ''
    const m = href.match(/^\/media\/([^/?#]+)\/(\d+)$/)
    if (!m) return
    const title = $el.find('h2, h3, h4, header').first().text()
    const img = $el.find('img').first()
    const thumb = img.attr('src') || img.attr('data-src') || null
    add(m[1], m[2], title, thumb)
  })

  if (results.length === 0) {
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
    for (const m of decoded.matchAll(/"slug"\s*:\s*"([^"]+)"[^}]{0,200}?"episode"\s*:\s*(\d+)(?:[^}]{0,200}?"title"\s*:\s*"([^"]+)")?/g)) {
      add(m[1], m[2], m[3])
    }
    for (const m of html.matchAll(/href="\/media\/([^/"]+)\/(\d+)"/g)) {
      add(m[1], m[2], null)
    }
  }

  return results.slice(0, limit)
}

function normalizeMegaUrl(url) {
  const raw = String(url || '').trim()
  const m = raw.match(/mega\.nz\/(?:embed|file)\/[#!]*([A-Za-z0-9_-]{6,})[!#]([A-Za-z0-9_-]{20,})/i)
  if (m) return `https://mega.nz/file/${m[1]}#${m[2]}`
  return raw
}

function normalizeMp4UploadUrl(url) {
  const raw = String(url || '').trim()
  const m = raw.match(/mp4upload\.com\/(?:embed-)?([a-z0-9_-]{4,80})(?:\.html)?/i)
  if (m) return `https://www.mp4upload.com/embed-${m[1]}.html`
  return raw
}

function normalizeVoeUrl(url) {
  const raw = String(url || '').trim()
  const m = raw.match(/https?:\/\/[^/\s"'<\\]+\/(?:(?:e|v|d)\/)?([a-z0-9_-]{6,64})(?:[/?#]|$)/i)
  if (m) return `https://voe.sx/e/${m[1]}`
  return raw
}

function parseEpisodeLinks(html) {
  const decoded = String(html || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')

  const matchAllUnique = (regex, transform = (u) => u) => {
    const out = new Set()
    for (const m of decoded.matchAll(regex)) {
      const cleaned = m[0].replace(/[),.;'"]+$/, '')
      out.add(transform(cleaned))
    }
    return [...out]
  }

  const voeHosts = VOE_MIRRORS.map((h) => h.replace(/\./g, '\\.')).join('|')
  const voeRe = new RegExp(`https?:\\/\\/[^\\s"'<\\\\]*(?:${voeHosts})\\/(?:(?:e|v|d)\\/)?[a-z0-9_-]{6,64}[^\\s"'<\\\\]*`, 'gi')

  const mega = matchAllUnique(/https?:\/\/[^\s"'<\\]*mega\.nz\/(?:file|embed)\/[^\s"'<\\]*/gi, normalizeMegaUrl)
  const mediafire = matchAllUnique(/https?:\/\/[^\s"'<\\]*mediafire\.com\/file[^\s"'<\\]*/gi)
  const fireload = matchAllUnique(/https?:\/\/[^\s"'<\\]*fireload\.com\/[a-z0-9]{8,}[^\s"'<\\]*/gi)
  const fichier = matchAllUnique(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/gi)
  const mp4upload = matchAllUnique(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/(?:embed-)?[a-z0-9_-]{4,80}(?:\.html)?/gi, normalizeMp4UploadUrl)
  const yourupload = matchAllUnique(/https?:\/\/[^\s"'<\\]*yourupload\.com\/(?:embed|watch)\/[^\s"'<\\]*/gi)
  const voe = matchAllUnique(voeRe, normalizeVoeUrl)

  const known = new Set([...mega, ...mediafire, ...fireload, ...fichier, ...mp4upload, ...yourupload, ...voe])
  const otros = matchAllUnique(/https?:\/\/[^\s"'<\\]{10,}/gi)
    .filter((u) => !u.includes(BASE) && !known.has(u) && /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u))

  return { mega, mediafire, fireload, fichier, mp4upload, yourupload, voe, otros }
}

function extractMediafireDirect(html, sourceUrl = '') {
  const $ = cheerio.load(html)
  const direct =
    $('#downloadButton').attr('href') ||
    html.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/i)?.[1] ||
    null
  const name =
    $('.promoDownloadName').first().attr('title') ||
    $('.filename').first().text().trim() ||
    sourceUrl.split('/').pop()?.split('?')[0] ||
    'video.mp4'
  return { direct, name: name.replace(/\s+/g, ' ').trim() }
}

function extractFireloadDirect(html) {
  let direct = null
  let waitSeconds = 0
  const flMatch = html.match(/window\.Fl\s*=\s*(\{[\s\S]*?\})/i)
  if (flMatch) {
    try {
      const parsed = JSON.parse(flMatch[1])
      direct = parsed.dlink || null
      waitSeconds = Math.min(30, Math.max(0, Number(parsed.dwait) || 0))
    } catch { }
  }
  if (!direct) {
    direct =
      html.match(/"dlink"\s*:\s*"(https?:\/\/[^"]+)"/i)?.[1]?.replace(/\\\//g, '/') ||
      html.match(/href=["'](https?:\/\/[^"']*fireload\.com\/d\/[^"']+)["']/i)?.[1] ||
      html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1] ||
      null
  }
  const titleName = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|\s*Fireload.*$/i, '').trim()
  return { direct, name: titleName || 'video.mp4', waitSeconds }
}

function extractMp4UploadDirect(html) {
  const source = String(html || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')

  const patterns = [
    /https?:\/\/(?:[a-z]\d+|www\d{1,2})\.mp4upload\.com(?::\d+)?\/d\/[a-z0-9]{20,100}\/[^"'\s<>]+/i,
    /(?:file|src|source|video_url)\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']*)?)["']/i,
  ]
  for (const re of patterns) {
    const m = source.match(re)
    const candidate = m?.[1] || m?.[0]
    if (candidate && /\.mp4(?:[?#]|$)/i.test(candidate)) {
      return { direct: candidate, name: 'video.mp4' }
    }
  }

  const packed = source.match(/(?:^|[^a-z0-9])((?:www\d{1,2}|[a-z]\d+))\|[^|]{0,120}\|poster\|[a-z0-9]+\|(?:nivideo|video)\|([a-z0-9]{40,80})\|(\d{1,5})(?:[^0-9]|$)/i)
  const heading = source.match(/<h2[^>]*>\s*Download\s+File\s+(.+?)\s*<\/h2>/i)
  if (packed && heading) {
    const filename = heading[1].replace(/<[^>]*>/g, '').trim()
    const port = Number(packed[3])
    if (port > 0 && port <= 65535 && filename && /^[a-z0-9._%+-]+$/i.test(filename)) {
      return {
        direct: `https://${packed[1].toLowerCase()}.mp4upload.com:${port}/d/${packed[2].toLowerCase()}/${filename}`,
        name: filename,
      }
    }
  }

  return { direct: null, name: 'video.mp4' }
}

function extractYourUploadDirect(html) {
  const source = String(html || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')

  const patterns = [
    /file\s*:\s*['"](https?:\/\/[^'"]+)['"]/i,
    /sources?\s*:\s*\[\s*\{[^}]*src\s*:\s*['"](https?:\/\/[^'"]+)['"]/i,
    /(?:src|source)\s*=\s*['"](https?:\/\/[^'"]+\.mp4(?:\?[^'"]*)?)['"]/i,
  ]
  for (const re of patterns) {
    const m = source.match(re)
    if (m?.[1] && !/novideo\.mp4/i.test(m[1])) return m[1]
  }
  return null
}

async function resolveMediafire(url, signal) {
  const res = await httpFetch(url, { timeout: PAGE_TIMEOUT_MS, signal })
  if (!res.ok) throw new Error(`MediaFire HTTP ${res.status}`)
  const html = await res.text()
  const { direct, name } = extractMediafireDirect(html, url)
  if (!direct) throw new Error('No se encontró enlace directo en MediaFire')
  return { direct, name, referer: 'https://www.mediafire.com/' }
}

async function resolveFireload(url, signal) {
  const res = await httpFetch(url, { timeout: PAGE_TIMEOUT_MS, signal })
  if (!res.ok) throw new Error(`FireLoad HTTP ${res.status}`)
  const html = await res.text()
  const { direct, name, waitSeconds } = extractFireloadDirect(html)
  if (!direct) throw new Error('No se encontró enlace directo en FireLoad')
  if (waitSeconds > 0) await sleep(waitSeconds * 1000, signal)
  return { direct, name, referer: 'https://www.fireload.com/' }
}

async function resolveMp4Upload(url, signal) {
  const id = url.match(/mp4upload\.com\/(?:embed-)?([a-z0-9_-]{4,80})/i)?.[1]
  const candidates = id
    ? [`https://www.mp4upload.com/embed-${id}.html`, `https://www.mp4upload.com/${id}`]
    : [url]

  let lastError = null
  for (const candidate of candidates) {
    try {
      const res = await httpFetch(candidate, {
        headers: { Referer: 'https://www.mp4upload.com/' },
        timeout: PAGE_TIMEOUT_MS,
        signal,
      })
      if (!res.ok) throw new Error(`MP4Upload HTTP ${res.status}`)
      const html = await res.text()
      const { direct, name } = extractMp4UploadDirect(html)
      if (direct) return { direct, name, referer: 'https://www.mp4upload.com/' }
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastError = err
    }
  }
  throw lastError || new Error('No se encontró enlace directo en MP4Upload')
}

async function resolveYourUpload(url, signal) {
  let pageUrl = url
  let res = await httpFetch(pageUrl, {
    headers: { Referer: 'https://www.yourupload.com/' },
    timeout: PAGE_TIMEOUT_MS,
    signal,
  })
  if (!res.ok) throw new Error(`YourUpload HTTP ${res.status}`)
  let html = await res.text()

  const iframeSrc = html.match(/<iframe\b[^>]*\bsrc=["']([^"']*yourupload\.com\/embed\/[^"']+)["']/i)?.[1]
  if (iframeSrc) {
    pageUrl = new URL(iframeSrc, pageUrl).href
    res = await httpFetch(pageUrl, {
      headers: { Referer: url },
      timeout: PAGE_TIMEOUT_MS,
      signal,
    })
    if (!res.ok) throw new Error(`YourUpload embed HTTP ${res.status}`)
    html = await res.text()
  }

  const direct = extractYourUploadDirect(html)
  if (!direct) throw new Error('No se encontró enlace MP4 en YourUpload')
  return { direct, name: 'video.mp4', referer: pageUrl }
}

function deobfuscateVoePayload(rawStr) {
  try {
    let s = String(rawStr || '').replace(/[a-zA-Z]/g, (c) => {
      const base = c <= 'Z' ? 65 : 97
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
    })
    for (const junk of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) {
      s = s.split(junk).join('')
    }
    s = s.replace(/_/g, '')
    const step2 = Buffer.from(s, 'base64').toString('utf8')
    let step3 = ''
    for (let i = 0; i < step2.length; i++) {
      step3 += String.fromCharCode(step2.charCodeAt(i) - 3)
    }
    const reversed = step3.split('').reverse().join('')
    return JSON.parse(Buffer.from(reversed, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function decodeVoeUrl(value) {
  const cleaned = String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .trim()
  if (!/^https?:\/\//i.test(cleaned) && /^[A-Za-z0-9+/=]{16,}$/.test(cleaned)) {
    try {
      const decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim()
      if (/^https?:\/\//i.test(decoded)) return decoded
    } catch { }
  }
  return cleaned
}

function isSafeHttpsUrl(value, baseUrl) {
  try {
    const u = new URL(value, baseUrl)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
    return u
  } catch {
    return null
  }
}

function extractVoeMedia(html, baseUrl) {
  let directMp4 = null
  let hlsUrl = null
  const isFake = (u) => /bigbuckbunny|test[-_]?video|sample[-_]?video|placeholder/i.test(u)

  const consider = (raw) => {
    const decoded = decodeVoeUrl(raw)
    if (!decoded || isFake(decoded)) return
    const safe = isSafeHttpsUrl(decoded, baseUrl)
    if (!safe) return
    const href = safe.toString()
    if (!directMp4 && /\.mp4(?:[?#]|$)/i.test(safe.pathname)) {
      directMp4 = href
    } else if (!hlsUrl && (/\.m3u8(?:[?#]|$)/i.test(safe.pathname) || /\/hls(?:[/?#]|$)/i.test(safe.pathname))) {
      hlsUrl = href
    }
  }

  const jsonScriptRe = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/gi
  for (const m of html.matchAll(jsonScriptRe)) {
    const obj = deobfuscateVoePayload(m[1])
    if (!obj) continue
    if (Array.isArray(obj.direct_access_url)) consider(obj.direct_access_url[0])
    else if (obj.direct_access_url) consider(obj.direct_access_url)
    if (obj.source) consider(obj.source)
    if (obj.hls) consider(obj.hls)
    if (obj.file) consider(obj.file)
    if (Array.isArray(obj.sources)) {
      for (const item of obj.sources) {
        if (item) consider(item.hls || item.file || item.src)
      }
    }
  }

  if (!directMp4 && !hlsUrl) {
    for (const m of html.matchAll(/["'](?:direct_access_url|hls|source|file)["']\s*:\s*["']([^"']+)["']/gi)) {
      consider(m[1])
    }
    for (const m of html.matchAll(/atob\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/gi)) {
      consider(m[1])
    }
    for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>]*)?/gi)) {
      consider(m[0])
    }
  }

  return { directMp4, hlsUrl }
}

function extractVoeJsRedirect(html, currentUrl) {
  const patterns = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'\s>]+)/i,
  ]
  for (const re of patterns) {
    const match = html.match(re)
    if (match?.[1]) {
      const safe = isSafeHttpsUrl(decodeVoeUrl(match[1]), currentUrl)
      if (safe) return safe.toString()
    }
  }
  return null
}

async function resolveVoe(url, signal) {
  const parsed = new URL(url)
  const idMatch = parsed.pathname.match(/^\/(?:(?:e|v|d)\/)?([a-z0-9_-]{6,64})(?:\/|$)/i)
  if (!idMatch) throw new Error('ID de VOE no reconocido')
  const id = idMatch[1]
  const originalHost = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const mirrors = [...new Set([
    ...VOE_MIRRORS,
    ...(originalHost ? [originalHost] : []),
  ])]

  const triedHosts = new Set()
  let lastError = null

  for (const mirror of mirrors) {
    if (signal?.aborted) throw createAbortError()
    if (triedHosts.has(mirror)) continue
    triedHosts.add(mirror)

    let currentUrl = `https://${mirror}/e/${id}`
    const visited = new Set([currentUrl])
    let cookieHeader = ''
    let cookieHost = mirror

    try {
      for (let hop = 0; hop < 8; hop++) {
        if (signal?.aborted) throw createAbortError()
        const currentHost = new URL(currentUrl).hostname
        const headers = {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: hop === 0 ? `${BASE}/` : `https://${mirror}/`,
          ...(cookieHeader && cookieHost === currentHost ? { Cookie: cookieHeader } : {}),
        }

        const res = await httpFetch(currentUrl, {
          headers,
          redirect: 'manual',
          timeout: PAGE_TIMEOUT_MS,
          signal,
        })

        if (cookieHost !== currentHost) {
          cookieHeader = ''
          cookieHost = currentHost
        }
        const setCookie = res.headers?.get?.('set-cookie')
        if (setCookie) {
          const pair = setCookie.split(';')[0].trim()
          if (pair) cookieHeader = cookieHeader ? `${cookieHeader}; ${pair}` : pair
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers?.get?.('location')
          await cancelBodyQuietly(res)
          if (!location) throw new Error(`VOE HTTP ${res.status} sin Location`)
          const next = isSafeHttpsUrl(location, currentUrl)
          if (!next) throw new Error('Redirección VOE no segura')
          const nextUrl = next.toString()
          if (visited.has(nextUrl)) throw new Error('Bucle de redirección VOE')
          if (next.hostname !== currentHost) {
            cookieHeader = ''
            cookieHost = next.hostname
          }
          visited.add(nextUrl)
          currentUrl = nextUrl
          continue
        }

        if (!res.ok) {
          await cancelBodyQuietly(res)
          throw new Error(`VOE HTTP ${res.status} (${currentHost})`)
        }

        const html = await res.text()
        const { directMp4, hlsUrl } = extractVoeMedia(html, currentUrl)
        if (directMp4 || hlsUrl) {
          return {
            direct: directMp4,
            hls: hlsUrl,
            referer: currentUrl,
            cookie: cookieHeader,
          }
        }

        const jsNext = extractVoeJsRedirect(html, currentUrl)
        if (jsNext && !visited.has(jsNext)) {
          const nextHost = new URL(jsNext).hostname
          if (nextHost !== currentHost) {
            cookieHeader = ''
            cookieHost = nextHost
          }
          visited.add(jsNext)
          currentUrl = jsNext
          continue
        }

        throw new Error(`VOE sin stream en ${currentHost}`)
      }
      throw new Error('Demasiadas redirecciones en VOE')
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastError = err
    }
  }

  throw lastError || new Error('No se pudo extraer video de VOE')
}

async function resolve1Fichier(url, signal) {
  if (!ONEFICHIER_API_KEY) throw new Error('1Fichier sin ONEFICHIER_API_KEY configurada')
  const res = await httpFetch('https://api.1fichier.com/v1/download/get_token.cgi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ONEFICHIER_API_KEY}`,
    },
    body: JSON.stringify({ url, no_ssl: 0 }),
    timeout: PAGE_TIMEOUT_MS,
    signal,
  })
  const json = await res.json().catch(() => null)
  if (json?.status !== 'OK' || !json?.url) {
    throw new Error(json?.message || `1Fichier HTTP ${res.status}`)
  }
  return { direct: json.url, name: json.filename || 'video.mp4', referer: 'https://1fichier.com/' }
}

async function fetchSeriesBySlug(slug, signal) {
  try {
    const html = await fetchText(`${BASE}/media/${slug}`, { signal })
    const info = parseSeriesInfo(html, slug)
    if (!info.episodes.length && !info.cover && !/<h1\b/i.test(html)) return null
    return info
  } catch (err) {
    if (err?.status === 404) return null
    throw err
  }
}

async function searchCatalog(query, signal) {
  const html = await fetchText(`${BASE}/catalogo?search=${encodeURIComponent(query)}`, { signal })
  return parseSearchResults(html)
}

async function searchHentaiLA(query, signal) {
  const isSingleToken = !/\s/.test(query)
  const triedSlugs = new Set()

  if (isSingleToken) {
    const directSlug = query.toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (directSlug.length > 1) {
      triedSlugs.add(directSlug)
      const directInfo = await fetchSeriesBySlug(directSlug, signal)
      if (directInfo) return { exact: directInfo, results: [{ slug: directInfo.slug, title: directInfo.title }] }
    }
  }

  const catalogResults = await searchCatalog(query, signal)
  if (catalogResults.length > 0) {
    const normalizedQuery = query.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const exactMatch = catalogResults.find((r) => r.slug === normalizedQuery)
    if (exactMatch) {
      const exactInfo = await fetchSeriesBySlug(exactMatch.slug, signal)
      if (exactInfo) return { exact: exactInfo, results: [exactMatch] }
    }
    return { exact: null, results: catalogResults }
  }

  for (const slug of buildSlugVariations(query)) {
    if (triedSlugs.has(slug)) continue
    triedSlugs.add(slug)
    const info = await fetchSeriesBySlug(slug, signal)
    if (info) return { exact: info, results: [{ slug: info.slug, title: info.title }] }
  }

  return { exact: null, results: [] }
}

async function fetchLatestReleases(signal) {
  const html = await fetchText(`${BASE}/`, { signal })
  return parseLatestReleases(html, 10)
}

function createIdleWatchdog(onIdle) {
  let lastActivity = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      clearInterval(timer)
      onIdle()
    }
  }, 5000)
  timer.unref?.()
  return {
    ping() { lastActivity = Date.now() },
    stop() { clearInterval(timer) },
  }
}

function createProgressLogger(label, initialTotal) {
  let totalBytes = Number(initialTotal) || 0
  let downloaded = 0
  let lastTtyRender = 0
  const startedAt = Date.now()

  return {
    setTotal(bytes) {
      if (bytes > 0) totalBytes = bytes
    },
    add(bytes) {
      downloaded += bytes
      const now = Date.now()

      if (process.stdout.isTTY && now - lastTtyRender >= 1000) {
        lastTtyRender = now
        const elapsed = Math.max((now - startedAt) / 1000, 0.001)
        const speed = downloaded / elapsed
        const pct = totalBytes > 0 ? `${Math.min(100, (downloaded / totalBytes) * 100).toFixed(1)}%` : '--%'
        process.stdout.write(`\r[${label}] ${pct} (${formatBytes(downloaded)}) | ${formatBytes(speed)}/s   `)
      }
    },
    reset() {
      downloaded = 0
    },
    finish(extra = '') {
      if (process.stdout.isTTY) process.stdout.write('\n')
      console.log(`[HDL][${label}] Completo (${formatBytes(downloaded)})${extra ? ` ${extra}` : ''}`)
    },
  }
}

function validateMediaResponse(res, label) {
  const ct = String(res.headers?.get?.('content-type') || '').toLowerCase()
  if (/text\/html|application\/json|javascript/i.test(ct)) {
    throw new Error(`${label} devolvió ${ct} en lugar de video`)
  }
}

async function downloadParallelRanges(directUrl, tempPath, totalBytes, headers, progress, watchdog, signal) {
  const chunkSize = Math.ceil(totalBytes / PARALLEL_THREADS)
  const ranges = []
  for (let i = 0; i < PARALLEL_THREADS; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize - 1, totalBytes - 1)
    if (start > end) break
    ranges.push({ start, end })
  }

  const fh = await fsp.open(tempPath, 'w')
  try {
    await Promise.all(ranges.map(async ({ start, end }) => {
      const res = await httpFetch(directUrl, {
        headers: { ...headers, Range: `bytes=${start}-${end}` },
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal,
      })
      if (res.status !== 206) {
        await cancelBodyQuietly(res)
        throw new Error(`HTTP ${res.status} (se esperaba 206)`)
      }
      validateMediaResponse(res, 'Range')
      const stream = toNodeReadable(res.body)
      let pos = start
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.destroy()
          throw createAbortError()
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await fh.write(buf, 0, buf.length, pos)
        pos += buf.length
        watchdog.ping()
        progress.add(buf.length)
      }
      const expectedLen = end - start + 1
      if (pos - start !== expectedLen) {
        throw new Error(`Bloque incompleto (${pos - start}/${expectedLen} bytes)`)
      }
    }))
  } finally {
    await fh.close()
  }
}

async function downloadDirect(directUrl, tempPath, { label, referer, cookie, signal, onStart } = {}) {
  const headers = {
    Accept: '*/*',
    ...(referer ? { Referer: referer } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  }

  let sizeBytes = 0
  let supportsRanges = false
  try {
    const headRes = await httpFetch(directUrl, {
      method: 'HEAD',
      headers,
      timeout: 12_000,
      signal,
    })
    await cancelBodyQuietly(headRes)
    if (headRes.ok) {
      validateMediaResponse(headRes, label)
      sizeBytes = Number(headRes.headers?.get?.('content-length') || 0) || 0
      supportsRanges = /bytes/i.test(headRes.headers?.get?.('accept-ranges') || '')
    }
  } catch (err) {
    if (signal?.aborted) throw createAbortError()
    if (/devolvió .* en lugar de video/i.test(err.message)) throw err
  }

  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`El archivo (${formatBytes(sizeBytes)}) supera el límite de 2 GB`)
  }

  await onStart?.()

  const attemptController = new AbortController()
  const attemptSignal = combineSignal(signal, DOWNLOAD_TIMEOUT_MS)
  const onParentAbort = () => attemptController.abort(createAbortError())
  attemptSignal.addEventListener('abort', onParentAbort, { once: true })

  const watchdog = createIdleWatchdog(() => attemptController.abort(new Error(`${label} sin datos por ${IDLE_TIMEOUT_MS / 1000}s`)))
  const progress = createProgressLogger(label, sizeBytes)

  try {
    if (supportsRanges && sizeBytes >= MIN_PARALLEL_BYTES) {
      try {
        await downloadParallelRanges(directUrl, tempPath, sizeBytes, headers, progress, watchdog, attemptController.signal)
        progress.finish(`(${PARALLEL_THREADS} hilos)`)
        return
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        await fsp.rm(tempPath, { force: true }).catch(() => {})
        console.warn(`[HDL][${label}] Descarga paralela falló (${err.message}), probando modo secuencial...`)
        progress.reset()
      }
    }

    const res = await httpFetch(directUrl, {
      headers,
      timeout: DOWNLOAD_TIMEOUT_MS,
      signal: attemptController.signal,
    })
    if (!res.ok) {
      await cancelBodyQuietly(res)
      throw new Error(`HTTP ${res.status}`)
    }
    validateMediaResponse(res, label)

    const contentLength = Number(res.headers?.get?.('content-length') || 0) || 0
    if (contentLength > MAX_FILE_BYTES) {
      await cancelBodyQuietly(res)
      throw new Error(`El archivo (${formatBytes(contentLength)}) supera el límite de 2 GB`)
    }
    if (contentLength > 0) progress.setTotal(contentLength)

    let written = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length
        if (written > MAX_FILE_BYTES) return cb(new Error('El archivo superó el límite de 2 GB'))
        watchdog.ping()
        progress.add(chunk.length)
        cb(null, chunk)
      },
    })

    await pipeline(toNodeReadable(res.body), counter, fs.createWriteStream(tempPath), { signal: attemptController.signal })
    progress.finish()
  } finally {
    watchdog.stop()
    attemptSignal.removeEventListener('abort', onParentAbort)
  }
}

async function downloadHls(hlsUrl, tempPath, { referer, cookie, signal, onStart } = {}) {
  if (signal?.aborted) throw createAbortError()
  await onStart?.()

  const headerLines = [
    referer ? `Referer: ${referer}` : '',
    cookie ? `Cookie: ${cookie}` : '',
  ].filter(Boolean).join('\r\n')

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
    '-user_agent', FALLBACK_UA,
    ...(headerLines ? ['-headers', `${headerLines}\r\n`] : []),
    '-rw_timeout', '20000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '403,408,429,500,502,503,504',
    '-reconnect_delay_max', '5',
    '-i', hlsUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-f', 'mp4',
    tempPath,
  ]

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }

    const onAbort = () => {
      child.kill('SIGKILL')
      finish(createAbortError())
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, DOWNLOAD_TIMEOUT_MS)
    timer.unref?.()

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    child.once('error', (err) => finish(err))
    child.once('close', (code) => {
      if (timedOut) return finish(new Error('FFmpeg HLS superó el tiempo límite'))
      if (code === 0) return finish(null)
      finish(new Error(`FFmpeg HLS falló (código ${code})${stderr ? `: ${stderr.trim().slice(-240)}` : ''}`))
    })
  })
}

async function downloadMega(url, tempPath, { signal, onStart } = {}) {
  const file = MegaFile.fromURL(normalizeMegaUrl(url))
  await file.loadAttributes()
  if (signal?.aborted) throw createAbortError()

  const sizeBytes = Number(file.size) || 0
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`El archivo en MEGA (${formatBytes(sizeBytes)}) supera el límite de 2 GB`)
  }

  await onStart?.()

  const fileStream = file.download({ maxConnections: MEGA_MAX_CONNECTIONS })
  const progress = createProgressLogger('MEGA', sizeBytes)
  const watchdog = createIdleWatchdog(() => fileStream.destroy(new Error('MEGA sin respuesta')))
  const onAbort = () => fileStream.destroy(createAbortError())
  signal?.addEventListener('abort', onAbort, { once: true })

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      watchdog.ping()
      progress.add(chunk.length)
      cb(null, chunk)
    },
  })

  try {
    await pipeline(fileStream, counter, fs.createWriteStream(tempPath))
    progress.finish()
  } finally {
    watchdog.stop()
    signal?.removeEventListener('abort', onAbort)
  }
}

function createReactionController(conn, m) {
  let lastEmoji = null
  return async function react(emoji) {
    if (!conn?.sendMessage || !m?.key) return
    const next = String(emoji || '')
    if (next === lastEmoji) return
    lastEmoji = next
    try {
      await conn.sendMessage(m.chat, { react: { text: next, key: m.key } })
    } catch { }
  }
}

async function collectUserIdentities(m, conn, chat, participants = []) {
  const ids = new Set()
  const rawList = [
    m?.sender,
    m?.key?.participant,
    m?.key?.participantAlt,
    m?.participant,
  ]
  if (m?.fromMe) {
    rawList.push(conn?.user?.jid, conn?.user?.id, conn?.user?.lid)
  } else if (chat && !chat.endsWith('@g.us')) {
    rawList.push(chat)
  }

  const addJid = (value) => {
    const cleaned = cleanJid(value)
    if (!cleaned || typeof cleaned !== 'string') return
    ids.add(cleaned)
    const userPart = cleaned.split('@')[0]
    if (cleaned.endsWith('@s.whatsapp.net') || cleaned.endsWith('@c.us')) {
      const digits = userPart.replace(/\D/g, '')
      if (digits) {
        ids.add(`${digits}@s.whatsapp.net`)
        ids.add(`pn:${digits}`)
      }
    } else if (cleaned.endsWith('@lid') && userPart) {
      ids.add(`lid:${userPart}`)
    }
    const phone = resolveJidToPhone(cleaned, conn)
    if (phone) {
      ids.add(`${phone}@s.whatsapp.net`)
      ids.add(`pn:${phone}`)
    }
  }

  for (const raw of rawList) addJid(raw)

  if (Array.isArray(participants) && participants.length && ids.size) {
    const bareUsers = new Set([...ids].map((v) => v.split('@')[0].replace(/^(?:pn|lid):/, '')))
    for (const p of participants) {
      const candidates = [
        p?.id,
        p?.jid,
        p?.lid,
        p?.phoneNumber ? (String(p.phoneNumber).includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`) : null,
      ].map(cleanJid).filter(Boolean)

      const matches = candidates.some((c) => ids.has(c) || bareUsers.has(c.split('@')[0]))
      if (matches) {
        for (const c of candidates) addJid(c)
      }
    }
  }

  const snapshot = [...ids].filter((v) => v.includes('@'))
  for (const jid of snapshot) {
    try {
      const resolved = await resolveAnyJid(jid, conn, chat)
      if (resolved) addJid(resolved)
      if (resolved?.endsWith('@s.whatsapp.net')) {
        const lid = await getLidForJidAsync(resolved, conn)
        if (lid) addJid(lid)
      }
    } catch { }
  }

  return ids
}

function hasIdentityOverlap(ownerIds, actorIds) {
  if (!ownerIds?.size || !actorIds?.size) return false
  for (const id of actorIds) {
    if (ownerIds.has(id)) return true
  }
  return false
}

function actorWarningKey(actorIds, m) {
  for (const id of actorIds) {
    if (id.startsWith('pn:')) return id
  }
  for (const id of actorIds) {
    if (id.startsWith('lid:')) return id
  }
  return cleanJid(m?.sender) || 'unknown'
}

function clearSessionTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
}

async function deleteSessionMessage(session) {
  const key = session?.msgKey
  if (!key) return
  session.msgKey = null
  const clients = [session.conn, global.conn].filter(
    (c, i, arr) => typeof c?.sendMessage === 'function' && arr.indexOf(c) === i,
  )
  for (const client of clients) {
    try {
      await client.sendMessage(session.chat, { delete: key })
      return
    } catch { }
  }
}

function markSessionExpired(sessionId, now = Date.now(), { deleteMessage = false } = {}) {
  const session = sessions.get(sessionId)
  if (session) {
    clearSessionTimer(session)
    sessions.delete(sessionId)
    if (deleteMessage) {
      deleteSessionMessage(session).catch(() => {})
    }
  }
  if (!expiredSessions.has(sessionId)) {
    expiredSessions.set(sessionId, { expiry: now + EXPIRED_MEMORY_MS, warned: new Set() })
  }
}

function scheduleSessionExpiry(session) {
  clearSessionTimer(session)
  session.expiry = Date.now() + SESSION_TTL_MS
  const timer = setTimeout(() => {
    if (sessions.get(session.id) !== session) return
    markSessionExpired(session.id, Date.now(), { deleteMessage: true })
  }, SESSION_TTL_MS)
  timer.unref?.()
  session.timer = timer
}

function pruneExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.expiry <= now) markSessionExpired(id, now, { deleteMessage: true })
  }
  for (const [id, info] of expiredSessions) {
    if (info.expiry <= now) expiredSessions.delete(id)
  }
}

function makeButtonToken(sessionId, index) {
  return `${BUTTON_TOKEN_PREFIX}${sessionId}:${index}`
}

function parseButtonToken(raw) {
  const value = String(raw || '').trim()
  if (!value.startsWith(BUTTON_TOKEN_PREFIX)) return null
  const body = value.slice(BUTTON_TOKEN_PREFIX.length)
  const sep = body.lastIndexOf(':')
  if (sep <= 0) return null
  const sessionId = body.slice(0, sep)
  const index = Number(body.slice(sep + 1))
  if (!sessionId || !Number.isInteger(index) || index < 0) return null
  return { sessionId, index }
}

async function sendInteractiveList(conn, chat, m, {
  title,
  description,
  button,
  section,
  rows,
  coverUrl = null,
  quickReplies = false,
  participants = [],
  existingKey = null,
}) {
  pruneExpiredSessions()
  const ownerIds = await collectUserIdentities(m, conn, chat, participants)
  if (sessions.size >= 200) {
    const oldestId = sessions.keys().next().value
    if (oldestId) markSessionExpired(oldestId, Date.now(), { deleteMessage: true })
  }

  const sessionId = randomBytes(6).toString('hex')
  const session = {
    id: sessionId,
    chat,
    conn,
    ownerIds,
    rows,
    msgId: null,
    msgKey: null,
    listKey: null,
    timer: null,
    expiry: Date.now() + SESSION_TTL_MS,
    warned: new Set(),
  }
  sessions.set(sessionId, session)

  let device = 'android'
  try { device = getDevice(m?.key?.id) } catch { }
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile) {
    try {
      let imgBuf = null
      if (coverUrl) {
        try { imgBuf = await fetchBuffer(coverUrl) } catch { }
      }

      const formatLabel = (r) => {
        const base = r.description ? `${r.title} · ${r.description}` : r.title
        return base.length > 58 ? `${base.slice(0, 55)}...` : base
      }

      const inlineQuick = quickReplies && rows.length <= 3
      const nativeFlow = rows.map((r, index) => ({
        text: inlineQuick ? `▶️ ${r.title}` : formatLabel(r),
        id: makeButtonToken(sessionId, index),
        icon: 'default',
      }))

      const sheetOptions = !inlineQuick && rows.length > 1
        ? { optionText: button, optionTitle: section }
        : {}

      const footer = `${global.botName || global.wm || 'HentaiLA'} · Expira en 3 min`
      const bodyText = description || title
      const payload = imgBuf
        ? { image: imgBuf, title, caption: bodyText, footer, ...sheetOptions, nativeFlow }
        : { text: `*${title}*\n\n${bodyText}`, footer, ...sheetOptions, nativeFlow }

      const sent = await conn.sendMessage(chat, payload, { quoted: m })
      session.msgKey = sent?.key || null
      session.msgId = sent?.key?.id || null
      scheduleSessionExpiry(session)
      return sent
    } catch (err) {
      console.error('[HDL] Error en botones NativeFlow:', err.message)
    }
  }

  let txt = `✨ *${title}*\n_${description}_\n\n`
  rows.forEach((r, i) => {
    txt += `*${i + 1}.* ${r.title}`
    if (r.description) txt += ` _(${r.description})_`
    txt += '\n'
  })
  txt += '\n_Responde con el número para elegir (expira en 3 min)._'

  let listKey = null
  if (existingKey) {
    try {
      await conn.sendMessage(chat, { text: txt, edit: existingKey })
      listKey = existingKey
    } catch { }
  }
  if (!listKey) {
    const sent = await conn.sendMessage(chat, { text: txt }, { quoted: m })
    listKey = sent?.key || null
  }
  session.listKey = listKey
  session.msgKey = listKey
  session.msgId = listKey?.id || null
  scheduleSessionExpiry(session)
  return listKey
}

async function sendLatestCarousel(conn, chat, m, latest, usedPrefix, participants = [], existingKey = null) {
  let device = 'android'
  try { device = getDevice(m?.key?.id) } catch { }
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile && typeof conn.waUploadToServer === 'function' && typeof conn.relayMessage === 'function') {
    try {
      const items = latest.slice(0, 10)
      const uploaded = await Promise.allSettled(
        items.map(async (item) => {
          if (!item.thumb) throw new Error('sin thumb')
          const buf = await fetchBuffer(item.thumb)
          if (!buf?.length) throw new Error('imagen vacía')
          return prepareWAMessageMedia({ image: buf }, { upload: conn.waUploadToServer })
        }),
      )

      pruneExpiredSessions()
      const ownerIds = await collectUserIdentities(m, conn, chat, participants)
      if (sessions.size >= 200) {
        const oldestId = sessions.keys().next().value
        if (oldestId) markSessionExpired(oldestId, Date.now(), { deleteMessage: true })
      }

      const sessionId = randomBytes(6).toString('hex')
      const rows = []
      const cards = []

      items.forEach((item, i) => {
        if (uploaded[i].status !== 'fulfilled' || !uploaded[i].value?.imageMessage) return
        const dlIdx = rows.push({ rowId: `${usedPrefix}hdl ${item.slug} ${item.episode}`, title: item.title }) - 1
        const epsIdx = rows.push({ rowId: `${usedPrefix}hdl ${item.slug}`, title: item.title }) - 1
        cards.push({
          header: {
            title: '',
            subtitle: '',
            hasMediaAttachment: true,
            imageMessage: uploaded[i].value.imageMessage,
          },
          body: { text: `🎬 *${item.title}*\n📺 Episodio ${item.episode}` },
          footer: { text: `HentaiLA · Ep. ${item.episode}` },
          nativeFlowMessage: {
            buttons: [
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: `⬇️ Descargar Ep. ${item.episode}`,
                  id: makeButtonToken(sessionId, dlIdx),
                }),
              },
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: '📺 Ver episodios',
                  id: makeButtonToken(sessionId, epsIdx),
                }),
              },
            ],
          },
        })
      })

      if (cards.length >= 2) {
        const session = {
          id: sessionId,
          chat,
          conn,
          ownerIds,
          rows,
          msgId: null,
          msgKey: null,
          listKey: null,
          timer: null,
          expiry: Date.now() + SESSION_TTL_MS,
          warned: new Set(),
        }
        sessions.set(sessionId, session)

        const footer = `${global.botName || global.wm || 'HentaiLA'} · Expira en 3 min`
        const userJid = conn.authState?.creds?.me?.id || conn.user?.jid || conn.user?.id
        const userJidLid = conn.authState?.creds?.me?.lid || conn.user?.lid
        const hasQuoted = Boolean(m?.key && m?.message && Object.keys(m.message).length > 0)

        const fullMsg = generateWAMessageFromContent(
          chat,
          {
            messageContextInfo: { messageSecret: randomBytes(32) },
            interactiveMessage: {
              header: { hasMediaAttachment: false },
              body: { text: '🔞 *Últimos lanzamientos en HentaiLA*\n_Desliza las tarjetas para elegir:_' },
              footer: { text: footer },
              carouselMessage: {
                cards,
                messageVersion: 1,
                carouselCardType: CarouselCardType.HSCROLL_CARDS,
              },
            },
          },
          {
            userJid,
            userJidLid,
            ...(hasQuoted ? { quoted: m } : {}),
          },
        )

        const bizNode = getBizBinaryNode(fullMsg.message)
        try {
          await conn.relayMessage(chat, fullMsg.message, {
            messageId: fullMsg.key.id,
            additionalNodes: [bizNode],
          })
        } catch (relayErr) {
          clearSessionTimer(session)
          sessions.delete(sessionId)
          throw relayErr
        }

        session.msgKey = fullMsg?.key || null
        session.msgId = fullMsg?.key?.id || null
        scheduleSessionExpiry(session)
        return fullMsg
      }
    } catch (err) {
      console.error('[HDL] Error en carrusel /hlatest:', err.message)
    }
  }

  const fallbackRows = latest.map((item) => ({
    rowId: `${usedPrefix}hdl ${item.slug} ${item.episode}`,
    title: item.title,
    description: `Ep. ${item.episode}`,
  }))
  return sendInteractiveList(conn, chat, m, {
    title: '🔞 Últimos lanzamientos en HentaiLA',
    description: 'Elige un título para descargar:',
    button: '📋 Ver lanzamientos',
    section: 'Recién subidos',
    rows: fallbackRows,
    participants,
    existingKey,
  })
}

function buildServerQueue(links) {
  return [
    ...links.mediafire.map((url) => ({ tipo: 'mediafire', label: 'MediaFire', url })),
    ...links.yourupload.map((url) => ({ tipo: 'yourupload', label: 'YourUpload', url })),
    ...links.mp4upload.map((url) => ({ tipo: 'mp4upload', label: 'MP4Upload', url })),
    ...links.voe.map((url) => ({ tipo: 'voe', label: 'VOE', url })),
    ...links.mega.map((url) => ({ tipo: 'mega', label: 'MEGA', url })),
    ...links.fireload.map((url) => ({ tipo: 'fireload', label: 'FireLoad', url })),
    ...(ONEFICHIER_API_KEY ? links.fichier.map((url) => ({ tipo: '1fichier', label: '1Fichier', url })) : []),
    ...links.otros.map((url) => ({ tipo: 'directo', label: 'Directo', url })),
  ]
}

async function downloadAndSend(m, conn, mediaUrl, info, episode, react, signal, { batchMode = false } = {}) {
  const replyError = async (text) => {
    if (batchMode) {
      console.warn(`[HDL] ${text}`)
      return false
    }
    await react('❌')
    await conn.sendMessage(m.chat, { text }, { quoted: m })
    return false
  }

  let html
  try {
    html = await fetchText(mediaUrl, { signal })
  } catch (err) {
    if (err?.status === 404) {
      const avail = info.episodes.length ? ` (disponibles: 1–${info.episodes.at(-1)})` : ''
      return replyError(`❌ El episodio *${episode}* de *${info.title}* no existe${avail}.`)
    }
    throw err
  }

  const links = parseEpisodeLinks(html)
  const servers = buildServerQueue(links)
  if (!servers.length) {
    return replyError(`❌ No se encontraron servidores de descarga.\n🔗 ${mediaUrl}`)
  }

  let tempPath = null
  let success = false

  for (const srv of servers) {
    if (signal?.aborted) throw createAbortError()
    const baseName = sanitizeFilename(`${info.title} - Ep ${episode}.mp4`)
    tempPath = path.join(os.tmpdir(), `hdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`)

    try {
      await react('⏳')
      const onStart = () => react('📥')

      if (srv.tipo === 'mega') {
        await downloadMega(srv.url, tempPath, { signal, onStart })
      } else if (srv.tipo === 'directo') {
        await downloadDirect(srv.url, tempPath, { label: srv.label, signal, onStart })
      } else if (srv.tipo === 'voe') {
        const resolved = await resolveVoe(srv.url, signal)
        let downloaded = false
        if (resolved.direct) {
          try {
            await downloadDirect(resolved.direct, tempPath, {
              label: srv.label,
              referer: resolved.referer,
              cookie: resolved.cookie,
              signal,
              onStart,
            })
            downloaded = true
          } catch (directErr) {
            await fsp.rm(tempPath, { force: true }).catch(() => {})
            if (signal?.aborted) throw createAbortError()
            if (!resolved.hls) throw directErr
            console.warn(`[HDL][VOE] MP4 directo falló (${directErr.message}), probando HLS...`)
          }
        }
        if (!downloaded) {
          if (!resolved.hls) throw new Error('VOE sin stream descargable')
          await downloadHls(resolved.hls, tempPath, {
            referer: resolved.referer,
            cookie: resolved.cookie,
            signal,
            onStart,
          })
        }
      } else {
        const resolver = {
          mediafire: resolveMediafire,
          fireload: resolveFireload,
          mp4upload: resolveMp4Upload,
          yourupload: resolveYourUpload,
          '1fichier': resolve1Fichier,
        }[srv.tipo]
        const resolved = await resolver(srv.url, signal)
        await downloadDirect(resolved.direct, tempPath, {
          label: srv.label,
          referer: resolved.referer,
          signal,
          onStart,
        })
      }

      const stats = await fsp.stat(tempPath)
      if (stats.size < MIN_VALID_BYTES) {
        throw new Error(`Archivo incompleto (${formatBytes(stats.size)})`)
      }

      success = true
      break
    } catch (err) {
      await fsp.rm(tempPath, { force: true }).catch(() => {})
      tempPath = null
      if (signal?.aborted) throw createAbortError()
      console.warn(`[HDL][${srv.label}] Falló: ${err.message}`)
    }
  }

  if (!success || !tempPath) {
    return replyError(`❌ Todos los servidores fallaron para el ep. ${episode} de *${info.title}*.\n🔗 ${mediaUrl}`)
  }

  try {
    if (signal?.aborted) throw createAbortError()
    await react('📤')

    const finalName = buildDocumentFilename(info.title, info.slug, episode)
    let jpegThumbnail = null
    try {
      jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(tempPath)
    } catch { }
    if (!jpegThumbnail && info.cover) {
      try {
        jpegThumbnail = await fetchBuffer(info.cover, signal)
      } catch { }
    }

    await conn.sendMessage(m.chat, {
      document: { url: tempPath },
      fileName: finalName,
      mimetype: 'video/mp4',
      ...(jpegThumbnail ? { jpegThumbnail } : {}),
    }, { quoted: m })

    if (!batchMode) await react('✅')
    return true
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function runEpisodeFlow(m, conn, info, episode, react) {
  const userKey = downloadKey(m)
  if (hasDownload(userKey, SERVICE)) {
    await react('⚠️')
    return conn.sendMessage(
      m.chat,
      { text: '⚠️ Ya tienes una descarga de HentaiLA en curso. Usa *.cancelar* para detenerla.' },
      { quoted: m },
    )
  }

  const controller = new AbortController()
  const release = startDownload(userKey, SERVICE, controller, {
    label: `HentaiLA · ${info.title} Ep. ${episode}`,
  })

  try {
    const epUrl = `${BASE}/media/${info.slug}/${episode}`
    await downloadAndSend(m, conn, epUrl, info, episode, react, controller.signal)
  } finally {
    release()
  }
}

async function runAllEpisodesFlow(m, conn, info, react) {
  const userKey = downloadKey(m)
  if (hasDownload(userKey, SERVICE)) {
    await react('⚠️')
    return conn.sendMessage(
      m.chat,
      { text: '⚠️ Ya tienes una descarga de HentaiLA en curso. Usa *.cancelar* para detenerla.' },
      { quoted: m },
    )
  }

  const episodes = [...info.episodes]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  if (!episodes.length) {
    await react('❌')
    return conn.sendMessage(
      m.chat,
      { text: `❌ No se encontraron episodios disponibles para *${info.title}*.` },
      { quoted: m },
    )
  }

  const controller = new AbortController()
  const release = startDownload(userKey, SERVICE, controller, {
    label: `HentaiLA · ${info.title} (${episodes.length} eps)`,
  })

  try {
    if (info.cover) {
      try {
        const coverBuf = await fetchBuffer(info.cover, controller.signal)
        if (coverBuf?.length) {
          await conn.sendMessage(
            m.chat,
            { image: coverBuf, mimetype: 'image/jpeg' },
            { quoted: m },
          )
          await sleep(800, controller.signal)
        }
      } catch (err) {
        if (controller.signal.aborted) throw createAbortError()
        console.warn(`[HDL] No se pudo enviar portada de ${info.title}: ${err.message}`)
      }
    }

    let sentCount = 0
    const failed = []

    for (let i = 0; i < episodes.length; i++) {
      if (controller.signal.aborted) throw createAbortError()
      const ep = episodes[i]
      const epUrl = `${BASE}/media/${info.slug}/${ep}`
      try {
        const ok = await downloadAndSend(m, conn, epUrl, info, ep, react, controller.signal, { batchMode: true })
        if (ok) {
          sentCount++
          if (i < episodes.length - 1) await sleep(800, controller.signal)
        } else {
          failed.push(ep)
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) throw createAbortError()
        console.warn(`[HDL] Ep. ${ep} de ${info.title} falló: ${err.message}`)
        failed.push(ep)
      }
    }

    if (sentCount === 0) {
      await react('❌')
      await conn.sendMessage(
        m.chat,
        { text: `❌ No se pudo descargar ningún episodio de *${info.title}*.` },
        { quoted: m },
      )
      return
    }

    if (failed.length > 0) {
      await react('⚠️')
      await conn.sendMessage(
        m.chat,
        { text: `⚠️ *${info.title}*: enviados ${sentCount}/${episodes.length}. Fallaron los episodios: ${failed.join(', ')}.` },
        { quoted: m },
      )
      return
    }

    await react('✅')
  } finally {
    release()
  }
}

const handler = async (m, { conn, text, usedPrefix, command, participants = [], existingKey = null, isOwner = false, isROwner = false }) => {
  const isLatest = /hlatest|hentailatest/i.test(command)

  if (!text && !isLatest) {
    return m.reply(
      `🔞 *Uso:* ${usedPrefix}${command} <nombre|url> [episodio|all]\n\n` +
      `*Ejemplos:*\n` +
      `• ${usedPrefix}${command} overflow 1\n` +
      `• ${usedPrefix}${command} nikuen all _(solo owner)_\n` +
      `• ${usedPrefix}${command} ${BASE}/media/overflow/1\n\n` +
      `💡 Usa \`${usedPrefix}hlatest\` para ver lo más nuevo.`,
    )
  }

  const parsed = isLatest ? null : parseHentaiInput(text)
  const ownerAuthorized = Boolean(isOwner || isROwner || m?.fromMe)
  if (parsed?.all && !ownerAuthorized) {
    return conn.sendMessage(
      m.chat,
      { text: '🔒 La descarga completa (*all*) es de uso exclusivo del owner.' },
      { quoted: m },
    )
  }

  const react = createReactionController(conn, m)
  const replyError = async (msg) => {
    await react('❌')
    await conn.sendMessage(m.chat, { text: msg }, { quoted: m })
  }

  await react('⏳')

  try {
    if (isLatest) {
      const latest = await fetchLatestReleases()
      if (!latest.length) {
        return replyError('❌ No se pudieron obtener los últimos lanzamientos.')
      }
      await sendLatestCarousel(conn, m.chat, m, latest, usedPrefix, participants, existingKey)
      await react('✅')
      return
    }

    const { slug, episode, all, query } = parsed
    let info = null

    if (slug) {
      info = await fetchSeriesBySlug(slug)
      if (!info) return replyError(`❌ No se encontró la serie *${slug}* en HentaiLA.`)
    } else {
      const { exact, results } = await searchHentaiLA(query)

      if (exact) {
        info = exact
      } else if (!results.length) {
        return replyError(
          `❌ No se encontraron resultados para *"${query}"*.\n\n` +
          `💡 Prueba con el título en inglés o romaji.\n` +
          `Ej: \`${usedPrefix}hdl overflow 1\``,
        )
      } else if (results.length === 1) {
        info = await fetchSeriesBySlug(results[0].slug)
        if (!info) return replyError(`❌ No se pudo cargar la info de *${results[0].title}*.`)
      } else {
        const top = results.slice(0, 10)
        const rows = top.map((r) => ({
          rowId: all
            ? `${usedPrefix}hdl ${r.slug} all`
            : episode
              ? `${usedPrefix}hdl ${r.slug} ${episode}`
              : `${usedPrefix}hdl ${r.slug}`,
          title: r.title,
        }))
        await sendInteractiveList(conn, m.chat, m, {
          title: `🔞 Resultados para: "${query}"`,
          description: `Se encontraron ${top.length} títulos. Elige uno:`,
          button: '📋 Ver opciones',
          section: 'Títulos disponibles',
          rows,
          participants,
          existingKey,
        })
        await react('✅')
        return
      }
    }

    if (all) {
      await runAllEpisodesFlow(m, conn, info, react)
      return
    }

    if (!episode) {
      const epList = info.episodes.length > 0 ? info.episodes.slice(0, 25) : [1, 2, 3]
      const rows = epList.map((ep) => ({
        rowId: `${usedPrefix}hdl ${info.slug} ${ep}`,
        title: `Episodio ${ep}`,
      }))
      const epsSummary = info.episodes.length > 0
        ? `${info.episodes.length} (${info.episodes.length === 1 ? 'Ep. 1' : `Eps 1–${info.episodes.at(-1)}`})`
        : '?'
      const genresSummary = info.generos.length > 0 ? info.generos.slice(0, 4).join(' · ') : 'N/A'

      await sendInteractiveList(conn, m.chat, m, {
        title: `🎬 ${info.title}`,
        description: `${info.desc}\n\n🎬 *Eps:* ${epsSummary} · 🏷️ ${genresSummary}`,
        button: '📺 Elegir episodio',
        section: 'Episodios disponibles',
        rows,
        coverUrl: info.cover,
        quickReplies: true,
        participants,
        existingKey,
      })
      await react('✅')
      return
    }

    await runEpisodeFlow(m, conn, info, episode, react)
  } catch (err) {
    if (isAbortError(err)) {
      await react('⏹️')
      await conn.sendMessage(m.chat, { text: '⏹️ *Descarga cancelada.*' }, { quoted: m })
      return
    }
    console.error('[HDL]', err.message)
    await replyError(`❌ *Error:* ${err.message}`)
  }
}

function extractInteractiveId(message, fallbackText = '') {
  const nf = message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (nf?.paramsJson) {
    try { return JSON.parse(nf.paramsJson)?.id ?? null } catch { return null }
  }
  const direct = (
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    null
  )
  if (direct) return direct
  const raw = String(fallbackText || '').trim()
  return raw.startsWith(BUTTON_TOKEN_PREFIX) ? raw : null
}

async function warnOnce(warnedSet, actorKey, conn, m, text) {
  if (warnedSet.has(actorKey)) return
  warnedSet.add(actorKey)
  try {
    await conn.sendMessage(m.chat, { text }, { quoted: m })
  } catch { }
}

async function dispatchSelection(conn, m, rowId, { participants = [], existingKey = null, isOwner = false, isROwner = false } = {}) {
  const usedPrefix = rowId[0]
  const [command, ...argParts] = rowId.slice(1).trim().split(/\s+/)
  const text = argParts.join(' ')
  try {
    await handler.call(conn, m, { conn, text, usedPrefix, command, participants, existingKey, isOwner, isROwner })
  } catch (err) {
    console.error('[HDL before] Error ejecutando selección:', err.message)
  }
}

handler.before = async function (m, { conn, participants = [], isOwner = false, isROwner = false }) {
  pruneExpiredSessions()

  const selectedId = extractInteractiveId(m.message, m.text)
  const token = parseButtonToken(selectedId)
  if (token) {
    const actorIds = await collectUserIdentities(m, conn, m.chat, participants)
    const actorKey = actorWarningKey(actorIds, m)
    const session = sessions.get(token.sessionId)

    if (!session || session.expiry <= Date.now()) {
      markSessionExpired(token.sessionId, Date.now(), { deleteMessage: true })
      const expired = expiredSessions.get(token.sessionId)
      await warnOnce(
        expired.warned,
        actorKey,
        conn,
        m,
        '⏱️ Estos botones expiraron (duran 3 minutos). Vuelve a ejecutar el comando.',
      )
      return true
    }

    if (session.chat !== m.chat) return true

    if (!hasIdentityOverlap(session.ownerIds, actorIds)) {
      await warnOnce(
        session.warned,
        actorKey,
        conn,
        m,
        '🔒 Solo quien ejecutó el comando puede usar este botón.',
      )
      return true
    }

    const chosen = session.rows[token.index]
    if (!chosen) return true

    await dispatchSelection(conn, m, chosen.rowId, {
      participants,
      existingKey: null,
      isOwner,
      isROwner,
    })
    return true
  }

  if (!sessions.size) return false

  const rawText = String(m.text || '').trim()
  if (!/^\d+$/.test(rawText)) return false

  const chatSessions = [...sessions.values()].filter((s) => s.chat === m.chat && s.expiry > Date.now())
  if (!chatSessions.length) return false

  const actorIds = await collectUserIdentities(m, conn, m.chat, participants)
  const actorKey = actorWarningKey(actorIds, m)
  const quotedId = m.quoted?.key?.id || m.quoted?.id || null

  let session = null
  if (quotedId) {
    const quotedSession = chatSessions.find((s) => s.msgId && s.msgId === quotedId)
    if (quotedSession) {
      if (!hasIdentityOverlap(quotedSession.ownerIds, actorIds)) {
        await warnOnce(
          quotedSession.warned,
          actorKey,
          conn,
          m,
          '🔒 Solo quien ejecutó el comando puede usar esta lista.',
        )
        return true
      }
      session = quotedSession
    }
  }

  if (!session) {
    const owned = chatSessions.filter((s) => hasIdentityOverlap(s.ownerIds, actorIds))
    session = owned.at(-1) || null
  }
  if (!session) return false
  if (quotedId && session.msgId && quotedId !== session.msgId) return false

  const index = Number(rawText) - 1
  if (index < 0 || index >= session.rows.length) {
    if (quotedId && quotedId === session.msgId) {
      await conn.sendMessage(m.chat, { text: `❌ Número inválido. Elige entre 1 y ${session.rows.length}.` }, { quoted: m })
      return true
    }
    return false
  }

  const chosen = session.rows[index]
  const isEpisodeChoice = /\s+(?:\d+|all)\s*$/i.test(chosen.rowId)
  const reuseKey = !isEpisodeChoice ? session.listKey : null
  if (reuseKey) {
    clearSessionTimer(session)
    session.msgKey = null
    sessions.delete(session.id)
  }

  await dispatchSelection(conn, m, chosen.rowId, {
    participants,
    existingKey: reuseKey,
    isOwner,
    isROwner,
  })
  return true
}

handler.help = ['hdl <nombre|url> [episodio|all]', 'hlatest']
handler.tags = ['nsfw']
handler.command = /^(hdl|hentaidl|hlatest|hentailatest)$/i

export default handler
