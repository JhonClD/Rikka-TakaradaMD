```js
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp')
const DB_PATH   = join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH  = join(TMP_DIR, 'crunchyroll-cfg.json')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

const CR_BASE    = 'https://www.crunchyroll.com'
const CR_BETA    = 'https://beta-api.crunchyroll.com'
const CR_AUTH    = `${CR_BASE}/auth/v1/token`
const BASIC_ANON = 'Basic dC1rZGdwMmg4YzNqdWI4Zm4wZnE6eWZMRGZNZnJZdktYaDRKWFMxTEVJMmNDcXUxdjVXYW4='
const BASIC_AUTH = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZWdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA      = 'Crunchyroll/ANDROIDTV/3.59.0_22338 (Android 13.0; en-US; TCL-S5400AF Build/TP1A.220624.014)'
const DEVICE_ID  = '00000000-dead-beef-cafe-000000000000'
const DEVICE_TYPE= 'ANDROIDTV'
const MAX_SEEN   = 500
const SEND_GAP   = 1500
const EP_GAP     = 3000

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, path)
}
const delay = ms => new Promise(r => setTimeout(r, ms))

function loadCfg() {
  try {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    if (cfg.targetJid && !cfg.targetJids) {
      cfg.targetJids = [cfg.targetJid]
      delete cfg.targetJid
      writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf-8')
    }
    if (!Array.isArray(cfg.targetJids)) cfg.targetJids = cfg.targetJids ? [cfg.targetJids] : []
    cfg.targetJids = [...new Set(cfg.targetJids.filter(j => typeof j === 'string' && j.trim()))]
    if (typeof cfg.minutes !== 'number' || cfg.minutes < 1) cfg.minutes = 1
    return cfg
  } catch { return { targetJids: [], minutes: 1 } }
}
function saveCfg(d) { writeJsonAtomic(CFG_PATH, d) }

function loadSeen() {
  try {
    const ids = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [])
  } catch { return new Set() }
}
function saveSeen(set) { writeJsonAtomic(DB_PATH, [...set].slice(-MAX_SEEN)) }

let _cookies = ''
async function preLogin() {
  try {
    const res = await fetch(CR_BASE, { headers: { 'User-Agent': CR_UA }, signal: AbortSignal.timeout(15_000) })
    const raw = res.headers.getSetCookie?.() || []
    _cookies  = raw.map(c => c.split(';')[0]).join('; ')
  } catch { }
}

let _token = null, _tokenExp = 0, _tokenLock = null

async function _refreshInner() {
  const cfg = loadCfg()
  if (!cfg.refreshToken) throw new Error('Sin refresh_token — usa .crlogin de nuevo')
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'Cookie': _cookies },
    body: body.toString(), signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      const c = loadCfg()
      delete c.accessToken; delete c.refreshToken; delete c.tokenExp
      delete c.accountId; delete c.loggedIn
      saveCfg(c)
      _token = null; _tokenExp = 0
    }
    throw new Error(`Refresh HTTP ${res.status}`)
  }
  const data = await res.json()
  cfg.accessToken  = data.access_token
  cfg.refreshToken = data.refresh_token || cfg.refreshToken
  cfg.tokenExp     = Date.now() + (data.expires_in || 300) * 1000
  saveCfg(cfg); _token = data.access_token; _tokenExp = cfg.tokenExp
  console.log('[CR-Notify] Token renovado.')
  return _token
}

async function refreshAccountToken() {
  if (_tokenLock) return _tokenLock
  _tokenLock = _refreshInner().finally(() => { _tokenLock = null })
  return _tokenLock
}

async function getAnonToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token
  if (_tokenLock) return _tokenLock
  _tokenLock = (async () => {
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
  })().finally(() => { _tokenLock = null })
  return _tokenLock
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

async function getToken() {
  const cfg = loadCfg()
  if (cfg.loggedIn) {
    if (_token && Date.now() < _tokenExp - 30_000) return _token
    if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - 30_000) { _token = cfg.accessToken; _tokenExp = cfg.tokenExp; return _token }
    return refreshAccountToken()
  }
  return getAnonToken()
}

async function crFetch(path, params = {}, base = CR_BASE) {
  const url = new URL(`${base}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken()
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': CR_UA, 'Accept': 'application/json', 'Cookie': _cookies },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return res.json()
    if (res.status === 401 && attempt === 0) { _token = null; _tokenExp = 0; continue }
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`CR API HTTP ${res.status} → ${path}${detail ? `: ${detail}` : ''}`)
  }
  throw new Error(`CR API no pudo renovar el token → ${path}`)
}

function extractImage(images = {}) {
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

  return candidates
    .map(c => {
      const area = (c.width * c.height) || c.width || 1
      const wide = c.width >= c.height ? 1.5 : 1
      return { ...c, score: area * wide }
    })
    .sort((a, b) => b.score - a.score)[0]?.source || ''
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
    airTime,
  }
}

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

async function fetchLatestRaw() {
  const data = await crFetch('/content/v1/browse', { count: '100', sort_by: 'newly_added', type: 'episode', locale: 'es-419' }, CR_BETA)
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []
  return [...new Map(rows.map(normalizeEpisode)
    .filter(i => i.id && i.series && ALLOWED_LOCALES.has(i.audioLocale))
    .map(i => [i.id, i])).values()]
}

async function fetchNewEpisodes() {
  const valid = await fetchLatestRaw()
  if (!valid.length) return []

  const seen = loadSeen()
  if (seen.size === 0) {
    const s = new Set(valid.map(i => i.id))
    saveSeen(s)
    console.log(`[CR-Notify] Caché sembrado con ${s.size} IDs.`)
    return []
  }
  return valid.filter(i => !seen.has(i.id))
}

function markSeen(ids) {
  const seen = loadSeen()
  const list = Array.isArray(ids) ? ids : [ids]
  let changed = false
  for (const id of list) if (id && !seen.has(id)) { seen.add(id); changed = true }
  if (changed) saveSeen(seen)
}

async function getLatestEpisodes(limit = 10) {
  return (await fetchLatestRaw()).slice(0, limit)
}

async function sendItem(conn, jid, ep, quoted = null) {
  const caption = formatCaption(ep)
  const opts    = quoted ? { quoted } : {}
  if (ep.image) {
    try { await conn.sendMessage(jid, { image: { url: ep.image }, caption }, opts); return }
    catch (e) { console.warn(`[CR-Notify] Imagen falló (${jid}): ${e.message}`) }
  }
  await conn.sendMessage(jid, { text: caption }, opts)
}

let cronTimer  = null
let cronGen    = 0
let cronPaused = false
let cronRunning = false
let storedConn = null
let lastCheck  = 0
let lastError  = null
let consecutiveErrors = 0

function getConn() { return storedConn || global.conn || null }

function currentMinutes() {
  const cfg = loadCfg()
  const n = Number(process.env.CR_MINUTES ?? cfg.minutes ?? 1)
  return Number.isFinite(n) ? Math.max(1, n) : 1
}

function stopCron() {
  if (cronTimer) { clearTimeout(cronTimer); cronTimer = null }
  cronGen++
}

function scheduleCron(conn, initialDelay = 5_000) {
  if (conn) storedConn = conn
  stopCron()
  if (cronPaused) { console.log('[CR-Notify] Cron en pausa.'); return }

  const gen = cronGen
  const minutes = currentMinutes()
  const jidsCount = loadCfg().targetJids.length
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${jidsCount} grupo(s)`)

  const tick = async () => {
    if (gen !== cronGen) return
    cronTimer = null

    if (!cronRunning) {
      cronRunning = true
      try {
        const activeConn = getConn()
        const jids = loadCfg().targetJids || []
        if (activeConn && jids.length) {
          const items = await fetchNewEpisodes()
          lastCheck = Date.now()
          consecutiveErrors = 0
          lastError = null
          if (items.length) {
            const sentIds = []
            for (const ep of items) {
              if (gen !== cronGen) break
              let ok = false
              for (const jid of jids) {
                try { await sendItem(activeConn, jid, ep); ok = true; await delay(SEND_GAP) }
                catch (e) { console.error(`[CR-Notify] Envío a ${jid}:`, e.message) }
              }
              if (ok) sentIds.push(ep.id)
              await delay(EP_GAP)
            }
            if (sentIds.length) markSeen(sentIds)
            console.log(`[CR-Notify] ${sentIds.length}/${items.length} ep(s) → ${jids.length} grupo(s)`)
          }
        }
      } catch (err) {
        consecutiveErrors++
        lastError = err.message
        if (consecutiveErrors === 1 || consecutiveErrors % 5 === 0) {
          console.error(`[CR-Notify] Cron (fallo #${consecutiveErrors}):`, err.message)
        }
      } finally {
        cronRunning = false
      }
    }

    if (gen === cronGen && !cronPaused) {
      cronTimer = setTimeout(tick, currentMinutes() * 60_000)
    }
  }

  cronTimer = setTimeout(tick, initialDelay)
}

let handler = async (m, { conn, command, args, isOwner }) => {
  if (conn) storedConn = conn
  if (!cronTimer && !cronPaused && !cronRunning) scheduleCron(conn)

  const reply = txt => conn.sendMessage(m.chat, { text: txt }, { quoted: m })

  if (command === 'crlogin') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const [email, pass] = args
    if (!email || !pass) return reply('💡 Uso: *.crlogin email contraseña*')
    await reply('🔐 Conectando con Crunchyroll...')
    try {
      await loginWithAccount(email, pass)
      scheduleCron(conn, 2_000)
      const cfg = loadCfg()
      return reply(`✅ *Login exitoso*\n👤 Cuenta real activa\n🎯 Grupos: ${cfg.targetJids.length}\n🔄 Monitor cada ${currentMinutes()} min\n🔁 Refresh automático habilitado`)
    } catch (e) { return reply(`❌ *Auth fallida*\n${e.message}`) }
  }

  if (command === 'crlogout') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const cfg = loadCfg()
    delete cfg.accessToken; delete cfg.refreshToken; delete cfg.tokenExp
    delete cfg.accountId; delete cfg.loggedIn
    saveCfg(cfg)
    _token = null; _tokenExp = 0
    return reply(`🔒 Sesión cerrada. Grupos conservados (${cfg.targetJids.length}).\nEl cron continúa en modo anónimo.`)
  }

  if (command === 'crset') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const cfg = loadCfg()
    if (cfg.targetJids.includes(m.chat)) return reply(`ℹ️ Este chat ya está en la lista.\n📋 Grupos: *${cfg.targetJids.length}*`)
    cfg.targetJids.push(m.chat)
    saveCfg(cfg)
    return reply(`✅ *Grupo añadido al notificador*\n\`${m.chat}\`\n\n📋 Total grupos: *${cfg.targetJids.length}*`)
  }

  if (command === 'crrem') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const cfg = loadCfg()
    const before = cfg.targetJids.length
    cfg.targetJids = cfg.targetJids.filter(j => j !== m.chat)
    saveCfg(cfg)
    return reply(before !== cfg.targetJids.length
      ? `🗑️ *Grupo eliminado del notificador*\n\`${m.chat}\`\n📋 Quedan: *${cfg.targetJids.length}*`
      : `⚠️ Este chat no estaba en la lista.`)
  }

  if (command === 'crmins') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const n = parseInt(args[0], 10)
    if (!Number.isFinite(n) || n < 1) return reply('💡 Uso: *.crmins <minutos>* (≥ 1)')
    const cfg = loadCfg()
    cfg.minutes = n
    saveCfg(cfg)
    if (!cronPaused) scheduleCron(conn, 2_000)
    return reply(`⏱ Intervalo actualizado a *${n} min*.`)
  }

  if (command === 'crpause') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    cronPaused = true
    stopCron()
    return reply('⏸️ Cron pausado. Usa *.crresume* para reanudar.')
  }
  if (command === 'crresume') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    cronPaused = false
    scheduleCron(conn, 2_000)
    return reply(`▶️ Cron reanudado (cada ${currentMinutes()} min).`)
  }

  if (command === 'crstatus') {
    const cfg  = loadCfg()
    const mins = currentMinutes()
    const seen = loadSeen()
    const estadoCron = cronPaused ? '⏸️ Pausado' : cronTimer ? '✅ Activo' : '❌ Detenido'

    if (!isOwner) {
      return reply(
        `📊 *CR-Notify*\n\n` +
        `🔑 Modo: *${cfg.loggedIn ? 'Cuenta real' : 'Anónimo'}*\n` +
        `⏱ Cron: cada *${mins} min* — ${estadoCron}\n` +
        `🎯 Grupos: *${cfg.targetJids.length}*`
      )
    }

    const exp     = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
    const fmtLast = lastCheck   ? new Date(lastCheck  ).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
    const gruposList = cfg.targetJids.length
      ? cfg.targetJids.map((j, i) => `  ${i + 1}. \`${j}\``).join('\n')
      : '  _Ninguno — usa .crset_'
    const errLine = lastError ? `\n⚠️ Último error: ${lastError.slice(0, 100)}` : ''

    return reply(
      `📊 *CR-Notify Status*\n\n` +
      `🔑 Modo: *${cfg.loggedIn ? '👤 Cuenta real ✅' : '👻 Anónimo'}*\n` +
      `⏳ Token expira: *${exp}*\n` +
      `🔁 Refresh token: *${cfg.refreshToken ? 'Sí ✅' : 'No ❌'}*\n` +
      `⏱ Cron: cada *${mins} min* — ${estadoCron}\n` +
      `🕒 Última consulta: *${fmtLast}*\n` +
      `💾 IDs en caché: *${seen.size}*\n\n` +
      `🎯 *Grupos (${cfg.targetJids.length}):*\n${gruposList}${errLine}`
    )
  }

  if (command === 'crlist') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    const limit = Math.min(20, Math.max(1, parseInt(args[0], 10) || 10))
    await reply(`🔍 Obteniendo los ${limit} lanzamientos más recientes...`)
    try {
      const episodes = await getLatestEpisodes(limit)
      if (!episodes.length) return reply('📭 No se encontraron episodios recientes.')
      for (const ep of episodes) { await sendItem(conn, m.chat, ep, m); await delay(2_000) }
    } catch (err) { await reply(`❌ Error: ${err.message}`) }
    return
  }

  if (command === 'crnotify') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    await reply('🔍 Buscando episodios recientes...')
    try {
      const episodes = await getLatestEpisodes(10)
      if (!episodes.length) return reply('📭 No se encontraron episodios.')
      for (const ep of episodes) { await sendItem(conn, m.chat, ep, m); await delay(2_000) }
    } catch (err) { await reply(`❌ Error: ${err.message}`) }
    return
  }

  if (command === 'crtest') {
    if (!isOwner) return reply('⛔ Solo el dueño.')
    if (cronRunning) return reply('⏳ Hay un chequeo en curso, espera un momento.')
    await reply('🔎 Ejecutando chequeo manual...')
    cronRunning = true
    try {
      const items = await fetchNewEpisodes()
      const jids  = loadCfg().targetJids
      if (!jids.length) return reply('⚠️ No hay grupos configurados. Usa *.crset*.')
      if (!items.length) return reply('📭 Sin novedades desde el último chequeo.')
      const sentIds = []
      for (const ep of items) {
        let ok = false
        for (const jid of jids) {
          try { await sendItem(conn, jid, ep); ok = true; await delay(SEND_GAP) }
          catch (e) { console.error(e.message) }
        }
        if (ok) sentIds.push(ep.id)
        await delay(EP_GAP)
      }
      if (sentIds.length) markSeen(sentIds)
      lastCheck = Date.now()
      return reply(`✅ ${sentIds.length}/${items.length} ep(s) enviados a ${jids.length} grupo(s).`)
    } catch (err) { return reply(`❌ Error: ${err.message}`) }
    finally { cronRunning = false }
  }

  if (command === 'crhelp') {
    return reply(
      `📖 *CR-Notify — Comandos*\n\n` +
      `*Configuración:*\n` +
      `• .crset — añade este chat al notificador\n` +
      `• .crrem — elimina este chat\n` +
      `• .crmins <n> — cada cuántos minutos revisar\n` +
      `• .crpause / .crresume — controlar el cron\n\n` +
      `*Cuenta:*\n` +
      `• .crlogin email pass — cuenta real\n` +
      `• .crlogout — volver a anónimo\n\n` +
      `*Utilidades:*\n` +
      `• .crstatus — estado general\n` +
      `• .crlist [n] — últimos lanzamientos\n` +
      `• .crnotify — envío manual de los últimos 10\n` +
      `• .crtest — fuerza un tick del cron\n`
    )
  }
}

handler.help    = ['crlogin <email> <pass>', 'crlogout', 'crset', 'crrem', 'crmins <n>', 'crpause', 'crresume', 'crstatus', 'crlist [n]', 'crnotify', 'crtest', 'crhelp']
handler.tags    = ['anime']
handler.command = /^(crlogin|crlogout|crset|crrem|crmins|crpause|crresume|crstatus|crlist|crnotify|crtest|crhelp)$/i

;(async () => {
  const cfg = loadCfg()
  if (cfg.loggedIn && cfg.accessToken) {
    _token    = cfg.accessToken
    _tokenExp = cfg.tokenExp || 0
  }
  scheduleCron(null)
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${cfg.targetJids.length} | Modo: ${cfg.loggedIn ? 'Cuenta' : 'Anónimo'} | Cada ${currentMinutes()} min`)
})()

export default handler
```