// plugins/dbs-notify.js — v3.2
//
// Notificador automático de nuevos episodios — AnimeDBS (SUB ESPAÑOL)

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
import { fetchTeraBox } from './terabox-dowloader.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const ANIMEDBS_URL          = 'https://www.animedbs.online'
const DBS_LATINO_CATALOG_URL = `${ANIMEDBS_URL}/anime/?sub=lat&order=update`

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

const DBS_SERVIDORES = new Set(['mega', 'mediafire', 'directo', 'terabox'])

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

// ─── Estado global ────────────────────────────────────────────────────────────

global.dbsActiveChats  = global.dbsActiveChats  || new Map()
global.dbsEpisodeQueue = global.dbsEpisodeQueue || []
global.dbsQueueRunning = global.dbsQueueRunning || false
global.dbsConn         = global.dbsConn         || null
global.dbsQueuedIds    = global.dbsQueuedIds    || new Set()
global.dbsCheckingChats = global.dbsCheckingChats || new Set()

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
  if (/(?:^|\.)(?:terabox\.com|teraboxapp\.com|1024terabox\.com|terabox\.app|teraboxshare\.com|teraboxlink\.com)$/.test(host)) return 'terabox'
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
  const addEpisode = ({ href, title, epNum, imgUrl = '', latino = false }) => {
    const epUrl = absoluteUrl(href, ANIMEDBS_URL)
    const number = Number.parseInt(epNum, 10)
    if (!epUrl || !Number.isInteger(number) || number < 0) return
    const titulo = String(title || '').replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').trim() || 'Anime desconocido'
    const slug = titulo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const id = `${latino ? 'dbs-lat' : 'dbs'}-${slug}-${number}`
    if (ids.has(id)) return
    ids.add(id)
    lista.push({ id, slug, titulo, epNum: number, epUrl, imgUrl, fuente: latino ? 'latino' : 'animedbs', idioma: latino ? 'latino' : 'sub' })
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
    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    const imgUrl = imgSrc.startsWith('data:') ? '' : absoluteUrl(imgSrc, ANIMEDBS_URL)
    const latino = /latino/i.test(`${href} ${titulo} ${$el.find('.lg').text()}`)
    addEpisode({ href, title: titulo, epNum: epNumStr, imgUrl, latino })
  })

  // "Audio Latino" es un catálogo de series: cada tarjeta lleva a una página
  // con el listado de episodios, cuyo más reciente aparece primero en .eplister.
  try {
    const { data: catalogHtml } = await getPage(DBS_LATINO_CATALOG_URL, { headers: HEADERS })
    const $catalog = cheerio.load(catalogHtml)
    const series = []
    $catalog('.listupd .bs').each((_, el) => {
      const $el = $catalog(el)
      if (!/emisi[oó]n/i.test($el.find('.epx').text())) return
      const href = $el.find('a[href]').first().attr('href') || ''
      if (href) series.push({ href, title: $el.find('.tt').text().trim() || $el.find('h2').text().trim() })
    })

    const concurrency = 5
    for (let i = 0; i < series.length; i += concurrency) {
      await Promise.all(series.slice(i, i + concurrency).map(async item => {
        try {
          const seriesUrl = absoluteUrl(item.href, ANIMEDBS_URL)
          const { data: seriesHtml } = await getPage(seriesUrl, { headers: { ...HEADERS, Referer: DBS_LATINO_CATALOG_URL } })
          const $series = cheerio.load(seriesHtml)
          const $episode = $series('.eplister a[href]').first()
          const episodeHref = $episode.attr('href') || ''
          const epNum = episodeHref.match(/episodio[- _]?(\d+)/i)?.[1] || $episode.text().match(/\d+/)?.[0]
          const title = $series('h1').first().text().trim() || item.title
          const imgEl = $series('.thumb img, .thumbook img').first()
          const imgSrc = imgEl.attr('data-src') || imgEl.attr('src') || ''
          const imgUrl = imgSrc.startsWith('data:') ? '' : absoluteUrl(imgSrc, seriesUrl)
          if (episodeHref && epNum) addEpisode({ href: episodeHref, title, epNum, imgUrl, latino: true })
        } catch (err) {
          console.error(`[dbs-notify] No se pudo revisar una serie del catálogo LAT (${item.href}): ${err.message}`)
        }
      }))
    }
  } catch (err) {
    console.error(`[dbs-notify] Catálogo Audio Latino no disponible: ${err.message}`)
  }

  console.log(`[dbs-notify] ${lista.length} episodios recientes detectados (SUB + LAT)`)
  return lista
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
    const siteHost = new URL(ANIMEDBS_URL).hostname.toLowerCase()
    if ((parsed.hostname.toLowerCase() === siteHost || parsed.hostname.toLowerCase().endsWith(`.${siteHost}`)) && !/\.mp4(?:$|[?#])/i.test(url)) return
    const nombre = detectarServidor(url, label) || (allowDirect && /\.mp4(?:$|[?#])/i.test(url) ? 'directo' : '')
    if (!nombre || !DBS_SERVIDORES.has(nombre)) return
    const directDownload = ['mega', 'mediafire', 'directo'].includes(nombre)
    srvs.push({ nombre, url, calidad: calidadDesde(calidad, label, parsed.pathname) || (nombre === 'terabox' ? '1080p' : '720p'), directo: directDownload })
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
  // El sitio puede omitir las clases del bloque; aun así sólo se aceptan los cuatro tipos esperados.
  $('a[href]').each((_, el) => {
    const $el = $(el)
    const $languageBlock = $el.closest('.soraddlx')
    if (bloquesIdioma.length && !$languageBlock.length) return
    if ($languageBlock.length && !bloqueCoincide($languageBlock[0])) return
    const label = `${$el.text().trim()} ${$el.attr('title') || ''}`
    const context = $el.closest('.soraddlx, .soraurlx, .download, .downloads, .links').text()
    add($el.attr('href') || '', label, calidadDesde(context, label))
  })
  $('[data-src], [data-player], [data-url], iframe[src]').each((_, el) => {
    const $el = $(el)
    const raw = $el.attr('data-src') || $el.attr('data-player') || $el.attr('data-url') || $el.attr('src') || ''
    const context = $el.closest('.soraddlx, .soraurlx, .download, .downloads, .links').text()
    add(raw, `${$el.attr('title') || ''} ${context}`, calidadDesde(context), true)
  })
  srvs.sort((a, b) => {
    if (a.directo !== b.directo) return a.directo ? -1 : 1
    const rank = v => /720/i.test(v) ? 0 : /1080/i.test(v) ? 1 : 2
    return rank(a.calidad) - rank(b.calidad)
  })
  return srvs
}

// ─── Descarga ─────────────────────────────────────────────────────────────────

const PREFS_DBS = ['directo', 'mediafire', 'mega', 'terabox']

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
        res.data.on('data', chunk => reportar(chunk.length))
        await pipeline(res.data, fs.createWriteStream(p.path))
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
      done = 0 // reiniciar contador para el fallback
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

async function descargarTeraBox(serverUrl, outputDir, fileName) {
  const files = await fetchTeraBox(serverUrl)
  const item = files.find(file => /\.(?:mp4|mkv|mov|avi|webm)$/i.test(file.file_name || '')) || files[0]
  const directUrl = item?.stream_final_url || item?.stream_url || item?.download_url
  if (!directUrl) throw new Error('TeraBox: la API no devolvió un enlace de descarga')
  return descargarUrlServidor(directUrl, serverUrl, outputDir, fileName, 'TeraBox')
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
  const esLatino = ep.fuente === 'latino' || ep.idioma === 'latino'
  const fileName = buildFileName(titulo, epNum, esLatino ? 'latino' : 'dbs')
  console.log(`[dbs-notify] 🔎 Buscando servidores para "${titulo}" ep ${epNum}...`)
  const srvs = await scrapeServidoresDBS(epUrl, esLatino ? 'latino' : 'sub')
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
    if (imgUrl) {
      try { const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: HEADERS, timeout: 10000 }); await conn.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption }) }
      catch (_) { await conn.sendMessage(chatId, { text: caption }) }
    } else await conn.sendMessage(chatId, { text: caption })
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
        else if (nombre === 'terabox') videoPath = await descargarTeraBox(srv.url, tmpDir, serverFileName)
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
    const jpegThumbnail = await animeV1Downloader.createJpegThumbnail(videoPath)
    await conn.sendMessage(chatId, { document: { url: videoPath }, fileName: downloadedFileName, mimetype: 'video/mp4', jpegThumbnail })
    console.log(`[dbs-notify] 🚀 Enviado: ${fileName} (${sizeMB} MB)`)
    const fileName360 = build360FileName(downloadedFileName)
    const video360Path = path.join(tmpDir, fileName360)
    try {
      await compressDw4(videoPath, video360Path, { label: 'DW4 AnimeDBS' })
      const jpegThumbnail360 = await animeV1Downloader.createJpegThumbnail(video360Path)
      await conn.sendMessage(chatId, { document: { url: video360Path }, fileName: fileName360, mimetype: 'video/mp4', jpegThumbnail: jpegThumbnail360 })
      console.log(`[dbs-notify] 🚀 Enviado /dw4 360p: ${fileName360}`)
    } catch (error) {
      console.error(`[dbs-notify] No se pudo crear o enviar 360p: ${error.message}`)
      try { await conn.sendMessage(chatId, { text: `⚠️ El original de *${titulo}* ep. *${zeroPad(epNum)}* fue enviado, pero falló la versión 360p.` }) } catch (_) {}
    }
    return true
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} }
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

async function procesarCola() {
  if (global.dbsQueueRunning) return
  if (!global.dbsEpisodeQueue.length) return
  global.dbsQueueRunning = true

  const MAX_REINTENTOS   = 3
  const ESPERA_REINTENTO = 3 * 60_000
  const ESPERA_REQUEUEUE = 5 * 60_000

  try {
    while (global.dbsEpisodeQueue.length > 0) {
      const item = global.dbsEpisodeQueue[0]
      if (!item) { global.dbsEpisodeQueue.shift(); continue }
      const { chatId, ep, manual = false } = item
      const quitarItemActual = () => {
        const index = global.dbsEpisodeQueue.indexOf(item)
        if (index !== -1) global.dbsEpisodeQueue.splice(index, 1)
      }
      if (!manual && !global.dbsActiveChats.has(chatId)) {
        quitarItemActual()
        global.dbsQueuedIds.delete(`${chatId}:${ep.id}`)
        continue
      }
      let intentos = 0
      let exito    = false
      let omitidoSinServidores = false

      while (intentos < MAX_REINTENTOS && !exito) {
        intentos++
        if (!manual && !global.dbsActiveChats.has(chatId)) {
          quitarItemActual()
          global.dbsQueuedIds.delete(`${chatId}:${ep.id}`)
          break
        }
        const connActivo = global.dbsConn
        if (!connActivo) {
          await new Promise(r => setTimeout(r, ESPERA_REINTENTO))
          continue
        }
        try {
          const enviado = await enviarEpisodio(chatId, ep, connActivo)
          if (enviado === false) {
            quitarItemActual()
            global.dbsQueuedIds.delete(`${chatId}:${ep.id}`)
            omitidoSinServidores = true
            exito = true
            break
          }
          exito = true
          const seen = loadSeen()
          if (!seen[chatId]) seen[chatId] = []
          if (!seen[chatId].includes(ep.id)) seen[chatId].push(ep.id)
          if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
          saveSeen(seen)
          const state = loadState()
          const sentCount = (Number(state[chatId]?.sentCount) || 0) + 1
          if (state[chatId]) state[chatId].sentCount = sentCount
          const active = global.dbsActiveChats.get(chatId)
          if (active) active.sentCount = sentCount
          saveState(state)
          quitarItemActual()
          global.dbsQueuedIds.delete(`${chatId}:${ep.id}`)
        } catch (err) {
          const esConexion = /connection closed|stream errored|timed out|econnreset|econnrefused|socket hang up|precondition required/i.test(err.message)
          if (esConexion && intentos < MAX_REINTENTOS) {
            await new Promise(r => setTimeout(r, ESPERA_REINTENTO * intentos))
          } else if (esConexion) {
            quitarItemActual()
            global.dbsEpisodeQueue.push({ chatId, ep, manual })
            await new Promise(r => setTimeout(r, ESPERA_REQUEUEUE))
            break
          } else {
            quitarItemActual()
            global.dbsQueuedIds.delete(`${chatId}:${ep.id}`)
            try {
              const connErr = global.dbsConn
              if (connErr) await connErr.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}` })
            } catch (_) {}
          }
        }
      }
      if (omitidoSinServidores) continue
      if (global.dbsEpisodeQueue.length > 0) await new Promise(r => setTimeout(r, QUEUE_DELAY))
    }
  } catch (fatalErr) {
    console.error(`[dbs-notify] Error fatal en la cola: ${fatalErr.message}`)
  } finally {
    global.dbsQueueRunning = false
  }
}

async function checkNuevosEpisodios(chatId, conn) {
  if (global.dbsCheckingChats.has(chatId)) return
  global.dbsCheckingChats.add(chatId)
  let lista = []
  try {
    try { lista = await fetchLatestEpisodesDBS() } catch (err) { console.error(`[dbs-notify] AnimeDBS: ${err.message}`) }
    if (!lista.length) return

    const seen = loadSeen()
    if (!global.dbsActiveChats.has(chatId)) return
    if (!seen[chatId]) seen[chatId] = []
    const nuevos = lista.filter(e => !seen[chatId].includes(e.id) && !global.dbsQueuedIds.has(`${chatId}:${e.id}`))
    if (!nuevos.length) return

    for (const ep of nuevos) {
      global.dbsEpisodeQueue.push({ chatId, ep })
      global.dbsQueuedIds.add(`${chatId}:${ep.id}`)
    }
    procesarCola().catch(err => console.error(`[dbs-notify] Error procesando cola: ${err.message}`))
  } finally {
    global.dbsCheckingChats.delete(chatId)
  }
}

function iniciarNotificador(chatId, conn, intervalSec = null, checkNow = true) {
  if (conn) global.dbsConn = conn
  if (global.dbsActiveChats.has(chatId)) clearInterval(global.dbsActiveChats.get(chatId).timer)
  intervalSec = Number(intervalSec) || getGlobalIntervalSec()
  const timer = setInterval(() => {
    const c = global.dbsConn
    if (!c) return
    checkNuevosEpisodios(chatId, c).catch(e => {})
  }, intervalSec * 1000)
  const state = loadState()
  const startedAt = Date.now()
  const sentCount = Number(state[chatId]?.sentCount) || 0
  global.dbsActiveChats.set(chatId, { timer, intervalSec, startedAt, sentCount })
  state[chatId] = { intervalSec, startedAt, sentCount }
  saveState(state)
  // No esperar hasta el siguiente tick: detecta novedades al activar/restaurar.
  if (checkNow && global.dbsConn) checkNuevosEpisodios(chatId, global.dbsConn).catch(() => {})
}

function detenerNotificador(chatId) {
  const entry = global.dbsActiveChats.get(chatId)
  if (entry) { clearInterval(entry.timer); global.dbsActiveChats.delete(chatId) }
  const pendientes = global.dbsEpisodeQueue.filter(item => item.chatId === chatId)
  global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(item => item.chatId !== chatId)
  for (const item of pendientes) global.dbsQueuedIds.delete(`${chatId}:${item.ep.id}`)
  const state = loadState()
  delete state[chatId]
  saveState(state)
}

function restaurarNotificadores(conn) {
  const state = loadState()
  for (const [chatId, cfg] of Object.entries(state)) {
    if (chatId === '__config') continue
    if (!global.dbsActiveChats.has(chatId)) {
      iniciarNotificador(chatId, conn, getGlobalIntervalSec())
    }
  }
}

if (!global.dbsWatchdog) {
  global.dbsWatchdog = setInterval(() => {
    const conn = global.dbsConn
    if (!conn) return
    const state = loadState()
    for (const [chatId, cfg] of Object.entries(state)) {
      if (chatId === '__config') continue
      if (!global.dbsActiveChats.has(chatId)) {
        iniciarNotificador(chatId, conn, getGlobalIntervalSec())
      }
    }
  }, 2 * 60 * 1000)
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
    await conn.sendMessage(m.chat, { text: `✅ *Notificador AnimeDBS activado*\n\n┃ ⏱️ *Intervalo:* \`${formatInterval(intervalSec)}\`\n┃ 🌐 *AnimeDBS* — \`SUB + Audio Latino\`\n┃ 💬 *Chat Activo*\n📋 *${lista.length}* episodios registrados como base.\n> Solo los nuevos se enviarán.\n*Usa \`${usedPrefix}dbsstop\` para detener*\n*Usa \`${usedPrefix}dbsstatus\` para ver el estado*` }, { quoted: m })
    return
  }
  if (command === 'dbsstop') {
    if (!global.dbsActiveChats.has(m.chat)) return m.reply('ℹ️ El notificador no estaba activo.')
    const entry = global.dbsActiveChats.get(m.chat); const activeTime = formatActiveTime(entry.startedAt); const sentCount = Number(entry.sentCount) || 0
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido*\n\n├ Activo: *${activeTime}*\n└ Avisos enviados: *${sentCount}*\n\n*Usa ${usedPrefix}dbsstart para reactivarlo.*`)
  }
  if (command === 'dbsstatus') {
    const active = global.dbsActiveChats.has(m.chat); const entry = global.dbsActiveChats.get(m.chat); const cola = global.dbsEpisodeQueue.filter(i => i.chatId === m.chat); const vistos = (loadSeen()[m.chat] || []).length
    let txt = `📡 *Estado AnimeDBS*\n\n${active ? `✅ *Activo* — cada ${formatInterval(entry.intervalSec)}` : '🔴 *Inactivo*'}\n📋 Cola: *${cola.length}* pendiente(s)\n🔵 Procesando: *${global.dbsQueueRunning ? 'Sí' : 'No'}*\n👁️ Vistos: *${vistos}*`
    if (cola.length) txt += `\n\n*En cola:*\n` + cola.slice(0,5).map((i,n) => `  ${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)}`).join('\n')
    return m.reply(txt)
  }
  if (command === 'dbsqueue') return m.reply(global.dbsEpisodeQueue.length ? `📋 *Cola (${global.dbsEpisodeQueue.length}):*\n\n` + global.dbsEpisodeQueue.map((i,n) => `${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} [${i.chatId === m.chat ? 'este chat' : 'otro chat'}]`).join('\n') : '✅ Cola vacía.')
  if (command === 'dbsflush') { const antes = global.dbsEpisodeQueue.length; const removed = global.dbsEpisodeQueue.filter(i => i.chatId === m.chat); global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(i => i.chatId !== m.chat); for (const item of removed) global.dbsQueuedIds.delete(`${item.chatId}:${item.ep.id}`); return m.reply(`🗑️ *${antes - global.dbsEpisodeQueue.length}* episodio(s) eliminado(s).`) }
  if (command === 'dbsunblock') { const estaba = global.dbsQueueRunning; if (global.dbsEpisodeQueue.length) { await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.dbsEpisodeQueue.length} episodio(s)...`); if (!estaba) procesarCola().catch(() => {}) } else await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\nℹ️ No hay episodios pendientes.`); return }
  if (command === 'dbscheck') { await m.reply('🔍 Chequeando AnimeDBS...'); try { await checkNuevosEpisodios(m.chat, conn); if (!global.dbsEpisodeQueue.some(i => i.chatId === m.chat)) await m.reply('✅ Sin episodios nuevos.') } catch (err) { await m.reply(`❌ Error: ${err.message}`) }; return }
  if (command === 'dbsinterval') { const seconds = parseIntervalInput(text); if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) return m.reply(`❌ Usa entre *${MIN_INTERVAL_SECONDS} segundos* y *${MAX_INTERVAL_SECONDS / 60} minutos*.\nEjemplos: *${usedPrefix}dbsinterval 60s* o *${usedPrefix}dbsinterval 10m*`); if (!global.dbsActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}dbsstart* primero.`); setGlobalIntervalSec(seconds); for (const chatId of Object.keys(loadState()).filter(id => id !== '__config')) iniciarNotificador(chatId, conn, seconds, false); return m.reply(`⏱️ Intervalo global actualizado a *${formatInterval(seconds)}*.`) }
  if (command === 'dbsexample') { const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10); await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *AnimeDBS*...`); let lista; try { lista = await fetchLatestEpisodesDBS(); if (!lista.length) return m.reply('❌ Sin episodios de AnimeDBS disponibles.') } catch (err) { return m.reply(`❌ Error: ${err.message}`) }; const seleccion = lista.slice(0,cantidad); if (seleccion.length > 1) await m.reply(`📋 *${seleccion.length} episodios seleccionados (AnimeDBS 🌐):*\n\n` + seleccion.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._'); for (const ep of seleccion) { const id = `${m.chat}:${ep.id}`; if (global.dbsQueuedIds.has(id)) continue; global.dbsEpisodeQueue.push({ chatId:m.chat, ep, manual:true }); global.dbsQueuedIds.add(id) }; procesarCola().catch(() => {}); return }
}
handler.command = /^(dbsstart|dbsstop|dbsstatus|dbscheck|dbsqueue|dbsflush|dbsunblock|dbsinterval|dbsexample)$/i
handler.tags = ['anime','notificaciones']
handler.help = ['dbsstart [segundos]','dbsstop','dbsstatus','dbscheck','dbsqueue','dbsflush','dbsunblock','dbsinterval <segundos>','dbsexample [N]']
handler.exp = 0; handler.level = 0; handler.limit = false
handler.before = async (m, { conn }) => { if (conn) global.dbsConn = conn; restaurarNotificadores(conn) }
export default handler
