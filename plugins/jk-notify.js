import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import {
  request, zeroPad, buildFileName, ordenarServidores,
  descargarMega, descargarMediaFire, descargarEmbed,
} from './jk-dbs-common.mjs'

const JKANIME_URL = 'https://jkanime.net'
const SEEN_FILE = path.join(process.env.TMPDIR || '/tmp', 'jk_seen.json')
const STATE_FILE = path.join(process.env.TMPDIR || '/tmp', 'jk_state.json')
const CHECK_INTERVAL_DEFAULT = 10
const QUEUE_DELAY = 90_000
const DL_TIMEOUT = 3 * 60 * 60 * 1000

global.jkActiveChats = global.jkActiveChats || new Map()
global.jkEpisodeQueue = global.jkEpisodeQueue || []
global.jkQueueRunning = global.jkQueueRunning || false
global.jkConn = global.jkConn || null

async function fetchLatestEpisodesJK() {
  const { data } = await request(JKANIME_URL, { timeout: 15000 })
  const $ = cheerio.load(data)
  const lista = []

  $('#animes .dir1').each((_, el) => {
    const $el = $(el)
    const aTag = $el.find('a').first()
    const href = aTag.attr('href') || ''
    if (!href) return

    const m = href.match(/jkanime\.net\/([^/]+)\/(\d+)\/?$/) || href.match(/^\/([^/]+)\/(\d+)\/?$/)
    if (!m) return

    const slug = m[1]
    const epNum = parseInt(m[2])
    const tiempo = $el.find('.badge-secondary').text().trim()

    if (!tiempo.toLowerCase().includes('hoy') && !tiempo.toLowerCase().includes('ayer')) return

    const titulo = ($el.find('.card-title').text() || aTag.attr('title') || slug.replace(/-/g, ' ')).trim()
    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || ''
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc ? JKANIME_URL + imgSrc : ''
    const epUrl = href.startsWith('http') ? href : JKANIME_URL + href
    const id = `jk-${slug.toLowerCase()}-${epNum}`

    if (!lista.find(e => e.id === id))
      lista.push({ id, slug, titulo, epNum, epUrl, imgUrl, fuente: 'jkanime' })
  })

  if (lista.length === 0) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m = href.match(/jkanime\.net\/([^/]+)\/(\d+)\/?$/) || href.match(/^\/([^/]+)\/(\d+)\/?$/)
      if (!m) return
      const slug = m[1]
      const epNum = parseInt(m[2])
      const id = `jk-${slug.toLowerCase()}-${epNum}`
      if (lista.find(e => e.id === id)) return
      const titulo = ($(el).attr('title') || $(el).text() || slug.replace(/-/g, ' ')).trim()
      const epUrl = href.startsWith('http') ? href : JKANIME_URL + href
      lista.push({ id, slug, titulo, epNum, epUrl, imgUrl: '', fuente: 'jkanime' })
    })
  }

  return lista
}

async function scrapeServidoresJK(epUrl) {
  const { data } = await request(epUrl, { headers: { Referer: JKANIME_URL }, timeout: 15000 })
  const $ = cheerio.load(data)
  const srvs = []

  $('script').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('var servers') && !code.includes('var\tservers')) return
    const match = code.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/)
    if (!match) return
    try {
      const servidores = JSON.parse(match[1])
      for (const srv of servidores) {
        if (!srv.remote) continue
        let url = ''
        try { url = Buffer.from(srv.remote, 'base64').toString('utf-8').trim() } catch (_) { continue }
        if (!url.startsWith('http')) continue
        if (srvs.find(s => s.url === url)) continue
        const nombre = (srv.server || '').toLowerCase()
        const esMega = url.includes('mega.nz') || url.includes('mega.co.nz')
        const esMediafire = url.includes('mediafire.com')
        if (url.includes('hqq.tv') || url.includes('netu.tv') || url.includes('netu.ac')) continue
        srvs.push({
          nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : nombre || detectarServNombre(url),
          url,
          directo: esMega || esMediafire,
        })
      }
    } catch (_) {}
  })

  let epId = null
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    const m1 = code.match(/\/ajax\/download_episode\/(\d+)/)
    if (m1) { epId = m1[1]; return false }
    const m2 = code.match(/(?:ep_id|episode_id|episodeId)\s*=\s*(\d+)/)
    if (m2) { epId = m2[1]; return false }
  })

  if (epId && srvs.filter(s => s.directo).length === 0) {
    try {
      const ajaxUrl = `${JKANIME_URL}/ajax/download_episode/${epId}`
      const ajaxRes = await request(ajaxUrl, {
        headers: { Referer: epUrl, 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 12000,
      })
      const d = ajaxRes.data
      if (d?.url?.startsWith('http') && !srvs.find(s => s.url === d.url)) {
        const esMega = d.url.includes('mega.nz')
        const esMediafire = d.url.includes('mediafire.com')
        srvs.push({
          nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : detectarServNombre(d.url),
          url: d.url,
          directo: esMega || esMediafire,
        })
      }
    } catch (_) {}
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href.startsWith('http')) return
    const esMega = href.includes('mega.nz') || href.includes('mega.co.nz')
    const esMediafire = href.includes('mediafire.com')
    if (href.includes('hqq.tv') || href.includes('netu.tv') || (!esMega && !esMediafire)) return
    if (srvs.find(s => s.url === href)) return
    srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, directo: true })
  })

  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, directo: false })
    })
  }

  return srvs
}

function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) } catch (_) { return {} } }
function saveSeen(d) { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch (_) { return {} } }
function saveState(d) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl } = ep
  const fileName = buildFileName(titulo, epNum)
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', `jk_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const bandera = '🇯🇵'
  const etiqueta = 'JKAnime 🇯🇵'
  try {
    const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
    const caption = `*✨Nuevo Episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> ${bandera} ${titulo}\n> 🆕 Capítulo: *${epNum}*\n> 🕐 Publicado: *${ahora}*\n> 🌐 Ver online: ${epUrl}\n> 📡 Fuente: *${etiqueta}*\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`
    if (imgUrl) {
      try { const imgRes = await request(imgUrl, { responseType: 'arraybuffer', timeout: 10000 }); await conn.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption }) }
      catch (_) { await conn.sendMessage(chatId, { text: caption }) }
    } else await conn.sendMessage(chatId, { text: caption })
    const srvs = await scrapeServidoresJK(epUrl)
    if (!srvs.length) throw new Error('No se encontraron servidores de video')
    await new Promise(r => setTimeout(r, 15_000))
    let videoPath = null
    for (const srv of ordenarServidores(srvs).slice(0, 5)) {
      try {
        if (srv.nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        else videoPath = await descargarEmbed(srv.url, tmpDir, fileName, JKANIME_URL)
        break
      } catch (_) {
        for (const f of fs.readdirSync(tmpDir)) { try { if (f !== 'cover.jpg') fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {} }
      }
    }
    if (!videoPath) throw new Error('Todos los servidores fallaron')
    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
    await conn.sendMessage(chatId, { document: { url: videoPath }, fileName, mimetype: 'video/mp4', caption: `✅ *${titulo}*\n📌 Episodio ${zeroPad(epNum)}\n📦 ${sizeMB} MB · ${etiqueta}` })
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} }
}

async function procesarCola() {
  if (global.jkQueueRunning || !global.jkEpisodeQueue.length) return
  global.jkQueueRunning = true
  try {
    while (global.jkEpisodeQueue.length) {
      const item = global.jkEpisodeQueue[0]
      if (!item) { global.jkEpisodeQueue.shift(); continue }
      const { chatId, ep } = item
      let ok = false
      for (let intento = 1; intento <= 3 && !ok; intento++) {
        const conn = global.jkConn
        if (!conn) { await new Promise(r => setTimeout(r, 180_000)); continue }
        try { await enviarEpisodio(chatId, ep, conn); ok = true; global.jkEpisodeQueue.shift() }
        catch (err) {
          if (intento < 3 && /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)) await new Promise(r => setTimeout(r, intento * 180_000))
          else if (intento === 3 && /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)) { global.jkEpisodeQueue.shift(); global.jkEpisodeQueue.push(item); await new Promise(r => setTimeout(r, 300_000)) }
          else { global.jkEpisodeQueue.shift(); try { await global.jkConn?.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}` }) } catch (_) {} }
        }
      }
      if (global.jkEpisodeQueue.length) await new Promise(r => setTimeout(r, QUEUE_DELAY))
    }
  } finally { global.jkQueueRunning = false }
}

async function checkNuevosEpisodios(chatId, conn) {
  let lista = []
  try { lista = await fetchLatestEpisodesJK() } catch (_) { return }
  if (!lista.length) return
  const seen = loadSeen(); if (!seen[chatId]) seen[chatId] = []
  const nuevos = lista.filter(e => !seen[chatId].includes(e.id))
  if (!nuevos.length) return
  for (const ep of nuevos) seen[chatId].push(ep.id)
  if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
  saveSeen(seen)
  if (nuevos.length > 1) try { await conn.sendMessage(chatId, { text: `📋 *${nuevos.length} episodios nuevos detectados*\n\n` + nuevos.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)} [🇯🇵 JKAnime]`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._' }) } catch (_) {}
  for (const ep of nuevos) global.jkEpisodeQueue.push({ chatId, ep })
  procesarCola().catch(() => {})
}
function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.jkConn = conn
  if (global.jkActiveChats.has(chatId)) clearInterval(global.jkActiveChats.get(chatId).timer)
  const timer = setInterval(() => { const c = global.jkConn; if (c) checkNuevosEpisodios(chatId, c).catch(() => {}) }, intervalMin * 60 * 1000)
  global.jkActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState(); state[chatId] = { intervalMin, startedAt: Date.now() }; saveState(state)
}
function detenerNotificador(chatId) { const entry = global.jkActiveChats.get(chatId); if (entry) { clearInterval(entry.timer); global.jkActiveChats.delete(chatId) } const state = loadState(); delete state[chatId]; saveState(state) }
function restaurarNotificadores(conn) { for (const [chatId, cfg] of Object.entries(loadState())) if (!global.jkActiveChats.has(chatId)) iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT) }
if (!global.jkWatchdog) global.jkWatchdog = setInterval(() => restaurarNotificadores(global.jkConn), 2 * 60 * 1000)

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (conn) global.jkConn = conn
  restaurarNotificadores(conn)
  if (command === 'jkstart') {
    const min = parseInt(text?.trim()); const intervalMin = (!isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, { text: `✅ *Notificador JKAnime activado*\n\n╭━━━━━━〔 📡 〕━━━━━━\n┃ ⏱️ Intervalo: *${intervalMin} min*\n┃ 🇯🇵 JKAnime\n┃ 💬 Chat registrado\n╰━━━━━━━━━━━━━━━━━━\n\n_Usa ${usedPrefix}jkstop para detener._` }, { quoted: m })
    try { const lista = await fetchLatestEpisodesJK(); const seen = loadSeen(); if (!seen[m.chat]) seen[m.chat] = []; for (const ep of lista) if (!seen[m.chat].includes(ep.id)) seen[m.chat].push(ep.id); seen[m.chat] = seen[m.chat].slice(-500); saveSeen(seen); await conn.sendMessage(m.chat, { text: `📋 *${lista.length}* episodios de JKAnime registrados como base.\n_Solo los nuevos se enviarán._` }, { quoted: m }) } catch (err) { await conn.sendMessage(m.chat, { text: `⚠️ Chequeo inicial falló: ${err.message}` }, { quoted: m }) }
    return
  }
  if (command === 'jkstop') { if (!global.jkActiveChats.has(m.chat)) return m.reply('ℹ️ El notificador no estaba activo.'); detenerNotificador(m.chat); return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}jkstart para reactivar._`) }
  if (command === 'jkstatus') { const active = global.jkActiveChats.has(m.chat); const entry = global.jkActiveChats.get(m.chat); const cola = global.jkEpisodeQueue.filter(i => i.chatId === m.chat); const vistos = (loadSeen()[m.chat] || []).length; return m.reply(`📡 *Estado JKAnime*\n\n${active ? `✅ *Activo* — cada ${entry.intervalMin} min` : '🔴 *Inactivo*'}\n📋 Cola: *${cola.length}* pendiente(s)\n🔵 Procesando: *${global.jkQueueRunning ? 'Sí' : 'No'}*\n👁️ Vistos: *${vistos}*`) }
  if (command === 'jkqueue') return m.reply(global.jkEpisodeQueue.length ? `📋 *Cola (${global.jkEpisodeQueue.length}):*\n\n` + global.jkEpisodeQueue.map((i,n) => `${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} ${i.chatId === m.chat ? '← este chat' : ''}`).join('\n') : '✅ Cola vacía.')
  if (command === 'jkflush') { const antes = global.jkEpisodeQueue.length; global.jkEpisodeQueue = global.jkEpisodeQueue.filter(i => i.chatId !== m.chat); return m.reply(`🗑️ *${antes - global.jkEpisodeQueue.length}* episodio(s) eliminado(s).`) }
  if (command === 'jkunblock') { const estaba = global.jkQueueRunning; global.jkQueueRunning = false; procesarCola().catch(() => {}); return m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.`) }
  if (command === 'jkcheck') { await m.reply('🔍 Chequeando JKAnime...'); const antes = global.jkEpisodeQueue.length; await checkNuevosEpisodios(m.chat, conn); if (global.jkEpisodeQueue.length === antes) await m.reply('✅ Sin episodios nuevos.'); return }
  if (command === 'jkinterval') { const min = parseInt(text?.trim()); if (isNaN(min) || min < 5 || min > 60) return m.reply(`❌ Número entre *5* y *60*.\nEj: ${usedPrefix}jkinterval 15`); if (!global.jkActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}jkstart* primero.`); iniciarNotificador(m.chat, conn, min); return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`) }
  if (command === 'jkexample') { const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10); await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *JKAnime*...`); let lista; try { lista = await fetchLatestEpisodesJK() } catch (err) { return m.reply(`❌ Error: ${err.message}`) } if (!lista.length) return m.reply('❌ Sin episodios disponibles.'); const seleccion = lista.slice(0, cantidad); if (seleccion.length > 1) await m.reply(`📋 *${seleccion.length} episodios seleccionados (JKAnime 🇯🇵):*\n\n` + seleccion.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._'); for (const ep of seleccion) global.jkEpisodeQueue.push({ chatId: m.chat, ep }); procesarCola().catch(() => {}); return }
}
handler.command = /^(?:jkstart|jkstop|jkstatus|jkcheck|jkqueue|jkflush|jkunblock|jkinterval|jkexample)$/i
handler.tags = ['anime', 'notificaciones']
handler.help = ["'jkstart'", "'jkstop'", "'jkstatus'", "'jkcheck'", "'jkqueue'", "'jkflush'", "'jkunblock'", "'jkinterval <min>'", "'jkexample [N]'"]
handler.exp = 0
handler.level = 0
handler.limit = false
handler.before = async (m, { conn }) => { if (conn) global.jkConn = conn; restaurarNotificadores(conn) }
export default handler
