// plugins/anime-DL.js  — v2.3  (extractores byse/dsvplay/lulu dedicados + descarga Savefiles/Gofile)
//
// Comandos:
//   .anilist                          → muestra los sitios disponibles numerados
//   .animedl <url>                    → descarga desde URL directa (episodio)
//   .animedl <nombre>                 → busca en AnimeFLV, muestra info y lista de episodios
//   .animedl <nombre> <ep>            → busca en todos los sitios (temporada 1)
//   .animedl <nombre> t<N> <ep>       → busca temporada N específica
//   .animedl <S> <nombre> <ep>        → busca en el sitio número S
//   .animedl <S> <nombre> t<N> <ep>   → sitio S + temporada N
//   .cancelar / .stop                 → cancela descarga activa (responder al mensaje)
//   .animedl <mega url>               → descarga desde Mega
//   .animedl <mediafire url>          → descarga desde MediaFire
//
//   Selección de servidor (web/desktop): .dl a  .dl b  .dl c  …
//   Selección de servidor (móvil):       botones interactivos nativos
//
//   Ejemplos:
//   .animedl shingeki no kyojin          → info + lista de episodios
//   .animedl shingeki no kyojin t4 1
//   .animedl 1 oshi no ko t2 3
//   .animedl 6 one piece 1100
//   .animedl 7 naruto 25

import { spawn }         from 'child_process'
import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import fs                from 'fs'
import path              from 'path'
import fetch             from 'node-fetch'
import * as cheerio      from 'cheerio'
import puppeteerExtra    from 'puppeteer-extra'
import StealthPlugin     from 'puppeteer-extra-plugin-stealth'
import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import { pipeline }      from 'stream/promises'
import https             from 'https'

puppeteerExtra.use(StealthPlugin())

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 20 })
global.activeDownloads    = global.activeDownloads    || new Map()
global.pendingServerPicks = global.pendingServerPicks || new Map()  // chatId → pick state
global.animeDlSessions    = global.animeDlSessions    || {}          // chatId|sender → owner lock
global.pendingAnimeSearch = global.pendingAnimeSearch || new Map()  // chatId → anime search state

// ─── Persistencia de picks pendientes ─────────────────────────────────────────
// Permite restaurar la selección de servidor tras reinicio del bot

const PICKS_FILE = path.join(process.cwd(), '.anime_dl_picks.json')

function guardarPicks() {
  try {
    const serializable = {}
    for (const [chatId, pick] of global.pendingServerPicks.entries()) {
      serializable[chatId] = {
        servers      : pick.servers,
        tmpDir       : pick.tmpDir,
        sitioId      : pick.sitioElegido?.id ?? null,
        argsParaAnime: pick.argsParaAnime,
        timestamp    : pick.timestamp,
      }
    }
    fs.writeFileSync(PICKS_FILE, JSON.stringify(serializable, null, 2), 'utf-8')
  } catch (e) { console.error('[picks] Error al guardar:', e.message) }
}

function cargarPicks() {
  try {
    if (!fs.existsSync(PICKS_FILE)) return
    const data = JSON.parse(fs.readFileSync(PICKS_FILE, 'utf-8'))
    const ahora = Date.now()
    for (const [chatId, p] of Object.entries(data)) {
      if (ahora - p.timestamp > 10 * 60 * 1000) continue  // expirado (>10 min)
      if (!fs.existsSync(p.tmpDir)) {
        try { fs.mkdirSync(p.tmpDir, { recursive: true }) } catch (_) {}
      }
      global.pendingServerPicks.set(chatId, {
        servers      : p.servers,
        tmpDir       : p.tmpDir,
        sitioElegido : getSitioPorId(p.sitioId),
        argsParaAnime: p.argsParaAnime,
        timestamp    : p.timestamp,
      })
    }
    if (global.pendingServerPicks.size > 0)
      console.log(`[picks] Restaurados ${global.pendingServerPicks.size} pick(s) pendientes`)
  } catch (e) { console.error('[picks] Error al cargar:', e.message) }
}

// ─── CATÁLOGO DE SITIOS  (AnimeFLV · TioAnime · LatAnime · JKanime) ──────────

const SITIOS = [
  {
    id: 1, nombre: 'AnimeFLV',  dominio: 'animeflv',
    url: 'https://www3.animeflv.net',
    buscar: buscarEnAnimeFLV,  scrape: scrapeAnimeFLV,
  },
  {
    id: 2, nombre: 'TioAnime',  dominio: 'tioanime',
    url: 'https://tioanime.com',
    buscar: buscarEnTioAnime,  scrape: scrapeTioAnime,
  },
  {
    id: 3, nombre: 'LatAnime',  dominio: 'latanime',
    url: 'https://latanime.org',
    buscar: buscarEnLatAnime,  scrape: scrapeLatAnime,
  },
  {
    id: 4, nombre: 'JKanime',   dominio: 'jkanime',
    url: 'https://jkanime.net',
    buscar: buscarEnJKanime,   scrape: scrapeJKanime,
  },
]

function getSitioPorId(id)       { return SITIOS.find(s => s.id === Number(id)) || null }
function getSitioPorDominio(url) { return SITIOS.find(s => url.includes(s.dominio)) || null }

// ─── Errores Mega ─────────────────────────────────────────────────────────────

const MEGA_ERRORS = {
  EOVERQUOTA: '⚠️ Mega superó su límite de transferencia. Intenta más tarde.',
  ENOENT:     '❌ El archivo de Mega no existe o fue eliminado.',
  ETOOMANY:   '⚠️ Demasiadas solicitudes a Mega. Espera unos minutos.',
  EACCESS:    '❌ Sin acceso al archivo. Puede ser privado o el enlace es inválido.',
  EBLOCKED:   '❌ Cuenta/archivo bloqueado en Mega.',
}
function parseMegaError(err) {
  const msg = err?.message || String(err)
  for (const [code, text] of Object.entries(MEGA_ERRORS)) {
    if (msg.includes(code) || msg.includes(code.toLowerCase())) return text
  }
  if (msg.includes('-18')) return MEGA_ERRORS.EOVERQUOTA
  if (msg.includes('-9'))  return MEGA_ERRORS.ENOENT
  if (msg.includes('-4'))  return MEGA_ERRORS.ETOOMANY
  return `❌ Error Mega: ${msg}`
}

// ─── MediaFire link extractor ─────────────────────────────────────────────────

async function mediafireDl(url) {
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

// ─── Configuración ────────────────────────────────────────────────────────────

const CONFIG = {
  downloadTimeout: 3 * 60 * 60 * 1000,  // 3 horas — soporta archivos grandes en conexión lenta
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
  servidoresPreferidos: [
    'mp4upload', 'filemoon', 'streamwish', 'wishembed',
    'doodstream', 'streamtape', 'okru', 'voe', 'upstream',
    'yourupload', 'vidmoly', 'uqload',
    'savefiles', 'gofile', 'byse', 'dsvplay', 'lulu', 'streamtape', 'vidhide', 'mixdrop',
  ],
  videoExtensions: /\.(mp4|mkv|webm|m3u8|ts)(\?|$)/i,
}

const randomUA     = () => CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)]
const buildHeaders = (extra = {}) => ({ ...CONFIG.baseHeaders, 'User-Agent': randomUA(), ...extra })

// ─── Normalizar URLs de Mega a formato mega.nz/file/ID#KEY ───────────────────
// Cubre: /embed/!ID!KEY  /embed#!ID!KEY  /#!ID!KEY  /file/ID!KEY
function normalizarMegaUrl(u) {
  if (!u || !u.includes('mega.nz')) return u
  // Extraer ID y KEY de cualquier variante
  // Variante 1: /embed/!ID!KEY o /embed/#!ID!KEY o /#!ID!KEY
  let m = u.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m) return `https://mega.nz/file/${m[1]}#${m[2]}`
  // Variante 2: /file/ID#KEY (ya correcto)
  if (u.includes('/file/') && u.includes('#')) return u
  // Variante 3: /file/ID!KEY → convertir ! a #
  m = u.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m) return `https://mega.nz/file/${m[1]}#${m[2]}`
  return u
}

// ─── Helper: conversión índice → letra minúscula ─────────────────────────────

const numToLetter = (i) => String.fromCharCode(97 + (i % 26))  // 0→'a', 1→'b', …

// ─── Helper: Lista interactiva WhatsApp ───────────────────────────────────────
// Móvil → interactiveMessage nativeFlow single_select
// Web / Desktop → texto plano enumerado con letras minúsculas (a, b, c…)
//
// opts = { title, body?, footer?, buttonText?, sections: [{title?, rows:[{title,description,id}]}] }

async function enviarListaWA(conn, m, { title, body = '', footer, buttonText = 'SELECCIONAR', sections }) {
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
      // caer al fallback de texto
    }
  }

  // Fallback texto plano — letras minúsculas
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

// ─── Búsqueda: lista de resultados en AnimeFLV (sin auto-pick) ────────────────

async function buscarResultadosAnimeFLV(nombre, temporada = 1) {
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

// ─── Scraping de info de anime desde AnimeFLV ─────────────────────────────────
// Devuelve: { title, description, genres, coverUrl, slug, episodes, audioTags }
// Prioriza etiquetas de audio regional (Sub Español / Latino / Doblado)

async function scrapeInfoAnimeFLV(animeUrl) {
  try {
    const html = await fetchHtml(animeUrl)
    const $    = cheerio.load(html)

    const title = $('h1.Title, h2.Title, .Title').first().text().trim()

    // Descripción en español (AnimeFLV siempre la tiene en es)
    const description =
      $('div.Description p').first().text().trim() ||
      $('div.sinopsis p').first().text().trim()    ||
      $('p.synopsis').first().text().trim()        || ''

    // Géneros en español
    const genres = []
    $('nav.Nvg a, a[href*="/browse?genre="]').each((_, el) => {
      const g = $(el).text().trim()
      if (g && !genres.includes(g)) genres.push(g)
    })

    // Etiquetas de audio regional: Sub Español / Latino / Doblado
    const audioTags = []
    $('span.Type, .badge, .label, a[href*="sub-espanol"], a[href*="latino"], a[href*="doblado"]').each((_, el) => {
      const txt = $(el).text().trim().toLowerCase()
      if (/sub.?espa|latino|doblado|castellano/.test(txt) && !audioTags.includes(txt))
        audioTags.push($(el).text().trim())
    })
    // Fallback: buscar en el slug/URL
    if (audioTags.length === 0) {
      if (/latino/.test(animeUrl))    audioTags.push('Latino')
      if (/sub-espa/.test(animeUrl))  audioTags.push('Sub Español')
      if (/doblado/.test(animeUrl))   audioTags.push('Doblado')
    }

    const coverUrl =
      $('div.AnimeCover img, .cover img, figure.Bg img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') || null

    // Episodios embebidos en el script JS: var episodes = [[N,0],…]
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

// ─── Mostrar info + lista de episodios (AnimeFLV) ────────────────────────────

async function mostrarInfoYEpisodios({ url, slug: inputSlug, title: inputTitle }, m, conn, usedPrefix, temporada = 1, statusKey = null) {
  // Edita el mensaje de estado si ya existe (viene del "Buscando..."),
  // o crea uno nuevo si se llega aquí directamente (p.ej. desde handler.before).
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

  // Descartar títulos de página de login / error
  const titulo = (info.title && !/iniciar.?ses|login|register|acceder/i.test(info.title))
    ? info.title
    : (inputTitle || slug)

  // Metadatos en español
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

  // ── Enviar portada con caption ───────────────────────────────────────────
  if (info.coverUrl) {
    try {
      await conn.sendMessage(m.chat, {
        image  : { url: info.coverUrl },
        caption,
      }, { quoted: m })
      // Reducir el mensaje de estado a una sola línea (WA no permite eliminar mensajes propios)
      await updateStatus(`✅ *${titulo}* · ${info.episodes.length} episodios disponibles`)
    } catch (imgErr) {
      console.error('[mostrarInfoYEpisodios] imagen:', imgErr.message)
      // Sin imagen: editar el estado con el texto completo
      await updateStatus(caption)
    }
  } else {
    // Sin portada: el estado se convierte en la info
    await updateStatus(caption)
  }

  // ── Lista de episodios — máx. 26 (letras a–z) ────────────────────────────
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

// ─── Helpers de servidor ──────────────────────────────────────────────────────

function detectarServidor(url) {
  for (const s of CONFIG.servidoresPreferidos) {
    if (url.includes(s)) return s
  }
  return 'generico'
}

function elegirMejorServidor(servidores) {
  for (const preferido of CONFIG.servidoresPreferidos) {
    const match = servidores.find(s =>
      s.nombre?.includes(preferido) || s.url?.includes(preferido)
    )
    if (match) return match
  }
  return servidores[0] || null
}

// ─── Normalizar títulos para comparación ──────────────────────────────────────

function normalizarTitulo(t = '') {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar tildes
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function puntuarMatch(titulo, query) {
  const t = normalizarTitulo(titulo)
  const q = normalizarTitulo(query)
  if (t === q) return 100
  if (t.startsWith(q)) return 90
  if (t.includes(q)) return 70
  // coincidencia por palabras
  const palabrasQ = q.split(' ')
  const matches = palabrasQ.filter(p => p.length > 2 && t.includes(p))
  return Math.round((matches.length / palabrasQ.length) * 60)
}

function mejorMatch(links, query) {
  if (!links.length) return null
  return links
    .map(l => ({ ...l, score: puntuarMatch(l.title || l.href, query) }))
    .sort((a, b) => b.score - a.score)[0]
}

// ─── Fetch estático → dinámico ────────────────────────────────────────────────

async function fetchHtml(url) {
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

async function fetchHtmlConPuppeteer(url) {
  // Detectar Chromium automáticamente en Termux / Linux
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean)

  let execPath = null
  for (const p of chromiumPaths) {
    if (fs.existsSync(p)) { execPath = p; break }
  }

  if (!execPath) {
    console.error('[puppeteer] Chromium no encontrado. Instala con: pkg install chromium')
    throw new Error('Chromium no disponible (instala con: pkg install chromium)')
  }

  let capturedVideoUrl = null
  const browser = await puppeteerExtra.launch({
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
    const html = await page.content()
    await browser.close()
    if (capturedVideoUrl) return html + `\n<!-- INTERCEPTED_VIDEO:${capturedVideoUrl} -->`
    return html
  } catch (err) {
    await browser.close()
    throw err
  }
}

// ─── Helpers compartidos ─────────────────────────────────────────────────────

// P.A.C.K.E.R. decoder
function jsUnpack(packed) {
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

function extraerUrlDeVideo(code) {
  const patrones = [
    /sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["']([^"']+\.m3u8[^"']*)["']/i,
    /source\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /videoUrl\s*[=:]\s*["']([^"']+)["']/i,
    /player\.src\("([^"]+)"/,
    /player\.src\([^)]*src\s*:\s*"([^"]+)"/,
  ]
  for (const re of patrones) {
    const m = code.match(re)
    if (m?.[1]?.startsWith('http')) return m[1]
  }
  return null
}

function embedHeaders(referer, extra = {}) {
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

// ─── Extractores de servidores ────────────────────────────────────────────────

// ── Filemoon ──────────────────────────────────────────────────────────────────
async function extractFilemoon(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    let   html = await res.text()
    const iframeSrc = html.match(/<iframe[^>]+src=["']([^"']+filemoon[^"']+)["']/i)?.[1]
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

// ── Mp4Upload ─────────────────────────────────────────────────────────────────
async function extractMp4Upload(embedUrl) {
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
    // Patrón alternativo (de monkey-dl mp4upload_extractor)
    const m3 = (code || text).match(/<script(?:.|\n)+?src:(?:.|\n)*?"(.+?\.mp4)"/)
    if (m3?.[1]) return m3[1]
    return extraerUrlDeVideo(code || text)
  } catch (e) { console.error('[mp4upload]', e.message) }
  return null
}

// ── DoodStream ────────────────────────────────────────────────────────────────
async function extractDoodStream(embedUrl) {
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

// ── StreamWish / Wishembed / VidHide / FileLions ──────────────────────────────
async function extractStreamWish(embedUrl) {
  const norm = embedUrl.replace(/\/(f|e)\//, '/')

  // ── Intento 1: fetch estático con múltiples patrones ─────────────────────
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
    console.log(`[streamwish] fetch OK, HTML len=${text.length}, tiene eval=${/eval\(function/.test(text)}`)
    if (text.length < 2000) console.log(`[streamwish] HTML completo:\n${text}\n---`)

    // P.A.C.K.E.R.
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    if (packed) {
      const code = jsUnpack(packed[0])
      console.log(`[streamwish] unpacked len=${code?.length}, snippet=${code?.slice(0,120)}`)
      if (code) {
        const src = extraerUrlDeVideo(code)
        if (src) { console.log(`[streamwish] ✅ src from packer: ${src.slice(0,80)}`); return src }
      }
    }

    // Base64 patterns
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
          if (src) { console.log(`[streamwish] ✅ src from b64: ${src.slice(0,80)}`); return src }
        } catch (_) {}
      }
    }

    const src = extraerUrlDeVideo(text)
    if (src) { console.log(`[streamwish] ✅ src from raw: ${src.slice(0,80)}`); return src }

    console.log('[streamwish] fetch estático no encontró src, pasando a Puppeteer...')
  } catch (e) {
    console.error('[streamwish] fetch error:', e.message)
  }

  // ── Intento 2: Puppeteer con ruta de Chromium de Termux ──────────────────
  try {
    // Detectar ruta de Chromium automáticamente (Termux / Linux / Docker)
    const chromiumPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/data/data/com.termux/files/usr/bin/chromium-browser',
      '/data/data/com.termux/files/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].filter(Boolean)

    let execPath = null
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) { execPath = p; break }
    }

    if (!execPath) {
      console.error('[streamwish] puppeteer: no se encontró Chromium. Instala con: pkg install chromium')
      return null
    }

    let capturedUrl = null
    const browser = await puppeteerExtra.launch({
      headless: 'new',
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setUserAgent(randomUA())
    await page.setExtraHTTPHeaders({ Referer: embedUrl })

    page.on('response', async (response) => {
      const url = response.url()
      if (!capturedUrl && /\.m3u8/.test(url)) capturedUrl = url
    })

    try {
      await page.goto(norm, { waitUntil: 'networkidle2', timeout: 25000 })
    } catch (_) {}

    for (let i = 0; i < 16 && !capturedUrl; i++) {
      await new Promise(r => setTimeout(r, 500))
    }
    await browser.close()
    if (capturedUrl) return capturedUrl
  } catch (e) {
    console.error('[streamwish] puppeteer error:', e.message)
  }

  return null
}

// ── StreamTape ────────────────────────────────────────────────────────────────
async function extractStreamtape(embedUrl) {
  try {
    // Usar /v/ para acceder a la página con el norobotlink (Stremio addon approach)
    const pageUrl = embedUrl.replace('/e/', '/v/')
    const res  = await fetch(pageUrl, { headers: embedHeaders('https://streamtape.com/'), timeout: 15000 })
    const text = await res.text()
    // Patrón moderno: norobotlink innerHTML
    const m1 = text.match(/robotlink['"]?\)\.innerHTML\s*=\s*["']([^"']+)["']\s*\+\s*["']([^"']+)["']/)
    if (m1) return 'https:' + m1[1] + m1[2]
    // Patrón streamParsing.js (stremio): document.getElementById('norobotlink')
    const noRobotMatch = text.match(/document\.getElementById\('norobotlink'\)\.innerHTML\s*=\s*(.+?);/)
    if (noRobotMatch?.[1]) {
      const tokenMatch = noRobotMatch[1].match(/token=([^&']+)/)
      if (tokenMatch?.[1]) {
        const STPattern = /id\s*=\s*"ideoooolink"/
        const tagEnd = text.indexOf('>', STPattern.exec(text).index) + 1
        const streamtape = text.substring(tagEnd, text.indexOf('<', tagEnd))
        return `https:/${streamtape}&token=${tokenMatch[1]}&dl=1`
      }
    }
    // Patrón alternativo: id= token=
    const m2 = text.match(/get_video\?id=([^&"'\s]+)&token=([^&"'\s]+)/)
    if (m2) return `https://streamtape.com/get_video?id=${m2[1]}&token=${m2[2]}&stream=1`
  } catch (e) { console.error('[streamtape]', e.message) }
  return null
}

// ── Voe ───────────────────────────────────────────────────────────────────────
async function extractVoe(embedUrl) {
  try {
    // Normalizar /e/ → URL base (voe.sx/SLUG)
    const url = embedUrl.replace(/\/e\//, '/')
    const res  = await fetch(url, { headers: embedHeaders(embedUrl), timeout: 15000, redirect: 'follow' })
    const html = await res.text()

    // Patrón 1: var sources / window.voe_player
    const m1 = html.match(/(?:var\s+sources|window\.voe_player)\s*=\s*({[^}]+})/)
    if (m1) {
      try {
        const obj = JSON.parse(m1[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'))
        if (obj.hls) return obj.hls
        if (obj.mp4) return obj.mp4
      } catch (_) {}
    }

    // Patrón 2: "hls":"url"
    const mHls = html.match(/["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
    if (mHls?.[1]) return mHls[1]

    // Patrón 3: decrypt F7 (array base64 en script type=application/json)
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

    // Patrón 4: buscar cualquier m3u8 en el HTML
    const mAny = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/)
    if (mAny?.[1]) return mAny[1]

  } catch (e) { console.error('[voe]', e.message) }
  return null
}

// ── Ok.ru ─────────────────────────────────────────────────────────────────────
async function extractOkru(embedUrl) {
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

// ── UpStream ──────────────────────────────────────────────────────────────────
async function extractUpStream(embedUrl) {
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

// ── VidMoly ───────────────────────────────────────────────────────────────────
async function extractVidMoly(embedUrl) {
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

// ── Uqload ────────────────────────────────────────────────────────────────────
async function extractUqload(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    const text = await res.text()
    const src = text.match(/sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/)
    return src?.[1] || null
  } catch (e) { console.error('[uqload]', e.message) }
  return null
}

// ── YourUpload ────────────────────────────────────────────────────────────────
// Técnica: meta og:video content (de stremio-addon/streamParsing.js)
async function extractYourUpload(embedUrl) {
  try {
    const res  = await fetch(embedUrl, { headers: embedHeaders(embedUrl), timeout: 15000 })
    const text = await res.text()
    const metaMatch = text.match(/property\s*=\s*"og:video"/)
    if (metaMatch) {
      const remaining = text.substring(metaMatch.index)
      const contentMatch = remaining.match(/content\s*=\s*"(\S+)"/)
      if (contentMatch?.[1]) return contentMatch[1]
    }
    // Fallback: buscar URL directa en el HTML
    return extraerUrlDeVideo(text)
  } catch (e) { console.error('[yourupload]', e.message) }
  return null
}

// ── PDrain / HLS directo ──────────────────────────────────────────────────────
function extractPDrain(embedUrl) {
  try {
    const m = embedUrl.match(/(.+?:\/\/.+?)\/.+?\/(.+?)(?:\?embed)?$/)
    if (m) return `${m[1]}/api/file/${m[2]}`
  } catch (_) {}
  return null
}

// ── Byse / DSVPlay / LuluStream ───────────────────────────────────────────────
// Estos reproductores usan JWPlayer con P.A.C.K.E.R. similar a StreamWish
async function extractByse(embedUrl) {
  try {
    const res  = await fetch(embedUrl, {
      headers: { ...embedHeaders(embedUrl), 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
      timeout: 15000,
    })
    const text = await res.text()
    // P.A.C.K.E.R.
    const packed = text.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
    if (packed) {
      const code = jsUnpack(packed[0])
      if (code) {
        const src = extraerUrlDeVideo(code)
        if (src) return src
      }
    }
    // Base64 atob
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

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function resolverEmbedAVideoDirecto(embedUrl) {
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

  if (u.includes('yourupload') || u.includes('yourcdn'))
    return extractYourUpload(embedUrl)

  if (u.includes('pdrain'))
    return extractPDrain(embedUrl)

  if (u.includes('savefiles') || u.includes('savefiles.net'))
    return null  // link de descarga directa, no embed — yt-dlp / axios lo maneja

  if (u.includes('gofile.io') || u.includes('gofile'))
    return null  // descarga directa

  if (u.includes('byse.') || u.includes('byserial'))
    return extractByse(embedUrl)

  if (u.includes('dsvplay') || u.includes('dsvplay.com'))
    return extractByse(embedUrl)

  if (u.includes('lulu') || u.includes('luluvdo') || u.includes('lulustream'))
    return extractByse(embedUrl)

  if (u.includes('cloud.mail') || u.includes('cloudfile') || u.includes('1fichier'))
    return null  // descarga directa, yt-dlp lo intenta

  return null  // sin extractor → yt-dlp lo intenta directamente
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

function extraerUrlsDeScripts($, html, servidores) {
  $('script:not([src])').each((_, el) => {
    const code = $(el).html() || ''
    const re = /['"](https?:\/\/[^'"]{10,}\.(?:mp4|m3u8|webm|mkv)[^'"]*)['"]/gi
    let match
    while ((match = re.exec(code)) !== null) {
      const u = match[1]
      if (!servidores.find(s => s.url === u))
        servidores.push({ nombre: detectarServidor(u), url: u, directo: true })
    }
  })
}

// ── AnimeFLV ──────────────────────────────────────────────────────────────────
// Mejorado: soporta var videos = {SUB:[...], DUB:[...]} (de AnimeFLV-Stremio)
// Normaliza URLs de Mega (mega.nz/#! → mega.nz/file/)
async function scrapeAnimeFLV(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)
  const servidores = []

  const intercepted = html.match(/INTERCEPTED_VIDEO:(https?:\/\/[^\s"<>\n]+)/)
  if (intercepted) servidores.push({ nombre: detectarServidor(intercepted[1]), url: intercepted[1], directo: true })

  $('script').each((_, el) => {
    const code = $(el).html() || ''
    const matchVar = code.match(/var videos\s*=\s*(\{[\s\S]*?\});/)
    if (matchVar) {
      try {
        const data  = JSON.parse(matchVar[1])
        // Soportar SUB, LAT y DUB  (fuente: stremio-addon/animeFLV.js)
        const listas = [
          ...(data.SUB || []).map(s => ({ ...s, dub: false })),
          ...(data.LAT || []).map(s => ({ ...s, dub: false })),
          ...(data.DUB || []).map(s => ({ ...s, dub: true  })),
        ]
        for (const s of listas) {
          let videoUrl = normalizarMegaUrl(s.url || '')
          let embedUrl = normalizarMegaUrl(s.code || '')
          const u = embedUrl || videoUrl
          if (u && !servidores.find(sv => sv.url === u)) {
            const nombre = (s.title || detectarServidor(u)).toLowerCase()
            servidores.push({ nombre: nombre + (s.dub ? '-dub' : ''), url: u, download: videoUrl || null })
          }
        }
      } catch (_) {}
    }
  })

  extraerUrlsDeScripts($, html, servidores)
  return servidores
}

// ── LatAnime ──────────────────────────────────────────────────────────────────
// LatAnime tiene dos fuentes de video:
//  1. Tabs de reproductores: data-src / data-player con embed URL
//  2. Botones de descarga directa: <a href="https://mega.nz/...">Mega</a>
//     OJO: algunos links pasan por un redirector de anuncio antes de llegar
//     al servidor real (ej: togglevpn.org → mediafire.com). Hay que resolverlos.
async function scrapeLatAnime(url) {
  const html = await fetchHtml(url)
  const $    = cheerio.load(html)
  const servidores = []

  const intercepted = html.match(/INTERCEPTED_VIDEO:(https?:\/\/[^\s"<>\n]+)/)
  if (intercepted) servidores.push({ nombre: detectarServidor(intercepted[1]), url: intercepted[1], directo: true })

  // Resolver un posible redirector de anuncio para obtener la URL real
  async function resolverRedirector(href) {
    // Si ya es un servidor conocido, no hace falta resolver
    const dominiosDirectos = ['mega.nz','mediafire.com','voe.sx','streamtape','filemoon',
      'mp4upload','streamwish','dood','upstream','ok.ru','vidhide','mixdrop','gofile.io']
    if (dominiosDirectos.some(d => href.includes(d))) return href

    // Si parece un redirector externo, seguirlo para obtener la URL destino
    try {
      const { default: axios } = await import('axios')
      const res = await axios.get(href, {
        headers: { 'User-Agent': randomUA(), 'Referer': 'https://latanime.org/' },
        httpsAgent,
        maxRedirects: 5,
        timeout: 10000,
        validateStatus: () => true, // aceptar cualquier status
      })
      // Buscar la URL de MediaFire u otro servidor en el HTML de la página de anuncio
      const body = typeof res.data === 'string' ? res.data : ''
      const finalUrl = res.request?.res?.responseUrl || ''

      // Patrón 1: URL de servidor en el HTML del redirector
      for (const d of dominiosDirectos) {
        const m = body.match(new RegExp(`https?://[^"'\\s]*${d.replace('.', '\\.')}[^"'\\s]*`))
        if (m) return m[0]
      }
      // Patrón 2: URL final después del redirect
      if (finalUrl && dominiosDirectos.some(d => finalUrl.includes(d))) return finalUrl

    } catch (_) {}
    return href // si no pudo resolver, devolver el original
  }

  // ── 1. Botones de descarga directa ──────────────────────────────────────
  const linksDescarga = []
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http')) return
    const esServidor =
      href.includes('mega.nz')    || href.includes('mediafire.com') ||
      href.includes('voe.sx')     || href.includes('streamtape')    ||
      href.includes('filemoon')   || href.includes('mp4upload')     ||
      href.includes('streamwish') || href.includes('dood')          ||
      href.includes('upstream')   || href.includes('ok.ru')         ||
      href.includes('vidhide')    || href.includes('mixdrop')       ||
      href.includes('savefiles')  || href.includes('gofile.io')     ||
      href.includes('byse')       || href.includes('dsvplay')       ||
      href.includes('lulu')       || href.includes('cloud')
    // También detectar redirectores externos que llevan a servidores
    const esRedirector = !href.includes('latanime.org') &&
      !href.includes('javascript') && !href.includes('#') &&
      (href.includes('toggle') || href.includes('redirect') ||
       href.includes('go.') || href.includes('/out/') || href.includes('/r/'))

    if ((esServidor || esRedirector) && !linksDescarga.find(l => l.href === href))
      linksDescarga.push({ href, label })
  })

  // Resolver redirectores en paralelo (máx 5 a la vez)
  for (const { href, label } of linksDescarga) {
    const urlReal = await resolverRedirector(href)
    const urlNorm = normalizarMegaUrl(urlReal)
    if (!servidores.find(s => s.url === urlNorm))
      servidores.push({ nombre: label || detectarServidor(urlNorm), url: urlNorm })
  }

  // ── 2. Tabs de reproductores embed (data-src / data-player / data-url) ──
  // También capturar tabs con texto como "dsvplay", "byse", etc. que usan atributo href o data-*
  $('[data-src], [data-player], [data-url]').each((_, el) => {
    const raw   = $(el).attr('data-src') || $(el).attr('data-player') || $(el).attr('data-url') || ''
    const label = $(el).text().trim().toLowerCase()
    let embedUrl = raw
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8')
      if (decoded.startsWith('http')) embedUrl = decoded
    } catch (_) {}
    if (embedUrl.startsWith('http') && !servidores.find(s => s.url === embedUrl))
      servidores.push({ nombre: label || detectarServidor(embedUrl), url: embedUrl })
  })

  // ── 3. Iframes directos ─────────────────────────────────────────────────
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src') || ''
    if (src.startsWith('http') && !servidores.find(s => s.url === src))
      servidores.push({ nombre: detectarServidor(src), url: src })
  })

  // ── 4. Scripts inline (fallback) ────────────────────────────────────────
  if (servidores.length === 0) extraerUrlsDeScripts($, html, servidores)

  console.log(`[latanime] ${servidores.length} servidor(es):`, servidores.map(s => s.nombre).join(', '))
  return servidores
}

// ── Genérico ──────────────────────────────────────────────────────────────────
async function scrapeGenerico(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)
  const servidores = []
  const intercepted = html.match(/INTERCEPTED_VIDEO:(https?:\/\/[^\s"<>\n]+)/)
  if (intercepted) servidores.push({ nombre: detectarServidor(intercepted[1]), url: intercepted[1], directo: true })
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    const matchArr = code.match(/var\s+videos\s*=\s*(\[[\s\S]*?\]);/)
    if (matchArr) {
      try {
        const lista = JSON.parse(matchArr[1])
        for (const item of lista) {
          if (Array.isArray(item) && typeof item[1] === 'string' && item[1].startsWith('http'))
            servidores.push({ nombre: String(item[0]).toLowerCase() || detectarServidor(item[1]), url: item[1] })
          else if (item?.file?.startsWith('http'))
            servidores.push({ nombre: item.label?.toLowerCase() || detectarServidor(item.file), url: item.file })
        }
      } catch (_) {}
    }
    if (servidores.length === 0) {
      const matchObj = code.match(/var\s+videos\s*=\s*(\{[\s\S]*?\});/)
      if (matchObj) {
        try {
          const data = JSON.parse(matchObj[1])
          const lista = data.SUB || data.LAT || data.ESP || []
          for (const s of lista) {
            const videoUrl = s.url || s.code || s.file
            if (videoUrl) servidores.push({ nombre: s.title?.toLowerCase() || detectarServidor(videoUrl), url: videoUrl })
          }
        } catch (_) {}
      }
    }
    const jwRe = /file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi
    let mj
    while ((mj = jwRe.exec(code)) !== null) {
      if (!servidores.find(s => s.url === mj[1]))
        servidores.push({ nombre: detectarServidor(mj[1]), url: mj[1], directo: true })
    }
  })
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src')
    if (src?.startsWith('http')) servidores.push({ nombre: detectarServidor(src), url: src })
  })
  extraerUrlsDeScripts($, html, servidores)
  return servidores
}

// ── TioAnime ──────────────────────────────────────────────────────────────────
// NUEVO — fuente: stremio-addon/routes/tioanime.js & tioanime-master/src/api.js
// Formato: var videos = [[server, url], ...] (array de arrays)
async function scrapeTioAnime(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)
  const servidores = []
  const intercepted = html.match(/INTERCEPTED_VIDEO:(https?:\/\/[^\s"<>\n]+)/)
  if (intercepted) servidores.push({ nombre: detectarServidor(intercepted[1]), url: intercepted[1], directo: true })

  $('script').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('var videos')) return

    // TioAnime: var videos = [[server, url], [server, url], ...]
    const m = code.match(/var videos\s*=\s*(\[\[.*?\]\])/s)
    if (m) {
      try {
        const lista = JSON.parse(m[1])
        for (const item of lista) {
          if (Array.isArray(item) && typeof item[1] === 'string' && item[1].startsWith('http')) {
            const nombre = String(item[0]).toLowerCase() || detectarServidor(item[1])
            const u = normalizarMegaUrl(item[1])
            if (!servidores.find(s => s.url === u))
              servidores.push({ nombre, url: u })
          }
        }
      } catch (_) {}
    }

    // Fallback: array simple o {SUB:[...]}
    if (servidores.length === 0) {
      const mArr = code.match(/var\s+videos\s*=\s*(\[[\s\S]*?\]);/)
      if (mArr) {
        try {
          const lista = JSON.parse(mArr[1])
          for (const item of lista) {
            const u = normalizarMegaUrl(item?.url || item?.file || item?.code || '')
            const n = item?.title || item?.label || item?.server || detectarServidor(u)
            if (u?.startsWith('http') && !servidores.find(s => s.url === u))
              servidores.push({ nombre: n.toLowerCase(), url: u })
          }
        } catch (_) {}
      }
    }
  })

  console.log(`[tioanime] ${servidores.length} servidor(es):`, servidores.map(s => `${s.nombre}=${s.url.slice(0,50)}`).join(' | '))

  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src')
    if (src?.startsWith('http') && !servidores.find(s => s.url === src))
      servidores.push({ nombre: detectarServidor(src), url: src })
  })

  extraerUrlsDeScripts($, html, servidores)
  return servidores
}

// ── JKanime ───────────────────────────────────────────────────────────────────
// La tabla "Enlaces de descarga" se renderiza con JavaScript, por lo que
// se necesita Puppeteer para ver los servidores reales.
// El flujo es: página carga → XHR con lista de descargas → tabla DOM con nombres.
async function scrapeJKanime(url) {
  const servidores = []

  // ── Resolución de redirect (jkplayers → URL real) ──────────────────────────
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
        // parar si ya salimos de jkplayers
        if (!current.includes('jkplayers.com')) break
      }
    } catch (_) {}
    return current
  }

  // ── Estrategia 0: Puppeteer — tabla de descargas renderizada ───────────────
  const jkMatch = url.match(/jkanime\.net\/([^/]+)\/(\d+)/)
  const slug    = jkMatch?.[1]
  const cap     = jkMatch?.[2]

  try {
    const chromiumPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/data/data/com.termux/files/usr/bin/chromium-browser',
      '/data/data/com.termux/files/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ].filter(Boolean)
    let execPath = null
    for (const p of chromiumPaths) { if (fs.existsSync(p)) { execPath = p; break } }
    if (!execPath) throw new Error('Chromium no disponible')

    const browser = await puppeteerExtra.launch({
      headless      : 'new',
      executablePath: execPath,
      args          : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setUserAgent(randomUA())
    await page.setExtraHTTPHeaders(buildHeaders({ Referer: 'https://jkanime.net/' }))

    // Bloquear recursos pesados para acelerar
    await page.setRequestInterception(true)
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort()
      else req.continue()
    })

    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }) } catch (_) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch (_) {}
    }

    // Esperar a que la tabla de descargas aparezca en el DOM
    try { await page.waitForSelector('table tr td a[href]', { timeout: 8000 }) } catch (_) {}

    // Extraer filas de la tabla "Enlaces de descarga"
    // Estructura: <tr><td>NombreServidor</td><td>Tamaño</td><td>Audio</td><td><a href="...">Descargar HD</a></td></tr>
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
      // Resolver redirects en paralelo (jkplayers → mega/mediafire/etc.)
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
      if (servidores.length > 0) {
        console.log(`[jkanime] ${servidores.length} URLs resueltas`)
        return servidores
      }
    }
  } catch (e) { console.error('[jkanime] Puppeteer tabla:', e.message) }

  // ── Estrategia 1: API oficial /ajax/episode/2/ + decodificar remote ────────
  if (slug && cap) {
    const SERVIDORES_JK = ['sw', 'jkvideo', 'okru', 'stape', 'mp4upload', 'filemoon', 'voe', 'uqload', 'doodstream', 'vidhide', 'mixdrop', 'streamwish']
    const headers = { ...buildHeaders({ Referer: url }), 'X-Requested-With': 'XMLHttpRequest' }

    for (const srv of SERVIDORES_JK) {
      try {
        const apiUrl = `https://jkanime.net/ajax/episode/2/?id=${slug}&cap=${cap}&server=${srv}`
        const res    = await fetch(apiUrl, { headers, timeout: 12000 })
        if (!res.ok) continue
        const json   = await res.json()

        // Campo remote en base64
        if (json?.remote) {
          try {
            let d = json.remote
            const pad = 4 - (d.length % 4)
            if (pad !== 4) d += '='.repeat(pad)
            const decoded = Buffer.from(d, 'base64').toString('utf-8').trim()
            if (decoded.startsWith('http') && !servidores.find(s => s.url === decoded)) {
              // Seguir el redirect para salir de jkplayers
              const finalUrl = decoded.includes('jkplayers.com') ? await resolverRedirect(decoded) : decoded
              console.log(`[jkanime] API ${srv}: ${finalUrl.slice(0, 60)}`)
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
          console.log(`[jkanime] API ${srv}: ${finalUrl.slice(0, 60)}`)
          servidores.push({ nombre: srv, url: normalizarMegaUrl(finalUrl) })
        }
      } catch (e) { console.error(`[jkanime] API ${srv}:`, e.message) }
    }
  }

  console.log(`[jkanime] ${servidores.length} servidor(es) encontrados`)
  return servidores
}

// ─── Helpers para filtrar temporada ──────────────────────────────────────────

function elegirPorTemporada(links, temporada) {
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

// ─── Funciones de búsqueda ────────────────────────────────────────────────────

// ── AnimeFLV ──────────────────────────────────────────────────────────────────
// Mejorado: CSS selectors correctos, soporte DUB/SUB en label, slug robusto
// Fuente: stremio-addon/routes/animeFLV.js > SearchAnimesBySpecificURL
async function buscarEnAnimeFLV(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} ${temporada}` : nombre
  const html = await fetchHtml(`https://www3.animeflv.net/browse?q=${encodeURIComponent(query)}`)
  const $ = cheerio.load(html)

  const links = []
  // Selectores AnimeFLV: ul.ListAnimes li  (fuente: stremio addon scrapSearchAnimeData)
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

// ── LatAnime ──────────────────────────────────────────────────────────────────
async function buscarEnLatAnime(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} temporada ${temporada}` : nombre
  const html  = await fetchHtml(`https://latanime.org/?s=${encodeURIComponent(query)}`)
  const $     = cheerio.load(html)

  const links = []
  // Solo tomar links /ver/ que incluyan "-episodio-" o links de anime
  $('a[href*="/ver/"]').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
    // Filtrar links que sean de episodios o de páginas de anime
    if (href.includes('latanime.org') || href.startsWith('/ver/')) {
      links.push({ href, title })
    }
  })
  // También buscar en cards de resultados
  $('article a, .card a, .anime-item a').each((_, el) => {
    const href  = $(el).attr('href') || ''
    const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
    if (href && !links.find(l => l.href === href)) links.push({ href, title })
  })

  if (links.length === 0) return null

  // Usar mejorMatch para elegir el resultado más parecido al nombre buscado
  const elegido   = mejorMatch(links, nombre) || elegirPorTemporada(links, temporada) || links[0]
  // Extraer slug base sin número de episodio
  const slugMatch = elegido.href.match(/\/ver\/([^/]+?)(?:-episodio-\d+)?(?:\/|$)/)
  if (!slugMatch) return null
  const slugBase = slugMatch[1].replace(/-episodio-\d+$/, '')
  return `https://latanime.org/ver/${slugBase}-episodio-${episodio}`
}

// ── JKanime ───────────────────────────────────────────────────────────────────
// Mejorado: usa el mismo flujo que JKAnimeClient (Python), incluyendo slug directo
async function buscarEnJKanime(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} temporada ${temporada}` : nombre

  // Estrategia 1: API interna
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

  // Estrategia 2: HTML search
  try {
    const html  = await fetchHtml(`https://jkanime.net/buscar/?q=${encodeURIComponent(query)}`)
    const $     = cheerio.load(html)
    const links = []
    // Selectores específicos de resultados de búsqueda JKanime
    $('.anime__item, .col-lg-2, .card, article').each((_, el) => {
      const aTag  = $(el).find('a').first()
      const href  = aTag.attr('href') || ''
      const title = (aTag.attr('title') || $(el).find('h3, h5, .title').text() || aTag.text()).trim().toLowerCase()
      // Solo URLs tipo jkanime.net/slug-del-anime/
      if (href.match(/jkanime\.net\/[a-z0-9][a-z0-9-]+\/?$/) && title) {
        links.push({ href, title })
      }
    })
    // Fallback: cualquier link con slug válido
    if (links.length === 0) {
      $('a[href*="jkanime.net/"]').each((_, el) => {
        const href  = $(el).attr('href') || ''
        const title = ($(el).attr('title') || $(el).text()).trim().toLowerCase()
        const slug  = href.match(/jkanime\.net\/([a-z0-9][a-z0-9-]+)\/?$/)?.[1]
        // Excluir páginas de sistema
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

  // Estrategia 3: Slug directo
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

// ── TioAnime ──────────────────────────────────────────────────────────────────
// NUEVO — fuente: stremio-addon/routes/tioanime.js > SearchTioAnime + GetEpisodeLinks
// URL de episodio: /ver/<slug>-<ep>
async function buscarEnTioAnime(nombre, episodio, temporada = 1) {
  const query = temporada > 1 ? `${nombre} ${temporada}` : nombre
  // Directorio con año y estado requeridos (como en tioanime.js)
  const searchUrl = `https://tioanime.com/directorio?q=${encodeURIComponent(query)}&year=1950%2C2026&status=2&sort=recent`
  const html = await fetchHtml(searchUrl)
  const $    = cheerio.load(html)

  const links = []
  // Selectores TioAnime (fuente: tioanime.js > scrapSearchAnimeData)
  $('main > ul > li, #tioanime > div > div ul > li').each((_, el) => {
    const $el   = $(el)
    const aTag  = $el.find('a').first()
    const href  = aTag.attr('href') || ''
    const title = ($el.find('h3').text() || aTag.text() || '').trim().toLowerCase()
    if (href.includes('/anime/')) links.push({ href, title })
  })

  if (links.length === 0) return null

  const elegido   = elegirPorTemporada(links, temporada) || mejorMatch(links, nombre)
  const slugMatch = elegido.href.match(/\/anime\/([^/]+)/)
  if (!slugMatch) return null
  const slug = slugMatch[1]
  return `https://tioanime.com/ver/${slug}-${episodio}`
}

// ─── Descarga con yt-dlp ──────────────────────────────────────────────────────

class MegaQuotaError extends Error {
  constructor() { super('EOVERQUOTA'); this.name = 'MegaQuotaError' }
}

// Descarga dedicada Mega — reutilizable desde el loop de servidores
async function descargarMega(url, m, tmpDir) {
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

async function descargarConYtDlp(embedUrl, outputDir) {
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
        // Incluir stdout también porque yt-dlp a veces escribe el error ahí
        const fullLog = [stderrBuf, stdoutBuf]
          .map(s => s.trim()).filter(Boolean).join('\n')
        const msg = fullLog || `yt-dlp salió con código ${code}`
        console.error(`\n[yt-dlp] ❌ FALLO (código ${code}):\n${msg}\n`)
        reject(new Error(msg))
      }
    })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })

  const archivos = fs.readdirSync(outputDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f))
  if (archivos.length === 0) throw new Error('yt-dlp no genero ningun archivo')
  return path.join(
    outputDir,
    archivos.map(f => ({ f, t: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0].f
  )
}

// ─── Ejecutar descarga desde un servidor específico (o fallar al siguiente) ───

async function ejecutarDescargaServidor(listaIntentos, indiceInicio = 0, pick, m, conn) {
  const { tmpDir, sitioElegido, argsParaAnime } = pick
  let archivoPath = null

  // Crear UN mensaje de estado que se editará en cada paso (sin spam)
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
      // Si el edit falla, intentar nuevo mensaje
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

    // Saltar dominios sin soporte real
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
            mfLastTime  = now
            mfLastDld   = dld
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

      // ── Savefiles ─────────────────────────────────────────────────────────
      if (/savefiles\.net|savefiles\.io/.test(u)) {
        await updateStatus(`💾 *Savefiles* detectado — descargando...`)
        const { default: axios } = await import('axios')
        const sfRes = await axios.get(srv.url, { headers: { 'User-Agent': randomUA(), 'Referer': 'https://savefiles.net/' }, httpsAgent, timeout: 15000 })
        const sfHtml = sfRes.data
        const sfLink =
          sfHtml.match(/href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|webm)[^"']*)["']/i)?.[1] ||
          sfHtml.match(/window\.location\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1]
        if (!sfLink) throw new Error('Savefiles: no encontré URL de descarga')
        archivoPath = await descargarConYtDlp(sfLink, tmpDir)
        break
      }

      // ── Gofile ────────────────────────────────────────────────────────────
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

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, text, args, usedPrefix, command }) => {

  // ── .anilist ──────────────────────────────────────────────────────────────
  if (command === 'anilist') {
    const lista = SITIOS.map(s => `*${s.id}.* ${s.nombre}\n   🔗 ${s.url}`).join('\n\n')
    return m.reply(
      `*🎌 Sitios de Anime Disponibles*\n\n${lista}\n\n` +
      `*¿Cómo usar?*\n` +
      `• *.animedl <nombre> <ep>*\n` +
      `• *.animedl <nombre> t<N> <ep>*\n` +
      `• *.animedl <S> <nombre> t<N> <ep>*\n\n` +
      `*Ejemplos:*\n` +
      `  .animedl one piece 1100\n` +
      `  .animedl shingeki no kyojin t4 1\n` +
      `  .animedl 7 naruto shippuden t2 30\n\n` +
      `_t<N> = temporada. Sin t = temporada 1_`
    )
  }

  // ── .cancelar / .stop ─────────────────────────────────────────────────────
  if (command === 'cancelar' || command === 'stop') {
    const quotedMsgId = m.quoted?.id
    if (!quotedMsgId) return m.reply(`❌ Responde al mensaje de progreso de la descarga.`)
    const dl = global.activeDownloads.get(quotedMsgId)
    if (!dl) return m.reply(`❌ No hay descarga activa para ese mensaje.`)
    dl.controller.abort()
    global.activeDownloads.delete(quotedMsgId)
    return m.reply(`🚫 Descarga cancelada.`)
  }

  // ── Selección de anime de búsqueda con letra (texto plano web/desktop) ─────
  const letraInput = text?.trim().toLowerCase()
  if (/^[a-z]$/.test(letraInput)) {
    const animeSearch = global.pendingAnimeSearch.get(m.chat)
    if (animeSearch) {
      if (animeSearch.owner && animeSearch.owner !== m.sender) {
        return conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, esta selección pertenece a otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
      }
      const idxSearch = letraInput.charCodeAt(0) - 97  // a=0, b=1, …
      const elegido   = animeSearch.resultados[idxSearch]
      if (!elegido) return m.reply(`❌ Letra inválida. Elige entre *a* y *${numToLetter(animeSearch.resultados.length - 1)}*.`)
      global.pendingAnimeSearch.delete(m.chat)
      return mostrarInfoYEpisodios(elegido, m, conn, usedPrefix, animeSearch.temporada)
    }
  }

  // ── Selección de servidor pendiente (.dl <número|letra> o .animedl <número|letra>) ─
  if ((command === 'animedl' || command === 'dl') && /^(\d+|[a-z])$/i.test(text?.trim())) {
    const pick = global.pendingServerPicks.get(m.chat)
    if (pick) {
      // Solo el usuario que inició puede elegir
      if (pick.owner && pick.owner !== m.sender) {
        return conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, esta selección pertenece a otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
      }
      const raw = text.trim().toLowerCase()
      const num = /^[a-z]$/.test(raw) ? raw.charCodeAt(0) - 96 : parseInt(raw)  // a=1, b=2, …
      if (num < 1 || num > pick.servers.length) {
        return m.reply(`❌ Selección inválida. Elige entre *a* y *${numToLetter(pick.servers.length - 1)}* (o *1*–*${pick.servers.length}*).`)
      }
      global.pendingServerPicks.delete(m.chat)
      const sk = `${m.chat}|${m.sender}`
      delete global.animeDlSessions[sk]
      guardarPicks()
      return ejecutarDescargaServidor(pick.servers, num - 1, pick, m, conn)
    }
  }

  // ── Sin argumentos → ayuda ────────────────────────────────────────────────
  if (!text || !text.trim()) {
    return m.reply(
      `*🎌 Descargador de Anime + Archivos*\n\n` +
      `*Comandos:*\n` +
      `• *.anilist* — Ver sitios disponibles (${SITIOS.length} sitios)\n` +
      `• *.animedl <nombre> <ep>* — Buscar en todos\n` +
      `• *.animedl <nombre> t<N> <ep>* — Temporada N\n` +
      `• *.animedl <S> <nombre> t<N> <ep>* — Sitio S + temporada N\n` +
      `• *.animedl <url>* — URL directa del episodio\n` +
      `• *.animedl <url mega/mediafire>* — Descargar archivo\n\n` +
      `*Ejemplos:*\n` +
      `  .animedl shingeki no kyojin t4 1\n` +
      `  .animedl 7 tioanime naruto 1\n\n` +
      `_Usa .anilist para ver los números de sitio_`
    )
  }

  // ── Mega / MediaFire ──────────────────────────────────────────────────────
  const rawArg      = (args?.[0] || text?.trim() || '')
  const isMega      = /mega\.nz/.test(rawArg)
  const isMediaFire = /mediafire\.com/.test(rawArg)

  if (isMega || isMediaFire) {
    const { default: axios } = await import('axios')
    const controller = new AbortController()
    const { signal } = controller
    let tempPath, msgId

    try {
      const { key } = await m.reply(`⏳ *Preparando descarga...*`)
      msgId = key.id
      global.activeDownloads.set(msgId, { controller })

      if (isMega) {
        const tmpMega = path.join(process.env.TMPDIR || '/tmp', `mega_ytdlp_${Date.now()}`)
        fs.mkdirSync(tmpMega, { recursive: true })

        // Variables de archivo — necesarias tanto si usa yt-dlp como megajs
        let megaFileName = null
        let megaSizeH    = null

        // Intentar yt-dlp primero
        let usedYtDlp = false
        try {
          await conn.sendMessage(m.chat, { text: `📥 *Mega:* descargando con yt-dlp...`, edit: key })
          tempPath = await descargarConYtDlp(rawArg, tmpMega)
          megaFileName = path.basename(tempPath)
          megaSizeH    = (fs.statSync(tempPath).size / 1024 / 1024).toFixed(2) + ' MB'
          usedYtDlp = true
        } catch (ytErr) {
          console.log(`[mega] yt-dlp falló (${ytErr.message.slice(0, 60)}), usando megajs...`)
          fs.rmSync(tmpMega, { recursive: true, force: true })
        }

        // Fallback: megajs
        if (!usedYtDlp) {
          let file
          try {
            file = MegaFile.fromURL(rawArg)
            await file.loadAttributes()
          } catch (err) { return m.reply(parseMegaError(err)) }

          megaFileName = file.name
          megaSizeH    = (file.size / 1024 / 1024).toFixed(2) + ' MB'
          await conn.sendMessage(m.chat, { text: `📥 *Mega:* ${megaFileName}\n⚖️ ${megaSizeH}\n\n_Descargando..._`, edit: key })
          tempPath = path.join(process.env.TMPDIR || '/tmp', `mega_${Date.now()}_${megaFileName}`)

          let fileStream
          try { fileStream = file.download({ signal }) }
          catch (err) { return m.reply(parseMegaError(err)) }

          let dld = 0
          fileStream.on('data', (chunk) => {
            dld += chunk.length
            process.stdout.write(`\r[MEGA] ${((dld / file.size) * 100).toFixed(1)}% | ${(dld / 1024 / 1024).toFixed(2)} MB`)
          })
          try {
            await pipeline(fileStream, fs.createWriteStream(tempPath), { signal })
          } catch (err) {
            if (err.name === 'AbortError') throw err
            return m.reply(parseMegaError(err))
          }
        }

        await conn.sendMessage(m.chat, { text: `⬆️ Subiendo a WhatsApp...`, edit: key })
        await conn.sendMessage(m.chat, {
          document: { url: tempPath },
          fileName: megaFileName,
          mimetype: mimeLookup(megaFileName) || 'application/octet-stream',
          caption: `✅ *${megaFileName}*\n⚖️ ${megaSizeH}`,
        }, { quoted: m })

      } else {
        let mfData
        try { mfData = await mediafireDl(rawArg) }
        catch (err) { return m.reply(`❌ Error MediaFire: ${err.message}`) }
        if (!mfData.link) return m.reply(`❌ No encontré el enlace de descarga.`)

        const { name, link: downloadUrl } = mfData
        let sizeBytes = 0
        try {
          const ax   = await import('axios')
          const head = await ax.default.head(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, httpsAgent, signal })
          sizeBytes  = parseInt(head.headers['content-length'] || '0')
        } catch (_) {}
        const sizeH = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '?'

        await conn.sendMessage(m.chat, { text: `📥 *MediaFire:* ${name}\n⚖️ ${sizeH}\n\n_Descargando..._`, edit: key })
        tempPath = path.join(process.env.TMPDIR || '/tmp', `mf_${Date.now()}_${name}`)

        const ax2      = await import('axios')
        const response = await ax2.default({ method: 'get', url: downloadUrl, responseType: 'stream', signal, httpsAgent })
        let dld = 0, mfLastTime = Date.now(), mfLastDld = 0
        response.data.on('data', (chunk) => {
          dld += chunk.length
          const now = Date.now()
          const dt  = (now - mfLastTime) / 1000
          if (dt >= 0.5) {
            const speed = ((dld - mfLastDld) / dt / 1024 / 1024).toFixed(1)
            mfLastTime  = now
            mfLastDld   = dld
            const p     = sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) : '?'
            const dlMB  = (dld / 1024 / 1024).toFixed(1)
            const totMB = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : '?'
            process.stdout.write(`\r[MediaFire] ${p}% | ${dlMB} MB / ${totMB} MB | ${speed} MB/s`)
          }
        })
        await pipeline(response.data, fs.createWriteStream(tempPath), { signal })
        console.log(`\n[MediaFire] ✅ ${name}`)

        await conn.sendMessage(m.chat, { text: `⬆️ Subiendo a WhatsApp...`, edit: key })
        await conn.sendMessage(m.chat, {
          document: { url: tempPath },
          fileName: name,
          mimetype: mimeLookup(name) || 'application/octet-stream',
          caption: `✅ *${name}*\n⚖️ ${sizeH}`,
        }, { quoted: m })
      }

      global.activeDownloads.delete(msgId)
    } catch (err) {
      console.error('[animedl] Error:', err)
      if (err.name !== 'AbortError') await m.reply(`❌ Error: ${err.message}`)
      if (msgId) global.activeDownloads.delete(msgId)
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
    return
  }

  // ── Lógica principal de anime ─────────────────────────────────────────────
  const rawArgs = text.trim().split(/\s+/)

  // Paso 1: detectar número de sitio al inicio (opcional)
  let sitioElegido  = null
  let argsParaAnime = rawArgs

  if (/^\d+$/.test(rawArgs[0]) && rawArgs.length >= 3) {
    const idNum           = parseInt(rawArgs[0])
    const sitioCandidate  = getSitioPorId(idNum)
    if (sitioCandidate && !isNaN(rawArgs[rawArgs.length - 1])) {
      sitioElegido  = sitioCandidate
      argsParaAnime = rawArgs.slice(1)
    }
  }

  let episodeUrl = null

  // Modo URL directa
  if (argsParaAnime[0]?.startsWith('http')) {
    episodeUrl   = argsParaAnime[0]
    sitioElegido = getSitioPorDominio(episodeUrl)
  } else {
    // Paso 2: extraer episodio (último token numérico) o detectar modo "sin episodio"
    const lastToken = argsParaAnime[argsParaAnime.length - 1]
    const episodio  = isNaN(lastToken) ? null : parseInt(lastToken)

    // ── Modo "sin episodio": .animedl <nombre> → info + lista de episodios ──
    if (episodio === null) {
      let tokensSinEp = [...argsParaAnime]
      let temporada   = 1
      const tempIdx2  = tokensSinEp.findIndex(t => /^t(?:emperada|emp)?(\d+)$/i.test(t))
      if (tempIdx2 !== -1) {
        temporada    = parseInt(tokensSinEp[tempIdx2].match(/(\d+)/)[1])
        tokensSinEp  = tokensSinEp.filter((_, i) => i !== tempIdx2)
      }
      const nombreBusq = tokensSinEp.join(' ')
      if (!nombreBusq) return m.reply(`❌ Escribe el nombre del anime.\nEjemplo: *.animedl naruto*`)

      // Mensaje de estado que se irá editando en todo el flujo
      const { key: statusKey } = await m.reply(`🔎 Buscando *${nombreBusq}*...`)
      const editStatus = async (txt) => {
        try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }) } catch (_) {}
      }

      const resultados = await buscarResultadosAnimeFLV(nombreBusq, temporada)

      if (resultados.length === 0) {
        return editStatus(
          `❌ No encontré ningún anime llamado *${nombreBusq}*.\n\n` +
          `Prueba con el sitio + episodio:\n  ${usedPrefix}animedl ${nombreBusq} 1`
        )
      }

      // Un único resultado o match exacto → info + episodios (editando el mismo mensaje)
      if (resultados.length === 1 || puntuarMatch(resultados[0].title, nombreBusq) >= 85) {
        return mostrarInfoYEpisodios(resultados[0], m, conn, usedPrefix, temporada, statusKey)
      }

      // Múltiples resultados → editar estado + lista interactiva
      await editStatus(`🔍 *${resultados.length} resultados para "${nombreBusq}"* — elige uno:`)

      const maxR = Math.min(resultados.length, 26)
      global.pendingAnimeSearch.set(m.chat, {
        resultados: resultados.slice(0, maxR),
        nombre    : nombreBusq,
        temporada,
        owner     : m.sender,
        timestamp : Date.now(),
        usedPrefix,
      })

      return enviarListaWA(conn, m, {
        title     : `🔍 Resultados para "${nombreBusq}"`,
        body      : `Encontré ${resultados.length} resultados. Elige el anime correcto:`,
        buttonText: 'ELEGIR ANIME',
        sections  : [{
          title: 'Animes encontrados',
          rows : resultados.slice(0, maxR).map(r => ({
            title      : r.title,
            description: r.sitio?.nombre || 'AnimeFLV',
            id         : `__animeselect__${r.slug}`,
          })),
        }],
      })
    }

    // Paso 3: detectar temporada tN
    let temporada  = 1
    let tokensSinEp = argsParaAnime.slice(0, -1)

    const tempIdx = tokensSinEp.findIndex(t => /^t(?:emperada|emp)?(\d+)$/i.test(t))
    if (tempIdx !== -1) {
      const match = tokensSinEp[tempIdx].match(/(\d+)/)
      temporada   = parseInt(match[1])
      tokensSinEp = tokensSinEp.filter((_, i) => i !== tempIdx)
    }

    const nombre = tokensSinEp.join(' ')
    if (!nombre) return m.reply(`❌ Falta el nombre del anime.\nEjemplo: *.animedl one piece t1 1*`)

    // Paso 4: búsqueda
    const labelTemp  = temporada > 1 ? ` temporada *${temporada}*` : ''
    const labelSitio = sitioElegido ? ` en *${sitioElegido.nombre}*` : ' en todos los sitios'

    await m.reply(`🔎 Buscando *${nombre}*${labelTemp} ep *${episodio}*${labelSitio}...`)

    if (sitioElegido) {
      episodeUrl = await sitioElegido.buscar(nombre, episodio, temporada)
      if (!episodeUrl) {
        const tSuffix = temporada > 1 ? ` t${temporada}` : ''
        return m.reply(
          `❌ No encontré *${nombre}* ep *${episodio}*${temporada > 1 ? ` (temporada ${temporada})` : ''} en *${sitioElegido.nombre}*.\n\n` +
          `Prueba con otro sitio:\n` +
          SITIOS.filter(s => s.id !== sitioElegido.id)
                .map(s => `  .animedl ${s.id} ${nombre}${tSuffix} ${episodio}`)
                .join('\n')
        )
      }
    } else {
      for (const sitio of SITIOS) {
        try {
          episodeUrl = await sitio.buscar(nombre, episodio, temporada)
          if (episodeUrl) {
            sitioElegido = sitio
            await m.reply(`✅ Encontrado en *${sitio.nombre}*`)
            break
          }
        } catch (err) { console.error(`[busqueda] ${sitio.nombre}:`, err.message) }
      }
      if (!episodeUrl) {
        return m.reply(
          `❌ No encontré *${nombre}* ep *${episodio}*${temporada > 1 ? ` (temporada ${temporada})` : ''} en ningún sitio.\n` +
          `Prueba con la URL directa del episodio.`
        )
      }
    }
  }

  await m.reply(
    `📡 Extrayendo servidores de *${sitioElegido?.nombre || 'sitio desconocido'}*...\n` +
    `🔗 ${episodeUrl}`
  )

  let servidores = []
  try {
    servidores = sitioElegido?.scrape
      ? await sitioElegido.scrape(episodeUrl)
      : [{ nombre: 'directo', url: episodeUrl, directo: true }]
  } catch (err) {
    return m.reply(`❌ Error al analizar la página:\n\`${err.message}\``)
  }

  if (servidores.length === 0) {
    return m.reply('❌ No encontré servidores de video en esa página.')
  }

  // ── Prioridad: Mega y MediaFire siempre al frente ──────────────────────────
  const esMegaMf  = s => /mega\.nz|mega\.co\.nz|mediafire\.com/.test(s.url)
  const megaYMf   = servidores.filter(s =>  esMegaMf(s))
  const sinMegaMf = servidores.filter(s => !esMegaMf(s))
  const directas  = sinMegaMf.filter(s => s.directo && CONFIG.videoExtensions.test(s.url))
  const listaIntentos = [
    ...megaYMf,
    ...(directas.length > 0
      ? [...directas, ...sinMegaMf.filter(s => !s.directo)]
      : sinMegaMf),
  ]

  // ── Mostrar lista de servidores con botones interactivos ─────────────────
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', `anime_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const servidorEmojis = { mega: '📦', mediafire: '📦', mp4upload: '📹', filemoon: '🌙',
    streamwish: '⭐', streamtape: '📼', doodstream: '🟣', voe: '🟠', upstream: '🔵',
    okru: '🔴', vidhide: '🟡', mixdrop: '🔵', generico: '🎬',
    savefiles: '💾', gofile: '💾', byse: '⭐', dsvplay: '▶️', lulu: '⭐' }
  const emoji = (nombre) => {
    const n = nombre?.toLowerCase() || ''
    return Object.entries(servidorEmojis).find(([k]) => n.includes(k))?.[1] || '🎬'
  }

  // Guardar pick con owner ANTES de enviar el mensaje
  const sessionKey = `${m.chat}|${m.sender}`
  global.pendingServerPicks.set(m.chat, {
    servers     : listaIntentos,
    tmpDir,
    sitioElegido,
    argsParaAnime,
    timestamp   : Date.now(),
    owner       : m.sender,
  })
  global.animeDlSessions[sessionKey] = {
    owner : m.sender,
    chat  : m.chat,
    expiry: Date.now() + 10 * 60 * 1000,   // 10 min para elegir
  }
  guardarPicks()

  // Intentar interactiveMessage en móvil, fallback a texto en desktop/web
  const device   = getDevice(m.key.id)
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile) {
    try {
      const filas = listaIntentos.map((s, i) => ({
        header     : `${emoji(s.nombre)} ${s.nombre.toUpperCase()}`,
        title      : `${emoji(s.nombre)} ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`,
        description: s.directo ? 'Link directo — más rápido' : 'Servidor de streaming',
        id         : `${usedPrefix}dl ${i + 1}`,
      }))

      const interactiveMessage = {
        body  : { text: `✅ = link directo (más rápido)\nElige el servidor para descargar.` },
        footer: { text: global.wm || 'Kana Arima Bot' },
        header: { title: `🎬 ${sitioElegido?.nombre || 'Anime'} — ${listaIntentos.length} servidores`, hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title   : 'ELEGIR SERVIDOR',
              sections: [{
                title          : 'Servidores disponibles',
                highlight_label: '',
                rows           : filas,
              }],
            }),
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
    } catch (err) {
      console.error('[animedl interactiveMsg]', err.message)
      const listaTxt = listaIntentos
        .map((s, i) => `${emoji(s.nombre)} *${numToLetter(i)}.* ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`)
        .join('\n')
      await m.reply(
        `🎬 *${sitioElegido?.nombre || 'Anime'} — Servidores (${listaIntentos.length}):*\n\n` +
        `${listaTxt}\n\n✅ = directo\n_Responde con_ *.dl <letra>* (ej: *.dl a*)`
      )
    }
  } else {
    const listaTxt = listaIntentos
      .map((s, i) => `${emoji(s.nombre)} *${numToLetter(i)}.* ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`)
      .join('\n')
    await m.reply(
      `🎬 *${sitioElegido?.nombre || 'Anime'} — Servidores (${listaIntentos.length}):*\n\n` +
      `${listaTxt}\n\n✅ = directo\n_Responde con_ *.dl <letra>* (ej: *.dl a*)`
    )
  }
}

handler.before = async function (m, { conn }) {
  const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (nativeFlow) {
    try {
      const params     = JSON.parse(nativeFlow.paramsJson || '{}')
      const selectedId = params?.id || null
      if (!selectedId) return false

      // ── Selección de anime desde lista de búsqueda ──────────────────────────
      if (selectedId.startsWith('__animeselect__')) {
        const slug        = selectedId.replace('__animeselect__', '')
        const animeSearch = global.pendingAnimeSearch.get(m.chat)
        if (!animeSearch) return false

        if (animeSearch.owner && animeSearch.owner !== m.sender) {
          await conn.sendMessage(m.chat,
            { text: `⛔ @${m.sender.split('@')[0]}, estos botones son de otro usuario.` },
            { quoted: m, mentions: [m.sender] }
          )
          return true
        }

        global.pendingAnimeSearch.delete(m.chat)
        const elegido = animeSearch.resultados.find(r => r.slug === slug)
        if (!elegido) return false

        await mostrarInfoYEpisodios(elegido, m, conn, animeSearch.usedPrefix || '.', animeSearch.temporada)
        return true
      }

      const pick = global.pendingServerPicks.get(m.chat)
      if (!pick) return false

      // Solo el owner puede usar los botones
      if (pick.owner && pick.owner !== m.sender) {
        await conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, estos botones son de otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
        return true
      }

      // Inyectar el comando (.dl N) para que el handler principal lo procese
      const sk = `${m.chat}|${m.sender}`
      delete global.animeDlSessions[sk]
      m.text = selectedId.trim()
    } catch (_) {}
    return false
  }
  return false
}

handler.help    = ['animedl <nombre> [tN] <ep>', 'animedl <S> <nombre> [tN] <ep>', 'anilist']
handler.tags    = ['descargas']
handler.command = /^(animedl|dl|anilist|cancelar|stop)$/i

// Restaurar picks pendientes al cargar el plugin (sobrevive reinicios)
cargarPicks()

export default handler
