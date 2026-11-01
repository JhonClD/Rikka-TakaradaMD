// plugins/animev1-notify.js — Notificador automático de nuevos episodios de AnimeV1
// Reutiliza la biblioteca oficial del proyecto y la cola de descargas AnimeV1.

import fs from 'fs'
import path from 'path'
import axios from 'axios'
import * as cheerio from 'cheerio'
import animeV1 from '../src/libraries/animev1.cjs'
import animeV1Downloader from '../src/libraries/animev1-download.cjs'
import { compressDw4 } from '../src/libraries/dw4-compress.js'

const DB_DIR = path.join(process.cwd(), 'database')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const STATE_FILE = path.join(DB_DIR, 'animev1_notify_state.json')
const CHECK_INTERVAL_DEFAULT = 10 * 60
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 3600
const QUEUE_DELAY = 90_000
const MAX_TRACKED = 20
const MAX_SEEN = 500
const AUTO_CATALOG_PAGES = 2
const DOMAIN = String(process.env.ANIMEV1_DOMAIN || process.env.DEFAULT_ANIME_DOMAIN || 'animeav1.com')
  .replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase()

const clean = (value, max = 180) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
const safeFile = value => clean(value, 120).replace(/[\\/*?"<>|]/g, '_') || 'Anime'
const episodeNumber = ep => Number(ep?.number || ep?.episode || 0) || 0
const episodeKey = (subscriptionKey, ep) => `${subscriptionKey}:${episodeNumber(ep)}:${ep?.id || ep?.url || ''}`
const formatInterval = seconds => Number(seconds) % 60 === 0 ? `${Number(seconds) / 60} min` : `${seconds} segundos`
const formatActiveTime = startedAt => {
  const minutes = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    console.error(`[animev1-notify] No se pudo guardar el estado: ${error.message}`)
  }
}

function getGlobalIntervalSec() {
  const state = loadState()
  const configured = Number(state.__config?.intervalSec)
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS)
    : CHECK_INTERVAL_DEFAULT
}

function setGlobalIntervalSec(intervalSec) {
  const state = loadState()
  state.__config = { ...(state.__config || {}), intervalSec }
  saveState(state)
}

function parseIntervalInput(value) {
  const match = String(value || '').trim().toLowerCase().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(s|seg|segundos?|m|min|minutos?)?$/)
  if (!match) return null
  const amount = Number(match[1])
  const seconds = /^m/i.test(match[2] || '') ? amount * 60 : amount
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null
}

function normalizeVariant(value) { return /^dub$/i.test(value) ? 'DUB' : 'SUB' }
function getChatState(chatId) {
  const state = loadState()
  if (!state[chatId]) state[chatId] = { intervalSec: getGlobalIntervalSec(), startedAt: Date.now(), sentCount: 0, subscriptions: [], seen: [] }
  if (!Array.isArray(state[chatId].subscriptions)) state[chatId].subscriptions = []
  if (!Array.isArray(state[chatId].seen)) state[chatId].seen = []
  return { state, chat: state[chatId] }
}

function subscriptionKey(url, variant) { return `${url}|${normalizeVariant(variant)}` }
function trimSeen(chat) { if (chat.seen.length > MAX_SEEN) chat.seen = chat.seen.slice(-MAX_SEEN) }
function zeroPad(number) { return String(number).padStart(2, '0') }
function buildFileName(ep, subscription, extension = '.mp4') {
  const title = safeFile(subscription.title)
  const variant = normalizeVariant(subscription.variant)
  const number = zeroPad(episodeNumber(ep) || 'x')
  return `${number} ${title} (${variant})${extension}`
}

async function resolveSubscription(input, variant = 'SUB') {
  const raw = String(input || '').trim()
  if (!raw) throw new Error(`Indica un título o URL de AnimeV1 (${DOMAIN}).`)
  let url = /^https?:\/\//i.test(raw) ? raw : ''
  let result = null
  if (!url) {
    const response = await animeV1.searchAnime(raw, DOMAIN)
    result = response?.data?.results?.[0]
    if (!result?.url) throw new Error(`No encontré *${clean(raw)}* en AnimeV1.`)
    url = result.url
  }
  const infoResponse = await animeV1.getAnimeInfo(url)
  const anime = infoResponse?.data
  if (!anime?.episodes?.length) throw new Error('AnimeV1 no devolvió episodios para esa serie.')
  const episodes = [...anime.episodes].sort((a, b) => episodeNumber(a) - episodeNumber(b))
  const latest = episodes[episodes.length - 1]
  return {
    key: subscriptionKey(url, variant),
    url,
    title: clean(anime.title || result?.title || raw, 120),
    image: anime.image || result?.image || '',
    variant: normalizeVariant(variant),
    lastEpisodeNumber: episodeNumber(latest),
    latestEpisode: latest,
  }
}

async function discoverCatalogSubscriptions() {
  const results = []
  const seenUrls = new Set()
  for (let page = 1; page <= AUTO_CATALOG_PAGES; page++) {
    try {
      const response = await axios.get(`https://${DOMAIN}/catalogo?page=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        timeout: 20_000,
      })
      const $ = cheerio.load(response.data)
      const pageResults = []
      $('a[href^="/media/"]').each((_, element) => {
        const href = $(element).attr('href') || ''
        if (!/^\/media\/[^/]+$/i.test(href)) return
        const card = $(element).closest('article').length ? $(element).closest('article') : $(element).parent()
        const title = card.find('h3, h2').first().text().trim() ||
          $(element).find('.sr-only').first().text().trim() ||
          card.find('img').first().attr('alt') || ''
        if (!title) return
        const image = card.find('img').first().attr('src') || ''
        pageResults.push({
          title,
          url: new URL(href, `https://${DOMAIN}`).href,
          image: image ? new URL(image, `https://${DOMAIN}`).href : '',
        })
      })
      for (const item of pageResults) {
        if (!item?.url || seenUrls.has(item.url)) continue
        seenUrls.add(item.url)
        results.push(item)
      }
    } catch (error) {
      console.error(`[animev1-notify] No se pudo leer el catálogo página ${page}: ${error.message}`)
    }
  }
  const subscriptions = []
  for (const item of results.slice(0, MAX_TRACKED)) {
    try {
      const response = await animeV1.getAnimeInfo(item.url)
      const anime = response?.data
      const episodes = [...(anime?.episodes || [])].sort((a, b) => episodeNumber(a) - episodeNumber(b))
      const latest = episodes[episodes.length - 1]
      if (!latest) continue
      subscriptions.push({
        key: subscriptionKey(item.url, 'SUB'),
        url: item.url,
        title: clean(anime.title || item.title || 'Anime', 120),
        image: anime.image || item.image || '',
        variant: 'SUB',
        lastEpisodeNumber: episodeNumber(latest),
      })
    } catch (error) {
      console.error(`[animev1-notify] No se pudo cargar ${item.title || item.url}: ${error.message}`)
    }
  }
  return subscriptions
}

async function initializeCatalogForChat(chatId) {
  const { state, chat } = getChatState(chatId)
  if (chat.subscriptions.length) return chat.subscriptions.length
  chat.subscriptions = await discoverCatalogSubscriptions()
  saveState(state)
  return chat.subscriptions.length
}

async function fetchNewEpisodes(chatId) {
  const { state, chat } = getChatState(chatId)
  const found = []
  for (const subscription of chat.subscriptions) {
    try {
      const response = await animeV1.getAnimeInfo(subscription.url)
      const anime = response?.data
      const episodes = [...(anime?.episodes || [])].sort((a, b) => episodeNumber(a) - episodeNumber(b))
      for (const ep of episodes) {
        const number = episodeNumber(ep)
        if (!number || number <= Number(subscription.lastEpisodeNumber || 0)) continue
        const id = episodeKey(subscription.key, ep)
        if (chat.seen.includes(id) || global.animeV1NotifyQueuedIds.has(`${chatId}:${id}`)) continue
        found.push({ id, subscriptionKey: subscription.key, title: subscription.title, image: subscription.image, variant: subscription.variant, ep })
      }
    } catch (error) {
      console.error(`[animev1-notify] No se pudo revisar ${subscription.title}: ${error.message}`)
    }
  }
  saveState(state)
  return found.sort((a, b) => episodeNumber(a.ep) - episodeNumber(b.ep))
}

async function sendEpisode(chatId, item, conn) {
  const { subscription, ep } = { subscription: item, ep: item.ep }
  const localTmp = path.join(process.cwd(), 'temp_videos')
  fs.mkdirSync(localTmp, { recursive: true })
  const tmpDir = path.join(localTmp, `animev1_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  let file = null
  const title = subscription.title || 'Anime'
  const caption = `*✨ Nuevo episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> 🎬 ${title}\n> 🆕 Capítulo: *${episodeNumber(ep)}*\n> 🎙️ Variante: *${subscription.variant}*\n> 🌐 Fuente: *AnimeV1*\n> 🔗 ${ep.url}\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`
  try {
    if (subscription.image) {
      try {
        const image = await fetch(subscription.image).then(res => res.ok ? res.arrayBuffer() : null)
        if (image) await conn.sendMessage(chatId, { image: Buffer.from(image), caption })
        else await conn.sendMessage(chatId, { text: caption })
      } catch (_) { await conn.sendMessage(chatId, { text: caption }) }
    } else await conn.sendMessage(chatId, { text: caption })

    file = await animeV1Downloader.downloadEpisodeFile(ep.url, {
      title,
      episode: episodeNumber(ep),
      variant: subscription.variant,
      onStatus: text => console.log(`[animev1-notify] ${text}`),
    })
    const originalName = buildFileName(ep, subscription, file.extension)
    const originalPath = path.join(tmpDir, originalName)
    fs.renameSync(file.filePath, originalPath)
    const thumbnail = await animeV1Downloader.createJpegThumbnail(originalPath)
    await conn.sendMessage(chatId, {
      document: { url: originalPath },
      fileName: originalName,
      mimetype: file.mimetype,
      jpegThumbnail: thumbnail,
    })

    const lowName = originalName.replace(/\.[^.]+$/, ' (360p)$&')
    const lowPath = path.join(tmpDir, lowName)
    try {
      await compressDw4(originalPath, lowPath, { label: 'DW4 AnimeV1' })
      const lowThumbnail = await animeV1Downloader.createJpegThumbnail(lowPath)
      await conn.sendMessage(chatId, {
        document: { url: lowPath },
        fileName: lowName,
        mimetype: 'video/mp4',
        jpegThumbnail: lowThumbnail,
      })
    } catch (error) {
      console.error(`[animev1-notify] No se pudo crear la versión 360p: ${error.message}`)
      await conn.sendMessage(chatId, { text: `⚠️ El episodio original de *${title}* ya fue enviado, pero falló la versión 360p.` })
    }
  } finally {
    if (file?.filePath) await animeV1Downloader.cleanupDownloadFile(file.filePath)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
}

async function processQueue() {
  if (global.animeV1NotifyQueueRunning || !global.animeV1NotifyQueue.length) return
  global.animeV1NotifyQueueRunning = true
  try {
    while (global.animeV1NotifyQueue.length) {
      const item = global.animeV1NotifyQueue[0]
      const active = global.animeV1NotifyActiveChats.has(item.chatId)
      if (!item.manual && !active) {
        global.animeV1NotifyQueue.shift()
        global.animeV1NotifyQueuedIds.delete(`${item.chatId}:${item.id}`)
        continue
      }
      try {
        if (!global.animeV1NotifyConn) throw new Error('La conexión de WhatsApp no está disponible.')
        await sendEpisode(item.chatId, { ...item, title: item.title, variant: item.variant }, global.animeV1NotifyConn)
        const { state, chat } = getChatState(item.chatId)
        if (!chat.seen.includes(item.id)) chat.seen.push(item.id)
        trimSeen(chat)
        const sub = chat.subscriptions.find(value => value.key === item.subscriptionKey)
        if (sub) sub.lastEpisodeNumber = Math.max(Number(sub.lastEpisodeNumber || 0), episodeNumber(item.ep))
        chat.sentCount = Number(chat.sentCount || 0) + 1
        saveState(state)
        global.animeV1NotifyQueue.shift()
        global.animeV1NotifyQueuedIds.delete(`${item.chatId}:${item.id}`)
      } catch (error) {
        console.error(`[animev1-notify] Falló el envío: ${error.message}`)
        global.animeV1NotifyQueue.shift()
        global.animeV1NotifyQueuedIds.delete(`${item.chatId}:${item.id}`)
        try { await global.animeV1NotifyConn?.sendMessage(item.chatId, { text: `❌ Error enviando *${item.title}* ep *${episodeNumber(item.ep)}*:\n${error.message}` }) } catch (_) {}
      }
      if (global.animeV1NotifyQueue.length) await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY))
    }
  } finally { global.animeV1NotifyQueueRunning = false }
}

async function checkChat(chatId, conn) {
  if (global.animeV1NotifyChecking.has(chatId)) return 0
  global.animeV1NotifyChecking.add(chatId)
  try {
    const items = await fetchNewEpisodes(chatId)
    if (!items.length) return 0
    if (items.length > 1) {
      await conn.sendMessage(chatId, { text: `📋 *${items.length} episodios nuevos detectados en AnimeV1*\n\n${items.map((item, index) => `${index + 1}. *${item.title}* — Ep ${episodeNumber(item.ep)} (${item.variant})`).join('\n')}\n\n⏳ _Se enviarán de uno en uno..._` })
    }
    for (const item of items) {
      global.animeV1NotifyQueue.push({ chatId, ...item })
      global.animeV1NotifyQueuedIds.add(`${chatId}:${item.id}`)
    }
    processQueue().catch(error => console.error(`[animev1-notify] Cola: ${error.message}`))
    return items.length
  } finally { global.animeV1NotifyChecking.delete(chatId) }
}

function startChat(chatId, conn, intervalSec = null, checkNow = true) {
  if (conn) global.animeV1NotifyConn = conn
  const { state, chat } = getChatState(chatId)
  if (global.animeV1NotifyActiveChats.has(chatId)) clearInterval(global.animeV1NotifyActiveChats.get(chatId).timer)
  const interval = Number(intervalSec) || Number(chat.intervalSec) || getGlobalIntervalSec()
  const entry = { timer: setInterval(() => checkChat(chatId, global.animeV1NotifyConn).catch(() => {}), interval * 1000), intervalSec: interval, startedAt: chat.startedAt || Date.now(), sentCount: Number(chat.sentCount) || 0 }
  chat.intervalSec = interval
  if (!chat.startedAt) chat.startedAt = Date.now()
  state[chatId] = chat
  saveState(state)
  global.animeV1NotifyActiveChats.set(chatId, entry)
  if (checkNow && chat.subscriptions.length) checkChat(chatId, global.animeV1NotifyConn).catch(() => {})
}

function stopChat(chatId) {
  const entry = global.animeV1NotifyActiveChats.get(chatId)
  if (entry) clearInterval(entry.timer)
  global.animeV1NotifyActiveChats.delete(chatId)
  global.animeV1NotifyQueue = global.animeV1NotifyQueue.filter(item => {
    if (item.chatId !== chatId) return true
    global.animeV1NotifyQueuedIds.delete(`${chatId}:${item.id}`)
    return false
  })
  const state = loadState()
  delete state[chatId]
  saveState(state)
}

function restoreChats(conn) {
  if (conn) global.animeV1NotifyConn = conn
  const state = loadState()
  for (const [chatId, chat] of Object.entries(state)) {
    if (chatId === '__config' || !chat.subscriptions?.length) continue
    if (!global.animeV1NotifyActiveChats.has(chatId)) startChat(chatId, conn, chat.intervalSec, false)
  }
}

if (!global.animeV1NotifyActiveChats) global.animeV1NotifyActiveChats = new Map()
if (!global.animeV1NotifyQueue) global.animeV1NotifyQueue = []
if (!global.animeV1NotifyQueuedIds) global.animeV1NotifyQueuedIds = new Set()
if (!global.animeV1NotifyChecking) global.animeV1NotifyChecking = new Set()
if (typeof global.animeV1NotifyQueueRunning !== 'boolean') global.animeV1NotifyQueueRunning = false
if (!global.animeV1NotifyConn) global.animeV1NotifyConn = null

if (!global.animeV1NotifyWatchdog) {
  global.animeV1NotifyWatchdog = setInterval(() => restoreChats(global.animeV1NotifyConn), 2 * 60 * 1000)
}

const ownerCommands = new Set(['animev1start', 'animev1stop', 'animev1interval', 'animev1flush', 'animev1unblock'])

const handler = async (m, { conn, text, usedPrefix, command, isOwner }) => {
  if (conn) global.animeV1NotifyConn = conn
  restoreChats(conn)
  if (ownerCommands.has(command) && !isOwner) return m.reply('⛔ Solo el *owner* puede usar este comando.')

  if (command === 'animev1start') {
    const { chat } = getChatState(m.chat)
    if (!chat.subscriptions.length) {
      await m.reply('🔎 Cargando el catálogo de AnimeV1 y registrando la base inicial...')
      const total = await initializeCatalogForChat(m.chat)
      if (!total) return m.reply('❌ No pude obtener series del catálogo de AnimeV1. Intenta de nuevo más tarde.')
    }
    const input = parseIntervalInput(text)
    const interval = input && input >= MIN_INTERVAL_SECONDS && input <= MAX_INTERVAL_SECONDS ? input : chat.intervalSec || getGlobalIntervalSec()
    startChat(m.chat, conn, interval, false)
    return m.reply(`✅ *Notificador AnimeV1 activado*\n\n⏱️ Intervalo: *${formatInterval(interval)}*\n🎬 Series seguidas: *${chat.subscriptions.length}*\n
Usa *${usedPrefix}animev1stop* para detenerlo.`)
  }

  if (command === 'animev1stop') {
    const entry = global.animeV1NotifyActiveChats.get(m.chat)
    if (!entry) return m.reply('ℹ️ El notificador AnimeV1 no estaba activo.')
    stopChat(m.chat)
    return m.reply(`🛑 *Notificador AnimeV1 detenido*\n\nActivo: *${formatActiveTime(entry.startedAt)}*\nAvisos enviados: *${entry.sentCount}*`)
  }

  if (command === 'animev1list') {
    const { chat } = getChatState(m.chat)
    if (!chat.subscriptions.length) return m.reply('📭 No sigues ninguna serie.')
    return m.reply(`📚 *Series seguidas en AnimeV1*\n\n${chat.subscriptions.map((item, index) => `${index + 1}. *${item.title}* — ${item.variant} — último ep. ${item.lastEpisodeNumber}`).join('\n')}`)
  }

  if (command === 'animev1status') {
    const { chat } = getChatState(m.chat)
    const entry = global.animeV1NotifyActiveChats.get(m.chat)
    const pending = global.animeV1NotifyQueue.filter(item => item.chatId === m.chat)
    return m.reply(`📡 *Estado AnimeV1*\n\n${entry ? `✅ Activo — cada ${formatInterval(entry.intervalSec)}` : '🔴 Inactivo'}\n📚 Series: *${chat.subscriptions.length}*\n📋 Cola: *${pending.length}*\n👁️ Episodios enviados: *${chat.seen.length}*`)
  }

  if (command === 'animev1check') {
    if (!getChatState(m.chat).chat.subscriptions.length) {
      await m.reply('🔎 Cargando el catálogo de AnimeV1...')
      await initializeCatalogForChat(m.chat)
    }
    await m.reply('🔍 Revisando episodios nuevos en AnimeV1...')
    const count = await checkChat(m.chat, conn)
    return m.reply(count ? `✅ Detecté *${count}* episodio(s), añadidos a la cola.` : '✅ No hay episodios nuevos.')
  }

  if (command === 'animev1interval') {
    const interval = parseIntervalInput(text)
    if (!interval || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) return m.reply(`❌ Usa entre ${MIN_INTERVAL_SECONDS} segundos y ${MAX_INTERVAL_SECONDS / 60} minutos.`)
    setGlobalIntervalSec(interval)
    const state = loadState()
    for (const chatId of Object.keys(state)) if (chatId !== '__config' && state[chatId]?.subscriptions?.length) startChat(chatId, conn, interval, false)
    return m.reply(`⏱️ Intervalo global actualizado a *${formatInterval(interval)}*.`)
  }

  if (command === 'animev1queue') {
    const queue = global.animeV1NotifyQueue.filter(item => item.chatId === m.chat)
    return m.reply(queue.length ? `📋 *Cola AnimeV1*\n\n${queue.map((item, index) => `${index + 1}. *${item.title}* — Ep ${episodeNumber(item.ep)} (${item.variant})`).join('\n')}` : '✅ Cola vacía.')
  }

  if (command === 'animev1flush') {
    const before = global.animeV1NotifyQueue.length
    global.animeV1NotifyQueue = global.animeV1NotifyQueue.filter(item => {
      if (item.chatId !== m.chat) return true
      global.animeV1NotifyQueuedIds.delete(`${m.chat}:${item.id}`)
      return false
    })
    return m.reply(`🗑️ *${before - global.animeV1NotifyQueue.length}* episodio(s) eliminado(s) de la cola.`)
  }

  if (command === 'animev1unblock') {
    if (!global.animeV1NotifyQueue.length) return m.reply('🔓 No hay episodios pendientes.')
    global.animeV1NotifyQueueRunning = false
    processQueue().catch(() => {})
    return m.reply(`🔓 Cola reanudada: *${global.animeV1NotifyQueue.length}* episodio(s).`)
  }

  if (command === 'animev1example') {
    const { chat } = getChatState(m.chat)
    if (!chat.subscriptions.length) {
      await m.reply('🔎 Cargando el catálogo de AnimeV1...')
      await initializeCatalogForChat(m.chat)
    }
    if (!chat.subscriptions.length) return m.reply('❌ No hay series disponibles en el catálogo de AnimeV1.')
    const subscription = chat.subscriptions[0]
    const response = await animeV1.getAnimeInfo(subscription.url)
    const ep = [...(response?.data?.episodes || [])].sort((a, b) => episodeNumber(b) - episodeNumber(a))[0]
    if (!ep) return m.reply('❌ No encontré episodios para esa serie.')
    const id = episodeKey(subscription.key, ep)
    if (!global.animeV1NotifyQueuedIds.has(`${m.chat}:${id}`)) {
      global.animeV1NotifyQueue.push({ chatId: m.chat, id, subscriptionKey: subscription.key, title: subscription.title, image: subscription.image, variant: subscription.variant, ep, manual: true })
      global.animeV1NotifyQueuedIds.add(`${m.chat}:${id}`)
    }
    processQueue().catch(() => {})
    return m.reply(`📥 Enviando como prueba: *${subscription.title}* episodio *${episodeNumber(ep)}*.`)
  }
}

handler.command = /^(animev1start|animev1stop|animev1list|animev1status|animev1check|animev1interval|animev1queue|animev1flush|animev1unblock|animev1example)$/i
handler.tags = ['anime', 'notificaciones']
handler.help = ['animev1start [intervalo]', 'animev1stop', 'animev1list', 'animev1status', 'animev1check', 'animev1interval <tiempo>', 'animev1queue', 'animev1flush', 'animev1unblock', 'animev1example']
handler.exp = 0
handler.limit = false

handler.before = async (m, { conn }) => {
  if (conn) global.animeV1NotifyConn = conn
  restoreChats(conn)
}

export default handler
