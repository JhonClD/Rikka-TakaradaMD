import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp/cr-notify')
const DB_PATH   = join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH  = join(TMP_DIR, 'crunchyroll-cfg.json')
const JA_CACHE_PATH = join(TMP_DIR, 'crunchyroll-series-ja.json')
const LOCAL_CREDENTIALS_PATH = join(__dirname, 'credentials.tv.json')

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })
try { chmodSync(TMP_DIR, 0o700) } catch {}
for (const sensitivePath of [DB_PATH, CFG_PATH, JA_CACHE_PATH, LOCAL_CREDENTIALS_PATH]) {
  if (existsSync(sensitivePath)) {
    try { chmodSync(sensitivePath, 0o600) } catch {}
  }
}

// ─── Constantes ─────────────────────────────────────────────────────────────
const CR_BASE    = 'https://www.crunchyroll.com'
const CR_BETA    = 'https://beta-api.crunchyroll.com'
const CR_AUTH    = `${CR_BASE}/auth/v1/token`
const CR_RSS     = 'https://feeds.feedburner.com/crunchyroll/rss/anime'

// Fuente 1: crextractor (se actualiza semanalmente)
const CREDENTIALS_URL = 'https://raw.githubusercontent.com/vitalygashkov/crextractor/refs/heads/main/credentials.tv.json'
// Fuente 2 (respaldo): artifacts de crunchyroll-rs
const CRUNCHYROLL_RS_ARTIFACTS = 'https://raw.githubusercontent.com/crunchy-labs/artifacts/main/credentials.json'

// Fallback final (verificado y actualizado)
const BASIC_ANON_FALLBACK = 'Basic bmR0aTZicXlqcm9wNXZnZjF0dnU6elpIcS00SEJJVDlDb2FMcnBPREJjRVRCTUNHai1QNlg='
const BASIC_AUTH_FALLBACK = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZWdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA_FALLBACK = 'Crunchyroll/ANDROIDTV/3.76.0_22366 (Android 16; en-US; sdk_gphone64_x86_64)'

let DEVICE_ID = (() => {
  try {
    const cfg = loadCfg()
    if (cfg.deviceId) return cfg.deviceId
    const uuid = randomUUID()
    cfg.deviceId = uuid
    saveCfg(cfg)
    return uuid
  } catch {
    return randomUUID()
  }
})()

// ID anónimo efímero por sesión (ETP-Anonymous-ID). Semánticamente distinto del device_id persistente.
const ANON_ETP_ID = randomUUID()

const DEVICE_TYPE = 'ANDROIDTV'
const MAX_SEEN    = 500
const MAX_JA_CACHE = 2000
const CREDENTIAL_CACHE_MS = 6 * 60 * 60_000
const CREDENTIAL_RETRY_MS = 15 * 60_000
const COOKIE_TTL = 6 * 60 * 60_000
const HEALTH_INTERVAL_MS = 30 * 60_000

let BASIC_ANON = BASIC_ANON_FALLBACK
let BASIC_AUTH = BASIC_AUTH_FALLBACK
let CR_UA = CR_UA_FALLBACK
let _credCache = { exp: 0, source: 'fallback', lastError: null }
let _credRefresh = null

// ─── Utilidades ──────────────────────────────────────────────────────────────
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  try { chmodSync(tmp, 0o600) } catch {}
  renameSync(tmp, path)
}

function isValidBasicCredential(value) {
  if (typeof value !== 'string' || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 512) return false
  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return separator > 0 && separator < decoded.length - 1 && !/[\u0000-\u001f\u007f]/.test(decoded)
  } catch { return false }
}

function parseClientVersion(value) {
  if (typeof value !== 'string' || value.length > 48) return null
  const match = value.match(/^((?:\d+\.){1,3}\d+) \((\d{3,8})\)$/)
  return match ? { version: match[1], build: match[2] } : null
}

function buildUserAgent(version, build) {
  return `Crunchyroll/ANDROIDTV/${version}_${build} (Android 16; en-US; sdk_gphone64_x86_64)`
}

function buildBasicAuth(clientId, clientSecret) {
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null
  if (!clientId || !clientSecret || clientId.length > 128 || clientSecret.length > 128) return null
  if (/[\u0000-\u001f\u007f]/.test(clientId + clientSecret)) return null
  const b64 = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  return isValidBasicCredential(b64) ? b64 : null
}

// ─── Mutex simple (promesa encadenada, sin polling) ─────────────────────────
let _lockChain = Promise.resolve()
async function withGlobalLock(fn) {
  const prev = _lockChain
  let release
  _lockChain = new Promise(r => { release = r })
  await prev
  try { return await fn() } finally { release() }
}

// ─── Credenciales (triple fuente + rotación de BASIC_AUTH) ──────────────────
async function fetchCredentialsFrom(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw = await res.text()
  if (raw.length > 32 * 1024) throw new Error('respuesta demasiado grande')
  const credentials = JSON.parse(raw)
  const authorization = credentials?.authorization
  const client = parseClientVersion(credentials?.version)
  if (!isValidBasicCredential(authorization)) throw new Error('authorization inválida')
  if (!client) throw new Error('versión inválida')
  const basicAuth = buildBasicAuth(credentials?.client_id, credentials?.client_secret)
  return { authorization, client, basicAuth }
}

function applyCredentials(authorization, client, basicAuth) {
  BASIC_ANON = authorization
  if (basicAuth) BASIC_AUTH = basicAuth
  CR_UA = buildUserAgent(client.version, client.build)
}

async function refreshCredentials() {
  if (_credRefresh) return _credRefresh
  if (_credCache.exp && Date.now() < _credCache.exp) return

  _credRefresh = (async () => {
    // Fuente 1: crextractor
    try {
      const { authorization, client, basicAuth } = await fetchCredentialsFrom(CREDENTIALS_URL)
      applyCredentials(authorization, client, basicAuth)
      _credCache = { exp: Date.now() + CREDENTIAL_CACHE_MS, source: 'crextractor', lastError: null }
      console.log(`[CR-Notify] Credenciales desde crextractor (v${client.version}, build ${client.build}).`)
      return
    } catch (err) {
      console.warn(`[CR-Notify] crextractor falló: ${err.message}. Probando crunchyroll-rs...`)
      _credCache.lastError = `crextractor: ${err.message}`
    }

    // Fuente 2: artifacts de crunchyroll-rs
    try {
      const { authorization, client, basicAuth } = await fetchCredentialsFrom(CRUNCHYROLL_RS_ARTIFACTS)
      applyCredentials(authorization, client, basicAuth)
      _credCache = { exp: Date.now() + CREDENTIAL_CACHE_MS, source: 'crunchyroll-rs', lastError: null }
      console.log(`[CR-Notify] Credenciales desde crunchyroll-rs (v${client.version}, build ${client.build}).`)
      return
    } catch (err) {
      console.warn(`[CR-Notify] crunchyroll-rs falló: ${err.message}. Probando archivo local...`)
      _credCache.lastError = `crunchyroll-rs: ${err.message}`
    }

    // Fuente 3: archivo local
    try {
      if (existsSync(LOCAL_CREDENTIALS_PATH)) {
        const raw = readFileSync(LOCAL_CREDENTIALS_PATH, 'utf-8')
        const credentials = JSON.parse(raw)
        const authorization = credentials?.authorization
        const client = parseClientVersion(credentials?.version)
        const basicAuth = buildBasicAuth(credentials?.client_id, credentials?.client_secret)
        if (isValidBasicCredential(authorization) && client) {
          applyCredentials(authorization, client, basicAuth)
          _credCache = { exp: Date.now() + CREDENTIAL_CACHE_MS, source: 'local', lastError: null }
          console.log(`[CR-Notify] Credenciales locales cargadas (v${client.version}).`)
          return
        }
      }
    } catch (localErr) {
      console.warn(`[CR-Notify] Archivo local falló: ${localErr.message}`)
      _credCache.lastError = `local: ${localErr.message}`
    }

    // Fallback final (hardcodeado) — sólo si no tenemos una credencial buena previa
    const sourceIsFallback = _credCache.source === 'fallback' || _credCache.source === 'stale'
    if (sourceIsFallback || !isValidBasicCredential(BASIC_ANON)) {
      BASIC_ANON = BASIC_ANON_FALLBACK
      CR_UA = CR_UA_FALLBACK
      _credCache = {
        exp: Date.now() + CREDENTIAL_RETRY_MS,
        source: 'fallback',
        lastError: _credCache.lastError,
      }
      console.warn('[CR-Notify] Usando credenciales de respaldo final (fallback).')
    } else {
      // Conservamos la última credencial buena y reintentamos pronto
      _credCache.exp = Date.now() + CREDENTIAL_RETRY_MS
      console.warn('[CR-Notify] Fuentes remotas fallaron; conservando credencial previa y reintentando pronto.')
    }
  })().finally(() => {
    _credRefresh = null
  })

  return _credRefresh
}

// ─── Persistencia ─────────────────────────────────────────────────────────────
function loadCfg() {
  try {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    if (cfg.targetJid && !cfg.targetJids) {
      cfg.targetJids = [cfg.targetJid]
      delete cfg.targetJid
      saveCfg(cfg)
    }
    if (!Array.isArray(cfg.targetJids)) cfg.targetJids = cfg.targetJids ? [cfg.targetJids] : []
    cfg.targetJids = [...new Set(cfg.targetJids.filter(j => typeof j === 'string' && j.trim()))]
    return cfg
  } catch { return { targetJids: [] } }
}
function saveCfg(d) { writeJsonAtomic(CFG_PATH, d) }

function loadSeen() {
  try {
    const ids = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
    return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id))] : []
  } catch { return [] }
}
function saveSeen(ids) { writeJsonAtomic(DB_PATH, [...new Set(ids)].slice(-MAX_SEEN)) }

// ─── Caché de títulos japoneses ──────────────────────────────────────────────
let _seriesCache = {}
function loadSeriesCache() {
  try {
    const raw = JSON.parse(readFileSync(JA_CACHE_PATH, 'utf-8'))
    _seriesCache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  } catch { _seriesCache = {} }
}
function saveSeriesCache() {
  const keys = Object.keys(_seriesCache)
  if (keys.length > MAX_JA_CACHE) {
    for (const k of keys.slice(0, keys.length - MAX_JA_CACHE)) delete _seriesCache[k]
  }
  try { writeJsonAtomic(JA_CACHE_PATH, _seriesCache) } catch {}
}
loadSeriesCache()

const _seriesFetching = new Map()

function extractSeriesTitle(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.title === 'string' && data.title) return data.title
  if (data.series_metadata?.title) return data.series_metadata.title
  if (Array.isArray(data.items) && data.items[0]?.title) return data.items[0].title
  if (Array.isArray(data.data) && data.data[0]?.title) return data.data[0].title
  return ''
}

async function getJapaneseTitle(seriesId) {
  if (!seriesId) return ''
  if (typeof _seriesCache[seriesId] === 'string' && _seriesCache[seriesId]) return _seriesCache[seriesId]
  if (_seriesFetching.has(seriesId)) return _seriesFetching.get(seriesId)

  const promise = (async () => {
    try {
      const data = await crFetch(`/content/v1/series/${seriesId}`, { locale: 'ja-JP' }, CR_BETA)
      const title = extractSeriesTitle(data)
      // No cachear títulos vacíos (permite reintentar si es transitorio)
      if (title) {
        _seriesCache[seriesId] = title
        saveSeriesCache()
      }
      return title
    } catch {
      return ''
    } finally {
      _seriesFetching.delete(seriesId)
    }
  })()
  _seriesFetching.set(seriesId, promise)
  return promise
}

// ─── Cookies (con TTL) ───────────────────────────────────────────────────────
let _cookies = ''
let _cookiesExp = 0
async function preLogin(force = false) {
  if (!force && _cookies && Date.now() < _cookiesExp) return
  await refreshCredentials()
  try {
    const res = await fetch(CR_BASE, { headers: { 'User-Agent': CR_UA }, signal: AbortSignal.timeout(15_000) })
    const raw = res.headers.getSetCookie?.() || []
    _cookies = raw.map(c => c.split(';')[0]).join('; ')
    _cookiesExp = Date.now() + COOKIE_TTL
  } catch {}
}

// ─── Tokens ───────────────────────────────────────────────────────────────────
let _token = null, _tokenExp = 0

async function getAnonToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token
  await refreshCredentials()
  await preLogin()

  const doRequest = () => fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      'Authorization': BASIC_ANON,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CR_UA,
      'ETP-Anonymous-ID': ANON_ETP_ID,
      'Cookie': _cookies,
    },
    body: new URLSearchParams({ grant_type: 'client_id', scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE }).toString(),
    signal: AbortSignal.timeout(15_000),
  })

  let res = await doRequest()

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    const isClientInactive = res.status === 401 && /client_inactive|invalid_client|invalid_grant/i.test(raw)

    if (isClientInactive) {
      console.warn('[CR-Notify] Credenciales inactivas. Forzando refresh de todas las fuentes...')
      _credCache.exp = 0
      _credCache.source = 'stale'
      _cookiesExp = 0
      try {
        await refreshCredentials()
        await preLogin(true)
        res = await doRequest()
      } catch (refreshErr) {
        console.error('[CR-Notify] Refresh de emergencia falló:', refreshErr.message)
      }
    }

    if (!res.ok) {
      const t = await res.text().catch(() => raw)
      throw new Error(`Auth anónima HTTP ${res.status}: ${(t || raw).slice(0, 80)}`)
    }
  }

  const data = await res.json()
  _token = data.access_token
  _tokenExp = Date.now() + (data.expires_in || 300) * 1000
  return _token
}

async function loginWithAccount(email, password) {
  await preLogin()
  const body = new URLSearchParams({ grant_type: 'password', username: email, password, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'ETP-Anonymous-ID': ANON_ETP_ID, 'Cookie': _cookies },
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
  await preLogin()
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, scope: 'offline_access', device_id: DEVICE_ID, device_type: DEVICE_TYPE })
  const res  = await fetch(CR_AUTH, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CR_UA, 'ETP-Anonymous-ID': ANON_ETP_ID, 'Cookie': _cookies },
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

async function crFetch(path, params = {}, base = CR_BASE) {
  const url   = new URL(`${base}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken()
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': CR_UA, 'Accept': 'application/json', 'Cookie': _cookies },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return res.json()
    if (res.status === 401 && attempt === 0) {
      _token = null; _tokenExp = 0
      _cookiesExp = 0
      const cfg = loadCfg()
      if (cfg.loggedIn) { delete cfg.accessToken; delete cfg.tokenExp; saveCfg(cfg) }
      continue
    }
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`CR API HTTP ${res.status} → ${path}${detail ? `: ${detail}` : ''}`)
  }
  throw new Error(`CR API no pudo renovar el token → ${path}`)
}

// ─── Normalización de episodios ──────────────────────────────────────────────
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
    .sort((a, b) => (b.width * b.height || b.width) - (a.width * a.height || a.width))[0]?.source || ''
}

function normalizeEpisode(p) {
  const meta    = p.episode_metadata || {}
  const airRaw  = p.premium_available_date || p.availability_starts || p.episode_air_date || ''
  const airTime = airRaw ? new Date(airRaw).getTime() : 0
  const epNum   = p.episode_number ?? meta.episode_number ?? null
  const epId    = p.id || ''
  const slug    = p.slug_title || meta.slug_title || ''
  const seriesId = p.series_id || meta.series_id || ''

  let locale = p.audio_locale || meta.audio_locale || ''
  if (!locale && Array.isArray(meta.audio_locales) && meta.audio_locales.length) {
    locale = meta.audio_locales[0]
  }

  let seriesName = p.series_title || meta.series_title || ''
  const seasonTitle = p.season_title || meta.season_title || ''
  if (seasonTitle && seriesName && !seriesName.includes(seasonTitle) && !seasonTitle.startsWith(seriesName)) {
    seriesName += ` ${seasonTitle}`
  }
  if (!seriesName.trim()) seriesName = p.title || 'Anime Desconocido'

  return {
    id: epId,
    seriesId,
    series: seriesName.trim(),
    epTitle: p.title || '',
    epNum: epNum !== null ? epNum : 'Especial',
    link: `https://www.crunchyroll.com/watch/${epId}${slug ? `/${slug}` : ''}`,
    audioLocale: locale,
    image: extractImage(p.images),
    airTime
  }
}

function sortNewest(episodes) {
  return [...episodes].sort((a, b) => {
    const dateDiff = (Number(b.airTime) || 0) - (Number(a.airTime) || 0)
    if (dateDiff !== 0) return dateDiff
    return String(b.id).localeCompare(String(a.id))
  })
}

// ─── Parser RSS (fallback de emergencia) ─────────────────────────────────────
function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function parseRssItems(xml) {
  const items = []
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const tag = (name) => {
      const r = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i')
      const mm = block.match(r)
      return mm ? stripCdata(mm[1]) : ''
    }
    const title   = tag('title')
    const link    = tag('link') || (block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || '')
    const pubDate = tag('pubDate')
    const guid    = tag('guid')

    const idMatch = link.match(/\/watch\/([^\/\s?#]+)/)
    const id = idMatch ? idMatch[1] : (guid || '')

    // Heurística para extraer número de episodio del título
    const epMatch = title.match(/(?:^|\s)(?:Episode|Ep\.?|E)\s*(\d+)(?:\s|$)/i)
    const epNum = epMatch ? Number(epMatch[1]) : null

    // Series = título sin el sufijo "Episode N ..."
    const series = title
      .replace(/\s*(?:Episode|Ep\.?|E)\s*\d+.*$/i, '')
      .trim() || title

    // Intentar thumbnail de media:thumbnail o enclosure
    let image = ''
    const thumbMatch = block.match(/<media:thumbnail\b[^>]*url="([^"]+)"/i)
    if (thumbMatch) image = thumbMatch[1]
    if (!image) {
      const encMatch = block.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*type="image\/[^"]*"/i)
      if (encMatch) image = encMatch[1]
    }

    items.push({
      id,
      seriesId: '',
      series,
      epTitle: '',
      epNum: epNum !== null ? epNum : 'Especial',
      link,
      audioLocale: 'ja-JP',
      image,
      airTime: pubDate ? (new Date(pubDate).getTime() || 0) : 0,
    })
  }
  return items.filter(i => i.id && i.series && i.link)
}

async function fetchRssEpisodes() {
  const res = await fetch(CR_RSS, {
    headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5', 'User-Agent': CR_UA },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`)
  const xml = await res.text()
  if (xml.length > 2 * 1024 * 1024) throw new Error('RSS demasiado grande')
  return parseRssItems(xml)
}

// ─── Formato y locales ───────────────────────────────────────────────────────
const FLAG = {
  'ja-JP':'🇯🇵','en-US':'🇺🇸','es-419':'🇲🇽','es-LA':'🇲🇽','es-ES':'🇪🇸','pt-BR':'🇧🇷',
  'fr-FR':'🇫🇷','de-DE':'🇩🇪','it-IT':'🇮🇹','ru-RU':'🇷🇺','ar-SA':'🇸🇦',
}
const LOCALE_NAME = {
  'ja-JP':'Japonés','en-US':'Inglés','es-419':'Latino','es-LA':'Latino','es-ES':'Castellano',
  'pt-BR':'Portugués','fr-FR':'Francés','de-DE':'Alemán','it-IT':'Italiano','ru-RU':'Ruso','ar-SA':'Árabe',
}
const ALLOWED_LOCALES = new Set(['ja-JP','es-419','es-LA','es-ES'])

async function formatCaption(ep) {
  let displayTitle = ep.series
  if (ep.seriesId) {
    try {
      const jaTitle = await getJapaneseTitle(ep.seriesId)
      if (jaTitle) displayTitle = jaTitle
    } catch {}
  }
  const audioFlag  = FLAG[ep.audioLocale] || '🌐'
  const localeName = LOCALE_NAME[ep.audioLocale] || ep.audioLocale || 'Desconocido'
  const epLabel    = `Ep. ${ep.epNum}`
  const epLine     = ep.epTitle ? `${epLabel} - ${ep.epTitle}` : epLabel
  return (
    `📺 ${displayTitle}\n` +
    `🎬 ${epLine}\n` +
    `${audioFlag} ${localeName}\n\n` +
    `${ep.link}`
  )
}

// ─── Fetch de episodios ──────────────────────────────────────────────────────
function getPageCount() {
  const pages = Number(process.env.CR_PAGES ?? 1)
  return Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 1
}

async function fetchBrowseEpisodes(pageCount = getPageCount()) {
  const allRows = []
  const pageSize = 100

  for (let page = 0; page < pageCount; page++) {
    const data = await crFetch('/content/v2/discover/browse', {
      count: String(pageSize),
      start: String(page * pageSize),
      sort_by: 'newly_added',
      type: 'episode',
      locale: 'es-419',
    }, CR_BETA)
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : []
    if (!rows.length) break
    allRows.push(...rows)
    if (rows.length < pageSize) break
  }

  return [...new Map(allRows.map(normalizeEpisode)
    .filter(i => {
      if (!i.id || !i.series) return false
      if (!ALLOWED_LOCALES.has(i.audioLocale)) {
        console.warn('[CR-Notify] Descartado por locale:', i.id, i.series, i.audioLocale || '(vacío)')
        return false
      }
      return true
    })
    .map(i => [i.id, i])).values()]
}

async function fetchNewEpisodes() {
  let valid
  try {
    valid = await fetchBrowseEpisodes()
  } catch (err) {
    console.warn(`[CR-Notify] API browse falló (${err.message}). Intentando RSS de emergencia...`)
    try {
      valid = await fetchRssEpisodes()
      console.log(`[CR-Notify] RSS devolvió ${valid.length} ítem(s).`)
    } catch (rssErr) {
      console.error(`[CR-Notify] RSS también falló: ${rssErr.message}`)
      return []
    }
  }

  if (!valid.length) return []

  const seen = loadSeen()

  if (seen.length === 0) {
    saveSeen(valid.map(i => i.id))
    console.log(`[CR-Notify] Caché sembrado con ${valid.length} IDs.`)
    return []
  }

  return sortNewest(valid.filter(i => !seen.includes(i.id)))
}

function markSeen(id) {
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

async function getLatestEpisodes(limit = 10) {
  const episodes = await fetchBrowseEpisodes()
  return sortNewest(episodes).slice(0, limit)
}

// ─── Envío ────────────────────────────────────────────────────────────────────
async function sendItem(conn, jid, ep, quoted = null) {
  const caption = await formatCaption(ep)
  const opts    = quoted ? { quoted } : {}
  if (ep.image) {
    try {
      await conn.sendMessage(jid, { image: { url: ep.image }, caption }, opts)
      return
    } catch {
      await delay(500)
    }
  }
  await conn.sendMessage(jid, { text: caption }, opts)
}
const delay = ms => new Promise(r => setTimeout(r, ms))

// ─── Cron ─────────────────────────────────────────────────────────────────────
let cronTimer = null
let healthTimer = null
let storedConn = null
let cronRunning = false

function stopCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null }
}
function getConn() { return storedConn || global.conn || null }

function startHealthCheck() {
  if (healthTimer) return
  healthTimer = setInterval(async () => {
    try {
      await crFetch('/content/v2/discover/browse', { count: '1', type: 'episode', locale: 'es-419' }, CR_BETA)
    } catch (err) {
      console.warn(`[CR-Notify] Health-check falló (${err.message}). Refrescando credenciales y cookies...`)
      _credCache.exp = 0
      _cookiesExp = 0
      try {
        await refreshCredentials()
        await preLogin(true)
      } catch (e) {
        console.error('[CR-Notify] Refresh en health-check falló:', e.message)
      }
    }
  }, HEALTH_INTERVAL_MS)
}
function stopHealthCheck() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
}

function startCron(conn) {
  if (conn) storedConn = conn
  stopCron()

  const cfg = loadCfg()
  if (cfg.cronDisabled) {
    console.log('[CR-Notify] Cron deshabilitado por configuración (usa .crstart para reactivar).')
    return
  }

  const rawMinutes = process.env.CR_MINUTES || cfg.minutes || 5
  const parsedMinutes = Number(rawMinutes)
  const minutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? Math.max(1, Math.floor(parsedMinutes)) : 5

  cronTimer = setInterval(async () => {
    if (cronRunning) return
    const activeConn = getConn()
    if (!activeConn) return
    const jids = loadCfg().targetJids || []
    if (!jids.length) return

    cronRunning = true
    try {
      await withGlobalLock(async () => {
        const items = await fetchNewEpisodes()
        if (!items.length) return

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
          if (algunExito) markSeen(ep.id)
          await delay(3000)
        }
        console.log(`[CR-Notify] ${items.length} ep(s) → ${jids.length} grupo(s)`)
      })
    } catch (err) {
      console.error('[CR-Notify] Cron:', err.message)
    } finally {
      cronRunning = false
    }
  }, minutes * 60_000)

  const jids = cfg.targetJids || []
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${jids.length} grupo(s) configurado(s)`)
}

// ─── Handler de comandos ──────────────────────────────────────────────────────
let handler = async (m, { conn, command, args, isOwner, isAdmin }) => {
  if (conn) storedConn = conn
  if (!cronTimer) {
    const cfg0 = loadCfg()
    if (!cfg0.cronDisabled) startCron(conn)
  }
  const canManageGroup = isOwner || isAdmin

  if (command === 'crlogin') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    if (m.isGroup) {
      return conn.sendMessage(m.chat, { text: '⛔ Por seguridad, usa *.crlogin* solo por privado.' }, { quoted: m })
    }
    const email = args[0]
    const pass  = args.slice(1).join(' ')
    if (!email || !pass) return conn.sendMessage(m.chat, { text: '💡 Uso: *.crlogin email contraseña*' }, { quoted: m })
    await conn.sendMessage(m.chat, { text: '🔐 Conectando con Crunchyroll...' }, { quoted: m })
    try {
      await loginWithAccount(email, pass)
      const cfg = loadCfg()
      cfg.cronDisabled = false
      saveCfg(cfg)
      startCron(conn)
      return conn.sendMessage(m.chat, {
        text: `✅ *Login exitoso*\n👤 Cuenta real activa\n🎯 Grupos: ${cfg.targetJids.length}\n🔄 Monitor cada ${process.env.CR_MINUTES || cfg.minutes || 5} min\n🔁 Refresh automático habilitado`,
      }, { quoted: m })
    } catch (e) { return conn.sendMessage(m.chat, { text: `❌ *Auth fallida*\n${e.message}` }, { quoted: m }) }
  }

  if (command === 'crlogout') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    delete cfg.accessToken; delete cfg.refreshToken; delete cfg.tokenExp
    delete cfg.accountId; delete cfg.loggedIn
    saveCfg(cfg)
    _token = null; _tokenExp = 0
    return conn.sendMessage(m.chat, {
      text: `🔒 Sesión cerrada. Grupos conservados (${cfg.targetJids.length}).\nEl cron continúa en modo anónimo.`,
    }, { quoted: m })
  }

  if (command === 'crset') {
    if (!canManageGroup) return conn.sendMessage(m.chat, { text: '⛔ Solo administradores del grupo o el dueño.' }, { quoted: m })
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
    if (!canManageGroup) return conn.sendMessage(m.chat, { text: '⛔ Solo administradores del grupo o el dueño.' }, { quoted: m })
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

  if (command === 'crstatus') {
    const cfg  = loadCfg()
    const mins = process.env.CR_MINUTES || cfg.minutes || 5
    const seen = loadSeen()
    const exp  = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
    const gruposList = cfg.targetJids.length
      ? cfg.targetJids.map((j, i) => `  ${i + 1}. \`${j}\``).join('\n')
      : '  _Ninguno — usa .crset_'
    const jaCached = Object.keys(_seriesCache).length
    const authRotated = BASIC_AUTH !== BASIC_AUTH_FALLBACK ? '✅ rotada' : '⚠️ fallback'
    return conn.sendMessage(m.chat, {
      text: `📊 *CR-Notify Status*\n\n` +
            `🔑 Modo: *${cfg.loggedIn ? '👤 Cuenta real ✅' : '👻 Anónimo'}*\n` +
            `⏳ Token expira: *${exp}*\n` +
            `🔁 Refresh token: *${cfg.refreshToken ? 'Sí ✅' : 'No ❌'}*\n` +
            `⏱ Cron: cada *${mins} min*\n` +
            `🔄 Cron activo: *${cronTimer ? 'Sí ✅' : (cfg.cronDisabled ? 'Detenido ⏸️' : 'No ❌')}*\n` +
            `💾 IDs caché: *${seen.length}*\n` +
            `🇯🇵 Títulos JA en caché: *${jaCached}*\n` +
            `🔐 Basic Auth (login): *${authRotated}*\n` +
            `🔐 Credenciales anón.: *${_credCache.source}* (exp ${_credCache.exp ? new Date(_credCache.exp).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'})*\n` +
            `⚠️ Último error: *${_credCache.lastError || 'Ninguno'}*\n\n` +
            `🎯 *Grupos configurados (${cfg.targetJids.length}):*\n${gruposList}`,
    }, { quoted: m })
  }

  if (command === 'crstop') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    cfg.cronDisabled = true
    saveCfg(cfg)
    stopCron()
    return conn.sendMessage(m.chat, { text: '🛑 Cron detenido (persistente). Usa *.crstart* para reanudar.' }, { quoted: m })
  }

  if (command === 'crstart') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg = loadCfg()
    cfg.cronDisabled = false
    saveCfg(cfg)
    startCron(conn)
    return conn.sendMessage(m.chat, { text: '▶️ Cron reiniciado.' }, { quoted: m })
  }

  if (command === 'crlist') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    await conn.sendMessage(m.chat, { text: '🔍 Obteniendo los 10 lanzamientos más recientes...' }, { quoted: m })
    try {
      await withGlobalLock(async () => {
        const episodes = await getLatestEpisodes(10)
        if (!episodes.length) {
          await conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios recientes.' }, { quoted: m })
          return
        }
        for (const ep of episodes) {
          await sendItem(conn, m.chat, ep, m)
          await delay(2000)
        }
      })
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m })
    }
    return
  }

  if (command === 'crnotify') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    const cfg  = loadCfg()
    const jids = cfg.targetJids.length ? cfg.targetJids : [m.chat]
    await conn.sendMessage(m.chat, { text: `🔍 Enviando los 10 estrenos recientes a ${jids.length} grupo(s)...` }, { quoted: m })
    try {
      await withGlobalLock(async () => {
        const episodes = await getLatestEpisodes(10)
        if (!episodes.length) {
          await conn.sendMessage(m.chat, { text: '📭 No se encontraron episodios.' }, { quoted: m })
          return
        }
        for (const ep of episodes) {
          for (const jid of jids) {
            try {
              await sendItem(conn, jid, ep)
              await delay(1500)
            } catch (err) {
              console.error(`[CR-Notify] Error enviando a ${jid}:`, err.message)
            }
          }
          await delay(3000)
        }
      })
    } catch (err) {
      await conn.sendMessage(m.chat, { text: `❌ Error: ${err.message}` }, { quoted: m })
    }
    return
  }

  if (command === 'crdiag') {
    if (!isOwner) return conn.sendMessage(m.chat, { text: '⛔ Solo el dueño.' }, { quoted: m })
    await conn.sendMessage(m.chat, { text: '🩺 Diagnosticando credenciales...' }, { quoted: m })
    const lines = []
    try {
      await refreshCredentials()
      lines.push(`📡 Fuente activa: *${_credCache.source}*`)
      lines.push(`🕒 Expira: *${_credCache.exp ? new Date(_credCache.exp).toLocaleString('es-MX') : '—'}*`)
      if (_credCache.lastError) lines.push(`⚠️ Último error de fuente: _${_credCache.lastError}_`)
      lines.push(`🔑 Basic Anon (primeros 20): \`${BASIC_ANON.slice(0, 20)}...\``)
      lines.push(`🔐 Basic Auth (login): *${BASIC_AUTH === BASIC_AUTH_FALLBACK ? 'fallback ⚠️' : 'rotada ✅'}*`)
      lines.push(`👤 User-Agent: \`${CR_UA.slice(0, 40)}...\``)
      lines.push(`🆔 Device ID: \`${DEVICE_ID}\``)
      lines.push(`🆔 ETP-Anon ID: \`${ANON_ETP_ID.slice(0, 8)}...\``)
      lines.push(`🍪 Cookies: ${_cookies ? '✅' : '❌'} (TTL ${_cookiesExp ? new Date(_cookiesExp).toLocaleTimeString('es-MX') : '—'})`)
      try {
        const token = await getAnonToken()
        lines.push(`✅ Auth anónima: *OK* (token: \`${token.slice(0, 15)}...\`)`)
      } catch (authErr) {
        lines.push(`❌ Auth anónima: *FALLÓ* → ${authErr.message}`)
      }
      try {
        const rssItems = await fetchRssEpisodes()
        lines.push(`📰 RSS test: *OK* (${rssItems.length} ítems)`)
      } catch (rssErr) {
        lines.push(`📰 RSS test: *FALLÓ* → ${rssErr.message}`)
      }
    } catch (e) {
      lines.push(`❌ Error general: ${e.message}`)
    }
    return conn.sendMessage(m.chat, { text: `🩺 *CR-Notify Diagnóstico*\n\n${lines.join('\n')}` }, { quoted: m })
  }
}

handler.help    = ['crlogin <email> <pass>', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist', 'crnotify', 'crstop', 'crstart', 'crdiag']
handler.tags    = ['anime']
handler.command = /^(crlogin|crlogout|crset|crrem|crstatus|crlist|crnotify|crstop|crstart|crdiag)$/i

// ─── Auto-arranque ───────────────────────────────────────────────────────────
;(async () => {
  const cfg = loadCfg()
  if (cfg.loggedIn && cfg.accessToken) {
    _token    = cfg.accessToken
    _tokenExp = cfg.tokenExp || 0
  }
  if (!cfg.cronDisabled) startCron(null)
  startHealthCheck()
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${cfg.targetJids.length} | Modo: ${cfg.loggedIn ? 'Cuenta' : 'Anónimo'} | Cron: ${cfg.cronDisabled ? 'OFF' : 'ON'} | Títulos JA cacheados: ${Object.keys(_seriesCache).length}`)
})()

export default handler