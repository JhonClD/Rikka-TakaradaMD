import { getDevice } from 'baileys'
import * as cheerio from 'cheerio'
import { File as MegaFile } from 'megajs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { downloadKey, hasDownload, startDownload } from '../src/funcion/download-registry.js'

const BASE = 'https://hentaila.com'
const SERVICE = 'hentaila'

const WREQ_BROWSER = 'chrome_142'
const IMPIT_BROWSER = 'chrome142'
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const BASE_HEADERS = { 'Accept-Language': 'es-419,es;q=0.9,en-US;q=0.8,en;q=0.7' }

const PROXY_URL = String(process.env.HDL_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
const ONEFICHIER_API_KEY = String(process.env.ONEFICHIER_API_KEY || '').trim()

const PAGE_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const IDLE_TIMEOUT_MS = 60_000
const REQUEST_PACING_MS = 350
const STATUS_EDIT_INTERVAL_MS = 2500

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 150
const SESSION_TTL_MS = 5 * 60 * 1000

const MIN_VALID_BYTES = 16 * 1024
const MAX_FILE_BYTES = 2 * 1024 ** 3
const MEGA_MAX_CONNECTIONS = 10
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const COMMAND_PREFIX_RE = /^[^\s]?(?:hdl|hentaidl|hlatest|hentailatest)\b/i

let wreqSessionPromise = null
let wreqUnavailable = false
let impitClientPromise = null
let impitUnavailable = false

const htmlCache = new Map()
const sessions = new Map()

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
  const urlMatch = trimmed.match(/https?:\/\/(?:www\.)?hentaila\.com\/media\/([^/?#\s]+)(?:\/(\d+))?/i)
  if (urlMatch) {
    const slug = decodeURIComponent(urlMatch[1]).toLowerCase()
    const ep = urlMatch[2] || null
    return { slug, episode: ep, query: slug.replace(/-/g, ' ') }
  }

  let query = trimmed
  let episode = null
  const epMatch = query.match(/(?:\s+(?:ep(?:isodio)?|cap(?:[ií]tulo)?|#)\s*|\s+)(\d+)\s*$/i)
  if (epMatch) {
    const candidateQuery = query.slice(0, epMatch.index).trim()
    if (candidateQuery) {
      episode = epMatch[1]
      query = candidateQuery
    }
  }

  const cleanQuery = query.replace(/[?!¡¿]/g, '').replace(/\s+/g, ' ').trim()
  return { slug: null, episode, query: cleanQuery }
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

  const add = (slug, episode, title) => {
    const cleanSlug = String(slug || '').trim()
    const epNum = Number(episode)
    if (!cleanSlug || !Number.isFinite(epNum) || epNum <= 0 || seen.has(cleanSlug)) return
    seen.add(cleanSlug)
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim() || cleanSlug.replace(/-/g, ' ')
    results.push({ slug: cleanSlug, title: cleanTitle, episode: epNum })
  }

  $('article').each((_, el) => {
    const $el = $(el)
    const href = $el.find('a[href^="/media/"]').first().attr('href') || ''
    const m = href.match(/^\/media\/([^/?#]+)\/(\d+)$/)
    if (!m) return
    const title = $el.find('h2, h3, h4, header').first().text()
    add(m[1], m[2], title)
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

  const mega = matchAllUnique(/https?:\/\/[^\s"'<\\]*mega\.nz\/(?:file|embed)\/[^\s"'<\\]*/gi, normalizeMegaUrl)
  const mediafire = matchAllUnique(/https?:\/\/[^\s"'<\\]*mediafire\.com\/file[^\s"'<\\]*/gi)
  const fireload = matchAllUnique(/https?:\/\/[^\s"'<\\]*fireload\.com\/[a-z0-9]{8,}[^\s"'<\\]*/gi)
  const fichier = matchAllUnique(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/gi)
  const mp4upload = matchAllUnique(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/(?:embed-)?[a-z0-9_-]{4,80}(?:\.html)?/gi, normalizeMp4UploadUrl)
  const yourupload = matchAllUnique(/https?:\/\/[^\s"'<\\]*yourupload\.com\/(?:embed|watch)\/[^\s"'<\\]*/gi)

  const known = new Set([...mega, ...mediafire, ...fireload, ...fichier, ...mp4upload, ...yourupload])
  const otros = matchAllUnique(/https?:\/\/[^\s"'<\\]{10,}/gi)
    .filter((u) => !u.includes(BASE) && !known.has(u) && /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u))

  return { mega, mediafire, fireload, fichier, mp4upload, yourupload, otros }
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

function buildProgressBar(pct, width = 14) {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((width * clamped) / 100)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function formatDownloadProgress(title, episode, serverLabel, downloaded, totalBytes, speed) {
  const header = `📥 *${title}* — Ep. ${episode} _(${serverLabel})_`
  if (totalBytes > 0) {
    const pct = Math.min(100, (downloaded / totalBytes) * 100)
    return (
      `${header}\n` +
      `\`[${buildProgressBar(pct)}] ${pct.toFixed(1)}%\`\n` +
      `📦 ${formatBytes(downloaded)} / ${formatBytes(totalBytes)} · ⚡ ${formatBytes(speed)}/s`
    )
  }
  return `${header}\n📦 ${formatBytes(downloaded)} · ⚡ ${formatBytes(speed)}/s`
}

function createProgressLogger(label, initialTotal, onStatusProgress) {
  let totalBytes = Number(initialTotal) || 0
  let downloaded = 0
  let lastTtyRender = 0
  let lastStatusRender = Date.now()
  const startedAt = Date.now()

  return {
    setTotal(bytes) {
      if (bytes > 0) totalBytes = bytes
    },
    add(bytes) {
      downloaded += bytes
      const now = Date.now()
      const elapsed = Math.max((now - startedAt) / 1000, 0.001)
      const speed = downloaded / elapsed

      if (process.stdout.isTTY && now - lastTtyRender >= 1000) {
        lastTtyRender = now
        const pct = totalBytes > 0 ? `${Math.min(100, (downloaded / totalBytes) * 100).toFixed(1)}%` : '--%'
        process.stdout.write(`\r[${label}] ${pct} (${formatBytes(downloaded)}) | ${formatBytes(speed)}/s   `)
      }

      if (onStatusProgress && now - lastStatusRender >= STATUS_EDIT_INTERVAL_MS) {
        lastStatusRender = now
        onStatusProgress(downloaded, totalBytes, speed)
      }
    },
    reset() {
      downloaded = 0
      lastStatusRender = Date.now()
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

async function downloadDirect(directUrl, tempPath, status, { title, episode, label, referer, signal } = {}) {
  const headers = {
    Accept: '*/*',
    ...(referer ? { Referer: referer } : {}),
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

  const sizeInfo = sizeBytes > 0 ? ` · ${formatBytes(sizeBytes)}` : ''
  await status.update(`📥 *${title}* — Ep. ${episode} _(${label}${sizeInfo})_\n⏬ _Descargando..._`)

  const attemptController = new AbortController()
  const attemptSignal = combineSignal(signal, DOWNLOAD_TIMEOUT_MS)
  const onParentAbort = () => attemptController.abort(createAbortError())
  attemptSignal.addEventListener('abort', onParentAbort, { once: true })

  const watchdog = createIdleWatchdog(() => attemptController.abort(new Error(`${label} sin datos por ${IDLE_TIMEOUT_MS / 1000}s`)))
  const progress = createProgressLogger(label, sizeBytes, (done, total, speed) => {
    status.update(formatDownloadProgress(title, episode, label, done, total, speed))
  })

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

async function downloadMega(url, tempPath, status, { title, episode, signal } = {}) {
  const file = MegaFile.fromURL(normalizeMegaUrl(url))
  await file.loadAttributes()
  if (signal?.aborted) throw createAbortError()

  const sizeBytes = Number(file.size) || 0
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`El archivo en MEGA (${formatBytes(sizeBytes)}) supera el límite de 2 GB`)
  }

  const sizeInfo = sizeBytes > 0 ? ` · ${formatBytes(sizeBytes)}` : ''
  await status.update(`📥 *${title}* — Ep. ${episode} _(MEGA${sizeInfo})_\n⏬ _Descargando..._`)

  const fileStream = file.download({ maxConnections: MEGA_MAX_CONNECTIONS })
  const progress = createProgressLogger('MEGA', sizeBytes, (done, total, speed) => {
    status.update(formatDownloadProgress(title, episode, 'MEGA', done, total, speed))
  })
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

function createStatusController(conn, m, initialKey = null) {
  let key = initialKey
  let lastText = ''
  let chain = Promise.resolve()

  const enqueue = (fn) => {
    const task = chain.then(fn, fn)
    chain = task.catch(() => {})
    return task
  }

  return {
    getKey() {
      return key
    },
    update(txt, { forceSend = false } = {}) {
      return enqueue(async () => {
        if (!txt || txt === lastText) return
        if (key) {
          try {
            await conn.sendMessage(m.chat, { text: txt, edit: key })
            lastText = txt
            return
          } catch {
            if (!forceSend) return
          }
        }
        try {
          const sent = await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
          if (sent?.key) key = sent.key
          lastText = txt
        } catch { }
      })
    },
    remove() {
      return enqueue(async () => {
        if (!key) return
        const target = key
        key = null
        lastText = ''
        try {
          await conn.sendMessage(m.chat, { delete: target })
        } catch { }
      })
    },
  }
}

function pruneExpiredSessions() {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (session.expiry <= now) sessions.delete(key)
  }
}

async function sendInteractiveList(conn, chat, m, status, {
  title,
  description,
  button,
  section,
  rows,
  coverUrl = null,
  coverShown = false,
  quickReplies = false,
}) {
  pruneExpiredSessions()
  const sessionKey = `${chat}|${m.sender}`
  const session = {
    owner: m.sender,
    chat,
    rows,
    msgId: null,
    statusKey: null,
    coverShown,
    expiry: Date.now() + SESSION_TTL_MS,
  }
  sessions.set(sessionKey, session)

  let device = 'android'
  try { device = getDevice(m?.key?.id) } catch { }
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile) {
    try {
      let imgBuf = null
      if (coverUrl) {
        try { imgBuf = await fetchBuffer(coverUrl) } catch { }
      }

      const nativeFlow = quickReplies && rows.length <= 3
        ? rows.map((r) => ({
            text: `▶️ ${r.title}`,
            id: r.rowId,
            icon: 'default',
          }))
        : [{
            text: button,
            icon: 'default',
            sections: [{
              title: section,
              rows: rows.map((r) => ({
                header: r.title,
                title: r.subtitle || r.title,
                description: r.description || '',
                id: r.rowId,
              })),
            }],
          }]

      const footer = global.botName || global.wm || 'HentaiLA'
      const bodyText = description || title
      const payload = imgBuf
        ? { image: imgBuf, title, caption: bodyText, footer, nativeFlow }
        : { text: `*${title}*\n\n${bodyText}`, footer, nativeFlow }

      const sent = await conn.sendMessage(chat, payload, { quoted: m })
      await status.remove()
      session.msgId = sent?.key?.id || null
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
  txt += '\n_Responde con el número para elegir._'
  await status.update(txt, { forceSend: true })
  session.statusKey = status.getKey()
  session.msgId = session.statusKey?.id || null
  return session.statusKey
}

async function sendCover(m, conn, info, signal) {
  const { title, cover, desc, episodes, generos } = info
  const totalEps = episodes.length
  const lastEp = episodes[totalEps - 1] || '?'
  const rango = totalEps === 1 ? 'Ep. 1' : `Eps 1–${lastEp}`
  const tags = generos.length > 0 ? generos.slice(0, 5).join(' · ') : 'N/A'

  const caption =
    `🔞 *${title}*\n` +
    `📖 ${desc}\n\n` +
    `🎬 *Episodios:* ${totalEps > 0 ? `${totalEps} (${rango})` : '?'} · 🏷️ ${tags}`

  if (cover) {
    try {
      const imgBuf = await fetchBuffer(cover, signal)
      await conn.sendMessage(m.chat, { image: imgBuf, caption, mimetype: 'image/jpeg' }, { quoted: m })
      return true
    } catch { }
  }
  await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
  return true
}

function buildServerQueue(links) {
  return [
    ...links.mediafire.map((url) => ({ tipo: 'mediafire', label: 'MediaFire', url })),
    ...links.fireload.map((url) => ({ tipo: 'fireload', label: 'FireLoad', url })),
    ...links.mp4upload.map((url) => ({ tipo: 'mp4upload', label: 'MP4Upload', url })),
    ...links.yourupload.map((url) => ({ tipo: 'yourupload', label: 'YourUpload', url })),
    ...(ONEFICHIER_API_KEY ? links.fichier.map((url) => ({ tipo: '1fichier', label: '1Fichier', url })) : []),
    ...links.otros.map((url) => ({ tipo: 'directo', label: 'Directo', url })),
    ...links.mega.map((url) => ({ tipo: 'mega', label: 'MEGA', url })),
  ]
}

async function downloadAndSend(m, conn, mediaUrl, info, episode, status, signal) {
  let html
  try {
    html = await fetchText(mediaUrl, { signal })
  } catch (err) {
    if (err?.status === 404) {
      const avail = info.episodes.length ? ` (disponibles: 1–${info.episodes.at(-1)})` : ''
      return status.update(`❌ El episodio *${episode}* de *${info.title}* no existe${avail}.`, { forceSend: true })
    }
    throw err
  }

  const links = parseEpisodeLinks(html)
  const servers = buildServerQueue(links)
  if (!servers.length) {
    return status.update(`❌ No se encontraron servidores de descarga.\n🔗 ${mediaUrl}`, { forceSend: true })
  }

  let tempPath = null
  let success = false

  for (const srv of servers) {
    if (signal?.aborted) throw createAbortError()
    const baseName = sanitizeFilename(`${info.title} - Ep ${episode}.mp4`)
    tempPath = path.join(os.tmpdir(), `hdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`)

    try {
      await status.update(`🔄 *${info.title}* — Ep. ${episode}\n_Probando ${srv.label}..._`)

      if (srv.tipo === 'mega') {
        await downloadMega(srv.url, tempPath, status, { title: info.title, episode, signal })
      } else if (srv.tipo === 'directo') {
        await downloadDirect(srv.url, tempPath, status, { title: info.title, episode, label: srv.label, signal })
      } else {
        const resolver = {
          mediafire: resolveMediafire,
          fireload: resolveFireload,
          mp4upload: resolveMp4Upload,
          yourupload: resolveYourUpload,
          '1fichier': resolve1Fichier,
        }[srv.tipo]
        const resolved = await resolver(srv.url, signal)
        await downloadDirect(resolved.direct, tempPath, status, {
          title: info.title,
          episode,
          label: srv.label,
          referer: resolved.referer,
          signal,
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
    return status.update(`❌ Todos los servidores fallaron para el ep. ${episode} de *${info.title}*.\n🔗 ${mediaUrl}`, { forceSend: true })
  }

  try {
    if (signal?.aborted) throw createAbortError()
    await status.update(`📤 *${info.title}* — Ep. ${episode}\n_Enviando a WhatsApp..._`)

    const stats = await fsp.stat(tempPath)
    const epNum = String(episode).padStart(2, '0')
    const finalName = `${epNum} ${sanitizeFilename(info.title, info.slug)}.mp4`

    await conn.sendMessage(m.chat, {
      document: { url: tempPath },
      fileName: finalName,
      mimetype: 'video/mp4',
      caption: `🔞 *${info.title}* — Ep. ${episode} · ${formatBytes(stats.size)}`,
    }, { quoted: m })

    await status.update(`✅ *Enviado* · ${info.title} — Ep. ${episode}`)
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function runEpisodeFlow(m, conn, info, episode, status, { skipCover = false } = {}) {
  const userKey = downloadKey(m)
  if (hasDownload(userKey, SERVICE)) {
    return status.update('⚠️ Ya tienes una descarga de HentaiLA en curso. Usa *.cancelar* para detenerla.', { forceSend: true })
  }

  const controller = new AbortController()
  const release = startDownload(userKey, SERVICE, controller, {
    label: `HentaiLA · ${info.title} Ep. ${episode}`,
  })

  try {
    if (!skipCover) {
      await status.remove()
      await sendCover(m, conn, info, controller.signal)
    }
    await status.update(`⏳ *${info.title}* — Ep. ${episode}\n_Preparando descarga... (usa .cancelar para detener)_`)

    const epUrl = `${BASE}/media/${info.slug}/${episode}`
    await downloadAndSend(m, conn, epUrl, info, episode, status, controller.signal)
  } finally {
    release()
  }
}

const handler = async (m, { conn, text, usedPrefix, command, existingKey = null, skipCover = false }) => {
  const isLatest = /hlatest|hentailatest/i.test(command)

  if (!text && !isLatest) {
    return m.reply(
      `🔞 *Uso:* ${usedPrefix}${command} <nombre|url> [episodio]\n\n` +
      `*Ejemplos:*\n` +
      `• ${usedPrefix}${command} overflow 1\n` +
      `• ${usedPrefix}${command} ${BASE}/media/overflow/1\n\n` +
      `💡 Usa \`${usedPrefix}hlatest\` para ver lo más nuevo.`,
    )
  }

  const status = createStatusController(conn, m, existingKey)
  await status.update('🔍 _Buscando en HentaiLA..._', { forceSend: true })

  try {
    if (isLatest) {
      const latest = await fetchLatestReleases()
      if (!latest.length) {
        return status.update('❌ No se pudieron obtener los últimos lanzamientos.', { forceSend: true })
      }

      const rows = latest.map((item) => ({
        rowId: `${usedPrefix}hdl ${item.slug} ${item.episode}`,
        title: item.title,
        description: `Ep. ${item.episode}`,
      }))
      await sendInteractiveList(conn, m.chat, m, status, {
        title: '🔞 Últimos lanzamientos en HentaiLA',
        description: 'Elige un título para descargar:',
        button: '📋 Ver lanzamientos',
        section: 'Recién subidos',
        rows,
      })
      return
    }

    const { slug, episode, query } = parseHentaiInput(text)
    let info = null

    if (slug) {
      info = await fetchSeriesBySlug(slug)
      if (!info) return status.update(`❌ No se encontró la serie *${slug}* en HentaiLA.`, { forceSend: true })
    } else {
      await status.update(`🔎 _Buscando "${query}"..._`)
      const { exact, results } = await searchHentaiLA(query)

      if (exact) {
        info = exact
      } else if (!results.length) {
        return status.update(
          `❌ No se encontraron resultados para *"${query}"*.\n\n` +
          `💡 Prueba con el título en inglés o romaji.\n` +
          `Ej: \`${usedPrefix}hdl overflow 1\``,
          { forceSend: true },
        )
      } else if (results.length === 1) {
        info = await fetchSeriesBySlug(results[0].slug)
        if (!info) return status.update(`❌ No se pudo cargar la info de *${results[0].title}*.`, { forceSend: true })
      } else {
        const top = results.slice(0, 10)
        const rows = top.map((r) => ({
          rowId: episode ? `${usedPrefix}hdl ${r.slug} ${episode}` : `${usedPrefix}hdl ${r.slug}`,
          title: r.title,
        }))
        await sendInteractiveList(conn, m.chat, m, status, {
          title: `🔞 Resultados para: "${query}"`,
          description: `Se encontraron ${top.length} títulos. Elige uno:`,
          button: '📋 Ver opciones',
          section: 'Títulos disponibles',
          rows,
        })
        return
      }
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

      await sendInteractiveList(conn, m.chat, m, status, {
        title: `🎬 ${info.title}`,
        description: `${info.desc}\n\n🎬 *Eps:* ${epsSummary} · 🏷️ ${genresSummary}`,
        button: '📺 Elegir episodio',
        section: 'Episodios disponibles',
        rows,
        coverUrl: info.cover,
        coverShown: true,
        quickReplies: true,
      })
      return
    }

    await runEpisodeFlow(m, conn, info, episode, status, { skipCover })
  } catch (err) {
    if (isAbortError(err)) {
      await status.update('⏹️ *Descarga cancelada.*', { forceSend: true })
      return
    }
    console.error('[HDL]', err.message)
    await status.update(`❌ *Error:* ${err.message}`, { forceSend: true })
  }
}

function extractInteractiveId(message) {
  const nf = message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (nf?.paramsJson) {
    try { return JSON.parse(nf.paramsJson)?.id ?? null } catch { return null }
  }
  return (
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    null
  )
}

async function dispatchSelection(conn, m, rowId, { existingKey = null, skipCover = false } = {}) {
  const usedPrefix = rowId[0]
  const [command, ...argParts] = rowId.slice(1).trim().split(/\s+/)
  const text = argParts.join(' ')
  try {
    await handler.call(conn, m, { conn, text, usedPrefix, command, existingKey, skipCover })
  } catch (err) {
    console.error('[HDL before] Error ejecutando selección:', err.message)
  }
}

handler.before = async function (m, { conn }) {
  pruneExpiredSessions()
  const sessionKey = `${m.chat}|${m.sender}`
  const session = sessions.get(sessionKey)

  const selectedId = extractInteractiveId(m.message)
  if (selectedId) {
    if (!COMMAND_PREFIX_RE.test(selectedId)) return false
    if (!session || session.owner !== m.sender) return true
    if (!session.rows.some((r) => r.rowId === selectedId)) return false

    sessions.delete(sessionKey)
    await dispatchSelection(conn, m, selectedId, {
      existingKey: session.statusKey,
      skipCover: Boolean(session.coverShown),
    })
    return true
  }

  if (!session || session.owner !== m.sender) return false

  const rawText = String(m.text || '').trim()
  if (!/^\d+$/.test(rawText)) return false

  const quotedId = m.quoted?.key?.id || m.quoted?.id || null
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
  sessions.delete(sessionKey)
  await dispatchSelection(conn, m, chosen.rowId, {
    existingKey: session.statusKey,
    skipCover: Boolean(session.coverShown),
  })
  return true
}

handler.help = ['hdl <nombre|url> [episodio]', 'hlatest']
handler.tags = ['nsfw']
handler.command = /^(hdl|hentaidl|hlatest|hentailatest)$/i

export default handler
