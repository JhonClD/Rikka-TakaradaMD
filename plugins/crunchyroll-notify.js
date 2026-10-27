import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp')
const DB_PATH   = join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH  = join(TMP_DIR, 'crunchyroll-cfg.json')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

const CR_BASE     = 'https://www.crunchyroll.com'
const CR_BETA     = 'https://beta-api.crunchyroll.com'
const CR_AUTH     = `${CR_BASE}/auth/v1/token`
const BASIC_ANON  = 'Basic dC1rZGdwMmg4YzNqdWI4Zm4wZnE6eWZMRGZNZnJZdktYaDRKWFMxTEVJMmNDcXUxdjVXYW4='
const BASIC_AUTH  = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZMdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA       = 'Crunchyroll/ANDROIDTV/3.59.0_22338 (Android 13.0; en-US; TCL-S5400AF Build/TP1A.220624.014)'
const DEVICE_ID   = '00000000-dead-beef-cafe-000000000000'
const DEVICE_TYPE = 'ANDROIDTV'
const MAX_SEEN    = 500

let _cfgCache  = null
let _seenCache = null

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, path)
}

function loadCfg() {
  if (_cfgCache) return _cfgCache
  try {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    if (cfg.targetJid && !cfg.targetJids) {
      cfg.targetJids = [cfg.targetJid]
      delete cfg.targetJid
    }
    if (!Array.isArray(cfg.targetJids)) cfg.targetJids = cfg.targetJids ? [cfg.targetJids] : []
    cfg.targetJids = [...new Set(cfg.targetJids.filter(j => typeof j === 'string' && j.trim()))]
    _cfgCache = cfg
    return _cfgCache
  } catch {
    _cfgCache = { targetJids: [] }
    return _cfgCache
  }
}

function saveCfg(d) {
  _cfgCache = d
  writeJsonAtomic(CFG_PATH, d)
}

function getSeenSet() {
  if (_seenCache) return _seenCache
  try {
    const ids = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
    const valid = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []
    _seenCache = new Set(valid.slice(-MAX_SEEN))
  } catch {
    _seenCache = new Set()
  }
  return _seenCache
}

function saveSeenSet() {
  if (!_seenCache) return
  const arr = [..._seenCache].slice(-MAX_SEEN)
  _seenCache = new Set(arr)
  writeJsonAtomic(DB_PATH, arr)
}

function markSeenBatch(ids) {
  const seen = getSeenSet()
  let changed = false
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id)
      changed = true
    }
  }
  if (changed) saveSeenSet()
}

let _cookies = ''
async function preLogin() {
  try {
    const res = await fetch(CR_BASE, { headers: { 'User-Agent': CR_UA }, signal: AbortSignal.timeout(15_000) })
    const raw = res.headers.getSetCookie?.() || []
    _cookies  = raw.map(c => c.split(';')[0]).join('; ')
  } catch {}
}

let _token = null, _tokenExp = 0

async function getAnonToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({
    grant_type: 'client_id',
    scope: 'offline_access',
    device_id: DEVICE_ID,
    device_type: DEVICE_TYPE
  })
  const res = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      'Authorization': BASIC_ANON,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CR_UA,
      'ETP-Anonymous-ID': DEVICE_ID,
      'Cookie': _cookies
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Auth anónima HTTP ${res.status}: ${t.slice(0, 80)}`)
  }
  const data = await res.json()
  _token    = data.access_token
  _tokenExp = Date.now() + (data.expires_in || 300) * 1000
  return _token
}

async function loginWithAccount(email, password) {
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({
    grant_type: 'password',
    username: email,
    password,
    scope: 'offline_access',
    device_id: DEVICE_ID,
    device_type: DEVICE_TYPE
  })
  const res = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      'Authorization': BASIC_AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CR_UA,
      'ETP-Anonymous-ID': DEVICE_ID,
      'Cookie': _cookies
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error_description || e.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  const cfg  = loadCfg()
  Object.assign(cfg, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExp: Date.now() + (data.expires_in || 300) * 1000,
    accountId: data.account_id || null,
    loggedIn: true
  })
  saveCfg(cfg)
  _token    = data.access_token
  _tokenExp = cfg.tokenExp
  return data
}

async function refreshAccountToken() {
  const cfg = loadCfg()
  if (!cfg.refreshToken) throw new Error('Sin refresh_token')
  if (!_cookies) await preLogin()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
    scope: 'offline_access',
    device_id: DEVICE_ID,
    device_type: DEVICE_TYPE
  })
  const res = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      'Authorization': BASIC_AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CR_UA,
      'Cookie': _cookies
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Refresh HTTP ${res.status}`)
  const data = await res.json()
  cfg.accessToken  = data.access_token
  cfg.refreshToken = data.refresh_token || cfg.refreshToken
  cfg.tokenExp     = Date.now() + (data.expires_in || 300) * 1000
  saveCfg(cfg)
  _token    = data.access_token
  _tokenExp = cfg.tokenExp
  console.log('[CR-Notify] Token de cuenta renovado.')
  return _token
}

async function getToken() {
  const cfg = loadCfg()
  if (cfg.loggedIn) {
    if (_token && Date.now() < _tokenExp - 30_000) return _token
    if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - 30_000) {
      _token    = cfg.accessToken
      _tokenExp = cfg.tokenExp
      return _token
    }
    try {
      return await refreshAccountToken()
    } catch (err) {
      console.warn(`[CR-Notify] Falló refresh de cuenta (${err.message}). Usando fallback anónimo.`)
      cfg.loggedIn = false
      delete cfg.accessToken
      delete cfg.tokenExp
      saveCfg(cfg)
      _token = null
      _tokenExp = 0
    }
  }
  return getAnonToken()
}

async function crFetch(path, params = {}, base = CR_BASE) {
  const url = new URL(`${base}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken()
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': CR_UA,
        'Accept': 'application/json',
        'Cookie': _cookies
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return res.json()
    if (res.status === 401 && attempt === 0) {
      _token    = null
      _tokenExp = 0
      const cfg = loadCfg()
      cfg.tokenExp = 0
      continue
    }
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`CR API HTTP ${res.status} → ${path}${detail ? `: ${detail}` : ''}`)
  }
  throw new Error(`CR API no pudo renovar el token → ${path}`)
}

function extractImage(images = {}) {
  const priorityKeys = ['thumbnail', 'poster_wide', 'poster_tall']
  for (const key of priorityKeys) {
    if (!images[key]) continue
    const best = [images[key]]
      .flat(Infinity)
      .filter(item => item && typeof item === 'object' && (item.source || item.url))
      .map(item => ({
        source: item.source || item.url,
        area: (Number(item.width) || 0) * (Number(item.height) || 0),
        width: Number(item.width) || 0
      }))
      .sort((a, b) => (b.area || b.width) - (a.area || a.width))[0]
    if (best?.source) return best.source
  }
  return ''
}

function normalizeEpisode(p) {
  const meta    = p.episode_metadata || {}
  const airRaw  = p.episode_air_date || p.premium_available_date || p.availability_starts || ''
  const airTime = airRaw ? new Date(airRaw).getTime() : 0
  const epNum   = p.episode_number ?? meta.episode_number ?? meta.episode ?? null
  const epId    = p.id || ''
  const slug    = p.slug_title || meta.slug_title || ''

  let locale = p.audio_locale || meta.audio_locale || ''
  if (!locale && Array.isArray(meta.versions)) {
    const matchVer = meta.versions.find(v => v.guid === epId || v.original)
    if (matchVer?.audio_locale) locale = matchVer.audio_locale
  }
  if (!locale && epId) {
    if (epId.endsWith('JAJP')) locale = 'ja-JP'
    else if (epId.endsWith('ES419') || epId.endsWith('LA')) locale = 'es-419'
    else if (epId.endsWith('ESES')) locale = 'es-ES'
  }

  let seriesName    = (p.series_title || meta.series_title || '').trim()
  const seasonTitle = (p.season_title || meta.season_title || '').trim()

  if (
    seasonTitle &&
    seriesName &&
    seasonTitle.toLowerCase() !== seriesName.toLowerCase() &&
    !seriesName.toLowerCase().includes(seasonTitle.toLowerCase()) &&
    !seriesName.includes('Season')
  ) {
    seriesName += ` - ${seasonTitle}`
  }
  if (!seriesName) seriesName = p.title || 'Anime Desconocido'

  return {
    id: epId,
    series: seriesName.trim(),
    epTitle: (p.title || '').trim(),
    epNum: epNum !== null && epNum !== '' ? epNum : 'Especial',
    link: `https://www.crunchyroll.com/watch/${epId}${slug ? `/${slug}` : ''}`,
    audioLocale: locale,
    image: extractImage(p.images),
    airTime
  }
}

const FLAG = {
  'ja-JP': '🇯🇵', 'en-US': '🇺🇸', 'es-419': '🇲🇽', 'es-LA': '🇲🇽', 'es-ES': '🇪🇸',
  'pt-BR': '🇧🇷', 'fr-FR': '🇫🇷', 'de-DE': '🇩🇪', 'it-IT': '🇮🇹', 'ru-RU': '🇷🇺', 'ar-SA': '🇸🇦',
}
const LOCALE_NAME = {
  'ja-JP': 'Japonés', 'en-US': 'Inglés', 'es-419': 'Latino', 'es-LA': 'Latino', 'es-ES': 'Castellano',
  'pt-BR': 'Portugués', 'fr-FR': 'Francés', 'de-DE': 'Alemán', 'it-IT': 'Italiano', 'ru-RU': 'Ruso', 'ar-SA': 'Árabe',
}
const ALLOWED_LOCALES = new Set(['ja-JP', 'es-419', 'es-LA', 'es-ES'])

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

async function fetchBrowseEpisodes() {
  const data = await crFetch('/content/v1/browse', {
    count: '100',
    sort_by: 'newly_added',
    type: 'episode',
    locale: 'es-419'
  }, CR_BETA)
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []
  return [...new Map(
    rows
      .map(normalizeEpisode)
      .filter(i => i.id && i.series && ALLOWED_LOCALES.has(i.audioLocale))
      .map(i => [i.id, i])
  ).values()]
}

async function fetchNewEpisodes() {
  const valid = await fetchBrowseEpisodes()
  if (!valid.length) return []

  const seen = getSeenSet()

  if (seen.size === 0) {
    markSeenBatch(valid.map(i => i.id))
    console.log(`[CR-Notify] Caché inicial sembrado con ${valid.length} IDs.`)
    return []
  }

  return valid.filter(i => !seen.has(i.id)).reverse()
}

async function getLatestEpisodes(limit = 10) {
  const valid = await fetchBrowseEpisodes()
  return valid.slice(0, limit)
}

async function sendItem(conn, jid, ep, quoted = null) {
  const caption = formatCaption(ep)
  const opts    = quoted ? { quoted } : {}
  if (ep.image) {
    try {
      await conn.sendMessage(jid, { image: { url: ep.image }, caption }, opts)
      return
    } catch {}
  }
  await conn.sendMessage(jid, { text: caption }, opts)
}

const delay = ms => new Promise(r => setTimeout(r, ms))

let storedConn  = null
let cronRunning = false

function stopCron() {
  if (global.__crNotifyTimer) {
    clearInterval(global.__crNotifyTimer)
    global.__crNotifyTimer = null
  }
}

function getConn() {
  return storedConn || global.conn || null
}

async function runCronTick() {
  if (cronRunning) return { status: 'busy', sent: 0 }
  const activeConn = getConn()
  if (!activeConn) return { status: 'no_conn', sent: 0 }

  const jids = loadCfg().targetJids || []
  if (!jids.length) return { status: 'no_groups', sent: 0 }

  cronRunning = true
  let totalSent = 0
  try {
    const items = await fetchNewEpisodes()
    if (!items.length) return { status: 'empty', sent: 0 }

    for (const ep of items) {
      let algunExito = false
      for (const jid of jids) {
        try {
          await sendItem(activeConn, jid, ep)
          algunExito = true
          await delay(1500)
        } catch (err) {
          console.error(`[CR-Notify] Error enviando a ${jid}:`, err.message)
        }
      }
      if (algunExito) {
        markSeenBatch([ep.id])
        totalSent++
      }
      await delay(2500)
    }
    if (totalSent > 0) {
      console.log(`[CR-Notify] ${totalSent} ep(s) notificado(s) → ${jids.length} grupo(s)`)
    }
    return { status: 'ok', sent: totalSent }
  } catch (err) {
    console.error('[CR-Notify] Error en Cron:', err.message)
    throw err
  } finally {
    cronRunning = false
  }
}

function startCron(conn) {
  if (conn) storedConn = conn
  stopCron()

  const cfg = loadCfg()
  const configuredMinutes = Number(process.env.CR_MINUTES ?? cfg.minutes ?? 1)
  const minutes = Number.isFinite(configuredMinutes) ? Math.max(1, configuredMinutes) : 1

  global.__crNotifyTimer = setInterval(() => {
    runCronTick().catch(() => {})
  }, minutes * 60_000)

  const jids = cfg.targetJids || []
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${jids.length} grupo(s) configurado(s)`)
}

let handler = async (m, { conn, command, args, isOwner }) => {
  if (conn) storedConn = conn
  if (!global.__crNotifyTimer) startCron(conn)

  if (command === 'crlogin') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const email = args[0]
    const pass  = args.slice(1).join(' ')
    if (!email || !pass) return conn.sendMessage(m.chat, { text: '💡 Uso: *.crlogin <email> <contraseña>*' }, { quoted: m })

    if (m.isGroup) conn.sendMessage(m.chat, { delete: m.key }).catch(() => {})

    await conn.sendMessage(m.chat, { text: '🔐 Conectando con Crunchyroll...' }, { quoted: m })
    try {
      await loginWithAccount(email, pass)
      startCron(conn)
      const cfg = loadCfg()
      return conn.sendMessage(m.chat, {
        text: `✅ *Login exitoso*\n👤 Cuenta real activa\n🎯 Grupos: ${cfg.targetJids.length}\n🔄 Monitor cada ${process.env.CR_MINUTES || cfg.minutes || 1} min\n🔁 Refresh automático habilitado`,
      }, { quoted: m })
    } catch (e) {
      return conn.sendMessage(m.chat, { text: `❌ *Auth fallida*\n${e.message}` }, { quoted: m })
    }
  }

  if (command === 'crlogout') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    delete cfg.accessToken
    delete cfg.refreshToken
    delete cfg.tokenExp
    delete cfg.accountId
    delete cfg.loggedIn
    saveCfg(cfg)
    _token    = null
    _tokenExp = 0
    return conn.sendMessage(m.chat, {
      text: `🔒 Sesión cerrada. Grupos conservados (${cfg.targetJids.length}).\nEl cron continúa en modo anónimo.`,
    }, { quoted: m })
  }

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

  if (command === 'crrem') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg    = loadCfg()
    const before = cfg.targetJids.length
    cfg.targetJids = cfg.targetJids.filter(j => j !== m.chat)
    saveCfg(cfg)
    return conn.sendMessage(m.chat, {
      text: before !== cfg.targetJids.length
        ? `🗑️ *Grupo eliminado del notificador*\n\`${m.chat}\`\n📋 Quedan: *${cfg.targetJids.length}*`
        : `⚠️ Este chat no estaba en la lista.`,
    }, { quoted: m })
  }

  if (command === 'crtime') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const mins = parseInt(args[0], 10)
    if (!mins || mins < 1 || mins > 120) {
      return conn.sendMessage(m.chat, { text: '💡 Uso: *.crtime <1-120>* (en minutos)' }, { quoted: m })
    }
    const cfg = loadCfg()
    cfg.minutes = mins
    saveCfg(cfg)
    startCron(conn)
    return conn.sendMessage(m.chat, { text: `⏱️ Intervalo actualizado a cada *${mins} min*.` }, { quoted: m })
  }

  if (command === 'crstatus') {
    const cfg  = loadCfg()
    const mins = process.env.CR_MINUTES || cfg.minutes || '1'
    const seen = getSeenSet()
    const exp  = cfg.tokenExp
      ? new Date(cfg.tokenExp).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })
      : (_tokenExp ? new Date(_tokenExp).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '—')
    const gruposList = cfg.targetJids.length
      ? cfg.targetJids.map((j, i) => `  ${i + 1}. \`${j}\``).join('\n')
      : '  _Ninguno — usa .crset_'
    return conn.sendMessage(m.chat, {
      text: `📊 *CR-Notify Status*\n\n` +
            `🔑 Modo: *${cfg.loggedIn ? '👤 Cuenta real ✅' : '👻 Anónimo'}*\n` +
            `⏳ Token expira: *${exp}*\n` +
            `🔁 Refresh token: *${cfg.refreshToken ? 'Sí ✅' : 'No ❌'}*\n` +
            `⏱ Cron: cada *${mins} min*\n` +
            `🔄 Cron activo: *${global.__crNotifyTimer ? 'Sí ✅' : 'No ❌'}*\n` +
            `💾 IDs en caché: *${seen.size}/${MAX_SEEN}*\n\n` +
            `🎯 *Grupos configurados (${cfg.targetJids.length}):*\n${gruposList}`,
    }, { quoted: m })
  }

  if (command === 'crlist') {
    await conn.sendMessage(m.chat, { text: '🔍 Consultando últimos lanzamientos...' }, { quoted: m })
    try {
      const limit = Math.min(Math.max(parseInt(args[0], 10) || 10, 1), 20)
      const episodes = await getLatestEpisodes(limit)
      if (!episodes.length) return conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios recientes.' }, { quoted: m })

      const listText = episodes.map((ep, idx) => {
        const flag = FLAG[ep.audioLocale] || '🌐'
        const lang = LOCALE_NAME[ep.audioLocale] || ep.audioLocale
        return `*${idx + 1}.* 📺 *${ep.series}*\n   🎬 Ep. ${ep.epNum}${ep.epTitle ? ` - ${ep.epTitle}` : ''} (${flag} ${lang})\n   🔗 ${ep.link}`
      }).join('\n\n')

      return conn.sendMessage(m.chat, {
        text: `🆕 *Últimos ${episodes.length} estrenos en Crunchyroll*\n\n${listText}`
      }, { quoted: m })
    } catch (err) {
      return conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m })
    }
  }

  if (command === 'crnotify') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })

    if (args[0] === 'sync' || args[0] === 'check') {
      await conn.sendMessage(m.chat, { text: '🔄 Ejecutando revisión manual de nuevos episodios...' }, { quoted: m })
      try {
        const res = await runCronTick()
        if (res.status === 'no_groups') return conn.sendMessage(m.chat, { text: '⚠️ No hay grupos configurados. Usa *.crset* primero.' }, { quoted: m })
        if (res.status === 'busy') return conn.sendMessage(m.chat, { text: '⏳ Ya hay una sincronización en curso.' }, { quoted: m })
        return conn.sendMessage(m.chat, {
          text: res.sent > 0
            ? `✅ Se enviaron *${res.sent}* nuevo(s) episodio(s) a los grupos.`
            : '📭 Todo al día. No hay episodios nuevos por notificar.'
        }, { quoted: m })
      } catch (err) {
        return conn.sendMessage(m.chat, { text: `❌ Error en sync: ${err.message}` }, { quoted: m })
      }
    }

    const count = Math.min(Math.max(parseInt(args[0], 10) || 3, 1), 10)
    await conn.sendMessage(m.chat, { text: `🔍 Enviando los últimos ${count} episodios...` }, { quoted: m })
    try {
      const episodes = await getLatestEpisodes(count)
      if (!episodes.length) return conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios.' }, { quoted: m })
      for (const ep of episodes) {
        await sendItem(conn, m.chat, ep, m)
        await delay(1500)
      }
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m })
    }
  }
}

handler.help    = ['crlogin <email> <pass>', 'crlogout', 'crset', 'crrem', 'crtime <min>', 'crstatus', 'crlist [n]', 'crnotify [n|sync]']
handler.tags    = ['anime']
handler.command = /^(crlogin|crlogout|crset|crrem|crtime|crstatus|crlist|crnotify)$/i

;(async () => {
  const cfg = loadCfg()
  getSeenSet()
  if (cfg.loggedIn && cfg.accessToken) {
    _token    = cfg.accessToken
    _tokenExp = cfg.tokenExp || 0
  }
  startCron(null)
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${cfg.targetJids.length} | Modo: ${cfg.loggedIn ? 'Cuenta' : 'Anónimo'}`)
})()

export default handler