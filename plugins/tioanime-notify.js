// plugins/tioanime-notify.js — v3.2
//
// Notificador automático de nuevos episodios — TioAnime (SUB) + LatAnime (LAT/ESP)
//
// Comandos:
//   .tiostart               → inicia el notificador (TioAnime SUB + LatAnime LAT)
//   .tiostop                → detiene el notificador en el chat actual
//   .tiostatus              → muestra estado y cola
//   .tioqueue               → ver episodios en cola
//   .tioflush               → vaciar la cola de este chat
//   .tiocheck               → forzar chequeo ahora
//   .tiointerval <minutos>  → cambiar intervalo (mín 5, máx 60)
//   .tioexample [N]         → prueba con los N episodios más recientes de TioAnime (por defecto 1)
//   .latexample [N]         → prueba con los N episodios más recientes de LatAnime  (por defecto 1)

import axios        from 'axios'
import * as cheerio from 'cheerio'
import fs           from 'fs'
import path         from 'path'
import { spawn }    from 'child_process'
import { pipeline } from 'stream/promises'
import { File as MegaFile } from 'megajs'

// ─── Constantes ───────────────────────────────────────────────────────────────

const TIOANIME_URL           = 'https://tioanime.com'
const LATANIME_URL           = 'https://latanime.org'
const SEEN_FILE              = path.join(process.env.TMPDIR || '/tmp', 'tioanime_seen.json')
const STATE_FILE             = path.join(process.env.TMPDIR || '/tmp', 'tioanime_state.json')
const CHECK_INTERVAL_DEFAULT = 10        // minutos
const QUEUE_DELAY            = 90_000    // ms entre ítems de cola (90 seg)
const DL_TIMEOUT             = 3 * 60 * 60 * 1000

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
global.tioConn         = global.tioConn         || null   // conn más reciente para el watchdog

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadSeen()   { try { return JSON.parse(fs.readFileSync(SEEN_FILE,  'utf-8')) } catch (_) { return {} } }
function saveSeen(d)  { try { fs.writeFileSync(SEEN_FILE,  JSON.stringify(d, null, 2)) } catch (_) {} }
function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch (_) { return {} } }
function saveState(d) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n)  { return String(n).padStart(2, '0') }
function safeFile(s) { return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
function buildFileName(titulo, epNum) { return `${zeroPad(epNum)} ${safeFile(titulo)}.mp4` }

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
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc.startsWith('//') ? 'https:' + imgSrc : imgSrc ? TIOANIME_URL + imgSrc : ''
    const epUrl  = href.startsWith('http') ? href : TIOANIME_URL + href
    // Normalizar slug para ID estable (sin sufijos como -sub, -hd, etc.)
    const normSlug = slug.replace(/-(?:sub|hd|fhd|1080p|720p|480p)$/i, '').toLowerCase()
    const id       = `${normSlug}-${epNum}`

    if (!lista.find(e => e.id === id)) lista.push({ id, slug: normSlug, titulo, epNum, epUrl, imgUrl })
  })

  // Fallback: cualquier link /ver/
  if (lista.length === 0) {
    $('a[href*="/ver/"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m    = href.match(/\/ver\/(.+?)[-_](\d+)\/?$/)
      if (!m) return
      const slug   = m[1]
      const epNum  = parseInt(m[2])
      const titulo = ($(el).attr('title') || $(el).text() || slug.replace(/-/g, ' ')).trim()
      const epUrl  = href.startsWith('http') ? href : TIOANIME_URL + href
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

  // ── Extraer el slug del episodio desde la URL o el HTML ───────────────────
  // URL: https://tioanime.com/ver/slug-del-anime-ep
  const slugMatch = epUrl.match(/\/ver\/(.+)$/)
  const epSlug    = slugMatch?.[1]?.replace(/\/$/, '') || ''

  // ── 1. API oficial de descargas de TioAnime ───────────────────────────────
  // TioAnime expone: GET /api/download?episode={slug}
  // Responde JSON: [{ server: "Mega", idiom: "SUB", url: "https://mega.nz/..." }, ...]
  if (epSlug) {
    try {
      const apiUrl = `${TIOANIME_URL}/api/download?episode=${epSlug}`
      console.log(`[tioanime-notify] API descargas: ${apiUrl}`)
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
        const esMega      = url.includes('mega.nz') || url.includes('mega.co.nz')
        const esMediafire = url.includes('mediafire.com')
        srvs.push({ nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : nombre, url, directo: esMega || esMediafire })
      }
      console.log(`[tioanime-notify] API devolvió ${descargas.length} descarga(s)`)
    } catch (err) {
      console.log(`[tioanime-notify] API descargas falló: ${err.message}`)
    }
  }

  // ── 2. Links directos en el HTML (botones <a href="https://mega.nz/...">)  ─
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    if (!href.startsWith('http')) return
    const esMega      = href.includes('mega.nz') || href.includes('mega.co.nz')
    const esMediafire = href.includes('mediafire.com')
    const esOtro      = href.includes('gofile.io') || href.includes('1fichier') || href.includes('pixeldrain')
    const sinSoporte  = href.includes('hqq.tv') || href.includes('netu.tv')
    if (sinSoporte || (!esMega && !esMediafire && !esOtro)) return
    if (!srvs.find(s => s.url === href)) {
      const label = $(el).text().trim().toLowerCase()
      srvs.push({ nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : label || 'descarga', url: href, directo: true })
    }
  })

  // ── 3. var videos = [["servidor", "url"], ...] (reproductores embed) ──────
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
          const esMega      = url.includes('mega.nz') || url.includes('mega.co.nz')
          const esMediafire = url.includes('mediafire.com')
          const sinSoporte  = url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')
          if (sinSoporte) continue
          srvs.push({ nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : nombre, url, directo: esMega || esMediafire })
        }
      } catch (_) {}
    }

    // Fallback array de objetos
    const mArr = code.match(/var\s+videos\s*=\s*(\[[\s\S]*?\]);/)
    if (mArr && !srvs.find(s => !s.directo)) {
      try {
        for (const item of JSON.parse(mArr[1])) {
          const url = item?.url || item?.file || item?.code || ''
          const nom = (item?.title || item?.label || item?.server || '').toLowerCase()
          if (!url.startsWith('http') || srvs.find(s => s.url === url)) continue
          const esMega     = url.includes('mega.nz')
          const sinSoporte = url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')
          if (sinSoporte) continue
          srvs.push({ nombre: esMega ? 'mega' : nom || url, url, directo: esMega })
        }
      } catch (_) {}
    }
  })

  // ── 4. iframes como último recurso ────────────────────────────────────────
  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, directo: false })
    })
  }

  console.log(`[tioanime-notify] ${srvs.length} servidores — Mega: ${srvs.filter(s => s.nombre === 'mega').length}`)
  return srvs
}

// ─── LatAnime — scraping de nuevos episodios ──────────────────────────────────

async function fetchLatestEpisodesLatAnime() {
  const { data } = await axios.get(LATANIME_URL, { headers: HEADERS, timeout: 15000 })
  const $    = cheerio.load(data)
  const lista = []

  // LatAnime lista episodios recientes en la portada
  $('a[href*="/ver/"]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const m     = href.match(/\/ver\/(.+?)[-_](\d+)(?:-[a-z]+)?(?:\/|$)/)
    if (!m) return
    const slug   = m[1]
    const epNum  = parseInt(m[2])
    // Cada fuente se trimea por separado para evitar que un string " " truthy
    // bloquee el fallback; además limpiamos el slug de sufijos como -episodio
    const tAttr  = ($(el).attr('title') || '').trim()
    const tFind  = $(el).find('h3, h2, p, span, [class*="title"], [class*="name"]').first().text().trim()
    const tSlug  = slug.replace(/-episodio$/i, '').replace(/-/g, ' ').trim()
    const titulo = tAttr || tFind || tSlug
    const imgEl  = $(el).find('img').first()
    // LatAnime lazy-load: data-src tiene la imagen real; src suele ser un placeholder negro
    const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy') || imgEl.attr('data-original') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    // Descartar placeholders base64 o SVG vacíos
    const imgUrl = (!imgSrc || imgSrc.startsWith('data:'))
      ? ''
      : imgSrc.startsWith('http') ? imgSrc : LATANIME_URL + imgSrc
    const epUrl  = href.startsWith('http') ? href : LATANIME_URL + href
    // Normalizar slug: quitar -episodio, -castellano, -latino, -español y variantes
    // así el id es estable aunque la URL tenga sufijos variables
    const normSlugLat = slug
      .replace(/-episodio$/i, '')
      .replace(/-(?:castellano|latino|espanol|español|esp|sub|dub|hd)$/i, '')
      .replace(/-episodio$/i, '') // segunda pasada por si había ambos sufijos
      .toLowerCase()
    const id     = `lat-${normSlugLat}-${epNum}`
    const idioma = href.toLowerCase().includes('castellano') ? 'castellano' : 'latino'
    if (!lista.find(e => e.id === id)) lista.push({ id, slug, titulo, epNum, epUrl, imgUrl, fuente: 'latanime', idioma })
  })

  console.log(`[tioanime-notify] LatAnime: ${lista.length} episodios en portada`)
  return lista
}

async function scrapeServidoresLatAnime(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: LATANIME_URL }, timeout: 15000 })
  const $    = cheerio.load(data)
  const srvs = []

  // ── 1. Botones de descarga directa ──────────────────────────────────────────
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http')) return

    const esMega      = href.includes('mega.nz')
    const esMediafire = href.includes('mediafire.com')
    const esOtro =
      href.includes('voe.sx')     || href.includes('streamtape') ||
      href.includes('filemoon')   || href.includes('mp4upload')  ||
      href.includes('streamwish') || href.includes('dood')       ||
      href.includes('upstream')   || href.includes('ok.ru')      ||
      href.includes('vidhide')    || href.includes('mixdrop')    ||
      href.includes('savefiles')  || href.includes('gofile.io')  ||
      href.includes('byse')

    // También detectar redirectores de anuncio de LatAnime
    const esRedirector = !href.includes('latanime.org') && !href.includes('javascript') &&
      !href.includes('#') && href.length > 20 &&
      !href.match(/\.(jpg|png|gif|css|js)$/)

    if (srvs.find(s => s.url === href)) return

    if (esMega || esMediafire) {
      srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, directo: true })
    } else if (esOtro) {
      srvs.push({ nombre: label || detectarServNombre(href), url: href, directo: false })
    } else if (esRedirector) {
      // Puede ser un redirector de anuncio → intentar resolver
      srvs.push({ nombre: label || 'redir', url: href, directo: false, esRedirector: true })
    }
  })

  // ── 2. Resolver redirectores de anuncio para obtener la URL real ────────────
  const redirs = srvs.filter(s => s.esRedirector)
  for (const r of redirs) {
    try {
      const res = await axios.get(r.url, {
        headers: { 'User-Agent': UA, 'Referer': LATANIME_URL },
        maxRedirects: 5, timeout: 10000, validateStatus: () => true,
      })
      const body     = typeof res.data === 'string' ? res.data : ''
      const finalUrl = res.request?.res?.responseUrl || ''
      const dominios = ['mega.nz','mediafire.com','voe.sx','streamtape','filemoon','mp4upload','streamwish','dood','ok.ru']
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
          srvs[idx].nombre   = urlReal.includes('mediafire') ? 'mediafire' : urlReal.includes('mega.nz') ? 'mega' : detectarServNombre(urlReal)
          srvs[idx].directo  = urlReal.includes('mega.nz') || urlReal.includes('mediafire.com')
          delete srvs[idx].esRedirector
        }
      } else {
        // No se pudo resolver → eliminar de la lista
        const idx = srvs.findIndex(s => s.url === r.url)
        if (idx !== -1) srvs.splice(idx, 1)
      }
    } catch (_) {
      const idx = srvs.findIndex(s => s.url === r.url)
      if (idx !== -1) srvs.splice(idx, 1)
    }
  }

  // ── 3. data-src / data-player / iframes ─────────────────────────────────────
  $('[data-src], [data-player], [data-url], iframe[src]').each((_, el) => {
    const raw = $(el).attr('data-src') || $(el).attr('data-player') || $(el).attr('data-url') || $(el).attr('src') || ''
    let embedUrl = raw
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8')
      if (decoded.startsWith('http')) embedUrl = decoded
    } catch (_) {}
    if (embedUrl.startsWith('http') && !srvs.find(s => s.url === embedUrl))
      srvs.push({ nombre: detectarServNombre(embedUrl), url: embedUrl, directo: false })
  })

  console.log(`[tioanime-notify] LatAnime servidores: ${srvs.map(s => s.nombre).join(', ')}`)
  return srvs
}

function detectarServNombre(url) {
  const u = url.toLowerCase()
  if (u.includes('mediafire')) return 'mediafire'
  if (u.includes('mega.nz'))   return 'mega'
  if (u.includes('voe'))       return 'voe'
  if (u.includes('filemoon'))  return 'filemoon'
  if (u.includes('mp4upload')) return 'mp4upload'
  if (u.includes('streamwish'))return 'streamwish'
  if (u.includes('streamtape'))return 'streamtape'
  if (u.includes('dood'))      return 'doodstream'
  if (u.includes('ok.ru'))     return 'okru'
  return 'embed'
}

// ─── Descarga ─────────────────────────────────────────────────────────────────

// Mega siempre primero para TioAnime, MediaFire primero para LatAnime
const PREFS_EMBED = ['mp4upload', 'filemoon', 'streamwish', 'streamtape', 'doodstream', 'voe', 'vidhide', 'okru', 'mixdrop']

function ordenarServidores(srvs, fuente = 'tioanime') {
  const mega      = srvs.filter(s => s.nombre === 'mega')
  const mediafire = srvs.filter(s => s.nombre === 'mediafire')
  const otros     = srvs.filter(s => s.directo && s.nombre !== 'mega' && s.nombre !== 'mediafire')
  const embeds    = [...srvs.filter(s => !s.directo)].sort((a, b) => {
    const ia = PREFS_EMBED.findIndex(p => a.nombre.includes(p) || a.url.includes(p))
    const ib = PREFS_EMBED.findIndex(p => b.nombre.includes(p) || b.url.includes(p))
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  // LatAnime: MediaFire primero (pedido explícito)
  // TioAnime: Mega primero
  if (fuente === 'latanime') return [...mediafire, ...mega, ...otros, ...embeds]
  return [...mega, ...mediafire, ...otros, ...embeds]
}

// Descarga desde Mega con megajs
async function descargarMega(megaUrl, outputDir, fileName) {
  // Normalizar URL: /embed/!ID!KEY → /file/ID#KEY
  let url = megaUrl
  const m1 = megaUrl.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m1) url = `https://mega.nz/file/${m1[1]}#${m1[2]}`
  const m2 = megaUrl.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m2) url = `https://mega.nz/file/${m2[1]}#${m2[2]}`

  console.log(`[tioanime-notify] Mega → ${url.slice(0, 80)}`)

  const file = MegaFile.fromURL(url)
  await file.loadAttributes()

  const megaName = file.name || fileName
  const sizeMB   = (file.size / 1024 / 1024).toFixed(1)
  console.log(`[tioanime-notify] Mega: ${megaName} (${sizeMB} MB)`)

  const totalMB    = (file.size / 1024 / 1024).toFixed(1)
  const destPath   = path.join(outputDir, fileName)
  const fileStream = file.download()

  let downloaded = 0
  let lastTime   = Date.now()
  let lastBytes  = 0

  fileStream.on('data', chunk => {
    downloaded += chunk.length
    const now     = Date.now()
    const elapsed = (now - lastTime) / 1000
    if (elapsed >= 1) {
      const speed = ((downloaded - lastBytes) / elapsed / 1024 / 1024).toFixed(1)
      const dlMB  = (downloaded / 1024 / 1024).toFixed(1)
      const pct   = ((downloaded / file.size) * 100).toFixed(1)
      process.stdout.write(`\r[MEGA] ${pct}% | ${dlMB} MB / ${totalMB} MB | ${speed} MB/s   `)
      lastTime  = now
      lastBytes = downloaded
    }
  })

  fileStream.on('error', err => {
    console.error(`\n[tioanime-notify] Mega stream error: ${err.message}\n${err.stack}`)
  })

  try {
    await pipeline(fileStream, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`Mega: fallo durante la escritura — ${err.message}\n${err.stack}`)
  }

  const finalMB = (downloaded / 1024 / 1024).toFixed(1)
  console.log(`\n[tioanime-notify] Mega ✅ ${fileName} (${finalMB} MB)`)
  return destPath
}

// ─── Descarga desde MediaFire con barra de progreso ──────────────────────────

async function descargarMediaFire(mfUrl, outputDir, fileName) {
  console.log(`[tioanime-notify] MediaFire → obteniendo página: ${mfUrl}`)

  // 1. Obtener página de MediaFire para extraer el link directo
  let mfPage
  try {
    const res = await axios.get(mfUrl, { headers: HEADERS, timeout: 12000 })
    mfPage = res.data
  } catch (err) {
    throw new Error(`MediaFire: error al obtener página — ${err.message}\n${err.stack}`)
  }

  // 2. Extraer link de descarga directa
  const mfLink =
    mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
    mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1]   ||
    mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]

  if (!mfLink) {
    // Mostrar snippet de la página para diagnosticar el problema en terminal
    const snippet = typeof mfPage === 'string'
      ? mfPage.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 800)
      : String(mfPage).slice(0, 800)
    console.error(`[tioanime-notify] MediaFire: no encontré link de descarga directa.`)
    console.error(`[tioanime-notify] URL analizada: ${mfUrl}`)
    console.error(`[tioanime-notify] Snippet de la página (primeros 800 chars sin HTML):\n${snippet}`)
    throw new Error('MediaFire: no encontré link de descarga directa (ver terminal para diagnóstico)')
  }

  console.log(`[tioanime-notify] MediaFire link directo → ${mfLink.slice(0, 100)}`)

  // 3. Iniciar descarga en streaming
  let mfRes
  try {
    mfRes = await axios.get(mfLink, {
      responseType  : 'stream',
      headers       : { ...HEADERS, Referer: 'https://www.mediafire.com/' },
      timeout       : DL_TIMEOUT,
    })
  } catch (err) {
    throw new Error(`MediaFire: error al iniciar stream — ${err.message}\n${err.stack}`)
  }

  // 4. Barra de progreso
  const totalBytes = parseInt(mfRes.headers['content-length'] || '0', 10)
  const totalMB    = totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) : '?'
  const destPath   = path.join(outputDir, fileName)

  let downloaded = 0
  let lastTime   = Date.now()
  let lastBytes  = 0

  mfRes.data.on('data', chunk => {
    downloaded += chunk.length
    const now     = Date.now()
    const elapsed = (now - lastTime) / 1000
    if (elapsed >= 1) {
      const speed  = ((downloaded - lastBytes) / elapsed / 1024 / 1024).toFixed(1)
      const dlMB   = (downloaded / 1024 / 1024).toFixed(1)
      const pct    = totalBytes ? ((downloaded / totalBytes) * 100).toFixed(1) : '?'
      process.stdout.write(`\r[MF] ${pct}% | ${dlMB} MB / ${totalMB} MB | ${speed} MB/s   `)
      lastTime  = now
      lastBytes = downloaded
    }
  })

  // 5. Capturar errores del stream antes de piping
  mfRes.data.on('error', err => {
    console.error(`\n[tioanime-notify] MediaFire stream error: ${err.message}\n${err.stack}`)
  })

  try {
    await pipeline(mfRes.data, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`MediaFire: fallo durante la escritura — ${err.message}\n${err.stack}`)
  }

  const finalMB = (downloaded / 1024 / 1024).toFixed(1)
  console.log(`\n[tioanime-notify] MediaFire ✅ ${fileName} (${finalMB} MB)`)
  return destPath
}

// ─── Extractores de embed → URL directa ──────────────────────────────────────

function jsUnpack(packed) {
  try {
    const m = packed.match(/}\s*\('(.*)',\s*(.*?),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/)
    if (!m) return null
    const payload = m[1].replace(/\\'/g, "'")
    const radix   = parseInt(m[2]) || 36
    const symtab  = m[4].split('|')
    return payload.replace(/\b[a-zA-Z0-9_]+\b/g, word => {
      const idx = parseInt(word, radix)
      return (symtab[idx] && symtab[idx] !== '') ? symtab[idx] : word
    })
  } catch (_) { return null }
}

function extraerUrlVideo(code) {
  const patrones = [
    /sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["']([^"']+\.m3u8[^"']*)["']/i,
  ]
  for (const re of patrones) {
    const m = code.match(re)
    if (m?.[1]?.startsWith('http')) return m[1]
  }
  return null
}

async function resolverEmbed(embedUrl) {
  const u = embedUrl.toLowerCase()

  // ── Voe ──────────────────────────────────────────────────────────────────
  if (u.includes('voe.sx') || u.match(/voe\d*\.sx/)) {
    try {
      const { data } = await axios.get(embedUrl.replace(/\/e\//, '/'), { headers: { ...HEADERS, Referer: embedUrl }, timeout: 15000 })
      const mHls = data.match(/["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
      if (mHls?.[1]) return mHls[1]
      // Patrón ROT13 + base64 (Voe nuevo)
      const enc = data.match(/\["([A-Za-z0-9+/=@$^~!#&%?*]{20,})"\]/)
      if (enc?.[1]) {
        try {
          let v = enc[1]
          v = v.replace(/[A-Za-z]/g, c => {
            const b = c <= 'Z' ? 65 : 97
            return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b)
          })
          for (const p of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) v = v.split(p).join('_')
          v = Buffer.from(v.replace(/_/g, ''), 'base64').toString('utf-8')
          v = v.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 3)).join('')
          v = Buffer.from(v.split('').reverse().join(''), 'base64').toString('utf-8')
          const json = JSON.parse(v)
          return json.source || json.direct_access_url || json.hls || null
        } catch (_) {}
      }
      const mAny = data.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/)
      if (mAny?.[1]) return mAny[1]
    } catch (_) {}
    return null
  }

  // ── Filemoon ──────────────────────────────────────────────────────────────
  if (u.includes('filemoon') || u.includes('moonplayer')) {
    try {
      const { data } = await axios.get(embedUrl, { headers: { ...HEADERS, Referer: embedUrl }, timeout: 15000 })
      const packed   = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const unpacked = packed ? jsUnpack(packed[0]) : null
      const src      = extraerUrlVideo(unpacked || data)
      if (src) return src
    } catch (_) {}
    return null
  }

  // ── Mp4Upload ─────────────────────────────────────────────────────────────
  if (u.includes('mp4upload')) {
    try {
      const idMatch = embedUrl.match(/mp4upload\.com\/(?:embed-)?([A-Za-z0-9]+)/)
      const url     = idMatch ? `https://www.mp4upload.com/embed-${idMatch[1]}.html` : embedUrl
      const { data } = await axios.get(url, { headers: { ...HEADERS, Referer: 'https://www.mp4upload.com/' }, timeout: 15000 })
      const packed   = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const code     = packed ? jsUnpack(packed[0]) : data
      const m1 = (code || data).match(/player\.src\("([^"]+)"/)
      if (m1?.[1]) return m1[1]
      return extraerUrlVideo(code || data)
    } catch (_) {}
    return null
  }

  // ── DoodStream ────────────────────────────────────────────────────────────
  if (u.includes('dood') || u.includes('ds2play')) {
    try {
      const url  = embedUrl.replace(/\/(d|watch)\//, '/e/')
      const res  = await axios.get(url, { headers: { ...HEADERS, Referer: 'https://dood.wf/' }, timeout: 15000 })
      const text = res.data
      const host = new URL(res.request?.res?.responseUrl || url).origin
      const pass = text.match(/\/pass_md5\/[^'"<\s]*/)?.[0]
      if (!pass) return null
      const token = pass.split('/').pop()
      const r2    = await axios.get(host + pass, { headers: { Referer: url }, timeout: 15000 })
      const rand  = Array.from({ length: 10 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('')
      return `${r2.data}${rand}?token=${token}&expiry=${Date.now()}`
    } catch (_) {}
    return null
  }

  // ── StreamWish / Vidhide / Filelions ──────────────────────────────────────
  if (u.includes('streamwish') || u.includes('wishembed') || u.includes('vidhide') || u.includes('filelions')) {
    try {
      const { data } = await axios.get(embedUrl, { headers: { ...HEADERS, 'Sec-Fetch-Dest': 'document' }, timeout: 15000 })
      const packed   = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      if (packed) {
        const code = jsUnpack(packed[0])
        const src  = code ? extraerUrlVideo(code) : null
        if (src) return src
      }
      return extraerUrlVideo(data)
    } catch (_) {}
    return null
  }

  return null  // sin extractor conocido → yt-dlp lo intenta directamente
}

// Descarga con yt-dlp para embeds
async function descargarEmbed(embedUrl, outputDir, fileName) {
  // Saltar dominios sin soporte real
  const u = embedUrl.toLowerCase()
  if (u.includes('hqq.tv') || u.includes('netu.tv') || u.includes('netu.ac') || u.includes('biribup.com'))
    throw new Error(`Servidor sin soporte: ${embedUrl.split('/')[2]}`)

  // Intentar resolver embed → URL directa con extractores nativos
  let videoUrl = embedUrl
  const resuelto = await resolverEmbed(embedUrl)
  if (resuelto) {
    console.log(`[tioanime-notify] Embed resuelto → ${resuelto.slice(0, 80)}`)
    videoUrl = resuelto
  } else {
    // Fallback: fetch simple buscando patrones mp4/m3u8
    try {
      const { data } = await axios.get(embedUrl, { headers: { ...HEADERS, Referer: TIOANIME_URL }, timeout: 12000 })
      const dm = data.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                 data.match(/"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/)
      if (dm?.[1]) videoUrl = dm[1]
    } catch (_) {}
  }

  const outTemplate = path.join(outputDir, 'video.%(ext)s')
  const cmdArgs = [
    '--no-check-certificate', '--no-warnings',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${UA}`,
    '--add-header', `Referer: ${TIOANIME_URL}/`,
    '-o', outTemplate,
    videoUrl,
  ]

  console.log(`[tioanime-notify] yt-dlp → ${videoUrl.slice(0, 100)}`)

  await new Promise((resolve, reject) => {
    const proc  = spawn('yt-dlp', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errBuf  = ''
    proc.stderr.on('data', d => { errBuf += d.toString() })
    proc.stdout.on('data', d => process.stdout.write(`[tio] ${d}`))
    const timer = setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')) }, DL_TIMEOUT)
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errBuf.trim() || `código ${code}`)) })
    proc.on('error', err  => { clearTimeout(timer); reject(err) })
  })

  const archivos = fs.readdirSync(outputDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f))
  if (!archivos.length) throw new Error('yt-dlp no generó ningún archivo')

  const srcPath  = path.join(outputDir, archivos[0])
  const destPath = path.join(outputDir, fileName)
  fs.renameSync(srcPath, destPath)
  return destPath
}

// ─── Enviar episodio ──────────────────────────────────────────────────────────

async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl, fuente = 'tioanime', idioma = 'latino' } = ep
  const fileName = buildFileName(titulo, epNum)
  const tmpDir   = path.join(process.env.TMPDIR || '/tmp', `tio_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const bandera  = fuente === 'latanime' ? (idioma === 'castellano' ? '🇪🇸' : '🇲🇽') : '🇯🇵'
  const etiqueta = fuente === 'latanime' ? `LatAnime ${bandera}` : 'TioAnime 🇯🇵'
  console.log(`[tioanime-notify] Enviando [${fuente}]: ${fileName}`)

  try {
    // 1. Aviso con imagen
    const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
    const caption =
      `*✨Nuevo Episodio ✨*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `> ${bandera} ${titulo}\n` +
      `> 🆕 Capítulo: *${epNum}*\n` +
      `> 🕐 Publicado: *${ahora}*\n` +
      `> 🌐 Ver online: ${epUrl}\n` +
      `> 📡 Fuente: *${etiqueta}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ _INICIANDO DESCARGA..._`

    if (imgUrl) {
      try {
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: HEADERS, timeout: 10000 })
        await conn.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption })
      } catch (_) {
        await conn.sendMessage(chatId, { text: caption })
      }
    } else {
      await conn.sendMessage(chatId, { text: caption })
    }

    // 2. Obtener servidores según la fuente
    const srvs = fuente === 'latanime'
      ? await scrapeServidoresLatAnime(epUrl)
      : await scrapeServidores(epUrl)

    if (!srvs.length) throw new Error('No se encontraron servidores de video')

    // 3. Esperar 15s
    console.log('[tioanime-notify] Esperando 15s antes de descargar...')
    await new Promise(r => setTimeout(r, 15_000))

    // 4. Descargar — orden de preferencia según fuente
    const orden = ordenarServidores(srvs, fuente).slice(0, 5)
    console.log(`[tioanime-notify] Orden [${fuente}]: ${orden.map(s => s.nombre).join(' → ')}`)

    let videoPath = null

    for (const srv of orden) {
      try {
        console.log(`[tioanime-notify] Intentando: ${srv.nombre} — ${srv.url.slice(0, 80)}`)

        if (srv.nombre === 'mega') {
          videoPath = await descargarMega(srv.url, tmpDir, fileName)
        } else if (srv.nombre === 'mediafire') {
          videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        } else {
          videoPath = await descargarEmbed(srv.url, tmpDir, fileName)
        }

        break
      } catch (err) {
        // Mostrar error completo con stack para diagnóstico real
        console.error(`[tioanime-notify] ❌ ${srv.nombre} falló:`)
        console.error(err.stack || err.message)
        fs.readdirSync(tmpDir).forEach(f => {
          try { if (f !== 'cover.jpg') fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {}
        })
      }
    }

    if (!videoPath) throw new Error('Todos los servidores fallaron')

    // 5. Enviar video
    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
    await conn.sendMessage(chatId, {
      document : fs.readFileSync(videoPath),
      fileName,
      mimetype : 'video/mp4',
      caption  : `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${etiqueta}`,
    })

    console.log(`[tioanime-notify] ✅ ${fileName}`)

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

async function procesarCola() {
  // Si ya está corriendo, no iniciar otra instancia
  if (global.tioQueueRunning) {
    console.log('[tioanime-notify] Cola ya está corriendo, ignorando llamada duplicada')
    return
  }

  if (!global.tioEpisodeQueue.length) return

  global.tioQueueRunning = true
  console.log(`[tioanime-notify] Cola iniciada — ${global.tioEpisodeQueue.length} episodio(s)`)

  const MAX_REINTENTOS   = 3
  const ESPERA_REINTENTO = 3 * 60_000   // 3 min entre reintentos (la sesión WA necesita tiempo)
  const ESPERA_REQUEUEUE = 5 * 60_000   // 5 min antes de re-encolar si la conexión sigue caída

  try {
    while (global.tioEpisodeQueue.length > 0) {
      const item = global.tioEpisodeQueue[0]
      if (!item) { global.tioEpisodeQueue.shift(); continue }

      const { chatId, ep } = item
      let intentos = 0
      let exito    = false

      while (intentos < MAX_REINTENTOS && !exito) {
        intentos++
        // Usar siempre global.tioConn (conn fresco tras reconexión)
        // El conn capturado al encolar puede ser una referencia muerta
        const connActivo = global.tioConn
        if (!connActivo) {
          console.log('[tioanime-notify] ⚠️  Sin conn activo, esperando reconexión...')
          await new Promise(r => setTimeout(r, ESPERA_REINTENTO))
          continue
        }
        try {
          await enviarEpisodio(chatId, ep, connActivo)
          exito = true
          global.tioEpisodeQueue.shift()
          console.log(`[tioanime-notify] ✅ Cola: completado ${ep.titulo} ep ${zeroPad(ep.epNum)}`)
        } catch (err) {
          const esConexion = /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)
          console.error(`[tioanime-notify] ❌ Intento ${intentos}/${MAX_REINTENTOS}: ${err.message}`)
          if (err.stack) console.error(err.stack)

          if (esConexion && intentos < MAX_REINTENTOS) {
            const espera = ESPERA_REINTENTO * intentos  // 3min, 6min progresivo
            console.log(`[tioanime-notify] ♻️  Esperando ${espera/60000}min antes de reintentar...`)
            await new Promise(r => setTimeout(r, espera))
          } else if (esConexion) {
            // Se agotaron reintentos pero es fallo de conexión → re-encolar al final
            // así se intenta de nuevo en el próximo chequeo sin perder el episodio
            global.tioEpisodeQueue.shift()
            global.tioEpisodeQueue.push({ chatId, ep })
            console.log(`[tioanime-notify] 🔁 Re-encolado (conexión caída): ${ep.titulo} ep ${zeroPad(ep.epNum)}`)
            console.log(`[tioanime-notify] ⏳ Esperando ${ESPERA_REQUEUEUE/60000}min antes de continuar...`)
            await new Promise(r => setTimeout(r, ESPERA_REQUEUEUE))
            break  // salir del while reintentos, el próximo item de cola lo procesará
          } else {
            // Error no recuperable (no es conexión) → descartar
            global.tioEpisodeQueue.shift()
            console.error(`[tioanime-notify] ❌ Cola error (no recuperable): ${err.message}`)
            if (err.stack) console.error(err.stack)
            try {
              const connErr = global.tioConn
              if (connErr) await connErr.sendMessage(chatId, {
                text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}`
              })
            } catch (_) {}
          }
        }
      } // fin while reintentos

      // Pausa entre episodios si hay más en cola
      if (global.tioEpisodeQueue.length > 0) {
        console.log(`[tioanime-notify] Cola: ${global.tioEpisodeQueue.length} pendiente(s), esperando ${QUEUE_DELAY / 1000}s...`)
        await new Promise(r => setTimeout(r, QUEUE_DELAY))
      }
    }
  } catch (fatalErr) {
    // Error inesperado fuera del try interno — loguear y continuar
    console.error('[tioanime-notify] Error fatal en cola:', fatalErr.message)
    if (fatalErr.stack) console.error(fatalErr.stack)
  } finally {
    // SIEMPRE resetear el flag, pase lo que pase
    global.tioQueueRunning = false
    console.log('[tioanime-notify] Cola finalizada')
  }
}

// ─── Chequeo periódico ────────────────────────────────────────────────────────

async function checkNuevosEpisodios(chatId, conn) {
  console.log(`[tioanime-notify] Chequeando para ${chatId}...`)

  let lista = []
  // Revisar TioAnime (SUB japonés)
  try {
    const tio = await fetchLatestEpisodes()
    lista = lista.concat(tio)
  } catch (err) {
    console.error('[tioanime-notify] TioAnime fetch error:', err.message)
    if (err.stack) console.error(err.stack)
  }

  // Revisar LatAnime (doblaje/sub latino)
  try {
    const lat = await fetchLatestEpisodesLatAnime()
    lista = lista.concat(lat)
  } catch (err) {
    console.error('[tioanime-notify] LatAnime fetch error:', err.message)
    if (err.stack) console.error(err.stack)
  }

  if (!lista.length) return

  const seen = loadSeen()
  if (!seen[chatId]) seen[chatId] = []
  const nuevos = lista.filter(e => !seen[chatId].includes(e.id))
  if (!nuevos.length) { console.log('[tioanime-notify] Sin novedades'); return }

  console.log(`[tioanime-notify] ${nuevos.length} nuevo(s):`, nuevos.map(e => e.id).join(', '))

  for (const ep of nuevos) seen[chatId].push(ep.id)
  if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
  saveSeen(seen)

  if (nuevos.length > 1) {
    try {
      await conn.sendMessage(chatId, {
        text:
          `📋 *${nuevos.length} episodios nuevos detectados*\n\n` +
          nuevos.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
          `\n\n⏳ _Se enviarán de uno en uno..._`
      })
    } catch (_) {}
  }

  for (const ep of nuevos) global.tioEpisodeQueue.push({ chatId, ep })
  procesarCola().catch(err => {
    console.error('[tioanime-notify] cola error:', err.message)
    if (err.stack) console.error(err.stack)
  })
}

// ─── Notificador ─────────────────────────────────────────────────────────────

function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.tioConn = conn  // guardar siempre el conn más reciente
  if (global.tioActiveChats.has(chatId)) clearInterval(global.tioActiveChats.get(chatId).timer)
  const timer = setInterval(() => {
    const c = global.tioConn
    if (!c) return
    checkNuevosEpisodios(chatId, c).catch(e => {
      console.error('[tioanime-notify] interval error:', e.message)
      if (e.stack) console.error(e.stack)
    })
  }, intervalMin * 60 * 1000)
  global.tioActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState()
  state[chatId] = { intervalMin, startedAt: Date.now() }
  saveState(state)
  console.log(`[tioanime-notify] Iniciado en ${chatId} cada ${intervalMin} min`)
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

// ─── Watchdog — revisa cada 2 min que los intervalos sigan vivos ──────────────
// Se crea una sola vez aunque el plugin se recargue en caliente (hot-reload)
if (!global.tioWatchdog) {
  global.tioWatchdog = setInterval(() => {
    const conn = global.tioConn
    if (!conn) return
    const state = loadState()
    let restaurados = 0
    for (const [chatId, cfg] of Object.entries(state)) {
      if (!global.tioActiveChats.has(chatId)) {
        console.log('[tioanime-notify] 🔄 Watchdog restaurando: ' + chatId)
        iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT)
        restaurados++
      }
    }
    if (restaurados > 0) console.log('[tioanime-notify] Watchdog restauró ' + restaurados + ' chat(s)')
  }, 2 * 60 * 1000)  // cada 2 minutos
  console.log('[tioanime-notify] Watchdog iniciado')
}

// ─── Handler ──────────────────────────────────────────────────────────────────

let handler = async (m, { conn, text, usedPrefix, command }) => {

  // Actualizar conn global y restaurar cualquier chat perdido
  if (conn) global.tioConn = conn
  restaurarNotificadores(conn)

  // .tiostart
  if (command === 'tiostart') {
    const min = parseInt(text?.trim())
    const intervalMin = (!isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, {
      text:
        `✅ *Notificador TioAnime + LatAnime activado*\n\n` +
        `╭━━━━━━〔 📡 〕━━━━━━\n` +
        `┃ ⏱️ Intervalo: *${intervalMin} min*\n` +
        `┃ 🇯🇵 TioAnime — Sub japonés\n` +
        `┃ 🇲🇽🇪🇸 LatAnime — Latino / Castellano\n` +
        `┃ 💬 Chat registrado\n` +
        `╰━━━━━━━━━━━━━━━━━━\n\n` +
        `_Usa ${usedPrefix}tiostop para detener._`
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
      await conn.sendMessage(m.chat, {
        text: `📋 *${tio.length}* ep TioAnime + *${lat.length}* ep LatAnime registrados como base.\n_Solo los nuevos se enviarán._`
      }, { quoted: m })
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `⚠️ Chequeo inicial falló: ${err.message}` }, { quoted: m })
    }
    return
  }

  // .tiostop
  if (command === 'tiostop') {
    if (!global.tioActiveChats.has(m.chat)) return m.reply(`ℹ️ El notificador no estaba activo.`)
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}tiostart para reactivar._`)
  }

  // .tiostatus
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

  // .tioqueue
  if (command === 'tioqueue') {
    if (!global.tioEpisodeQueue.length) return m.reply(`✅ Cola vacía.`)
    return m.reply(
      `📋 *Cola (${global.tioEpisodeQueue.length}):*\n\n` +
      global.tioEpisodeQueue.map((i, n) =>
        `${n + 1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} [${i.chatId === m.chat ? 'este chat' : 'otro chat'}]`
      ).join('\n')
    )
  }

  // .tioflush
  if (command === 'tioflush') {
    const antes = global.tioEpisodeQueue.length
    global.tioEpisodeQueue = global.tioEpisodeQueue.filter(i => i.chatId !== m.chat)
    return m.reply(`🗑️ *${antes - global.tioEpisodeQueue.length}* episodio(s) eliminado(s).`)
  }

  // .tiounblock — desbloquea la cola si quedó trabada
  if (command === 'tiounblock') {
    const estaba = global.tioQueueRunning
    global.tioQueueRunning = false
    if (global.tioEpisodeQueue.length > 0) {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.tioEpisodeQueue.length} episodio(s)...`)
      procesarCola().catch(e => console.error('[tioanime-notify] cola error:', e.message))
    } else {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\nℹ️ No hay episodios pendientes.`)
    }
    return
  }

  // .tiocheck
  if (command === 'tiocheck') {
    await m.reply(`🔍 Chequeando TioAnime...`)
    try {
      await checkNuevosEpisodios(m.chat, conn)
      if (!global.tioEpisodeQueue.some(i => i.chatId === m.chat)) await m.reply(`✅ Sin episodios nuevos.`)
    } catch (err) { await m.reply(`❌ Error: ${err.message}`) }
    return
  }

  // .tiointerval
  if (command === 'tiointerval') {
    const min = parseInt(text?.trim())
    if (isNaN(min) || min < 5 || min > 60) return m.reply(`❌ Número entre *5* y *60*.\nEj: *${usedPrefix}tiointerval 15*`)
    if (!global.tioActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}tiostart* primero.`)
    iniciarNotificador(m.chat, conn, min)
    return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`)
  }

  // .tioexample [N] — prueba con los N episodios más recientes de TioAnime (SUB japonés)
  if (command === 'tioexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *TioAnime*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodes()
      if (!lista.length) return m.reply(`❌ Sin episodios de TioAnime disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error al obtener episodios: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(
        `📋 *${seleccion.length} episodios seleccionados (TioAnime):*\n\n` +
        seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
        `\n\n⏳ _Se enviarán de uno en uno..._`
      )
    }

    for (const ep of seleccion) {
      global.tioEpisodeQueue.push({ chatId: m.chat, ep })
    }
    procesarCola().catch(e => console.error('[tioanime-notify] cola error:', e.message))
    return
  }

  // .latexample [N] — prueba con los N episodios más recientes de LatAnime (doblaje latino/castellano)
  if (command === 'latexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *LatAnime*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodesLatAnime()
      if (!lista.length) return m.reply(`❌ Sin episodios de LatAnime disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error al obtener episodios: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(
        `📋 *${seleccion.length} episodios seleccionados (LatAnime):*\n\n` +
        seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
        `\n\n⏳ _Se enviarán de uno en uno..._`
      )
    }

    for (const ep of seleccion) {
      global.tioEpisodeQueue.push({ chatId: m.chat, ep })
    }
    procesarCola().catch(e => console.error('[tioanime-notify] cola error:', e.message))
    return
  }
}

handler.command = /^(tiostart|tiostop|tiostatus|tiocheck|tioqueue|tioflush|tiounblock|tiointerval|tioexample|latexample)$/i
handler.tags    = ['anime', 'notificaciones']
handler.help    = ['tiostart', 'tiostop', 'tiostatus', 'tiocheck', 'tioqueue', 'tioflush', 'tiounblock', 'tiointerval <min>', 'tioexample [N]', 'latexample [N]']
handler.exp     = 0
handler.level   = 0
handler.limit   = false

// Actualizar conn y restaurar en cada mensaje (sin guardia — restaurarNotificadores ya deduplica)
handler.before = async (m, { conn }) => {
  if (conn) global.tioConn = conn
  restaurarNotificadores(conn)
}

export default handler
