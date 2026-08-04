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
import { File as MegaFile } from 'megajs'

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

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadSeen()   { try { return JSON.parse(fs.readFileSync(SEEN_FILE,  'utf-8')) } catch (_) { return {} } }
function saveSeen(d)  { try { fs.writeFileSync(SEEN_FILE,  JSON.stringify(d, null, 2)) } catch (_) {} }
function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch (_) { return {} } }
function saveState(d) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n)  { return String(n).padStart(2, '0') }
function safeFile(s) { return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
function buildFileName(titulo, epNum) { return `${zeroPad(epNum)} ${safeFile(titulo)}.mp4` }

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
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc.startsWith('//') ? 'https:' + imgSrc : imgSrc ? TIOANIME_URL + imgSrc : ''
    const epUrl  = href.startsWith('http') ? href : TIOANIME_URL + href
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
        const esMega      = url.includes('mega.nz') || url.includes('mega.co.nz')
        const esMediafire = url.includes('mediafire.com')
        srvs.push({ nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : nombre, url, directo: esMega || esMediafire })
      }
    } catch (err) {}
  }

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
    const imgUrl = (!imgSrc || imgSrc.startsWith('data:')) ? '' : imgSrc.startsWith('http') ? imgSrc : LATANIME_URL + imgSrc
    const epUrl  = href.startsWith('http') ? href : LATANIME_URL + href
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

    const esMega      = href.includes('mega.nz')
    const esMediafire = href.includes('mediafire.com')
    const esOtro = href.includes('voe.sx') || href.includes('streamtape') || href.includes('filemoon') || href.includes('mp4upload') || href.includes('streamwish') || href.includes('dood') || href.includes('upstream') || href.includes('ok.ru') || href.includes('vidhide') || href.includes('mixdrop') || href.includes('savefiles') || href.includes('gofile.io') || href.includes('byse')
    const esRedirector = !href.includes('latanime.org') && !href.includes('javascript') && !href.includes('#') && href.length > 20 && !href.match(/\.(jpg|png|gif|css|js)$/)

    if (srvs.find(s => s.url === href)) return
    if (esMega || esMediafire) srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, directo: true })
    else if (esOtro) srvs.push({ nombre: label || detectarServNombre(href), url: href, directo: false })
    else if (esRedirector) srvs.push({ nombre: label || 'redir', url: href, directo: false, esRedirector: true })
  })

  const redirs = srvs.filter(s => s.esRedirector)
  for (const r of redirs) {
    try {
      const res = await axios.get(r.url, { headers: { 'User-Agent': UA, 'Referer': LATANIME_URL }, maxRedirects: 5, timeout: 10000, validateStatus: () => true })
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
    if (embedUrl.startsWith('http') && !srvs.find(s => s.url === embedUrl)) srvs.push({ nombre: detectarServNombre(embedUrl), url: embedUrl, directo: false })
  })
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
  if (fuente === 'latanime') return [...mediafire, ...mega, ...otros, ...embeds]
  return [...mega, ...mediafire, ...otros, ...embeds]
}

async function descargarMega(megaUrl, outputDir, fileName) {
  let url = megaUrl
  const m1 = megaUrl.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m1) url = `https://mega.nz/file/${m1[1]}#${m1[2]}`
  const m2 = megaUrl.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m2) url = `https://mega.nz/file/${m2[1]}#${m2[2]}`

  const file = MegaFile.fromURL(url)
  await file.loadAttributes()
  const total      = file.size || 0
  const destPath   = path.join(outputDir, fileName)
  const fileStream = file.download()

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
        process.stdout.write(`\r[MEGA] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtBytes(speed)}/s   `)
      }
      cb(null, chunk)
    },
  })

  try {
    await pipeline(fileStream, tracker, fs.createWriteStream(destPath))
    process.stdout.write('\n')
  } catch (err) {
    process.stdout.write('\n')
    throw new Error(`Mega error: ${err.message}`)
  }
  return destPath
}

async function descargarMediaFire(mfUrl, outputDir, fileName) {
  let mfPage
  try {
    const res = await axios.get(mfUrl, { headers: HEADERS, timeout: 12000 })
    mfPage = res.data
  } catch (err) { throw new Error(`MediaFire: ${err.message}`) }

  const mfLink = mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
                 mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1] ||
                 mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]
                 
  if (!mfLink) throw new Error('MediaFire: sin link directo')

  let mfRes
  try {
    mfRes = await axios.get(mfLink, { responseType: 'stream', headers: { ...HEADERS, Referer: 'https://www.mediafire.com/' }, timeout: DL_TIMEOUT })
  } catch (err) { throw new Error(`MediaFire: ${err.message}`) }

  const total = parseInt(mfRes.headers['content-length'] || '0')
  const destPath = path.join(outputDir, fileName)

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
        process.stdout.write(`\r[MEDIAFIRE] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtBytes(speed)}/s   `)
      }
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

// ─── Enviar episodio ──────────────────────────────────────────────────────────

async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl, fuente = 'tioanime', idioma = 'latino' } = ep
  const fileName = buildFileName(titulo, epNum)
  
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
    const orden = ordenarServidores(srvs, fuente).slice(0, 5)
    let videoPath = null

    for (const srv of orden) {
      const nombreServidor = (srv.nombre || 'servidor').toUpperCase()
      try {
        if (srv.nombre === 'mega' || srv.nombre === 'mediafire') {
          console.log(`[tioanime-notify] 🔄 Conectando con [ ${nombreServidor} ]...`)
        } else {
          continue // "otros" directos y embeds: sin soporte de descarga por ahora, seguir probando
        }

        if (srv.nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)

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

    // [CORRECCIÓN 3] Usar { url: videoPath } para usar streaming real y no congelar el bot ni la memoria RAM
    await conn.sendMessage(chatId, {
      document : { url: videoPath },
      fileName,
      mimetype : 'video/mp4',
      caption  : `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${etiqueta}`,
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
          global.tioEpisodeQueue.shift()
        } catch (err) {
          const esConexion = /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)
          if (esConexion && intentos < MAX_REINTENTOS) {
            await new Promise(r => setTimeout(r, ESPERA_REINTENTO * intentos))
          } else if (esConexion) {
            global.tioEpisodeQueue.shift()
            global.tioEpisodeQueue.push({ chatId, ep })
            await new Promise(r => setTimeout(r, ESPERA_REQUEUEUE))
            break
          } else {
            global.tioEpisodeQueue.shift()
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
  } finally {
    global.tioQueueRunning = false
  }
}

async function checkNuevosEpisodios(chatId, conn) {
  let lista = []
  try { lista = lista.concat(await fetchLatestEpisodes()) } catch (err) {}
  try { lista = lista.concat(await fetchLatestEpisodesLatAnime()) } catch (err) {}
  if (!lista.length) return

  const seen = loadSeen()
  if (!seen[chatId]) seen[chatId] = []
  const nuevos = lista.filter(e => !seen[chatId].includes(e.id))
  if (!nuevos.length) return

  for (const ep of nuevos) seen[chatId].push(ep.id)
  if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
  saveSeen(seen)

  if (nuevos.length > 1) {
    try {
      await conn.sendMessage(chatId, { text: `📋 *${nuevos.length} episodios nuevos detectados*\n\n` + nuevos.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + `\n\n⏳ _Se enviarán de uno en uno..._` })
    } catch (_) {}
  }

  for (const ep of nuevos) global.tioEpisodeQueue.push({ chatId, ep })
  procesarCola().catch(err => {})
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
    global.tioEpisodeQueue = global.tioEpisodeQueue.filter(i => i.chatId !== m.chat)
    return m.reply(`🗑️ *${antes - global.tioEpisodeQueue.length}* episodio(s) eliminado(s).`)
  }

  if (command === 'tiounblock') {
    const estaba = global.tioQueueRunning
    global.tioQueueRunning = false
    if (global.tioEpisodeQueue.length > 0) {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.tioEpisodeQueue.length} episodio(s)...`)
      procesarCola().catch(e => {})
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

    for (const ep of seleccion) global.tioEpisodeQueue.push({ chatId: m.chat, ep })
    procesarCola().catch(e => {})
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

    for (const ep of seleccion) global.tioEpisodeQueue.push({ chatId: m.chat, ep })
    procesarCola().catch(e => {})
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
