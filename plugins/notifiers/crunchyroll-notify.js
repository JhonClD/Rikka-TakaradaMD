/**
 * crunchyroll-notify.js — Plugin KanaArima-MD / Rikka-Bot (Baileys)
 * Modos: Anónimo (sin cuenta) | Cuenta real (con refresh automático)
 * Filtro estricto: Solo Japonés, Latino y Castellano.
 * Formato: Corto y ultra limpio.
 * v2: Auto-start al arrancar el bot + soporte multi-grupo
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp')
const DB_PATH   = join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH  = join(TMP_DIR, 'crunchyroll-cfg.json')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

// ─── Constantes ──────────────────────────────────────────────────────────────
const CR_BASE    = 'https://www.crunchyroll.com'
const CR_BETA    = 'https://beta-api.crunchyroll.com'
const CR_AUTH    = `${CR_BASE}/auth/v1/token`
const BASIC_ANON = 'Basic dC1rZGdwMmg4YzNqdWI4Zm4wZnE6eWZMRGZNZnJZdktYaDRKWFMxTEVJMmNDcXUxdjVXYW4='
const BASIC_AUTH = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZMdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA      = 'Crunchyroll/ANDROIDTV/3.59.0_22338 (Android 13.0; en-US; TCL-S5400AF Build/TP1A.220624.014)'
const DEVICE_ID  = '00000000-dead-beef-cafe-000000000000'
const DEVICE_TYPE= 'ANDROIDTV'

// ─── Persistencia ─────────────────────────────────────────────────────────────
function loadCfg() {
  try {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    // Migración automática: targetJid (string viejo) → targetJids (array nuevo)
    if (cfg.targetJid && !cfg.targetJids) {
      cfg.targetJids = [cfg.targetJid]
      delete cfg.targetJid
      writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf-8')
    }
    if (!cfg.targetJids) cfg.targetJids = []
    return cfg
  } catch { return { targetJids: [] } }
}
function saveCfg(d)    { writeFileSync(CFG_PATH, JSON.stringify(d, null, 2), 'utf-8') }
function loadSeen()    { try { return JSON.parse(readFileSync(DB_PATH,  'utf-8')) } catch { return [] } }
function saveSeen(ids) { writeFileSync(DB_PATH,  JSON.stringify(ids.slice(-300)), 'utf-8') }

// ─── Cookie jar ──────────────────────────────────────────────────────────────
let _cookies = ''
async function preLogin() {
  try {
    const res = await fetch(CR_BASE, { headers: { 'User-Agent': CR_UA }, signal: AbortSignal.timeout(15_000) })
    const raw = res.headers.getSetCookie?.() || []
    _cookies  = raw.map(c => c.split(';')[0]).join('; ')
  } catch { /* no crítico */ }
}

// ─── Tokens ───────────────────────────────────────────────────────────────────
let _token = null, _tokenExp = 0

async function getAnonToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({ grant_type: 'client_id', scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_ANON, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'ETP-Anonymous-ID': DEVICE_ID, 'Cookie': _cookies },
    body: body.toString(), signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Auth anónima HTTP ${res.status}: ${t.slice(0,80)}`) }
  const data = await res.json()
  _token = data.access_token; _tokenExp = Date.now() + (data.expires_in || 300) * 1000
  return _token
}

async function loginWithAccount(email, password) {
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({ grant_type: 'password', username: email, password, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'ETP-Anonymous-ID': DEVICE_ID, 'Cookie': _cookies },
    body: body.toString(), signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error_description || e.error || `HTTP ${res.status}`) }
  const data = await res.json()
  const cfg  = loadCfg()
  Object.assign(cfg, { accessToken: data.access_token, refreshToken: data.refresh_token || null, tokenExp: Date.now() + (data.expires_in || 300) * 1000, accountId: data.account_id || null, loggedIn: true })
  saveCfg(cfg); _token = data.access_token; _tokenExp = cfg.tokenExp
  return data
}

async function refreshAccountToken() {
  const cfg = loadCfg()
  if (!cfg.refreshToken) throw new Error('Sin refresh_token — usa .crlogin de nuevo')
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'Cookie': _cookies },
    body: body.toString(), signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Refresh HTTP ${res.status}`)
  const data = await res.json()
  cfg.accessToken  = data.access_token
  cfg.refreshToken = data.refresh_token || cfg.refreshToken
  cfg.tokenExp     = Date.now() + (data.expires_in || 300) * 1000
  saveCfg(cfg); _token = data.access_token; _tokenExp = cfg.tokenExp
  console.log('[CR-Notify] Token renovado.')
  return _token
}

async function getToken() {
  const cfg = loadCfg()
  if (cfg.loggedIn) {
    if (_token && Date.now() < _tokenExp - 30_000) return _token
    if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - 30_000) { _token = cfg.accessToken; _tokenExp = cfg.tokenExp; return _token }
    return refreshAccountToken()
  }
  return getAnonToken()
}

// ─── Fetch autenticado ────────────────────────────────────────────────────────
async function crFetch(path, params = {}, base = CR_BASE) {
  const token = await getToken()
  const url   = new URL(`${base}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res   = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': CR_UA, 'Accept': 'application/json', 'Cookie': _cookies },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`CR API HTTP ${res.status} → ${path}`)
  return res.json()
}

// ─── Lógica de Procesamiento ──────────────────────────────────────────────────
function extractImage(images = {}) {
  const src = images.thumbnail || images.poster_tall || images.poster_wide
  if (!src) return ''
  if (typeof src === 'string') return src
  if (Array.isArray(src)) {
    const flat = src.flat().filter(Boolean)
    return flat.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.source || ''
  }
  return ''
}

function normalizeEpisode(p) {
  const meta    = p.episode_metadata || {}
  const airRaw  = p.episode_air_date || p.premium_available_date || p.availability_starts || ''
  const airTime = airRaw ? new Date(airRaw).getTime() : 0
  const epNum   = p.episode_number ?? meta.episode_number ?? null
  const epId    = p.id || ''
  const slug    = p.slug_title || meta.slug_title || ''

  let locale = p.audio_locale || meta.audio_locale || ''
  if (!locale && epId) {
    if (epId.endsWith('JAJP')) locale = 'ja-JP'
    else if (epId.endsWith('ES419') || epId.endsWith('LA')) locale = 'es-419'
    else if (epId.endsWith('ESES')) locale = 'es-ES'
  }

  let seriesName = p.series_title || meta.series_title || ''
  const seasonTitle = p.season_title || meta.season_title || ''

  if (seasonTitle && seriesName && !seriesName.includes(seasonTitle) && !seriesName.includes('Season')) {
    seriesName += ` ${seasonTitle}`
  }
  if (!seriesName.trim()) seriesName = p.title || 'Anime Desconocido'

  return {
    id: epId,
    series: seriesName.trim(),
    epTitle: p.title || '',
    epNum: epNum !== null ? epNum : 'Especial',
    link: `https://www.crunchyroll.com/watch/${epId}${slug ? `/${slug}` : ''}`,
    audioLocale: locale,
    image: extractImage(p.images),
    airTime
  }
}

// ─── Formato Limpio y Corto ───────────────────────────────────────────────────
const FLAG = {
  'ja-JP':'🇯🇵','en-US':'🇺🇸','es-419':'🇲🇽','es-LA':'🇲🇽','es-ES':'🇪🇸','pt-BR':'🇧🇷',
  'fr-FR':'🇫🇷','de-DE':'🇩🇪','it-IT':'🇮🇹','ru-RU':'🇷🇺','ar-SA':'🇸🇦',
}
const LOCALE_NAME = {
  'ja-JP':'Japonés','en-US':'Inglés','es-419':'Latino','es-LA':'Latino','es-ES':'Castellano',
  'pt-BR':'Portugués','fr-FR':'Francés','de-DE':'Alemán','it-IT':'Italiano','ru-RU':'Ruso','ar-SA':'Árabe',
}
const ALLOWED_LOCALES = new Set(['ja-JP','es-419','es-LA','es-ES'])

function formatCaption(ep) {
  const audioFlag  = FLAG[ep.audioLocale] || '🌐'
  const localeName = LOCALE_NAME[ep.audioLocale] || ep.audioLocale
  const epLabel    = `Ep. ${ep.epNum}`
  const epLine     = ep.epTitle ? `${epLabel} - ${ep.epTitle}` : epLabel
  return (
    `📺 ${ep.series}\n` +
    `🎬 ${epLine}\n` +
    `${audioFlag} ${localeName}\n\n` +
    `${ep.link}`
  )
}

// ─── Fetch episodios ──────────────────────────────────────────────────────────
async function fetchNewEpisodes() {
  const data  = await crFetch('/content/v1/browse', { count: '100', sort_by: 'newly_added', type: 'episode', locale: 'es-419' }, CR_BETA)
  const rows  = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []
  const valid = rows.map(normalizeEpisode).filter(i => i.id && i.series && ALLOWED_LOCALES.has(i.audioLocale))
  if (!valid.length) return []

  const seen = loadSeen()

  // Primera ejecución: caché vacío → solo sembramos los IDs sin enviar nada
  if (seen.length === 0) {
    saveSeen(valid.map(i => i.id))
    console.log(`[CR-Notify] Caché sembrado con ${valid.length} IDs.`)
    return []
  }

  return valid.filter(i => !seen.includes(i.id))
}

function markSeen(id) {
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

async function getLatestEpisodes(limit = 10) {
  const data = await crFetch('/content/v1/browse', { count: '100', sort_by: 'newly_added', type: 'episode', locale: 'es-419' }, CR_BETA)
  const rows = Array.isArray(data?.items) ? data.items : []
  return rows.map(normalizeEpisode).filter(i => ALLOWED_LOCALES.has(i.audioLocale)).slice(0, limit)
}

// ─── Envío ────────────────────────────────────────────────────────────────────
async function sendItem(conn, jid, ep, quoted = null) {
  const caption = formatCaption(ep)
  const opts    = quoted ? { quoted } : {}
  if (ep.image) {
    try { await conn.sendMessage(jid, { image: { url: ep.image }, caption }, opts); return } catch { /* fallback texto */ }
  }
  await conn.sendMessage(jid, { text: caption }, opts)
}
const delay = ms => new Promise(r => setTimeout(r, ms))

// ─── Cron ─────────────────────────────────────────────────────────────────────
let cronTimer = null
let storedConn = null

function stopCron() { if (cronTimer) { clearInterval(cronTimer); cronTimer = null } }

// Devuelve la conexión activa: primero la guardada, si no global.conn del bot
function getConn() { return storedConn || global.conn || null }

function startCron(conn) {
  if (conn) storedConn = conn
  stopCron()

  const cfg     = loadCfg()
  const minutes = parseInt(process.env.CR_MINUTES ?? cfg.minutes ?? '5')

  // ✅ El cron SIEMPRE arranca — espera la conexión y los grupos en cada tick
  cronTimer = setInterval(async () => {
    const activeConn = getConn()
    if (!activeConn) return  // Bot aún no conectado, siguiente tick

    const jids = loadCfg().targetJids || []
    if (!jids.length) return  // Sin grupos configurados aún

    try {
      const items = await fetchNewEpisodes()
      if (!items.length) return

      for (const ep of items) {
        for (const jid of jids) {
          try {
            await sendItem(activeConn, jid, ep)
            await delay(1500)
          } catch (err) {
            console.error(`[CR-Notify] Error enviando a ${jid}:`, err.message)
          }
        }
        markSeen(ep.id)  // Marcar después de enviarlo a todos los grupos
        await delay(3000)
      }
      console.log(`[CR-Notify] ${items.length} ep(s) → ${jids.length} grupo(s)`)
    } catch (err) { console.error('[CR-Notify] Cron:', err.message) }
  }, minutes * 60_000)

  const jids = loadCfg().targetJids || []
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${jids.length} grupo(s) configurado(s)`)
}

// ─── Handler ──────────────────────────────────────────────────────────────────
let handler = async (m, { conn, command, args, isOwner }) => {
  // Guardar conexión en cada llamada para que el cron la use
  if (conn) storedConn = conn
  if (!cronTimer) startCron(conn)

  // ── .crlogin ──────────────────────────────────────────────────────────────
  if (command === 'crlogin') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const [email, pass] = args
    if (!email || !pass) return conn.sendMessage(m.chat, { text: '💡 Uso: *.crlogin email contraseña*' }, { quoted: m })
    await conn.sendMessage(m.chat, { text: '🔐 Conectando con Crunchyroll...' }, { quoted: m })
    try {
      await loginWithAccount(email, pass)
      startCron(conn)
      const cfg = loadCfg()
      return conn.sendMessage(m.chat, {
        text: `✅ *Login exitoso*\n👤 Cuenta real activa\n🎯 Grupos: ${cfg.targetJids.length}\n🔄 Monitor cada ${process.env.CR_MINUTES || cfg.minutes || 5} min\n🔁 Refresh automático habilitado`,
      }, { quoted: m })
    } catch (e) { return conn.sendMessage(m.chat, { text: `❌ *Auth fallida*\n${e.message}` }, { quoted: m }) }
  }

  // ── .crlogout ─────────────────────────────────────────────────────────────
  if (command === 'crlogout') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    // Borrar solo credenciales, conservar la lista de grupos
    delete cfg.accessToken; delete cfg.refreshToken; delete cfg.tokenExp
    delete cfg.accountId; delete cfg.loggedIn
    saveCfg(cfg)
    _token = null; _tokenExp = 0
    return conn.sendMessage(m.chat, {
      text: `🔒 Sesión cerrada. Grupos conservados (${cfg.targetJids.length}).\nEl cron continúa en modo anónimo.`,
    }, { quoted: m })
  }

  // ── .crset — Añade este chat a la lista de grupos ─────────────────────────
  if (command === 'crset') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    if (cfg.targetJids.includes(m.chat)) {
      return conn.sendMessage(m.chat, { text: `ℹ️ Este chat ya está en la lista.\n📋 Grupos: *${cfg.targetJids.length}*` }, { quoted: m })
    }
    cfg.targetJids.push(m.chat)
    saveCfg(cfg)
    return conn.sendMessage(m.chat, {
      text: `✅ *Grupo añadido al notificador*\n\`${m.chat}\`\n\n📋 Total grupos: *${cfg.targetJids.length}*`,
    }, { quoted: m })
  }

  // ── .crrem — Elimina este chat de la lista de grupos ──────────────────────
  if (command === 'crrem') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    const before = cfg.targetJids.length
    cfg.targetJids = cfg.targetJids.filter(j => j !== m.chat)
    saveCfg(cfg)
    return conn.sendMessage(m.chat, {
      text: before !== cfg.targetJids.length
        ? `🗑️ *Grupo eliminado del notificador*\n\`${m.chat}\`\n📋 Quedan: *${cfg.targetJids.length}*`
        : `⚠️ Este chat no estaba en la lista.`,
    }, { quoted: m })
  }

  // ── .crstatus ─────────────────────────────────────────────────────────────
  if (command === 'crstatus') {
    const cfg  = loadCfg()
    const mins = process.env.CR_MINUTES || cfg.minutes || '5'
    const seen = loadSeen()
    const exp  = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
    const gruposList = cfg.targetJids.length
      ? cfg.targetJids.map((j, i) => `  ${i + 1}. \`${j}\``).join('\n')
      : '  _Ninguno — usa .crset_'
    return conn.sendMessage(m.chat, {
      text: `📊 *CR-Notify Status*\n\n` +
            `🔑 Modo: *${cfg.loggedIn ? '👤 Cuenta real ✅' : '👻 Anónimo'}*\n` +
            `⏳ Token expira: *${exp}*\n` +
            `🔁 Refresh token: *${cfg.refreshToken ? 'Sí ✅' : 'No ❌'}*\n` +
            `⏱ Cron: cada *${mins} min*\n` +
            `🔄 Cron activo: *${cronTimer ? 'Sí ✅' : 'No ❌'}*\n` +
            `💾 IDs caché: *${seen.length}*\n\n` +
            `🎯 *Grupos configurados (${cfg.targetJids.length}):*\n${gruposList}`,
    }, { quoted: m })
  }

  // ── .crlist ───────────────────────────────────────────────────────────────
  if (command === 'crlist') {
    await conn.sendMessage(m.chat, { text: '🔍 Obteniendo los 10 lanzamientos más recientes...' }, { quoted: m })
    try {
      const episodes = await getLatestEpisodes(10)
      if (!episodes.length) return conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios recientes.' }, { quoted: m })
      for (const ep of episodes) { await sendItem(conn, m.chat, ep, m); await delay(2000) }
    } catch (err) { await conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m }) }
    return
  }

  // ── .crnotify ─────────────────────────────────────────────────────────────
  if (command === 'crnotify') {
    await conn.sendMessage(m.chat, { text: '🔍 Buscando episodios recientes...' }, { quoted: m })
    try {
      const episodes = await getLatestEpisodes(10)
      if (!episodes.length) return conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios.' }, { quoted: m })
      for (const ep of episodes) { await sendItem(conn, m.chat, ep, m); await delay(2000) }
    } catch (err) { await conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m }) }
  }
}

handler.help    = ['crlogin <email> <pass>', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist', 'crnotify']
handler.tags    = ['anime']
handler.command = /^(crlogin|crlogout|crset|crrem|crstatus|crlist|crnotify)$/i

// ─── Auto-arranque al cargar el plugin ───────────────────────────────────────
// Se ejecuta inmediatamente al importar el archivo.
// global.conn es la conexión de Baileys que el bot principal expone globalmente.
// El cron arranca aunque global.conn aún no esté listo — cada tick lo reintenta.
;(async () => {
  const cfg = loadCfg()
  // Restaurar token de sesión si existe
  if (cfg.loggedIn && cfg.accessToken) {
    _token    = cfg.accessToken
    _tokenExp = cfg.tokenExp || 0
  }
  startCron(null)  // 🚀 Arranca el cron sin esperar ningún comando
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${cfg.targetJids.length} | Modo: ${cfg.loggedIn ? 'Cuenta' : 'Anónimo'}`)
})()

export default handler
