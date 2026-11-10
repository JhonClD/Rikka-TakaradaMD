// plugins/dbs-notify.js — v3.2
//
// Notificador automático de nuevos episodios — AnimeDBS (SUB + AUDIO LATINO)

import axios        from 'axios'
import * as cheerio from 'cheerio'
import fs           from 'fs'
import path         from 'path'
import { spawn }    from 'child_process'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import https        from 'https'
import { File as MegaFile } from 'megajs'
import animeV1Downloader from '../src/libraries/animev1-download.cjs'
import { compressDw4 } from '../src/libraries/dw4-compress.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const ANIMEDBS_URL          = 'https://www.animedbs.online'
const DBS_DIRECTORY_URL      = `${ANIMEDBS_URL}/anime/?status=&type=&order=update`
const DBS_DIRECTORY_LIMIT    = 12
const ANILIST_URL            = 'https://graphql.anilist.co'

// [CORRECCIÓN 1] Crear carpeta 'database' para no perder datos al reiniciar
const DB_DIR = path.join(process.cwd(), 'database')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const SEEN_FILE              = path.join(DB_DIR, 'dbs_seen.json')
const STATE_FILE             = path.join(DB_DIR, 'dbs_state.json')

const CHECK_INTERVAL_DEFAULT = 10        // minutos históricos
const CHECK_INTERVAL_SECONDS = CHECK_INTERVAL_DEFAULT * 60
const MIN_INTERVAL_SECONDS   = 15
const MAX_INTERVAL_SECONDS   = 3600
const QUEUE_DELAY            = 90_000    // ms entre ítems de cola (90 seg)
const DL_TIMEOUT             = 3 * 60 * 60 * 1000
const MIN_EPISODE_SIZE_BYTES = 5 * 1024 * 1024

// [MEJORA VELOCIDAD] megajs descarga por bloques y conexiones paralelas.
// Se puede ajustar con MEGA_MAX_CONNECTIONS; se limita para no saturar Mega ni el bot.
const MEGA_MAX_CONNECTIONS   = Math.min(Math.max(Number(process.env.MEGA_MAX_CONNECTIONS) || 16, 4), 32)
const MEGA_CHUNK_SIZE        = 1024 * 1024 // máximo documentado por megajs: 1 MB
const MF_HILOS               = 8   // hilos para descarga por rangos en MediaFire
const MF_MIN_SIZE_PARALELO   = 5 * 1024 * 1024 // no vale la pena paralelizar archivos < 5MB

const DBS_SERVIDORES = new Set(['mega', 'mediafire', 'directo'])
const ERROR_OWNER_JID = process.env.DBS_ERROR_OWNER_JID || process.env.TIO_ERROR_OWNER_JID || '51925092348@s.whatsapp.net'

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

global.dbsAnimeCoverCache = global.dbsAnimeCoverCache || new Map()
async function getAniListCover(titulo, slug = '') {
  const candidates = [titulo, String(slug).replace(/[-_]+/g, ' ')].map(v => String(v || '').trim()).filter(Boolean)
  const key = candidates[0]?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  if (!key) return null
  if (global.dbsAnimeCoverCache.has(key)) return global.dbsAnimeCoverCache.get(key)
  const query = `query ($search: String) { Page(perPage: 3) { media(search: $search, type: ANIME) { coverImage { extraLarge large medium } } } }`
  for (const search of candidates) {
    try {
      const response = await axios.post(ANILIST_URL, { query, variables: { search } }, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 10000,
      })
      const media = response.data?.data?.Page?.media || []
      const cover = media[0]?.coverImage?.extraLarge || media[0]?.coverImage?.large || media[0]?.coverImage?.medium
      if (cover) { global.dbsAnimeCoverCache.set(key, cover); return cover }
    } catch (_) {}
  }
  global.dbsAnimeCoverCache.set(key, null)
  return null
}

// ─── Estado global ────────────────────────────────────────────────────────────

global.dbsActiveChats  = global.dbsActiveChats  || new Map()
global.dbsEpisodeQueue = global.dbsEpisodeQueue || []
global.dbsQueueRunning = global.dbsQueueRunning || false
global.dbsConn         = global.dbsConn         || null
global.dbsQueuedIds    = global.dbsQueuedIds    || new Set()
global.dbsChecking = global.dbsChecking || false
global.dbsGlobalTimer = global.dbsGlobalTimer || null

async function reportDbsError(conn, context, error) {
  const message = error instanceof Error ? error.message : String(error || 'Error desconocido')
  console.error(`[dbs-notify] ${context}: ${message}`)
  if (!conn?.sendMessage) return
  try {
    await conn.sendMessage(ERROR_OWNER_JID, { text: `🚨 *Error en DBS Notify*\n📍 *Contexto:* ${context}\n💬 *Mensaje:* ${message}`.slice(0, 4000) })
  } catch (_) {}
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return value && typeof value === 'object' ? value : fallback
  } catch (err) {
    if (fs.existsSync(file)) console.error(`[dbs-notify] No se pudo leer ${file}: ${err.message}`)
    return fallback
  }
}

function saveJsonAtomic(file, data) {
  const tempFile = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2))
    fs.renameSync(tempFile, file)
  } catch (err) {
    try { fs.unlinkSync(tempFile) } catch (_) {}
    console.error(`[dbs-notify] No se pudo guardar ${file}: ${err.message}`)
  }
}

function loadSeen()   { return loadJson(SEEN_FILE) }
function saveSeen(d)  { saveJsonAtomic(SEEN_FILE, d) }
function loadState()  { return loadJson(STATE_FILE) }
function saveState(d) { saveJsonAtomic(STATE_FILE, d) }
function seedChatSeen(chatId, lista, seen = {}) {
  const ids = [...new Set(lista.flatMap(ep => ep.variantSeenIds || [ep.id]))]
  seen[chatId] = ids.slice(-500)
  saveSeen(seen)
  return seen
}
function getGlobalIntervalSec() {
  const state = loadState()
  const configured = Number(state.__config?.intervalSec)
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS)
    : CHECK_INTERVAL_SECONDS
}
function setGlobalIntervalSec(intervalSec) {
  const state = loadState()
  state.__config = { ...(state.__config || {}), intervalSec }
  saveState(state)
}

function absoluteUrl(value, base) {
  try { return new URL(value, base).href } catch (_) { return '' }
}

function parseEpisodeHref(href, baseUrl) {
  const epUrl = absoluteUrl(href, baseUrl)
  if (!epUrl) return null
  let pathname
  try { pathname = decodeURIComponent(new URL(epUrl).pathname) } catch (_) { return null }
  const match = pathname.match(/\/ver\/([^/]+?)(?:[-_](?:episode|episodio|ep)[-_]?)?(?:[-_])?(\d+)(?:[-_](?:sub|latino|castellano|espanol|español|esp|dub|hd|fhd|1080p|720p|480p))?\/?$/i)
    || pathname.match(/\/ver\/([^/]+?)[-_](\d+)\/?$/i)
  if (!match) return null
  const epNum = Number.parseInt(match[2], 10)
  if (!Number.isInteger(epNum) || epNum < 0) return null
  const slug = match[1].replace(/[-_](?:episode|episodio|ep)$/i, '')
  const normSlug = slug
    .replace(/[-_](?:sub|latino|castellano|espanol|español|esp|dub|hd|fhd|1080p|720p|480p)$/i, '')
    .toLowerCase()
  return { slug, normSlug, epNum, epUrl }
}

async function getPage(url, options = {}, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, { ...options, timeout: options.timeout || 15000 })
    } catch (err) {
      lastError = err
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError
}

function detectarServidor(url, label = '') {
  let host = ''
  let pathname = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    pathname = parsed.pathname.toLowerCase()
  } catch (_) {}
  if (/(?:^|\.)mega\.(?:nz|co\.nz)$/.test(host)) return 'mega'
  if (/(?:^|\.)mediafire\.com$/.test(host)) return 'mediafire'
  const text = String(label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/\bmega\b/.test(text)) return 'mega'
  if (/media\s*fire/.test(text)) return 'mediafire'
  if (/\bdirect(?:o)?\b/.test(text) || /\.mp4$/i.test(pathname)) return 'directo'
  return ''
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n)  { return String(n).padStart(2, '0') }
function formatInterval(seconds) {
  const value = Number(seconds)
  if (Number.isInteger(value) && value % 60 === 0) return `${value / 60} min`
  return `${value} segundos`
}
function parseIntervalInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(',', '.')
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(s|seg|segs|segundo|segundos|m|min|mins|minuto|minutos)?$/i)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const seconds = /^m/i.test(match[2] || '') ? amount * 60 : amount
  return Number.isInteger(seconds) ? seconds : Math.round(seconds)
}
function formatActiveTime(startedAt) {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}
function safeFile(s) { return s.replace(/[\\/\\*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
const ROMAN_SEASONS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }
function seasonValue(value) {
  const token = String(value || '').toUpperCase()
  return /^\d+$/.test(token) ? Number(token) : ROMAN_SEASONS[token] || 1
}
function getSeasonNumber(...values) {
  const text = values.filter(Boolean).join(' ')
  const token = '(\\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)'
  const patterns = [
    new RegExp(`${token}\\s*(?:st|nd|rd|th|ª|º)?\\s*(?:temporada|season|saison)`, 'i'),
    new RegExp(`(?:temporada|season|saison)\\s*[-_: ]?\\s*${token}`, 'i'),
    new RegExp(`\\b(?:S|T)\\s*${token}\\b`, 'i'),
    /\b(?:VIII|VII|VI|IX|IV|V|III|II|X)\b/i,
    /\b(?:first|second|third|fourth|fifth)\s+season\b/i,
  ]
  let match
  for (const pattern of patterns) {
    match = text.match(pattern)
    if (match) break
  }
  const wordSeasons = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }
  const season = match?.[1] ? seasonValue(match[1]) : wordSeasons[match?.[0]?.split(/\s+/)[0]?.toLowerCase()] || 1
  return season > 1 ? season : 1
}
function cleanTitle(titulo, epNum) {
  return titulo
    .replace(new RegExp(`\\s*[-–—:]?\\s*${Number(epNum)}\\s*$`), '')
    .replace(/\s*(?:first|second|third|fourth|fifth)\s+season/ig, '')
    .replace(/\s*(?:(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)(?:st|nd|rd|th|ª|º)?\s*)?(?:temporada|season|saison)\s*[-_: ]*\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)?/ig, '')
    .replace(/\s*\b(?:S|T)\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)\b/ig, '')
    .replace(/(^|[\s()[\]{}\-_:])(?:VIII|VII|VI|IX|IV|V|III|II|X)(?=$|[\s()[\]{}\-_:])/ig, '$1')
    .replace(/\s*(?:sub\s+)?español(?:\s+(?:latino|castellano))?\s*(?:🇲🇽|🇪🇸)?/ig, '')
    .replace(/\s*(?:latino|castellano)\s*(?:🇲🇽|🇪🇸)?/ig, '')
    .replace(/\s*\(\s*(?:720p|1080p)\s*\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function parsePublishedAt(text) {
  const match = String(text || '').match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/)
  if (!match) return 0
  const timestamp = Date.parse(`${match[1].replace(' ', 'T')}-05:00`)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function episodeAgeSeconds(text) {
  const value = String(text || '').toLowerCase().trim()
  if (!value) return Number.POSITIVE_INFINITY
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*(segundo|minuto|hora|día|dia|semana|mes|year|año)/i)
  if (!match) return Number.POSITIVE_INFINITY
  const amount = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(amount)) return Number.POSITIVE_INFINITY
  const unit = match[2].toLowerCase()
  if (unit.startsWith('seg')) return amount
  if (unit.startsWith('min')) return amount * 60
  if (unit.startsWith('hora')) return amount * 3600
  if (unit.startsWith('día') || unit.startsWith('dia')) return amount * 86400
  if (unit.startsWith('sem')) return amount * 604800
  if (unit.startsWith('mes')) return amount * 2592000
  return amount * 31536000
}

function buildFileName(titulo, epNum, fuente = 'dbs', idioma = 'latino', slug = '') {
  const season = getSeasonNumber(titulo, slug)
  const seasonLabel = season > 1 ? `T${season} ` : ''
  const title = cleanTitle(titulo, epNum)
  const details = fuente === 'latino'
    ? 'Español Latino (720p)'
    : fuente === 'latanime'
    ? `Español ${idioma === 'castellano' ? 'Castellano 🇪🇸' : 'Latino 🇲🇽'} (1080p)`
    : 'Sub Español (720p)'
  return `${zeroPad(epNum)} ${seasonLabel}${safeFile(title)} ${details} [[𝗖𝗜𝗗]].mp4`
}

function build360FileName(fileName) {
  return fileName.replace(/\(\d{3,4}p\)/i, '(360p)')
}

function fmtBytes(b) {
  if (!b || b <= 0) return '0 KB'
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576)    return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1024).toFixed(2) + ' KB'
}



// ─── Scraping ─────────────────────────────────────────────────────────────────

async function fetchLatestEpisodesDBS() {
  const { data } = await getPage(ANIMEDBS_URL, { headers: HEADERS })
  const $ = cheerio.load(data)
  const lista = []
  const ids = new Set()
  const episodiosPortada = new Map()
  const addEpisode = ({ href, title, epNum, imgUrl = '', latino = false, ageSeconds = Number.POSITIVE_INFINITY, publishedAt = 0 }) => {
    const epUrl = absoluteUrl(href, ANIMEDBS_URL)
    const number = Number.parseInt(epNum, 10)
    if (!epUrl || !Number.isInteger(number) || number < 0) return
    const titulo = String(title || '').replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').trim() || 'Anime desconocido'
    const slug = titulo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const id = `dbs-${slug}-${number}`
    const idioma = latino ? 'latino' : 'sub'
    const legacyIds = [`dbs-${slug}-${number}`, `dbs-lat-${slug}-${number}`]
    if (ids.has(id)) {
      const existing = lista.find(ep => ep.id === id)
      if (existing) {
        if (!existing.idiomas.includes(idioma)) existing.idiomas.push(idioma)
        if (publishedAt > (existing.publishedAt || 0)) {
          Object.assign(existing, { epUrl, imgUrl, ageSeconds, publishedAt })
        }
      }
      return
    }
    ids.add(id)
    lista.push({
      id, slug, titulo, epNum: number, epUrl, imgUrl,
      fuente: latino ? 'latino' : 'animedbs', idioma,
      idiomas: [idioma], legacyIds, ageSeconds, publishedAt,
    })
  }

  $('.listupd .bs').each((_, el) => {
    const $el = $(el)
    const aTag = $el.find('a').first()
    const href = aTag.attr('href') || ''
    if (!href) return
    const epUrl = absoluteUrl(href, ANIMEDBS_URL)
    const epxText = $el.find('.epx').text().trim()
    const epNumStr = epxText.match(/\d+/)?.[0] || epUrl.match(/episodio[- _]?(\d+)/i)?.[1]
    if (!epNumStr) return
    const anime = $el.find('.tite1').text().trim()
    const h2 = $el.find('h2').text().trim() || $el.find('.tt').text().trim()
    const titulo = anime || h2.replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').replace(/hace\s+.*$/i, '').trim()
    const ageSeconds = episodeAgeSeconds($el.find('.sosev').text())
    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    const imgUrl = imgSrc.startsWith('data:') ? '' : absoluteUrl(imgSrc, ANIMEDBS_URL)
    const latino = /latino/i.test(`${href} ${titulo} ${$el.find('.lg').text()}`)
    episodiosPortada.set(epUrl, { href: epUrl, title: titulo, epNum: epNumStr, imgUrl })
    addEpisode({ href: epUrl, title: titulo, epNum: epNumStr, imgUrl, latino: false, ageSeconds })
    if (latino) addEpisode({ href: epUrl, title: titulo, epNum: epNumStr, imgUrl, latino: true, ageSeconds })
  })

  // La portada puede mostrar la fecha de modificación del post (por ejemplo,
  // "Hace 5 segundos"), que no siempre es la fecha de publicación del episodio.
  // El directorio ordenado por actualización contiene las series recientes; para
  // cada una consultamos su primer episodio y la fecha real de publicación.
  try {
    const { data: directoryHtml } = await getPage(DBS_DIRECTORY_URL, { headers: HEADERS })
    const $directory = cheerio.load(directoryHtml)
    const series = []
    $directory('.listupd .bs').each((_, el) => {
      const $el = $directory(el)
      const href = $el.find('a[href]').first().attr('href') || ''
      if (!href) return
      const label = $el.text().replace(/\s+/g, ' ').trim()
      series.push({ href, label, title: $el.find('.tite1').text().trim() || $el.find('h2').text().trim() })
    })
    const recientes = series.slice(0, DBS_DIRECTORY_LIMIT)
    const concurrency = 6
    for (let i = 0; i < recientes.length; i += concurrency) {
      await Promise.all(recientes.slice(i, i + concurrency).map(async item => {
        try {
          const seriesUrl = absoluteUrl(item.href, ANIMEDBS_URL)
          const { data: seriesHtml } = await getPage(seriesUrl, { headers: { ...HEADERS, Referer: DBS_DIRECTORY_URL }, timeout: 8000, maxRedirects: 3 }, 1)
          const $series = cheerio.load(seriesHtml)
          const first = $series('.eplister a[href]').first()
          const episodeHref = first.attr('href') || ''
          if (!episodeHref) return
          const episodeUrl = absoluteUrl(episodeHref, seriesUrl)
          const epNum = first.text().match(/\d+/)?.[0] || episodeUrl.match(/episodio[- _]?(\d+)/i)?.[1]
          if (!epNum) return
          const { data: episodeHtml } = await getPage(episodeUrl, { headers: { ...HEADERS, Referer: seriesUrl }, timeout: 8000, maxRedirects: 3 }, 1)
          const $episode = cheerio.load(episodeHtml)
          const publishedAt = parsePublishedAt($episode('.year').first().text())
          const title = $series('h1').first().text().trim() || item.title
          const img = $series('.thumb img, .thumbook img').first()
          const rawImg = img.attr('data-src') || img.attr('src') || ''
          const imgUrl = rawImg.startsWith('data:') ? '' : absoluteUrl(rawImg, seriesUrl)
          const hasLat = /\b(?:lat|latino)\b/i.test(item.label)
          const hasSub = /\b(?:sub|subtitulado)\b/i.test(item.label)
          const variants = hasLat || hasSub ? { latino: hasLat, sub: hasSub } : { sub: true }
          if (variants.sub) addEpisode({ href: episodeUrl, title, epNum, imgUrl, latino: false, publishedAt })
          if (variants.latino) addEpisode({ href: episodeUrl, title, epNum, imgUrl, latino: true, publishedAt })
        } catch (_) {}
      }))
    }
  } catch (error) {
    console.error(`[dbs-notify] Directorio de AnimeDBS no disponible: ${error.message}`)
  }

  // La portada general ya mezcla SUB y LAT y está ordenada por actualización.
  // No usamos el catálogo /anime/?sub=lat como fuente principal: puede poner
  // doblajes recientes de temporadas antiguas por delante de la temporada vigente.

  const gruposPorEpisodio = new Map()
  for (const ep of lista) {
    const key = `${ep.epUrl}:${ep.epNum}`
    if (!gruposPorEpisodio.has(key)) gruposPorEpisodio.set(key, [])
    gruposPorEpisodio.get(key).push(ep)
  }
  const priorizados = [...gruposPorEpisodio.values()]
    .sort((a, b) => {
      const publishedA = Math.max(...a.map(ep => ep.publishedAt || 0))
      const publishedB = Math.max(...b.map(ep => ep.publishedAt || 0))
      if (publishedA && publishedB && publishedA !== publishedB) return publishedB - publishedA
      if (publishedA !== publishedB) return publishedA ? -1 : 1
      const ageA = Math.min(...a.map(ep => ep.ageSeconds ?? Number.POSITIVE_INFINITY))
      const ageB = Math.min(...b.map(ep => ep.ageSeconds ?? Number.POSITIVE_INFINITY))
      if (ageA !== ageB) return ageA - ageB
      return Math.max(...b.map(ep => ep.epNum)) - Math.max(...a.map(ep => ep.epNum))
    })
    .flatMap(grupo => grupo.sort((a, b) => (a.idioma === 'latino' ? 0 : 1) - (b.idioma === 'latino' ? 0 : 1)))
  lista.splice(0, lista.length, ...priorizados)

  console.log(`[dbs-notify] ${lista.length} episodios recientes detectados desde la portada general (SUB + LAT)`)
  return lista
}

async function seleccionarVersionPreferidaDBS(lista, { seen = null, chatId = '', skipQueued = false, limit = Infinity } = {}) {
  const grupos = new Map()
  for (const ep of lista) {
    const key = `${ep.epUrl}:${ep.epNum}`
    if (!grupos.has(key)) grupos.set(key, [])
    grupos.get(key).push(ep)
  }
  const seleccionados = []
  for (const grupo of grupos.values()) {
    const estaVisto = ep => [ep.id, ...(ep.legacyIds || [])].some(id => seen?.includes(id))
    const estaEnCola = ep => [ep.id, ...(ep.legacyIds || [])].some(id => global.dbsQueuedIds.has(`${chatId}:${id}`))
    const candidatos = grupo.filter(ep => !estaVisto(ep) && !(skipQueued && estaEnCola(ep)))
    if (!candidatos.length) continue
    const ordenados = candidatos
      .map((ep, index) => ({ ep, index }))
      .sort((a, b) => {
        const publishedA = a.ep.publishedAt || 0
        const publishedB = b.ep.publishedAt || 0
        if (publishedA && publishedB && publishedA !== publishedB) return publishedB - publishedA
        if (publishedA !== publishedB) return publishedA ? -1 : 1
        const ageA = a.ep.ageSeconds ?? Number.POSITIVE_INFINITY
        const ageB = b.ep.ageSeconds ?? Number.POSITIVE_INFINITY
        if (ageA !== ageB) return ageA - ageB
        return a.index - b.index
      })

    for (const { ep } of ordenados) {
      const idiomas = [...new Set(ep.idiomas?.length ? ep.idiomas : [ep.idioma || 'sub'])]
      for (const idioma of idiomas) {
        try {
          const servidores = await scrapeServidoresDBS(ep.epUrl, idioma)
          if (!servidores.length) continue
          seleccionados.push({
            ...ep,
            idioma,
            fuente: idioma === 'latino' ? 'latino' : 'animedbs',
            servidores,
            // SUB y LAT son versiones del mismo capítulo y comparten un único visto.
            variantSeenIds: [ep.id, ...(ep.legacyIds || [])],
          })
          break
        } catch (_) {}
      }
      if (seleccionados.at(-1)?.id === ep.id) break
    }
    if (seleccionados.length >= limit) break
  }
  return seleccionados
}

async function scrapeServidoresDBS(epUrl, idioma = 'sub') {
  const { data } = await getPage(epUrl, { headers: { ...HEADERS, Referer: ANIMEDBS_URL } })
  const $ = cheerio.load(data)
  const srvs = []
  const idiomaObjetivo = /lat/i.test(idioma) ? 'latino' : 'sub'
  const idiomaPagina = $('.ts-language-label').text().replace(/\s+/g, ' ').trim()
  const paginaTieneLat = /\bLAT\b/i.test(idiomaPagina)
  const paginaTieneSub = /\bSUB\b/i.test(idiomaPagina)
  const bloquesIdioma = $('.soraddlx').toArray().map(el => ({
    el,
  }))
  const idiomaBloque = el => {
    const $block = $(el)
    const heading = $block.find('.sorattlx h3').text().trim()
    const hrefs = $block.find('a[href]').map((_, a) => $(a).attr('href') || '').get().join(' ')
    if (/latino/i.test(heading) || (/latino/i.test(hrefs) && !/subtitulado|sub\+espa/i.test(hrefs))) return 'latino'
    if (/sub(?:titulado| español)?/i.test(heading) || /subtitulado|sub\+espa/i.test(hrefs)) return 'sub'
    if (paginaTieneLat !== paginaTieneSub) return paginaTieneLat ? 'latino' : 'sub'
    if (paginaTieneLat && paginaTieneSub) return ''
    if (/-latino(?:\/|$)/i.test(epUrl)) return 'latino'
    return idiomaObjetivo
  }
  const bloqueCoincide = el => {
    return idiomaBloque(el) === idiomaObjetivo
  }
  const gruposDescarga = $('.episode-download-group').toArray()
  const idiomaGrupoDescarga = el => {
    const heading = $(el).find('h3').first().text().trim()
    if (/latino/i.test(heading)) return 'latino'
    // En AnimeDBS el bloque SUB suele llamarse simplemente "Descargar MP4".
    return 'sub'
  }
  const calidadDesde = (...values) => {
    const text = values.filter(Boolean).join(' ')
    return /1080\s*p?/i.test(text) ? '1080p' : /720\s*p?/i.test(text) ? '720p' : ''
  }
  const add = (value, label = '', calidad = '', allowDirect = false) => {
    if (!value || typeof value !== 'string') return
    const raw = value.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/')
    let url = absoluteUrl(raw, epUrl)
    if (!url) {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8').trim()
        if (/^https?:\/\//i.test(decoded)) url = absoluteUrl(decoded, epUrl)
      } catch (_) {}
    }
    if (!url || !/^https?:\/\//i.test(url) || srvs.some(s => s.url === url)) return
    let parsed
    try { parsed = new URL(url) } catch (_) { return }
    if (parsed.username || parsed.password) return
    if (/(?:^|\.)(?:terabox\.com|teraboxapp\.com|1024terabox\.com|terabox\.app|teraboxshare\.com|teraboxlink\.com)$/i.test(parsed.hostname)) return
    const siteHost = new URL(ANIMEDBS_URL).hostname.toLowerCase()
    if ((parsed.hostname.toLowerCase() === siteHost || parsed.hostname.toLowerCase().endsWith(`.${siteHost}`)) && !/\.mp4(?:$|[?#])/i.test(url)) return
    const nombre = detectarServidor(url, label) || (allowDirect && /\.mp4(?:$|[?#])/i.test(url) ? 'directo' : '')
    if (!nombre || !DBS_SERVIDORES.has(nombre)) return
    const directDownload = ['mega', 'mediafire', 'directo'].includes(nombre)
    srvs.push({ nombre, url, calidad: calidadDesde(calidad, label, parsed.pathname) || '720p', directo: directDownload })
  }
  $('.soraddlx').each((_, serverBlock) => {
    if (!bloqueCoincide(serverBlock)) return
    const $block = $(serverBlock)
    $block.find('.soraurlx').each((__, urlBlk) => {
      const $qualityBlock = $(urlBlk)
      const quality = calidadDesde($qualityBlock.find('strong').text(), $qualityBlock.text())
      $qualityBlock.find('a[href]').each((___, el) => add($(el).attr('href') || '', $(el).text().trim(), quality))
    })
  })
  // Diseño actual de AnimeDBS: una sola ficha contiene grupos separados
  // como "Descargar MP4" y "Descargar MP4 Latino".
  $('.episode-download-group').each((_, group) => {
    if (idiomaGrupoDescarga(group) !== idiomaObjetivo) return
    const $group = $(group)
    const quality = calidadDesde($group.find('.download-quality').text(), $group.text())
    $group.find('.download-hosts a[href]').each((__, el) => add($(el).attr('href') || '', $(el).text().trim(), quality))
  })
  // El sitio puede omitir las clases del bloque; aun así sólo se aceptan los tres tipos esperados.
  $('a[href]').each((_, el) => {
    const $el = $(el)
    const $languageBlock = $el.closest('.soraddlx')
    const $downloadGroup = $el.closest('.episode-download-group')
    if ((bloquesIdioma.length || gruposDescarga.length) && !$languageBlock.length && !$downloadGroup.length) return
    if ($languageBlock.length && !bloqueCoincide($languageBlock[0])) return
    if ($downloadGroup.length && idiomaGrupoDescarga($downloadGroup[0]) !== idiomaObjetivo) return
    const label = `${$el.text().trim()} ${$el.attr('title') || ''}`
    const context = $el.closest('.soraddlx, .soraurlx, .episode-download-group, .download, .downloads, .links').text()
    add($el.attr('href') || '', label, calidadDesde(context, label))
  })
  if (!gruposDescarga.length) {
    $('[data-src], [data-player], [data-url], iframe[src]').each((_, el) => {
      const $el = $(el)
      const raw = $el.attr('data-src') || $el.attr('data-player') || $el.attr('data-url') || $el.attr('src') || ''
      const context = $el.closest('.soraddlx, .soraurlx, .download, .downloads, .links').text()
      add(raw, `${$el.attr('title') || ''} ${context}`, calidadDesde(context), true)
    })
  }
  srvs.sort((a, b) => {
    if (a.directo !== b.directo) return a.directo ? -1 : 1
    const rank = v => /720/i.test(v) ? 0 : /1080/i.test(v) ? 1 : 2
    return rank(a.calidad) - rank(b.calidad)
  })
  return srvs
}

// ─── Descarga ─────────────────────────────────────────────────────────────────

const PREFS_DBS = ['directo', 'mediafire', 'mega']

function ordenarServidores(srvs) {
  const preferencias = PREFS_DBS
  return [...srvs].sort((a, b) => {
    const ia = preferencias.indexOf(a.nombre)
    const ib = preferencias.indexOf(b.nombre)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
}

async function descargarMega(megaUrl, outputDir, fileName) {
  if (!megaUrl || typeof megaUrl !== 'string') throw new Error('Mega: URL vacía')

  const normalizarMegaUrl = (value) => {
    const raw = value.trim()
    if (!/^https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz)\//i.test(raw)) {
      throw new Error('Mega: dominio o URL no válidos')
    }
    if (/\/folder\//i.test(raw) || /#F!/i.test(raw)) {
      throw new Error('Mega: los enlaces de carpetas no están soportados')
    }

    const match = raw.match(/\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/(?:file|embed)\/([A-Za-z0-9_-]{8,})[#!]([A-Za-z0-9_-]{20,})/i) ||
      raw.match(/#!?([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{20,})/i)
    if (!match) throw new Error('Mega: enlace sin ID o clave de archivo')
    return `https://mega.nz/file/${match[1]}#${match[2]}`
  }

  const url      = normalizarMegaUrl(megaUrl)
  const destPath = path.join(outputDir, fileName)
  const partPath = `${destPath}.part`
  const maxIntentos = 2
  let ultimoError

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      try { fs.rmSync(partPath, { force: true }) } catch (_) {}

      const file = MegaFile.fromURL(url)
      await file.loadAttributes()
      const total = Number(file.size || 0)
      const fileStream = file.download({
        maxConnections: MEGA_MAX_CONNECTIONS,
        initialChunkSize: MEGA_CHUNK_SIZE,
        chunkSizeIncrement: 0,
        maxChunkSize: MEGA_CHUNK_SIZE,
        forceHttps: true,
      })
      let done = 0
      const start = Date.now()
      let lastLog = 0
      const tracker = new Transform({
        transform(chunk, _enc, cb) {
          done += chunk.length
          const secs  = (Date.now() - start) / 1000 || 0.001
          const speed = done / secs
          const now   = Date.now()
          if (now - lastLog > 1000) {
            lastLog = now
            const pct = total > 0 ? (done / total) * 100 : 0
            process.stdout.write(`\r[MEGA] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtBytes(speed)}/s | intento ${intento}/${maxIntentos}   `)
          }
          cb(null, chunk)
        },
      })

      await pipeline(fileStream, tracker, fs.createWriteStream(partPath))
      const downloadedSize = fs.statSync(partPath).size
      if (total > 0 && downloadedSize !== total) {
        throw new Error(`Mega: tamaño incompleto (${downloadedSize} de ${total} bytes)`)
      }
      fs.renameSync(partPath, destPath)
      process.stdout.write('\n')
      return destPath
    } catch (err) {
      ultimoError = err
      process.stdout.write('\n')
      try { fs.rmSync(partPath, { force: true }) } catch (_) {}
      if (intento < maxIntentos) {
        console.log(`[dbs-notify] ⚠️ Mega falló; reintentando (${intento}/${maxIntentos}): ${err.message}`)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
  }

  throw new Error(`Mega error: ${ultimoError?.message || 'descarga fallida'}`)
}

async function descargarMediaFire(mfUrl, outputDir, fileName) {
  let mfPage
  try {
    const res = await axios.get(mfUrl, { headers: HEADERS, httpsAgent, timeout: 12000 })
    mfPage = res.data
  } catch (err) { throw new Error(`MediaFire: ${err.message}`) }

  const mfLink = mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
                 mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1] ||
                 mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]

  if (!mfLink) throw new Error('MediaFire: sin link directo')

  const destPath = path.join(outputDir, fileName)

  // [MEJORA VELOCIDAD] Averiguar tamaño y soporte de rangos con un HEAD
  let total = 0
  let soportaRangos = false
  try {
    const head = await axios.head(mfLink, { headers: HEADERS, httpsAgent, timeout: 10000 })
    total = parseInt(head.headers['content-length'] || '0')
    soportaRangos = /bytes/i.test(head.headers['accept-ranges'] || '')
  } catch (_) {}

  let done = 0
  const start = Date.now()
  let lastLog = 0
  const reportar = (bytes) => {
    done += bytes
    const now = Date.now()
    if (now - lastLog > 1000) {
      lastLog = now
      const secs  = (now - start) / 1000 || 0.001
      const speed = done / secs
      const pct   = total > 0 ? (done / total) * 100 : 0
      process.stdout.write(`\r[MEDIAFIRE] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtBytes(speed)}/s   `)
    }
  }

  // ── Descarga paralela por rangos (si el servidor lo permite) ────────────────
  if (soportaRangos && total >= MF_MIN_SIZE_PARALELO) {
    const hilos     = MF_HILOS
    const chunkSize = Math.ceil(total / hilos)
    const partes    = []
    for (let i = 0; i < hilos; i++) {
      const bStart = i * chunkSize
      const bEnd   = Math.min(bStart + chunkSize - 1, total - 1)
      if (bStart > bEnd) break
      partes.push({ start: bStart, end: bEnd, path: `${destPath}.part${i}` })
    }

    try {
      await Promise.all(partes.map(async p => {
        const res = await axios.get(mfLink, {
          responseType: 'stream',
          headers : { ...HEADERS, Referer: 'https://www.mediafire.com/', Range: `bytes=${p.start}-${p.end}` },
          httpsAgent,
          timeout : DL_TIMEOUT,
        })
        if (res.status !== 206) throw new Error(`MediaFire ignoró el rango solicitado (HTTP ${res.status})`)
        const contentRange = res.headers['content-range'] || ''
        if (!contentRange.startsWith(`bytes ${p.start}-${p.end}/`)) {
          throw new Error(`MediaFire devolvió un rango inesperado: ${contentRange || 'sin Content-Range'}`)
        }
        const tracker = new Transform({
          transform(chunk, _enc, cb) { reportar(chunk.length); cb(null, chunk) },
        })
        await pipeline(res.data, tracker, fs.createWriteStream(p.path))
      }))

      // Unir las partes en orden
      const out = fs.createWriteStream(destPath)
      for (const p of partes) {
        const expected = p.end - p.start + 1
        if (fs.statSync(p.path).size !== expected) throw new Error(`Parte incompleta: ${path.basename(p.path)}`)
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(p.path)
          rs.pipe(out, { end: false })
          rs.on('end', resolve)
          rs.on('error', reject)
        })
      }
      await new Promise(resolve => out.end(resolve))
      for (const p of partes) { try { fs.unlinkSync(p.path) } catch (_) {} }

      process.stdout.write('\n')
      console.log(`[dbs-notify] ⚡ MediaFire descargado en ${partes.length} hilos paralelos`)
      return destPath
    } catch (err) {
      process.stdout.write('\n')
      for (const p of partes) { try { fs.unlinkSync(p.path) } catch (_) {} }
      console.log(`[dbs-notify] ⚠️ Descarga paralela falló (${err.message}), reintentando en modo simple...`)
      done = 0
      lastLog = 0
      // sigue abajo al modo de un solo stream
    }
  }

  // ── Descarga simple (fallback o cuando no hay soporte de rangos) ────────────
  let mfRes
  try {
    mfRes = await axios.get(mfLink, { responseType: 'stream', headers: { ...HEADERS, Referer: 'https://www.mediafire.com/' }, httpsAgent, timeout: DL_TIMEOUT })
  } catch (err) { throw new Error(`MediaFire: ${err.message}`) }

  if (!total) total = parseInt(mfRes.headers['content-length'] || '0')

  const tracker = new Transform({
    transform(chunk, _enc, cb) {
      reportar(chunk.length)
      cb(null, chunk)
    },
  })

  try {
    await pipeline(mfRes.data, tracker, fs.createWriteStream(destPath))
    process.stdout.write('\n')
  } catch (err) {
    process.stdout.write('\n')
    throw new Error(`MediaFire: ${err.message}`)
  }
  return destPath
}

async function descargarUrlServidor(directUrl, serverUrl, outputDir, fileName, servidor) {
  if (!directUrl) throw new Error(`${servidor}: no se encontró un enlace de vídeo`)
  let parsed
  try { parsed = new URL(directUrl) } catch (_) { throw new Error(`${servidor}: URL directa no válida`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${servidor}: protocolo o credenciales de URL no permitidos`)
  }
  const destPath = path.join(outputDir, fileName)
  const partPath = `${destPath}.part`
  try {
    const res = await axios.get(parsed.href, {
      responseType: 'stream',
      headers: { ...HEADERS, Referer: serverUrl },
      httpsAgent,
      timeout: DL_TIMEOUT,
      maxRedirects: 8,
      validateStatus: status => status >= 200 && status < 300,
    })
    const contentType = String(res.headers['content-type'] || '').toLowerCase()
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      res.data.destroy()
      throw new Error(`${servidor}: el enlace no devolvió un vídeo`)
    }
    await pipeline(res.data, fs.createWriteStream(partPath))
    const size = fs.statSync(partPath).size
    if (!size) throw new Error(`${servidor}: archivo vacío`)
    fs.renameSync(partPath, destPath)
    return destPath
  } catch (err) {
    try { fs.rmSync(partPath, { force: true }) } catch (_) {}
    throw err
  }
}

async function descargarServidorVideo(serverUrl, outputDir, fileName, servidor) {
  const extraerCandidatos = (html) => {
    const encontrados = []
    const patrones = [
      /https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/gi,
      /(?:file|src|source|url|video_url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
    ]
    for (const patron of patrones) {
      for (const match of html.matchAll(patron)) {
        const raw = match[1] || match[0]
        const url = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&')
        if (url.startsWith('http') && !encontrados.includes(url)) encontrados.push(url)
      }
    }
    return encontrados
  }

  let directUrl = /\.mp4(?:[?#]|$)/i.test(serverUrl) ? serverUrl : ''
  if (!directUrl) {
    const page = await axios.get(serverUrl, {
      headers: { ...HEADERS, Referer: serverUrl },
      httpsAgent,
      timeout: 15000,
      maxRedirects: 5,
      responseType: 'text',
    })
    const candidatos = extraerCandidatos(String(page.data || ''))
    directUrl = candidatos[0] || ''
  }
  if (!directUrl) throw new Error(`${servidor}: no se encontró un enlace MP4 directo`)

  return descargarUrlServidor(directUrl, serverUrl, outputDir, fileName, servidor)
}

// ─── Enviar episodio ──────────────────────────────────────────────────────────
async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl } = ep
  const recipients = [...new Set((Array.isArray(chatId) ? chatId : [chatId]).filter(Boolean))]
  if (!recipients.length) throw new Error('No hay chats receptores configurados')
  const esLatino = ep.fuente === 'latino' || ep.idioma === 'latino'
  const fileName = buildFileName(titulo, epNum, esLatino ? 'latino' : 'dbs', ep.idioma, ep.slug)
  console.log(`[dbs-notify] 🔎 Buscando servidores para "${titulo}" ep ${epNum}...`)
  const srvs = Array.isArray(ep.servidores)
    ? ep.servidores
    : await scrapeServidoresDBS(epUrl, esLatino ? 'latino' : 'sub')
  if (!srvs.length) {
    console.log(`[dbs-notify] Sin servidores para "${titulo}" ep ${epNum}; se omite sin enviar mensajes.`)
    return false
  }
  const localTmp = path.join(process.cwd(), 'temp_videos')
  if (!fs.existsSync(localTmp)) fs.mkdirSync(localTmp, { recursive: true })
  const tmpDir = path.join(localTmp, `dbs_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const bandera = '🌐'
  const etiqueta = esLatino ? 'AnimeDBS Audio Latino 🌐' : 'AnimeDBS Sub Español 🌐'
  try {
    const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
    const caption = `*✨Nuevo Episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> ${bandera} ${titulo}\n> 🆕 Capítulo: *${epNum}*\n> 🎙️ Audio: *${esLatino ? 'Latino' : 'Sub Español'}*\n> 🕐 Publicado: *${ahora}*\n> 🌐 Ver online: ${epUrl}\n> 📡 Fuente: *${etiqueta}*\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`
    let coverBuffer = null
    try {
      const coverUrl = await getAniListCover(titulo, ep.slug) || imgUrl
      if (coverUrl) {
        const imgRes = await axios.get(coverUrl, { responseType: 'arraybuffer', headers: HEADERS, timeout: 10000 })
        coverBuffer = Buffer.from(imgRes.data)
      }
    } catch (_) {}
    for (const recipient of recipients) {
      if (coverBuffer) await conn.sendMessage(recipient, { image: coverBuffer })
      else await conn.sendMessage(recipient, { text: caption })
    }
    await new Promise(r => setTimeout(r, 15_000))
    let videoPath = null
    let downloadedFileName = fileName
    for (const srv of ordenarServidores(srvs).slice(0, 10)) {
      const nombre = (srv.nombre || 'servidor').toLowerCase()
      try {
        console.log(`[dbs-notify] 🔄 Conectando con [ ${nombre.toUpperCase()} ]...`)
        const serverFileName = fileName.replace(/\(\d{3,4}p\)/i, `(${srv.calidad || '720p'})`)
        if (nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, serverFileName)
        else if (nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, serverFileName)
        else videoPath = await descargarServidorVideo(srv.url, tmpDir, serverFileName, nombre)
        if (videoPath) downloadedFileName = serverFileName
        if (videoPath) {
          const size = fs.statSync(videoPath).size
          if (size < MIN_EPISODE_SIZE_BYTES) { console.log(`[dbs-notify] ⚠️ Archivo demasiado pequeño (${fmtBytes(size)}); probando otro servidor.`); fs.rmSync(videoPath, { force: true }); videoPath = null; continue }
          break
        }
      } catch (err) {
        console.log(`[dbs-notify] ⚠️ [ ${nombre} ] falló: ${err.message}`)
        for (const f of fs.readdirSync(tmpDir)) { try { if (f !== 'cover.jpg') fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {} }
      }
    }
    if (!videoPath) throw new Error('Todos los servidores fallaron')
    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
    let jpegThumbnail
    try { jpegThumbnail = await animeV1Downloader.createJpegThumbnail(videoPath) } catch (_) {}
    const originalBuffer = fs.readFileSync(videoPath)
    for (const recipient of recipients) {
      await conn.sendMessage(recipient, { document: originalBuffer, fileName: downloadedFileName, mimetype: 'video/mp4', jpegThumbnail })
    }
    console.log(`[dbs-notify] 🚀 Enviado: ${downloadedFileName} (${sizeMB} MB) a ${recipients.length} chat(s)`)
    const fileName360 = build360FileName(downloadedFileName)
    const video360Path = path.join(tmpDir, fileName360)
    try {
      await compressDw4(videoPath, video360Path, { label: 'DW4 AnimeDBS' })
      const jpegThumbnail360 = await animeV1Downloader.createJpegThumbnail(video360Path)
      const video360Buffer = fs.readFileSync(video360Path)
      for (const recipient of recipients) {
        await conn.sendMessage(recipient, { document: video360Buffer, fileName: fileName360, mimetype: 'video/mp4', jpegThumbnail: jpegThumbnail360 })
      }
      console.log(`[dbs-notify] 🚀 Enviado /dw4 360p: ${fileName360}`)
    } catch (error) {
      console.error(`[dbs-notify] No se pudo crear o enviar 360p: ${error.message}`)
      await reportDbsError(conn, `Versión 360p de ${titulo} ep. ${epNum}`, error)
      for (const recipient of recipients) {
        try { await conn.sendMessage(recipient, { text: `⚠️ El original de *${titulo}* ep. *${zeroPad(epNum)}* fue enviado, pero falló la versión 360p.` }) } catch (_) {}
      }
    }
    return true
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} }
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

async function procesarCola() {
  if (global.dbsQueueRunning || !global.dbsEpisodeQueue.length) return
  global.dbsQueueRunning = true
  const MAX_REINTENTOS = 3
  const ESPERA_REINTENTO = 3 * 60_000
  const ESPERA_REQUEUE = 5 * 60_000
  try {
    while (global.dbsEpisodeQueue.length) {
      const item = global.dbsEpisodeQueue[0]
      if (!item) { global.dbsEpisodeQueue.shift(); continue }
      const recipients = item.recipients || (item.chatId ? [item.chatId] : [])
      const activeRecipients = item.manual
        ? recipients
        : recipients.filter(chatId => global.dbsActiveChats.has(chatId))
      const { ep, manual = false } = item
      const removeItem = () => {
        const index = global.dbsEpisodeQueue.indexOf(item)
        if (index !== -1) global.dbsEpisodeQueue.splice(index, 1)
      }
      const clearQueued = () => recipients.forEach(chatId => global.dbsQueuedIds.delete(`${chatId}:${ep.id}`))
      if (!activeRecipients.length) { removeItem(); clearQueued(); continue }

      let sent = false
      for (let attempt = 1; attempt <= MAX_REINTENTOS && !sent; attempt++) {
        if (!manual && !activeRecipients.some(chatId => global.dbsActiveChats.has(chatId))) {
          removeItem(); clearQueued(); break
        }
        const conn = global.dbsConn
        if (!conn) { await new Promise(resolve => setTimeout(resolve, ESPERA_REINTENTO)); continue }
        try {
          const result = await enviarEpisodio(activeRecipients, ep, conn)
          if (result === false) { removeItem(); clearQueued(); sent = true; break }
          const seen = loadSeen()
          for (const chatId of activeRecipients) {
            if (!seen[chatId]) seen[chatId] = []
            for (const seenId of ep.variantSeenIds || [ep.id]) {
              if (!seen[chatId].includes(seenId)) seen[chatId].push(seenId)
            }
            if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
          }
          saveSeen(seen)
          const state = loadState()
          for (const chatId of activeRecipients) {
            const count = (Number(state[chatId]?.sentCount) || 0) + 1
            if (state[chatId]) state[chatId].sentCount = count
            const active = global.dbsActiveChats.get(chatId)
            if (active) active.sentCount = count
          }
          saveState(state)
          removeItem(); clearQueued(); sent = true
        } catch (error) {
          const connectionError = /connection closed|stream errored|timed out|econnreset|econnrefused|socket hang up|precondition required/i.test(error.message)
          if (connectionError && attempt < MAX_REINTENTOS) {
            await new Promise(resolve => setTimeout(resolve, ESPERA_REINTENTO * attempt))
          } else if (connectionError) {
            removeItem()
            global.dbsEpisodeQueue.push({ recipients, ep, manual })
            await new Promise(resolve => setTimeout(resolve, ESPERA_REQUEUE))
            sent = true
          } else {
            removeItem(); clearQueued()
            await reportDbsError(conn, `Entrega de ${ep.titulo} ep. ${ep.epNum}`, error)
            for (const chatId of activeRecipients) {
              try { await conn.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${error.message}` }) } catch (_) {}
            }
            sent = true
          }
        }
      }
      if (global.dbsEpisodeQueue.length) await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY))
    }
  } catch (error) {
    await reportDbsError(global.dbsConn, 'Cola de episodios', error)
  } finally { global.dbsQueueRunning = false }
}

async function checkNuevosEpisodiosGlobal(conn) {
  if (global.dbsChecking) return
  global.dbsChecking = true
  try {
    let lista
    try { lista = await fetchLatestEpisodesDBS() }
    catch (error) { await reportDbsError(conn, 'Consulta AnimeDBS', error); return }
    if (!lista.length || !global.dbsActiveChats.size) return
    const seen = loadSeen()
    const nuevosPorChat = new Map()
    for (const chatId of global.dbsActiveChats.keys()) {
      if (!Array.isArray(seen[chatId]) || !seen[chatId].length) {
        seedChatSeen(chatId, lista, seen)
        continue
      }
      const nuevos = await seleccionarVersionPreferidaDBS(lista, { seen: seen[chatId], chatId, skipQueued: true })
      if (nuevos.length) nuevosPorChat.set(chatId, nuevos)
    }
    saveSeen(seen)
    const grouped = new Map()
    for (const [chatId, episodes] of nuevosPorChat) {
      for (const ep of episodes) {
        if (!grouped.has(ep.id)) grouped.set(ep.id, { ep, recipients: [] })
        grouped.get(ep.id).recipients.push(chatId)
      }
    }
    for (const { ep, recipients } of grouped.values()) {
      global.dbsEpisodeQueue.push({ recipients, ep, manual: false })
      recipients.forEach(chatId => global.dbsQueuedIds.add(`${chatId}:${ep.id}`))
    }
    if (grouped.size) procesarCola().catch(error => reportDbsError(global.dbsConn, 'Procesamiento de cola', error))
  } finally { global.dbsChecking = false }
}

async function checkNuevosEpisodios(_chatId, conn) {
  return checkNuevosEpisodiosGlobal(conn || global.dbsConn)
}

function iniciarSondeoGlobal(conn, intervalSec, checkNow = false) {
  if (conn) global.dbsConn = conn
  if (global.dbsGlobalTimer) clearInterval(global.dbsGlobalTimer)
  global.dbsGlobalTimer = setInterval(() => {
    if (global.dbsConn) checkNuevosEpisodiosGlobal(global.dbsConn).catch(error => reportDbsError(global.dbsConn, 'Sondeo global', error))
  }, intervalSec * 1000)
  if (global.dbsGlobalTimer.unref) global.dbsGlobalTimer.unref()
  if (checkNow && global.dbsConn) checkNuevosEpisodiosGlobal(global.dbsConn).catch(error => reportDbsError(global.dbsConn, 'Sondeo inicial', error))
}

function iniciarNotificador(chatId, conn, intervalSec = null, checkNow = false) {
  if (conn) global.dbsConn = conn
  intervalSec = Number(intervalSec) || getGlobalIntervalSec()
  const state = loadState()
  const startedAt = state[chatId]?.startedAt || Date.now()
  const sentCount = Number(state[chatId]?.sentCount) || 0
  global.dbsActiveChats.set(chatId, { intervalSec, startedAt, sentCount })
  state[chatId] = { intervalSec, startedAt, sentCount }
  saveState(state)
  const interval = Math.min(...[...global.dbsActiveChats.values()].map(entry => entry.intervalSec))
  iniciarSondeoGlobal(conn, interval, checkNow)
}

function detenerNotificador(chatId) {
  global.dbsActiveChats.delete(chatId)
  for (const item of global.dbsEpisodeQueue) {
    if (!item.recipients?.includes(chatId)) continue
    item.recipients = item.recipients.filter(id => id !== chatId)
    global.dbsQueuedIds.delete(`${chatId}:${item.ep.id}`)
  }
  global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(item => item.recipients?.length)
  const state = loadState()
  delete state[chatId]
  saveState(state)
  if (!global.dbsActiveChats.size && global.dbsGlobalTimer) {
    clearInterval(global.dbsGlobalTimer)
    global.dbsGlobalTimer = null
  }
}

function restaurarNotificadores(conn) {
  const state = loadState()
  for (const [chatId, cfg] of Object.entries(state)) {
    if (chatId !== '__config' && !global.dbsActiveChats.has(chatId)) {
      iniciarNotificador(chatId, conn, cfg.intervalSec || getGlobalIntervalSec())
    }
  }
}

if (!global.dbsWatchdog) {
  global.dbsWatchdog = setInterval(() => restaurarNotificadores(global.dbsConn), 2 * 60 * 1000)
  if (global.dbsWatchdog.unref) global.dbsWatchdog.unref()
}
let handler = async (m, { conn, text, usedPrefix, command, isOwner }) => {
  if (conn) global.dbsConn = conn
  restaurarNotificadores(conn)
  const OWNER_COMMANDS = ['dbsstart','dbsstop','dbsinterval','dbsflush','dbsunblock','dbsexample']
  if (OWNER_COMMANDS.includes(command) && !isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el *owner* puede usar este comando.' }, { quoted: m })
  if (command === 'dbsstart') {
    const value = Number.parseInt(text?.trim(), 10)
    const intervalSec = Number.isInteger(value) && value >= MIN_INTERVAL_SECONDS && value <= MAX_INTERVAL_SECONDS ? value : CHECK_INTERVAL_SECONDS
    iniciarNotificador(m.chat, conn, intervalSec, false)
    let lista = []
    try {
      lista = await fetchLatestEpisodesDBS()
      const seen = loadSeen(); if (!seen[m.chat]) seen[m.chat] = []
      for (const ep of lista) if (!seen[m.chat].includes(ep.id)) seen[m.chat].push(ep.id)
      seen[m.chat] = seen[m.chat].slice(-500); saveSeen(seen)
    } catch (_) {}
    await conn.sendMessage(m.chat, { text: `✅ *Notificador AnimeDBS activado*\n\n┃ ⏱️ *Intervalo:* \`${formatInterval(intervalSec)}\`\n┃ 🌐 *AnimeDBS* — \`SUB + Audio Latino (LAT)\`\n┃ 💬 *Chat Activo*\n📋 *${lista.length}* episodios registrados como base.\n> Solo los nuevos se enviarán.\n*Usa \`${usedPrefix}dbsstop\` para detener*\n*Usa \`${usedPrefix}dbsstatus\` para ver el estado*` }, { quoted: m })
    return
  }
  if (command === 'dbsstop') {
    if (!global.dbsActiveChats.has(m.chat)) return m.reply('ℹ️ El notificador no estaba activo.')
    const entry = global.dbsActiveChats.get(m.chat); const activeTime = formatActiveTime(entry.startedAt); const sentCount = Number(entry.sentCount) || 0
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido*\n\n├ Activo: *${activeTime}*\n└ Avisos enviados: *${sentCount}*\n\n*Usa ${usedPrefix}dbsstart para reactivarlo.*`)
  }
  if (command === 'dbsstatus') {
    const active = global.dbsActiveChats.has(m.chat); const entry = global.dbsActiveChats.get(m.chat); const cola = global.dbsEpisodeQueue.filter(i => i.recipients?.includes(m.chat) || i.chatId === m.chat); const vistos = (loadSeen()[m.chat] || []).length
    let txt = `📡 *Estado AnimeDBS (SUB + LAT)*\n\n${active ? `✅ *Activo* — cada ${formatInterval(entry.intervalSec)}` : '🔴 *Inactivo*'}\n📋 Cola: *${cola.length}* pendiente(s)\n🔵 Procesando: *${global.dbsQueueRunning ? 'Sí' : 'No'}*\n👁️ Vistos: *${vistos}*`
    if (cola.length) txt += `\n\n*En cola:*\n` + cola.slice(0,5).map((i,n) => `  ${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)}`).join('\n')
    return m.reply(txt)
  }
  if (command === 'dbsqueue') return m.reply(global.dbsEpisodeQueue.length ? `📋 *Cola (${global.dbsEpisodeQueue.length}):*\n\n` + global.dbsEpisodeQueue.map((i,n) => `${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} [${i.recipients?.includes(m.chat) ? 'este chat' : 'otro chat'}]`).join('\n') : '✅ Cola vacía.')
  if (command === 'dbsflush') { const antes = global.dbsEpisodeQueue.length; let removed = 0; for (const item of global.dbsEpisodeQueue) { if (!item.recipients?.includes(m.chat)) continue; item.recipients = item.recipients.filter(id => id !== m.chat); global.dbsQueuedIds.delete(`${m.chat}:${item.ep.id}`); removed++ } global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(item => item.recipients?.length); return m.reply(`🗑️ *${removed}* episodio(s) eliminado(s) de este chat.`) }
  if (command === 'dbsunblock') { const estaba = global.dbsQueueRunning; if (global.dbsEpisodeQueue.length) { await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.dbsEpisodeQueue.length} episodio(s)...`); if (!estaba) procesarCola().catch(() => {}) } else await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\nℹ️ No hay episodios pendientes.`); return }
  if (command === 'dbscheck') { await m.reply('🔍 Chequeando episodios SUB + LAT de AnimeDBS...'); try { await checkNuevosEpisodios(m.chat, conn); if (!global.dbsEpisodeQueue.some(i => i.recipients?.includes(m.chat) || i.chatId === m.chat)) await m.reply('✅ Sin episodios nuevos.') } catch (err) { await m.reply(`❌ Error: ${err.message}`) }; return }
  if (command === 'dbsinterval') { const seconds = parseIntervalInput(text); if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) return m.reply(`❌ Usa entre *${MIN_INTERVAL_SECONDS} segundos* y *${MAX_INTERVAL_SECONDS / 60} minutos*.\nEjemplos: *${usedPrefix}dbsinterval 60s* o *${usedPrefix}dbsinterval 10m*`); if (!global.dbsActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}dbsstart* primero.`); setGlobalIntervalSec(seconds); for (const chatId of Object.keys(loadState()).filter(id => id !== '__config')) iniciarNotificador(chatId, conn, seconds, false); return m.reply(`⏱️ Intervalo global actualizado a *${formatInterval(seconds)}*.`) }
  if (command === 'dbsexample') { const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10); await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *AnimeDBS*...`); let lista; try { lista = await fetchLatestEpisodesDBS(); if (!lista.length) return m.reply('❌ Sin episodios de AnimeDBS disponibles.'); lista = await seleccionarVersionPreferidaDBS(lista, { limit: cantidad }); if (!lista.length) return m.reply('❌ No hay enlaces SUB ni LAT disponibles.') } catch (err) { return m.reply(`❌ Error: ${err.message}`) }; const seleccion = lista.slice(0,cantidad); if (seleccion.length > 1) await m.reply(`📋 *${seleccion.length} episodios más recientes (según fecha de publicación):*\n\n` + seleccion.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)} (${e.idioma.toUpperCase()})`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._'); for (const ep of seleccion) { const id = `${m.chat}:${ep.id}`; if (global.dbsQueuedIds.has(id)) continue; global.dbsEpisodeQueue.push({ recipients:[m.chat], ep, manual:true }); global.dbsQueuedIds.add(id) }; procesarCola().catch(() => {}); return }
}
handler.command = /^(dbsstart|dbsstop|dbsstatus|dbscheck|dbsqueue|dbsflush|dbsunblock|dbsinterval|dbsexample)$/i
handler.tags = ['anime','notificaciones']
handler.help = ['dbsstart [segundos]','dbsstop','dbsstatus','dbscheck','dbsqueue','dbsflush','dbsunblock','dbsinterval <segundos>','dbsexample [N]']
handler.exp = 0; handler.level = 0; handler.limit = false
handler.before = async (m, { conn }) => { if (conn) global.dbsConn = conn; restaurarNotificadores(conn) }
export default handler
