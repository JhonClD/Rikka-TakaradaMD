import axios from 'axios'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const cheerio = require('cheerio')

const POLL_INTERVAL_MS   = 10 * 60 * 1000
const MAX_FEEDS_PER_CHAT = 10
const MAX_SEEN_GUIDS     = 300
const REQUEST_TIMEOUT    = 20_000
const MAX_SEND_PER_TICK  = 3
const SEND_DELAY_MS      = 1_500

async function translateText(text, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.get(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`,
        { timeout: 6_000 }
      )
      const translated = res.data?.[0]?.[0]?.[0]
      if (translated) return translated
    } catch {
      if (i < retries) await new Promise(r => setTimeout(r, 1_000 * (i + 1)))
    }
  }
  return text
}

function initDB() {
  if (!global.db?.data) return
  global.db.data.rss = global.db.data.rss || {}
}

function feedsOf(chatId) {
  initDB()
  if (!global.db.data.rss[chatId]) global.db.data.rss[chatId] = []
  return global.db.data.rss[chatId]
}

async function fetchFeed(url) {
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':        'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
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
    if (byText && /^https?:\/\//.test(byText)) return byText
    const byHref = $(el).find('link[rel="alternate"]').attr('href') ||
                   $(el).find('link').first().attr('href')
    if (byHref && /^https?:\/\//.test(byHref)) return byHref
    const m = $.html(el).match(/<link[^>]*?>([^<]+)<\/link>/)
    return (m && /^https?:\/\//.test(m[1].trim())) ? m[1].trim() : ''
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

    return { img, video }
  }

  const extractGuid = (el, link) => txt($(el).find('guid').first()) || link || ''
  const extractDate = el => {
    const raw     = $.html(el)
    const pubDate = txt($(el).find('pubDate').first())
    if (pubDate) return pubDate
    const m = raw.match(new RegExp(`<${dcPrefix}:date[^>]*>([^<]+)<\/${dcPrefix}:date>`, 'i'))
    return m ? m[1].trim() : ''
  }

  const items = []

  $('item').each((_, el) => {
    const title   = txt($(el).find('title').first())
    const link    = extractLink(el)
    const guid    = extractGuid(el, link)
    const pubDate = extractDate(el)
    const desc    = txt($(el).find('description').first())
    const { img, video } = extractMedia(el, desc)
    if (title && guid) items.push({ title, link, guid, pubDate, img, video })
  })

  if (!items.length) {
    $('entry').each((_, el) => {
      const title   = txt($(el).find('title').first())
      const link    = $(el).find('link[rel="alternate"]').attr('href') ||
                      $(el).find('link').first().attr('href') || extractLink(el)
      const guid    = txt($(el).find('id').first()) || link
      const pubDate = txt($(el).find('published').first()) || txt($(el).find('updated').first())
      const content = txt($(el).find('content').first()) || txt($(el).find('summary').first())
      const { img, video } = extractMedia(el, content)
      if (title && guid) items.push({ title, link, guid, pubDate, img, video })
    })
  }

  return { items, channelTitle }
}

function extractFirstImgSrc(html = '') {
  const m = html.match(/<img[^>]+src=["']([^"'>]+)["']/i)
  return m ? m[1] : null
}

function formatDate(pubDate) {
  if (!pubDate) return ''
  const d = new Date(pubDate)
  return isNaN(d) ? '' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
}

function capitalize(s = '') {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function buildMessage(feed, item, translatedTitle) {
  const dateStr = formatDate(item.pubDate)
  return [
    `📰 *${capitalize(feed.label || 'RSS')}*`,
    `━━━━━━━━━━━━━━━━`,
    `🎌 *${translatedTitle}*`,
    dateStr ? `🕐 ${dateStr}` : null,
    ``,
    `🔗 ${item.link}`
  ].filter(l => l !== null).join('\n')
}

async function sendItem(conn, chatId, feed, item) {
  const translatedTitle = await translateText(item.title)
  const text = buildMessage(feed, item, translatedTitle)
  if (item.video) {
    await conn.sendMessage(chatId, { video: { url: item.video }, caption: text, mimetype: 'video/mp4' })
  } else if (item.img) {
    await conn.sendMessage(chatId, { image: { url: item.img }, caption: text })
  } else {
    await conn.sendMessage(chatId, { text })
  }
}

if (!global._rssPoller) global._rssPoller = { started: false, timer: null, initTimer: null }

async function checkAllFeeds() {
  const conn = global.conn
  if (!conn) return
  if (!global.db?.data?.rss) return

  const urlMap = {}
  for (const [chatId, feeds] of Object.entries(global.db.data.rss)) {
    if (!Array.isArray(feeds) || !feeds.length) continue
    for (const feed of feeds) {
      if (!feed?.url || feed.paused) continue
      if (!urlMap[feed.url]) urlMap[feed.url] = []
      urlMap[feed.url].push({ chatId, feed })
    }
  }

  let dbDirty = false

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

      const newItems = items.filter(i => !feed.seenGuids.includes(i.guid))
      if (!newItems.length) continue

      const toSend = newItems.reverse().slice(0, MAX_SEND_PER_TICK)

      for (const item of toSend) {
        try {
          await sendItem(conn, chatId, feed, item)
          await new Promise(r => setTimeout(r, SEND_DELAY_MS))
        } catch (e) {
          console.error(`[RSS Send] ${chatId}:`, e.message)
        }
      }

      feed.seenGuids = [
        ...newItems.map(i => i.guid),
        ...feed.seenGuids
      ].slice(0, MAX_SEEN_GUIDS)
      dbDirty = true
    }
  }

  if (dbDirty) {
    try { await global.db.write() } catch (e) { console.error('[RSS] db.write error:', e.message) }
  }
}

function startPoller() {
  if (global._rssPoller.initTimer) { clearTimeout(global._rssPoller.initTimer);  global._rssPoller.initTimer = null }
  if (global._rssPoller.timer)     { clearInterval(global._rssPoller.timer);      global._rssPoller.timer = null }
  global._rssPoller.started = false

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

let handler = async (m, { conn, text, usedPrefix, command, isOwner, isAdmin, isROwner }) => {
  const chatId    = m.chat
  const feeds     = feedsOf(chatId)
  const canManage = isOwner || isAdmin || isROwner

  if (/list$/i.test(command)) {
    if (!feeds.length) return m.reply(`❌ No hay feeds activos.\nUsa *${usedPrefix}rssadd <url>*`)
    let msg = `📋 *Feeds Activos (${feeds.length}/${MAX_FEEDS_PER_CHAT})*\n━━━━━━━━━━━━━━━━\n`
    feeds.forEach((f, i) => {
      msg += `*${i + 1}.* ${capitalize(f.label)}${f.paused ? ' ⏸️' : ''}\n   🔗 ${f.url}\n`
    })
    return m.reply(msg)
  }

  if (/recientes$/i.test(command)) {
    if (!feeds.length) return m.reply(`❌ No hay feeds registrados.`)
    const idx  = parseInt(text) - 1
    const feed = (!isNaN(idx) && feeds[idx]) ? feeds[idx] : feeds[0]
    await m.reply(`⏳ Cargando noticias de *${feed.label}*...`)
    try {
      const { items } = await fetchFeed(feed.url)
      const top = items.slice(0, 5)
      let res = `📰 *${capitalize(feed.label)}*\n━━━━━━━━━━━━━━━━\n`
      for (const [i, it] of top.entries()) {
        const translated = await translateText(it.title)
        res += `*${i + 1}.* ${translated}\n🔗 ${it.link}\n───────────────\n`
      }
      return m.reply(res.trim())
    } catch (e) {
      return m.reply(`❌ Error al conectar con el feed: ${e.message}`)
    }
  }

  if (/add$/i.test(command)) {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    if (!text)      return m.reply(`Ejemplo: *${usedPrefix}rssadd <url>*`)
    const url = text.trim()
    if (!/^https?:\/\//.test(url))          return m.reply('❌ URL inválida.')
    if (feeds.some(f => f.url === url))     return m.reply('⚠️ Ya está en la lista.')
    if (feeds.length >= MAX_FEEDS_PER_CHAT) return m.reply('⚠️ Límite alcanzado.')
    await m.reply('⏳ Verificando URL...')
    try {
      const { items, channelTitle } = await fetchFeed(url)
      if (!items.length) return m.reply('❌ No se encontraron noticias en ese feed.')
      const label = channelTitle || new URL(url).hostname
      feeds.push({ url, label, seenGuids: items.map(i => i.guid).slice(0, MAX_SEEN_GUIDS), paused: false })
      await global.db.write()
      return m.reply(`✅ Feed agregado: *${capitalize(label)}*\n📌 ${items.length} items encontrados, notificará solo los nuevos.`)
    } catch (e) {
      return m.reply(`❌ No se pudo conectar: ${e.message}`)
    }
  }

  if (/del$/i.test(command)) {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    const n = parseInt(text) - 1
    if (isNaN(n) || !feeds[n]) return m.reply('❌ Número inválido. Usa *.rsslist* para ver los feeds.')
    const [removed] = feeds.splice(n, 1)
    await global.db.write()
    return m.reply(`🗑️ Feed *${removed.label}* eliminado.`)
  }

  if (/pause$/i.test(command) || /resume$/i.test(command)) {
    if (!canManage) return m.reply('⛔ Solo administradores.')
    const isPause = /pause$/i.test(command)
    const n = parseInt(text) - 1
    if (isNaN(n) || !feeds[n]) return m.reply('❌ Número inválido.')
    feeds[n].paused = isPause
    await global.db.write()
    return m.reply(`${isPause ? '⏸️ Pausado' : '▶️ Reanudado'}: *${feeds[n].label}*`)
  }

  if (/check$/i.test(command)) {
    const mode = text?.trim()

    if (mode === '1') {
      if (!feeds.length) return m.reply('❌ No hay feeds en este grupo.')
      await m.reply(`📡 Enviando último item de *${feeds.length}* feed(s)...`)
      for (const feed of feeds) {
        try {
          const { items } = await fetchFeed(feed.url)
          if (!items.length) continue
          await sendItem(conn, chatId, feed, items[0])
          await new Promise(r => setTimeout(r, SEND_DELAY_MS))
        } catch (e) {
          await conn.sendMessage(chatId, { text: `⚠️ Error en *${feed.label}*: ${e.message}` })
        }
      }
      return m.reply('✅ Listo.')
    }

    if (mode === '2') {
      if (!canManage && !isOwner) return m.reply('⛔ Solo dueño.')
      if (!global.db?.data?.rss) return m.reply('❌ Sin datos RSS.')
      await m.reply('📡 Enviando último item a todos los grupos suscritos...')
      const urlMap = {}
      for (const [cid, cfeeds] of Object.entries(global.db.data.rss)) {
        if (!Array.isArray(cfeeds)) continue
        for (const feed of cfeeds) {
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
        for (const { chatId: cid, feed } of subscribers) {
          try {
            await sendItem(conn, cid, feed, items[0])
            await new Promise(r => setTimeout(r, SEND_DELAY_MS))
          } catch (e) { console.error(`[rsscheck 2 send] ${cid}:`, e.message) }
        }
      }
      return m.reply('✅ Listo.')
    }

    await m.reply('🔄 Buscando actualizaciones...')
    await checkAllFeeds()
    return m.reply('✅ Listo. Solo se enviaron items no vistos anteriormente.')
  }
}

handler.all = async function (_m) {
  const c = this || global.conn
  if (c && !global._rssPoller.started) startPoller()
}

handler.command = /^rss(add|del|list|recientes|check|pause|resume)$/i
handler.tags    = ['tools']
handler.help    = ['rssadd <url>', 'rssdel <número>', 'rsslist', 'rssrecientes [n]', 'rsscheck', 'rsspause <n>', 'rssresume <n>']

export default handler
    
