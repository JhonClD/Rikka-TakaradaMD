// plugins/tioanime-notify.js — v3.2
//
// Notificador automático de nuevos episodios — TioAnime (SUB) + LatAnime (LAT/ESP)

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

// ─── Constantes ───────────────────────────────────────────────────────────────

const TIOANIME_URL           = 'https://tioanime.com'
const LATANIME_URL           = 'https://latanime.org'

// [CORRECCIÓN 1] Crear carpeta 'database' para no perder datos al reiniciar
const DB_DIR = path.join(process.cwd(), 'database')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const SEEN_FILE              = path.join(DB_DIR, 'tioanime_seen.json')
const STATE_FILE             = path.join(DB_DIR, 'tioanime_state.json')

const CHECK_INTERVAL_DEFAULT = 10        // minutos
const QUEUE_DELAY            = 90_000    // ms entre ítems de cola (90 seg)
const DL_TIMEOUT             = 3 * 60 * 60 * 1000

// [MEJORA VELOCIDAD] megajs descarga por bloques y conexiones paralelas.
// Se puede ajustar con MEGA_MAX_CONNECTIONS; se limita para no saturar Mega ni el bot.
const MEGA_MAX_CONNECTIONS   = Math.min(Math.max(Number(process.env.MEGA_MAX_CONNECTIONS) || 16, 4), 32)
const MEGA_CHUNK_SIZE        = 1024 * 1024 // máximo documentado por megajs: 1 MB
const MF_HILOS               = 8   // hilos para descarga por rangos en MediaFire
const MF_MIN_SIZE_PARALELO   = 5 * 1024 * 1024 // no vale la pena paralelizar archivos < 5MB

const TIO_SERVIDORES = ['mega', 'voe', 'yourupload']
const LAT_SERVIDORES = ['mediafire', 'mega', 'voe', 'cloud', 'savefiles', 'hexload', 'dsvplay', 'byse']

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

// ─── Estado global ────────────────────────────────────────────────────────────

global.tioActiveChats  = global.tioActiveChats  || new Map()
global.tioEpisodeQueue = global.tioEpisodeQueue || []
global.tioQueueRunning = global.tioQueueRunning || false
global.tioConn         = global.tioConn         || null
global.tioQueuedIds    = global.tioQueuedIds    || new Set()
global.tioCheckingChats = global.tioCheckingChats || new Set()

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return value && typeof value === 'object' ? value : fallback
  } catch (err) {
    if (fs.existsSync(file)) console.error(`[tioanime-notify] No se pudo leer ${file}: ${err.message}`)
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
    console.error(`[tioanime-notify] No se pudo guardar ${file}: ${err.message}`)
  }
}

function loadSeen()   { return loadJson(SEEN_FILE) }
function saveSeen(d)  { saveJsonAtomic(SEEN_FILE, d) }
function loadState()  { return loadJson(STATE_FILE) }
function saveState(d) { saveJsonAtomic(STATE_FILE, d) }

function absoluteUrl(value, base) {
  try { return new URL(value, base).href } catch (_) { return '' }
}

function detectarServidor(url, label = '') {
  const u = `${url} ${label}`.toLowerCase()
  if (u.includes('mega.nz') || u.includes('mega.co.nz') || u.includes(' mega')) return 'mega'
  if (u.includes('mediafire')) return 'mediafire'
  if (u.includes('voe')) return 'voe'
  if (u.includes('yourupload')) return 'yourupload'
  if (u.includes('savefiles')) return 'savefiles'
  if (u.includes('hexload')) return 'hexload'
  if (u.includes('dsvplay')) return 'dsvplay'
  if (u.includes('byse')) return 'byse'
  if (u.includes('cloud')) return 'cloud'
  return ''
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n)  { return String(n).padStart(2, '0') }
function safeFile(s) { return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
function getSeasonNumber(...values) {
  const text = values.filter(Boolean).join(' ')
  const match = text.match(/(?:temporada|season)\s*[-_: ]?\s*(\d+)|\bT(\d+)\b/i)
  const season = Number(match?.[1] || match?.[2] || 1)
  return season > 1 ? season : 1
}
function cleanTitle(titulo) {
  return titulo
    .replace(/\s*(?:temporada|season)\s*[-_: ]?\s*\d+/ig, '')
    .replace(/\s*\bT\d+\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function buildFileName(titulo, epNum, fuente = 'tioanime', idioma = 'latino', slug = '') {
  const season = getSeasonNumber(titulo, slug)
  const seasonLabel = season > 1 ? `T${season} ` : ''
  const title = cleanTitle(titulo)
  const details = fuente === 'latanime'
    ? `Español ${idioma === 'castellano' ? 'Castellano 🇪🇸' : 'Latino 🇲🇽'} (1080p)`
    : 'Sub Español (720p)'
  return `${zeroPad(epNum)} ${seasonLabel}${safeFile(title)} ${details} [[𝗖𝗜𝗗]].mp4`
}

function fmtBytes(b) {
  if (!b || b <= 0) return '0 KB'
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576)    return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1024).toFixed(2) + ' KB'
}



// ─── Scraping ─────────────────────────────────────────────────────────────────

async function fetchLatestEpisodes() {
  const { data } = await axios.get(TIOANIME_URL, { headers: HEADERS, timeout: 15000 })
  const $    = cheerio.load(data)
  const lista = []

  $('ul.episodes-list li, .episodes-list li, article.episode, .episode-item, .anime-item, [class*="episode"], [class*="item"]').each((_, el) => {
    const $el   = $(el)
    const aTag  = $el.find('a').first()
    const href  = aTag.attr('href') || ''
    if (!href) return

    const m = href.match(/\/ver\/(.+?)[-_](\d+)\/?$/)
    if (!m) return

    const slug   = m[1]
    const epNum  = parseInt(m[2])
    const titulo = ($el.find('h3, h2, .title, .anime-title, p').first().text() || aTag.attr('title') || slug.replace(/-/g, ' ')).trim()
    const imgEl  = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || ''
    const imgUrl = !imgSrc ? '' : imgSrc.startsWith('//') ? 'https:' + imgSrc : absoluteUrl(imgSrc, TIOANIME_URL)
    const epUrl  = absoluteUrl(href, TIOANIME_URL)
    const normSlug = slug.replace(/-(?:sub|hd|fhd|1080p|720p|480p)$/i, '').toLowerCase()
    const id       = `${normSlug}-${epNum}`

    if (!lista.find(e => e.id === id)) lista.push({ id, slug: normSlug, titulo, epNum, epUrl, imgUrl })
  })

  if (lista.length === 0) {
    $('a[href*="/ver/"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m    = href.match(/\/ver\/(.+?)[-_](\d+)\/?$/)
      if (!m) return
      const slug   = m[1]
      const epNum  = parseInt(m[2])
      const titulo = ($(el).attr('title') || $(el).text() || slug.replace(/-/g, ' ')).trim()
      const epUrl  = absoluteUrl(href, TIOANIME_URL)
      const normSlug = slug.replace(/-(?:sub|hd|fhd|1080p|720p|480p)$/i, '').toLowerCase()
      const id       = `${normSlug}-${epNum}`
      if (!lista.find(e => e.id === id)) lista.push({ id, slug: normSlug, titulo, epNum, epUrl, imgUrl: '' })
    })
  }

  console.log(`[tioanime-notify] ${lista.length} episodios en portada`)
  return lista
}

async function scrapeServidores(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: TIOANIME_URL }, timeout: 15000 })
  const $    = cheerio.load(data)
  const srvs = []
  const slugMatch = epUrl.match(/\/ver\/(.+)$/)
  const epSlug    = slugMatch?.[1]?.replace(/\/$/, '') || ''

  if (epSlug) {
    try {
      const apiUrl = `${TIOANIME_URL}/api/download?episode=${epSlug}`
      const apiRes = await axios.get(apiUrl, {
        headers: { ...HEADERS, Referer: epUrl, 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 12000,
      })
      const descargas = Array.isArray(apiRes.data) ? apiRes.data : (apiRes.data?.downloads || apiRes.data?.data || [])
      for (const d of descargas) {
        const url    = d.url || d.link || d.href || ''
        const nombre = (d.server || d.name || d.label || '').toLowerCase()
        if (!url.startsWith('http') || srvs.find(s => s.url === url)) continue
        const sinSoporte = url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')
        if (sinSoporte) continue
        const servidor = detectarServidor(url, nombre)
        if (!servidor || !TIO_SERVIDORES.includes(servidor)) continue
        srvs.push({ nombre: servidor, url, directo: servidor === 'mega' })
      }
    } catch (err) {}
  }

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    if (!href.startsWith('http')) return
    const servidor    = detectarServidor(href, $(el).text())
    const esTio       = TIO_SERVIDORES.includes(servidor)
    const sinSoporte  = href.includes('hqq.tv') || href.includes('netu.tv')
    if (sinSoporte || !esTio) return
    if (!srvs.find(s => s.url === href)) {
      const label = $(el).text().trim().toLowerCase()
      srvs.push({ nombre: servidor || label || 'descarga', url: href, directo: servidor === 'mega' })
    }
  })

  $('script').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('var videos')) return
    const match = code.match(/var\s+videos\s*=\s*(\[\s*\[[\s\S]*?\]\s*\])\s*[;,]?/)
    if (match) {
      try {
        for (const item of JSON.parse(match[1])) {
          if (!Array.isArray(item) || !item[1]?.startsWith('http')) continue
          const url    = item[1]
          const nombre = String(item[0]).toLowerCase()
          if (srvs.find(s => s.url === url)) continue
          const servidor = detectarServidor(url, nombre)
          const sinSoporte  = url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')
          if (sinSoporte || !TIO_SERVIDORES.includes(servidor)) continue
          srvs.push({ nombre: servidor, url, directo: servidor === 'mega' })
        }
      } catch (_) {}
    }
    const mArr = code.match(/var\s+videos\s*=\s*(\[[\s\S]*?\]);/)
    if (mArr && !srvs.find(s => !s.directo)) {
      try {
        for (const item of JSON.parse(mArr[1])) {
          const url = item?.url || item?.file || item?.code || ''
          const nom = (item?.title || item?.label || item?.server || '').toLowerCase()
          if (!url.startsWith('http') || srvs.find(s => s.url === url)) continue
          const servidor   = detectarServidor(url, nom)
          const sinSoporte = url.includes('hqq.tv') || url.includes('netu.tv')
          if (sinSoporte || !TIO_SERVIDORES.includes(servidor)) continue
          srvs.push({ nombre: servidor, url, directo: servidor === 'mega' })
        }
      } catch (_) {}
    }
  })

  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, directo: false })
    })
  }
  return srvs
}

async function fetchLatestEpisodesLatAnime() {
  const { data } = await axios.get(LATANIME_URL, { headers: HEADERS, timeout: 15000 })
  const $    = cheerio.load(data)
  const lista = []

  $('a[href*="/ver/"]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const m     = href.match(/\/ver\/(.+?)[-_](\d+)(?:-[a-z]+)?(?:\/|$)/)
    if (!m) return
    const slug   = m[1]
    const epNum  = parseInt(m[2])
    const tAttr  = ($(el).attr('title') || '').trim()
    const tFind  = $(el).find('h3, h2, p, span, [class*="title"], [class*="name"]').first().text().trim()
    const tSlug  = slug.replace(/-episodio$/i, '').replace(/-/g, ' ').trim()
    const titulo = tAttr || tFind || tSlug
    const imgEl  = $(el).find('img').first()
    const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy') || imgEl.attr('data-original') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    const imgUrl = (!imgSrc || imgSrc.startsWith('data:')) ? '' : imgSrc.startsWith('//') ? 'https:' + imgSrc : absoluteUrl(imgSrc, LATANIME_URL)
    const epUrl  = absoluteUrl(href, LATANIME_URL)
    const normSlugLat = slug.replace(/-episodio$/i, '').replace(/-(?:castellano|latino|espanol|español|esp|sub|dub|hd)$/i, '').replace(/-episodio$/i, '').toLowerCase()
    const id     = `lat-${normSlugLat}-${epNum}`
    const idioma = href.toLowerCase().includes('castellano') ? 'castellano' : 'latino'
    if (!lista.find(e => e.id === id)) lista.push({ id, slug, titulo, epNum, epUrl, imgUrl, fuente: 'latanime', idioma })
  })
  return lista
}

async function scrapeServidoresLatAnime(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: LATANIME_URL }, timeout: 15000 })
  const $    = cheerio.load(data)
  const srvs = []

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http')) return

    const servidor = detectarServidor(href, label)
    const esLat = LAT_SERVIDORES.includes(servidor)
    const esRedirector = !href.includes('latanime.org') && !href.includes('javascript') && !href.includes('#') && href.length > 20 && !href.match(/\.(jpg|png|gif|css|js)$/)

    if (srvs.find(s => s.url === href)) return
    if (esLat) srvs.push({ nombre: servidor, url: href, directo: servidor === 'mega' || servidor === 'mediafire' })
    else if (esRedirector) srvs.push({ nombre: label || 'redir', url: href, directo: false, esRedirector: true })
  })

  const redirs = srvs.filter(s => s.esRedirector)
  for (const r of redirs) {
    try {
      const res = await axios.get(r.url, { headers: { 'User-Agent': UA, 'Referer': LATANIME_URL }, maxRedirects: 5, timeout: 10000, validateStatus: () => true })
      const body     = typeof res.data === 'string' ? res.data : ''
      const finalUrl = res.request?.res?.responseUrl || ''
      const dominios = ['mega.nz','mediafire.com','voe.sx','yourupload.com','savefiles','hexload','dsvplay','byse']
      let urlReal = null
      for (const d of dominios) {
        const match = body.match(new RegExp(`https?://[^"'\\s]*${d.replace('.','\\.')}[^"'\\s]*`))
        if (match) { urlReal = match[0]; break }
      }
      if (!urlReal && finalUrl && dominios.some(d => finalUrl.includes(d))) urlReal = finalUrl
      if (urlReal) {
        const idx = srvs.findIndex(s => s.url === r.url)
        if (idx !== -1) {
          srvs[idx].url      = urlReal
          srvs[idx].nombre   = detectarServidor(urlReal) || detectarServNombre(urlReal)
          srvs[idx].directo  = ['mega', 'mediafire'].includes(srvs[idx].nombre)
          delete srvs[idx].esRedirector
        }
      } else {
        const idx = srvs.findIndex(s => s.url === r.url)
        if (idx !== -1) srvs.splice(idx, 1)
      }
    } catch (_) {
      const idx = srvs.findIndex(s => s.url === r.url)
      if (idx !== -1) srvs.splice(idx, 1)
    }
  }

  $('[data-src], [data-player], [data-url], iframe[src]').each((_, el) => {
    const raw = $(el).attr('data-src') || $(el).attr('data-player') || $(el).attr('data-url') || $(el).attr('src') || ''
    let embedUrl = raw
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8')
      if (decoded.startsWith('http')) embedUrl = decoded
    } catch (_) {}
    const servidor = detectarServidor(embedUrl)
    if (embedUrl.startsWith('http') && servidor && LAT_SERVIDORES.includes(servidor) && !srvs.find(s => s.url === embedUrl)) {
      srvs.push({ nombre: servidor, url: embedUrl, directo: servidor === 'mega' || servidor === 'mediafire' })
    }
  })
  return srvs
}

function detectarServNombre(url) {
  return detectarServidor(url) || 'embed'
}

// ─── Descarga ─────────────────────────────────────────────────────────────────

const PREFS_TIO = ['mega', 'voe', 'yourupload']
const PREFS_LAT = ['mediafire', 'mega', 'voe', 'cloud', 'savefiles', 'hexload', 'dsvplay', 'byse']

function ordenarServidores(srvs, fuente = 'tioanime') {
  const preferencias = fuente === 'latanime' ? PREFS_LAT : PREFS_TIO
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
        console.log(`[tioanime-notify] ⚠️ Mega falló; reintentando (${intento}/${maxIntentos}): ${err.message}`)
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
      console.log(`[tioanime-notify] ⚡ MediaFire descargado en ${partes.length} hilos paralelos`)
      return destPath
    } catch (err) {
      process.stdout.write('\n')
      for (const p of partes) { try { fs.unlinkSync(p.path) } catch (_) {} }
      console.log(`[tioanime-notify] ⚠️ Descarga paralela falló (${err.message}), reintentando en modo simple...`)
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
  const destPath = path.join(outputDir, fileName)
  const res = await axios.get(directUrl, {
    responseType: 'stream',
    headers: { ...HEADERS, Referer: serverUrl },
    httpsAgent,
    timeout: DL_TIMEOUT,
    maxRedirects: 8,
    validateStatus: status => status >= 200 && status < 400,
  })
  const contentType = String(res.headers['content-type'] || '').toLowerCase()
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new Error(`${servidor}: el enlace no devolvió un vídeo`)
  }
  await pipeline(res.data, fs.createWriteStream(destPath))
  const size = fs.statSync(destPath).size
  if (!size) {
    try { fs.rmSync(destPath, { force: true }) } catch (_) {}
    throw new Error(`${servidor}: archivo vacío`)
  }
  return destPath
}

async function extraerUrlServidor(serverUrl, servidor, patrones) {
  const page = await axios.get(serverUrl, {
    headers: { ...HEADERS, Referer: servidor === 'voe' ? 'https://voe.sx/' : serverUrl },
    timeout: 15000,
    maxRedirects: 8,
    responseType: 'text',
  })
  const html = String(page.data || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  for (const patron of patrones) {
    const match = html.match(patron)
    if (match?.[1]?.startsWith('http')) return match[1].replace(/&amp;/g, '&')
  }
  throw new Error(`${servidor}: no se encontró un enlace MP4 directo`)
}

async function descargarYourUpload(serverUrl, outputDir, fileName) {
  const directUrl = await extraerUrlServidor(serverUrl, 'yourupload', [
    /file["']?\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
    /sources?\s*:\s*\[\s*\{[^}]*src\s*:\s*["'](https?:\/\/[^"']+)["']/i,
    /video\[[^\]]+\]\s*=\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
    /(https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?)/i,
  ])
  return descargarUrlServidor(directUrl, serverUrl, outputDir, fileName, 'YourUpload')
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
      headers: { ...HEADERS, Referer: servidor === 'voe' ? 'https://voe.sx/' : serverUrl },
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
  const { titulo, epNum, epUrl, imgUrl, slug = '', fuente = 'tioanime', idioma = 'latino' } = ep
  const fileName = buildFileName(titulo, epNum, fuente, idioma, slug)
  
  // [CORRECCIÓN 2] Usar carpeta local segura para descargar y evitar ENOSPC
  const localTmp = path.join(process.cwd(), 'temp_videos')
  if (!fs.existsSync(localTmp)) fs.mkdirSync(localTmp, { recursive: true })
  
  const tmpDir = path.join(localTmp, `tio_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const bandera  = fuente === 'latanime' ? (idioma === 'castellano' ? '🇪🇸' : '🇲🇽') : '🇯🇵'
  const etiqueta = fuente === 'latanime' ? `LatAnime ${bandera}` : 'TioAnime 🇯🇵'

  try {
    const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
    const caption = `*✨Nuevo Episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> ${bandera} ${titulo}\n> 🆕 Capítulo: *${epNum}*\n> 🕐 Publicado: *${ahora}*\n> 🌐 Ver online: ${epUrl}\n> 📡 Fuente: *${etiqueta}*\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`

    if (imgUrl) {
      try {
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: HEADERS, timeout: 10000 })
        await conn.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption })
      } catch (_) { await conn.sendMessage(chatId, { text: caption }) }
    } else {
      await conn.sendMessage(chatId, { text: caption })
    }

    console.log(`[tioanime-notify] 🔎 Buscando servidores para "${titulo}" ep ${epNum}...`)
    const srvs = fuente === 'latanime' ? await scrapeServidoresLatAnime(epUrl) : await scrapeServidores(epUrl)
    if (!srvs.length) throw new Error('No se encontraron servidores')

    await new Promise(r => setTimeout(r, 15_000))
    const orden = ordenarServidores(srvs, fuente).slice(0, fuente === 'latanime' ? 10 : 3)
    let videoPath = null

    for (const srv of orden) {
      const nombreServidor = (srv.nombre || 'servidor').toUpperCase()
      try {
        if (srv.nombre === 'mega' || srv.nombre === 'mediafire' || (fuente === 'tioanime' && srv.nombre === 'yourupload') || (fuente === 'latanime' && LAT_SERVIDORES.includes(srv.nombre))) {
          console.log(`[tioanime-notify] 🔄 Conectando con [ ${nombreServidor} ]...`)
        } else {
          continue
        }

        if (srv.nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'yourupload') videoPath = await descargarYourUpload(srv.url, tmpDir, fileName)
        else videoPath = await descargarServidorVideo(srv.url, tmpDir, fileName, srv.nombre)

        if (videoPath) break // solo cortar tras una descarga exitosa
      } catch (err) {
        console.log(`[tioanime-notify] ⚠️ [ ${nombreServidor} ] falló: ${err.message}`)
        fs.readdirSync(tmpDir).forEach(f => {
          try { if (f !== 'cover.jpg') fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {}
        })
      }
    }

    if (!videoPath) throw new Error('Todos los servidores fallaron')

    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
    console.log(`[tioanime-notify] ✅ Descarga completa: ${fileName} (${sizeMB} MB) — subiendo a WhatsApp...`)
    const jpegThumbnail = await animeV1Downloader.createJpegThumbnail(videoPath)

    // [CORRECCIÓN 3] Usar { url: videoPath } para usar streaming real y no congelar el bot ni la memoria RAM
    await conn.sendMessage(chatId, {
      document : { url: videoPath },
      fileName,
      mimetype : 'video/mp4',
      caption  : `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${etiqueta}`,
      jpegThumbnail,
    })

    console.log(`[tioanime-notify] 🚀 Enviado: ${fileName}`)

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

async function procesarCola() {
  if (global.tioQueueRunning) return
  if (!global.tioEpisodeQueue.length) return
  global.tioQueueRunning = true

  const MAX_REINTENTOS   = 3
  const ESPERA_REINTENTO = 3 * 60_000
  const ESPERA_REQUEUEUE = 5 * 60_000

  try {
    while (global.tioEpisodeQueue.length > 0) {
      const item = global.tioEpisodeQueue[0]
      if (!item) { global.tioEpisodeQueue.shift(); continue }
      const { chatId, ep } = item
      const quitarItemActual = () => {
        const index = global.tioEpisodeQueue.indexOf(item)
        if (index !== -1) global.tioEpisodeQueue.splice(index, 1)
      }
      let intentos = 0
      let exito    = false

      while (intentos < MAX_REINTENTOS && !exito) {
        intentos++
        const connActivo = global.tioConn
        if (!connActivo) {
          await new Promise(r => setTimeout(r, ESPERA_REINTENTO))
          continue
        }
        try {
          await enviarEpisodio(chatId, ep, connActivo)
          exito = true
          const seen = loadSeen()
          if (!seen[chatId]) seen[chatId] = []
          if (!seen[chatId].includes(ep.id)) seen[chatId].push(ep.id)
          if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
          saveSeen(seen)
          quitarItemActual()
          global.tioQueuedIds.delete(`${chatId}:${ep.id}`)
        } catch (err) {
          const esConexion = /connection closed|stream errored|timed out|econnreset|econnrefused|socket hang up|precondition required/i.test(err.message)
          if (esConexion && intentos < MAX_REINTENTOS) {
            await new Promise(r => setTimeout(r, ESPERA_REINTENTO * intentos))
          } else if (esConexion) {
            quitarItemActual()
            global.tioEpisodeQueue.push({ chatId, ep })
            await new Promise(r => setTimeout(r, ESPERA_REQUEUEUE))
            break
          } else {
            quitarItemActual()
            global.tioQueuedIds.delete(`${chatId}:${ep.id}`)
            try {
              const connErr = global.tioConn
              if (connErr) await connErr.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}` })
            } catch (_) {}
          }
        }
      }
      if (global.tioEpisodeQueue.length > 0) await new Promise(r => setTimeout(r, QUEUE_DELAY))
    }
  } catch (fatalErr) {
    console.error(`[tioanime-notify] Error fatal en la cola: ${fatalErr.message}`)
  } finally {
    global.tioQueueRunning = false
  }
}

async function checkNuevosEpisodios(chatId, conn) {
  if (global.tioCheckingChats.has(chatId)) return
  global.tioCheckingChats.add(chatId)
  let lista = []
  try {
    try { lista = lista.concat(await fetchLatestEpisodes()) } catch (err) { console.error(`[tioanime-notify] TioAnime: ${err.message}`) }
    try { lista = lista.concat(await fetchLatestEpisodesLatAnime()) } catch (err) { console.error(`[tioanime-notify] LatAnime: ${err.message}`) }
    if (!lista.length) return

    const seen = loadSeen()
    if (!seen[chatId]) seen[chatId] = []
    const nuevos = lista.filter(e => !seen[chatId].includes(e.id) && !global.tioQueuedIds.has(`${chatId}:${e.id}`))
    if (!nuevos.length) return

    if (nuevos.length > 1) {
      try {
        await conn.sendMessage(chatId, { text: `📋 *${nuevos.length} episodios nuevos detectados*\n\n` + nuevos.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + `\n\n⏳ _Se enviarán de uno en uno..._` })
      } catch (err) { console.error(`[tioanime-notify] No se pudo enviar el resumen: ${err.message}`) }
    }

    for (const ep of nuevos) {
      global.tioEpisodeQueue.push({ chatId, ep })
      global.tioQueuedIds.add(`${chatId}:${ep.id}`)
    }
    procesarCola().catch(err => console.error(`[tioanime-notify] Error procesando cola: ${err.message}`))
  } finally {
    global.tioCheckingChats.delete(chatId)
  }
}

function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.tioConn = conn
  if (global.tioActiveChats.has(chatId)) clearInterval(global.tioActiveChats.get(chatId).timer)
  const timer = setInterval(() => {
    const c = global.tioConn
    if (!c) return
    checkNuevosEpisodios(chatId, c).catch(e => {})
  }, intervalMin * 60 * 1000)
  global.tioActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState()
  state[chatId] = { intervalMin, startedAt: Date.now() }
  saveState(state)
}

function detenerNotificador(chatId) {
  const entry = global.tioActiveChats.get(chatId)
  if (entry) { clearInterval(entry.timer); global.tioActiveChats.delete(chatId) }
  const state = loadState()
  delete state[chatId]
  saveState(state)
}

function restaurarNotificadores(conn) {
  const state = loadState()
  for (const [chatId, cfg] of Object.entries(state)) {
    if (!global.tioActiveChats.has(chatId)) iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT)
  }
}

if (!global.tioWatchdog) {
  global.tioWatchdog = setInterval(() => {
    const conn = global.tioConn
    if (!conn) return
    const state = loadState()
    for (const [chatId, cfg] of Object.entries(state)) {
      if (!global.tioActiveChats.has(chatId)) iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT)
    }
  }, 2 * 60 * 1000)
}

let handler = async (m, { conn, text, usedPrefix, command, isOwner }) => {
  if (conn) global.tioConn = conn
  restaurarNotificadores(conn)

  const COMANDOS_OWNER = ['tiostart', 'tiostop', 'tiointerval', 'tioflush', 'tiounblock', 'tioexample', 'latexample']
  if (COMANDOS_OWNER.includes(command) && !isOwner) {
    return conn.sendMessage(m.chat, { text: '⛔ Solo el *owner* puede usar este comando.' }, { quoted: m })
  }

  if (command === 'tiostart') {
    const min = parseInt(text?.trim())
    const intervalMin = (!isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, {
      text: `✅ *Notificador TioAnime + LatAnime activado*\n\n╭━━━━━━〔 📡 〕━━━━━━\n┃ ⏱️ Intervalo: *${intervalMin} min*\n┃ 🇯🇵 TioAnime — Sub japonés\n┃ 🇲🇽🇪🇸 LatAnime — Latino / Castellano\n┃ 💬 Chat registrado\n╰━━━━━━━━━━━━━━━━━━\n\n_Usa ${usedPrefix}tiostop para detener._`
    }, { quoted: m })
    try {
      const tio  = await fetchLatestEpisodes()
      const lat  = await fetchLatestEpisodesLatAnime()
      const lista = [...tio, ...lat]
      const seen  = loadSeen()
      if (!seen[m.chat]) seen[m.chat] = []
      for (const ep of lista) { if (!seen[m.chat].includes(ep.id)) seen[m.chat].push(ep.id) }
      if (seen[m.chat].length > 500) seen[m.chat] = seen[m.chat].slice(-500)
      saveSeen(seen)
      await conn.sendMessage(m.chat, { text: `📋 *${tio.length}* ep TioAnime + *${lat.length}* ep LatAnime registrados como base.\n_Solo los nuevos se enviarán._` }, { quoted: m })
    } catch (err) {}
    return
  }

  if (command === 'tiostop') {
    if (!global.tioActiveChats.has(m.chat)) return m.reply(`ℹ️ El notificador no estaba activo.`)
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}tiostart para reactivar._`)
  }

  if (command === 'tiostatus') {
    const activo = global.tioActiveChats.has(m.chat)
    const entry  = global.tioActiveChats.get(m.chat)
    const cola   = global.tioEpisodeQueue.filter(i => i.chatId === m.chat)
    const vistos = (loadSeen()[m.chat] || []).length
    let txt = `📡 *Estado TioAnime*\n\n`
    txt += activo ? `✅ *Activo* — cada ${entry.intervalMin} min\n` : `🔴 *Inactivo*\n`
    txt += `📋 Cola: *${cola.length}* pendiente(s)\n`
    txt += `🔵 Procesando: *${global.tioQueueRunning ? 'Sí' : 'No'}*\n`
    txt += `👁️ Vistos: *${vistos}*`
    if (cola.length > 0) txt += `\n\n*En cola:*\n` + cola.slice(0, 5).map((i, n) => `  ${n + 1}. ${i.ep.titulo} ep ${zeroPad(i.ep.epNum)}`).join('\n')
    return m.reply(txt)
  }

  if (command === 'tioqueue') {
    if (!global.tioEpisodeQueue.length) return m.reply(`✅ Cola vacía.`)
    return m.reply(`📋 *Cola (${global.tioEpisodeQueue.length}):*\n\n` + global.tioEpisodeQueue.map((i, n) => `${n + 1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} [${i.chatId === m.chat ? 'este chat' : 'otro chat'}]`).join('\n'))
  }

  if (command === 'tioflush') {
    const antes = global.tioEpisodeQueue.length
    const eliminados = global.tioEpisodeQueue.filter(i => i.chatId === m.chat)
    global.tioEpisodeQueue = global.tioEpisodeQueue.filter(i => i.chatId !== m.chat)
    for (const item of eliminados) global.tioQueuedIds.delete(`${item.chatId}:${item.ep.id}`)
    return m.reply(`🗑️ *${antes - global.tioEpisodeQueue.length}* episodio(s) eliminado(s).`)
  }

  if (command === 'tiounblock') {
    const estaba = global.tioQueueRunning
    if (global.tioEpisodeQueue.length > 0) {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.tioEpisodeQueue.length} episodio(s)...`)
      if (!estaba) procesarCola().catch(e => console.error(`[tioanime-notify] Error reanudando cola: ${e.message}`))
    } else {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\nℹ️ No hay episodios pendientes.`)
    }
    return
  }

  if (command === 'tiocheck') {
    await m.reply(`🔍 Chequeando TioAnime...`)
    try {
      await checkNuevosEpisodios(m.chat, conn)
      if (!global.tioEpisodeQueue.some(i => i.chatId === m.chat)) await m.reply(`✅ Sin episodios nuevos.`)
    } catch (err) { await m.reply(`❌ Error: ${err.message}`) }
    return
  }

  if (command === 'tiointerval') {
    const min = parseInt(text?.trim())
    if (isNaN(min) || min < 5 || min > 60) return m.reply(`❌ Número entre *5* y *60*.\nEj: *${usedPrefix}tiointerval 15*`)
    if (!global.tioActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}tiostart* primero.`)
    iniciarNotificador(m.chat, conn, min)
    return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`)
  }

  if (command === 'tioexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *TioAnime*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodes()
      if (!lista.length) return m.reply(`❌ Sin episodios de TioAnime disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(`📋 *${seleccion.length} episodios seleccionados (TioAnime):*\n\n` + seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + `\n\n⏳ _Se enviarán de uno en uno..._`)
    }

    for (const ep of seleccion) {
      const queueId = `${m.chat}:${ep.id}`
      if (global.tioQueuedIds.has(queueId)) continue
      global.tioEpisodeQueue.push({ chatId: m.chat, ep })
      global.tioQueuedIds.add(queueId)
    }
    procesarCola().catch(e => console.error(`[tioanime-notify] Error en tioexample: ${e.message}`))
    return
  }

  if (command === 'latexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *LatAnime*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodesLatAnime()
      if (!lista.length) return m.reply(`❌ Sin episodios de LatAnime disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(`📋 *${seleccion.length} episodios seleccionados (LatAnime):*\n\n` + seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + `\n\n⏳ _Se enviarán de uno en uno..._`)
    }

    for (const ep of seleccion) {
      const queueId = `${m.chat}:${ep.id}`
      if (global.tioQueuedIds.has(queueId)) continue
      global.tioEpisodeQueue.push({ chatId: m.chat, ep })
      global.tioQueuedIds.add(queueId)
    }
    procesarCola().catch(e => console.error(`[tioanime-notify] Error en latexample: ${e.message}`))
    return
  }
}

handler.command = /^(tiostart|tiostop|tiostatus|tiocheck|tioqueue|tioflush|tiounblock|tiointerval|tioexample|latexample)$/i
handler.tags    = ['anime', 'notificaciones']
handler.help    = ['tiostart', 'tiostop', 'tiostatus', 'tiocheck', 'tioqueue', 'tioflush', 'tiounblock', 'tiointerval <min>', 'tioexample [N]', 'latexample [N]']
handler.exp     = 0
handler.level   = 0
handler.limit   = false

handler.before = async (m, { conn }) => {
  if (conn) global.tioConn = conn
  restaurarNotificadores(conn)
}

export default handler
