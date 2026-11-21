// plugins/jk-notify.js — Notificador automático unificado de nuevos episodios (JKAnime)
// Incluye extractores JKAnime (sin evaluar JS remoto), cliente HTTP sobre wreq-js
// con huella Chrome real, respaldo anti-Cloudflare con APIs de scraping
// (scrape.do, ScraperAPI, WebScrapingAPI, OpenGraph.io), descargas paralelas/HLS
// y suite de tests embebida
// (ejecutable con `node --test plugins/jk-notify.js`).

import * as cheerio from 'cheerio'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { File as MegaFile } from 'megajs'
import ffmpegStatic from 'ffmpeg-static'
import { DATA_DIR, TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'

// ─── Constantes y configuración ───────────────────────────────────────────────

const MODULE_PATH = fileURLToPath(import.meta.url)
const IS_TEST_RUN = Boolean(
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === MODULE_PATH,
)

const JKANIME_URL = 'https://jkanime.net'
const ANILIST_URL = 'https://graphql.anilist.co'
const SOURCE_LABEL = 'JKAnime 🇯🇵'

const WREQ_BROWSER = 'chrome'
const WREQ_OS = 'windows'
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const ACCEPT_LANG = 'es-419,es;q=0.9,en;q=0.8'

// Anti-Cloudflare (opcionales; si tu IP es de datacenter y Cloudflare pide desafío):
//   JK_PROXY_URL=http://user:pass@host:8888 (o socks5://host:1080)
//   JK_FLARESOLVERR_URL / FLARESOLVERR_URL=http://host:8191
//   JK_COOKIE=cf_clearance=...  (acompañada de JK_UA del mismo navegador e IP)
// APIs de scraping (respaldo automático cuando JKAnime bloquea la petición directa):
//   SCRAPEDO_TOKEN, SCRAPERAPI_KEY, WEBSCRAPINGAPI_KEY, OPENGRAPH_APP_ID
//   (JK_SCRAPER_APIS=0 las desactiva)
const JK_PROXY_URL = String(process.env.JK_PROXY_URL || '').trim()
const JK_TIMEZONE = String(process.env.JK_TIMEZONE || process.env.DBS_TIMEZONE || 'America/Lima').trim()

const HTTP_TIMEOUT_MS = 18_000
const JK_MIN_REQUEST_INTERVAL_MS = 700
const IDLE_TIMEOUT_MS = 90_000
const DL_TIMEOUT_MS = 3 * 60 * 60 * 1000
const CHECK_INTERVAL_DEFAULT = 10 // minutos
const QUEUE_DELAY_MS = 90_000
const MAX_SEEN_PER_CHAT = 500
const MAX_REQUEUES = 2

const MIN_VALID_BYTES = 256 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3 // 2 GB límite de documentos WhatsApp
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024
const MEGA_MAX_CONNECTIONS = Math.min(Math.max(Number(process.env.MEGA_MAX_CONNECTIONS) || 16, 4), 32)
const MEGA_CHUNK_SIZE = 1024 * 1024
const FFMPEG_BIN = ffmpegStatic || process.env.FFMPEG_PATH || 'ffmpeg'

const COVER_CACHE_MAX = 300
const COVER_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const TRANSIENT_SEND_ERROR_RE = /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required|etimedout|epipe/i
const BLOCKED_HOSTS_RE = /(?:^|\.)(?:hqq\.tv|netu\.tv|netu\.ac|waaw\.to|biribup\.com)$/i

const SERVER_PRIORITY = [
  'mega',
  'mediafire',
  'mp4upload',
  'jkplayer',
  'voe',
  'filemoon',
  'streamwish',
  'vidhide',
  'streamtape',
  'doodstream',
  'okru',
  'mixdrop',
  'embed',
]

const DB_DIR = DATA_DIR
if (!IS_TEST_RUN && !fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
const SEEN_FILE = path.join(DB_DIR, 'jkanime_seen.json')
const STATE_FILE = path.join(DB_DIR, 'jkanime_state.json')

// ─── Estado global persistente entre recargas ─────────────────────────────────

global.jkActiveChats = global.jkActiveChats || new Map()
global.jkEpisodeQueue = global.jkEpisodeQueue || []
global.jkQueueRunning = global.jkQueueRunning || false
global.jkConn = global.jkConn || null
global.jkQueuedIds = global.jkQueuedIds || new Set()
global.jkCheckingChats = global.jkCheckingChats || new Set()
global.jkCoverCache = global.jkCoverCache || new Map()
global.jkCoverNegTime = global.jkCoverNegTime || new Map()
global.jkCurrentJob = global.jkCurrentJob || null
global.jkLastCheckAt = global.jkLastCheckAt || 0
global.jkLastSent = global.jkLastSent || null
global.jkLastError = global.jkLastError || null

// ─── Utilidades base ──────────────────────────────────────────────────────────

const sleep = (ms, signal) => {
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

function combineSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal])
  return signal
}

function zeroPad(n) {
  return String(n).padStart(2, '0')
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function formatClock(timestamp = Date.now()) {
  try {
    return new Date(timestamp)
      .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: JK_TIMEZONE })
      .toUpperCase()
  } catch (_) {
    return new Date(timestamp)
      .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })
      .toUpperCase()
  }
}

function safeFile(value) {
  return String(value || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'Anime'
}

const ROMAN_SEASONS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }

function getSeasonNumber(...values) {
  const text = values.filter(Boolean).join(' ')
  const token = '(\\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)'
  const patterns = [
    new RegExp(`${token}\\s*(?:st|nd|rd|th|ª|º)?\\s*(?:temporada|season)`, 'i'),
    new RegExp(`(?:temporada|season)\\s*[-_: ]?\\s*${token}`, 'i'),
    new RegExp(`\\b(?:S|T)\\s*${token}\\b`, 'i'),
  ]
  for (const re of patterns) {
    const match = text.match(re)
    if (!match?.[1]) continue
    const raw = match[1].toUpperCase()
    const num = /^\d+$/.test(raw) ? Number(raw) : (ROMAN_SEASONS[raw] || 1)
    if (num > 1) return num
  }
  return 1
}

function cleanTitle(titulo, epNum) {
  return String(titulo || '')
    .replace(new RegExp(`^\\s*(?:episodio|cap[ií]tulo|capitulo)\\s*0?${Number(epNum)}\\s*[-–—:]?\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—:]?\\s*${Number(epNum)}\\s*$`), '')
    .replace(/\s*(?:(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)(?:st|nd|rd|th|ª|º)?\s*)?(?:temporada|season)\s*[-_: ]*\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)?/ig, '')
    .replace(/\s*\b(?:S|T)\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)\b/ig, '')
    .replace(/\s*(?:sub\s+)?español(?:\s+(?:latino|castellano|de\s+españa))?\s*(?:🇲🇽|🇪🇸)?/ig, '')
    .replace(/\s*\(\s*(?:720p|1080p)\s*\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildFileName(titulo, epNum, slug = '') {
  const season = getSeasonNumber(titulo, slug)
  const seasonLabel = season > 1 ? `T${season} ` : ''
  const title = cleanTitle(titulo || slug.replace(/[-_]+/g, ' '), epNum)
  return `${zeroPad(epNum)} ${seasonLabel}${safeFile(title)} Sub Español (720p) [[JK]].mp4`
}

function isJKAnimeUrl(url) {
  try {
    return /(^|\.)jkanime\.net$/i.test(new URL(url).hostname)
  } catch (_) {
    return false
  }
}

function isCloudflareChallenge(status, headers, bodyText = '') {
  if (status !== 403 && status !== 503) return false
  const cfMitigated = String(headers?.get?.('cf-mitigated') || headers?.['cf-mitigated'] || '').toLowerCase()
  if (cfMitigated.includes('challenge')) return true
  const snippet = String(bodyText || '').slice(0, 8192)
  return /<title>\s*(?:Just a moment|Un momento|Attention Required)/i.test(snippet)
    || /cdn-cgi\/challenge-platform|_cf_chl_opt|cf-browser-verification/i.test(snippet)
}

function parseCookiePairs(cookieHeader) {
  const pairs = []
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name) pairs.push([name, value])
  }
  return pairs
}

function getHeader(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return String(v || '')
  }
  return ''
}

function headersToObject(headers) {
  if (!headers) return {}
  if (typeof headers.toObject === 'function') return headers.toObject()
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries())
  return { ...headers }
}

function toNodeReadable(res) {
  if (typeof res?.readable === 'function') return res.readable()
  const body = res?.body
  if (!body) throw new Error('Respuesta HTTP sin cuerpo')
  if (body instanceof Readable || typeof body.pipe === 'function') return body
  if (typeof body.getReader === 'function') {
    try {
      return Readable.fromWeb(body)
    } catch (_) {
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
  } catch (_) {}
}

// ─── Capa HTTP unificada sobre wreq-js (huella Chrome + sesiones) ─────────────

const jkRuntime = {
  ua: String(process.env.JK_UA || '').trim(),
  cookie: String(process.env.JK_COOKIE || '').trim(),
  flareUrl: String(process.env.JK_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '').replace(/\/+$/, ''),
}

let wreqModulePromise = null
let wreqUnavailable = false
let activeProfile = WREQ_BROWSER
let activeUa = FALLBACK_UA
let jkSessionPromise = null
let webSessionPromise = null
let flareSolvePromise = null

let jkLastRequestAt = 0
let jkRequestQueue = Promise.resolve()

function waitJkRequestSlot(signal) {
  const slot = jkRequestQueue.then(async () => {
    const elapsed = Date.now() - jkLastRequestAt
    const delay = Math.max(0, JK_MIN_REQUEST_INTERVAL_MS - elapsed) + Math.floor(Math.random() * 251)
    if (delay > 0) await sleep(delay, signal)
    jkLastRequestAt = Date.now()
  })
  jkRequestQueue = slot.catch(() => {})
  return slot
}

async function getWreq() {
  if (wreqUnavailable) return null
  if (!wreqModulePromise) {
    wreqModulePromise = import('wreq-js')
      .then((mod) => {
        try {
          if (typeof mod.resolveProfile === 'function') activeProfile = mod.resolveProfile(WREQ_BROWSER)
          if (typeof mod.getEmulationHeaders === 'function') {
            const emu = mod.getEmulationHeaders(WREQ_BROWSER, WREQ_OS)
            const ua = emu?.get?.('user-agent')
            if (ua) activeUa = ua
          }
        } catch (_) {}
        return mod
      })
      .catch((err) => {
        wreqUnavailable = true
        wreqModulePromise = null
        console.warn(`[jk-notify] wreq-js no disponible, usando fetch nativo: ${err.message}`)
        return null
      })
  }
  return wreqModulePromise
}

function getEffectiveUa(forJk = false) {
  return (forJk && jkRuntime.ua) ? jkRuntime.ua : activeUa
}

async function getJkSession() {
  const wreq = await getWreq()
  if (!wreq) return null
  if (!jkSessionPromise) {
    jkSessionPromise = wreq.createSession({
      browser: WREQ_BROWSER,
      os: WREQ_OS,
      timeout: HTTP_TIMEOUT_MS,
      defaultHeaders: { 'accept-language': ACCEPT_LANG },
      ...(JK_PROXY_URL ? { proxy: JK_PROXY_URL } : {}),
    }).then((session) => {
      for (const [name, value] of parseCookiePairs(jkRuntime.cookie)) {
        try { session.setCookie(name, value, JKANIME_URL) } catch (_) {}
      }
      return session
    }).catch((err) => {
      jkSessionPromise = null
      throw err
    })
  }
  return jkSessionPromise
}

async function getWebSession() {
  const wreq = await getWreq()
  if (!wreq) return null
  if (!webSessionPromise) {
    webSessionPromise = wreq.createSession({
      browser: WREQ_BROWSER,
      os: WREQ_OS,
      timeout: HTTP_TIMEOUT_MS,
      defaultHeaders: { 'accept-language': ACCEPT_LANG },
    }).catch((err) => {
      webSessionPromise = null
      throw err
    })
  }
  return webSessionPromise
}

async function closeWreqSessions() {
  const sessions = await Promise.allSettled([jkSessionPromise, webSessionPromise])
  jkSessionPromise = null
  webSessionPromise = null
  for (const entry of sessions) {
    if (entry.status === 'fulfilled' && entry.value && !entry.value.closed) {
      await entry.value.close().catch(() => {})
    }
  }
}

async function applySolvedCookies(cookies, baseUrl = JKANIME_URL) {
  if (!Array.isArray(cookies) || !cookies.length) return
  jkRuntime.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  const session = await getJkSession().catch(() => null)
  if (!session) return
  await session.clearCookies().catch(() => {})
  for (const c of cookies) {
    if (!c?.name) continue
    try {
      const origin = c.domain
        ? `https://${String(c.domain).replace(/^\./, '')}/`
        : baseUrl
      session.setCookie(c.name, String(c.value ?? ''), origin)
    } catch (_) {
      try { session.setCookie(c.name, String(c.value ?? ''), baseUrl) } catch (_) {}
    }
  }
}

async function rawFetch(url, {
  method = 'GET',
  headers = {},
  body,
  timeout = HTTP_TIMEOUT_MS,
  signal,
  redirect = 'follow',
  useJkSession = false,
  disableDefaultHeaders = false,
  bypassProxy = false,
} = {}) {
  const combined = combineSignal(signal, timeout)
  const wreq = await getWreq()

  if (wreq) {
    if (disableDefaultHeaders || bypassProxy) {
      return wreq.fetch(url, {
        method,
        headers,
        body,
        timeout,
        redirect,
        signal: combined,
        disableDefaultHeaders,
      })
    }
    const session = useJkSession ? await getJkSession() : await getWebSession()
    if (session) {
      return session.fetch(url, {
        method,
        headers,
        body,
        timeout,
        redirect,
        signal: combined,
      })
    }
  }

  const fallbackHeaders = {
    ...(disableDefaultHeaders ? {} : {
      'user-agent': getEffectiveUa(useJkSession),
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': ACCEPT_LANG,
    }),
    ...(useJkSession && jkRuntime.cookie ? { cookie: jkRuntime.cookie } : {}),
    ...headers,
  }
  return globalThis.fetch(url, {
    method,
    headers: fallbackHeaders,
    body,
    redirect,
    signal: combined,
  })
}

async function solveWithFlareSolverr(targetUrl) {
  if (!jkRuntime.flareUrl) throw new Error('FlareSolverr no configurado')
  if (flareSolvePromise) return flareSolvePromise
  flareSolvePromise = (async () => {
    const res = await rawFetch(`${jkRuntime.flareUrl}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: targetUrl, maxTimeout: 60_000 }),
      timeout: 75_000,
      disableDefaultHeaders: true,
      bypassProxy: true,
    })
    if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`)
    const payload = await res.json()
    const sol = payload?.solution
    if (payload?.status !== 'ok' || !sol) {
      throw new Error(`FlareSolverr: ${payload?.message || 'sin solución'}`)
    }
    if (sol.userAgent) jkRuntime.ua = String(sol.userAgent).trim()
    await applySolvedCookies(sol.cookies, targetUrl)
    return {
      data: String(sol.response || ''),
      status: Number(sol.status) || 200,
      headers: sol.headers || {},
      url: sol.url || targetUrl,
    }
  })().finally(() => {
    flareSolvePromise = null
  })
  return flareSolvePromise
}

// ─── APIs de scraping (respaldo anti-Cloudflare) ──────────────────────────────
// Se usan SOLO cuando JKAnime bloquea la petición directa (HTTP 403/desafío) y
// FlareSolverr no está configurado o falla. Orden: scrape.do → ScraperAPI →
// WebScrapingAPI → OpenGraph.io (scrape). Cada proveedor prueba primero el modo
// normal y escala a premium/residencial solo si Cloudflare sigue bloqueando.
// Las claves se pueden sobrescribir con variables de entorno; JK_SCRAPER_APIS=0
// desactiva todo este respaldo.

const SCRAPER_TIMEOUT_MS = 70_000
const SCRAPER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000
const SCRAPER_SOFT_COOLDOWN_MS = 5 * 60 * 1000
const SCRAPER_RATE_COOLDOWN_MS = 60 * 1000
const SCRAPER_CACHE_TTL_MS = 60_000
const SCRAPER_CACHE_MAX = 40

const envKey = (name, fallback = '') => String(process.env[name] || fallback).trim()

const scraperRuntime = {
  enabled: !IS_TEST_RUN && process.env.JK_SCRAPER_APIS !== '0',
  lastGood: '',
  cache: new Map(),
  providers: [
    {
      id: 'scrapedo',
      label: 'scrape.do',
      base: 'https://api.scrape.do/',
      key: envKey('SCRAPEDO_TOKEN', 'db51bcb2edaf40ed9457e4f121357d66c253eb7d830'),
      levels: 2, // 0 = normal, 1 = super (proxies residenciales/móviles)
      forwardHeaders: true,
      params: (key, url, level, forward) => ({
        token: key,
        url,
        ...(level >= 1 ? { super: 'true' } : {}),
        ...(forward ? { customHeaders: 'true' } : {}),
      }),
    },
    {
      id: 'scraperapi',
      label: 'ScraperAPI',
      base: 'https://api.scraperapi.com/',
      key: envKey('SCRAPERAPI_KEY', '0431581063dc7e5b59fd1cb11e3b637e'),
      levels: 2, // 1 = premium
      forwardHeaders: true,
      params: (key, url, level, forward) => ({
        api_key: key,
        url,
        ...(level >= 1 ? { premium: 'true' } : {}),
        ...(forward ? { keep_headers: 'true' } : {}),
      }),
    },
    {
      id: 'webscrapingapi',
      label: 'WebScrapingAPI',
      base: 'https://api.webscrapingapi.com/v2',
      key: envKey('WEBSCRAPINGAPI_KEY', '47c60c5d4e836d631151ac9b3287a0f4'),
      levels: 2, // 1 = render JS + proxy residencial
      forwardHeaders: true,
      params: (key, url, level, forward) => ({
        api_key: key,
        url,
        render_js: level >= 1 ? '1' : '0',
        proxy_type: level >= 1 ? 'residential' : 'datacenter',
        ...(forward ? { keep_headers: '1' } : {}),
      }),
    },
    {
      id: 'opengraph',
      label: 'OpenGraph.io',
      base: 'https://opengraph.io/api/1.1/',
      key: envKey('OPENGRAPH_APP_ID', '8621cc8f-b6d6-4493-b8e5-baea0f11efb1'),
      levels: 2, // 1 = full_render (Chrome real)
      forwardHeaders: false,
      buildUrl: (provider, url, level) => `${provider.base}scrape/${encodeURIComponent(url)}?${new URLSearchParams({
        app_id: provider.key,
        use_proxy: 'true',
        cache_ok: 'false',
        ...(level >= 1 ? { full_render: 'true' } : {}),
      })}`,
      extract: (text) => {
        try {
          const json = JSON.parse(text)
          const html = json?.html ?? json?.content ?? json?.data
          return typeof html === 'string' ? html : ''
        } catch (_) {
          return text
        }
      },
    },
  ],
}

function redactScraperKeys(text) {
  let out = String(text ?? '')
  for (const provider of scraperRuntime.providers) {
    if (provider.key) out = out.split(provider.key).join('***')
  }
  return out
}

function scraperApisAvailable() {
  if (!scraperRuntime.enabled) return false
  const now = Date.now()
  return scraperRuntime.providers.some(p => p.key && (p.cooldownUntil || 0) <= now)
}

function activeScraperLabels() {
  return scraperRuntime.enabled ? scraperRuntime.providers.filter(p => p.key).map(p => p.label) : []
}

// Una página real de Cloudflare "Just a moment": no confundir con el script
// pasivo /cdn-cgi/challenge-platform que Cloudflare inyecta en páginas normales.
function looksLikeCfChallengePage(body) {
  const snippet = String(body || '').slice(0, 8192)
  return /<title>\s*(?:Just a moment|Un momento|Attention Required)/i.test(snippet)
    || /_cf_chl_opt|cf-browser-verification/i.test(snippet)
}

function parseJsonLoose(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch (_) {}
  try {
    const pre = cheerio.load(value)('pre').first().text()
    if (pre) return JSON.parse(pre)
  } catch (_) {}
  return value
}

async function callScraperProvider(provider, targetUrl, level, { headers = {}, signal } = {}) {
  const forward = Boolean(provider.forwardHeaders && Object.keys(headers).length)
  const endpoint = provider.buildUrl
    ? provider.buildUrl(provider, targetUrl, level)
    : `${provider.base}?${new URLSearchParams(provider.params(provider.key, targetUrl, level, forward))}`

  let res
  try {
    res = await rawFetch(endpoint, {
      headers: forward ? headers : {},
      timeout: SCRAPER_TIMEOUT_MS,
      signal,
      disableDefaultHeaders: true,
      bypassProxy: true,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(redactScraperKeys(err?.message || 'error de red'))
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    const failure = new Error(`HTTP ${res.status}`)
    if (isCloudflareChallenge(res.status, res.headers, text)) {
      failure.message = `HTTP ${res.status} (Cloudflare)`
      failure.blocked = true
    } else if (res.status === 401 || res.status === 402) {
      failure.cooldownMs = SCRAPER_QUOTA_COOLDOWN_MS // clave inválida o créditos agotados
    } else if (res.status === 403) {
      failure.cooldownMs = SCRAPER_SOFT_COOLDOWN_MS
    } else if (res.status === 429) {
      failure.cooldownMs = SCRAPER_RATE_COOLDOWN_MS
    }
    throw failure
  }

  const body = provider.extract ? provider.extract(text) : text
  if (!String(body).trim()) throw new Error('respuesta vacía')
  if (looksLikeCfChallengePage(body)) {
    const blocked = new Error('desafío Cloudflare en la respuesta')
    blocked.blocked = true
    throw blocked
  }
  return body
}

async function fetchViaScraperApis(targetUrl, { headers = {}, isAjax = false, signal } = {}) {
  if (!scraperRuntime.enabled) throw new Error('APIs de scraping desactivadas')

  const cached = scraperRuntime.cache.get(targetUrl)
  if (cached && Date.now() - cached.at < SCRAPER_CACHE_TTL_MS) return { ...cached.result }

  const forwardable = {}
  if (isAjax) {
    for (const name of ['x-requested-with', 'accept', 'referer']) {
      if (headers[name]) forwardable[name] = headers[name]
    }
  }

  const now = Date.now()
  const pool = scraperRuntime.providers.filter(p => p.key && (p.cooldownUntil || 0) <= now)
  const lastIdx = pool.findIndex(p => p.id === scraperRuntime.lastGood)
  if (lastIdx > 0) pool.unshift(...pool.splice(lastIdx, 1)) // primero el que funcionó la última vez

  const errors = []
  for (const provider of pool) {
    for (let level = provider.level || 0; level < provider.levels; level += 1) {
      try {
        const body = await callScraperProvider(provider, targetUrl, level, { headers: forwardable, signal })
        provider.level = level
        scraperRuntime.lastGood = provider.id
        const result = { data: body, status: 200, headers: {}, url: targetUrl }
        while (scraperRuntime.cache.size >= SCRAPER_CACHE_MAX) {
          scraperRuntime.cache.delete(scraperRuntime.cache.keys().next().value)
        }
        scraperRuntime.cache.set(targetUrl, { at: Date.now(), result })
        console.log(`[jk-notify] 🛡️ Cloudflare esquivado vía ${provider.label}${level ? ' (premium)' : ''}`)
        return { ...result }
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        errors.push(`${provider.label}${level ? ' premium' : ''}: ${redactScraperKeys(err.message)}`)
        if (err.cooldownMs) provider.cooldownUntil = Date.now() + err.cooldownMs
        if (!err.blocked) break // fallo que no es bloqueo → siguiente proveedor
        // bloqueado por Cloudflare → escala al modo premium del mismo proveedor
      }
    }
  }
  throw new Error(errors.join(' | ') || 'sin proveedores disponibles')
}

// Portada de respaldo: og:image de la página del episodio vía OpenGraph.io
async function getOpenGraphImage(pageUrl) {
  const provider = scraperRuntime.providers.find(p => p.id === 'opengraph')
  if (!scraperRuntime.enabled || !provider?.key || (provider.cooldownUntil || 0) > Date.now()) return null
  const key = `og:${pageUrl}`
  const cached = getCachedCover(key)
  if (cached !== undefined) return cached

  try {
    const endpoint = `${provider.base}site/${encodeURIComponent(pageUrl)}?${new URLSearchParams({
      app_id: provider.key,
      use_proxy: 'true',
    })}`
    const res = await rawFetch(endpoint, {
      headers: { accept: 'application/json' },
      timeout: 30_000,
      disableDefaultHeaders: true,
      bypassProxy: true,
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 402) provider.cooldownUntil = Date.now() + SCRAPER_QUOTA_COOLDOWN_MS
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json()
    const raw = json?.hybridGraph?.image || json?.openGraph?.image
    const image = safeHttpUrl(typeof raw === 'string' ? raw : raw?.url, pageUrl)
    setCachedCover(key, image || null)
    return image || null
  } catch (err) {
    throw new Error(redactScraperKeys(err?.message || 'error de red'))
  }
}

function normalizeHeaders(extra = {}, { forJk = false } = {}) {
  const out = {}
  if (forJk && jkRuntime.ua) out['user-agent'] = jkRuntime.ua
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') {
      out[key.toLowerCase()] = String(value)
    }
  }
  return out
}

async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = HTTP_TIMEOUT_MS,
    signal,
    redirect = 'follow',
    responseType = 'text',
    retries = 2,
    disableDefaultHeaders = false,
    forceJk = false,
  } = options

  const forJk = forceJk || isJKAnimeUrl(url)
  const isAjax = forJk && /\/ajax\//i.test(new URL(url).pathname)
  const totalAttempts = Math.max(1, retries + 1)
  let flareTried = false
  let scraperTried = false
  let scraperError = null
  let lastError = null

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (attempt > 1) await sleep(600 * attempt + Math.floor(Math.random() * 250), signal)
    if (forJk && !IS_TEST_RUN) await waitJkRequestSlot(signal)

    try {
      const res = await rawFetch(url, {
        method,
        headers: normalizeHeaders(headers, { forJk }),
        body,
        timeout,
        signal,
        redirect,
        useJkSession: forJk,
        disableDefaultHeaders,
      })

      if (res.ok) {
        let data
        if (responseType === 'buffer') {
          data = Buffer.from(await res.arrayBuffer())
        } else {
          const text = await res.text()
          if (responseType === 'json' || isAjax) {
            try { data = JSON.parse(text) } catch (_) { data = text }
          } else {
            data = text
          }
        }
        return {
          data,
          status: res.status,
          headers: headersToObject(res.headers),
          url: res.url || url,
        }
      }

      const preview = responseType === 'buffer' ? '' : await res.text().catch(() => '')
      const blocked = forJk && (res.status === 403 || isCloudflareChallenge(res.status, res.headers, preview))

      if (blocked && jkRuntime.flareUrl && !flareTried && responseType !== 'buffer') {
        flareTried = true
        try {
          const solved = await solveWithFlareSolverr(url)
          if (isAjax || responseType === 'json') {
            try { solved.data = JSON.parse(solved.data) } catch (_) {}
          }
          return solved
        } catch (flareErr) {
          if (signal?.aborted) throw createAbortError()
          console.warn(`[jk-notify] FlareSolverr falló: ${flareErr.message}`)
        }
      }

      if (blocked && method === 'GET' && !scraperTried && responseType !== 'buffer' && scraperApisAvailable()) {
        scraperTried = true
        try {
          const viaApi = await fetchViaScraperApis(url, { headers: normalizeHeaders(headers), isAjax, signal })
          if (isAjax || responseType === 'json') viaApi.data = parseJsonLoose(viaApi.data)
          return viaApi
        } catch (apiErr) {
          if (signal?.aborted) throw createAbortError()
          scraperError = apiErr
          console.warn(`[jk-notify] APIs de scraping fallaron: ${apiErr.message}`)
        }
      }

      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      err.isCloudflare = blocked
      lastError = err

      if (blocked || !RETRYABLE_STATUSES.has(res.status)) break
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastError = err
      if (err?.isCloudflare) break
    }
  }

  if (forJk) {
    const cfBlocked = Boolean(lastError?.isCloudflare || lastError?.status === 403)
    let detail
    if (cfBlocked && scraperError) {
      detail = `JKAnime devolvió HTTP 403 (desafío Cloudflare) y las APIs de scraping fallaron (${String(scraperError.message).slice(0, 240)}).`
    } else if (cfBlocked && !jkRuntime.flareUrl) {
      detail = 'JKAnime devolvió HTTP 403 (desafío Cloudflare). Configura JK_FLARESOLVERR_URL (o FLARESOLVERR_URL), una API de scraping (SCRAPEDO_TOKEN, SCRAPERAPI_KEY, WEBSCRAPINGAPI_KEY), JK_PROXY_URL residencial, o aporta JK_COOKIE y JK_UA vigentes del mismo navegador/IP.'
    } else {
      detail = `No se pudo acceder a JKAnime: ${lastError?.message || 'error desconocido'}`
    }
    const failed = new Error(detail)
    failed.code = 'JKANIME_FETCH_FAILED'
    if (lastError?.status) failed.status = lastError.status
    throw failed
  }

  throw lastError || new Error(`Error al solicitar ${url}`)
}

// ─── Extractores JKAnime (integrados, sin evaluar JS remoto) ──────────────────

function safeHttpUrl(value, baseUrl) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  try {
    const url = new URL(trimmed, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch (_) {
    return null
  }
}

function extractBalancedSection(text, startIndex, openChar, closeChar) {
  let depth = 0
  let activeQuote = ''
  let escaped = false
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index]
    if (activeQuote) {
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === activeQuote) activeQuote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') { activeQuote = character; continue }
    if (character === openChar) depth += 1
    if (character === closeChar) {
      depth -= 1
      if (depth === 0) return text.slice(startIndex, index + 1)
    }
  }
  return null
}

function extractVarLiteral(html, variableName) {
  const marker = new RegExp(`\\b(?:var|let|const)\\s+${variableName}\\s*=`, 'g')
  const match = marker.exec(html)
  if (!match) return null
  const slice = html.slice(marker.lastIndex)
  const start = slice.search(/[[{]/)
  if (start < 0) return null
  const open = slice[start]
  return extractBalancedSection(slice, start, open, open === '{' ? '}' : ']')
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const compact = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8').trim()
    if (!decoded || /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded)) return null
    return decoded
  } catch (_) {
    return null
  }
}

function decodeRemote(value) {
  const remote = typeof value === 'string' ? value.trim() : ''
  if (/^https?:\/\//i.test(remote)) return remote
  const decoded = decodeBase64(remote)
  return decoded && (/^https?:\/\//i.test(decoded) || decoded.startsWith('/')) ? decoded : null
}

export function parseJkAnimeEpisodeUrl(candidate, baseUrl = `${JKANIME_URL}/`) {
  const normalized = safeHttpUrl(candidate, baseUrl)
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    if (!/(^|\.)jkanime\.net$/i.test(url.hostname)) return null
    const segments = url.pathname.split('/').filter(Boolean)
    const episodeText = segments.at(-1) || ''
    const epNum = Number(episodeText)
    if (!Number.isSafeInteger(epNum) || epNum < 1 || segments.length < 2) return null
    return { slug: segments.at(-2), epNum, epUrl: url.href }
  } catch (_) {
    return null
  }
}

function extractVideoIframeUrls(html, baseUrl) {
  const urls = []
  const videoPattern = /video\[\d+\]\s*=\s*(['"])([\s\S]*?)\1/g
  let match
  while ((match = videoPattern.exec(html))) {
    const fragment = match[2].replace(/\\(["'])/g, '$1').replace(/\\\//g, '/')
    const srcMatch = fragment.match(/<iframe\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/i)
    if (!srcMatch) continue
    const url = safeHttpUrl(srcMatch[2], baseUrl)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

function extractJkPlayerUrls(html, baseUrl) {
  const urls = []
  const pattern = /https?:\/\/(?:www\.)?jkanime\.net\/jkplayer\/[a-z0-9]+\?[^"'<>\s]+/gi
  for (const match of html.matchAll(pattern)) {
    const url = safeHttpUrl(match[0], baseUrl)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

export function extractJkAnimeM3u8Candidates(html) {
  const source = String(html || '').replace(/\\\//g, '/')
  const candidates = []
  const literal = /['"](https?:\/\/[^'"\s\\]+\.m3u8[^'"\s\\]*)['"]/gi
  const atob = /atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/gi
  for (const match of source.matchAll(literal)) {
    candidates.push({ index: match.index, url: match[1] })
  }
  for (const match of source.matchAll(atob)) {
    const url = decodeBase64(match[2])
    if (url && /^https?:\/\//i.test(url) && /\.m3u8(?:[?#]|$)/i.test(url)) {
      candidates.push({ index: match.index, url })
    }
  }
  return candidates
    .sort((a, b) => b.index - a.index)
    .map(item => item.url)
    .filter((url, index, all) => all.indexOf(url) === index)
}

export function extractJkAnimeLinks(html, baseUrl) {
  const source = String(html || '')
  const links = []
  const seen = new Set()
  const add = (url, server, kind, variant = null) => {
    const normalized = safeHttpUrl(url, baseUrl)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    links.push({ url: normalized, server: String(server || '').trim(), kind, variant })
  }

  const literal = extractVarLiteral(source, 'servers')
  let servers = []
  if (literal) {
    try {
      const parsed = JSON.parse(literal)
      if (Array.isArray(parsed)) servers = parsed
    } catch (_) {
      // No se ejecuta código remoto: solo se aceptan literales JSON válidos.
    }
  }

  const remoteMatch = source.match(/\b(?:var|let|const)\s+remote\s*=\s*(['"])(.*?)\1/i)
  const remoteBase = remoteMatch ? safeHttpUrl(remoteMatch[2], baseUrl) : null
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') continue
    const decoded = decodeRemote(entry.remote)
    if (decoded) add(decoded, entry.server || 'embed', 'stream', entry.lang || null)
    if (remoteBase && entry.slug) {
      const downloadUrl = `${remoteBase.replace(/\/$/, '')}/d/${encodeURIComponent(String(entry.slug))}/`
      add(downloadUrl, entry.server || 'embed', 'download', entry.lang || null)
    }
  }

  for (const url of extractVideoIframeUrls(source, baseUrl)) add(url, 'jkplayer', 'player')
  for (const url of extractJkPlayerUrls(source, baseUrl)) add(url, 'jkplayer', 'player')
  return links
}

// ─── Scraping de portada y servidores de JKAnime ──────────────────────────────

function isRecentBadge(text) {
  const normalized = String(text || '').trim().toLowerCase()
  return normalized.includes('hoy')
    || normalized.includes('ayer')
    || normalized.includes('hace ')
    || normalized.includes('recién')
    || normalized.includes('recien')
}

export function parseLatestEpisodesHtml(html, baseUrl = JKANIME_URL) {
  const $ = cheerio.load(String(html || ''))
  const lista = []
  const seenIds = new Set()

  const addEpisode = ($card, aTag) => {
    const href = aTag.attr('href') || ''
    if (!href) return
    const tiempo = $card.find('.badge-secondary, .badge').first().text().trim()
    if (!isRecentBadge(tiempo)) return
    const episodio = parseJkAnimeEpisodeUrl(href, baseUrl)
    if (!episodio) return
    const { slug, epNum, epUrl } = episodio
    const id = `jk-${slug.toLowerCase()}-${epNum}`
    if (seenIds.has(id)) return
    seenIds.add(id)

    const titulo = (
      $card.find('.card-title, h5, h6').first().text() ||
      aTag.attr('title') ||
      aTag.text() ||
      slug.replace(/-/g, ' ')
    ).replace(/\s+/g, ' ').trim()

    const imgEl = $card.find('img.card-img-top').first().length
      ? $card.find('img.card-img-top').first()
      : $card.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-animepic') || ''
    const imgUrl = safeHttpUrl(imgSrc, baseUrl) || ''

    lista.push({ id, slug, titulo, epNum, epUrl, imgUrl })
  }

  const cardSelector = $('#animes .dir1').length ? '#animes .dir1' : '#animes .card'
  $(cardSelector).each((_, el) => {
    const $card = $(el)
    addEpisode($card, $card.find('a[href]').first())
  })

  if (!lista.length) {
    $('#animes a[href]').each((_, el) => {
      const $a = $(el)
      const $card = $a.closest('.card, .dir1')
      if ($card.length) addEpisode($card, $a)
    })
  }

  return lista
}

async function fetchLatestEpisodesJK() {
  const { data } = await httpRequest(JKANIME_URL, { timeout: HTTP_TIMEOUT_MS, forceJk: true })
  return parseLatestEpisodesHtml(data, JKANIME_URL)
}

export function detectarServNombre(url, hint = '') {
  const u = `${String(url || '').toLowerCase()} ${String(hint || '').toLowerCase()}`
  if (/mega\.(?:nz|co\.nz)|\bmega\b/.test(u)) return 'mega'
  if (/mediafire/.test(u)) return 'mediafire'
  if (/mp4upload/.test(u)) return 'mp4upload'
  if (/jkanime\.net\/jkplayer\/|\bjkplayer\b|\bdesu\b|\bnozu\b|\bdesuka\b/.test(u)) return 'jkplayer'
  if (/voe\d*\.sx|\bvoe\b|susanexpectcare|kathyinformationwhether|stevenfamilyedge|walterprettytheir|markstyleall|lukecomparetwo|jilliandescribecompany/.test(u)) return 'voe'
  if (/filemoon|moonplayer/.test(u)) return 'filemoon'
  if (/streamwish|wishembed|hgcloud|awish|dwish|mwish|sfastwish/.test(u)) return 'streamwish'
  if (/vidhide|filelions|dhtpre|peytonepre/.test(u)) return 'vidhide'
  if (/streamtape|strtape/.test(u)) return 'streamtape'
  if (/dood|ds2play|d000d|d0000d|do0od/.test(u)) return 'doodstream'
  if (/ok\.ru|\bokru\b/.test(u)) return 'okru'
  if (/mixdrop|mdy48tn97/.test(u)) return 'mixdrop'
  return 'embed'
}

export function ordenarServidores(srvs) {
  return [...srvs].sort((a, b) => {
    const ia = SERVER_PRIORITY.indexOf(a.nombre)
    const ib = SERVER_PRIORITY.indexOf(b.nombre)
    const pa = ia === -1 ? 99 : ia
    const pb = ib === -1 ? 99 : ib
    if (pa !== pb) return pa - pb
    if (a.kind === 'download' && b.kind !== 'download') return -1
    if (b.kind === 'download' && a.kind !== 'download') return 1
    return 0
  })
}

async function scrapeServidoresJK(epUrl) {
  const { data } = await httpRequest(epUrl, {
    headers: { referer: `${JKANIME_URL}/` },
    timeout: HTTP_TIMEOUT_MS,
    forceJk: true,
  })
  const $ = cheerio.load(data)
  const srvs = []
  const seenUrls = new Set()

  const addServer = (url, hint = '', kind = 'stream') => {
    const normalizedUrl = safeHttpUrl(url, epUrl)
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return
    const host = new URL(normalizedUrl).hostname.toLowerCase()
    if (BLOCKED_HOSTS_RE.test(host)) return
    seenUrls.add(normalizedUrl)
    const nombre = detectarServNombre(normalizedUrl, hint)
    srvs.push({
      nombre,
      url: normalizedUrl,
      directo: nombre === 'mega' || nombre === 'mediafire',
      kind,
    })
  }

  for (const link of extractJkAnimeLinks(data, epUrl)) {
    addServer(link.url, link.server, link.kind)
  }

  let epId = null
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    const m = code.match(/\/ajax\/download_episode\/(\d+)/) ||
      code.match(/(?:ep_id|episode_id|episodeId)\s*[:=]\s*['"]?(\d+)['"]?/)
    if (m) { epId = m[1]; return false }
  })

  if (epId && !srvs.some(s => s.directo)) {
    try {
      const ajaxRes = await httpRequest(`${JKANIME_URL}/ajax/download_episode/${epId}`, {
        headers: {
          referer: epUrl,
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json, text/plain, */*',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
        },
        timeout: 12_000,
        retries: 1,
        forceJk: true,
      })
      const payload = ajaxRes.data
      if (payload && typeof payload === 'object') {
        if (typeof payload.url === 'string') addServer(payload.url, payload.server || '', 'download')
        const list = Array.isArray(payload.links) ? payload.links : Array.isArray(payload.downloads) ? payload.downloads : []
        for (const item of list) {
          if (typeof item === 'string') addServer(item, '', 'download')
          else if (item?.url) addServer(item.url, item.server || item.name || '', 'download')
        }
      } else if (typeof payload === 'string') {
        for (const match of payload.matchAll(/https?:\/\/[^"'\s<>]+/gi)) {
          const detected = detectarServNombre(match[0])
          if (detected !== 'embed') addServer(match[0], detected, 'download')
        }
      }
    } catch (_) {}
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const resolved = safeHttpUrl(href, epUrl)
    if (!resolved) return
    const host = new URL(resolved).hostname.toLowerCase()
    if (/(?:^|\.)(?:mega\.(?:nz|co\.nz)|mediafire\.com|mp4upload\.com)$/i.test(host)) {
      addServer(resolved, $(el).text(), 'download')
    }
  })

  if (!srvs.length) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src) addServer(src, '', 'player')
    })
  }

  return srvs
}

// ─── Resolvers y motores de descarga ──────────────────────────────────────────

export function jsUnpack(packed) {
  try {
    const m = String(packed || '').match(/}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/)
    if (!m) return null
    const payload = m[1].replace(/\\'/g, "'")
    const radix = parseInt(m[2], 10) || 36
    const symtab = m[4].split('|')
    return payload.replace(/\b[a-zA-Z0-9_]+\b/g, (word) => {
      const idx = parseInt(word, radix)
      return (Number.isInteger(idx) && symtab[idx]) ? symtab[idx] : word
    })
  } catch (_) {
    return null
  }
}

export function extraerUrlVideo(code) {
  const source = String(code || '').replace(/\\\//g, '/')
  const patrones = [
    /sources\s*:\s*\[\s*\{[^}]*?(?:file|src)\s*:\s*["']([^"']+)["']/i,
    /(?:file|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/i,
  ]
  for (const re of patrones) {
    const m = source.match(re)
    if (m?.[1] && /^https?:\/\//i.test(m[1])) return m[1]
  }
  return null
}

export function extractMediaFireDirectUrl(html, baseUrl = 'https://www.mediafire.com/') {
  const source = String(html || '')
  const scrambled = source.match(/data-scrambled-url=["']([A-Za-z0-9+/=_-]+)["']/i)?.[1]
  if (scrambled) {
    const decoded = decodeBase64(scrambled)
    const safe = safeHttpUrl(decoded, baseUrl)
    if (safe) return safe
  }
  const patterns = [
    /href=["'](https?:\/\/download\d*\.mediafire\.com\/[^"']+)["']/i,
    /id=["']downloadButton["'][^>]+href=["']([^"']+)["']/i,
    /href=["']([^"']+)["'][^>]+id=["']downloadButton["']/i,
    /"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
  ]
  for (const re of patterns) {
    const candidate = source.match(re)?.[1]
    const safe = safeHttpUrl(candidate, baseUrl)
    if (safe) return safe
  }
  return null
}

function createIdleWatchdog(onIdle, idleMs = IDLE_TIMEOUT_MS) {
  let lastActivity = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs) {
      clearInterval(timer)
      onIdle()
    }
  }, 5_000)
  timer.unref?.()
  return {
    ping() { lastActivity = Date.now() },
    stop() { clearInterval(timer) },
  }
}

async function validateVideoFile(filePath) {
  const stat = await fsp.stat(filePath)
  if (stat.size < MIN_VALID_BYTES) {
    throw new Error(`Archivo descargado demasiado pequeño (${formatBytes(stat.size)})`)
  }
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new Error(`Archivo (${formatBytes(stat.size)}) supera el límite de 2 GB`)
  }
  const fh = await fsp.open(filePath, 'r')
  try {
    const head = Buffer.alloc(Math.min(512, stat.size))
    await fh.read(head, 0, head.length, 0)
    const sample = head.toString('utf8').trimStart().toLowerCase()
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<\?xml\b|\{"(?:error|status|message)")/i.test(sample)) {
      throw new Error('El servidor devolvió una página HTML/error en lugar de video')
    }
  } finally {
    await fh.close()
  }
  return stat
}

async function downloadParallelRanges(directUrl, partPath, totalBytes, headers, watchdog, signal) {
  const chunkSize = Math.ceil(totalBytes / PARALLEL_THREADS)
  const ranges = []
  for (let i = 0; i < PARALLEL_THREADS; i += 1) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize - 1, totalBytes - 1)
    if (start > end) break
    ranges.push({ start, end })
  }

  const fh = await fsp.open(partPath, 'w')
  try {
    await Promise.all(ranges.map(async ({ start, end }) => {
      const res = await rawFetch(directUrl, {
        headers: { ...headers, range: `bytes=${start}-${end}` },
        timeout: DL_TIMEOUT_MS,
        signal,
      })
      if (res.status !== 206) {
        await cancelBodyQuietly(res)
        throw new Error(`HTTP ${res.status} (se esperaba 206)`)
      }
      const ct = getHeader(res.headers, 'content-type').toLowerCase()
      if (/text\/html|application\/json|javascript/i.test(ct)) {
        await cancelBodyQuietly(res)
        throw new Error(`El servidor devolvió ${ct} en lugar de video`)
      }
      const stream = toNodeReadable(res)
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
      }
      const expected = end - start + 1
      if (pos - start !== expected) {
        throw new Error(`Bloque incompleto (${pos - start}/${expected} bytes)`)
      }
    }))
  } finally {
    await fh.close()
  }
}

async function downloadDirectHttp(directUrl, destPath, { referer = '', label = 'HTTP' } = {}) {
  const partPath = `${destPath}.part`
  const headers = normalizeHeaders({
    accept: '*/*',
    ...(referer ? { referer } : {}),
  })

  let sizeBytes = 0
  let supportsRanges = false
  try {
    const head = await rawFetch(directUrl, { method: 'HEAD', headers, timeout: 12_000 })
    await cancelBodyQuietly(head)
    if (head.ok) {
      const ct = getHeader(head.headers, 'content-type').toLowerCase()
      if (/text\/html|application\/json|javascript/i.test(ct)) {
        throw new Error(`${label}: devolvió ${ct} en lugar de video`)
      }
      sizeBytes = Number(getHeader(head.headers, 'content-length') || 0) || 0
      supportsRanges = /bytes/i.test(getHeader(head.headers, 'accept-ranges'))
    }
  } catch (err) {
    if (/en lugar de video/i.test(err.message)) throw err
  }

  if (sizeBytes > MAX_VIDEO_BYTES) {
    throw new Error(`${label}: el video (${formatBytes(sizeBytes)}) supera el límite de 2 GB`)
  }

  const controller = new AbortController()
  const watchdog = createIdleWatchdog(() => {
    controller.abort(new Error(`${label}: sin datos durante ${IDLE_TIMEOUT_MS / 1000}s`))
  })

  try {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    let downloadedParallel = false
    if (supportsRanges && sizeBytes >= MIN_PARALLEL_BYTES) {
      try {
        await downloadParallelRanges(directUrl, partPath, sizeBytes, headers, watchdog, controller.signal)
        downloadedParallel = true
      } catch (err) {
        await fsp.rm(partPath, { force: true }).catch(() => {})
        console.warn(`[jk-notify][${label}] Descarga paralela falló (${err.message}), probando modo secuencial`)
      }
    }

    if (!downloadedParallel) {
      const res = await rawFetch(directUrl, {
        headers,
        timeout: DL_TIMEOUT_MS,
        signal: controller.signal,
      })
      if (!res.ok) {
        await cancelBodyQuietly(res)
        throw new Error(`${label}: HTTP ${res.status}`)
      }
      const ct = getHeader(res.headers, 'content-type').toLowerCase()
      if (/text\/html|application\/json|javascript/i.test(ct)) {
        await cancelBodyQuietly(res)
        throw new Error(`${label}: devolvió ${ct} en lugar de video`)
      }
      const expected = Number(getHeader(res.headers, 'content-length') || 0) || 0
      if (expected > MAX_VIDEO_BYTES) {
        await cancelBodyQuietly(res)
        throw new Error(`${label}: el video (${formatBytes(expected)}) supera el límite de 2 GB`)
      }

      let bytes = 0
      const guard = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length
          watchdog.ping()
          if (bytes > MAX_VIDEO_BYTES) {
            cb(new Error(`${label}: el video supera el límite de 2 GB`))
          } else {
            cb(null, chunk)
          }
        },
      })
      await pipeline(toNodeReadable(res), guard, fs.createWriteStream(partPath))
    }

    await validateVideoFile(partPath)
    await fsp.rename(partPath, destPath)
    return destPath
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    throw err
  } finally {
    watchdog.stop()
  }
}

async function descargarMega(megaUrl, outputDir, fileName) {
  const raw = String(megaUrl || '').trim()
  if (/\/folder\//i.test(raw) || /#F!/i.test(raw)) {
    throw new Error('Mega: enlaces de carpeta no soportados')
  }
  const m = raw.match(/mega\.(?:nz|co\.nz)\/(?:file|embed)\/([A-Za-z0-9_-]{8,})[#!]([A-Za-z0-9_-]{20,})/i)
    || raw.match(/mega\.(?:nz|co\.nz)\/#!?([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{20,})/i)
  const url = m ? `https://mega.nz/file/${m[1]}#${m[2]}` : raw

  const destPath = path.join(outputDir, fileName)
  const partPath = `${destPath}.part`
  let lastErr = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    const file = MegaFile.fromURL(url)
    let fileStream = null
    let watchdog = null
    try {
      await file.loadAttributes()
      const total = Number(file.size || 0)
      if (total > MAX_VIDEO_BYTES) {
        throw new Error(`Mega: el archivo (${formatBytes(total)}) supera el límite de 2 GB`)
      }
      fileStream = file.download({
        maxConnections: MEGA_MAX_CONNECTIONS,
        initialChunkSize: MEGA_CHUNK_SIZE,
        chunkSizeIncrement: 0,
        maxChunkSize: MEGA_CHUNK_SIZE,
        forceHttps: true,
      })
      watchdog = createIdleWatchdog(() => {
        fileStream.destroy(new Error(`Mega: sin datos durante ${IDLE_TIMEOUT_MS / 1000}s`))
      })
      const ping = new Transform({
        transform(chunk, _enc, cb) {
          watchdog.ping()
          cb(null, chunk)
        },
      })
      await pipeline(fileStream, ping, fs.createWriteStream(partPath))
      await validateVideoFile(partPath)
      await fsp.rename(partPath, destPath)
      return destPath
    } catch (err) {
      lastErr = err
      await fsp.rm(partPath, { force: true }).catch(() => {})
      if (attempt < 2 && !/límite de 2 GB|carpeta/i.test(err.message)) {
        await sleep(2_000)
        continue
      }
      throw new Error(`Mega: ${err.message}`)
    } finally {
      watchdog?.stop()
    }
  }
  throw new Error(`Mega: ${lastErr?.message || 'fallo desconocido'}`)
}

async function descargarMediaFire(mfUrl, outputDir, fileName) {
  let mfPage
  try {
    const res = await httpRequest(mfUrl, { timeout: 15_000, retries: 2 })
    mfPage = res.data
  } catch (err) {
    throw new Error(`MediaFire: error al obtener página — ${err.message}`)
  }

  const mfLink = extractMediaFireDirectUrl(mfPage, mfUrl)
  if (!mfLink) throw new Error('MediaFire: no se encontró enlace de descarga directa')

  const destPath = path.join(outputDir, fileName)
  return downloadDirectHttp(mfLink, destPath, {
    referer: 'https://www.mediafire.com/',
    label: 'MediaFire',
  })
}

async function resolverEmbed(embedUrl, pageReferer = `${JKANIME_URL}/`) {
  const u = embedUrl.toLowerCase()

  if (/jkanime\.net\/jkplayer\//i.test(u)) {
    try {
      const { data } = await httpRequest(embedUrl, {
        headers: { referer: pageReferer },
        timeout: HTTP_TIMEOUT_MS,
        forceJk: true,
      })
      for (const candidate of extractJkAnimeM3u8Candidates(data)) {
        try {
          const manifest = await httpRequest(candidate, {
            headers: { referer: embedUrl },
            timeout: 12_000,
            retries: 1,
          })
          if (String(manifest.data).includes('#EXTM3U')) {
            return { url: candidate, type: 'hls', referer: embedUrl }
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null
  }

  if (u.includes('mp4upload')) {
    const idMatch = embedUrl.match(/mp4upload\.com\/(?:embed-)?([A-Za-z0-9_-]+)/i)
    const pages = idMatch
      ? [`https://www.mp4upload.com/embed-${idMatch[1]}.html`, `https://www.mp4upload.com/${idMatch[1]}`]
      : [embedUrl]
    for (const pageUrl of pages) {
      try {
        const { data } = await httpRequest(pageUrl, {
          headers: { referer: 'https://www.mp4upload.com/' },
          timeout: HTTP_TIMEOUT_MS,
        })
        const packed = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
        const code = (packed ? jsUnpack(packed[0]) : null) || data
        const direct =
          code.match(/player\.src\(\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)?.[1] ||
          code.match(/https?:\/\/(?:www\d{1,2}|s\d+)\.mp4upload\.com(?::\d+)?\/d\/[a-z0-9]{20,80}\/[^"'\s<>]+/i)?.[0] ||
          extraerUrlVideo(code)
        if (direct) {
          return {
            url: direct,
            type: /\.m3u8(?:[?#]|$)/i.test(direct) ? 'hls' : 'mp4',
            referer: pageUrl,
          }
        }
      } catch (_) {}
    }
    return null
  }

  if (/voe\d*\.sx|susanexpectcare|kathyinformationwhether|stevenfamilyedge|walterprettytheir|markstyleall|lukecomparetwo|jilliandescribecompany/.test(u)) {
    try {
      let currentUrl = embedUrl
      for (let hop = 0; hop < 4; hop += 1) {
        const { data, url: finalUrl } = await httpRequest(currentUrl, {
          headers: { referer: currentUrl },
          timeout: HTTP_TIMEOUT_MS,
        })
        const effectiveUrl = finalUrl || currentUrl
        const mMp4 = data.match(/["']mp4["']\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1]
        if (mMp4) return { url: mMp4.replace(/\\\//g, '/'), type: 'mp4', referer: effectiveUrl }
        const mHls = data.match(/["']hls["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)?.[1]
          || data.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)?.[1]
        if (mHls) return { url: mHls.replace(/\\\//g, '/'), type: 'hls', referer: effectiveUrl }
        const mAtob = data.match(/["']hls["']\s*:\s*atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/i)?.[1]
        if (mAtob) {
          const decoded = decodeBase64(mAtob)
          if (decoded && /^https?:\/\//i.test(decoded)) {
            return { url: decoded, type: 'hls', referer: effectiveUrl }
          }
        }
        const jsRedirect = data.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i)?.[1]
          || data.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i)?.[1]
        const nextUrl = safeHttpUrl(jsRedirect, effectiveUrl)
        if (!nextUrl || nextUrl === effectiveUrl) break
        currentUrl = nextUrl
      }
    } catch (_) {}
    return null
  }

  if (u.includes('dood') || u.includes('ds2play') || u.includes('d000d') || u.includes('d0000d')) {
    try {
      const target = embedUrl.replace(/\/(d|watch)\//, '/e/')
      const res = await httpRequest(target, { headers: { referer: 'https://dood.wf/' }, timeout: HTTP_TIMEOUT_MS })
      const host = new URL(res.url || target).origin
      const pass = res.data.match(/\/pass_md5\/[^'"<\s]*/)?.[0]
      if (!pass) return null
      const token = pass.split('/').pop()
      const r2 = await httpRequest(host + pass, { headers: { referer: res.url || target }, timeout: HTTP_TIMEOUT_MS })
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      const rand = Array.from({ length: 10 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
      const finalMedia = `${String(r2.data).trim()}${rand}?token=${token}&expiry=${Date.now()}`
      if (/^https?:\/\//i.test(finalMedia)) {
        return { url: finalMedia, type: 'mp4', referer: res.url || target }
      }
    } catch (_) {}
    return null
  }

  if (u.includes('streamtape') || u.includes('strtape')) {
    try {
      const { data, url: finalUrl } = await httpRequest(embedUrl, {
        headers: { referer: embedUrl },
        timeout: HTTP_TIMEOUT_MS,
      })
      const m = data.match(/getElementById\(['"](?:robot|norobot)link['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)(?:\.substring\((\d+)\))?(?:\.substring\((\d+)\))?/i)
      if (m) {
        let suffix = m[2]
        if (m[3]) suffix = suffix.substring(Number(m[3]))
        if (m[4]) suffix = suffix.substring(Number(m[4]))
        const media = safeHttpUrl(`https:${m[1]}${suffix}&stream=1`, finalUrl || embedUrl)
        if (media) return { url: media, type: 'mp4', referer: finalUrl || embedUrl }
      }
    } catch (_) {}
    return null
  }

  if (/filemoon|moonplayer|streamwish|wishembed|hgcloud|vidhide|filelions|dhtpre|peytonepre/.test(u)) {
    try {
      const { data, url: finalUrl } = await httpRequest(embedUrl, {
        headers: { referer: embedUrl },
        timeout: HTTP_TIMEOUT_MS,
      })
      const packed = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const unpacked = packed ? jsUnpack(packed[0]) : null
      const src = (unpacked && extraerUrlVideo(unpacked)) || extraerUrlVideo(data)
      if (src) {
        return {
          url: src,
          type: /\.m3u8(?:[?#]|$)/i.test(src) ? 'hls' : 'mp4',
          referer: finalUrl || embedUrl,
        }
      }
    } catch (_) {}
    return null
  }

  return null
}

function spawnWithTimeout(bin, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errBuf = ''
    proc.stderr.on('data', (chunk) => {
      errBuf += chunk.toString()
      if (errBuf.length > 8192) errBuf = errBuf.slice(-8192)
    })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${label} timeout`))
    }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(errBuf.trim() || `${label} código ${code}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function descargarConFfmpegHls(m3u8Url, destPath, referer) {
  const partPath = `${destPath}.part.mp4`
  const ua = getEffectiveUa(false)
  const headerLines = `User-Agent: ${ua}\r\nReferer: ${referer}\r\n`
  try {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    await spawnWithTimeout(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', headerLines,
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      partPath,
    ], DL_TIMEOUT_MS, 'ffmpeg')
    await validateVideoFile(partPath)
    await fsp.rename(partPath, destPath)
    return destPath
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    throw err
  }
}

async function descargarEmbed(embedUrl, outputDir, fileName, pageReferer) {
  const host = new URL(embedUrl).hostname.toLowerCase()
  if (BLOCKED_HOSTS_RE.test(host)) throw new Error(`Servidor sin soporte: ${host}`)

  const isJkPlayer = /jkanime\.net\/jkplayer\//i.test(embedUrl)
  const resolved = await resolverEmbed(embedUrl, pageReferer)
  let videoUrl = resolved?.url || embedUrl
  let videoType = resolved?.type || (/\.m3u8(?:[?#]|$)/i.test(videoUrl) ? 'hls' : 'unknown')
  let videoReferer = resolved?.referer || pageReferer

  if (!resolved) {
    if (isJkPlayer) throw new Error('JKPlayer no expuso un manifest HLS accesible desde el servidor')
    try {
      const { data } = await httpRequest(embedUrl, { headers: { referer: pageReferer }, timeout: 12_000, retries: 1 })
      const extracted = extraerUrlVideo(data)
      if (extracted) {
        videoUrl = extracted
        videoType = /\.m3u8(?:[?#]|$)/i.test(extracted) ? 'hls' : 'mp4'
        videoReferer = embedUrl
      }
    } catch (_) {}
  }

  const destPath = path.join(outputDir, fileName)
  const refererHeader = videoReferer === JKANIME_URL ? `${JKANIME_URL}/` : videoReferer

  // Descarga directa paralela para MP4 resueltos (mucho más rápido que invocar yt-dlp).
  if (videoType === 'mp4') {
    try {
      return await downloadDirectHttp(videoUrl, destPath, {
        referer: refererHeader,
        label: detectarServNombre(embedUrl),
      })
    } catch (err) {
      console.warn(`[jk-notify] Descarga directa MP4 falló (${err.message}), intentando yt-dlp`)
    }
  }

  const outTemplate = path.join(outputDir, 'video.%(ext)s')
  const cmdArgs = [
    '--no-check-certificate', '--no-warnings',
    '--concurrent-fragments', '8',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${getEffectiveUa(false)}`,
    '--add-header', `Referer: ${refererHeader}`,
    '-o', outTemplate,
    videoUrl,
  ]

  try {
    await spawnWithTimeout('yt-dlp', cmdArgs, DL_TIMEOUT_MS, 'yt-dlp')
    const archivos = (await fsp.readdir(outputDir)).filter(f => /\.(mp4|mkv|webm)$/i.test(f))
    if (!archivos.length) throw new Error('yt-dlp no generó ningún archivo')
    const srcPath = path.join(outputDir, archivos[0])
    await validateVideoFile(srcPath)
    await fsp.rename(srcPath, destPath)
    return destPath
  } catch (ytErr) {
    if (videoType === 'hls' || /\.m3u8(?:[?#]|$)/i.test(videoUrl)) {
      console.warn(`[jk-notify] yt-dlp falló (${ytErr.message}), probando ffmpeg-static para HLS`)
      return descargarConFfmpegHls(videoUrl, destPath, refererHeader)
    }
    throw ytErr
  }
}

// ─── Persistencia atómica con respaldo ante corrupción ────────────────────────

function loadJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch (err) {
    if (fs.existsSync(file)) {
      console.error(`[jk-notify] Archivo JSON corrupto (${path.basename(file)}): ${err.message}`)
      try {
        fs.renameSync(file, `${file}.bak-${Date.now()}`)
      } catch (_) {}
    }
    return fallback
  }
}

function saveJsonAtomic(file, data) {
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2))
    fs.renameSync(tempFile, file)
  } catch (err) {
    try { fs.unlinkSync(tempFile) } catch (_) {}
    console.error(`[jk-notify] No se pudo guardar ${path.basename(file)}: ${err.message}`)
  }
}

function loadSeen() { return loadJson(SEEN_FILE) }
function saveSeen(d) { saveJsonAtomic(SEEN_FILE, d) }
function loadState() { return loadJson(STATE_FILE) }
function saveState(d) { saveJsonAtomic(STATE_FILE, d) }

// ─── Portadas AniList (caché acotada con TTL negativo) ────────────────────────

function getCachedCover(key) {
  if (!key || !global.jkCoverCache.has(key)) return undefined
  const value = global.jkCoverCache.get(key)
  if (value === null) {
    const negAt = global.jkCoverNegTime.get(key) || 0
    if (Date.now() - negAt >= COVER_NEGATIVE_TTL_MS) {
      global.jkCoverCache.delete(key)
      global.jkCoverNegTime.delete(key)
      return undefined
    }
  }
  return value
}

function setCachedCover(key, cover) {
  if (!key) return
  while (global.jkCoverCache.size >= COVER_CACHE_MAX) {
    const oldest = global.jkCoverCache.keys().next().value
    if (oldest === undefined) break
    global.jkCoverCache.delete(oldest)
    global.jkCoverNegTime.delete(oldest)
  }
  global.jkCoverCache.set(key, cover)
  if (cover === null) global.jkCoverNegTime.set(key, Date.now())
  else global.jkCoverNegTime.delete(key)
}

async function getAniListCover(titulo, slug = '', epNum = 0) {
  const candidates = [...new Set([
    cleanTitle(titulo, epNum),
    String(titulo || '').trim(),
    String(slug || '').replace(/[-_]+/g, ' ').trim(),
  ].filter(Boolean))]
  const key = candidates[0]?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!key) return null

  const cached = getCachedCover(key)
  if (cached !== undefined) return cached

  const query = 'query ($search: String) { Page(perPage: 3) { media(search: $search, type: ANIME) { coverImage { extraLarge large medium } } } }'
  for (const search of candidates) {
    try {
      const res = await httpRequest(ANILIST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables: { search } }),
        timeout: 10_000,
        retries: 1,
        responseType: 'json',
        disableDefaultHeaders: true,
      })
      const media = res.data?.data?.Page?.media || []
      const cover = media[0]?.coverImage?.extraLarge || media[0]?.coverImage?.large || media[0]?.coverImage?.medium
      if (cover) {
        setCachedCover(key, cover)
        return cover
      }
    } catch (_) {}
  }

  setCachedCover(key, null)
  return null
}

// ─── Envío de episodios y cola ────────────────────────────────────────────────

async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl, slug = '' } = ep
  const fileName = buildFileName(titulo, epNum, slug)
  await fsp.mkdir(TEMP_VIDEOS_DIR, { recursive: true })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `jk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)
  await fsp.mkdir(tmpDir, { recursive: true })

  try {
    const srvs = await scrapeServidoresJK(epUrl)
    if (!srvs.length) throw new Error('No se encontraron servidores de video')

    let coverBuffer = null
    const downloadCover = async (coverUrl) => {
      const imgRes = await httpRequest(coverUrl, {
        responseType: 'buffer',
        headers: isJKAnimeUrl(coverUrl) ? { referer: `${JKANIME_URL}/` } : {},
        timeout: 10_000,
        retries: 1,
      })
      return (Buffer.isBuffer(imgRes.data) && imgRes.data.length > 512) ? imgRes.data : null
    }
    try {
      const coverUrl = await getAniListCover(titulo, slug, epNum) || imgUrl
      if (coverUrl) coverBuffer = await downloadCover(coverUrl)
    } catch (err) {
      console.warn(`[jk-notify] No se pudo obtener la portada de ${titulo}: ${err.message}`)
    }
    if (!coverBuffer) {
      try {
        const ogUrl = await getOpenGraphImage(epUrl)
        if (ogUrl) coverBuffer = await downloadCover(ogUrl)
      } catch (err) {
        console.warn(`[jk-notify] Portada OpenGraph.io falló para ${titulo}: ${err.message}`)
      }
    }

    const ahora = formatClock()
    const caption = `*✨Nuevo Episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> 🇯🇵 ${titulo}\n> 🆕 Capítulo: *${epNum}*\n> 🕐 Publicado: *${ahora}*\n> 🌐 Ver online: ${epUrl}\n> 📡 Fuente: *${SOURCE_LABEL}*\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`
    if (coverBuffer) await conn.sendMessage(chatId, { image: coverBuffer, caption })
    else await conn.sendMessage(chatId, { text: caption })

    let videoPath = null
    const errores = []
    for (const srv of ordenarServidores(srvs).slice(0, 6)) {
      try {
        if (srv.nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        else videoPath = await descargarEmbed(srv.url, tmpDir, fileName, epUrl)
        break
      } catch (err) {
        errores.push(`${srv.nombre}: ${err.message}`)
        console.warn(`[jk-notify] Servidor ${srv.nombre} falló para ${titulo} ep ${epNum}: ${err.message}`)
        for (const f of await fsp.readdir(tmpDir).catch(() => [])) {
          await fsp.rm(path.join(tmpDir, f), { recursive: true, force: true }).catch(() => {})
        }
      }
    }

    if (!videoPath) {
      throw new Error(`Todos los servidores fallaron (${errores.slice(0, 3).join(' | ') || 'sin detalle'})`)
    }

    const stat = await fsp.stat(videoPath)
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(videoPath) } catch (_) {}

    await conn.sendMessage(chatId, {
      document: { url: videoPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${SOURCE_LABEL}`,
    })
    global.jkLastSent = { titulo, epNum, at: Date.now(), sizeMB }
    console.log(`[jk-notify] 🚀 Enviado como documento: ${fileName} (${sizeMB} MB)`)
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function removeQueueItem(item) {
  const idx = global.jkEpisodeQueue.indexOf(item)
  if (idx !== -1) global.jkEpisodeQueue.splice(idx, 1)
  global.jkQueuedIds.delete(`${item.chatId}:${item.ep.id}`)
}

async function procesarCola() {
  if (global.jkQueueRunning || !global.jkEpisodeQueue.length) return
  global.jkQueueRunning = true
  try {
    while (global.jkEpisodeQueue.length) {
      const item = global.jkEpisodeQueue[0]
      const { chatId, ep } = item
      global.jkCurrentJob = { chatId, titulo: ep.titulo, epNum: ep.epNum, startedAt: Date.now() }

      let finished = false
      for (let intento = 1; intento <= 3 && !finished; intento += 1) {
        const conn = global.jkConn
        if (!conn) {
          await sleep(180_000)
          continue
        }
        try {
          await enviarEpisodio(chatId, ep, conn)
          finished = true
          removeQueueItem(item)
          global.jkLastError = null

          const seen = loadSeen()
          if (!Array.isArray(seen[chatId])) seen[chatId] = []
          if (!seen[chatId].includes(ep.id)) seen[chatId].push(ep.id)
          if (seen[chatId].length > MAX_SEEN_PER_CHAT) seen[chatId] = seen[chatId].slice(-MAX_SEEN_PER_CHAT)
          saveSeen(seen)
        } catch (err) {
          global.jkLastError = { message: err.message, at: Date.now() }
          const transient = TRANSIENT_SEND_ERROR_RE.test(String(err?.message || ''))
          if (transient && intento < 3) {
            await sleep(intento * 120_000)
          } else if (transient && (item.requeues || 0) < MAX_REQUEUES) {
            item.requeues = (item.requeues || 0) + 1
            const idx = global.jkEpisodeQueue.indexOf(item)
            if (idx !== -1) global.jkEpisodeQueue.splice(idx, 1)
            global.jkEpisodeQueue.push(item)
            finished = true
            await sleep(180_000)
          } else {
            removeQueueItem(item)
            finished = true
            try {
              await global.jkConn?.sendMessage(chatId, {
                text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}`,
              })
            } catch (_) {}
          }
        }
      }

      global.jkCurrentJob = null
      if (global.jkEpisodeQueue.length) await sleep(QUEUE_DELAY_MS)
    }
  } finally {
    global.jkCurrentJob = null
    global.jkQueueRunning = false
  }
}

async function checkNuevosEpisodios(chatId, conn, { throwOnError = false } = {}) {
  if (global.jkCheckingChats.has(chatId)) return { skipped: true, queued: 0 }
  global.jkCheckingChats.add(chatId)
  try {
    let lista = []
    try {
      lista = await fetchLatestEpisodesJK()
      global.jkLastCheckAt = Date.now()
      global.jkLastError = null
    } catch (err) {
      global.jkLastCheckAt = Date.now()
      global.jkLastError = { message: err.message, at: Date.now() }
      console.warn(`[jk-notify] Chequeo falló: ${err.message}`)
      if (throwOnError) throw err
      return { skipped: false, queued: 0 }
    }

    if (!lista.length) return { skipped: false, queued: 0 }

    const seen = loadSeen()
    if (!Array.isArray(seen[chatId])) seen[chatId] = []
    const seenSet = new Set(seen[chatId])
    const nuevos = lista.filter(e => !seenSet.has(e.id) && !global.jkQueuedIds.has(`${chatId}:${e.id}`))
    if (!nuevos.length) return { skipped: false, queued: 0 }

    if (nuevos.length > 1) {
      try {
        await conn.sendMessage(chatId, {
          text: `📋 *${nuevos.length} episodios nuevos detectados*\n\n` +
            nuevos.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)} [${SOURCE_LABEL}]`).join('\n') +
            '\n\n⏳ _Se enviarán de uno en uno..._',
        })
      } catch (_) {}
    }

    for (const ep of nuevos) {
      global.jkEpisodeQueue.push({ chatId, ep, requeues: 0 })
      global.jkQueuedIds.add(`${chatId}:${ep.id}`)
    }
    procesarCola().catch(() => {})
    return { skipped: false, queued: nuevos.length }
  } finally {
    global.jkCheckingChats.delete(chatId)
  }
}

// ─── Programador y watchdog ───────────────────────────────────────────────────

function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.jkConn = conn
  if (global.jkActiveChats.has(chatId)) clearInterval(global.jkActiveChats.get(chatId).timer)
  const timer = setInterval(() => {
    const c = global.jkConn
    if (c) checkNuevosEpisodios(chatId, c).catch(() => {})
  }, intervalMin * 60 * 1000)
  timer.unref?.()
  global.jkActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState()
  state[chatId] = { intervalMin, startedAt: Date.now() }
  saveState(state)
}

function detenerNotificador(chatId) {
  const entry = global.jkActiveChats.get(chatId)
  if (entry) {
    clearInterval(entry.timer)
    global.jkActiveChats.delete(chatId)
  }
  const state = loadState()
  delete state[chatId]
  saveState(state)
}

function restaurarNotificadores(conn) {
  if (!conn) return
  for (const [chatId, cfg] of Object.entries(loadState())) {
    if (!global.jkActiveChats.has(chatId)) {
      iniciarNotificador(chatId, conn, cfg?.intervalMin || CHECK_INTERVAL_DEFAULT)
    }
  }
}

if (!IS_TEST_RUN) {
  if (global.jkWatchdog) clearInterval(global.jkWatchdog)
  global.jkWatchdog = setInterval(() => restaurarNotificadores(global.jkConn), 2 * 60 * 1000)
  global.jkWatchdog.unref?.()
}

// ─── Handler de comandos ──────────────────────────────────────────────────────

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (conn) global.jkConn = conn

  if (command === 'jkstart') {
    const min = parseInt(text?.trim(), 10)
    const intervalMin = (!Number.isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, {
      text: `✅ *Notificador JKAnime activado*\n\n╭━━━━━━〔 📡 〕━━━━━━\n┃ ⏱️ Intervalo: *${intervalMin} min*\n┃ 🇯🇵 ${SOURCE_LABEL}\n┃ 💬 Chat registrado\n╰━━━━━━━━━━━━━━━━━━\n\n_Usa ${usedPrefix}jkstop para detener._`,
    }, { quoted: m })

    try {
      const lista = await fetchLatestEpisodesJK()
      const seen = loadSeen()
      if (!Array.isArray(seen[m.chat])) seen[m.chat] = []
      const seenSet = new Set(seen[m.chat])
      for (const ep of lista) {
        if (!seenSet.has(ep.id)) {
          seen[m.chat].push(ep.id)
          seenSet.add(ep.id)
        }
      }
      seen[m.chat] = seen[m.chat].slice(-MAX_SEEN_PER_CHAT)
      saveSeen(seen)
      await conn.sendMessage(m.chat, {
        text: `📋 *${lista.length}* episodios de JKAnime registrados como base.\n_Solo los nuevos se enviarán._`,
      }, { quoted: m })
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `⚠️ Chequeo inicial falló: ${err.message}` }, { quoted: m })
    }
    return
  }

  if (command === 'jkstop') {
    if (!global.jkActiveChats.has(m.chat)) return m.reply('ℹ️ El notificador no estaba activo.')
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}jkstart para reactivar._`)
  }

  if (command === 'jkstatus') {
    await getWreq()
    const active = global.jkActiveChats.has(m.chat)
    const entry = global.jkActiveChats.get(m.chat)
    const cola = global.jkEpisodeQueue.filter(i => i.chatId === m.chat)
    const vistos = (loadSeen()[m.chat] || []).length
    const httpLabel = wreqUnavailable ? 'fetch nativo (fallback)' : `wreq-js (${activeProfile})`
    const extras = [
      JK_PROXY_URL ? 'proxy' : null,
      jkRuntime.flareUrl ? 'FlareSolverr' : null,
      jkRuntime.cookie ? 'cookie' : null,
      scraperApisAvailable() ? `scraping: ${activeScraperLabels().join(' → ')}` : null,
    ].filter(Boolean).join(', ')
    const job = global.jkCurrentJob
    const lines = [
      '📡 *Estado JKAnime*',
      '',
      active ? `✅ *Activo* — cada ${entry.intervalMin} min` : '🔴 *Inactivo*',
      `🌐 Cliente HTTP: *${httpLabel}*${extras ? ` (${extras})` : ''}`,
      `📋 Cola: *${cola.length}* pendiente(s)`,
      `🔵 Procesando: *${global.jkQueueRunning ? 'Sí' : 'No'}*${job ? ` (${job.titulo} ep ${zeroPad(job.epNum)})` : ''}`,
      `👁️ Vistos: *${vistos}*`,
      global.jkLastCheckAt ? `🕒 Último chequeo: *${formatClock(global.jkLastCheckAt)}*` : null,
      global.jkLastSent ? `🚀 Último envío: *${global.jkLastSent.titulo}* ep ${zeroPad(global.jkLastSent.epNum)} (${global.jkLastSent.sizeMB} MB)` : null,
      global.jkLastError ? `⚠️ Último error: _${global.jkLastError.message.slice(0, 180)}_` : null,
    ].filter(line => line !== null)
    return m.reply(lines.join('\n'))
  }

  if (command === 'jkqueue') {
    if (!global.jkEpisodeQueue.length) return m.reply('✅ Cola vacía.')
    const lines = global.jkEpisodeQueue.map((item, idx) =>
      `${idx + 1}. *${item.ep.titulo}* ep ${zeroPad(item.ep.epNum)}${item.chatId === m.chat ? ' ← este chat' : ''}`,
    )
    return m.reply(`📋 *Cola (${global.jkEpisodeQueue.length}):*\n\n${lines.join('\n')}`)
  }

  if (command === 'jkflush') {
    const removed = global.jkEpisodeQueue.filter(i => i.chatId === m.chat)
    global.jkEpisodeQueue = global.jkEpisodeQueue.filter(i => i.chatId !== m.chat)
    for (const item of removed) {
      global.jkQueuedIds.delete(`${item.chatId}:${item.ep.id}`)
    }
    return m.reply(`🗑️ *${removed.length}* episodio(s) eliminado(s) de la cola.`)
  }

  if (command === 'jkunblock') {
    const estaba = global.jkQueueRunning
    global.jkQueueRunning = false
    global.jkCurrentJob = null
    procesarCola().catch(() => {})
    return m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.`)
  }

  if (command === 'jkcheck') {
    await m.reply('🔍 Chequeando JKAnime...')
    try {
      const result = await checkNuevosEpisodios(m.chat, conn, { throwOnError: true })
      if (result.skipped) return m.reply('⏳ Ya hay un chequeo en curso para este chat.')
      if (!result.queued) return m.reply('✅ Sin episodios nuevos.')
    } catch (err) {
      return m.reply(`❌ Error al chequear JKAnime:\n${err.message}`)
    }
    return
  }

  if (command === 'jkinterval') {
    const min = parseInt(text?.trim(), 10)
    if (Number.isNaN(min) || min < 5 || min > 60) {
      return m.reply(`❌ Número entre *5* y *60*.\nEj: ${usedPrefix}jkinterval 15`)
    }
    if (!global.jkActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}jkstart* primero.`)
    iniciarNotificador(m.chat, conn, min)
    return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`)
  }

  if (command === 'jkexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim(), 10) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *JKAnime*...`)
    let lista
    try {
      lista = await fetchLatestEpisodesJK()
    } catch (err) {
      return m.reply(`❌ Error: ${err.message}`)
    }
    if (!lista.length) return m.reply('❌ Sin episodios disponibles.')
    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(
        `📋 *${seleccion.length} episodios seleccionados (${SOURCE_LABEL}):*\n\n` +
        seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
        '\n\n⏳ _Se enviarán de uno en uno..._',
      )
    }
    for (const ep of seleccion) {
      const key = `${m.chat}:${ep.id}`
      if (!global.jkQueuedIds.has(key)) {
        global.jkEpisodeQueue.push({ chatId: m.chat, ep, requeues: 0 })
        global.jkQueuedIds.add(key)
      }
    }
    procesarCola().catch(() => {})
  }
}

handler.command = /^(jkstart|jkstop|jkstatus|jkcheck|jkqueue|jkflush|jkunblock|jkinterval|jkexample)$/i
handler.tags = ['anime', 'notificaciones']
handler.help = [
  'jkstart [min]',
  'jkstop',
  'jkstatus',
  'jkcheck',
  'jkqueue',
  'jkflush',
  'jkunblock',
  'jkinterval <min>',
  'jkexample [N]',
]
handler.before = async (_m, { conn }) => {
  if (conn) global.jkConn = conn
  restaurarNotificadores(conn)
}

export default handler

// ─── Tests embebidos (solo al ejecutar `node --test plugins/jk-notify.js`) ────

if (IS_TEST_RUN) {
  const { default: test, after } = await import('node:test')
  const { default: assert } = await import('node:assert/strict')
  const { default: http } = await import('node:http')

  after(async () => {
    await closeWreqSessions()
  })

  const pageUrl = 'https://jkanime.net/serie/12/'

  test('extrae streams codificados, descarga remota e iframe de JKAnime', () => {
    const streamUrl = 'https://streamwish.to/e/episode-token'
    const iframeUrl = 'https://player.example/embed/episode-token'
    const servers = [{
      remote: Buffer.from(streamUrl).toString('base64'),
      server: 'StreamWish',
      slug: 'download-token',
      lang: 'sub',
    }]
    const html = [
      `<script>var servers = ${JSON.stringify(servers)}; var remote = 'https://downloads.example';`,
      `video[0] = '<iframe src="${iframeUrl}"></iframe>';</script>`,
    ].join('\n')

    const links = extractJkAnimeLinks(html, pageUrl)
    assert.deepEqual(links.map(link => link.url), [
      streamUrl,
      'https://downloads.example/d/download-token/',
      iframeUrl,
    ])
    assert.equal(links[0].server, 'StreamWish')
    assert.equal(links[0].variant, 'sub')
    assert.equal(links[2].kind, 'player')
  })

  test('extrae slug y número de episodio desde URLs absolutas y relativas', () => {
    assert.deepEqual(parseJkAnimeEpisodeUrl('/serie-de-prueba/42/?from=feed', 'https://jkanime.net/'), {
      slug: 'serie-de-prueba',
      epNum: 42,
      epUrl: 'https://jkanime.net/serie-de-prueba/42/?from=feed',
    })
    assert.deepEqual(parseJkAnimeEpisodeUrl('https://www.jkanime.net/serie/7/', pageUrl), {
      slug: 'serie',
      epNum: 7,
      epUrl: 'https://www.jkanime.net/serie/7/',
    })
  })

  test('acepta remote en URL plana y conserva el token completo del JKPlayer', () => {
    const streamUrl = 'https://hgcloud.to/e/episode-token'
    const playerUrl = 'https://jkanime.net/jkplayer/um?e=abc_DEF-123.xY--&t=hash'
    const html = `var servers = ${JSON.stringify([{ remote: streamUrl, server: 'Streamwish' }])};\nvideo[0] = '<iframe src="${playerUrl}"></iframe>';`
    const links = extractJkAnimeLinks(html, pageUrl)

    assert.deepEqual(links.map(link => link.url), [streamUrl, playerUrl])
    assert.equal(links[1].kind, 'player')
  })

  test('prioriza el candidato HLS final y decodifica URLs ocultas en atob', () => {
    const oldUrl = 'https://cdn.example/old.m3u8?token=old'
    const escapedUrl = 'https:\\/\\/cdn.example/escaped.m3u8?token=escaped'
    const activeUrl = 'https://cdn.example/active.m3u8?token=active'
    const html = `url: '${oldUrl}'; video: '${escapedUrl}';\nhls.loadSource(atob('${Buffer.from(activeUrl).toString('base64')}'));`
    assert.deepEqual(extractJkAnimeM3u8Candidates(html), [
      activeUrl,
      'https://cdn.example/escaped.m3u8?token=escaped',
      oldUrl,
    ])
  })

  test('rechaza URLs fuera de JKAnime, credenciales y no ejecuta literales JS no JSON', () => {
    assert.equal(parseJkAnimeEpisodeUrl('https://example.org/serie/7/'), null)
    assert.equal(parseJkAnimeEpisodeUrl('https://user:pass@jkanime.net/serie/7/'), null)
    assert.equal(parseJkAnimeEpisodeUrl('/serie/no-es-numero/', 'https://jkanime.net/'), null)
    const html = 'var servers = [(() => { globalThis.__jkExtractorExecuted = true })()];'
    assert.deepEqual(extractJkAnimeLinks(html, pageUrl), [])
    assert.equal(globalThis.__jkExtractorExecuted, undefined)
  })

  test('parsea tarjetas recientes de portada, filtra antiguas y deduplica', () => {
    const html = `
      <div id="animes">
        <div class="dir1">
          <a href="/dandadan/5/" title="Dandadan"><img class="card-img-top" src="/img/dandadan.jpg"></a>
          <div class="card-title">Dandadan</div>
          <span class="badge-secondary">Hoy</span>
        </div>
        <div class="dir1">
          <a href="/dandadan/5/" title="Dandadan duplicado"><img src="/img/dandadan.jpg"></a>
          <span class="badge-secondary">Hoy</span>
        </div>
        <div class="dir1">
          <a href="/anime-viejo/12/"><img src="/img/viejo.jpg"></a>
          <div class="card-title">Anime Viejo</div>
          <span class="badge-secondary">12 Ene</span>
        </div>
        <div class="dir1">
          <a href="/frieren/2/"><img data-src="https://cdn.jkanime.net/f.jpg"></a>
          <div class="card-title">Frieren</div>
          <span class="badge-secondary">Hace 2 horas</span>
        </div>
      </div>
    `
    const episodes = parseLatestEpisodesHtml(html)
    assert.equal(episodes.length, 2)
    assert.deepEqual(episodes.map(e => e.id), ['jk-dandadan-5', 'jk-frieren-2'])
    assert.equal(episodes[0].imgUrl, 'https://jkanime.net/img/dandadan.jpg')
    assert.equal(episodes[1].imgUrl, 'https://cdn.jkanime.net/f.jpg')
  })

  test('extrae enlaces directos de MediaFire (normal y data-scrambled-url Base64)', () => {
    const direct = 'https://download1234.mediafire.com/abc/video.mp4'
    const encoded = Buffer.from(direct).toString('base64')
    assert.equal(extractMediaFireDirectUrl(`<a id="downloadButton" data-scrambled-url="${encoded}" href="#">DL</a>`), direct)
    assert.equal(extractMediaFireDirectUrl(`<a id="downloadButton" href="${direct}">DL</a>`), direct)
  })

  test('ordena servidores, limpia títulos y genera nombres de archivo con temporada', () => {
    const ordered = ordenarServidores([
      { nombre: 'streamwish', url: 'https://streamwish.to/e/1', kind: 'stream' },
      { nombre: 'jkplayer', url: 'https://jkanime.net/jkplayer/um?e=1', kind: 'player' },
      { nombre: 'mediafire', url: 'https://www.mediafire.com/file/1', kind: 'download' },
      { nombre: 'mega', url: 'https://mega.nz/file/1#key', kind: 'download' },
    ])
    assert.deepEqual(ordered.map(s => s.nombre), ['mega', 'mediafire', 'jkplayer', 'streamwish'])
    assert.equal(
      buildFileName('Episodio 4 - Frieren 2nd Season Sub Español', 4),
      '04 T2 Frieren Sub Español (720p) [[JK]].mp4',
    )
    assert.equal(detectarServNombre('https://hgcloud.to/e/xyz'), 'streamwish')
  })

  test('jsUnpack y extraerUrlVideo decodifican scripts empaquetados sin eval', () => {
    const packed = "eval(function(p,a,c,k,e,d){return p}('0:\"1://2.3/4.5\"',6,6,'file|https|cdn|test|video|m3u8'.split('|'),0,{}))"
    const unpacked = jsUnpack(packed)
    assert.equal(unpacked, 'file:"https://cdn.test/video.m3u8"')
    assert.equal(extraerUrlVideo(unpacked), 'https://cdn.test/video.m3u8')
  })

  test('cliente HTTP wreq-js mantiene cookies de sesión, parsea AJAX y maneja Cloudflare + FlareSolverr', async () => {
    const seenRequests = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        seenRequests.push({ url: req.url, method: req.method, headers: req.headers, body })
        if (req.url === '/ok') {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'jksid=ok123; Path=/' })
          res.end('<html>portada ok</html>')
          return
        }
        if (req.url === '/ajax/download_episode/99') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ url: 'https://mega.nz/file/abc#xyz', cookie: req.headers.cookie || '' }))
          return
        }
        if (req.url === '/cf-blocked') {
          res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' })
          res.end('<html><title>Just a moment...</title></html>')
          return
        }
        if (req.url === '/v1' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            status: 'ok',
            solution: {
              status: 200,
              url: 'http://127.0.0.1/cf-blocked',
              userAgent: 'FlareChrome/149.0',
              cookies: [{ name: 'cf_clearance', value: 'solved-token' }],
              response: '<html>desbloqueado por flaresolverr</html>',
            },
          }))
          return
        }
        res.writeHead(404)
        res.end('not found')
      })
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const prevFlare = jkRuntime.flareUrl
    const prevUa = jkRuntime.ua
    const prevCookie = jkRuntime.cookie

    try {
      jkRuntime.flareUrl = ''
      const r1 = await httpRequest(`${base}/ok`, { forceJk: true, retries: 0 })
      assert.equal(r1.status, 200)
      assert.match(r1.data, /portada ok/)
      assert.match(seenRequests[0].headers['user-agent'] || '', /Chrome\/\d+/)

      const r2 = await httpRequest(`${base}/ajax/download_episode/99`, { forceJk: true, retries: 0 })
      assert.equal(r2.data.url, 'https://mega.nz/file/abc#xyz')
      assert.match(r2.data.cookie, /jksid=ok123/)

      await assert.rejects(
        () => httpRequest(`${base}/cf-blocked`, { forceJk: true, retries: 0 }),
        (err) => err.code === 'JKANIME_FETCH_FAILED' && /403.*Cloudflare/i.test(err.message),
      )

      jkRuntime.flareUrl = base
      const r3 = await httpRequest(`${base}/cf-blocked`, { forceJk: true, retries: 0 })
      assert.equal(r3.status, 200)
      assert.match(r3.data, /desbloqueado por flaresolverr/)
      assert.equal(jkRuntime.ua, 'FlareChrome/149.0')
      assert.match(jkRuntime.cookie, /cf_clearance=solved-token/)
    } finally {
      jkRuntime.flareUrl = prevFlare
      jkRuntime.ua = prevUa
      jkRuntime.cookie = prevCookie
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('downloadDirectHttp descarga MP4 binario válido y rechaza respuestas HTML falsas', async () => {
    const os = await import('node:os')
    const fakeMp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
      Buffer.alloc(MIN_VALID_BYTES + 1024, 0x41),
    ])
    const server = http.createServer((req, res) => {
      if (req.url === '/video.mp4') {
        const headers = {
          'Content-Type': 'video/mp4',
          'Content-Length': String(fakeMp4.length),
          'Accept-Ranges': 'bytes',
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, headers)
          res.end()
          return
        }
        res.writeHead(200, headers)
        res.end(fakeMp4)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><html><body>error</body></html>')
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jk-notify-test-'))
    try {
      const okPath = path.join(tmpDir, 'ok.mp4')
      await downloadDirectHttp(`${base}/video.mp4`, okPath, { label: 'TestMP4' })
      const stat = await fsp.stat(okPath)
      assert.equal(stat.size, fakeMp4.length)

      const badPath = path.join(tmpDir, 'bad.mp4')
      await assert.rejects(
        () => downloadDirectHttp(`${base}/fake-html`, badPath, { label: 'TestHTML' }),
        /en lugar de video/i,
      )
      assert.equal(fs.existsSync(badPath), false)
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      await new Promise(resolve => server.close(resolve))
    }
  })
  test('APIs de scraping: rotan, escalan a premium, enfrían cuota agotada y no filtran claves', async () => {
    const hits = []
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      hits.push(`${u.pathname}${u.searchParams.has('premium') ? '?premium' : ''}`)
      if (u.pathname.startsWith('/sd/')) {
        res.writeHead(401)
        res.end('invalid token')
        return
      }
      if (u.pathname.startsWith('/sa/')) {
        if (!u.searchParams.has('premium')) {
          res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' })
          res.end('<html><title>Just a moment...</title></html>')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html>desbloqueado por scraperapi: ${u.searchParams.get('url')}</html>`)
        return
      }
      if (u.pathname.startsWith('/bad/')) {
        res.writeHead(500)
        res.end('boom')
        return
      }
      if (u.pathname.startsWith('/cf-')) {
        res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' })
        res.end('<html><title>Just a moment...</title></html>')
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const byId = Object.fromEntries(scraperRuntime.providers.map(p => [p.id, p]))
    const saved = scraperRuntime.providers.map(p => ({ p, base: p.base, key: p.key, level: p.level, cooldownUntil: p.cooldownUntil }))
    const prevEnabled = scraperRuntime.enabled
    const prevFlare = jkRuntime.flareUrl
    const apiHits = () => hits.filter(h => !h.startsWith('/cf-'))

    try {
      scraperRuntime.enabled = true
      scraperRuntime.cache.clear()
      scraperRuntime.lastGood = ''
      jkRuntime.flareUrl = ''
      for (const p of scraperRuntime.providers) { p.key = ''; p.level = 0; p.cooldownUntil = 0 }
      byId.scrapedo.key = 'test-key-sd'
      byId.scrapedo.base = `${base}/sd/`
      byId.scraperapi.key = 'test-key-sa'
      byId.scraperapi.base = `${base}/sa/`

      // 1) scrape.do responde 401 (cuota) → ScraperAPI normal bloqueado → ScraperAPI premium OK
      const r1 = await httpRequest(`${base}/cf-one`, { forceJk: true, retries: 0 })
      assert.equal(r1.status, 200)
      assert.match(r1.data, /desbloqueado por scraperapi/)
      assert.deepEqual(apiHits(), ['/sd/', '/sa/', '/sa/?premium'])
      assert.ok(byId.scrapedo.cooldownUntil > Date.now())

      // 2) scrape.do sigue en enfriamiento y ScraperAPI arranca directo en premium
      hits.length = 0
      const r2 = await httpRequest(`${base}/cf-two`, { forceJk: true, retries: 0 })
      assert.match(r2.data, /desbloqueado por scraperapi/)
      assert.deepEqual(apiHits(), ['/sa/?premium'])

      // 3) caché de 60 s: la misma URL no vuelve a gastar créditos
      hits.length = 0
      await httpRequest(`${base}/cf-two`, { forceJk: true, retries: 0 })
      assert.deepEqual(apiHits(), [])

      // 4) todo falla → error JKANIME_FETCH_FAILED sin exponer claves
      byId.scraperapi.base = `${base}/bad/`
      await assert.rejects(
        () => httpRequest(`${base}/cf-three`, { forceJk: true, retries: 0 }),
        (err) => err.code === 'JKANIME_FETCH_FAILED'
          && /APIs de scraping/.test(err.message)
          && !/test-key/.test(err.message),
      )
      assert.equal(redactScraperKeys('https://x/?api_key=test-key-sa'), 'https://x/?api_key=***')
    } finally {
      for (const s of saved) {
        s.p.base = s.base
        s.p.key = s.key
        s.p.level = s.level
        s.p.cooldownUntil = s.cooldownUntil
      }
      scraperRuntime.enabled = prevEnabled
      scraperRuntime.cache.clear()
      scraperRuntime.lastGood = ''
      jkRuntime.flareUrl = prevFlare
      await new Promise(resolve => server.close(resolve))
    }
  })
}
