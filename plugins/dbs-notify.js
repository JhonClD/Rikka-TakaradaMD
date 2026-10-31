import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import {
  request, zeroPad, buildFileName, ordenarServidores,
  descargarMega, descargarMediaFire, descargarEmbed,
} from './jk-dbs-common.mjs'

const ANIMEDBS_URL = 'https://www.animedbs.online'
const SEEN_FILE = path.join(process.env.TMPDIR || '/tmp', 'dbs_seen.json')
const STATE_FILE = path.join(process.env.TMPDIR || '/tmp', 'dbs_state.json')
const CHECK_INTERVAL_DEFAULT = 10
const QUEUE_DELAY = 90_000
const DL_TIMEOUT = 3 * 60 * 60 * 1000

global.dbsActiveChats = global.dbsActiveChats || new Map()
global.dbsEpisodeQueue = global.dbsEpisodeQueue || []
global.dbsQueueRunning = global.dbsQueueRunning || false
global.dbsConn = global.dbsConn || null

async function fetchLatestEpisodesDBS() {
  const { data } = await request(ANIMEDBS_URL, { timeout: 15000 })
  const $ = cheerio.load(data)
  const lista = []

  $('.listupd .bs').each((_, el) => {
    const $el = $(el)
    const aTag = $el.find('a').first()
    const href = aTag.attr('href') || ''
    if (!href) return

    const epUrl = href.startsWith('http') ? href : ANIMEDBS_URL + href
    const epxText = $el.find('.epx').text().trim()
    const epNumStr = epxText.match(/\d+/)?.[0] || epUrl.match(/episodio[- _]?(\d+)/i)?.[1] || '0'
    const epNum = parseInt(epNumStr)

    const anime = $el.find('.tite1').text().trim()
    const h2 = $el.find('h2').text().trim()
    const titulo = anime || h2.replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').trim() || 'Anime desconocido'

    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || ''
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc.startsWith('//') ? 'https:' + imgSrc : imgSrc ? ANIMEDBS_URL + imgSrc : ''

    const slugBase = titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const id = `dbs-${slugBase}-${epNum}`

    if (!lista.find(e => e.id === id))
      lista.push({ id, slug: slugBase, titulo, epNum, epUrl, imgUrl, fuente: 'animedbs' })
  })

  return lista
}

async function scrapeServidoresDBS(epUrl) {
  const { data } = await request(epUrl, { headers: { Referer: ANIMEDBS_URL }, timeout: 15000 })
  const $ = cheerio.load(data)
  const srvs = []

  $('.soraddlx').each((_, bloque) => {
    const $bloque = $(bloque)
    $bloque.find('.soraurlx').each((_, urlBlk) => {
      const calidad = $(urlBlk).find('strong').text().trim()
      $(urlBlk).find('a[href]').each((_, el) => {
        const href = $(el).attr('href') || ''
        const label = $(el).text().trim().toLowerCase()
        if (!href.startsWith('http')) return
        if (srvs.find(s => s.url === href)) return
        const esMega = href.includes('mega.nz') || href.includes('mega.co.nz')
        const esMediafire = href.includes('mediafire.com')
        if (href.includes('hqq.tv') || href.includes('netu.tv') || href.includes('netu.ac')) return
        srvs.push({
          nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : label || detectarServNombre(href),
          url: href,
          calidad: calidad || '720p',
          directo: esMega || esMediafire,
        })
      })
    })
  })

  if (srvs.length === 0) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      if (!href.startsWith('http')) return
      const esMega = href.includes('mega.nz') || href.includes('mega.co.nz')
      const esMediafire = href.includes('mediafire.com')
      if (!esMega && !esMediafire) return
      if (srvs.find(s => s.url === href)) return
      srvs.push({ nombre: esMega ? 'mega' : 'mediafire', url: href, calidad: '720p', directo: true })
    })
  }

  if (srvs.length === 0) {
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.startsWith('http')) srvs.push({ nombre: 'iframe', url: src, calidad: '', directo: false })
    })
  }

  srvs.sort((a, b) => {
    if (!a.directo && b.directo) return 1
    if (a.directo && !b.directo) return -1
    const aP = a.calidad.includes('720') ? 0 : a.calidad.includes('1080') ? 1 : 2
    const bP = b.calidad.includes('720') ? 0 : b.calidad.includes('1080') ? 1 : 2
    return aP - bP
  })

  return srvs
}

function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) } catch (_) { return {} } }
function saveSeen(d) { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch (_) { return {} } }
function saveState(d) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

async function enviarEpisodio(chatId, ep, conn) {
  const { titulo, epNum, epUrl, imgUrl } = ep
  const fileName = buildFileName(titulo, epNum)
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', `dbs_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const bandera = '🌐'
  const etiqueta = 'AnimeDBS 🌐'
  try {
    const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
    const caption = `*✨Nuevo Episodio ✨*\n━━━━━━━━━━━━━━━━━━━━━\n> ${bandera} ${titulo}\n> 🆕 Capítulo: *${epNum}*\n> 🕐 Publicado: *${ahora}*\n> 🌐 Ver online: ${epUrl}\n> 📡 Fuente: *${etiqueta}*\n━━━━━━━━━━━━━━━━━━━━━\n✅ _INICIANDO DESCARGA..._`
    if (imgUrl) {
      try { const imgRes = await request(imgUrl, { responseType: 'arraybuffer', timeout: 10000 }); await conn.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption }) }
      catch (_) { await conn.sendMessage(chatId, { text: caption }) }
    } else await conn.sendMessage(chatId, { text: caption })
    const srvs = await scrapeServidoresDBS(epUrl)
    if (!srvs.length) throw new Error('No se encontraron servidores de video')
    await new Promise(r => setTimeout(r, 15_000))
    let videoPath = null
    for (const srv of ordenarServidores(srvs).slice(0, 5)) {
      try {
        if (srv.nombre === 'mega') videoPath = await descargarMega(srv.url, tmpDir, fileName)
        else if (srv.nombre === 'mediafire') videoPath = await descargarMediaFire(srv.url, tmpDir, fileName)
        else videoPath = await descargarEmbed(srv.url, tmpDir, fileName, ANIMEDBS_URL)
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
  if (global.dbsQueueRunning || !global.dbsEpisodeQueue.length) return
  global.dbsQueueRunning = true
  try {
    while (global.dbsEpisodeQueue.length) {
      const item = global.dbsEpisodeQueue[0]
      if (!item) { global.dbsEpisodeQueue.shift(); continue }
      const { chatId, ep } = item
      let ok = false
      for (let intento = 1; intento <= 3 && !ok; intento++) {
        const conn = global.dbsConn
        if (!conn) { await new Promise(r => setTimeout(r, 180_000)); continue }
        try { await enviarEpisodio(chatId, ep, conn); ok = true; global.dbsEpisodeQueue.shift() }
        catch (err) {
          if (intento < 3 && /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)) await new Promise(r => setTimeout(r, intento * 180_000))
          else if (intento === 3 && /connection closed|stream errored|timed out|econnreset|socket hang up|precondition required/i.test(err.message)) { global.dbsEpisodeQueue.shift(); global.dbsEpisodeQueue.push(item); await new Promise(r => setTimeout(r, 300_000)) }
          else { global.dbsEpisodeQueue.shift(); try { await global.dbsConn?.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${err.message}` }) } catch (_) {} }
        }
      }
      if (global.dbsEpisodeQueue.length) await new Promise(r => setTimeout(r, QUEUE_DELAY))
    }
  } finally { global.dbsQueueRunning = false }
}

async function checkNuevosEpisodios(chatId, conn) {
  let lista = []
  try { lista = await fetchLatestEpisodesDBS() } catch (_) { return }
  if (!lista.length) return
  const seen = loadSeen(); if (!seen[chatId]) seen[chatId] = []
  const nuevos = lista.filter(e => !seen[chatId].includes(e.id))
  if (!nuevos.length) return
  for (const ep of nuevos) seen[chatId].push(ep.id)
  if (seen[chatId].length > 500) seen[chatId] = seen[chatId].slice(-500)
  saveSeen(seen)
  if (nuevos.length > 1) try { await conn.sendMessage(chatId, { text: `📋 *${nuevos.length} episodios nuevos detectados*\n\n` + nuevos.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)} [🌐 AnimeDBS]`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._' }) } catch (_) {}
  for (const ep of nuevos) global.dbsEpisodeQueue.push({ chatId, ep })
  procesarCola().catch(() => {})
}
function iniciarNotificador(chatId, conn, intervalMin = CHECK_INTERVAL_DEFAULT) {
  if (conn) global.dbsConn = conn
  if (global.dbsActiveChats.has(chatId)) clearInterval(global.dbsActiveChats.get(chatId).timer)
  const timer = setInterval(() => { const c = global.dbsConn; if (c) checkNuevosEpisodios(chatId, c).catch(() => {}) }, intervalMin * 60 * 1000)
  global.dbsActiveChats.set(chatId, { timer, intervalMin, startedAt: Date.now() })
  const state = loadState(); state[chatId] = { intervalMin, startedAt: Date.now() }; saveState(state)
}
function detenerNotificador(chatId) { const entry = global.dbsActiveChats.get(chatId); if (entry) { clearInterval(entry.timer); global.dbsActiveChats.delete(chatId) } const state = loadState(); delete state[chatId]; saveState(state) }
function restaurarNotificadores(conn) { for (const [chatId, cfg] of Object.entries(loadState())) if (!global.dbsActiveChats.has(chatId)) iniciarNotificador(chatId, conn, cfg.intervalMin || CHECK_INTERVAL_DEFAULT) }
if (!global.dbsWatchdog) global.dbsWatchdog = setInterval(() => restaurarNotificadores(global.dbsConn), 2 * 60 * 1000)

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (conn) global.dbsConn = conn
  restaurarNotificadores(conn)
  if (command === 'dbsstart') {
    const min = parseInt(text?.trim()); const intervalMin = (!isNaN(min) && min >= 5 && min <= 60) ? min : CHECK_INTERVAL_DEFAULT
    iniciarNotificador(m.chat, conn, intervalMin)
    await conn.sendMessage(m.chat, { text: `✅ *Notificador AnimeDBS activado*\n\n╭━━━━━━〔 📡 〕━━━━━━\n┃ ⏱️ Intervalo: *${intervalMin} min*\n┃ 🌐 AnimeDBS\n┃ 💬 Chat registrado\n╰━━━━━━━━━━━━━━━━━━\n\n_Usa ${usedPrefix}dbsstop para detener._` }, { quoted: m })
    try { const lista = await fetchLatestEpisodesDBS(); const seen = loadSeen(); if (!seen[m.chat]) seen[m.chat] = []; for (const ep of lista) if (!seen[m.chat].includes(ep.id)) seen[m.chat].push(ep.id); seen[m.chat] = seen[m.chat].slice(-500); saveSeen(seen); await conn.sendMessage(m.chat, { text: `📋 *${lista.length}* episodios de AnimeDBS registrados como base.\n_Solo los nuevos se enviarán._` }, { quoted: m }) } catch (err) { await conn.sendMessage(m.chat, { text: `⚠️ Chequeo inicial falló: ${err.message}` }, { quoted: m }) }
    return
  }
  if (command === 'dbsstop') { if (!global.dbsActiveChats.has(m.chat)) return m.reply('ℹ️ El notificador no estaba activo.'); detenerNotificador(m.chat); return m.reply(`🛑 *Notificador detenido.*\n_Usa ${usedPrefix}dbsstart para reactivar._`) }
  if (command === 'dbsstatus') { const active = global.dbsActiveChats.has(m.chat); const entry = global.dbsActiveChats.get(m.chat); const cola = global.dbsEpisodeQueue.filter(i => i.chatId === m.chat); const vistos = (loadSeen()[m.chat] || []).length; return m.reply(`📡 *Estado AnimeDBS*\n\n${active ? `✅ *Activo* — cada ${entry.intervalMin} min` : '🔴 *Inactivo*'}\n📋 Cola: *${cola.length}* pendiente(s)\n🔵 Procesando: *${global.dbsQueueRunning ? 'Sí' : 'No'}*\n👁️ Vistos: *${vistos}*`) }
  if (command === 'dbsqueue') return m.reply(global.dbsEpisodeQueue.length ? `📋 *Cola (${global.dbsEpisodeQueue.length}):*\n\n` + global.dbsEpisodeQueue.map((i,n) => `${n+1}. *${i.ep.titulo}* ep ${zeroPad(i.ep.epNum)} ${i.chatId === m.chat ? '← este chat' : ''}`).join('\n') : '✅ Cola vacía.')
  if (command === 'dbsflush') { const antes = global.dbsEpisodeQueue.length; global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(i => i.chatId !== m.chat); return m.reply(`🗑️ *${antes - global.dbsEpisodeQueue.length}* episodio(s) eliminado(s).`) }
  if (command === 'dbsunblock') { const estaba = global.dbsQueueRunning; global.dbsQueueRunning = false; procesarCola().catch(() => {}); return m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.`) }
  if (command === 'dbscheck') { await m.reply('🔍 Chequeando AnimeDBS...'); const antes = global.dbsEpisodeQueue.length; await checkNuevosEpisodios(m.chat, conn); if (global.dbsEpisodeQueue.length === antes) await m.reply('✅ Sin episodios nuevos.'); return }
  if (command === 'dbsinterval') { const min = parseInt(text?.trim()); if (isNaN(min) || min < 5 || min > 60) return m.reply(`❌ Número entre *5* y *60*.\nEj: ${usedPrefix}dbsinterval 15`); if (!global.dbsActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}dbsstart* primero.`); iniciarNotificador(m.chat, conn, min); return m.reply(`⏱️ Intervalo actualizado a *${min} minutos*.`) }
  if (command === 'dbsexample') { const cantidad = Math.min(Math.max(parseInt(text?.trim()) || 1, 1), 10); await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *AnimeDBS*...`); let lista; try { lista = await fetchLatestEpisodesDBS() } catch (err) { return m.reply(`❌ Error: ${err.message}`) } if (!lista.length) return m.reply('❌ Sin episodios disponibles.'); const seleccion = lista.slice(0, cantidad); if (seleccion.length > 1) await m.reply(`📋 *${seleccion.length} episodios seleccionados (AnimeDBS 🌐):*\n\n` + seleccion.map((e,i) => `${i+1}. *${e.titulo}* — Ep ${zeroPad(e.epNum)}`).join('\n') + '\n\n⏳ _Se enviarán de uno en uno..._'); for (const ep of seleccion) global.dbsEpisodeQueue.push({ chatId: m.chat, ep }); procesarCola().catch(() => {}); return }
}
handler.command = /^(?:dbsstart|dbsstop|dbsstatus|dbscheck|dbsqueue|dbsflush|dbsunblock|dbsinterval|dbsexample)$/i
handler.tags = ['anime', 'notificaciones']
handler.help = ["'dbsstart'", "'dbsstop'", "'dbsstatus'", "'dbscheck'", "'dbsqueue'", "'dbsflush'", "'dbsunblock'", "'dbsinterval <min>'", "'dbsexample [N]'"]
handler.exp = 0
handler.level = 0
handler.limit = false
handler.before = async (m, { conn }) => { if (conn) global.dbsConn = conn; restaurarNotificadores(conn) }
export default handler
