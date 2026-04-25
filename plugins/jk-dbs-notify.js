// plugins/jk-dbs-notify.js — v1.0
//
// Notificador automático de nuevos episodios — JKAnime (SUB japonés) + AnimeDBS (SUB español)
//
// Comandos:
//   .jkstart               → inicia el notificador (JKAnime SUB + AnimeDBS SUB)
//   .jkstop                → detiene el notificador en el chat actual
//   .jkstatus              → muestra estado y cola
//   .jkqueue               → ver episodios en cola
//   .jkflush               → vaciar la cola de este chat
//   .jkcheck               → forzar chequeo ahora
//   .jkinterval <minutos>  → cambiar intervalo (mín 5, máx 60)
//   .jkexample [N]         → prueba con los N episodios más recientes de JKAnime (por defecto 1)
//   .dbsexample [N]        → prueba con los N episodios más recientes de AnimeDBS (por defecto 1)

import axios        from 'axios'
import * as cheerio from 'cheerio'
import fs           from 'fs'
import path         from 'path'
import { spawn }    from 'child_process'
import { pipeline } from 'stream/promises'
import { File as MegaFile } from 'megajs'

// ─── Constantes ───────────────────────────────────────────────────────────────

const JKANIME_URL            = 'https://jkanime.net'
const ANIMEDBS_URL           = 'https://www.animedbs.online'
const SEEN_FILE              = path.join(process.env.TMPDIR || '/tmp', 'jkdbs_seen.json')
const STATE_FILE             = path.join(process.env.TMPDIR || '/tmp', 'jkdbs_state.json')
const CHECK_INTERVAL_DEFAULT = 10       // minutos
const QUEUE_DELAY            = 90_000   // ms entre ítems de cola (90 seg)
const DL_TIMEOUT             = 3 * 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

// ─── Estado global ────────────────────────────────────────────────────────────

global.jkActiveChats  = global.jkActiveChats  || new Map()
global.jkEpisodeQueue = global.jkEpisodeQueue || []
global.jkQueueRunning = global.jkQueueRunning || false
global.jkConn         = global.jkConn         || null

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadSeen()   { try { return JSON.parse(fs.readFileSync(SEEN_FILE,  'utf-8')) } catch (_) { return {} } }
function saveSeen(d)  { try { fs.writeFileSync(SEEN_FILE,  JSON.stringify(d, null, 2)) } catch (_) {} }
function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch (_) { return {} } }
function saveState(d) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n)  { return String(n).padStart(2, '0') }
function safeFile(s) { return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
function buildFileName(titulo, epNum) { return `${zeroPad(epNum)} ${safeFile(titulo)}.mp4` }

// ─── Scraping JKAnime ─────────────────────────────────────────────────────────

async function fetchLatestEpisodesJK() {
  const { data } = await axios.get(JKANIME_URL, { headers: HEADERS, timeout: 15000 })
  const $    = cheerio.load(data)
  const lista = []

  $('#animes .dir1').each((_, el) => {
    const $el    = $(el)
    const aTag   = $el.find('a').first()
    const href   = aTag.attr('href') || ''
    if (!href) return

    // URL esperada: https://jkanime.net/anime-slug/N/ o /anime-slug/N/
    const m = href.match(/jkanime\.net\/([^/]+)\/(\d+)\/?$/) ||
              href.match(/^\/([^/]+)\/(\d+)\/?$/)
    if (!m) return

    const slug   = m[1]
    const epNum  = parseInt(m[2])
    const tiempo = $el.find('.badge-secondary').text().trim()

    // Solo episodios de hoy o ayer
    if (!tiempo.toLowerCase().includes('hoy') && !tiempo.toLowerCase().includes('ayer')) return

    const titulo = ($el.find('.card-title').text() || aTag.attr('title') || slug.replace(/-/g, ' ')).trim()
    const imgEl  = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || ''
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc ? JKANIME_URL + imgSrc : ''
    const epUrl  = href.startsWith('http') ? href : JKANIME_URL + href
    const id     = `jk-${slug.toLowerCase()}-${epNum}`

    if (!lista.find(e => e.id === id))
      lista.push({ id, slug, titulo, epNum, epUrl, imgUrl, fuente: 'jkanime' })
  })

  // Fallback: cualquier link de episodio
  if (lista.length === 0) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m = href.match(/jkanime\.net\/([^/]+)\/(\d+)\/?$/) ||
                href.match(/^\/([^/]+)\/(\d+)\/?$/)
      if (!m) return
      const slug  = m[1]
      const epNum = parseInt(m[2])
      const id    = `jk-${slug.toLowerCase()}-${epNum}`
      if (lista.find(e => e.id === id)) return
      const titulo = ($(el).attr('title') || $(el).text() || slug.replace(/-/g, ' ')).trim()
      const epUrl  = href.startsWith('http') ? href : JKANIME_URL + href
      lista.push({ id, slug, titulo, epNum, epUrl, imgUrl: '', fuente: 'jkanime' })
    })
  }

  console.log(`[jk-dbs-notify] JKAnime: ${lista.length} episodios en portada`)
  return lista
}

// Scraping de servidores para JKAnime
async function scrapeServidoresJK(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: JKANIME_URL }, timeout: 15000 })
  const $ = cheerio.load(data)
  const srvs = []

  // ── 1. Extraer var servers = [...] del JS de la página ──────────────────────
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('var servers') && !code.includes('var\tservers')) return

    // Capturar el array de servidores
    const match = code.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/)
    if (!match) return
    try {
      const servidores = JSON.parse(match[1])
      for (const srv of servidores) {
        if (!srv.remote) continue
        // Decodificar base64 → URL real
        let url = ''
        try { url = Buffer.from(srv.remote, 'base64').toString('utf-8').trim() } catch (_) { continue }
        if (!url.startsWith('http')) continue
        if (srvs.find(s => s.url === url)) continue

        const nombre = (srv.server || '').toLowerCase()
        const esMega      = url.includes('mega.nz') || url.includes('mega.co.nz')
        const esMediafire = url.includes('mediafire.com')
        const sinSoporte  = url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')
        if (sinSoporte) continue

        srvs.push({
          nombre  : esMega ? 'mega' : esMediafire ? 'mediafire' : nombre || detectarServNombre(url),
          url,
          directo : esMega || esMediafire,
        })
      }
      console.log(`[jk-dbs-notify] JKAnime servers JS: ${srvs.length} encontrado(s)`)
    } catch (_) {}
  })

  // ── 2. AJAX /ajax/download_episode/{id} — obtener el ID del episodio ─────────
  let epId = null
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    // Buscar: /ajax/download_episode/72699
    const m1 = code.match(/\/ajax\/download_episode\/(\d+)/)
    if (m1) { epId = m1[1]; return false }
    // Buscar: var ep_id = 72699 o episodeId = 72699
    const m2 = code.match(/(?:ep_id|episode_id|episodeId)\s*=\s*(\d+)/)
    if (m2) { epId = m2[1]; return false }
  })

  if (epId && srvs.filter(s => s.directo).length === 0) {
    try {
      const ajaxUrl = `${JKANIME_URL}/ajax/download_episode/${epId}`
      console.log(`[jk-dbs-notify] JKAnime AJAX: ${ajaxUrl}`)
      const ajaxRes = await axios.get(ajaxUrl, {
        headers: { ...HEADERS, Referer: epUrl, 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 12000,
      })
      // Respuesta puede ser: { url: "...", nombre: "..." } o lista de servidores
      const d = ajaxRes.data
      if (d?.url?.startsWith('http') && !srvs.find(s => s.url === d.url)) {
        const esMega      = d.url.includes('mega.nz')
        const esMediafire = d.url.includes('mediafire.com')
        srvs.push({
          nombre  : esMega ? 'mega' : esMediafire ? 'mediafire' : detectarServNombre(d.url),
          url     : d.url,
          directo : esMega || esMediafire,
        })
      }
    } catch (err) {
      console.log(`[jk-dbs-notify] JKAnime AJAX falló: ${err.message}`)
    }
  }

  // ── 3. Links directos en el HTML ─────────────────────────────────────────────
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href.startsWith('http')) return
    const esMega      = href.includes('mega.nz') || href.includes('mega.co.nz')
    const esMediafire = href.includes('mediafire.com')
    const sinSoporte  = href.includes('hqq.tv') || href.includes('netu.tv')
    if (sinSoporte || (!esMega && !esMediafire)) return
    if (srvs.find(s => s.url === href)) return
    srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, directo: true })
  })

  // ── 4. iframes como último recurso ───────────────────────────────────────────
  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, directo: false })
    })
  }

  console.log(`[jk-dbs-notify] JKAnime ${srvs.length} servidores — Mega: ${srvs.filter(s => s.nombre === 'mega').length}`)
  return srvs
}

// ─── Scraping AnimeDBS ────────────────────────────────────────────────────────

async function fetchLatestEpisodesDBS() {
  const { data } = await axios.get(ANIMEDBS_URL, { headers: HEADERS, timeout: 15000 })
  const $    = cheerio.load(data)
  const lista = []

  $('.listupd .bs').each((_, el) => {
    const $el   = $(el)
    const aTag  = $el.find('a').first()
    const href  = aTag.attr('href') || ''
    if (!href) return

    const epUrl = href.startsWith('http') ? href : ANIMEDBS_URL + href

    // Extraer número de episodio del texto .epx  ("Episodio 4" → 4) o de la URL
    const epxText = $el.find('.epx').text().trim()
    const epNumStr = epxText.match(/\d+/)?.[0] || epUrl.match(/episodio[- _]?(\d+)/i)?.[1] || '0'
    const epNum  = parseInt(epNumStr)

    // Título: preferir .tite1 (nombre del anime) sobre h2 (título completo del episodio)
    const anime  = $el.find('.tite1').text().trim()
    const h2     = $el.find('h2').text().trim()
    const titulo = anime || h2.replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').trim() || 'Anime desconocido'

    const imgEl  = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || ''
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc.startsWith('//') ? 'https:' + imgSrc : imgSrc ? ANIMEDBS_URL + imgSrc : ''

    // ID estable: slug del anime + número de episodio
    const slugBase = titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const id       = `dbs-${slugBase}-${epNum}`

    if (!lista.find(e => e.id === id))
      lista.push({ id, slug: slugBase, titulo, epNum, epUrl, imgUrl, fuente: 'animedbs' })
  })

  console.log(`[jk-dbs-notify] AnimeDBS: ${lista.length} episodios en portada`)
  return lista
}

// Scraping de servidores para AnimeDBS
async function scrapeServidoresDBS(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: ANIMEDBS_URL }, timeout: 15000 })
  const $ = cheerio.load(data)
  const srvs = []

  // ── 1. Bloques de descarga .soraddlx → .soraurlx → a ────────────────────────
  // Estructura:
  //   .soraddlx
  //     .sorattlx > h3 ("Descargar MP4")
  //     .soraurlx
  //       strong ("720p")
  //       a[href] (MEGA, MediaFire…)
  $('.soraddlx').each((_, bloque) => {
    const $bloque = $(bloque)
    // Detectar calidad en strong dentro de .soraurlx
    $bloque.find('.soraurlx').each((_, urlBlk) => {
      const calidad = $(urlBlk).find('strong').text().trim()  // "720p", "1080p", etc.
      $(urlBlk).find('a[href]').each((_, el) => {
        const href   = $(el).attr('href') || ''
        const label  = $(el).text().trim().toLowerCase()
        if (!href.startsWith('http')) return
        if (srvs.find(s => s.url === href)) return

        const esMega      = href.includes('mega.nz') || href.includes('mega.co.nz')
        const esMediafire = href.includes('mediafire.com')
        const sinSoporte  = href.includes('hqq.tv') || href.includes('netu.tv') || href.includes('netu.ac')
        if (sinSoporte) return

        srvs.push({
          nombre  : esMega ? 'mega' : esMediafire ? 'mediafire' : label || detectarServNombre(href),
          url     : href,
          calidad : calidad || '720p',
          directo : esMega || esMediafire,
        })
      })
    })
  })

  // ── 2. Fallback: cualquier link mega/mediafire directo en la página ──────────
  if (srvs.length === 0) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      if (!href.startsWith('http')) return
      const esMega      = href.includes('mega.nz') || href.includes('mega.co.nz')
      const esMediafire = href.includes('mediafire.com')
      if (!esMega && !esMediafire) return
      if (srvs.find(s => s.url === href)) return
      srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, calidad: '720p', directo: true })
    })
  }

  // ── 3. iframes embed como último recurso ─────────────────────────────────────
  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, calidad: '', directo: false })
    })
  }

  // Ordenar: 720p primero dentro de directos (Mega/MF preferidos sobre embeds)
  srvs.sort((a, b) => {
    if (a.directo && !b.directo) return -1
    if (!a.directo && b.directo) return  1
    // Dentro de directos: 720p antes que otros
    const aP = a.calidad.includes('720') ? 0 : a.calidad.includes('1080') ? 1 : 2
    const bP = b.calidad.includes('720') ? 0 : b.calidad.includes('1080') ? 1 : 2
    return aP - bP
  })

  console.log(`[jk-dbs-notify] AnimeDBS ${srvs.length} servidores — Mega: ${srvs.filter(s => s.nombre === 'mega').length}`)
  return srvs
}

// ─── Helper de nombres de servidores ─────────────────────────────────────────

function detectarServNombre(url) {
  const u = url.toLowerCase()
  if (u.includes('mediafire'))  return 'mediafire'
  if (u.includes('mega.nz'))    return 'mega'
  if (u.includes('voe'))        return 'voe'
  if (u.includes('filemoon'))   return 'filemoon'
  if (u.includes('mp4upload'))  return 'mp4upload'
  if (u.includes('streamwish')) return 'streamwish'
  if (u.includes('streamtape')) return 'streamtape'
  if (u.includes('dood'))       return 'doodstream'
  if (u.includes('ok.ru'))      return 'okru'
  if (u.includes('vidhide'))    return 'vidhide'
  if (u.includes('mixdrop'))    return 'mixdrop'
  return 'embed'
}

// ─── Ordenar servidores ───────────────────────────────────────────────────────

const PREFS_EMBED = ['mp4upload', 'filemoon', 'streamwish', 'streamtape', 'doodstream', 'voe', 'vidhide', 'okru', 'mixdrop']

function ordenarServidores(srvs) {
  const mega      = srvs.filter(s => s.nombre === 'mega')
  const mediafire = srvs.filter(s => s.nombre === 'mediafire')
  const otros     = srvs.filter(s => s.directo && s.nombre !== 'mega' && s.nombre !== 'mediafire')
  const embeds    = [...srvs.filter(s => !s.directo)].sort((a, b) => {
    const ia = PREFS_EMBED.findIndex(p => a.nombre.includes(p) || a.url.includes(p))
    const ib = PREFS_EMBED.findIndex(p => b.nombre.includes(p) || b.url.includes(p))
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return [...mega, ...mediafire, ...otros, ...embeds]
}

// ─── Descarga desde Mega ──────────────────────────────────────────────────────

async function descargarMega(megaUrl, outputDir, fileName) {
  let url = megaUrl
  const m1 = megaUrl.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m1) url = `https://mega.nz/file/${m1[1]}#${m1[2]}`
  const m2 = megaUrl.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m2) url = `https://mega.nz/file/${m2[1]}#${m2[2]}`

  console.log(`[jk-dbs-notify] Mega → ${url.slice(0, 80)}`)

  const file = MegaFile.fromURL(url)
  await file.loadAttributes()

  const sizeMB     = (file.size / 1024 / 1024).toFixed(1)
  const totalMB    = sizeMB
  const destPath   = path.join(outputDir, fileName)
  const fileStream = file.download()

  console.log(`[jk-dbs-notify] Mega: ${file.name || fileName} (${sizeMB} MB)`)

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
    console.error(`\n[jk-dbs-notify] Mega stream error: ${err.message}`)
  })

  try {
    await pipeline(fileStream, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`Mega: fallo durante la escritura — ${err.message}`)
  }

  const finalMB = (downloaded / 1024 / 1024).toFixed(1)
  console.log(`\n[jk-dbs-notify] Mega ✅ ${fileName} (${finalMB} MB)`)
  return destPath
}

// ─── Descarga desde MediaFire ─────────────────────────────────────────────────

async function descargarMediaFire(mfUrl, outputDir, fileName) {
  console.log(`[jk-dbs-notify] MediaFire → obteniendo página: ${mfUrl}`)

  let mfPage
  try {
    const res = await axios.get(mfUrl, { headers: HEADERS, timeout: 12000 })
    mfPage = res.data
  } catch (err) {
    throw new Error(`MediaFire: error al obtener página — ${err.message}`)
  }

  const mfLink =
    mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
    mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1]              ||
    mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]

  if (!mfLink) {
    const snippet = typeof mfPage === 'string'
      ? mfPage.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 800)
      : String(mfPage).slice(0, 800)
    console.error(`[jk-dbs-notify] MediaFire: no encontré link de descarga directa.`)
    console.error(`[jk-dbs-notify] URL analizada: ${mfUrl}`)
    console.error(`[jk-dbs-notify] Snippet:\n${snippet}`)
    throw new Error('MediaFire: no encontré link de descarga directa')
  }

  console.log(`[jk-dbs-notify] MediaFire link directo → ${mfLink.slice(0, 100)}`)

  let mfRes
  try {
    mfRes = await axios.get(mfLink, {
      responseType: 'stream',
      headers     : { ...HEADERS, Referer: 'https://www.mediafire.com/' },
      timeout     : DL_TIMEOUT,
    })
  } catch (err) {
    throw new Error(`MediaFire: error al iniciar stream — ${err.message}`)
  }

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
      const speed = ((downloaded - lastBytes) / elapsed / 1024 / 1024).toFixed(1)
      const dlMB  = (downloaded / 1024 / 1024).toFixed(1)
      const pct   = totalBytes ? ((downloaded / totalBytes) * 100).toFixed(1) : '?'
      process.stdout.write(`\r[MF] ${pct}% | ${dlMB} MB / ${totalMB} MB | ${speed} MB/s   `)
      lastTime  = now
      lastBytes = downloaded
    }
  })

  mfRes.data.on('error', err => {
    console.error(`\n[jk-dbs-notify] MediaFire stream error: ${err.message}`)
  })

  try {
    await pipeline(mfRes.data, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`MediaFire: fallo durante la escritura — ${err.message}`)
  }

  const finalMB = (downloaded / 1024 / 1024).toFixed(1)
  console.log(`\n[jk-dbs-notify] MediaFire ✅ ${fileName} (${finalMB} MB)`)
  return destPath
}

// ─── Extractores de embed ─────────────────────────────────────────────────────

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

  if (u.includes('voe.sx') || u.match(/voe\d*\.sx/)) {
    try {
      const { data } = await axios.get(embedUrl.replace(/\/e\//, '/'), { headers: { ...HEADERS, Referer: embedUrl }, timeout: 15000 })
      const mHls = data.match(/["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
      if (mHls?.[1]) return mHls[1]
      const mAny = data.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/)
      if (mAny?.[1]) return mAny[1]
    } catch (_) {}
    return null
  }

  if (u.includes('filemoon') || u.includes('moonplayer')) {
    try {
      const { data } = await axios.get(embedUrl, { headers: { ...HEADERS, Referer: embedUrl }, timeout: 15000 })
      const packed   = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const unpacked = packed ? jsUnpack(packed[0]) : null
      return extraerUrlVideo(unpacked || data)
    } catch (_) {}
    return null
  }

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

  return null
}

// ─── Descarga con yt-dlp (embeds) ────────────────────────────────────────────

async function descargarEmbed(embedUrl, outputDir, fileName, referer = JKANIME_URL) {
  const u = embedUrl.toLowerCase()
  if (u.includes('hqq.tv') || u.includes('netu.tv') || u.includes('netu.ac') || u.includes('biribup.com'))
    throw new Error(`Servidor sin soporte: ${embedUrl.split('/')[2]}`)

  let videoUrl = embedUrl
  const resuelto = await resolverEmbed(embedUrl)
  if (resuelto) {
    console.log(`[jk-dbs-notify] Embed resuelto → ${resuelto.slice(0, 80)}`)
    videoUrl = resuelto
  } else {
    try {
      const { data } = await axios.get(embedUrl, { headers: { ...HEADERS, Referer: referer }, timeout: 12000 })
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
    '--add-header', `Referer: ${referer}/`,
    '-o', outTemplate,
    videoUrl,
  ]

  console.log(`[jk-dbs-notify] yt-dlp → ${videoUrl.slice(0, 100)}`)

  await new Promise((resolve, reject) => {
    const proc  = spawn('yt-dlp', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errBuf  = ''
    proc.stderr.on('data', d => { errBuf += d.toString() })
    proc.stdout.on('data', d => process.stdout.write(`[jk] ${d}`))
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
  const { titulo, epNum, epUrl, imgUrl, fuente = 'jkanime' } = ep
  const fileName = buildFileName(titulo, epNum)
  const tmpDir   = path.join(process.env.TMPDIR || '/tmp', `jk_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const bandera  = fuente === 'animedbs' ? '🌐' : '🇯🇵'
  const etiqueta = fuente === 'animedbs' ? 'AnimeDBS 🌐' : 'JKAnime 🇯🇵'
  const referer  = fuente === 'animedbs' ? ANIMEDBS_URL : JKANIME_URL
  console.log(`[jk-dbs-notify] Enviando [${fuente}]: ${fileName}`)

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
    const srvsBrutos = fuente === 'animedbs'
      ? await scrapeServidoresDBS(epUrl)
      : await scrapeServidoresJK(epUrl)

    if (!srvsBrutos.length) throw new Error('No se encontraron servidores de video')

    // 3. Esperar 15s antes de descargar
    console.log('[jk-dbs-notify] Esperando 15s antes de descargar...')
    await new Promise(r => setTimeout(r, 15_000))

    // 4. Descargar — orden de preferencia
    const orden = ordenarServidores(srvsBrutos).slice(0, 5)
    console.log(`[jk-dbs-notify] Orden [${fuente}]: ${orden.map(s => s.nombre).join(' → ')}`)

    let videoPath = null

    for (const srv of orden) {
      try {
        console.log(`[jk-dbs-notify] Intentando: ${srv.nombre} — ${srv.url.slice(0, 80)}`)

        if (srv.nombre === 'mega') {
          videoPath = await descargarMega(srv.url, tmpDir, fileName)
        } else if (srv.nombre === 'mediafire') {
          videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        } else {
          videoPath = await descargarEmbed(srv.url, tmpDir, fileName, referer)
        }

        break
      } catch (err) {
        console.error(`[jk-dbs-notify] ❌ ${srv.nombre} falló:`)
        console.error(err.stack || err.message)
        fs.readdirSync(tmpDir).forEach(f => {
          try { if (f !== 'cover.jpg') fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {}
        })
      }
    }

    if (!videoPath) throw new Error('Todos los servidores fallaron')

    // 5. Enviar como documento
    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
    await conn.sendMessage(chatId, {
      document : fs.readFileSync(videoPath),
      fileName,
      mimetype : 'video/mp4',
      caption  : `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${etiqueta}`,
    })

    console.log(`[jk-dbs-notify] ✅ ${fileName}`)

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

async function procesarCola() {
  if (global.jkQueueRunning) {
    console.log('[jk-dbs-notify] Cola ya está corriendo, ignorando llamada duplicada')
    return
  }
  if (!global.jkEpisodeQueue.length) return

  global.jkQueueRunning = true
  console.log(`[jk-dbs-notify] Cola iniciada — ${global.jkEpisodeQueue.length} episodio(s)`)

  const MAX_REINTENTOS   = 3
  const ESPERA_REINTENTO = 3 * 60_000
  const ESPERA_REQUEUEUE = 5 * 60_000

  try {
    while (global.jkEpisodeQueue.length > 0) {
      const item = global.jkEpisodeQueue[0]
      if (!item) { global.jkEpisodeQueue.shift(); continue }

      const { chatId, ep } = item
      let intentos = 0
      let exito    = false

      while (intentos < MAX_REINTENTOS && !exito) {
        intentos++
        const connActivo = global.jkConn
        if (!connActivo) {
          console.log('[jk-dbs-notify] ⚠️  Sin conn activo, esperando reconexión...')
          await new Promise(r => setTimeout(r, ESPERA_REINTENTO))
          continue
        }
        try {
          await enviarEpisodio(chatId, ep, connActivo)
          exito = true
          global.jkEpisodeQueue.shift()
          console.log(`[jk-dbs-notify] ✅ Cola: completado ${ep.titulo} ep ${zeroPad(ep.epNum)}`)
        } catch (err) {
          const esConexion = /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)
          console.error(`[jk-dbs-notify] ❌ Intento ${intentos}/${MAX_REINTENTOS}: ${err.message}`)
          if (err.stack) console.error(err.stack)

          if (esConexion && intentos < MAX_REINTENTOS) {
            const espera = ESPERA_REINTENTO * intentos
            console.log(`[jk-dbs-notify] ♻️  Esperando ${espera / 60000}min antes de reintentar...`)
            await new Promise(r => setTimeout(r, espera))
          } else if (esConexion) {
            global.jkEpisodeQueue.shift()
            global.jkEpisodeQueue.push({ chatId, ep })
            console.log(`[jk-dbs-notify] 🔁 Re-encolado: ${ep.titulo} ep ${zeroPad(ep.epNum)}`)
            await new Promise(r => setTimeout(r, ESPERA_REQUEUEUE))
            break
          } else {
            global.jkEpisodeQueue.shift()
            console.error(`[jk-dbs-notify] ❌ Cola error (no recuperable): ${err.message}`)
            try {
              const connErr = global.jkConn
              if (connErr) await connErr.sendMessage(chatId, {
                text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}`
              })
            } catch (_) {}
          }
        }
      }

      if (global.jkEpisodeQueue.length > 0) {
        console.log(`[jk-dbs-notify] Cola: ${global.jkEpisodeQueue.length} pendiente(s), esperando ${QUEUE_DELAY / 1000}s...`)
        await new Promise(r => setTimeout(r, QUEUE_DELAY))
      }
    }
  } catch (fatalErr) {
    console.error('[jk-dbs-notify] Error fatal en cola:', fatalErr.message)
    if (fatalErr.stack) console.error(fatalErr.stack)
  } finally {
    global.jkQueueRunning = false
    console.log('[jk-dbs-notify] Cola finalizada')
  }
}

// ─── Chequeo periódico ────────────────────────────────────────────────────────

async function checkNuevosEpisodios(chatId, conn) {
  console.log(`[jk-dbs-notify] Chequeando para ${chatId}...`)

  let lista = []

  // JKAnime (SUB japonés)
  try {
    const jk = await fetchLatestEpisodesJK()
    lista = lista.concat(jk)
  } catch (err) {
    console.error('[jk-dbs-notify] JKAnime fetch error:', err.message)
    if (err.stack) console.error(err.stack)
  }

  // AnimeDBS (SUB español)
  try {
    const dbs = await fetchLatestEpisodesDBS()
    lista = lista.concat(dbs)
  } catch (err) {
    console.error('[jk-dbs-notify] AnimeDBS fetch error:', err.message)
    if (err.stack) console.error(err.stack)
  }

  if (!lista.length) return

  const seen = loadSeen()
  if (!seen[chatId]) seen[chatId] = []
  const nuevos = lista.filter(e => !seen[chatId].includes(e.id))
  if (!nuevos.length) { console.log('[jk-dbs-notify] Sin novedades'); return }

  console.log(`[jk-dbs-notify] ${nuevos.length} nuevo(s):`, nuevos.map(e => e.id).join(', '))

  for (const ep of nuevos) seen[chatId].push(ep.id)
  if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
  saveSeen(seen)

  if (nuevos.length > 1) {
    try {
      await conn.sendMessage(chatId, {
        text:
          `📋 *${nuevos.length} episodios nuevos detectados*\n\n` +
          nuevos.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)} [${e.fuente === 'animedbs' ? 'AnimeDBS 🌐' : 'JKAnime 🇯🇵'}]`).join('\n') +
          `\n\n⏳ _Se enviarán de uno en uno..._`
      })
    } catch (_) {}
  }

  for (const ep of nuevos) global.jkEpisodeQueue.push({ chatId, ep })
  procesarCola().catch(err => {
    console.error('[jk-dbs-notify] cola error:', err.message)
    if (err.stack) console.error(err.stack)
  })
}

// ─── Notificador ─────────────────────────────────────────────────────────────

function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.jkConn = conn
  if (global.jkActiveChats.has(chatId)) clearInterval(global.jkActiveChats.get(chatId).timer)
  const timer = setInterval(() => {
    const c = global.jkConn
    if (!c) return
    checkNuevosEpisodios(chatId, c).catch(e => {
      console.error('[jk-dbs-notify] interval error:', e.message)
      if (e.stack) console.error(e.stack)
    })
  }, intervalMin * 60 * 1000)
  global.jkActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState()
  state[chatId] = { intervalMin, startedAt: Date.now() }
  saveState(state)
  console.log(`[jk-dbs-notify] Iniciado en ${chatId} cada ${intervalMin} min`)
}

function detenerNotificador(chatId) {
  const entry = global.jkActiveChats.get(chatId)
  if (entry) { clearInterval(entry.timer); global.jkActiveChats.delete(chatId) }
  const state = loadState()
  delete state[chatId]
  saveState(state)
}

function restaurarNotificadores(conn) {
  const state = loadState()
  for (const [chatId, cfg] of Object.entries(state)) {
    if (!global.jkActiveChats.has(chatId)) iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT)
  }
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

if (!global.jkWatchdog) {
  global.jkWatchdog = setInterval(() => {
    const conn = global.jkConn
    if (!conn) return
    const state = loadState()
    let restaurados = 0
    for (const [chatId, cfg] of Object.entries(state)) {
      if (!global.jkActiveChats.has(chatId)) {
        console.log('[jk-dbs-notify] 🔄 Watchdog restaurando: ' + chatId)
        iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT)
        restaurados++
      }
    }
    if (restaurados > 0) console.log('[jk-dbs-notify] Watchdog restauró ' + restaurados + ' chat(s)')
  }, 2 * 60 * 1000)
  console.log('[jk-dbs-notify] Watchdog iniciado')
}

// ─── Handler ──────────────────────────────────────────────────────────────────

let handler = async (m, { conn, text, usedPrefix, command }) => {

  if (conn) global.jkConn = conn
  restaurarNotificadores(conn)

  // ── .jkstart ────────────────────────────────────────────────────────────────
  if (command === 'jkstart') {
    const min = parseInt(text?.trim())
    const intervalMin = (!isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, {
      text:
        `✅ *Notificador JKAnime + AnimeDBS activado*\n\n` +
        `╭━━━━━━〔 📡 〕━━━━━━\n` +
        `┃ ⏱️ Intervalo: *${intervalMin} min*\n` +
        `┃ 🇯🇵 JKAnime — Sub japonés\n` +
        `┃ 🌐 AnimeDBS — Sub español\n` +
        `┃ 💬 Chat registrado\n` +
        `╰━━━━━━━━━━━━━━━━━━\n\n` +
        `_Usa ${usedPrefix}jkstop para detener._`
    }, { quoted: m })
    try {
      const jk  = await fetchLatestEpisodesJK()
      const dbs = await fetchLatestEpisodesDBS()
      const lista = [...jk, ...dbs]
      const seen  = loadSeen()
      if (!seen[m.chat]) seen[m.chat] = []
      for (const ep of lista) { if (!seen[m.chat].includes(ep.id)) seen[m.chat].push(ep.id) }
      if (seen[m.chat].length > 500) seen[m.chat] = seen[m.chat].slice(-500)
      saveSeen(seen)
      await conn.sendMessage(m.chat, {
        text: `📋 *${jk.length}* ep JKAnime + *${dbs.length}* ep AnimeDBS registrados como base.\n_Solo los nuevos se enviarán._`
      }, { quoted: m })
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `⚠️ Chequeo inicial falló: ${err.message}` }, { quoted: m })
    }
    return
  }

  // ── .jkstop ─────────────────────────────────────────────────────────────────
  if (command === 'jkstop') {
    if (!global.jkActiveChats.has(m.chat)) return m.reply(`ℹ️ El notificador no estaba activo.`)
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}jkstart para reactivar._`)
  }

  // ── .jkstatus ───────────────────────────────────────────────────────────────
  if (command === 'jkstatus') {
    const activo = global.jkActiveChats.has(m.chat)
    const entry  = global.jkActiveChats.get(m.chat)
    const cola   = global.jkEpisodeQueue.filter(i => i.chatId === m.chat)
    const vistos = (loadSeen()[m.chat] || []).length
    let txt = `📡 *Estado JKAnime + AnimeDBS*\n\n`
    txt += activo ? `✅ *Activo* — cada ${entry.intervalMin} min\n` : `🔴 *Inactivo*\n`
    txt += `📋 Cola: *${cola.length}* pendiente(s)\n`
    txt += `🔵 Procesando: *${global.jkQueueRunning ? 'Sí' : 'No'}*\n`
    txt += `👁️ Vistos: *${vistos}*`
    if (cola.length > 0)
      txt += `\n\n*En cola:*\n` + cola.slice(0, 5).map((i, n) =>
        `  ${n + 1}. ${i.ep.titulo} ep ${zeroPad(i.ep.epNum)} [${i.ep.fuente === 'animedbs' ? '🌐' : '🇯🇵'}]`
      ).join('\n')
    return m.reply(txt)
  }

  // ── .jkqueue ────────────────────────────────────────────────────────────────
  if (command === 'jkqueue') {
    if (!global.jkEpisodeQueue.length) return m.reply(`✅ Cola vacía.`)
    return m.reply(
      `📋 *Cola (${global.jkEpisodeQueue.length}):*\n\n` +
      global.jkEpisodeQueue.map((i, n) =>
        `${n + 1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} [${i.ep.fuente === 'animedbs' ? '🌐' : '🇯🇵'}] ${i.chatId === m.chat ? '← este chat' : ''}`
      ).join('\n')
    )
  }

  // ── .jkflush ────────────────────────────────────────────────────────────────
  if (command === 'jkflush') {
    const antes = global.jkEpisodeQueue.length
    global.jkEpisodeQueue = global.jkEpisodeQueue.filter(i => i.chatId !== m.chat)
    return m.reply(`🗑️ *${antes - global.jkEpisodeQueue.length}* episodio(s) eliminado(s).`)
  }

  // ── .jkunblock ──────────────────────────────────────────────────────────────
  if (command === 'jkunblock') {
    const estaba = global.jkQueueRunning
    global.jkQueueRunning = false
    if (global.jkEpisodeQueue.length > 0) {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.jkEpisodeQueue.length} episodio(s)...`)
      procesarCola().catch(e => console.error('[jk-dbs-notify] cola error:', e.message))
    } else {
      await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\nℹ️ No hay episodios pendientes.`)
    }
    return
  }

  // ── .jkcheck ────────────────────────────────────────────────────────────────
  if (command === 'jkcheck') {
    await m.reply(`🔍 Chequeando JKAnime + AnimeDBS...`)
    try {
      await checkNuevosEpisodios(m.chat, conn)
      if (!global.jkEpisodeQueue.some(i => i.chatId === m.chat)) await m.reply(`✅ Sin episodios nuevos.`)
    } catch (err) { await m.reply(`❌ Error: ${err.message}`) }
    return
  }

  // ── .jkinterval ─────────────────────────────────────────────────────────────
  if (command === 'jkinterval') {
    const min = parseInt(text?.trim())
    if (isNaN(min) || min < 5 || min > 60) return m.reply(`❌ Número entre *5* y *60*.\nEj: *${usedPrefix}jkinterval 15*`)
    if (!global.jkActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}jkstart* primero.`)
    iniciarNotificador(m.chat, conn, min)
    return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`)
  }

  // ── .jkexample [N] — prueba con los N episodios más recientes de JKAnime ────
  if (command === 'jkexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *JKAnime*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodesJK()
      if (!lista.length) return m.reply(`❌ Sin episodios de JKAnime disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error al obtener episodios: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(
        `📋 *${seleccion.length} episodios seleccionados (JKAnime 🇯🇵):*\n\n` +
        seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
        `\n\n⏳ _Se enviarán de uno en uno..._`
      )
    }
    for (const ep of seleccion) global.jkEpisodeQueue.push({ chatId: m.chat, ep })
    procesarCola().catch(e => console.error('[jk-dbs-notify] cola error:', e.message))
    return
  }

  // ── .dbsexample [N] — prueba con los N episodios más recientes de AnimeDBS ──
  if (command === 'dbsexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *AnimeDBS*...`)

    let lista = []
    try {
      lista = await fetchLatestEpisodesDBS()
      if (!lista.length) return m.reply(`❌ Sin episodios de AnimeDBS disponibles. Intenta más tarde.`)
    } catch (err) { return m.reply(`❌ Error al obtener episodios: ${err.message}`) }

    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply(
        `📋 *${seleccion.length} episodios seleccionados (AnimeDBS 🌐):*\n\n` +
        seleccion.map((e, i) => `${i + 1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') +
        `\n\n⏳ _Se enviarán de uno en uno..._`
      )
    }
    for (const ep of seleccion) global.jkEpisodeQueue.push({ chatId: m.chat, ep })
    procesarCola().catch(e => console.error('[jk-dbs-notify] cola error:', e.message))
    return
  }
}

handler.command = /^(jkstart|jkstop|jkstatus|jkcheck|jkqueue|jkflush|jkunblock|jkinterval|jkexample|dbsexample)$/i
handler.tags    = ['anime', 'notificaciones']
handler.help    = ['jkstart', 'jkstop', 'jkstatus', 'jkcheck', 'jkqueue', 'jkflush', 'jkunblock', 'jkinterval <min>', 'jkexample [N]', 'dbsexample [N]']
handler.exp     = 0
handler.level   = 0
handler.limit   = false

handler.before = async (m, { conn }) => {
  if (conn) global.jkConn = conn
  restaurarNotificadores(conn)
}

export default handler
