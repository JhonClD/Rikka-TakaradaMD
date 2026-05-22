import { spawn }         from 'child_process'
import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import fs                from 'fs'
import path              from 'path'
import fetch             from 'node-fetch'
import * as cheerio      from 'cheerio'
let _puppeteerExtra = null
import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import { pipeline }      from 'stream/promises'
import https             from 'https'
import vm                from 'vm'

export async function getPuppeteer() {
  if (!_puppeteerExtra) {
    const { default: pe }      = await import('puppeteer-extra')
    const { default: Stealth } = await import('puppeteer-extra-plugin-stealth')
    pe.use(Stealth())
    _puppeteerExtra = pe
  }
  return _puppeteerExtra
}

export const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 20 })

global.activeDownloads    = global.activeDownloads    || new Map()
global.pendingServerPicks = global.pendingServerPicks || new Map()
global.animeDlSessions    = global.animeDlSessions    || {}
global.pendingAnimeSearch = global.pendingAnimeSearch || new Map()

const PICKS_FILE = path.join(process.cwd(), '.anime_dl_picks.json')

export function guardarPicks() {
  try {
    const serializable = {}
    for (const [chatId, pick] of global.pendingServerPicks.entries()) {
      serializable[chatId] = {
        servers      : pick.servers,
        tmpDir       : pick.tmpDir,
        sitioId      : pick.sitioElegido?.id ?? null,
        argsParaAnime: pick.argsParaAnime,
        nombre       : pick.nombre ?? null,
        episodio     : pick.episodio ?? null,
        temporada    : pick.temporada ?? 1,
        timestamp    : pick.timestamp,
      }
    }
    fs.writeFileSync(PICKS_FILE, JSON.stringify(serializable, null, 2), 'utf-8')
  } catch (e) { console.error('[picks] Error al guardar:', e.message) }
}

export function cargarPicks() {
  try {
    if (!fs.existsSync(PICKS_FILE)) return
    const data = JSON.parse(fs.readFileSync(PICKS_FILE, 'utf-8'))
    const ahora = Date.now()
    for (const [chatId, p] of Object.entries(data)) {
      if (ahora - p.timestamp > 10 * 60 * 1000) continue
      if (!fs.existsSync(p.tmpDir)) {
        try { fs.mkdirSync(p.tmpDir, { recursive: true }) } catch (_) {}
      }
      global.pendingServerPicks.set(chatId, {
        servers      : p.servers,
        tmpDir       : p.tmpDir,
        sitioElegido : getSitioPorId(p.sitioId),
        argsParaAnime: p.argsParaAnime,
        nombre       : p.nombre ?? null,
        episodio     : p.episodio ?? null,
        temporada    : p.temporada ?? 1,
        timestamp    : p.timestamp,
      })
    }
    if (global.pendingServerPicks.size > 0)
      console.log(`[picks] Restaurados ${global.pendingServerPicks.size} pick(s) pendientes`)
  } catch (e) { console.error('[picks] Error al cargar:', e.message) }
}

export const SITIOS = [
  {
    id: 1, nombre: 'AnimeFLV',    dominio: 'animeflv',
    url: 'https://www3.animeflv.net',
    buscar: buscarEnAnimeFLV,    scrape: scrapeAnimeFLV,
  },
  {
    id: 2, nombre: 'MonosChinos', dominio: 'monoschinos2',
    url: 'https://monoschinos2.com',
    buscar: buscarEnMonosChinos, scrape: scrapeMonosChinos,
  },
  {
    id: 3, nombre: 'LatAnime',    dominio: 'latanime',
    url: 'https://latanime.org',
    buscar: buscarEnLatAnime,    scrape: scrapeLatAnime,
  },
  {
    id: 4, nombre: 'JKanime',     dominio: 'jkanime',
    url: 'https://jkanime.net',
    buscar: buscarEnJKanime,     scrape: scrapeJKanime,
  },
]

export function getSitioPorId(id)       { return SITIOS.find(s => s.id === Number(id)) || null }
export function getSitioPorDominio(url) { return SITIOS.find(s => url.includes(s.dominio)) || null }

export const MEGA_ERRORS = {
  EOVERQUOTA: '⚠️ Mega superó su límite de transferencia. Intenta más tarde.',
  ENOENT:     '❌ El archivo de Mega no existe o fue eliminado.',
  ETOOMANY:   '⚠️ Demasiadas solicitudes a Mega. Espera unos minutos.',
  EACCESS:    '❌ Sin acceso al archivo. Puede ser privado o el enlace es inválido.',
  EBLOCKED:   '❌ Cuenta/archivo bloqueado en Mega.',
}

export function parseMegaError(err) {
  const msg = err?.message || String(err)
  for (const [code, text] of Object.entries(MEGA_ERRORS)) {
    if (msg.includes(code) || msg.includes(code.toLowerCase())) return text
  }
  if (msg.includes('-18')) return MEGA_ERRORS.EOVERQUOTA
  if (msg.includes('-9'))  return MEGA_ERRORS.ENOENT
  if (msg.includes('-4'))  return MEGA_ERRORS.ETOOMANY
  return `❌ Error Mega: ${msg}`
}

export async function mediafireDl(url) {
  const { default: axios } = await import('axios')
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, httpsAgent })
  const $ = cheerio.load(res.data)
  const link =
    $('#downloadButton').attr('href') ||
    res.data.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/)?.[1]
  const name =
    $('.promoDownloadName').first().attr('title') ||
    $('.filename').first().text().trim() ||
    url.split('/').pop().split('?')[0] || 'archivo'
  return { name: name.replace(/\s+/g, ' ').trim(), link: link || null }
}

export const CONFIG = {
  downloadTimeout: 3 * 60 * 60 * 1000,
  puppeteerTimeout: 30_000,
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  ],
  baseHeaders: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Connection': 'keep-alive',
  },
  
  servidoresConocidos: [
    'mega', 'mediafire', 'mp4upload', 'filemoon', 'streamwish', 'wishembed',
    'doodstream', 'dood', 'streamtape', 'okru', 'voe', 'upstream',
    'yourupload', 'vidmoly', 'uqload', 'savefiles', 'gofile', 'byse',
    'dsvplay', 'lulu', 'vidhide', 'mixdrop', 'pixeldrain', 'pdrain',
    'jkvideo', 'sw', 'stape', 'fembed', 'upnshare', 'uns.bio',
  ],
  servidoresPreferidos: [
    'mp4upload', 'filemoon', 'streamwish', 'wishembed',
    'doodstream', 'streamtape', 'okru', 'voe', 'upstream',
    'yourupload', 'vidmoly', 'uqload',
    'savefiles', 'gofile', 'byse', 'dsvplay', 'lulu', 'streamtape', 'vidhide', 'mixdrop',
  ],
  videoExtensions: /\.(mp4|mkv|webm|m3u8|ts)(\?|$)/i,
}

export const randomUA     = () => CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)]
export const buildHeaders = (extra = {}) => ({ ...CONFIG.baseHeaders, 'User-Agent': randomUA(), ...extra })

export function esServidorConocido(nombre, url) {
  const src = `${nombre || ''} ${url || ''}`.toLowerCase()
  return CONFIG.servidoresConocidos.some(sv => src.includes(sv))
}

export function normalizarMegaUrl(u) {
  if (!u || !u.includes('mega.nz')) return u
  let m = u.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m) return `https://mega.nz/file/${m[1]}#${m[2]}`
  if (u.includes('/file/') && u.includes('#')) return u
  m = u.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m) return `https://mega.nz/file/${m[1]}#${m[2]}`
  return u
}

export const numToLetter  = (i) => String.fromCharCode(97 + (i % 26))
export const zeroPad      = (n) => String(n).padStart(2, '0')
export const safeFile     = (s) => s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
export const buildFileName = (titulo, epNum, temporada = 1) => {
  const season = temporada > 1 ? ` T${temporada}` : ''
  return `${zeroPad(epNum)} ${safeFile(titulo)}${season}.mp4`
}

export function detectarServidorConocido(nombre, url = '') {
  const src = `${nombre || ''} ${url || ''}`.toLowerCase()
  for (const sv of CONFIG.servidoresConocidos) {
    if (src.includes(sv)) return sv
  }
  
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    for (const sv of CONFIG.servidoresConocidos) {
      if (host.includes(sv)) return sv
    }
    
    const hostBase = host.split('.')[0]
    if (hostBase.length > 2) return hostBase
  } catch (_) {}
  return null
}

export function detectarServidor(url) {
  for (const s of CONFIG.servidoresPreferidos) {
    if (url.includes(s)) return s
  }
  
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host.split('.')[0] || 'generico'
  } catch (_) {}
  return 'generico'
}

export function elegirMejorServidor(servidores) {
  for (const preferido of CONFIG.servidoresPreferidos) {
    const match = servidores.find(s =>
      s.nombre?.includes(preferido) || s.url?.includes(preferido)
    )
    if (match) return match
  }
  return servidores[0] || null
}

function extractBalancedSection(text, startIndex, openChar, closeChar) {
  let depth = 0
  let activeQuote = ''
  let escaped = false
  for (let i = startIndex; i < text.length; i++) {
    const c = text[i]
    if (activeQuote) {
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === activeQuote) activeQuote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { activeQuote = c; continue }
    if (c === openChar) depth++
    if (c === closeChar) {
      depth--
      if (depth === 0) return text.slice(startIndex, i + 1)
    }
  }
  return null
}

function extractVarLiteral(html, varName) {
  const marker = `var ${varName}`
  const startIndex = html.indexOf(marker)
  if (startIndex === -1) return null
  const equalsIndex = html.indexOf('=', startIndex)
  if (equalsIndex === -1) return null
  const slice = html.slice(equalsIndex + 1)
  const firstBracketIndex = slice.search(/[\[{]/)
  if (firstBracketIndex === -1) return null
  const openChar  = slice[firstBracketIndex]
  const closeChar = openChar === '{' ? '}' : ']'
  return extractBalancedSection(slice, firstBracketIndex, openChar, closeChar)
}

function safeEvaluate(expression) {
  try {
    const ctx = Object.create(null)
    return vm.runInNewContext(expression, ctx, { timeout: 1000, displayErrors: false })
  } catch (_) { return null }
}

function decodeBase64Jk(value) {
  if (!value || typeof value !== 'string') return null
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8').trim()
    if (decoded.startsWith('http')) return decoded
    return null
  } catch (_) { return null }
}

function extractVideoIframeUrls(html) {
  const urls = []
  const re = /video\[\d+\]\s*=\s*(['"])([\s\S]*?)\1/g
  let match
  while ((match = re.exec(html))) {
    const fragment = match[2]
    const srcMatch = fragment.match(/src=['"]([^'"]+)['"]/i)
    if (srcMatch?.[1]) urls.push(srcMatch[1])
  }
  return urls
}

export async function enviarListaWA(conn, m, { title, body = '', footer, buttonText = 'SELECCIONAR', sections }) {
  const device   = getDevice(m.key.id)
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile) {
    try {
      const interactiveMessage = {
        body  : { text: body },
        footer: { text: footer || global.wm || 'Kana Arima Bot' },
        header: { title, hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({ title: buttonText, sections }),
          }],
          messageParamsJson: '',
        },
      }
      const msg = generateWAMessageFromContent(
        m.chat,
        { viewOnceMessage: { message: { interactiveMessage } } },
        { userJid: conn.user.jid, quoted: m }
      )
      await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id })
      return true
    } catch (err) {
      console.error('[enviarListaWA interactiveMsg]', err.message)
    }
  }

  let idx = 0
  const lineas = sections.flatMap(sec => {
    const cabecera = sec.title ? [`\n*${sec.title}*`] : []
    const filas    = sec.rows.map(row => {
      const letra = numToLetter(idx++)
      return `*${letra}.* ${row.title}${row.description ? `  —  _${row.description}_` : ''}`
    })
    return [...cabecera, ...filas]
  })
  await m.reply(
    `*${title}*${body ? '\n' + body : ''}\n\n` +
    lineas.join('\n') +
    `\n\n_Responde con la letra correspondiente_`
  )
  return false
}

export async function buscarResultadosAnimeFLV(nombre, temporada = 1) {
  const query = temporada > 1 ? `${nombre} ${temporada}` : nombre
  try {
    const html = await fetchHtml(`https://www3.animeflv.net/browse?q=${encodeURIComponent(query)}`)
    const $    = cheerio.load(html)
    const resultados = []
    $('ul.ListAnimes li, ul li article.Anime').each((_, el) => {
      const $el   = $(el)
      const aTag  = $el.find('a').first()
      const href  = aTag.attr('href') || ''
      const title = ($el.find('h3').text() || aTag.attr('title') || aTag.text() || '').trim()
      if (href.startsWith('/anime/')) {
        const slug = href.replace('/anime/', '').replace(/\/$/, '')
        resultados.push({
          title,
          slug,
          url  : `https://www3.animeflv.net${href}`,
          sitio: SITIOS.find(s => s.dominio === 'animeflv'),
        })
      }
    })
    return resultados
  } catch (e) {
    console.error('[buscarResultadosAnimeFLV]', e.message)
    return []
  }
}

export async function scrapeInfoAnimeFLV(animeUrl) {
  try {
    const html = await fetchHtml(animeUrl)
    const $    = cheerio.load(html)

    const title = $('h1.Title, h2.Title, .Title').first().text().trim()

    const description =
      $('div.Description p').first().text().trim() ||
      $('div.sinopsis p').first().text().trim()    ||
      $('p.synopsis').first().text().trim()        || ''

    const genres = []
    $('nav.Nvg a, a[href*="/browse?genre="]').each((_, el) => {
      const g = $(el).text().trim()
      if (g && !genres.includes(g)) genres.push(g)
    })

    const audioTags = []
    $('span.Type, .badge, .label, a[href*="sub-espanol"], a[href*="latino"], a[href*="doblado"]').each((_, el) => {
      const txt = $(el).text().trim().toLowerCase()
      if (/sub.?espa|latino|doblado|castellano/.test(txt) && !audioTags.includes(txt))
        audioTags.push($(el).text().trim())
    })
    if (audioTags.length === 0) {
      if (/latino/.test(animeUrl))    audioTags.push('Latino')
      if (/sub-espa/.test(animeUrl))  audioTags.push('Sub Español')
      if (/doblado/.test(animeUrl))   audioTags.push('Doblado')
    }

    const coverUrl =
      $('div.AnimeCover img, .cover img, figure.Bg img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') || null

    let episodes = []
    $('script').each((_, el) => {
      const src = $(el).html() || ''
      const m2  = src.match(/var\s+episodes\s*=\s*(\[\[[\s\S]*?\]\])\s*[,;]/)
      if (m2) {
        try {
          episodes = JSON.parse(m2[1]).map(e => e[0]).sort((a, b) => a - b)
        } catch (_) {}
      }
    })

    const slugMatch = animeUrl.match(/\/anime\/([^/?#]+)/)
    const slug = slugMatch?.[1] || ''

    return { title, description, genres, coverUrl, slug, episodes, audioTags }
  } catch (e) {
    console.error('[scrapeInfoAnimeFLV]', e.message)
    return null
  }
}

export async function mostrarInfoYEpisodios({ url, slug: inputSlug, title: inputTitle }, m, conn, usedPrefix, temporada = 1, statusKey = null) {
  const updateStatus = async (txt) => {
    try {
      if (statusKey) {
        await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
      } else {
        const sent = await m.reply(txt)
        statusKey  = sent?.key ?? null
      }
    } catch (_) {
      try {
        const sent = await m.reply(txt)
        statusKey  = sent?.key ?? null
      } catch (_) {}
    }
  }

  await updateStatus(`📡 Obteniendo datos de *${inputTitle || inputSlug}*...`)

  const info = await scrapeInfoAnimeFLV(url)
  if (!info || info.episodes.length === 0) {
    return updateStatus(
      `❌ No pude obtener los episodios.\n` +
      `Prueba con el número directamente:\n  ${usedPrefix}animedl ${inputTitle || inputSlug} 1`
    )
  }

  const slug = info.slug || inputSlug || ''

  const titulo = (info.title && !/iniciar.?ses|login|register|acceder/i.test(info.title))
    ? info.title
    : (inputTitle || slug)

  const generosTxt = info.genres.length    ? info.genres.join(', ')    : 'No disponible'
  const audioTxt   = info.audioTags.length ? info.audioTags.join(' · ') : null
  const descTxt    = info.description.length > 280
    ? info.description.slice(0, 280).trimEnd() + '…'
    : info.description || 'Sin descripción disponible.'

  const caption =
    `*🎌 ${titulo}*\n\n` +
    `📖 *Descripción:*\n${descTxt}\n\n` +
    `🏷️ *Géneros:* ${generosTxt}\n` +
    (audioTxt ? `🎙️ *Audio:* ${audioTxt}\n` : '') +
    `📺 *Episodios disponibles:* ${info.episodes.length}`

  if (info.coverUrl) {
    try {
      await conn.sendMessage(m.chat, {
        image  : { url: info.coverUrl },
        caption,
      }, { quoted: m })
      await updateStatus(`✅ *${titulo}* · ${info.episodes.length} episodios disponibles`)
    } catch (imgErr) {
      console.error('[mostrarInfoYEpisodios] imagen:', imgErr.message)
      await updateStatus(caption)
    }
  } else {
    await updateStatus(caption)
  }

  const sitioId = SITIOS.find(s => s.dominio === 'animeflv')?.id ?? 1
  const epSlice = info.episodes.slice(-26)

  await enviarListaWA(conn, m, {
    title     : `📋 Episodios — ${titulo}`,
    body      : `${info.episodes.length > 26 ? `Últimos ${epSlice.length} de ${info.episodes.length} episodios.` : ''}\nElige el episodio a descargar:`,
    buttonText: 'VER EPISODIOS',
    sections  : [{
      title: 'Episodios disponibles',
      rows : epSlice.map(ep => ({
        title      : `Episodio ${ep}`,
        description: '',
        id         : `${usedPrefix}animedl ${sitioId} ${slug} ${ep}`,
      })),
    }],
  })
}

export function normalizarTitulo(t = '') {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function puntuarMatch(titulo, query) {
  const t = normalizarTitulo(titulo)
  const q = normalizarTitulo(query)
  if (t === q) return 100
  if (t.startsWith(q)) return 90
  if (t.includes(q)) return 70
  const palabrasQ = q.split(' ')
  const matches = palabrasQ.filter(p => p.length > 2 && t.includes(p))
  return Math.round((matches.length / palabrasQ.length) * 60)
}

export function mejorMatch(links, query) {
  if (!links.length) return null
  return links
    .map(l => ({ ...l, score: puntuarMatch(l.title || l.href, query) }))
    .sort((a, b) => b.score - a.score)[0]
}

export function elegirPorTemporada(links, temporada) {
  if (!links?.length) return null
  if (temporada <= 1) return links[0]
  const keywords = [
    `temporada-${temporada}`, `temporada ${temporada}`,
    `season-${temporada}`,    `season ${temporada}`,
    `parte-${temporada}`,     `parte ${temporada}`,
    `part-${temporada}`,      `part ${temporada}`,
    `-${temporada}nd-`, `-${temporada}rd-`, `-${temporada}th-`,
  ]
  return (
    links.find(r => keywords.some(kw =>
      (r.title || '').includes(kw) || (r.href || r.url || '').includes(kw)
    )) || links[0]
  )
}

export async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: buildHeaders({ Referer: new URL(url).origin }),
      timeout: 15000,
    })
    const html = await res.text()
    const necesitaDinamico =
      html.length < 5000 ||
      /<div id="app"|ng-app|window\.__INITIAL_STATE__|_next\/static/.test(html) ||
      html.includes('challenge-platform') ||
      html.includes('cf-browser-verification') ||
      html.includes('Just a moment')
    if (necesitaDinamico) return await fetchHtmlConPuppeteer(url)
    return html
  } catch (_) {
    return await fetchHtmlConPuppeteer(url)
  }
}

export async function fetchHtmlConPuppeteer(url) {
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
  ].filter(Boolean)

  let execPath = null
  for (const p of chromiumPaths) {
    if (fs.existsSync(p)) { execPath = p; break }
  }

  if (!execPath) {
    console.error('[puppeteer] Chromium no encontrado en paths conocidos')
    throw new Error('Chromium no disponible')
  }

  let capturedVideoUrl = null
  const browser = await (await getPuppeteer()).launch({
    headless: 'new',
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(randomUA())
  await page.setExtraHTTPHeaders(CONFIG.baseHeaders)
  page.on('response', (response) => {
    const resUrl = response.url()
    if (CONFIG.videoExtensions.test(resUrl) && !capturedVideoUrl) capturedVideoUrl = resUrl
  })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.puppeteerTimeout })
    let tries = 0
    let bodyText = await page.evaluate(() => document.body?.innerText || '')
    while (
      (bodyText.includes('challenge-platform') || bodyText.includes('Checking your browser') || bodyText.includes('Just a moment')) &&
      tries < 10
    ) {
      await new Promise(r => setTimeout(r, 3000))
      bodyText = await page.evaluate(() => document.body?.innerText || '')
      tries++
    }
    await new Promise(r => setTimeout(r, 3000))
    if (url.includes('latanime.org') || url.includes('monoschinos')) {
      try { await page.waitForSelector('[data-player], [data-url], iframe[src]', { timeout: 8000 }) } catch (_) {}
    }
    const html = await page.content()
    await browser.close()
    if (capturedVideoUrl) return html + `\n<!-- INTERCEPTED_VIDEO:${capturedVideoUrl} -->`
    return html
  } catch (err) {
    await browser.close()
    throw err
  }
}

export async function fetchHtmlDirecto(url, referer) {
  try {
    const res = await fetch(url, {
      headers: buildHeaders({
        Referer: referer || (url ? (() => { try { return new URL(url).origin } catch (_) { return '' } })() : ''),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      }),
      timeout: 20000,
    })
    if (!res.ok) return ''
    return await res.text()
  } catch (e) {
    console.error('[fetchHtmlDirecto]', e.message)
    return ''
  }
}

export function jsUnpack(packed) {
  try {
    const m = packed.match(/}\s*\('(.*)',\s*(.*?),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/)
    if (!m) return null
    const payload = m[1].replace(/\\'/g, "'")
    const radix   = parseInt(m[2]) || 36
    const symtab  = m[4].split('|')
    if (symtab.length !== parseInt(m[3])) return null
    return payload.replace(/\b[a-zA-Z0-9_]+\b/g, word => {
      const idx = parseInt(word, radix)
      return (symtab[idx] && symtab[idx] !== '') ? symtab[idx] : word
    })
  } catch (_) { return null }
}

export function extraerUrlDeVideo(code) {
  const patrones = [
    /sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)['"]/i,
    /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)['"]/i,
    /["']([^"']+\.m3u8[^"']*)['"]/i,
    /source\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)['"]/i,
    /videoUrl\s*[=:]\s*["']([^"']+)['"]/i,
    /player\.src\("([^"]+)"/,
    /player\.src\([^)]*src\s*:\s*"([^"]+)"/,
  ]
  for (const re of patrones) {
    const m = code.match(re)
    if (m?.[1]?.startsWith('http')) return m[1]
  }
  return null
}

export function embedHeaders(referer, extra = {}) {
  return {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer'        : referer,
    'Origin'         : new URL(referer).origin,
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest' : 'iframe',
    'Sec-Fetch-Mode' : 'navigate',
    'Sec-Fetch-Site' : 'cross-site',
    ...extra,
  }
}

export async function extractFilemoon(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    let   html = await res.text()
    const iframeSrc = html.match(/<iframe[^>]+src=["']([^"']+filemoon[^"']+)['"]/i)?.[1]
    if (iframeSrc) {
      const res2 = await fetch(iframeSrc, { headers: embedHeaders(embedUrl), timeout: 15000 })
      html = await res2.text()
    }
    const packed   = html.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    const unpacked = packed ? jsUnpack(packed[0]) : null
    const src = extraerUrlDeVideo(unpacked || html)
    if (src) return src
  } catch (e) { console.error('[filemoon]', e.message) }
  return null
}

export async function extractMp4Upload(embedUrl) {
  try {
    const idMatch = embedUrl.match(/mp4upload\.com\/(?:embed-)?([A-Za-z0-9]+)/)
    const url = idMatch
      ? `https://www.mp4upload.com/embed-${idMatch[1]}.html`
      : embedUrl
    const res  = await fetch(url, { headers: embedHeaders('https://www.mp4upload.com/'), timeout: 15000 })
    const text = await res.text()
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    const code   = packed ? jsUnpack(packed[0]) : text
    const m1 = (code || text).match(/player\.src\("([^"]+)"/)
    if (m1?.[1]) return m1[1]
    const m2 = (code || text).match(/player\.src\([^)]*src\s*:\s*"([^"]+)"/)
    if (m2?.[1]) return m2[1]
    return extraerUrlDeVideo(code || text)
  } catch (e) { console.error('[mp4upload]', e.message) }
  return null
}

export async function extractDoodStream(embedUrl) {
  try {
    const url   = embedUrl.replace(/\/(d|watch)\//, '/e/')
    const res   = await fetch(url, { headers: embedHeaders('https://dood.wf/'), timeout: 15000 })
    const text  = await res.text()
    const host  = new URL(res.url).origin
    const pass  = text.match(/\/pass_md5\/[^'"<\s]*/)?.[0]
    if (!pass) return null
    const token = pass.split('/').pop()
    const r2    = await fetch(host + pass, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 })
    const base  = await r2.text()
    const rand  = Array.from({ length: 10 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('')
    return `${base}${rand}?token=${token}&expiry=${Date.now()}`
  } catch (e) { console.error('[doodstream]', e.message) }
  return null
}

export async function extractStreamWish(embedUrl) {
  const norm = embedUrl.replace(/\/(f|e)\//, '/')

  try {
    const res  = await fetch(norm, {
      headers: {
        ...embedHeaders(embedUrl),
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site' : 'none',
        'Cache-Control'  : 'no-cache',
      },
      timeout: 15000,
    })
    const text = await res.text()
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    if (packed) {
      const code = jsUnpack(packed[0])
      if (code) {
        const src = extraerUrlDeVideo(code)
        if (src) return src
      }
    }
    for (const re of [
      /atob\(["']([A-Za-z0-9+/=]{60,})["']\)/,
      /window\.\w+\s*=\s*["']([A-Za-z0-9+/=]{60,})["']/,
      /["']([A-Za-z0-9+/=]{100,})["']\s*[;,]/,
    ]) {
      const m = text.match(re)
      if (m) {
        try {
          const decoded = Buffer.from(m[1], 'base64').toString('utf-8')
          const src = extraerUrlDeVideo(decoded)
          if (src) return src
        } catch (_) {}
      }
    }
    const src = extraerUrlDeVideo(text)
    if (src) return src
  } catch (e) { console.error('[streamwish] fetch error:', e.message) }

  try {
    const chromiumPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable', '/usr/local/bin/chromium',
      '/data/data/com.termux/files/usr/bin/chromium-browser',
      '/data/data/com.termux/files/usr/bin/chromium',
    ].filter(Boolean)
    let execPath = null
    for (const p of chromiumPaths) { if (fs.existsSync(p)) { execPath = p; break } }
    if (!execPath) return null

    let capturedUrl = null
    const browser = await (await getPuppeteer()).launch({
      headless: 'new', executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setUserAgent(randomUA())
    await page.setExtraHTTPHeaders({ Referer: embedUrl })
    page.on('response', async (response) => {
      const url = response.url()
      if (!capturedUrl && /\.m3u8/.test(url)) capturedUrl = url
    })
    try { await page.goto(norm, { waitUntil: 'networkidle2', timeout: 25000 }) } catch (_) {}
    for (let i = 0; i < 16 && !capturedUrl; i++) await new Promise(r => setTimeout(r, 500))
    await browser.close()
    if (capturedUrl) return capturedUrl
  } catch (e) { console.error('[streamwish] puppeteer error:', e.message) }
  return null
}

export async function extractStreamtape(embedUrl) {
  try {
    const pageUrl = embedUrl.replace('/e/', '/v/')
    const res  = await fetch(pageUrl, { headers: embedHeaders('https://streamtape.com/'), timeout: 15000 })
    const text = await res.text()
    const m1 = text.match(/robotlink['"]\)\.innerHTML\s*=\s*["']([^"']+)["']\s*\+\s*["']([^"']+)["']/)
    if (m1) return 'https:' + m1[1] + m1[2]
    const m2 = text.match(/get_video\?id=([^&"'\s]+)&token=([^&"'\s]+)/)
    if (m2) return `https://streamtape.com/get_video?id=${m2[1]}&token=${m2[2]}&stream=1`
  } catch (e) { console.error('[streamtape]', e.message) }
  return null
}

export async function extractVoe(embedUrl) {
  try {
    const url = embedUrl.replace(/\/e\//, '/')
    const res  = await fetch(url, { headers: embedHeaders(embedUrl), timeout: 15000, redirect: 'follow' })
    const html = await res.text()
    const m1 = html.match(/(?:var\s+sources|window\.voe_player)\s*=\s*({[^}]+})/)
    if (m1) {
      try {
        const obj = JSON.parse(m1[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'))
        if (obj.hls) return obj.hls
        if (obj.mp4) return obj.mp4
      } catch (_) {}
    }
    const mHls = html.match(/["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
    if (mHls?.[1]) return mHls[1]
    const enc = html.match(/\["([A-Za-z0-9+/=@$^~!#&%?*]{20,})"\]/)
    if (enc?.[1]) {
      try {
        let v = enc[1]
        v = v.replace(/[A-Za-z]/g, c => {
          const b = c <= 'Z' ? 65 : 97
          return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b)
        })
        for (const p of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) v = v.split(p).join('_')
        v = v.replace(/_/g, '')
        v = Buffer.from(v, 'base64').toString('utf-8')
        v = v.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 3)).join('')
        v = v.split('').reverse().join('')
        v = Buffer.from(v, 'base64').toString('utf-8')
        const json = JSON.parse(v)
        return json.source || json.direct_access_url || json.hls || null
      } catch (_) {}
    }
    const mAny = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/)
    if (mAny?.[1]) return mAny[1]
  } catch (e) { console.error('[voe]', e.message) }
  return null
}

export async function extractOkru(embedUrl) {
  try {
    const vid = embedUrl.match(/ok\.ru\/(?:videoembed|video)\/(\d+)/)?.[1]
    if (!vid) return null
    const res  = await fetch(`https://ok.ru/videoembed/${vid}`, {
      headers: embedHeaders('https://ok.ru/'), timeout: 15000,
    })
    const text = await res.text()
    const dataOpts = text.match(/data-options="([^"]+)"/)
    if (!dataOpts) return null
    const json      = JSON.parse(dataOpts[1].replace(/&quot;/g, '"'))
    const flashVars = JSON.parse(json.flashvars?.metadata || '{}')
    const videos    = flashVars.videos || []
    const hls = videos.find(v => v.name === 'hls')
    const sd  = videos.find(v => v.name?.match(/SD|360|480/))
    return hls?.url || sd?.url || videos[0]?.url || null
  } catch (e) { console.error('[okru]', e.message) }
  return null
}

export async function extractUpStream(embedUrl) {
  try {
    const url = embedUrl.replace(/upstream\.to\//, 'upstream.to/e/')
    const res  = await fetch(url, { headers: embedHeaders(embedUrl), timeout: 15000 })
    const text = await res.text()
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    const code   = packed ? jsUnpack(packed[0]) : text
    return extraerUrlDeVideo(code || text)
  } catch (e) { console.error('[upstream]', e.message) }
  return null
}

export async function extractVidMoly(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    const text = await res.text()
    const m = text.match(/sources\s*:\s*\[([^\]]+)\]/)
    if (m) {
      const fileMatch = m[1].match(/file\s*:\s*["']([^"']+)["']/)
      if (fileMatch?.[1]) return fileMatch[1]
    }
    return extraerUrlDeVideo(text)
  } catch (e) { console.error('[vidmoly]', e.message) }
  return null
}

export async function extractUqload(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    const text = await res.text()
    const src = text.match(/sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/)
    return src?.[1] || null
  } catch (e) { console.error('[uqload]', e.message) }
  return null
}

export async function extractByse(embedUrl) {
  try {
    const res  = await fetch(embedUrl, {
      headers: { ...embedHeaders(embedUrl), 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
      timeout: 15000,
    })
    const text = await res.text()
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    if (packed) {
      const code = jsUnpack(packed[0])
      if (code) {
        const src = extraerUrlDeVideo(code)
        if (src) return src
      }
    }
    const b64 = text.match(/atob\(["']([A-Za-z0-9+/=]{60,})["']\)/)
    if (b64) {
      try {
        const decoded = Buffer.from(b64[1], 'base64').toString('utf-8')
        const src = extraerUrlDeVideo(decoded)
        if (src) return src
      } catch (_) {}
    }
    return extraerUrlDeVideo(text)
  } catch (e) { console.error('[byse/dsvplay/lulu]', e.message) }
  return null
}

export async function resolverEmbedAVideoDirecto(embedUrl) {
  const u = embedUrl.toLowerCase()
  if (u.includes('filemoon') || u.includes('moonplayer') || u.includes('moonvid'))
    return extractFilemoon(embedUrl)
  if (u.includes('mp4upload'))
    return extractMp4Upload(embedUrl)
  if (u.includes('dood') || u.includes('ds2play') || u.includes('dooood') ||
      u.includes('d0000d') || u.includes('dood.wf') || u.includes('dood.to'))
    return extractDoodStream(embedUrl)
  if (u.includes('streamwish') || u.includes('wishembed') || u.includes('embedwish') ||
      u.includes('dwish') || u.includes('awish') || u.includes('mwish') || u.includes('swdyu') ||
      u.includes('vidhide') || u.includes('dlions') || u.includes('filelions') ||
      u.includes('vidhidepre') || u.includes('senvid') || u.includes('vidscr'))
    return extractStreamWish(embedUrl)
  if (u.includes('streamtape') || u.includes('streamta.pe'))
    return extractStreamtape(embedUrl)
  if (u.includes('voe.sx') || u.includes('/voe/') || u.match(/voe\d*\.sx/))
    return extractVoe(embedUrl)
  if (u.includes('ok.ru') || u.includes('okru'))
    return extractOkru(embedUrl)
  if (u.includes('upstream.to') || u.includes('upstream'))
    return extractUpStream(embedUrl)
  if (u.includes('vidmoly'))
    return extractVidMoly(embedUrl)
  if (u.includes('uqload') || u.includes('uqload.co'))
    return extractUqload(embedUrl)
  if (u.includes('byse.') || u.includes('byserial'))
    return extractByse(embedUrl)
  if (u.includes('dsvplay') || u.includes('dsvplay.com'))
    return extractByse(embedUrl)
  if (u.includes('lulu') || u.includes('luluvdo') || u.includes('lulustream'))
    return extractByse(embedUrl)
  return null
}

export function extraerUrlsDeScripts($, html, servidores) {
  $('script:not([src])').each((_, el) => {
    const code = $(el).html() || ''
    const re = /['\"](https?:\/\/[^'\"]{10,}\.(?:mp4|m3u8|webm|mkv)[^'\"]*)['\"]/gi
    let match
    while ((match = re.exec(code)) !== null) {
      const u = match[1]
      if (!servidores.find(s => s.url === u))
        servidores.push({ nombre: detectarServidor(u), url: u, directo: true })
    }
  })
}

export async function scrapeAnimeFLV(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)
  const servidores = []

  const intercepted = html.match(/INTERCEPTED_VIDEO:(https?:\/\/[^\s"<>\n]+)/)
  if (intercepted) servidores.push({ nombre: detectarServidor(intercepted[1]), url: intercepted[1], directo: true })

  $('script').each((_, el) => {
    const code = $(el).html() || ''

    const m1 = code.match(/var\s+videos\s*=\s*(\{[\s\S]*?\})\s*;/)
    if (m1) {
      try {
        const data  = JSON.parse(m1[1])
        const listas = [
          ...(data.SUB || []).map(s => ({ ...s, dub: false })),
          ...(data.LAT || []).map(s => ({ ...s, dub: false })),
          ...(data.DUB || []).map(s => ({ ...s, dub: true  })),
        ]
        for (const s of listas) {
          const videoUrl = normalizarMegaUrl(s.url || '')
          const embedUrl = normalizarMegaUrl(s.code || '')
          const u = embedUrl || videoUrl
          if (u && !servidores.find(sv => sv.url === u)) {
            const nombre = (s.title || detectarServidor(u)).toLowerCase()
            servidores.push({ nombre: nombre + (s.dub ? '-dub' : ''), url: u, download: videoUrl || null })
          }
        }
      } catch (_) {}
    }

    const m2 = code.match(/var\s+videos\s*=\s*(\[[\s\S]*?\])\s*;/)
    if (m2 && !m1) {
      try {
        const lista = JSON.parse(m2[1])
        for (const s of lista) {
          const videoUrl = normalizarMegaUrl(s.url || '')
          const embedUrl = normalizarMegaUrl(s.code || s.embed || '')
          const u = embedUrl || videoUrl
          if (u && !servidores.find(sv => sv.url === u)) {
            const nombre = (s.title || s.server || s.name || detectarServidor(u)).toLowerCase()
            servidores.push({ nombre, url: u, download: videoUrl || null })
          }
        }
      } catch (_) {}
    }

    const m3 = code.match(/anime_info\s*=\s*\[[^\]]*,\s*(\[[^\]]+\])/)
    if (m3) {
      try {
        const lista = JSON.parse(m3[1])
        for (const s of lista) {
          if (!Array.isArray(s) || s.length < 2) continue
          const u = normalizarMegaUrl(String(s[1]))
          if (u.startsWith('http') && !servidores.find(sv => sv.url === u))
            servidores.push({ nombre: String(s[0]).toLowerCase() || detectarServidor(u), url: u })
        }
      } catch (_) {}
    }
  })

  extraerUrlsDeScripts($, html, servidores)

  const filtrados = servidores.filter(s => esServidorConocido(s.nombre, s.url))
  return filtrados.length > 0 ? filtrados : servidores
}

export async function scrapeLatAnime(url) {
  const { default: axios } = await import('axios')
  const DOMINIOS = [
    'mega.nz','mega.co.nz','mediafire.com','voe.sx','streamtape','filemoon',
    'mp4upload','streamwish','dood','upstream','ok.ru','vidhide','mixdrop',
    'savefiles','gofile.io','byse','dsvplay','lulu','pixeldrain','pdrain',
  ]

  const esConocido = (href) => DOMINIOS.some(d => href.includes(d))

  const resolverRedirector = async (href) => {
    if (esConocido(href)) return href
    try {
      const res = await axios.get(href, {
        headers: { 'User-Agent': randomUA(), 'Referer': 'https://latanime.org/' },
        maxRedirects: 5, timeout: 10000, validateStatus: () => true,
      })
      const body     = typeof res.data === 'string' ? res.data : ''
      const finalUrl = res.request?.res?.responseUrl || ''
      for (const d of DOMINIOS) {
        const m = body.match(new RegExp(`https?://[^"'\\s]*${d.replace('.', '\\.')}[^"'\\s]*`))
        if (m) return m[0]
      }
      if (finalUrl && esConocido(finalUrl)) return finalUrl
    } catch (_) {}
    return null
  }

  let html
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent'     : randomUA(),
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9',
        'Referer'        : 'https://latanime.org/',
      },
      timeout: 15000,
    })
    html = res.data
  } catch (_) {
    html = await fetchHtml(url)
  }

  const $        = cheerio.load(html)
  const servidores = []

  $('button.play-video[data-player], a[data-player], [data-player]').each((_, el) => {
    const raw   = $(el).attr('data-player') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!raw) return
    let embedUrl = raw
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8').trim()
      if (decoded.startsWith('http')) embedUrl = decoded
    } catch (_) {}
    if (embedUrl.startsWith('http') && !servidores.find(s => s.url === embedUrl))
      servidores.push({ nombre: label || detectarServidor(embedUrl), url: normalizarMegaUrl(embedUrl), directo: /mega\.nz|mediafire\.com/.test(embedUrl) })
  })

  const redirLinks = []
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http') || servidores.find(s => s.url === href)) return
    if (href.includes('latanime.org') || href.match(/\.(jpg|png|gif|css|js)$/)) return
    if (esConocido(href)) {
      servidores.push({ nombre: label || detectarServidor(href), url: normalizarMegaUrl(href), directo: /mega\.nz|mediafire\.com/.test(href) })
    } else if (href.length > 20 && !href.includes('javascript') && !href.includes('#')) {
      redirLinks.push({ href, label })
    }
  })

  for (const { href, label } of redirLinks) {
    const urlReal = await resolverRedirector(href)
    if (urlReal && !servidores.find(s => s.url === urlReal))
      servidores.push({ nombre: label || detectarServidor(urlReal), url: normalizarMegaUrl(urlReal), directo: /mega\.nz|mediafire\.com/.test(urlReal) })
  }

  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src') || ''
    if (src.startsWith('http') && !servidores.find(s => s.url === src))
      servidores.push({ nombre: detectarServidor(src), url: src })
  })

  if (servidores.length === 0) extraerUrlsDeScripts($, html, servidores)

  const filtrados = servidores.filter(s => esServidorConocido(s.nombre, s.url))
  const resultado = filtrados.length > 0 ? filtrados : servidores
  console.log(`[latanime] ${resultado.length} servidor(es):`, resultado.map(s => s.nombre).join(', '))
  return resultado
}

export async function scrapeMonosChinos(url) {
  const { default: axios } = await import('axios')
  let html
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent'     : randomUA(),
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9',
        'Referer'        : 'https://monoschinos2.com/',
      },
      timeout: 15000,
    })
    html = res.data
  } catch (_) {
    html = await fetchHtmlDirecto(url, 'https://monoschinos2.com/')
  }

  const $        = cheerio.load(html)
  const servidores = []

  $('button.play-video[data-player], a.play-video[data-player], [data-player]').each((_, el) => {
    const raw   = $(el).attr('data-player') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!raw) return
    let embedUrl = raw
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8').trim()
      if (decoded.startsWith('http')) embedUrl = decoded
    } catch (_) {}
    if (!embedUrl.startsWith('http') || servidores.find(s => s.url === embedUrl)) return
    servidores.push({
      nombre : label || detectarServidor(embedUrl),
      url    : normalizarMegaUrl(embedUrl),
      directo: /mega\.nz|mediafire\.com/.test(embedUrl),
    })
  })

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http') || servidores.find(s => s.url === href)) return
    const esDescarga = /mega\.nz|mediafire\.com|1fichier\.com|filemoon|voe\.sx|mp4upload|streamwish|gofile\.io|pixeldrain/.test(href)
    if (!esDescarga) return
    servidores.push({
      nombre : label || detectarServidor(href),
      url    : normalizarMegaUrl(href),
      directo: /mega\.nz|mediafire\.com|1fichier\.com/.test(href),
    })
  })

  if (servidores.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http') && !servidores.find(s => s.url === src))
        servidores.push({ nombre: detectarServidor(src), url: src })
    })
  }

  console.log(`[monoschinos] ${servidores.length} servidor(es):`, servidores.map(s => s.nombre).join(', '))
  return servidores
}

export async function scrapeJKanime(url) {
  const servidores = []

  const resolverRedirect = async (href) => {
    let current = href
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(current, {
          method : 'HEAD',
          redirect: 'manual',
          headers : buildHeaders({ Referer: 'https://jkanime.net/' }),
        })
        const loc = res.headers?.get?.('location') || res.headers?.location
        if (!loc) break
        current = loc.startsWith('http') ? loc : new URL(loc, current).href
        if (!current.includes('jkplayers.com')) break
      }
    } catch (_) {}
    return current
  }

  try {
    const html = await fetchHtml(url)
    const serversLiteral = extractVarLiteral(html, 'servers')
    if (serversLiteral) {
      const serversData = safeEvaluate(`(${serversLiteral})`)
      if (Array.isArray(serversData) && serversData.length > 0) {
        const remoteMatch = html.match(/var\s+remote\s*=\s*['"]([^'"]+)['"]/i)
        const remoteBase  = remoteMatch ? remoteMatch[1] : null

        for (const entry of serversData) {
          if (!entry) continue
          const decodedUrl = decodeBase64Jk(entry.remote)
          if (decodedUrl) {
            const finalUrl = decodedUrl.includes('jkplayers.com')
              ? await resolverRedirect(decodedUrl)
              : decodedUrl
            const nombre = (entry.server || '').toLowerCase() || detectarServidor(finalUrl)
            if (!servidores.find(s => s.url === finalUrl))
              servidores.push({
                nombre,
                url: normalizarMegaUrl(finalUrl),
                directo: /mega\.nz|mediafire\.com|gofile\.io|savefiles\.me/.test(finalUrl),
              })
          }

        }

        if (servidores.length > 0) {
          console.log(`[jkanime] var servers: ${servidores.length} servidores:`, servidores.map(s => s.nombre).join(', '))
          return servidores
        }
      }
    }

    const iframeUrls = extractVideoIframeUrls(html)
    for (const iUrl of iframeUrls) {
      if (!servidores.find(s => s.url === iUrl))
        servidores.push({ nombre: detectarServidor(iUrl), url: iUrl })
    }
    if (servidores.length > 0) {
      console.log(`[jkanime] video iframes: ${servidores.length}`)
      return servidores
    }
  } catch (e) { console.error('[jkanime] var servers parse:', e.message) }

  const jkMatch = url.match(/jkanime\.net\/([^/]+)\/(\d+)/)
  const slug    = jkMatch?.[1]
  const cap     = jkMatch?.[2]

  try {
    const chromiumPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable', '/usr/local/bin/chromium',
      '/data/data/com.termux/files/usr/bin/chromium-browser',
      '/data/data/com.termux/files/usr/bin/chromium',
    ].filter(Boolean)
    let execPath = null
    for (const p of chromiumPaths) { if (fs.existsSync(p)) { execPath = p; break } }
    if (!execPath) throw new Error('Chromium no disponible')

    const browser = await (await getPuppeteer()).launch({
      headless      : 'new',
      executablePath: execPath,
      args          : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setUserAgent(randomUA())
    await page.setExtraHTTPHeaders(buildHeaders({ Referer: 'https://jkanime.net/' }))
    await page.setRequestInterception(true)
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort()
      else req.continue()
    })

    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }) } catch (_) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch (_) {}
    }

    const serversFromPage = await page.evaluate(() => {
      try {
        const scripts = Array.from(document.querySelectorAll('script'))
        for (const s of scripts) {
          const code = s.textContent || ''
          if (code.includes('var servers')) {
            const m = code.match(/var\s+servers\s*=\s*(\[[\s\S]*?\])\s*[;,]/)
            if (m) return JSON.parse(m[1])
          }
        }
      } catch (_) {}
      return null
    })

    if (Array.isArray(serversFromPage) && serversFromPage.length > 0) {
      for (const entry of serversFromPage) {
        const decodedUrl = decodeBase64Jk(entry.remote)
        if (decodedUrl) {
          const finalUrl = decodedUrl.includes('jkplayers.com')
            ? await resolverRedirect(decodedUrl)
            : decodedUrl
          const nombre = (entry.server || '').toLowerCase() || detectarServidor(finalUrl)
          if (!servidores.find(s => s.url === finalUrl))
            servidores.push({ nombre, url: normalizarMegaUrl(finalUrl) })
        }
      }
      await browser.close()
      if (servidores.length > 0) {
        console.log(`[jkanime] puppeteer servers: ${servidores.length}`)
        return servidores
      }
    }

    try { await page.waitForSelector('table tr td a[href]', { timeout: 8000 }) } catch (_) {}

    const filas = await page.evaluate(() => {
      const resultado = []
      document.querySelectorAll('table tr').forEach(tr => {
        const tds = tr.querySelectorAll('td')
        if (tds.length < 4) return
        const nombre = tds[0]?.textContent?.trim()
        const link   = tds[3]?.querySelector('a[href]')?.href
        if (nombre && link?.startsWith('http')) resultado.push({ nombre, link })
      })
      return resultado
    })

    await browser.close()

    if (filas.length > 0) {
      console.log(`[jkanime] tabla: ${filas.length} servidores:`, filas.map(f => f.nombre).join(', '))
      const promesas = filas.map(async ({ nombre, link }) => {
        const finalUrl = await resolverRedirect(link)
        return {
          nombre : nombre.toLowerCase(),
          url    : normalizarMegaUrl(finalUrl),
          directo: /mega\.nz|mediafire\.com|gofile\.io|savefiles\.me/.test(finalUrl),
        }
      })
      const resultados = await Promise.allSettled(promesas)
      for (const r of resultados) {
        if (r.status === 'fulfilled' && r.value?.url && !servidores.find(s => s.url === r.value.url))
          servidores.push(r.value)
      }
      if (servidores.length > 0) return servidores
    }
  } catch (e) { console.error('[jkanime] Puppeteer:', e.message) }

  if (slug && cap && servidores.length === 0) {
    const SERVIDORES_JK = ['sw', 'jkvideo', 'okru', 'stape', 'mp4upload', 'filemoon', 'voe', 'uqload', 'doodstream', 'vidhide', 'mixdrop', 'streamwish']
    const headers = { ...buildHeaders({ Referer: url }), 'X-Requested-With': 'XMLHttpRequest' }

    for (const srv of SERVIDORES_JK) {
      try {
        const apiUrl = `https://jkanime.net/ajax/episode/2/?id=${slug}&cap=${cap}&server=${srv}`
        const res    = await fetch(apiUrl, { headers, timeout: 12000 })
        if (!res.ok) continue
        const json   = await res.json()

        if (json?.remote) {
          try {
            let d = json.remote
            const pad = 4 - (d.length % 4)
            if (pad !== 4) d += '='.repeat(pad)
            const decoded = Buffer.from(d, 'base64').toString('utf-8').trim()
            if (decoded.startsWith('http') && !servidores.find(s => s.url === decoded)) {
              const finalUrl = decoded.includes('jkplayers.com') ? await resolverRedirect(decoded) : decoded
              servidores.push({ nombre: srv, url: normalizarMegaUrl(finalUrl) })
              continue
            }
          } catch (_) {}
        }

        const embedUrl =
          json?.source?.[0]?.file || json?.iframe || json?.url ||
          json?.embed || json?.data?.url || json?.data?.iframe
        if (embedUrl?.startsWith('http') && !servidores.find(s => s.url === embedUrl)) {
          const finalUrl = embedUrl.includes('jkplayers.com') ? await resolverRedirect(embedUrl) : embedUrl
          servidores.push({ nombre: srv, url: normalizarMegaUrl(finalUrl) })
        }
      } catch (e) { console.error(`[jkanime] API ${srv}:`, e.message) }
    }
  }

  console.log(`[jkanime] ${servidores.length} servidor(es) encontrados`)
  return servidores
}

export async function buscarEnAnimeFLV(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} ${temporada}` : nombre
  const html = await fetchHtml(`https://www3.animeflv.net/browse?q=${encodeURIComponent(query)}`)
  const $ = cheerio.load(html)

  const links = []
  $('ul.ListAnimes li, ul li article.Anime').each((_, el) => {
    const $el   = $(el)
    const aTag  = $el.find('a').first()
    const href  = aTag.attr('href') || ''
    const title = ($el.find('h3').text() || aTag.text() || aTag.attr('title') || '').trim().toLowerCase()
    if (href.startsWith('/anime/')) links.push({ href, title })
  })

  if (links.length === 0) return null
  const elegido = elegirPorTemporada(links, temporada) || mejorMatch(links, nombre)
  const slug    = elegido.href.replace('/anime/', '').replace(/\/$/, '')
  return `https://www3.animeflv.net/ver/${slug}-${episodio}`
}

export async function buscarEnLatAnime(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} temporada ${temporada}` : nombre
  const html  = await fetchHtml(`https://latanime.org/?s=${encodeURIComponent(query)}`)
  const $     = cheerio.load(html)

  const links = []

  const addLink = (href, title) => {
    if (!href || !title || title.length < 2) return
    if (!links.find(l => l.href === href)) links.push({ href, title })
  }

  $('article').each((_, el) => {
    const aTag  = $(el).find('a[href*="/anime/"], a[href*="latanime.org"]').first()
    const href  = aTag.attr('href') || ''
    const title = (
      $(el).find('h2, h3, h4, .Title, .title, .entry-title, .name').first().text() ||
      aTag.attr('title') || aTag.text()
    ).trim().toLowerCase()
    addLink(href, title)
  })

  if (links.length === 0) {
    $('a[href*="/anime/"]').each((_, el) => {
      const href  = $(el).attr('href') || ''
      const title = ($(el).attr('title') || $(el).find('h2,h3').text() || $(el).text()).trim().toLowerCase()
      if ((href.includes('latanime.org') || href.startsWith('/anime/')) && title.length > 2)
        addLink(href, title)
    })
  }

  if (links.length === 0) {
    $('a[href]').each((_, el) => {
      const href  = $(el).attr('href') || ''
      const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
      if (!/latanime\.org|^\/anime\//.test(href)) return
      if (title.length < 3 || /menu|nav|footer|header|logo/i.test($(el).closest('nav,header,footer').attr('class') || '')) return
      addLink(href, title)
    })
  }

  if (links.length === 0) return null

  const elegido = mejorMatch(links, nombre) || elegirPorTemporada(links, temporada) || links[0]

  let baseHref = elegido.href
  const slugMatch =
    baseHref.match(/\/ver\/([^/?#]+?)(?:-episodio-\d+)?(?:\/|$)/) ||
    baseHref.match(/\/anime\/([^/?#]+?)(?:\/|$)/)

  if (!slugMatch) {
    const slugBase = normalizarTitulo(nombre).replace(/\s+/g, '-')
    return `https://latanime.org/ver/${slugBase}-episodio-${episodio}`
  }

  const slugBase = slugMatch[1].replace(/-episodio-\d+$/, '').replace(/\/$/, '')
  return `https://latanime.org/ver/${slugBase}-episodio-${episodio}`
}

export async function buscarEnJKanime(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} temporada ${temporada}` : nombre

  try {
    const apiSearch = `https://jkanime.net/api/search/?q=${encodeURIComponent(nombre)}`
    const res = await fetch(apiSearch, {
      headers: { ...buildHeaders({ Referer: 'https://jkanime.net/' }), 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
      timeout: 10000,
    })
    if (res.ok) {
      const json   = await res.json()
      const animes = json?.animes || json?.results || json?.data || []
      if (Array.isArray(animes) && animes.length > 0) {
        const nombreNorm = normalizarTitulo(nombre)
        const mejor = animes
          .map(a => ({ ...a, score: puntuarMatch(a.title || a.name || '', nombreNorm) }))
          .sort((a, b) => b.score - a.score)[0]
        const slug = mejor.slug || mejor.id || mejor.url?.split('/').filter(Boolean).pop()
        if (slug) return `https://jkanime.net/${slug}/${episodio}/`
      }
    }
  } catch (e) { console.error('[jkanime] API search:', e.message) }

  try {
    const html  = await fetchHtml(`https://jkanime.net/buscar/?q=${encodeURIComponent(query)}`)
    const $     = cheerio.load(html)
    const links = []

    $('.anime__item, .card, .col-lg-2').each((_, el) => {
      const aTag  = $(el).find('a').first()
      const href  = aTag.attr('href') || ''
      const title = (aTag.attr('title') || $(el).find('h5, h3, .title').first().text() || aTag.text()).trim().toLowerCase()
      if (href.match(/jkanime\.net\/[a-z0-9][a-z0-9-]+\/?$/) && title) {
        links.push({ href, title })
      }
    })

    if (links.length === 0) {
      $('a[href*="jkanime.net/"]').each((_, el) => {
        const href  = $(el).attr('href') || ''
        const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
        const slug  = href.match(/jkanime\.net\/([a-z0-9][a-z0-9-]+)\/?$/)?.[1]
        const excluir = ['buscar','categoria','notificaciones','contacto','login','registro','perfil','favoritos','historial','top','calendario','faq']
        if (slug && !excluir.includes(slug) && title) {
          links.push({ href, title })
        }
      })
    }

    if (links.length > 0) {
      const elegido   = mejorMatch(links, nombre) || elegirPorTemporada(links, temporada) || links[0]
      const slugMatch = elegido.href.match(/jkanime\.net\/([a-z0-9-]+)\/?$/)
      if (slugMatch) return `https://jkanime.net/${slugMatch[1]}/${episodio}/`
    }
  } catch (e) { console.error('[jkanime] HTML search:', e.message) }

  try {
    const slugBase = normalizarTitulo(nombre).replace(/\s+/g, '-')
    const candidatos = [slugBase]
    if (temporada > 1) {
      candidatos.push(`${slugBase}-${temporada}nd-season`, `${slugBase}-temporada-${temporada}`, `${slugBase}-season-${temporada}`)
    }
    for (const slug of candidatos) {
      const epUrl = `https://jkanime.net/${slug}/${episodio}/`
      try {
        const res = await fetch(epUrl, { headers: buildHeaders({ Referer: 'https://jkanime.net/' }), timeout: 8000, redirect: 'manual' })
        if (res.status === 200 || res.status === 301 || res.status === 302) {
          return res.status === 200 ? epUrl : (res.headers.get('location') || epUrl)
        }
      } catch (_) {}
    }
  } catch (e) { console.error('[jkanime] slug directo:', e.message) }

  return null
}

export async function buscarEnMonosChinos(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} temporada ${temporada}` : nombre

  const tryBuscarAPI = async () => {
    try {
      const apiUrl = `https://monoschinos2.com/api/search?q=${encodeURIComponent(nombre)}&_=${Date.now()}`
      const res = await fetch(apiUrl, {
        headers: buildHeaders({ Referer: 'https://monoschinos2.com/', Accept: 'application/json' }),
        timeout: 10000,
      })
      if (!res.ok) return null
      const json   = await res.json()
      const animes = json?.data || json?.results || json?.animes || []
      if (!Array.isArray(animes) || animes.length === 0) return null
      const mejor = animes
        .map(a => ({ ...a, score: puntuarMatch(a.titulo || a.title || a.name || '', nombre) }))
        .sort((a, b) => b.score - a.score)[0]
      const slug = mejor.slug || mejor.id || mejor.url?.split('/').filter(Boolean).pop()
      if (slug) return `https://monoschinos2.com/ver/${slug}-episodio-${episodio}`
    } catch (_) {}
    return null
  }

  const fromApi = await tryBuscarAPI()
  if (fromApi) return fromApi

  const searchUrl = `https://monoschinos2.com/buscar?q=${encodeURIComponent(query)}`
  const html = await fetchHtmlDirecto(searchUrl, 'https://monoschinos2.com/')
  const $    = cheerio.load(html)

  const links = []

  $('a[href*="/anime/"]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const title = (
      $(el).find('h3, h3.title_cap, .title, .name').first().text() ||
      $(el).attr('title') ||
      $(el).text()
    ).trim().toLowerCase()
    const img = $(el).find('img')
    if (!href || !title || img.length === 0) return
    if (!links.find(l => l.href === href)) links.push({ href, title })
  })

  if (links.length === 0) {
    $('a[href*="/anime/"]').each((_, el) => {
      const href  = $(el).attr('href') || ''
      const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
      if (href && title.length > 2 && !links.find(l => l.href === href)) links.push({ href, title })
    })
  }

  if (links.length === 0) return null

  const elegido  = mejorMatch(links, nombre) || elegirPorTemporada(links, temporada) || links[0]
  const slugMatch = elegido.href.match(/\/anime\/([^/?#]+)/)
  if (!slugMatch) return null
  const slug = slugMatch[1]

  return `https://monoschinos2.com/ver/${slug}-episodio-${episodio}`
}

export class MegaQuotaError extends Error {
  constructor() { super('EOVERQUOTA'); this.name = 'MegaQuotaError' }
}

export async function descargarMega(url, m, tmpDir) {
  let file
  try {
    file = MegaFile.fromURL(url)
    await file.loadAttributes()
  } catch (err) {
    const isQuota = err?.message?.includes('EOVERQUOTA') || err?.message?.includes('-18')
    if (isQuota) throw new MegaQuotaError()
    throw new Error(parseMegaError(err))
  }

  const name     = file.name
  const sizeH    = (file.size / 1024 / 1024).toFixed(2) + ' MB'
  await m.reply(`📥 *Mega:* ${name}\n⚖️ ${sizeH}\n_Descargando..._`)

  const tempPath   = path.join(tmpDir, name.replace(/[/\\:*?"<>|]/g, '_'))
  const fileStream = file.download()
  let dld = 0
  fileStream.on('data', chunk => {
    dld += chunk.length
    process.stdout.write(`\r[MEGA] ${((dld / file.size) * 100).toFixed(1)}% | ${(dld / 1024 / 1024).toFixed(2)} MB`)
  })
  try {
    await pipeline(fileStream, fs.createWriteStream(tempPath))
  } catch (err) {
    const isQuota = err?.message?.includes('EOVERQUOTA') || err?.message?.includes('-18')
    if (isQuota) throw new MegaQuotaError()
    throw err
  }
  console.log(`\n[MEGA] ✅ ${name}`)
  return tempPath
}

export async function descargarConYtDlp(embedUrl, outputDir) {
  const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s')

  let videoUrl = embedUrl
  const urlDirecta = await resolverEmbedAVideoDirecto(embedUrl)
  if (urlDirecta) {
    console.log(`[extractor] URL directa: ${urlDirecta.slice(0, 100)}`)
    videoUrl = urlDirecta
  }

  const esOkCdn  = videoUrl.includes('okcdn.ru')
  const esHLS    = videoUrl.includes('.m3u8') || esOkCdn
  const isOkCdn  = videoUrl.includes('okcdn.ru') || videoUrl.includes('ok.ru')
  const referer  = isOkCdn ? 'https://ok.ru/' : (() => { try { return new URL(embedUrl).origin + '/' } catch (_) { return 'https://animeflv.net/' } })()

  const cmdArgs = [
    '--no-check-certificate',
    '--no-warnings',
    ...(esHLS ? ['--downloader', 'ffmpeg'] : []),
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${randomUA()}`,
    '--add-header', `Referer: ${referer}`,
    '--add-header', 'Accept-Language: es-419,es;q=0.9',
    '-o', outputTemplate,
    videoUrl,
  ]

  console.log(`\n[yt-dlp] Descargando: ${videoUrl.slice(0, 120)}`)

  await new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrBuf = ''
    let stdoutBuf = ''

    proc.stdout.on('data', d => {
      const t = d.toString()
      stdoutBuf += t
      process.stdout.write(`[yt-dlp] ${t}`)
    })
    proc.stderr.on('data', d => {
      const t = d.toString()
      stderrBuf += t
      process.stderr.write(`[yt-dlp ERR] ${t}`)
    })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`yt-dlp timeout (${CONFIG.downloadTimeout / 1000}s)`))
    }, CONFIG.downloadTimeout)

    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        const fullLog = [stderrBuf, stdoutBuf].map(s => s.trim()).filter(Boolean).join('\n')
        const msg = fullLog || `yt-dlp salió con código ${code}`
        reject(new Error(msg))
      }
    })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })

  const archivos = fs.readdirSync(outputDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f))
  if (archivos.length === 0) throw new Error('yt-dlp no generó ningún archivo')
  return path.join(
    outputDir,
    archivos.map(f => ({ f, t: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0].f
  )
}

export async function ejecutarDescargaServidor(listaIntentos, indiceInicio = 0, pick, m, conn) {
  const { tmpDir, sitioElegido, argsParaAnime, nombre, episodio, temporada = 1 } = pick
  let archivoPath = null

  let statusKey = null
  const updateStatus = async (txt) => {
    try {
      if (statusKey) {
        await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
      } else {
        const sent = await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        statusKey = sent?.key || null
      }
    } catch (_) {
      try {
        const sent = await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        statusKey = sent?.key || null
      } catch (_) {}
    }
  }

  const servidoresPendientes = listaIntentos.slice(indiceInicio, indiceInicio + 6)
  await updateStatus(`⏳ Preparando descarga desde *${servidoresPendientes[0]?.nombre?.toUpperCase() || 'servidor'}*...`)

  for (const srv of servidoresPendientes) {
    const u = srv.url.toLowerCase()

    if (u.includes('hqq.tv') || u.includes('netu.tv') || u.includes('netu.ac') ||
        u.includes('biribup.com') ||
        (u.includes('yourupload.com') && !u.includes('.mp4'))) {
      console.log(`[descarga] saltando ${srv.nombre} (sin soporte real)`)
      continue
    }

    try {
      if (/mega\.nz|mega\.co\.nz/.test(u)) {
        await updateStatus(`📦 *Mega* detectado — descargando...`)
        archivoPath = await descargarMega(srv.url, m, tmpDir)
        break
      }

      if (/mediafire\.com/.test(u)) {
        await updateStatus(`📦 *MediaFire* detectado — obteniendo link...`)
        const { default: axios } = await import('axios')
        let mfData
        try { mfData = await mediafireDl(srv.url) }
        catch (err) { throw new Error(`MediaFire: ${err.message}`) }
        if (!mfData.link) throw new Error('MediaFire: no se encontró el link de descarga')
        const { name, link: downloadUrl } = mfData
        let sizeBytes = 0
        try {
          const head = await axios.head(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, httpsAgent })
          sizeBytes = parseInt(head.headers['content-length'] || '0')
        } catch (_) {}
        const sizeH = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '?'
        await updateStatus(`📥 *MediaFire:* ${name}\n⚖️ ${sizeH}\n_Descargando..._`)
        const tempPath = path.join(tmpDir, name.replace(/[/\\:*?"<>|]/g, '_'))
        const response = await axios({ method: 'get', url: downloadUrl, responseType: 'stream', httpsAgent })
        let dld = 0, mfLastTime = Date.now(), mfLastDld = 0
        response.data.on('data', chunk => {
          dld += chunk.length
          const now = Date.now()
          const dt  = (now - mfLastTime) / 1000
          if (dt >= 0.5) {
            const speed = ((dld - mfLastDld) / dt / 1024 / 1024).toFixed(1)
            mfLastTime  = now; mfLastDld = dld
            const p     = sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) : '?'
            const dlMB  = (dld / 1024 / 1024).toFixed(1)
            const totMB = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : '?'
            process.stdout.write(`\r[MediaFire] ${p}% | ${dlMB} MB / ${totMB} MB | ${speed} MB/s`)
          }
        })
        await pipeline(response.data, fs.createWriteStream(tempPath))
        console.log(`\n[MediaFire] ✅ ${name}`)
        archivoPath = tempPath
        break
      }

      if (/savefiles\.net|savefiles\.io/.test(u)) {
        await updateStatus(`💾 *Savefiles* detectado — descargando...`)
        const { default: axios } = await import('axios')
        const sfRes = await axios.get(srv.url, { headers: { 'User-Agent': randomUA(), 'Referer': 'https://savefiles.net/' }, httpsAgent, timeout: 15000 })
        const sfHtml = sfRes.data
        const sfLink =
          sfHtml.match(/href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|webm)[^"']*)['"]/i)?.[1] ||
          sfHtml.match(/window\.location\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1]
        if (!sfLink) throw new Error('Savefiles: no encontré URL de descarga')
        archivoPath = await descargarConYtDlp(sfLink, tmpDir)
        break
      }

      if (/gofile\.io/.test(u)) {
        await updateStatus(`💾 *Gofile* detectado — obteniendo link...`)
        const goId = srv.url.match(/gofile\.io\/(?:d|download)\/([A-Za-z0-9]+)/)?.[1]
        if (!goId) throw new Error('Gofile: ID no encontrado en URL')
        const { default: axios } = await import('axios')
        const goApi = await axios.get(`https://api.gofile.io/contents/${goId}?wt=4fd6sg89d7s6&cache=true`, {
          headers: { 'User-Agent': randomUA() }, httpsAgent, timeout: 12000,
        })
        const files = Object.values(goApi.data?.data?.children || {}).filter(c => c.type === 'file')
        if (!files.length) throw new Error('Gofile: no encontré archivos')
        const videoFile = files.find(f => /\.(mp4|mkv|webm)$/i.test(f.name)) || files[0]
        if (!videoFile?.link) throw new Error('Gofile: sin link de descarga')
        archivoPath = await descargarConYtDlp(videoFile.link, tmpDir)
        break
      }

      await updateStatus(`⬇️ Descargando desde *${srv.nombre.toUpperCase()}*...`)
      archivoPath = await descargarConYtDlp(srv.url, tmpDir)
      break

    } catch (err) {
      if (err instanceof MegaQuotaError) {
        await updateStatus(`⚠️ *Mega* alcanzó su límite (~5GB/6h) → probando siguiente servidor...`)
      } else {
        console.error(`\n[descarga] ❌ ${srv.nombre}:\n${(err.message || err).toString().trim()}\n`)
        await updateStatus(`⚠️ *${srv.nombre}* falló → probando siguiente servidor...`)
      }
      fs.readdirSync(tmpDir).forEach(f => {
        try { fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {}
      })
    }
  }

  if (!archivoPath) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const intentados = listaIntentos.slice(indiceInicio, indiceInicio + 4).map(s => s.nombre).join(', ')
    const sugerencias = SITIOS.filter(s => s.id !== sitioElegido?.id)
          .slice(0, 4)
          .map(s => `  .animedl ${s.id} ${(argsParaAnime || []).join(' ')}`)
          .join('\n')
    return updateStatus(
      `❌ *Todos los servidores fallaron.*\n*Intentados:* ${intentados}\n\nPrueba con otro sitio:\n${sugerencias}`
    )
  }

  try {
    if (nombre && episodio != null) {
      const newName = buildFileName(nombre, episodio, temporada)
      const newPath = path.join(tmpDir, newName)
      try { fs.renameSync(archivoPath, newPath); archivoPath = newPath } catch (_) {}
    }
    const sizeMB  = fs.statSync(archivoPath).size / 1024 / 1024
    const fileName = path.basename(archivoPath).replace(/_c\.mp4$/, '.mp4')
    const caption  = `🎌 *${fileName.replace(/\.[^.]+$/, '')}*\n📦 ${sizeMB.toFixed(1)} MB · KanaArima-MD`

    await updateStatus(`⬆️ Subiendo a WhatsApp...`)

    let enviado = false
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await conn.sendMessage(m.chat, {
          document: { url: archivoPath },
          caption, mimetype: 'video/mp4', fileName,
        }, { quoted: m })
        enviado = true
        await updateStatus(`✅ *¡Enviado!* ${fileName}`)
        break
      } catch (sendErr) {
        const isConnErr = sendErr.message?.includes('Connection Closed') ||
                          sendErr.message?.includes('Connection Terminated') ||
                          sendErr.output?.statusCode === 428
        if (isConnErr && intento < 3) {
          await updateStatus(`⏳ Conexión perdida, reconectando... (intento ${intento}/3)`)
          await new Promise(r => setTimeout(r, 10000 * intento))
        } else throw sendErr
      }
    }
    if (!enviado) throw new Error('No se pudo enviar tras 3 intentos')

  } catch (err) {
    console.error('[animedl] Error envío:', err.message)
    await updateStatus(`❌ Falló el envío:\n${err.message}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
