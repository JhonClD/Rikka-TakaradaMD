/**
 * crunchyroll-notify.js — Plugin KanaArima-MD / Rikka-Bot (Baileys)
 * Modos: Anónimo (sin cuenta) | Cuenta real (con refresh automático)
 * Filtro estricto: Solo Japonés, Latino y Castellano.
 * Formato: Corto y ultra limpio.
 * v3: Anti-duplicados en hot-reload, token single-flight, reintentos,
 *     caché en memoria, envío ordenado y login más seguro.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp')
const DB_PATH   = join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH  = join(TMP_DIR, 'crunchyroll-cfg.json')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

// ─── Constantes ──────────────────────────────────────────────────────────────
const CR_BASE     = 'https://www.crunchyroll.com'
const CR_BETA     = 'https://beta-api.crunchyroll.com'
const CR_AUTH     = `${CR_BASE}/auth/v1/token`
const BASIC_ANON  = process.env.CR_BASIC_ANON || 'Basic dC1rZGdwMmg4YzNqdWI4Zm4wZnE6eWZMRGZNZnJZdktYaDRKWFMxTEVJMmNDcXUxdjVXYW4='
const BASIC_AUTH  = process.env.CR_BASIC_AUTH || 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZMdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA       = 'Crunchyroll/ANDROIDTV/3.59.0_22338 (Android 13.0; en-US; TCL-S5400AF Build/TP1A.220624.014)'
const DEVICE_ID   = '00000000-dead-beef-cafe-000000000000'
const DEVICE_TYPE = 'ANDROIDTV'
const MAX_SEEN    = 500
const MAX_RETRIES = 3          // ticks fallidos antes de descartar un episodio
const TOKEN_SKEW  = 30_000     // margen para renovar el token antes de que expire
const OWNER_ONLY  = new Set(['crlogin', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist', 'crnotify'])

const delay = ms => new Promise(r => setTimeout(r, ms))

// ─── Persistencia ─────────────────────────────────────────────────────────────
// mode 0o600: el cfg contiene tokens de sesión, que no deben ser legibles por otros.
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, path)
}

function saveCfg(d) { writeJsonAtomic(CFG_PATH, d) }

function loadCfg() {
  try {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    let migrated = false
    // Migración automática: targetJid (string viejo) → targetJids (array nuevo)
    if (cfg.targetJid && !cfg.targetJids) {
      cfg.targetJids = [cfg.targetJid]
      delete cfg.targetJid
      migrated = true
    }
    if (!Array.isArray(cfg.targetJids)) cfg.targetJids = cfg.targetJids ? [cfg.targetJids] : []
    cfg.targetJids = [...new Set(cfg.targetJids.filter(j => typeof j === 'string' && j.trim()))]
    if (migrated) saveCfg(cfg)
    return cfg
  } catch { return { targetJids: [] } }
}

function getMinutes() {
  const n = Number(process.env.CR_MINUTES ?? loadCfg().minutes ?? 1)
  return Number.isFinite(n) ? Math.max(1, n) : 1
}

// Caché de IDs vistos en memoria (Set conserva el orden de inserción → slice(-MAX) deja los más nuevos)
let _seen = null
function getSeen() {
  if (_seen) return _seen
  try {
    const ids = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
    _seen = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [])
  } catch { _seen = new Set() }
  return _seen
}
function markSeen(ids) {
  const seen = getSeen()
  for (const id of [].concat(ids)) if (id) seen.add(id)
  const trimmed = [...seen].slice(-MAX_SEEN)
  _seen = new Set(trimmed)
  writeJsonAtomic(DB_PATH, trimmed)
}

// ─── Sesión / Tokens ──────────────────────────────────────────────────────────
let _cookies = ''
let _token = null, _tokenExp = 0
let _pending = null // single-flight: evita refrescar el token varias veces en paralelo

function singleFlight(fn) {
  if (!_pending) _pending = fn().finally(() => { _pending = null })
  return _pending
}

async function preLogin() {
  try {
    const res = await fetch(CR_BASE, { headers: { 'User-Agent': CR_UA }, signal: AbortSignal.timeout(15_000) })
    const raw = res.headers.getSetCookie?.() || []
    _cookies  = raw.map(c => c.split(';')[0]).join('; ')
  } catch { /* no crítico */ }
}

async function tokenRequest(basic, params, { timeout = 15_000, anonId = true } = {}) {
  if (!_cookies) await preLogin()
  const headers = { 'Authorization': basic, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA }
  if (anonId)  headers['ETP-Anonymous-ID'] = DEVICE_ID
  if (_cookies) headers['Cookie'] = _cookies
  const body = new URLSearchParams({ ...params, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  return fetch(CR_AUTH, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(timeout) })
}

function clearSession() {
  const cfg = loadCfg()
  delete cfg.accessToken; delete cfg.refreshToken; delete cfg.tokenExp
  delete cfg.accountId;   delete cfg.loggedIn
  saveCfg(cfg)
  _token = null; _tokenExp = 0
  return cfg
}

// Fuerza renovación del token (también en modo cuenta, donde el token vive en el cfg)
function invalidateToken() {
  _token = null; _tokenExp = 0
  const cfg = loadCfg()
  if (cfg.loggedIn && cfg.tokenExp) { cfg.tokenExp = 0; saveCfg(cfg) }
}

async function getAnonToken() {
  const res = await tokenRequest(BASIC_ANON, { grant_type: 'client_id' })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Auth anónima HTTP ${res.status}: ${t.slice(0, 80)}`) }
  const data = await res.json()
  _token = data.access_token; _tokenExp = Date.now() + (data.expires_in || 300) * 1000
  return _token
}

async function loginWithAccount(email, password) {
  const res = await tokenRequest(BASIC_AUTH, { grant_type: 'password', username: email, password }, { timeout: 20_000 })
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error_description || e.error || `HTTP ${res.status}`) }
  const data = await res.json()
  const cfg  = loadCfg()
  Object.assign(cfg, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExp: Date.now() + (data.expires_in || 300) * 1000,
    accountId: data.account_id || null,
    loggedIn: true,
  })
  saveCfg(cfg); _token = data.access_token; _tokenExp = cfg.tokenExp
  return data
}

async function refreshAccountToken() {
  const cfg = loadCfg()
  if (!cfg.refreshToken) {
    console.warn('[CR-Notify] Sin refresh_token → sesión descartada, modo anónimo.')
    clearSession()
    return getAnonToken()
  }
  const res = await tokenRequest(BASIC_AUTH, { grant_type: 'refresh_token', refresh_token: cfg.refreshToken }, { anonId: false })
  if (!res.ok) {
    // Refresh rechazado de forma definitiva → volver a anónimo en vez de fallar en bucle
    if (res.status === 400 || res.status === 401) {
      console.warn(`[CR-Notify] Refresh rechazado (HTTP ${res.status}) → sesión descartada, modo anónimo. Usa .crlogin de nuevo.`)
      clearSession()
      return getAnonToken()
    }
    throw new Error(`Refresh HTTP ${res.status}`)
  }
  const data = await res.json()
  const fresh = loadCfg()
  fresh.accessToken  = data.access_token
  fresh.refreshToken = data.refresh_token || fresh.refreshToken
  fresh.tokenExp     = Date.now() + (data.expires_in || 300) * 1000
  saveCfg(fresh); _token = data.access_token; _tokenExp = fresh.tokenExp
  console.log('[CR-Notify] Token renovado.')
  return _token
}

async function getToken() {
  if (_token && Date.now() < _tokenExp - TOKEN_SKEW) return _token
  const cfg = loadCfg()
  if (cfg.loggedIn) {
    if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - TOKEN_SKEW) {
      _token = cfg.accessToken; _tokenExp = cfg.tokenExp
      return _token
    }
    return singleFlight(refreshAccountToken)
  }
  return singleFlight(getAnonToken)
}

// ─── Fetch autenticado ────────────────────────────────────────────────────────
// Reintenta: 401 (renueva token, una vez) y 429/5xx (backoff corto).
async function crFetch(path, params = {}, base = CR_BASE) {
  const url = new URL(`${base}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  let renewed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const token   = await getToken()
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': CR_UA, 'Accept': 'application/json' }
    if (_cookies) headers['Cookie'] = _cookies
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) })
    if (res.ok) return res.json()
    if (res.status === 401 && !renewed) { renewed = true; invalidateToken(); continue }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await delay(2000 * (attempt + 1)); continue }
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`CR API HTTP ${res.status} → ${path}${detail ? `: ${detail}` : ''}`)
  }
  throw new Error(`CR API sin respuesta válida → ${path}`)
}

// ─── Lógica de Procesamiento ──────────────────────────────────────────────────
function extractImage(images = {}) {
  // Crunchyroll devuelve thumbnail, poster_tall y poster_wide con varias
  // resoluciones. Se elige la de mayor área; `thumbnail` suele ser miniatura.
  const area = c => c.width * c.height || c.width
  const candidates = Object.values(images)
    .flat(Infinity)
    .filter(Boolean)
    .map(item => {
      if (typeof item === 'string') return { source: item, width: 0, height: 0 }
      if (typeof item !== 'object') return null
      return {
        source: item.source || item.url || '',
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
      }
    })
    .filter(item => item?.source)

  return candidates.sort((a, b) => area(b) - area(a))[0]?.source || ''
}

function normalizeEpisode(p) {
  const meta    = p.episode_metadata || {}
  const airRaw  = p.episode_air_date || p.premium_available_date || p.availability_starts || ''
  const airTime = airRaw ? (new Date(airRaw).getTime() || 0) : 0
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
    epNum,
    link: `${CR_BASE}/watch/${epId}${slug ? `/${slug}` : ''}`,
    audioLocale: locale,
    image: extractImage(p.images),
    airTime,
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
const ALLOWED_LOCALES = new Set(['ja-JP', 'es-419', 'es-LA', 'es-ES'])

function formatCaption(ep) {
  const audioFlag  = FLAG[ep.audioLocale] || '🌐'
  const localeName = LOCALE_NAME[ep.audioLocale] || ep.audioLocale
  const hasNum     = ep.epNum !== null && ep.epNum !== ''
  const epLabel    = hasNum ? `Ep. ${ep.epNum}` : 'Especial'
  const epLine     = ep.epTitle ? `${epLabel} - ${ep.epTitle}` : epLabel
  return (
    `📺 ${ep.series}\n` +
    `🎬 ${epLine}\n` +
    `${audioFlag} ${localeName}\n\n` +
    `${ep.link}`
  )
}

// ─── Fetch episodios ──────────────────────────────────────────────────────────
// Una sola consulta compartida: episodios únicos, en idiomas permitidos (más nuevos primero).
async function fetchBrowse() {
  const data = await crFetch('/content/v1/browse', { count: '100', sort_by: 'newly_added', type: 'episode', locale: 'es-419' }, CR_BETA)
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []
  const byId = new Map()
  for (const row of rows) {
    const ep = normalizeEpisode(row)
    if (ep.id && ep.series && ALLOWED_LOCALES.has(ep.audioLocale) && !byId.has(ep.id)) byId.set(ep.id, ep)
  }
  return [...byId.values()]
}

async function fetchNewEpisodes() {
  const valid = await fetchBrowse()
  if (!valid.length) return []

  const seen = getSeen()

  // Primera ejecución: caché vacío → solo sembramos los IDs sin enviar nada
  if (seen.size === 0) {
    markSeen(valid.map(i => i.id))
    console.log(`[CR-Notify] Caché sembrado con ${valid.length} IDs.`)
    return []
  }

  // Se envían de más antiguo a más nuevo, para que el chat quede en orden cronológico
  return valid
    .filter(i => !seen.has(i.id))
    .reverse()
    .sort((a, b) => a.airTime - b.airTime)
}

async function getLatestEpisodes(limit = 10) {
  return (await fetchBrowse()).slice(0, limit)
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

// ─── Cron ─────────────────────────────────────────────────────────────────────
// El estado del timer se guarda también en `global` porque, si el bot recarga
// plugins en caliente, el módulo se re-importa y el timer viejo seguiría vivo
// (notificaciones duplicadas). Cada arranque invalida al anterior vía generación.
let cronTimer   = null
let storedConn  = null
let cronRunning = false
const failCount = new Map()

function stopCron() {
  if (cronTimer) clearTimeout(cronTimer)
  if (global.__crNotifyTimer) clearTimeout(global.__crNotifyTimer)
  cronTimer = global.__crNotifyTimer = null
  global.__crNotifyGen = (global.__crNotifyGen || 0) + 1
}

// Devuelve la conexión activa: primero la guardada, si no global.conn del bot
function getConn() { return storedConn || global.conn || null }

async function runCycle() {
  if (cronRunning) return
  const conn = getConn()
  if (!conn) return                          // Bot aún no conectado, siguiente tick
  const jids = loadCfg().targetJids
  if (!jids.length) return                   // Sin grupos configurados aún

  cronRunning = true
  try {
    const items = await fetchNewEpisodes()
    if (!items.length) return

    let enviados = 0
    for (const ep of items) {
      let algunExito = false
      for (const jid of jids) {
        try {
          await sendItem(conn, jid, ep)
          algunExito = true
          await delay(1500)
        } catch (err) {
          console.error(`[CR-Notify] Error enviando a ${jid}:`, err.message)
        }
      }

      if (algunExito) {
        // Solo se marca como visto si llegó al menos a un grupo
        markSeen(ep.id); failCount.delete(ep.id); enviados++
      } else {
        // Falló en todos: reintentar en el próximo tick, pero sin insistir eternamente
        const n = (failCount.get(ep.id) || 0) + 1
        failCount.set(ep.id, n)
        if (n >= MAX_RETRIES) {
          console.warn(`[CR-Notify] Descartado tras ${n} intentos: ${ep.series} Ep. ${ep.epNum}`)
          markSeen(ep.id); failCount.delete(ep.id)
        } else {
          break // probablemente conexión caída; no seguir golpeando
        }
      }
      await delay(3000)
    }
    if (enviados) console.log(`[CR-Notify] ${enviados} ep(s) → ${jids.length} grupo(s)`)
  } finally { cronRunning = false }
}

function startCron(conn) {
  if (conn) storedConn = conn
  stopCron()

  const minutes = getMinutes()
  const gen     = global.__crNotifyGen

  const tick = async () => {
    if (gen !== global.__crNotifyGen) return
    try { await runCycle() } catch (err) { console.error('[CR-Notify] Cron:', err.message) }
    if (gen === global.__crNotifyGen) cronTimer = global.__crNotifyTimer = setTimeout(tick, minutes * 60_000)
  }

  // Primer chequeo a los pocos segundos; luego cada `minutes` (sin solapar ciclos)
  cronTimer = global.__crNotifyTimer = setTimeout(tick, 5_000)
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${loadCfg().targetJids.length} grupo(s) configurado(s)`)
}

// ─── Handler ──────────────────────────────────────────────────────────────────
let handler = async (m, { conn, command, args, isOwner }) => {
  // Guardar conexión en cada llamada para que el cron la use
  if (conn) storedConn = conn
  if (!cronTimer) startCron(conn)

  command = String(command || '').toLowerCase()
  const reply = text => conn.sendMessage(m.chat, { text }, { quoted: m })

  if (OWNER_ONLY.has(command) && !isOwner) return reply('⛔ Solo el dueño.')

  // ── .crlogin ──────────────────────────────────────────────────────────────
  if (command === 'crlogin') {
    // La contraseña viaja en un mensaje: se exige chat privado y se intenta borrarlo siempre.
    const deleteMsg = () => conn.sendMessage(m.chat, { delete: m.key }).catch(() => {})
    if (m.chat?.endsWith('@g.us')) {
      await deleteMsg()
      return reply('🔒 Usa *.crlogin* solo en chat privado con el bot.')
    }
    const [email, ...rest] = args
    const pass = rest.join(' ')
    if (!email || !pass) return reply('💡 Uso: *.crlogin email contraseña*')
    await reply('🔐 Conectando con Crunchyroll...')
    try {
      await loginWithAccount(email, pass)
      await deleteMsg()
      const cfg = loadCfg()
      return reply(`✅ *Login exitoso*\n👤 Cuenta real activa\n🎯 Grupos: ${cfg.targetJids.length}\n🔄 Monitor cada ${getMinutes()} min\n🔁 Refresh automático habilitado`)
    } catch (e) {
      await deleteMsg()
      return reply(`❌ *Auth fallida*\n${e.message}`)
    }
  }

  // ── .crlogout ─────────────────────────────────────────────────────────────
  if (command === 'crlogout') {
    // Borra solo credenciales, conserva la lista de grupos
    const cfg = clearSession()
    return reply(`🔒 Sesión cerrada. Grupos conservados (${cfg.targetJids.length}).\nEl cron continúa en modo anónimo.`)
  }

  // ── .crset — Añade este chat a la lista de grupos ─────────────────────────
  if (command === 'crset') {
    const cfg = loadCfg()
    if (cfg.targetJids.includes(m.chat)) {
      return reply(`ℹ️ Este chat ya está en la lista.\n📋 Grupos: *${cfg.targetJids.length}*`)
    }
    cfg.targetJids.push(m.chat)
    saveCfg(cfg)
    return reply(`✅ *Grupo añadido al notificador*\n\`${m.chat}\`\n\n📋 Total grupos: *${cfg.targetJids.length}*`)
  }

  // ── .crrem — Elimina este chat de la lista de grupos ──────────────────────
  if (command === 'crrem') {
    const cfg    = loadCfg()
    const before = cfg.targetJids.length
    cfg.targetJids = cfg.targetJids.filter(j => j !== m.chat)
    if (before === cfg.targetJids.length) return reply('⚠️ Este chat no estaba en la lista.')
    saveCfg(cfg)
    return reply(`🗑️ *Grupo eliminado del notificador*\n\`${m.chat}\`\n📋 Quedan: *${cfg.targetJids.length}*`)
  }

  // ── .crstatus ─────────────────────────────────────────────────────────────
  if (command === 'crstatus') {
    const cfg = loadCfg()
    const exp = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
    const gruposList = cfg.targetJids.length
      ? cfg.targetJids.map((j, i) => `  ${i + 1}. \`${j}\``).join('\n')
      : '  _Ninguno — usa .crset_'
    return reply(
      `📊 *CR-Notify Status*\n\n` +
      `🔑 Modo: *${cfg.loggedIn ? '👤 Cuenta real ✅' : '👻 Anónimo'}*\n` +
      `⏳ Token expira: *${exp}*\n` +
      `🔁 Refresh token: *${cfg.refreshToken ? 'Sí ✅' : 'No ❌'}*\n` +
      `⏱ Cron: cada *${getMinutes()} min*\n` +
      `🔄 Cron activo: *${cronTimer ? 'Sí ✅' : 'No ❌'}*\n` +
      `💾 IDs caché: *${getSeen().size}*\n\n` +
      `🎯 *Grupos configurados (${cfg.targetJids.length}):*\n${gruposList}`
    )
  }

  // ── .crlist / .crnotify [n] — Últimos lanzamientos a este chat ────────────
  if (command === 'crlist' || command === 'crnotify') {
    const n = Math.min(10, Math.max(1, parseInt(args[0], 10) || 10))
    await reply(`🔍 Obteniendo los ${n} lanzamientos más recientes...`)
    try {
      const episodes = await getLatestEpisodes(n)
      if (!episodes.length) return reply('📭 No se encontraron episodios recientes.')
      for (const ep of episodes) { await sendItem(conn, m.chat, ep, m); await delay(2000) }
    } catch (err) { await reply(`❌ Error: ${err.message}`) }
  }
}

handler.help    = ['crlogin <email> <pass>', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist [n]', 'crnotify [n]']
handler.tags    = ['anime']
handler.command = /^(crlogin|crlogout|crset|crrem|crstatus|crlist|crnotify)$/i

// ─── Auto-arranque al cargar el plugin ───────────────────────────────────────
// Se ejecuta al importar el archivo. El cron arranca aunque global.conn aún no
// esté listo — cada tick lo reintenta.
{
  const cfg = loadCfg()
  // Restaurar token de sesión si existe
  if (cfg.loggedIn && cfg.accessToken) {
    _token    = cfg.accessToken
    _tokenExp = cfg.tokenExp || 0
  }
  startCron(null)
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${cfg.targetJids.length} | Modo: ${cfg.loggedIn ? 'Cuenta' : 'Anónimo'}`)
}

export default handler
