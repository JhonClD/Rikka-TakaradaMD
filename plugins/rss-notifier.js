import axios from 'axios'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const cheerio = require('cheerio')

const POLL_INTERVAL_MS    = 10 * 60 * 1000
const MAX_FEEDS_PER_CHAT  = 10
const MAX_SEEN_GUIDS      = 300
const REQUEST_TIMEOUT     = 20_000
const MAX_SEND_PER_TICK   = 3
const SEND_DELAY_MS       = 1_500
const TRANSLATE_TIMEOUT   = 8_000
const TRANSLATE_CACHE_MAX = 500
const TRANSLATE_MIN_GAP   = 120
const VER_LIMIT           = 5
const MAX_DESC_LEN        = 400
const MAX_HEADER_LEN      = 40

const _translateCache = new Map()
let _lastTranslateAt = 0

async function translateText(text, retries = 3) {
  if (!text) return text
  const input = String(text).trim()
  if (!input) return text

  const cached = _translateCache.get(input)
  if (cached) return cached

  for (let i = 0; i <= retries; i++) {
    try {
      const gap = Date.now() - _lastTranslateAt
      if (gap < TRANSLATE_MIN_GAP) {
        await new Promise(r => setTimeout(r, TRANSLATE_MIN_GAP - gap))
      }
      _lastTranslateAt = Date.now()

      const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: {
          client: 'gtx',
          sl: 'auto',
          tl: 'es',
          hl: 'es',
          dt: 't',
          q: input
        },
        timeout: TRANSLATE_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
        }
      })

      const chunks = res.data?.[0]
      if (Array.isArray(chunks) && chunks.length) {
        let translated = ''
        for (const chunk of chunks) {
          if (Array.isArray(chunk) && typeof chunk[0] === 'string') {
            translated += chunk[0]
          }
        }
        translated = translated.trim()
        if (translated) {
          if (_translateCache.size >= TRANSLATE_CACHE_MAX) {
            _translateCache.delete(_translateCache.keys().next().value)
          }
          _translateCache.set(input, translated)
          return translated
        }
      }
    } catch {
      if (i < retries) await new Promise(r => setTimeout(r, 800 * (i + 1)))
    }
  }
  return text
}

function getDB() {
  if (!global.db?.data) return null
  global.db.data.rss = global.db.data.rss || {}
  return global.db.data.rss
}

function feedsOf(chatId) {
  const db = getDB()
  if (!db) return null
  if (!Array.isArray(db[chatId])) db[chatId] = []
  return db[chatId]
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u)
}

function extractFirstImgSrc(html = '') {
  const m = html.match(/<img[^>]+src=["']([^"'>]+)["']/i)
  return m ? m[1] : null
}

function cleanDesc(raw) {
  if (!raw) return ''
  let s = String(raw)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<[^>]+>/g, ' ')
       .replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;|&#x27;/gi, "'")
       .replace(/&#(\d+);/g, (_, n) => {
         const c = parseInt(n, 10)
         return c >= 32 && c <= 0xFFFF ? String.fromCharCode(c) : ''
       })
       .replace(/&#x([\da-f]+);/gi, (_, n) => {
         const c = parseInt(n, 16)
         return c >= 32 && c <= 0xFFFF ? String.fromCharCode(c) : ''
       })
  return s.replace(/\s+/g, ' ').trim()
}

function trimDesc(s, max = MAX_DESC_LEN) {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max).replace(/\s+\S*$/, '').trimEnd() + '…'
}

function stripTitlePrefix(desc, title) {
  if (!desc || !title) return desc
  const dl = desc.toLowerCase()
  const tl = title.toLowerCase()
  if (dl === tl) return ''
  if (dl.startsWith(tl)) {
    return desc.slice(title.length).replace(/^[\s\-–—:|.]+/, '').trim()
  }
  return desc
}

async function fetchFeed(url) {
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
      'Cache-Control': 'no-cache',
    }
  })

  const nsMap = {}
  for (const [, prefix, uri] of data.matchAll(/xmlns:(\w+)=["']([^"']+)["']/g)) {
    nsMap[uri] = prefix
  }
  const mediaPrefix   = nsMap['http://search.yahoo.com/mrss/']            || 'media'
  const contentPrefix = nsMap['http://purl.org/rss/1.0/modules/content/'] || 'content'
  const dcPrefix      = nsMap['http://purl.org/dc/elements/1.1/']         || 'dc'

  const xml = data
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.trim())

  const $ = cheerio.load(xml, { xmlMode: true })
  const txt = el => $(el).text().replace(/<[^>]+>/g, '').trim()

  const channelTitle = txt($('channel > title').first()) ||
                       txt($('feed > title').first())    || ''

  const extractLink = el => {
    const byText = $(el).find('link').first().text().trim()
    if (isHttpUrl(byText)) return byText
    const byHref = $(el).find('link[rel="alternate"]').attr('href') ||
                   $(el).find('link').first().attr('href')
    if (isHttpUrl(byHref)) return byHref
    const m = $.html(el).match(/<link[^>]*?>([^<]+)<\/link>/)
    return (m && isHttpUrl(m[1].trim())) ? m[1].trim() : ''
  }

  const extractMedia = (el, desc = '') => {
    const raw = $.html(el)
    let img = null, video = null

    const encVid = raw.match(/<enclosure[^>]+type=["']video[^"']*["'][^>]+url=["']([^"']+)["']/i)
                || raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']video[^"']*["']/i)
    if (encVid) video = encVid[1]
    const encImg = raw.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]+url=["']([^"']+)["']/i)
                || raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image[^"']*["']/i)
    if (encImg) img = encImg[1]

    if (!img) {
      const m = raw.match(new RegExp(`<${mediaPrefix}:thumbnail[^>]+url=["']([^"']+)["']`, 'i'))
      if (m) img = m[1]
    }
    if (!video) {
      const m = raw.match(new RegExp(`<${mediaPrefix}:content[^>]+medium=["']video["'][^>]+url=["']([^"']+)["']`, 'i'))
             || raw.match(new RegExp(`<${mediaPrefix}:content[^>]+url=["']([^"']+\\.(?:mp4|webm|mov))[^"']*["']`, 'i'))
      if (m) video = m[1]
    }
    if (!img) {
      const m = raw.match(new RegExp(`<${mediaPrefix}:content[^>]+url=["']([^"']+\\.(?:jpe?g|png|gif|webp))[^"']*["']`, 'i'))
             || raw.match(new RegExp(`<${mediaPrefix}:content[^>]+medium=["']image["'][^>]+url=["']([^"']+)["']`, 'i'))
      if (m) img = m[1]
    }
    if (!img) {
      const m = raw.match(new RegExp(`<${contentPrefix}:encoded[^>]*>([\\s\\S]*?)<\\/${contentPrefix}:encoded>`, 'i'))
      if (m) img = extractFirstImgSrc(m[1])
    }
    if (!img) img = extractFirstImgSrc(desc)

    if (img && !isHttpUrl(img)) img = null
    if (video && !isHttpUrl(video)) video = null

    return { img, video }
  }

  const extractDesc = (el, primaryText) => {
    const desc1 = cleanDesc(primaryText)
    const raw = $.html(el)
    const m = raw.match(new RegExp(`<${contentPrefix}:encoded[^>]*>([\\s\\S]*?)<\\/${contentPrefix}:encoded>`, 'i'))
    const desc2 = m ? cleanDesc(m[1]) : ''
    if (desc1.length >= 40) return desc1
    if (desc2.length >= 40) return desc2
    return desc1 || desc2
  }

  const extractGuid = (el, link) => txt($(el).find('guid').first()) || link || ''
  const extractDate = el => {
    const raw     = $.html(el)
    const pubDate = txt($(el).find('pubDate').first())
    if (pubDate) return pubDate
    const m = raw.match(new RegExp(`<${dcPrefix}:date[^>]*>([^<]+)<\\/${dcPrefix}:date>`, 'i'))
    return m ? m[1].trim() : ''
  }

  const items = []

  $('item').each((_, el) => {
    const title   = txt($(el).find('title').first())
    const link    = extractLink(el)
    const guid    = extractGuid(el, link) || link
    const pubDate = extractDate(el)
    const descTxt = txt($(el).find('description').first())
    const desc    = extractDesc(el, descTxt)
    const { img, video } = extractMedia(el, descTxt)
    if (title && guid) items.push({ title, link, guid, pubDate, img, video, desc })
  })

  if (!items.length) {
    $('entry').each((_, el) => {
      const title   = txt($(el).find('title').first())
      const link    = $(el).find('link[rel="alternate"]').attr('href') ||
                      $(el).find('link').first().attr('href') || extractLink(el)
      const guid    = txt($(el).find('id').first()) || link
      const pubDate = txt($(el).find('published').first()) || txt($(el).find('updated').first())
      const content = txt($(el).find('content').first()) || txt($(el).find('summary').first())
      const desc    = extractDesc(el, content)
      const { img, video } = extractMedia(el, content)
      if (title && guid) items.push({ title, link, guid, pubDate, img, video, desc })
    })
  }

  return { items, channelTitle }
}

function formatDate(pubDate) {
  if (!pubDate) return ''
  const d = new Date(pubDate)
  if (isNaN(d)) return ''
  try {
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

function capitalize(s = '') {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function buildMessage(feed, item, translatedLabel, translatedTitle, translatedDesc, index = 0, total = 0) {
  const dateStr = formatDate(item.pubDate)
  const counter = total > 0 ? ` | ${index}/${total}` : ''
  const header  = (translatedLabel || feed.label || 'RSS').toUpperCase().slice(0, MAX_HEADER_LEN)

  const lines = [
    `*[ 📰 ${header}${counter} ]*`,
    ``,
    ` _📍${translatedTitle}_`,
    ``,
    `• *Fecha:* \`${dateStr || '—'}\``,
  ]

  if (translatedDesc) {
    lines.push('')
    lines.push(`> ${translatedDesc}`)
  }

  lines.push('')
  lines.push(`*✨ Fuente:*`)
  lines.push('')
  lines.push(item.link)

  return lines.join('\n')
}

async function sendItem(conn, chatId, feed, item, index = 0, total = 0) {
  const translatedLabel = await translateText(feed.label || 'RSS')
  const translatedTitle = await translateText(item.title)

  let descClean = cleanDesc(item.desc || '')
  descClean = stripTitlePrefix(descClean, item.title)
  descClean = trimDesc(descClean)
  const translatedDesc = descClean ? await translateText(descClean) : ''

  const text = buildMessage(feed, item, translatedLabel, translatedTitle, translatedDesc, index, total)

  if (item.video) {
    await conn.sendMessage(chatId, { video: { url: item.video }, caption: text, mimetype: 'video/mp4' })
  } else if (item.img) {
    await conn.sendMessage(chatId, { image: { url: item.img }, caption: text })
  } else {
    await conn.sendMessage(chatId, { text })
  }
}

if (!global._rssPoller) global._rssPoller = { started: false, timer: null, initTimer: null, running: false }

async function checkAllFeeds() {
  if (global._rssPoller.running) return
  global._rssPoller.running = true
  let dbDirty = false

  try {
    const conn = global.conn
    const db   = getDB()
    if (!conn || !db) return

    const urlMap = {}
    for (const [chatId, feeds] of Object.entries(db)) {
      if (!Array.isArray(feeds) || !feeds.length) continue
      for (const feed of feeds) {
        if (!feed?.url || feed.paused) continue
        if (!urlMap[feed.url]) urlMap[feed.url] = []
        urlMap[feed.url].push({ chatId, feed })
      }
    }

    for (const [url, subscribers] of Object.entries(urlMap)) {
      let items
      try {
        ;({ items } = await fetchFeed(url))
        if (!items.length) continue
      } catch (e) {
        if (e.code !== 'ECONNRESET') console.error(`[RSS Error] ${url}:`, e.message)
        continue
      }

      for (const { chatId, feed } of subscribers) {
        if (!Array.isArray(feed.seenGuids) || !feed.seenGuids.length) {
          feed.seenGuids = items.map(i => i.guid).slice(0, MAX_SEEN_GUIDS)
          dbDirty = true
          continue
        }

        const seen     = new Set(feed.seenGuids)
        const newItems = items.filter(i => !seen.has(i.guid))
        if (!newItems.length) continue

        const toSend   = newItems.slice(0, MAX_SEND_PER_TICK)
        const overflow = newItems.slice(MAX_SEND_PER_TICK).map(i => i.guid)

        for (let k = 0; k < toSend.length; k++) {
          try {
            await sendItem(conn, chatId, feed, toSend[k], k + 1, toSend.length)
            await new Promise(r => setTimeout(r, SEND_DELAY_MS))
          } catch (e) {
            console.error(`[RSS Send] ${chatId}:`, e.message)
          }
        }

        feed.seenGuids = [
          ...toSend.map(i => i.guid),
          ...overflow,
          ...feed.seenGuids
        ].slice(0, MAX_SEEN_GUIDS)
        dbDirty = true
      }
    }
  } finally {
    global._rssPoller.running = false
    if (dbDirty) {
      try { await global.db.write() } catch (e) { console.error('[RSS] db.write error:', e.message) }
    }
  }
}

function startPoller() {
  if (global._rssPoller.started) return
  global._rssPoller.started = true
  console.log('[RSS] Poller activo ✓')

  global._rssPoller.initTimer = setTimeout(
    () => checkAllFeeds().catch(e => console.error('[RSS Poller init]', e.message)),
    30_000
  )

  global._rssPoller.timer = setInterval(
    () => checkAllFeeds().catch(e => console.error('[RSS Poller tick]', e.message)),
    POLL_INTERVAL_MS
  )
}

const ALIASES = {
  add: 'add', agregar: 'add', a: 'add', '+': 'add',
  del: 'del', delete: 'del', borrar: 'del', eliminar: 'del', quitar: 'del', d: 'del', '-': 'del',
  list: 'list', lista: 'list', ls: 'list', l: 'list',
  ver: 'ver', info: 'ver', ultimas: 'ver', 'últimas': 'ver', ultima: 'ver', 'última': 'ver', v: 'ver',
  pause: 'pause', pausar: 'pause', p: 'pause',
  resume: 'resume', reanudar: 'resume', reanuda: 'resume', r: 'resume',
  check: 'check', buscar: 'check', actualizar: 'check', actualiza: 'check', c: 'check',
  test: 'test', probar: 'test', prueba: 'test', t: 'test',
  all: 'all', todos: 'all', global: 'all', g: 'all',
}

function menu(prefix) {
  return [
    `📡 *Comandos RSS*`,
    `━━━━━━━━━━━━━━━━`,
    `*${prefix}rss* → este menú`,
    `*${prefix}rss <url>* → agregar feed`,
    `*${prefix}rss list* → ver feeds`,
    `*${prefix}rss ver [n]* → últimas ${VER_LIMIT} noticias (imagen + descripción)`,
    `*${prefix}rss del <n>* → borrar feed`,
    `*${prefix}rss pause <n>* → pausar`,
    `*${prefix}rss resume <n>* → reanudar`,
    `*${prefix}rss check* → buscar novedades ahora`,
    `*${prefix}rss test [n]* → enviar último item aquí`,
    `*${prefix}rss all* → enviar último a todos (owner)`,
    ``,
    `_El [n] es el número del feed (mira_ *${prefix}rss list*_)_.`,
  ].join('\n')
}

function pickFeed(feeds, arg) {
  const n = parseInt(arg || '1', 10) - 1
  if (isNaN(n) || !feeds[n]) return null
  return { idx: n, feed: feeds[n] }
}

async function doAdd(m, feeds, canManage, usedPrefix, url) {
  if (!canManage) return m.reply('⛔ Solo administradores.')
  if (!isHttpUrl(url)) return m.reply(`Ejemplo: *${usedPrefix}rss <url>*`)
  if (feeds.some(f => f.url === url)) return m.reply('⚠️ Ya está en la lista.')
  if (feeds.length >= MAX_FEEDS_PER_CHAT) return m.reply(`⚠️ Límite alcanzado (${MAX_FEEDS_PER_CHAT}).`)
  await m.reply('⏳ Verificando...')
  try {
    const { items, channelTitle } = await fetchFeed(url)
    if (!items.length) return m.reply('❌ No se encontraron noticias en ese feed.')
    const label = channelTitle || new URL(url).hostname
    feeds.push({ url, label, seenGuids: items.map(i => i.guid).slice(0, MAX_SEEN_GUIDS), paused: false })
    await global.db.write()
    return m.reply(`✅ Agregado: *${capitalize(label)}*\n📌 ${items.length} items. Notificará solo los nuevos.`)
  } catch (e) {
    return m.reply(`❌ No se pudo conectar: ${e.message}`)
  }
}

async function showLatest(m, conn, chatId, feeds, arg) {
  if (!feeds.length) return m.reply('❌ No hay feeds. Agrega uno con *.rss <url>*')
  const p = pickFeed(feeds, arg)
  if (!p) return m.reply('❌ Número inválido. Mira *.rss list*')
  await m.reply(`⏳ Enviando últimas ${VER_LIMIT} de *${p.feed.label}*...`)
  let items
  try {
    ;({ items } = await fetchFeed(p.feed.url))
  } catch (e) {
    return m.reply(`❌ Error al conectar: ${e.message}`)
  }
  if (!items.length) return m.reply('❌ El feed no tiene items.')
  const top = items.slice(0, VER_LIMIT)
  for (let k = 0; k < top.length; k++) {
    try {
      await sendItem(conn, chatId, p.feed, top[k], k + 1, top.length)
      await new Promise(r => setTimeout(r, SEND_DELAY_MS))
    } catch (e) {
      console.error(`[rss ver send] ${chatId}:`, e.message)
      await conn.sendMessage(chatId, { text: `⚠️ Error al enviar item ${k + 1}: ${e.message}` }).catch(() => {})
    }
  }
  return m.reply('✅ Listo.')
}

async function testHere(m, conn, chatId, feeds, arg) {
  if (!feeds.length) return m.reply('❌ No hay feeds.')
  if (arg) {
    const p = pickFeed(feeds, arg)
    if (!p) return m.reply('❌ Número inválido.')
    try {
      const { items } = await fetchFeed(p.feed.url)
      if (!items.length) return m.reply('❌ Sin items.')
      await sendItem(conn, chatId, p.feed, items[0], 1, 1)
      return m.reply('✅ Enviado.')
    } catch (e) {
      return m.reply(`❌ ${e.message}`)
    }
  }
  const active = feeds.filter(f => !f.paused)
  if (!active.length) return m.reply('❌ Todos los feeds están pausados.')
  await m.reply(`📡 Enviando último item de *${active.length}* feed(s)...`)
  for (const feed of active) {
    try {
      const { items } = await fetchFeed(feed.url)
      if (!items.length) continue
      await sendItem(conn, chatId, feed, items[0], 1, 1)
      await new Promise(r => setTimeout(r, SEND_DELAY_MS))
    } catch (e) {
      await conn.sendMessage(chatId, { text: `⚠️ Error en *${feed.label}*: ${e.message}` })
    }
  }
  return m.reply('✅ Listo.')
}

async function testAll(conn, isOwner) {
  if (!isOwner) return { ok: false, msg: '⛔ Solo el dueño puede usar esto.' }
  const db = getDB()
  if (!db) return { ok: false, msg: '❌ Sin datos RSS.' }
  const urlMap = {}
  for (const [cid, cfeeds] of Object.entries(db)) {
    if (!Array.isArray(cfeeds)) continue
    for (const feed of cfeeds) {
      if (!feed?.url || feed.paused) continue
      if (!urlMap[feed.url]) urlMap[feed.url] = []
      urlMap[feed.url].push({ chatId: cid, feed })
    }
  }
  for (const [url, subscribers] of Object.entries(urlMap)) {
    let items
    try {
      ;({ items } = await fetchFeed(url))
      if (!items.length) continue
    } catch { continue }
    for (const { chatId, feed } of subscribers) {
      try {
        await sendItem(conn, chatId, feed, items[0], 1, 1)
        await new Promise(r => setTimeout(r, SEND_DELAY_MS))
      } catch (e) { console.error(`[rss all] ${chatId}:`, e.message) }
    }
  }
  return { ok: true, msg: '✅ Enviado a todos los grupos suscritos.' }
}

let handler = async (m, { conn, text, usedPrefix, isOwner, isAdmin, isROwner }) => {
  const chatId    = m.chat
  const feeds     = feedsOf(chatId)
  if (!feeds) return m.reply('⏳ Base de datos no lista. Intenta de nuevo.')
  const canManage = isOwner || isAdmin || isROwner

  const raw = (text || '').trim()
  if (!raw) return m.reply(menu(usedPrefix))

  const parts = raw.split(/\s+/)
  const first = parts[0]
  const rest  = parts.slice(1)

  if (isHttpUrl(first)) return doAdd(m, feeds, canManage, usedPrefix, first)

  const sub = ALIASES[first.toLowerCase()]
  if (!sub) return m.reply(`❌ No entendí *${first}*.\n\n${menu(usedPrefix)}`)

  if (sub === 'add') return doAdd(m, feeds, canManage, usedPrefix, rest[0])

  if (sub === 'list') {
    if (!feeds.length) return m.reply(`❌ No hay feeds.\nAgrega uno con *${usedPrefix}rss <url>*`)
    let msg = `📋 *Feeds (${feeds.length}/${MAX_FEEDS_PER_CHAT})*\n━━━━━━━━━━━━━━━━\n`
    feeds.forEach((f, i) => {
      msg += `*${i + 1}.* ${capitalize(f.label)}${f.paused ? ' ⏸️' : ''}\n   🔗 ${f.url}\n`
    })
    return m.reply(msg)
  }

  if (sub === 'ver') return showLatest(m, conn, chatId, feeds, rest[0])

  if (sub === 'del') {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    const p = pickFeed(feeds, rest[0])
    if (!p) return m.reply('❌ Número inválido. Mira *.rss list*')
    feeds.splice(p.idx, 1)
    await global.db.write()
    return m.reply(`🗑️ Eliminado: *${p.feed.label}*`)
  }

  if (sub === 'pause' || sub === 'resume') {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    const p = pickFeed(feeds, rest[0])
    if (!p) return m.reply('❌ Número inválido. Mira *.rss list*')
    const isPause = sub === 'pause'
    p.feed.paused = isPause
    await global.db.write()
    return m.reply(`${isPause ? '⏸️ Pausado' : '▶️ Reanudado'}: *${p.feed.label}*`)
  }

  if (sub === 'check') {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    await m.reply('🔄 Buscando novedades...')
    await checkAllFeeds()
    return m.reply('✅ Listo. Solo se enviaron items nuevos.')
  }

  if (sub === 'test') {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    return testHere(m, conn, chatId, feeds, rest[0])
  }

  if (sub === 'all') {
    const r = await testAll(conn, isOwner || isROwner)
    return m.reply(r.msg)
  }

  return m.reply(menu(usedPrefix))
}

handler.all = async function () {
  const c = this || global.conn
  if (!c) return
  if (!global.conn) global.conn = c
  if (!global._rssPoller.started) startPoller()
}

handler.command = /^rss$/i
handler.tags    = ['tools']
handler.help    = ['rss <url>', 'rss list', 'rss ver [n]', 'rss del <n>', 'rss pause <n>', 'rss resume <n>', 'rss check', 'rss test [n]', 'rss all']

export default handler
