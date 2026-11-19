// plugins/dbs-notify.js — v4.0
//
// Notificador automático de nuevos episodios — AnimeDBS (SUB + AUDIO LATINO)
//
// Comandos: dbsstart · dbsstop · dbsstatus · dbscheck · dbsqueue · dbsflush
//           dbsunblock · dbsinterval · dbsexample
//
// Cambios de esta versión frente a la 3.2:
//   • Envío desde disco: el episodio se pasa como ruta local, no como Buffer.
//     Antes un capítulo de 700 MB vivía dos veces en RAM (archivo + copia de
//     WhatsApp) y el proceso se reiniciaba por falta de memoria.
//   • Estado coherente: cada escritura de JSON se relee del disco antes de
//     mutar, así dos chats en paralelo no se pisan `dbs_seen.json`.
//   • Sin falsos negativos por throttling: si una ficha no responde (timeout,
//     429, 5xx) el episodio NO se marca como visto: se reintenta en el
//     siguiente sondeo. Solo se descarta cuando la ficha respondió bien y de
//     verdad no tiene enlaces descargables.
//   • Un episodio = un envío: si SUB y LAT comparten ficha, se descarga una
//     vez y el segundo idioma reutiliza el archivo.
//   • El envío de episodios es limpio: solo documentos, sin portada ni caption.
//   • Menos peticiones: caché del sondeo y del listado de servidores.

import axios from 'axios'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { DATA_DIR, TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { File as MegaFile } from 'megajs'
import animeV1Downloader from '../src/libraries/animev1-download.cjs'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'
import { compressDw4 } from '../src/libraries/dw4-compress.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const ANIMEDBS_URL        = 'https://www.animedbs.online'
const DBS_DIRECTORY_URL   = `${ANIMEDBS_URL}/anime/?status=&type=&order=update`
const DBS_DIRECTORY_LIMIT = 12
const ANILIST_URL         = 'https://graphql.anilist.co'

const DB_DIR = DATA_DIR
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const SEEN_FILE  = path.join(DB_DIR, 'dbs_seen.json')
const STATE_FILE = path.join(DB_DIR, 'dbs_state.json')

const CHECK_INTERVAL_DEFAULT = 10            // minutos
const CHECK_INTERVAL_SECONDS = CHECK_INTERVAL_DEFAULT * 60
const MIN_INTERVAL_SECONDS   = 15
const MAX_INTERVAL_SECONDS   = 3600
const QUEUE_DELAY            = 90_000        // ms entre ítems de cola (90 seg)
const DL_TIMEOUT             = 3 * 60 * 60 * 1000
const MIN_EPISODE_SIZE_BYTES = 5 * 1024 * 1024
const MAX_SEEN_POR_CHAT      = 500
const STALE_TEMP_MS          = 6 * 60 * 60 * 1000

// Cachés de red: entre chats se repiten el sondeo y las mismas fichas.
const FEED_CACHE_MS     = 40_000
const SERVERS_CACHE_MS  = 10 * 60_000
const FEED_CACHE_MAX    = 4
const SERVERS_CACHE_MAX = 40
const HTTP_TIMEOUT      = 15_000

// [MEJORA VELOCIDAD] megajs descarga por bloques y conexiones paralelas.
const MEGA_MAX_CONNECTIONS = Math.min(Math.max(Number(process.env.MEGA_MAX_CONNECTIONS) || 16, 4), 32)
const MEGA_CHUNK_SIZE      = 1024 * 1024 // máximo documentado por megajs: 1 MB
const MF_HILOS             = 8
const MF_MIN_SIZE_PARALELO = 5 * 1024 * 1024

const BLOQUEO_TEXTO = [
  '🚫 *AnimeDBS está bloqueando al bot (HTTP 403)*',
  '',
  'El sitio rechaza conexiones que no vienen de un navegador desde una IP',
  'residencial. Para que el notificador vuelva a funcionar, el dueño puede:',
  '',
  '┃ 1️⃣ *Proxy* — añadir `DBS_PROXY_URL=http://usuario:clave@host:puerto`',
  '┃ 2️⃣ *Cloudflare* — levantar FlareSolverr y poner `DBS_FLARESOLVERR_URL`',
  '┃ 3️⃣ *Cookie* — copiar `cf_clearance` del navegador en `DBS_COOKIE`',
  '',
  '> El bot ya intenta huella de Chrome (wreq/impit), axios y curl.',
  '> Los episodios no se pierden: quedan pendientes hasta que el acceso funcione.',
].join('\n')

const DBS_SERVIDORES  = new Set(['mega', 'mediafire', 'directo'])
const ERROR_OWNER_JID = process.env.DBS_ERROR_OWNER_JID || process.env.TIO_ERROR_OWNER_JID || '51925092348@s.whatsapp.net'

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

// ─── Cliente HTTP de AnimeDBS ────────────────────────────────────────────────
//
// El sitio responde **403** al bot cuando lo sondea desde una IP de datacenter
// (VPS, Termux con datos móviles, etc.): el WAF mira el handshake TLS, no solo
// el `User-Agent`, así que mandar cabeceras de Chrome no alcanza. Por eso aquí
// abajo se habla con huella de Chrome de verdad (wreq-js / impit) y, si aun así
// bloquean, se escala a un proxy o a FlareSolverr.
//
// Estrategias, en orden. La primera que responde 2xx gana y **se recuerda**,
// para no gastar cinco peticiones por cada ficha durante el resto del proceso:
//
//   1. wreq-js      — huella Chrome (lo que ya usa jk-notify en este repo)
//   2. impit        — huella Chrome; implementación distinta, cubre fallos de wreq
//   3. axios        — navegador "de mentira"; sirve si el WAF solo mira headers
//   4. curl         — binario del sistema, otra pila TLS
//   5. FlareSolverr — solo si DBS_FLARESOLVERR_URL está configurado
//
// Si todas fallan con 403, el error dice exactamente qué configurar
// (DBS_PROXY_URL o DBS_FLARESOLVERR_URL) en vez de un "Request failed with
// status code 403" que no deja hacer nada.


const DBS_HTTP_TIMEOUT = 20_000
const DBS_CLIENTE_REINTENTOS = 3
// Lista blanca opcional de estrategias, por si hace falta forzar una:
// DBS_HTTP_ESTRATEGIAS=axios,curl. Sin definir se prueban todas en orden.
const DBS_ESTRATEGIAS_FORZADAS = String(process.env.DBS_HTTP_ESTRATEGIAS || '')
  .split(',')
  .map(nombre => nombre.trim().toLowerCase())
  .filter(Boolean)

// Mismo navegador que declaran impit/wreq: si el User-Agent no coincide con el
// handshake TLS, el WAF lo nota.
const NAVEGADOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
// Perfil que emulan wreq-js e impit; si se cambia uno hay que cambiar el otro,
// porque un UA que no case con el handshake delata igual que un axios.
const PERFIL_WREQ = 'chrome_136'
const PERFIL_IMPIT = 'chrome136'

// Cabeceras de reserva. Si wreq-js está disponible se sustituyen por las de su
// emulación (incluyen sec-ch-ua): un Chrome 136 que no manda client hints es
// tan sospechoso como un axios.
const CABECERAS_BASE = {
  'User-Agent': NAVEGADOR_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

/**
 * Cabeceras activas. Es mutable a propósito: `wreq-js` solo existe tras un
 * import dinámico, y cuando llega su emulación se reemplaza el contenido de
 * este objeto (no la referencia) para que quien ya lo tenga en la mano lo vea.
 */
const DBS_HEADERS = { ...CABECERAS_BASE }

const PROXY_URL = String(
  process.env.DBS_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
).trim()
const FLARESOLVERR_URL = String(process.env.DBS_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '').replace(/\/+$/, '')
const COOKIE_INICIAL = String(process.env.DBS_COOKIE || '').trim()

// Si el dueño copió la cookie de su navegador, el sitio espera el UA de *ese*
// navegador y no el Chrome 136 que ponemos por defecto.
const NAVEGADOR_UA_ENV = String(process.env.DBS_UA || NAVEGADOR_UA).trim()

const dbsHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8 })

// Clientes perezosos: si `impit`/`wreq-js` no traen binario para esta
// plataforma (Termux ARM, por ejemplo) el import no debe tumbar el plugin
// entero; simplemente se saltan esas estrategias.
let moduloWreq = null
let wreqFallido = false
async function getWreq() {
  if (moduloWreq || wreqFallido) return moduloWreq
  try {
    moduloWreq = await import('wreq-js')
    // getEmulationHeaders da el juego exacto de cabeceras del perfil, que es
    // más creíble que cualquier lista escrita a mano.
    try {
      const emuladas = moduloWreq.getEmulationHeaders(PERFIL_WREQ, 'windows')
      const plano = emuladas && typeof emuladas.forEach === 'function'
        ? Object.fromEntries(emuladas)
        : emuladas
      if (plano && Object.keys(plano).length) {
        // `getEmulationHeaders` devuelve los nombres en minúscula; mezclarlos
        // con los de reserva mandaría dos User-Agent distintos.
        for (const clave of Object.keys(DBS_HEADERS)) delete DBS_HEADERS[clave]
        Object.assign(DBS_HEADERS, plano)
      }
    } catch (_) { /* se conservan las de reserva */ }
  } catch (error) {
    wreqFallido = true
    console.warn(`[dbs-notify] wreq-js no disponible: ${error.message}`)
  }
  return moduloWreq
}

let impitClient = null
let impitFallido = false
async function getImpit() {
  if (impitClient || impitFallido) return impitClient
  try {
    const { Impit } = await import('impit')
    impitClient = new Impit({
      browser: PERFIL_IMPIT,
      timeout: DBS_HTTP_TIMEOUT,
      headers: DBS_HEADERS,
      ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}),
    })
  } catch (error) {
    impitFallido = true
    console.warn(`[dbs-notify] impit no disponible: ${error.message}`)
  }
  return impitClient
}

const dbsSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Cookie vigente: la de entorno (copiada de un navegador) o la de FlareSolverr. */
let cookieSesion = COOKIE_INICIAL
/** User-Agent que dictó FlareSolverr al resolver el desafío; manda sobre el de entorno. */
let uaSesion = ''

/**
 * Cabeceras de una petición concreta.
 *
 * `DBS_HEADERS` puede venir de la emulación de wreq (nombres en minúscula) o de la
 * reserva; aquí se normaliza todo a minúsculas para que sobrescribir el UA no
 * deje un `user-agent` viejo al lado.
 */
function cabeceras(extra = {}, { documento = true } = {}) {
  const agente = uaSesion || NAVEGADOR_UA_ENV
  const base = documento
    ? DBS_HEADERS
    : { accept: '*/*', 'accept-language': DBS_HEADERS['accept-language'] || DBS_HEADERS['Accept-Language'] }
  const salida = {}
  for (const [clave, valor] of Object.entries(base)) salida[clave.toLowerCase()] = valor
  salida['user-agent'] = agente
  if (cookieSesion) salida.cookie = cookieSesion
  for (const [clave, valor] of Object.entries(extra)) salida[clave.toLowerCase()] = valor
  return salida
}

function normalizar(respuesta, url) {
  return {
    data: respuesta.data,
    status: respuesta.status,
    headers: respuesta.headers || {},
    request: { res: { responseUrl: respuesta.url || url } },
  }
}

// ── Estrategias ──────────────────────────────────────────────────────────────

async function conWreq(url, headers, timeout, binario = false) {
  const modulo = await getWreq()
  if (!modulo) throw new Error('wreq-js no disponible')
  const respuesta = await modulo.fetch(url, {
    browser: PERFIL_WREQ,
    os: 'windows',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  if (!respuesta.ok) {
    const error = new Error(`wreq-js HTTP ${respuesta.status}`)
    error.status = respuesta.status
    throw error
  }
  return normalizar({
    data: binario ? Buffer.from(await respuesta.arrayBuffer()) : await respuesta.text(),
    status: respuesta.status,
    headers: Object.fromEntries(respuesta.headers),
    url: respuesta.url,
  }, url)
}

async function conImpit(url, headers, timeout, binario = false) {
  const cliente = await getImpit()
  if (!cliente) throw new Error('impit no disponible')
  const respuesta = await cliente.fetch(url, { headers, redirect: 'follow', timeout })
  if (!respuesta.ok) {
    const error = new Error(`impit HTTP ${respuesta.status}`)
    error.status = respuesta.status
    throw error
  }
  return normalizar({
    data: binario ? Buffer.from(await respuesta.arrayBuffer()) : await respuesta.text(),
    status: respuesta.status,
    headers: Object.fromEntries(respuesta.headers),
    url: respuesta.url,
  }, url)
}

async function conAxios(url, headers, timeout, binario = false) {
  return axios.get(url, {
    headers,
    timeout,
    responseType: binario ? 'arraybuffer' : 'text',
    dbsHttpsAgent,
    maxRedirects: 5,
    proxy: PROXY_URL ? new URL(PROXY_URL) : undefined,
    validateStatus: status => status >= 200 && status < 300,
  })
}

function conCurl(url, headers, timeout, binario = false) {
  return new Promise((resolve, reject) => {
    // Se lee en Buffers: concatenar como texto destrozaría una portada PNG.
    const args = ['-sSL', '--compressed', '--max-time', String(Math.ceil(timeout / 1000)), '-w', '\n%{http_code}']
    if (PROXY_URL) args.push('--proxy', PROXY_URL)
    for (const [clave, valor] of Object.entries(headers)) {
      if (valor) args.push('-H', `${clave}: ${valor}`)
    }
    const proceso = spawn('curl', [...args, url])
    const trozos = []
    let errores = ''
    proceso.stdout.on('data', trozo => trozos.push(trozo))
    proceso.stderr.on('data', trozo => { errores += trozo })
    proceso.on('error', reject)
    proceso.on('close', () => {
      let salida = Buffer.concat(trozos)
      // Los últimos bytes son "\n<status>"; se separan antes de interpretar el cuerpo.
      const corte = salida.lastIndexOf(0x0a)
      const status = Number.parseInt(salida.subarray(corte + 1).toString('utf8'), 10)
      salida = salida.subarray(0, corte)
      const cuerpo = binario ? salida : salida.toString('utf8')
      if (status >= 200 && status < 300) resolve({ data: cuerpo, status, headers: {} })
      else reject(Object.assign(new Error(errores.trim() || `curl HTTP ${status}`), { status: Number.isFinite(status) ? status : 0 }))
    })
  })
}

async function conFlareSolverr(url, _headers, timeout = DBS_HTTP_TIMEOUT, binario = false) {
  if (!FLARESOLVERR_URL) throw new Error('FlareSolverr no configurado')
  // Devuelve el HTML ya resuelto como texto; un PNG saldría corrupto.
  if (binario) throw new Error('FlareSolverr no se usa para imágenes')
  // Resolver un desafío de Cloudflare tarda bastante más que un GET normal:
  // se le da margen sobre el timeout del llamador, no el fijo del módulo.
  const respuesta = await axios.post(`${FLARESOLVERR_URL}/v1`, {
    cmd: 'request.get',
    url,
    maxTimeout: timeout * 3,
  }, { timeout: timeout * 4 })
  const solucion = respuesta.data?.solution
  if (respuesta.data?.status !== 'ok' || !solucion) {
    throw new Error(`FlareSolverr: ${respuesta.data?.message || 'sin solución'}`)
  }
  // El UA y las cookies del navegador resuelto se reutilizan en las siguientes
  // peticiones: sin ellas el desafío vuelve en el minuto siguiente.
  if (solucion.userAgent && !process.env.DBS_UA) uaSesion = String(solucion.userAgent).trim()
  if (Array.isArray(solucion.cookies) && solucion.cookies.length) {
    cookieSesion = solucion.cookies.map(c => `${c.name}=${c.value}`).join('; ')
  }
  return { data: solucion.response, status: Number(solucion.status) || 200, headers: {} }
}

// ── Orquestador ──────────────────────────────────────────────────────────────

/**
 * Orden de estrategias. Empieza por la última que funcionó; el resto solo se
 * prueba cuando esa falla. Un 403 recalibra la lista (el WAF pudo cambiar).
 */
let estrategiaActual = null

const ESTRATEGIAS = [
  { nombre: 'wreq', ejecutar: conWreq, huella: true },
  { nombre: 'impit', ejecutar: conImpit, huella: true },
  { nombre: 'axios', ejecutar: conAxios, huella: false },
  { nombre: 'curl', ejecutar: conCurl, huella: false },
  { nombre: 'flaresolverr', ejecutar: conFlareSolverr, huella: true },
]

function ordenar() {
  const disponibles = DBS_ESTRATEGIAS_FORZADAS.length
    ? ESTRATEGIAS.filter(estrategia => DBS_ESTRATEGIAS_FORZADAS.includes(estrategia.nombre))
    : ESTRATEGIAS
  if (!disponibles.length) return ESTRATEGIAS
  if (estrategiaActual == null) return disponibles
  const indice = disponibles.findIndex(estrategia => estrategia.nombre === estrategiaActual)
  if (indice <= 0) return disponibles
  return [disponibles[indice], ...disponibles.slice(0, indice), ...disponibles.slice(indice + 1)]
}

function esBloqueo(error) {
  return error?.status === 403 || error?.response?.status === 403
}

function esReintentable(error) {
  if (esBloqueo(error)) return false // el 403 lo resuelve cambiar de estrategia
  const status = error?.status || error?.response?.status
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500
  return true // red, DNS, timeout
}

/**
 * GET con escalado de clientes.
 * @param {string} url
 * @param {object} [opciones]
 * @param {object} [opciones.headers] cabeceras extra del llamador
 * @param {number} [opciones.timeout]
 * @param {boolean} [opciones.documento] `false` para assets: no finge navegación
 * @param {boolean} [opciones.binario] devuelve `Buffer` en vez de texto (portadas)
 * @param {number} [opciones.intentos]
 */
async function fetchDbs(
  url,
  { headers = {}, timeout = DBS_HTTP_TIMEOUT, documento = true, binario = false, intentos = 1 } = {},
) {
  const totales = Math.min(Math.max(1, intentos), DBS_CLIENTE_REINTENTOS)
  let ultimoError = null
  let huboBloqueo = false

  for (let intento = 1; intento <= totales; intento++) {
    if (intento > 1) await dbsSleep(1000 * intento)

    for (const estrategia of ordenar()) {
      try {
        const respuesta = await estrategia.ejecutar(url, cabeceras(headers, { documento }), timeout, binario)
        if (estrategiaActual !== estrategia.nombre) {
          estrategiaActual = estrategia.nombre
          console.log(`[dbs-notify] cliente activo: ${estrategia.nombre}`)
        }
        return respuesta
      } catch (error) {
        ultimoError = error
        if (esBloqueo(error)) {
          huboBloqueo = true
          estrategiaActual = null
        }
      }
    }

    // Todas las estrategias fallaron (incluida FlareSolverr si está disponible).
    if (huboBloqueo) break
    if (!esReintentable(ultimoError)) break
  }

  throw describirFallo(url, ultimoError, huboBloqueo)
}

function describirFallo(url, error, bloqueo) {
  const fallo = new Error(
    bloqueo
      ? `AnimeDBS bloqueó la petición (HTTP 403) en ${new URL(url).pathname}. `
        + 'El sitio exige una IP de residencia/país permitido o un desafío de Cloudflare: '
        + 'configura DBS_PROXY_URL (proxy HTTP/SOCKS) o DBS_FLARESOLVERR_URL, y opcionalmente DBS_COOKIE.'
      : `No se pudo consultar AnimeDBS en ${new URL(url).pathname}: ${error?.message || 'error desconocido'}`,
  )
  fallo.code = bloqueo ? 'DBS_FORBIDDEN' : 'DBS_FETCH_FAILED'
  fallo.cause = error
  return fallo
}

/** ¿El error significa que el sitio nos está bloqueando? */
function esErrorDeBloqueo(error) {
  return error?.code === 'DBS_FORBIDDEN' || esBloqueo(error)
}

// Se exportan para que tests/dbs-notify.test.js pueda probar el cliente sin
// otra copia del código. `main.js` registra `module.default || module`, así que
// estos named exports no cambian cómo se carga el plugin en el bot.
export { fetchDbs, esErrorDeBloqueo, DBS_HEADERS }


// ─── Estado global ────────────────────────────────────────────────────────────

global.dbsActiveChats  = global.dbsActiveChats  || new Map()
global.dbsEpisodeQueue = global.dbsEpisodeQueue || []
global.dbsQueueRunning = global.dbsQueueRunning || false
global.dbsConn         = global.dbsConn         || null
global.dbsQueuedIds    = global.dbsQueuedIds    || new Set()
global.dbsChecking     = global.dbsChecking     || false
global.dbsGlobalTimer  = global.dbsGlobalTimer  || null
global.dbsLastCheckAt  = global.dbsLastCheckAt  || 0
global.dbsQueueLastProgress = global.dbsQueueLastProgress || 0

/** Caché del sondeo, de fichas y de servidores de descarga. */
const feedCache     = new Map()
const serversCache  = new Map()
const serversInflight = new Map()
/** Archivo ya descargado por episodio, para no bajarlo dos veces (SUB + LAT). */
const jobResults = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function reportDbsError(conn, context, error) {
  const message = error instanceof Error ? error.message : String(error || 'Error desconocido')
  console.error(`[dbs-notify] ${context}: ${message}`)
  if (!conn?.sendMessage) return
  return conn.sendMessage(ERROR_OWNER_JID, {
    text: `🚨 *Error en DBS Notify*\n📍 *Contexto:* ${context}\n💬 *Mensaje:* ${message}`.slice(0, 4000),
  }).catch(() => {})
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

function readJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return value && typeof value === 'object' ? value : fallback
  } catch (error) {
    if (fs.existsSync(file)) console.error(`[dbs-notify] No se pudo leer ${file}: ${error.message}`)
    return fallback
  }
}

function writeJsonAtomic(file, data) {
  const tempFile = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2))
    fs.renameSync(tempFile, file)
    return true
  } catch (error) {
    try { fs.unlinkSync(tempFile) } catch (_) {}
    console.error(`[dbs-notify] No se pudo guardar ${file}: ${error.message}`)
    return false
  }
}

/**
 * Lee, muta y guarda en una sola operación.
 *
 * Antes cada helper hacía `loadSeen()`, mutaba el objeto y `saveSeen()`: dos
 * chats procesados en paralelo leían la misma copia y el segundo guardado
 * borraba lo marcado por el primero, así que el episodio se reenviaba al
 * reiniciar. Si `mutate` devuelve `false` no se escribe nada.
 */
function updateJson(file, mutate, fallback = {}) {
  const data = readJson(file, fallback)
  if (mutate(data) !== false) writeJsonAtomic(file, data)
  return data
}

const loadSeen  = () => readJson(SEEN_FILE)
const loadState = () => readJson(STATE_FILE)
const updateSeen  = mutate => updateJson(SEEN_FILE, mutate)
const updateState = mutate => updateJson(STATE_FILE, mutate)

function markSeen(chatId, ids) {
  const nuevos = [...new Set(ids)].filter(Boolean)
  if (!nuevos.length) return
  updateSeen(seen => {
    const actual = Array.isArray(seen[chatId]) ? seen[chatId] : []
    const faltan = nuevos.filter(id => !actual.includes(id))
    if (!faltan.length) return false
    seen[chatId] = [...actual, ...faltan].slice(-MAX_SEEN_POR_CHAT)
  })
}

function seedChatSeen(chatId, lista) {
  const ids = [...new Set(lista.flatMap(ep => ep.variantSeenIds || [ep.id]))]
  updateSeen(seen => {
    seen[chatId] = ids.slice(-MAX_SEEN_POR_CHAT)
  })
}

function getGlobalIntervalSec() {
  const configured = Number(loadState().__config?.intervalSec)
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS)
    : CHECK_INTERVAL_SECONDS
}

function setGlobalIntervalSec(intervalSec) {
  updateState(state => {
    state.__config = { ...(state.__config || {}), intervalSec }
  })
}

function getCentralChatId() {
  const configured = loadState().__config?.centralChatId
  return typeof configured === 'string' && configured ? configured : null
}

function setCentralChatId(chatId) {
  updateState(state => {
    state.__config = { ...(state.__config || {}), centralChatId: chatId }
  })
}

function clearCentralChatId() {
  updateState(state => {
    if (!state.__config) return false
    delete state.__config.centralChatId
    return true
  })
}

function bumpSentCount(chatId) {
  const state = updateState(saved => {
    const entry = saved[chatId] || (saved[chatId] = { intervalSec: getGlobalIntervalSec(), startedAt: Date.now(), sentCount: 0 })
    entry.sentCount = (Number(entry.sentCount) || 0) + 1
  })
  const count = Number(state[chatId]?.sentCount) || 0
  const active = global.dbsActiveChats.get(chatId)
  if (active) active.sentCount = count
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zeroPad(n) { return String(n).padStart(2, '0') }

function formatInterval(seconds) {
  const value = Number(seconds)
  if (Number.isInteger(value) && value % 60 === 0) return `${value / 60} min`
  return `${value} segundos`
}

function parseIntervalInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(',', '.')
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(s|seg|segs|segundo|segundos|m|min|mins|minuto|minutos)?$/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const seconds = /^m/i.test(match[2] || '') ? amount * 60 : amount
  return Number.isInteger(seconds) ? seconds : Math.round(seconds)
}

function formatActiveTime(startedAt) {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function safeFile(value) { return String(value || '').replace(/[\\/*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }

const ROMAN_SEASONS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }

function seasonValue(value) {
  const token = String(value || '').toUpperCase()
  return /^\d+$/.test(token) ? Number(token) : ROMAN_SEASONS[token] || 1
}

function getSeasonNumber(...values) {
  const text = values.filter(Boolean).join(' ')
  const token = '(\\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)'
  const patterns = [
    new RegExp(`${token}\\s*(?:st|nd|rd|th|ª|º)?\\s*(?:temporada|season|saison)`, 'i'),
    new RegExp(`(?:temporada|season|saison)\\s*[-_: ]?\\s*${token}`, 'i'),
    new RegExp(`\\b(?:S|T)\\s*${token}\\b`, 'i'),
    /\b(?:VIII|VII|VI|IX|IV|V|III|II|X)\b/i,
    /\b(?:first|second|third|fourth|fifth)\s+season\b/i,
  ]
  let match
  for (const pattern of patterns) {
    match = text.match(pattern)
    if (match) break
  }
  const wordSeasons = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }
  const season = match?.[1] ? seasonValue(match[1]) : wordSeasons[match?.[0]?.split(/\s+/)[0]?.toLowerCase()] || 1
  return season > 1 ? season : 1
}

function cleanTitle(titulo, epNum) {
  return String(titulo || '')
    .replace(new RegExp(`\\s*[-–—:]?\\s*${Number(epNum)}\\s*$`), '')
    .replace(/\s*(?:first|second|third|fourth|fifth)\s+season/ig, '')
    .replace(/\s*(?:(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)(?:st|nd|rd|th|ª|º)?\s*)?(?:temporada|season|saison)\s*[-_: ]*\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)?/ig, '')
    .replace(/\s*\b(?:S|T)\s*(?:\d+|VIII|VII|VI|IX|IV|V|III|II|X|I)\b/ig, '')
    .replace(/(^|[\s()[\]{}\-_:])(?:VIII|VII|VI|IX|IV|V|III|II|X)(?=$|[\s()[\]{}\-_:])/ig, '$1')
    .replace(/\s*(?:sub\s+)?español(?:\s+(?:latino|castellano))?\s*(?:🇲🇽|🇪🇸)?/ig, '')
    .replace(/\s*(?:latino|castellano)\s*(?:🇲🇽|🇪🇸)?/ig, '')
    .replace(/\s*\(\s*(?:720p|1080p)\s*\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePublishedAt(text) {
  const match = String(text || '').match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/)
  if (!match) return 0
  const timestamp = Date.parse(`${match[1].replace(' ', 'T')}-05:00`)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function episodeAgeSeconds(text) {
  const value = String(text || '').toLowerCase().trim()
  if (!value) return Number.POSITIVE_INFINITY
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*(segundo|minuto|hora|día|dia|semana|mes|year|año)/i)
  if (!match) return Number.POSITIVE_INFINITY
  const amount = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(amount)) return Number.POSITIVE_INFINITY
  const unit = match[2].toLowerCase()
  if (unit.startsWith('seg')) return amount
  if (unit.startsWith('min')) return amount * 60
  if (unit.startsWith('hora')) return amount * 3600
  if (unit.startsWith('día') || unit.startsWith('dia')) return amount * 86400
  if (unit.startsWith('sem')) return amount * 604800
  if (unit.startsWith('mes')) return amount * 2592000
  return amount * 31536000
}

function buildFileName(titulo, epNum, fuente = 'dbs', idioma = 'latino', slug = '') {
  const season = getSeasonNumber(titulo, slug)
  const seasonLabel = season > 1 ? `T${season} ` : ''
  const title = cleanTitle(titulo, epNum)
  const details = fuente === 'latino'
    ? 'Español Latino (720p)'
    : fuente === 'latanime'
      ? `Español ${idioma === 'castellano' ? 'Castellano 🇪🇸' : 'Latino 🇲🇽'} (1080p)`
      : 'Sub Español (720p)'
  return `${zeroPad(epNum)} ${seasonLabel}${safeFile(title)} ${details} [[𝗖𝗜𝗗]].mp4`
}

function build360FileName(fileName) {
  return fileName.replace(/\(\d{3,4}p\)/i, '(360p)')
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB'
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB'
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(2) + ' MB'
  return (bytes / 1024).toFixed(2) + ' KB'
}

function fmtSpeed(bytes, elapsedMs) {
  return `${fmtBytes(bytes / Math.max(elapsedMs, 1) * 1000)}/s`
}

function absoluteUrl(value, base) {
  // `new URL('', base)` devuelve la base: un <img> sin src acababa pasando la
  // portada del sitio como si fuera la carátula del anime, y el envío fallaba.
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try { return new URL(raw, base).href } catch (_) { return '' }
}

function normalizeTitleKey(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Fecha de publicación de la ficha de AnimeDBS: la fuente de verdad al ordenar. */
function publishedAtFromPage($) {
  return parsePublishedAt($('.year').first().text()) || parsePublishedAt($('.sosev').first().text())
}

// ─── Red ──────────────────────────────────────────────────────────────────────

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Error que puede resolverse reintentando (red, límite de peticiones, servidor
 * caído). Un 403 del WAF no: se resuelve cambiando de cliente o de IP, así que
 * el episodio se deja pendiente sin gastar tres intentos por ficha.
 */
function isRetryableScrapeError(error) {
  if (esErrorDeBloqueo(error)) return false
  const status = error?.response?.status || error?.status
  return !status || isRetryableStatus(status)
}

/** ¿El fallo es de red/bloqueo (el episodio sigue pendiente) o del propio enlace? */
function esFalloDeAcceso(error) {
  return esErrorDeBloqueo(error) || isRetryableScrapeError(error)
}

/**
 * Petición a AnimeDBS.
 *
 * Delega en `fetchDbs`, que prueba huella de Chrome (wreq/impit), axios, curl y
 * FlareSolverr hasta dar con uno que el WAF acepte. Antes esto era un `axios`
 * con cabeceras de Chrome: al bot le respondían 403 desde que el sitio empezó a
 * validar el handshake TLS, y el error llegaba al chat como "Request failed with
 * status code 403".
 */
async function getPage(url, options = {}, attempts = 3) {
  const respuesta = await fetchDbs(url, {
    headers: options.headers,
    timeout: options.timeout || HTTP_TIMEOUT,
    intentos: Math.min(attempts, 2),
  })
  return respuesta
}

function setBoundedCache(map, key, value, max) {
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
}

function detectarServidor(url, label = '') {
  let host = ''
  let pathname = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    pathname = parsed.pathname.toLowerCase()
  } catch (_) {}
  if (/(?:^|\.)mega\.(?:nz|co\.nz)$/.test(host)) return 'mega'
  if (/(?:^|\.)mediafire\.com$/.test(host)) return 'mediafire'
  const text = String(label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/\bmega\b/.test(text)) return 'mega'
  if (/media\s*fire/.test(text)) return 'mediafire'
  if (/\bdirect(?:o)?\b/.test(text) || /\.mp4$/i.test(pathname)) return 'directo'
  return ''
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

function createEpisodeCollector() {
  const lista = []
  const porId = new Map()

  /**
   * Cuando el título de la portada y el de la ficha de la serie no coinciden,
   * el slug cambia y aparecerían dos episodios para el mismo capítulo (y se
   * enviaría dos veces). `enrich` busca primero por URL + número + idioma y
   * solo crea un episodio nuevo si de verdad no existe.
   */
  const findByUrl = (epUrl, epNum, latino) =>
    lista.find(ep => ep.epUrl === epUrl && ep.epNum === epNum && (ep.idioma === 'latino') === latino)

  return {
    lista,
    add({ href, title, epNum, imgUrl = '', latino = false, ageSeconds = Number.POSITIVE_INFINITY, publishedAt = 0 }) {
      const epUrl = absoluteUrl(href, ANIMEDBS_URL)
      const number = Number.parseInt(epNum, 10)
      if (!epUrl || !Number.isInteger(number) || number < 0) return
      const titulo = String(title || '').replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').trim() || 'Anime desconocido'
      const slug = normalizeTitleKey(titulo).replace(/ /g, '-')
      const id = `dbs-${slug}-${number}`
      const idioma = latino ? 'latino' : 'sub'
      const existing = porId.get(id) || findByUrl(epUrl, number, latino)
      if (existing) {
        // SUB y LAT del mismo capítulo son un único episodio con dos variantes.
        if (!existing.idiomas.includes(idioma)) existing.idiomas.push(idioma)
        if (!existing.imgUrl && imgUrl) existing.imgUrl = imgUrl
        if (publishedAt > (existing.publishedAt || 0)) {
          Object.assign(existing, { epUrl, ageSeconds, publishedAt })
        } else if (Number.isFinite(ageSeconds) && ageSeconds < (existing.ageSeconds ?? Number.POSITIVE_INFINITY)) {
          existing.ageSeconds = ageSeconds
        }
        return
      }
      const ep = {
        id, slug, titulo, epNum: number, epUrl, imgUrl,
        fuente: latino ? 'latino' : 'animedbs', idioma,
        idiomas: [idioma],
        legacyIds: [`dbs-${slug}-${number}`, `dbs-lat-${slug}-${number}`],
        ageSeconds, publishedAt,
      }
      porId.set(id, ep)
      lista.push(ep)
    },
  }
}

function parseHomePage(html) {
  const collector = createEpisodeCollector()
  const $ = cheerio.load(html)
  $('.listupd .bs').each((_, el) => {
    const $el = $(el)
    const href = $el.find('a').first().attr('href') || ''
    if (!href) return
    const epUrl = absoluteUrl(href, ANIMEDBS_URL)
    const epxText = $el.find('.epx').text().trim()
    const epNum = epxText.match(/\d+/)?.[0] || epUrl.match(/episodio[- _]?(\d+)/i)?.[1]
    if (!epNum) return
    const anime = $el.find('.tite1').text().trim()
    const h2 = $el.find('h2').text().trim() || $el.find('.tt').text().trim()
    const titulo = anime || h2.replace(/episodio\s*\d+/i, '').replace(/sub español/i, '').replace(/hace\s+.*$/i, '').trim()
    const ageSeconds = episodeAgeSeconds($el.find('.sosev').text())
    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    const imgUrl = imgSrc.startsWith('data:') ? '' : absoluteUrl(imgSrc, ANIMEDBS_URL)
    const latino = /latino/i.test(`${href} ${titulo} ${$el.find('.lg').text()}`)
    collector.add({ href: epUrl, title: titulo, epNum, imgUrl, latino: false, ageSeconds })
    if (latino) collector.add({ href: epUrl, title: titulo, epNum, imgUrl, latino: true, ageSeconds })
  })
  return collector
}

function parseDirectoryPage(html) {
  const $ = cheerio.load(html)
  const series = []
  $('.listupd .bs').each((_, el) => {
    const $el = $(el)
    const href = $el.find('a[href]').first().attr('href') || ''
    if (!href) return
    const label = $el.text().replace(/\s+/g, ' ').trim()
    series.push({ href, label, title: $el.find('.tite1').text().trim() || $el.find('h2').text().trim() })
  })
  return series
}

/**
 * La portada muestra la fecha de modificación del post ("Hace 5 segundos"),
 * que no siempre coincide con la publicación del episodio. Para las series
 * recientes del directorio se consulta la ficha real del primer episodio.
 * Los fallos son best-effort: nunca marcan ni descartan episodios.
 */
async function enrichWithRealDates(collector, series) {
  const recientes = series.slice(0, DBS_DIRECTORY_LIMIT)
  const concurrency = 6
  for (let i = 0; i < recientes.length; i += concurrency) {
    await Promise.all(recientes.slice(i, i + concurrency).map(async item => {
      try {
        const seriesUrl = absoluteUrl(item.href, ANIMEDBS_URL)
        const { data: seriesHtml } = await getPage(seriesUrl, {
          headers: { ...DBS_HEADERS, Referer: DBS_DIRECTORY_URL },
          timeout: 8000,
          maxRedirects: 3,
        }, 1)
        const $series = cheerio.load(seriesHtml)
        const first = $series('.eplister a[href]').first()
        const episodeHref = first.attr('href') || ''
        if (!episodeHref) return
        const episodeUrl = absoluteUrl(episodeHref, seriesUrl)
        const epNum = first.text().match(/\d+/)?.[0] || episodeUrl.match(/episodio[- _]?(\d+)/i)?.[1]
        if (!epNum) return
        const { data: episodeHtml } = await getPage(episodeUrl, {
          headers: { ...DBS_HEADERS, Referer: seriesUrl },
          timeout: 8000,
          maxRedirects: 3,
        }, 1)
        const $episode = cheerio.load(episodeHtml)
        // Sin fecha en la ficha no se inventa: queda 0 y el orden cae al
        // "hace X" de la portada.
        const publishedAt = publishedAtFromPage($episode)
        const title = $series('h1').first().text().trim() || item.title
        const img = $series('.thumb img, .thumbook img').first()
        const rawImg = img.attr('data-src') || img.attr('src') || ''
        const imgUrl = rawImg.startsWith('data:') ? '' : absoluteUrl(rawImg, seriesUrl)
        const hasLat = /\b(?:lat|latino)\b/i.test(item.label)
        const hasSub = /\b(?:sub|subtitulado)\b/i.test(item.label)
        const variants = hasLat || hasSub ? { latino: hasLat, sub: hasSub } : { sub: true }
        if (variants.sub) collector.add({ href: episodeUrl, title, epNum, imgUrl, latino: false, publishedAt })
        if (variants.latino) collector.add({ href: episodeUrl, title, epNum, imgUrl, latino: true, publishedAt })
      } catch (_) {
        // sin fecha real: el episodio sigue entrando con la de la portada
      }
    }))
  }
}

function sortEpisodes(collector) {
  const gruposPorEpisodio = new Map()
  for (const ep of collector.lista) {
    const key = `${ep.epUrl}:${ep.epNum}`
    if (!gruposPorEpisodio.has(key)) gruposPorEpisodio.set(key, [])
    gruposPorEpisodio.get(key).push(ep)
  }
  const priorizados = [...gruposPorEpisodio.values()]
    .sort((a, b) => {
      const publishedA = Math.max(...a.map(ep => ep.publishedAt || 0))
      const publishedB = Math.max(...b.map(ep => ep.publishedAt || 0))
      if (publishedA && publishedB && publishedA !== publishedB) return publishedB - publishedA
      if (publishedA !== publishedB) return publishedA ? -1 : 1
      const ageA = Math.min(...a.map(ep => ep.ageSeconds ?? Number.POSITIVE_INFINITY))
      const ageB = Math.min(...b.map(ep => ep.ageSeconds ?? Number.POSITIVE_INFINITY))
      if (ageA !== ageB) return ageA - ageB
      return Math.max(...b.map(ep => ep.epNum)) - Math.max(...a.map(ep => ep.epNum))
    })
    .flatMap(grupo => grupo.sort((a, b) => (a.idioma === 'latino' ? 0 : 1) - (b.idioma === 'latino' ? 0 : 1)))
  collector.lista.splice(0, collector.lista.length, ...priorizados)
}

async function fetchLatestEpisodesDBS({ force = false } = {}) {
  const cached = feedCache.get('episodios')
  if (!force && cached && Date.now() - cached.at < FEED_CACHE_MS) return cached.lista

  const { data } = await getPage(ANIMEDBS_URL, { headers: DBS_HEADERS })
  const collector = parseHomePage(data)

  // El directorio ordenado por actualización da la fecha real de publicación.
  // Si falla, se sigue con la portada: nunca se pierde el sondeo entero.
  try {
    const { data: directoryHtml } = await getPage(DBS_DIRECTORY_URL, { headers: DBS_HEADERS })
    await enrichWithRealDates(collector, parseDirectoryPage(directoryHtml))
  } catch (error) {
    console.error(`[dbs-notify] Directorio de AnimeDBS no disponible: ${error.message}`)
  }

  sortEpisodes(collector)
  setBoundedCache(feedCache, 'episodios', { lista: collector.lista, at: Date.now() }, FEED_CACHE_MAX)
  console.log(`[dbs-notify] ${collector.lista.length} episodios recientes detectados desde la portada general (SUB + LAT)`)
  return collector.lista
}

/** Lee una ficha de AnimeDBS y devuelve sus enlaces descargables. */
async function scrapeServidoresDBS(epUrl, idioma = 'sub') {
  const { data } = await getPage(epUrl, { headers: { ...DBS_HEADERS, Referer: ANIMEDBS_URL } })
  const $ = cheerio.load(data)
  const srvs = []
  const idiomaObjetivo = /lat/i.test(idioma) ? 'latino' : 'sub'
  const idiomaPagina = $('.ts-language-label').text().replace(/\s+/g, ' ').trim()
  const paginaTieneLat = /\bLAT\b/i.test(idiomaPagina)
  const paginaTieneSub = /\bSUB\b/i.test(idiomaPagina)
  const bloquesIdioma = $('.soraddlx').toArray()
  const idiomaBloque = el => {
    const $block = $(el)
    const heading = $block.find('.sorattlx h3').text().trim()
    const hrefs = $block.find('a[href]').map((_, a) => $(a).attr('href') || '').get().join(' ')
    if (/latino/i.test(heading) || (/latino/i.test(hrefs) && !/subtitulado|sub\+espa/i.test(hrefs))) return 'latino'
    if (/sub(?:titulado| español)?/i.test(heading) || /subtitulado|sub\+espa/i.test(hrefs)) return 'sub'
    if (paginaTieneLat !== paginaTieneSub) return paginaTieneLat ? 'latino' : 'sub'
    if (paginaTieneLat && paginaTieneSub) return ''
    if (/-latino(?:\/|$)/i.test(epUrl)) return 'latino'
    return idiomaObjetivo
  }
  const bloqueCoincide = el => idiomaBloque(el) === idiomaObjetivo
  const gruposDescarga = $('.episode-download-group').toArray()
  const idiomaGrupoDescarga = el => {
    const heading = $(el).find('h3').first().text().trim()
    if (/latino/i.test(heading)) return 'latino'
    if (paginaTieneLat && !paginaTieneSub) return 'latino'
    // En AnimeDBS el bloque SUB suele llamarse simplemente "Descargar MP4".
    return 'sub'
  }
  const calidadDesde = (...values) => {
    const text = values.filter(Boolean).join(' ')
    return /1080\s*p?/i.test(text) ? '1080p' : /720\s*p?/i.test(text) ? '720p' : ''
  }
  const add = (value, label = '', calidad = '', allowDirect = false) => {
    if (!value || typeof value !== 'string') return
    const raw = value.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/')
    let url = absoluteUrl(raw, epUrl)
    if (!url) {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8').trim()
        if (/^https?:\/\//i.test(decoded)) url = absoluteUrl(decoded, epUrl)
      } catch (_) {}
    }
    if (!url || !/^https?:\/\//i.test(url) || srvs.some(s => s.url === url)) return
    let parsed
    try { parsed = new URL(url) } catch (_) { return }
    if (parsed.username || parsed.password) return
    if (/(?:^|\.)(?:terabox\.com|teraboxapp\.com|1024terabox\.com|terabox\.app|teraboxshare\.com|teraboxlink\.com)$/i.test(parsed.hostname)) return
    const siteHost = new URL(ANIMEDBS_URL).hostname.toLowerCase()
    if ((parsed.hostname.toLowerCase() === siteHost || parsed.hostname.toLowerCase().endsWith(`.${siteHost}`)) && !/\.mp4(?:$|[?#])/i.test(url)) return
    const nombre = detectarServidor(url, label) || (allowDirect && /\.mp4(?:$|[?#])/i.test(url) ? 'directo' : '')
    if (!nombre || !DBS_SERVIDORES.has(nombre)) return
    srvs.push({ nombre, url, calidad: calidadDesde(calidad, label, parsed.pathname) || '720p', directo: true })
  }
  $('.soraddlx').each((_, serverBlock) => {
    if (!bloqueCoincide(serverBlock)) return
    const $block = $(serverBlock)
    $block.find('.soraurlx').each((__, urlBlk) => {
      const $qualityBlock = $(urlBlk)
      const quality = calidadDesde($qualityBlock.find('strong').text(), $qualityBlock.text())
      $qualityBlock.find('a[href]').each((___, el) => add($(el).attr('href') || '', $(el).text().trim(), quality))
    })
  })
  // Diseño actual de AnimeDBS: una sola ficha contiene grupos separados
  // como "Descargar MP4" y "Descargar MP4 Latino".
  $('.episode-download-group').each((_, group) => {
    if (idiomaGrupoDescarga(group) !== idiomaObjetivo) return
    const $group = $(group)
    const quality = calidadDesde($group.find('.download-quality').text(), $group.text())
    $group.find('.download-hosts a[href]').each((__, el) => add($(el).attr('href') || '', $(el).text().trim(), quality))
  })
  // El sitio puede omitir las clases del bloque; aun así sólo se aceptan los tres tipos esperados.
  $('a[href]').each((_, el) => {
    const $el = $(el)
    const $languageBlock = $el.closest('.soraddlx')
    const $downloadGroup = $el.closest('.episode-download-group')
    if ((bloquesIdioma.length || gruposDescarga.length) && !$languageBlock.length && !$downloadGroup.length) return
    if ($languageBlock.length && !bloqueCoincide($languageBlock[0])) return
    if ($downloadGroup.length && idiomaGrupoDescarga($downloadGroup[0]) !== idiomaObjetivo) return
    const label = `${$el.text().trim()} ${$el.attr('title') || ''}`
    const context = $el.closest('.soraddlx, .soraurlx, .episode-download-group, .download, .downloads, .links').text()
    add($el.attr('href') || '', label, calidadDesde(context, label))
  })
  if (!gruposDescarga.length) {
    $('[data-src], [data-player], [data-url], iframe[src]').each((_, el) => {
      const $el = $(el)
      const raw = $el.attr('data-src') || $el.attr('data-player') || $el.attr('data-url') || $el.attr('src') || ''
      const context = $el.closest('.soraddlx, .soraurlx, .download, .downloads, .links').text()
      add(raw, `${$el.attr('title') || ''} ${context}`, calidadDesde(context), true)
    })
  }
  srvs.sort((a, b) => {
    if (a.directo !== b.directo) return a.directo ? -1 : 1
    const rank = value => /720/i.test(value) ? 0 : /1080/i.test(value) ? 1 : 2
    return rank(a.calidad) - rank(b.calidad)
  })
  return { servidores: srvs }
}

/** Listado de servidores con caché corta: SUB y LAT de la misma ficha comparten petición. */
async function obtenerServidores(epUrl, idioma) {
  const key = `${epUrl}|${idioma}`
  const cached = serversCache.get(key)
  if (cached && Date.now() - cached.at < SERVERS_CACHE_MS) return cached.servidores
  if (serversInflight.has(key)) return serversInflight.get(key)
  const promise = (async () => {
    const { servidores } = await scrapeServidoresDBS(epUrl, idioma)
    setBoundedCache(serversCache, key, { servidores, at: Date.now() }, SERVERS_CACHE_MAX)
    return servidores
  })().finally(() => serversInflight.delete(key))
  serversInflight.set(key, promise)
  return promise
}

/**
 * Elige un episodio por grupo (ficha + capítulo).
 *
 * Regla clave: un episodio solo se descarta cuando la ficha se leyó bien y de
 * verdad no hay enlaces para ese idioma. Si la petición falló (timeout, 429,
 * 5xx), queda pendiente y se reintenta en el próximo sondeo. Antes se marcaba
 * como visto y se perdía para siempre.
 */
async function seleccionarVersionPreferidaDBS(lista, {
  seen = null,
  chatId = '',
  skipQueued = false,
  limit = Infinity,
  visibles = [],
  fallidos = [],
} = {}) {
  const grupos = new Map()
  for (const ep of lista) {
    const key = `${ep.epUrl}:${ep.epNum}`
    if (!grupos.has(key)) grupos.set(key, [])
    grupos.get(key).push(ep)
  }
  const seleccionados = []
  for (const grupo of grupos.values()) {
    const estaVisto = ep => [ep.id, ...(ep.legacyIds || [])].some(id => seen?.includes(id))
    const estaEnCola = ep => [ep.id, ...(ep.legacyIds || [])].some(id => global.dbsQueuedIds.has(`${chatId}:${id}`))
    const candidatos = grupo.filter(ep => !estaVisto(ep) && !(skipQueued && estaEnCola(ep)) && !visibles.includes(ep.id))
    if (!candidatos.length) continue
    const ordenados = candidatos
      .map((ep, index) => ({ ep, index }))
      .sort((a, b) => {
        const publishedA = a.ep.publishedAt || 0
        const publishedB = b.ep.publishedAt || 0
        if (publishedA && publishedB && publishedA !== publishedB) return publishedB - publishedA
        if (publishedA !== publishedB) return publishedA ? -1 : 1
        const ageA = a.ep.ageSeconds ?? Number.POSITIVE_INFINITY
        const ageB = b.ep.ageSeconds ?? Number.POSITIVE_INFINITY
        if (ageA !== ageB) return ageA - ageB
        return a.index - b.index
      })

    let resuelto = false
    let falloRed = false
    for (const { ep } of ordenados) {
      // Latino primero: es la variante que el sitio destaca y la que antes se
      // elegía (la lista llegaba ordenada con LAT delante).
      const idiomas = [...new Set(ep.idiomas?.length ? ep.idiomas : [ep.idioma || 'sub'])]
        .sort((a, b) => (a === 'latino' ? 0 : 1) - (b === 'latino' ? 0 : 1))
      for (const idioma of idiomas) {
        try {
          const servidores = await obtenerServidores(ep.epUrl, idioma)
          if (!servidores.length) continue
          seleccionados.push({
            ...ep,
            idioma,
            fuente: idioma === 'latino' ? 'latino' : 'animedbs',
            servidores,
            // SUB y LAT son versiones del mismo capítulo y comparten un visto.
            variantSeenIds: [ep.id, ...(ep.legacyIds || [])],
          })
          resuelto = true
          break
        } catch (error) {
          // Un 403 del WAF deja el episodio pendiente en vez de marcarlo visto:
          // cuando se configure el proxy o la cookie, se enviará.
          if (esFalloDeAcceso(error)) falloRed = true
        }
      }
      if (resuelto) break
    }
    if (!resuelto) {
      if (falloRed) fallidos.push(grupo[0].id)
      else visibles.push(...grupo.map(ep => ep.id))
    }
    if (seleccionados.length >= limit) break
  }
  return seleccionados
}

// ─── Descarga ─────────────────────────────────────────────────────────────────

const PREFS_DBS = ['directo', 'mediafire', 'mega']

function ordenarServidores(srvs) {
  return [...srvs].sort((a, b) => {
    const ia = PREFS_DBS.indexOf(a.nombre)
    const ib = PREFS_DBS.indexOf(b.nombre)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
}

/**
 * Métrica mínima para decidir por dónde empezar: si Mega falla tres veces
 * seguidas, el siguiente episodio prueba MediaFire primero. Es solo una pista
 * en memoria, no se guarda en disco.
 */
const serverStats = new Map()

function serverPenalty(nombre) {
  return serverStats.get(nombre)?.penalty || 0
}

function recordServerResult(nombre, ok) {
  if (!nombre) return
  const stats = serverStats.get(nombre) || { fails: 0, penalty: 0 }
  stats.fails = ok ? 0 : stats.fails + 1
  stats.penalty = Math.min(stats.fails, 3)
  serverStats.set(nombre, stats)
}

function ordenarServidoresConAprendizaje(srvs) {
  return ordenarServidores(srvs)
    .map((srv, index) => ({ srv, index }))
    .sort((a, b) => (serverPenalty(a.srv.nombre) - serverPenalty(b.srv.nombre)) || (a.index - b.index))
    .map(entry => entry.srv)
}

function normalizarMegaUrl(value) {
  const raw = String(value || '').trim()
  if (!/^https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz)\//i.test(raw)) {
    throw new Error('Mega: dominio o URL no válidos')
  }
  if (/\/folder\//i.test(raw) || /#F!/i.test(raw)) {
    throw new Error('Mega: los enlaces de carpetas no están soportados')
  }
  const match = raw.match(/\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/(?:file|embed)\/([A-Za-z0-9_-]{8,})[#!]([A-Za-z0-9_-]{20,})/i) ||
    raw.match(/#!?([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{20,})/i)
  if (!match) throw new Error('Mega: enlace sin ID o clave de archivo')
  return `https://mega.nz/file/${match[1]}#${match[2]}`
}

async function descargarMega(megaUrl, outputDir, fileName, { onProgress } = {}) {
  const url = normalizarMegaUrl(megaUrl)
  const destPath = path.join(outputDir, fileName)
  const partPath = `${destPath}.part`
  const maxIntentos = 2
  let ultimoError

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      try { fs.rmSync(partPath, { force: true }) } catch (_) {}

      const file = MegaFile.fromURL(url)
      await file.loadAttributes()
      const total = Number(file.size || 0)
      const fileStream = file.download({
        maxConnections: MEGA_MAX_CONNECTIONS,
        initialChunkSize: MEGA_CHUNK_SIZE,
        chunkSizeIncrement: 0,
        maxChunkSize: MEGA_CHUNK_SIZE,
        forceHttps: true,
      })
      let done = 0
      const start = Date.now()
      let lastLog = 0
      const tracker = new Transform({
        transform(chunk, _enc, cb) {
          done += chunk.length
          const now = Date.now()
          if (now - lastLog > 1000) {
            lastLog = now
            const pct = total > 0 ? (done / total) * 100 : 0
            process.stdout.write(`\r[MEGA] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtSpeed(done, now - start)} | intento ${intento}/${maxIntentos}   `)
            if (typeof onProgress === 'function') onProgress(done, total)
          }
          cb(null, chunk)
        },
      })

      await pipeline(fileStream, tracker, fs.createWriteStream(partPath))
      const downloadedSize = fs.statSync(partPath).size
      if (total > 0 && downloadedSize !== total) {
        throw new Error(`Mega: tamaño incompleto (${downloadedSize} de ${total} bytes)`)
      }
      fs.renameSync(partPath, destPath)
      process.stdout.write('\n')
      return destPath
    } catch (error) {
      ultimoError = error
      process.stdout.write('\n')
      try { fs.rmSync(partPath, { force: true }) } catch (_) {}
      if (intento < maxIntentos) {
        console.log(`[dbs-notify] ⚠️ Mega falló; reintentando (${intento}/${maxIntentos}): ${error.message}`)
        await sleep(3000)
      }
    }
  }

  throw new Error(`Mega error: ${ultimoError?.message || 'descarga fallida'}`)
}

async function descargarMediaFire(mfUrl, outputDir, fileName, { onProgress } = {}) {
  let mfPage
  try {
    const res = await axios.get(mfUrl, { headers: DBS_HEADERS, httpsAgent, timeout: HTTP_TIMEOUT })
    mfPage = String(res.data || '')
  } catch (error) { throw new Error(`MediaFire: ${error.message}`) }

  const mfLink = mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
                 mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1] ||
                 mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]
  if (!mfLink) throw new Error('MediaFire: sin link directo')

  let downloadUrl
  try { downloadUrl = new URL(mfLink.replace(/&amp;/g, '&')).href } catch (_) { throw new Error('MediaFire: link directo no válido') }

  const destPath = path.join(outputDir, fileName)

  // Averiguar tamaño y soporte de rangos con un HEAD.
  let total = 0
  let soportaRangos = false
  try {
    const head = await axios.head(downloadUrl, { headers: DBS_HEADERS, httpsAgent, timeout: 10_000 })
    total = parseInt(head.headers['content-length'] || '0', 10) || 0
    soportaRangos = /bytes/i.test(head.headers['accept-ranges'] || '')
  } catch (_) {}

  let done = 0
  const start = Date.now()
  let lastLog = 0
  const reportar = bytes => {
    done += bytes
    const now = Date.now()
    if (now - lastLog > 1000) {
      lastLog = now
      const pct = total > 0 ? (done / total) * 100 : 0
      process.stdout.write(`\r[MEDIAFIRE] 📥 ${pct.toFixed(1)}% | ${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''} | ${fmtSpeed(done, now - start)}   `)
      if (typeof onProgress === 'function') onProgress(done, total)
    }
  }

  // ── Descarga paralela por rangos (si el servidor lo permite) ────────────────
  if (soportaRangos && total >= MF_MIN_SIZE_PARALELO) {
    const hilos = MF_HILOS
    const chunkSize = Math.ceil(total / hilos)
    const partes = []
    for (let i = 0; i < hilos; i++) {
      const bStart = i * chunkSize
      const bEnd = Math.min(bStart + chunkSize - 1, total - 1)
      if (bStart > bEnd) break
      partes.push({ start: bStart, end: bEnd, path: `${destPath}.part${i}` })
    }

    try {
      await Promise.all(partes.map(async p => {
        const res = await axios.get(downloadUrl, {
          responseType: 'stream',
          headers: { ...DBS_HEADERS, Referer: 'https://www.mediafire.com/', Range: `bytes=${p.start}-${p.end}` },
          httpsAgent,
          timeout: DL_TIMEOUT,
        })
        if (res.status !== 206) throw new Error(`MediaFire ignoró el rango solicitado (HTTP ${res.status})`)
        const contentRange = res.headers['content-range'] || ''
        if (!contentRange.startsWith(`bytes ${p.start}-${p.end}/`)) {
          throw new Error(`MediaFire devolvió un rango inesperado: ${contentRange || 'sin Content-Range'}`)
        }
        const tracker = new Transform({ transform(chunk, _enc, cb) { reportar(chunk.length); cb(null, chunk) } })
        await pipeline(res.data, tracker, fs.createWriteStream(p.path))
      }))

      const out = fs.createWriteStream(destPath)
      for (const p of partes) {
        const expected = p.end - p.start + 1
        if (fs.statSync(p.path).size !== expected) throw new Error(`Parte incompleta: ${path.basename(p.path)}`)
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(p.path)
          rs.on('error', reject)
          rs.on('end', resolve)
          rs.pipe(out, { end: false })
        })
      }
      await new Promise((resolve, reject) => {
        out.on('error', reject)
        out.end(resolve)
      })
      for (const p of partes) { try { fs.unlinkSync(p.path) } catch (_) {} }

      process.stdout.write('\n')
      console.log(`[dbs-notify] ⚡ MediaFire descargado en ${partes.length} hilos paralelos`)
      return destPath
    } catch (error) {
      process.stdout.write('\n')
      for (const p of partes) { try { fs.unlinkSync(p.path) } catch (_) {} }
      try { fs.rmSync(destPath, { force: true }) } catch (_) {}
      console.log(`[dbs-notify] ⚠️ Descarga paralela falló (${error.message}), reintentando en modo simple...`)
      done = 0
      lastLog = 0
      // sigue abajo al modo de un solo stream
    }
  }

  // ── Descarga simple (fallback o cuando no hay soporte de rangos) ────────────
  let mfRes
  try {
    mfRes = await axios.get(downloadUrl, {
      responseType: 'stream',
      headers: { ...DBS_HEADERS, Referer: 'https://www.mediafire.com/' },
      httpsAgent,
      timeout: DL_TIMEOUT,
    })
  } catch (error) { throw new Error(`MediaFire: ${error.message}`) }

  if (!total) total = parseInt(mfRes.headers['content-length'] || '0', 10) || 0

  const tracker = new Transform({
    transform(chunk, _enc, cb) { reportar(chunk.length); cb(null, chunk) },
  })

  try {
    await pipeline(mfRes.data, tracker, fs.createWriteStream(destPath))
    process.stdout.write('\n')
  } catch (error) {
    process.stdout.write('\n')
    try { fs.rmSync(destPath, { force: true }) } catch (_) {}
    throw new Error(`MediaFire: ${error.message}`)
  }
  return destPath
}

async function descargarUrlServidor(directUrl, serverUrl, outputDir, fileName) {
  if (!directUrl) throw new Error('no se encontró un enlace de vídeo')
  let parsed
  try { parsed = new URL(directUrl) } catch (_) { throw new Error('URL directa no válida') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('protocolo o credenciales de URL no permitidos')
  }
  const destPath = path.join(outputDir, fileName)
  const partPath = `${destPath}.part`
  try {
    const res = await axios.get(parsed.href, {
      responseType: 'stream',
      headers: { ...DBS_HEADERS, Referer: serverUrl },
      httpsAgent,
      timeout: DL_TIMEOUT,
      maxRedirects: 8,
      validateStatus: status => status >= 200 && status < 300,
    })
    const contentType = String(res.headers['content-type'] || '').toLowerCase()
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      res.data.destroy()
      throw new Error('el enlace no devolvió un vídeo')
    }
    await pipeline(res.data, fs.createWriteStream(partPath))
    const size = fs.statSync(partPath).size
    if (!size) throw new Error('archivo vacío')
    fs.renameSync(partPath, destPath)
    return destPath
  } catch (error) {
    try { fs.rmSync(partPath, { force: true }) } catch (_) {}
    throw error
  }
}

async function descargarServidorVideo(serverUrl, outputDir, fileName) {
  const extraerCandidatos = html => {
    const encontrados = []
    const patrones = [
      /https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/gi,
      /(?:file|src|source|url|video_url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
    ]
    for (const patron of patrones) {
      for (const match of html.matchAll(patron)) {
        const raw = match[1] || match[0]
        const url = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&')
        if (url.startsWith('http') && !encontrados.includes(url)) encontrados.push(url)
      }
    }
    return encontrados
  }

  let directUrl = /\.mp4(?:[?#]|$)/i.test(serverUrl) ? serverUrl : ''
  if (!directUrl) {
    const page = await axios.get(serverUrl, {
      headers: { ...DBS_HEADERS, Referer: serverUrl },
      httpsAgent,
      timeout: HTTP_TIMEOUT,
      maxRedirects: 5,
      responseType: 'text',
    })
    directUrl = extraerCandidatos(String(page.data || ''))[0] || ''
  }
  if (!directUrl) throw new Error('no se encontró un enlace MP4 directo')
  return descargarUrlServidor(directUrl, serverUrl, outputDir, fileName)
}

/** Descarga desde el servidor que corresponda. */
async function descargarDesdeServidor(srv, outputDir, fileName, options = {}) {
  const nombre = String(srv.nombre || '').toLowerCase()
  if (nombre === 'mega') return descargarMega(srv.url, outputDir, fileName, options)
  if (nombre === 'mediafire') return descargarMediaFire(srv.url, outputDir, fileName, options)
  return descargarServidorVideo(srv.url, outputDir, fileName)
}

// ─── Envío ────────────────────────────────────────────────────────────────────

/** Carpeta de trabajo estable por episodio: permite reutilizarla entre variantes. */
function episodeWorkDir(ep) {
  fs.mkdirSync(TEMP_VIDEOS_DIR, { recursive: true })
  const dir = path.join(TEMP_VIDEOS_DIR, `dbs_${safeFile(ep.id).slice(0, 60)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupEpisodeDir(ep) {
  jobResults.delete(ep.id)
  try { fs.rmSync(path.join(TEMP_VIDEOS_DIR, `dbs_${safeFile(ep.id).slice(0, 60)}`), { recursive: true, force: true }) } catch (_) {}
}

/** Restos de un cierre inesperado: nada de `dbs_*` se reutiliza tras 6 horas. */
function limpiarTempViejos() {
  try {
    if (!fs.existsSync(TEMP_VIDEOS_DIR)) return
    for (const entry of fs.readdirSync(TEMP_VIDEOS_DIR)) {
      if (!entry.startsWith('dbs_')) continue
      const full = path.join(TEMP_VIDEOS_DIR, entry)
      try {
        if (Date.now() - fs.statSync(full).mtimeMs < STALE_TEMP_MS) continue
        fs.rmSync(full, { recursive: true, force: true })
      } catch (_) {}
    }
  } catch (_) {}
}

async function reenviarDesdeCentral(conn, centralMessage, recipient, fallbackMessage) {
  if (typeof conn.copyNForward === 'function' && centralMessage) {
    return conn.copyNForward(recipient, centralMessage, true)
  }
  return conn.sendMessage(recipient, fallbackMessage)
}

async function resolverImagenEpisodio(ep) {
  if (ep.imgUrl) return ep.imgUrl
  try {
    const { data } = await getPage(ep.epUrl, {
      headers: { ...DBS_HEADERS, Referer: ANIMEDBS_URL },
      timeout: 10_000,
    })
    const $ = cheerio.load(data)
    const candidates = [
      $('.thumb img, .thumbook img, .ts-post-image img, .poster img').first(),
      $('meta[property="og:image"]').first(),
      $('img[src]').first(),
    ]
    for (const element of candidates) {
      const raw = element.attr('data-src') || element.attr('data-lazy-src') || element.attr('content') || element.attr('src') || ''
      const image = absoluteUrl(raw, ep.epUrl)
      if (image) {
        ep.imgUrl = image
        return image
      }
    }
  } catch (error) {
    console.log(`[dbs-notify] No se pudo obtener la imagen de vista previa: ${error.message}`)
  }
  return ''
}

async function resolverImagenAniList(ep) {
  const candidates = [ep.titulo, String(ep.slug || '').replace(/[-_]+/g, ' ')]
    .map(value => String(value || '').trim())
    .filter(Boolean)
  const query = `query ($search: String!) {
    Page(perPage: 3) {
      media(search: $search, type: ANIME) {
        coverImage { extraLarge large medium }
      }
    }
  }`
  for (const search of [...new Set(candidates)]) {
    try {
      const response = await axios.post(ANILIST_URL, {
        query,
        variables: { search },
      }, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 10_000,
      })
      const media = response.data?.data?.Page?.media || []
      const image = media[0]?.coverImage?.extraLarge
        || media[0]?.coverImage?.large
        || media[0]?.coverImage?.medium
      if (image) return image
    } catch (error) {
      console.log(`[dbs-notify] AniList no disponible para "${search}": ${error.message}`)
    }
  }
  return ''
}

/**
 * Envía un episodio a todos los destinatarios.
 *
 * `jobResults` evita el caso SUB + LAT de la misma ficha: el segundo idioma
 * reutiliza el archivo ya descargado en vez de bajar cientos de MB otra vez.
 */
async function enviarEpisodio(chatId, ep, conn, { preview = false } = {}) {
  const { titulo, epNum, epUrl } = ep
  const recipients = [...new Set((Array.isArray(chatId) ? chatId : [chatId]).filter(Boolean))]
  if (!recipients.length) throw new Error('No hay chats receptores configurados')
  const centralChatId = getCentralChatId()
  const central = centralChatId && recipients.includes(centralChatId) ? centralChatId : null
  if (!central) throw new Error('El grupo central no está activo; usa dbsstart en el grupo central antes de continuar.')
  const otherRecipients = recipients.filter(recipient => recipient !== central)
  const esLatino = ep.fuente === 'latino' || ep.idioma === 'latino'
  const fileName = buildFileName(titulo, epNum, esLatino ? 'latino' : 'dbs', ep.idioma, ep.slug)

  const srvs = Array.isArray(ep.servidores)
    ? ep.servidores
    : (await scrapeServidoresDBS(epUrl, esLatino ? 'latino' : 'sub')).servidores
  if (!srvs.length) {
    console.log(`[dbs-notify] Sin servidores para "${titulo}" ep ${epNum}; se omite sin enviar mensajes.`)
    return false
  }

  // La carpeta es estable por episodio: si el envío falla a mitad, el
  // reintento reutiliza lo ya descargado y `releaseEpisodeDirIfIdle` la borra
  // cuando el episodio sale del todo de la cola.
  const tmpDir = episodeWorkDir(ep)
  if (preview) {
    const previewImage = await resolverImagenAniList(ep) || await resolverImagenEpisodio(ep)
    if (previewImage) {
      const previewMessage = await conn.sendMessage(central, {
        image: { url: previewImage },
      })
      for (const recipient of otherRecipients) {
        await reenviarDesdeCentral(conn, previewMessage, recipient, {
          image: { url: previewImage },
        })
      }
    }
  }
  // 1) Descarga (reutilizada si otra variante del mismo capítulo ya la hizo).
  const previous = jobResults.get(ep.id)
  let videoPath = previous?.path && fs.existsSync(previous.path) ? previous.path : null
  let downloadedFileName = previous?.fileName || fileName
  const reused = Boolean(videoPath)
  if (!videoPath) {
    for (const srv of ordenarServidoresConAprendizaje(srvs).slice(0, 10)) {
      const nombre = String(srv.nombre || 'servidor').toLowerCase()
      const serverFileName = fileName.replace(/\(\d{3,4}p\)/i, `(${srv.calidad || '720p'})`)
      try {
        console.log(`[dbs-notify] 🔄 Conectando con [ ${nombre.toUpperCase()} ]...`)
        const descargado = await descargarDesdeServidor(srv, tmpDir, serverFileName)
        const size = descargado ? fs.statSync(descargado).size : 0
        if (!descargado || size < MIN_EPISODE_SIZE_BYTES) {
          console.log(`[dbs-notify] ⚠️ Archivo insuficiente (${fmtBytes(size)}); probando otro servidor.`)
          if (descargado) { try { fs.rmSync(descargado, { force: true }) } catch (_) {} }
          recordServerResult(nombre, false)
          continue
        }
        videoPath = descargado
        downloadedFileName = serverFileName
        recordServerResult(nombre, true)
        break
      } catch (error) {
        recordServerResult(nombre, false)
        console.log(`[dbs-notify] ⚠️ [ ${nombre} ] falló: ${error.message}`)
      }
    }
  }
  if (!videoPath) {
    // Nada que reutilizar: no se deja una carpeta vacía colgando.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    throw new Error('Todos los servidores fallaron')
  }

  // Se registra antes de subir: si WhatsApp corta la conexión y la cola
  // reintenta, el archivo descargado se reutiliza en vez de bajarse otra vez.
  jobResults.set(ep.id, { path: videoPath, fileName: downloadedFileName })

  // 2) Envío del original desde disco. Pasar una ruta local hace que Baileys
  //    abra el archivo con createReadStream: no se duplica en memoria.
  const sizeTexto = fmtBytes(fs.statSync(videoPath).size)
  let jpegThumbnail
  try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(videoPath) } catch (_) {}
  const originalMessage = await conn.sendMessage(central, {
      document: { url: videoPath },
      fileName: downloadedFileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
  })
  for (const recipient of otherRecipients) {
    await reenviarDesdeCentral(conn, originalMessage, recipient, {
      document: { url: videoPath },
      fileName: downloadedFileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
    })
  }
  console.log(`[dbs-notify] 🚀 Enviado al central y reenviado a ${otherRecipients.length} chat(s): ${downloadedFileName} (${sizeTexto})${reused ? ' (archivo reutilizado)' : ''}`)

  // 3) Versión 360p. Se borra en cuanto se envía para no dejar dos veces el
  //    episodio en disco mientras la cola sigue con el siguiente.
  const fileName360 = build360FileName(downloadedFileName)
  const video360Path = path.join(tmpDir, fileName360)
  try {
    await compressDw4(videoPath, video360Path, { label: 'DW4 AnimeDBS' })
    const jpegThumbnail360 = await jpegThumbnailLibrary.createJpegThumbnail(video360Path)
    const reducedMessage = await conn.sendMessage(central, {
        document: { url: video360Path },
        fileName: fileName360,
        mimetype: 'video/mp4',
        jpegThumbnail: jpegThumbnail360,
    })
    for (const recipient of otherRecipients) {
      await reenviarDesdeCentral(conn, reducedMessage, recipient, {
        document: { url: video360Path },
        fileName: fileName360,
        mimetype: 'video/mp4',
        jpegThumbnail: jpegThumbnail360,
      })
    }
    console.log(`[dbs-notify] 🚀 Enviado /dw4 360p al central y reenviado a ${otherRecipients.length} chat(s): ${fileName360}`)
  } catch (error) {
    console.error(`[dbs-notify] No se pudo crear o enviar 360p: ${error.message}`)
    await reportDbsError(conn, `Versión 360p de ${titulo} ep. ${epNum}`, error)
    for (const recipient of recipients) {
      try {
        await conn.sendMessage(recipient, { text: `⚠️ El original de *${titulo}* ep. *${zeroPad(epNum)}* fue enviado, pero falló la versión 360p.` })
      } catch (_) {}
    }
  } finally {
    try { fs.rmSync(video360Path, { force: true }) } catch (_) {}
  }
  return true
}

// ─── Cola ─────────────────────────────────────────────────────────────────────

function removeQueueItem(item) {
  const index = global.dbsEpisodeQueue.indexOf(item)
  if (index !== -1) global.dbsEpisodeQueue.splice(index, 1)
}

function clearQueuedIds(item, recipients) {
  for (const chatId of recipients) {
    for (const seenId of item.ep.variantSeenIds || [item.ep.id]) {
      global.dbsQueuedIds.delete(`${chatId}:${seenId}`)
    }
  }
}

function markSeenByRecipients(recipients, ep) {
  const ids = ep.variantSeenIds || [ep.id]
  for (const chatId of recipients) markSeen(chatId, ids)
}

/** Libera la carpeta del episodio solo cuando ninguna otra variante la usa. */
function releaseEpisodeDirIfIdle(ep) {
  if (global.dbsEpisodeQueue.some(item => item.ep?.id === ep.id)) return
  cleanupEpisodeDir(ep)
}

async function procesarCola() {
  if (global.dbsQueueRunning || !global.dbsEpisodeQueue.length) return
  // Un solo consumidor: dos `procesarCola()` a la vez procesarían el mismo
  // ítem dos veces (dbsunblock + sondeo podían dispararlo en paralelo).
  global.dbsQueueRunning = true
  const MAX_REINTENTOS = 3
  const ESPERA_REINTENTO = 3 * 60_000
  const ESPERA_REQUEUE = 5 * 60_000
  try {
    while (global.dbsEpisodeQueue.length) {
      const item = global.dbsEpisodeQueue[0]
      if (!item?.ep) { global.dbsEpisodeQueue.shift(); continue }
      const recipients = item.recipients || (item.chatId ? [item.chatId] : [])
      const activeRecipients = item.manual
        ? recipients
        : recipients.filter(chatId => global.dbsActiveChats.has(chatId))
      const { ep, manual = false } = item

      if (!activeRecipients.length) {
        removeQueueItem(item)
        clearQueuedIds(item, recipients)
        releaseEpisodeDirIfIdle(ep)
        continue
      }

      let sent = false
      for (let attempt = 1; attempt <= MAX_REINTENTOS && !sent; attempt++) {
        global.dbsQueueLastProgress = Date.now()
        if (!manual && !activeRecipients.some(chatId => global.dbsActiveChats.has(chatId))) {
          removeQueueItem(item)
          clearQueuedIds(item, recipients)
          releaseEpisodeDirIfIdle(ep)
          break
        }
        const conn = global.dbsConn
        if (!conn) {
          await sleep(ESPERA_REINTENTO)
          continue
        }
        try {
          const result = await enviarEpisodio(activeRecipients, ep, conn, { preview: manual })
          // Si la ficha respondió pero no hay enlaces descargables, se marca
          // como visto para no reintentarlo en cada sondeo.
          markSeenByRecipients(activeRecipients, ep)
          if (result !== false) for (const chatId of activeRecipients) bumpSentCount(chatId)
          removeQueueItem(item)
          clearQueuedIds(item, recipients)
          releaseEpisodeDirIfIdle(ep)
          sent = true
        } catch (error) {
          global.dbsQueueLastProgress = Date.now()
          const connectionError = /connection closed|stream errored|timed out|econnreset|econnrefused|socket hang up|precondition required|not open/i.test(error.message)
          if (connectionError && attempt < MAX_REINTENTOS) {
            await sleep(ESPERA_REINTENTO * attempt)
          } else if (connectionError) {
            removeQueueItem(item)
            global.dbsEpisodeQueue.push({ recipients, ep, manual })
            await sleep(ESPERA_REQUEUE)
            sent = true
          } else {
            removeQueueItem(item)
            clearQueuedIds(item, recipients)
            releaseEpisodeDirIfIdle(ep)
            await reportDbsError(conn, `Entrega de ${ep.titulo} ep. ${ep.epNum}`, error)
            for (const chatId of activeRecipients) {
              try {
                await conn.sendMessage(chatId, { text: `❌ Error enviando *${ep.titulo}* ep *${zeroPad(ep.epNum)}*:\n${error.message}` })
              } catch (_) {}
            }
            sent = true
          }
        }
      }
      if (global.dbsEpisodeQueue.length) await sleep(QUEUE_DELAY)
    }
  } catch (error) {
    await reportDbsError(global.dbsConn, 'Cola de episodios', error)
  } finally {
    global.dbsQueueRunning = false
  }
}

// ─── Sondeo ───────────────────────────────────────────────────────────────────

async function checkNuevosEpisodiosGlobal(conn, { force = false } = {}) {
  if (global.dbsChecking) return
  global.dbsChecking = true
  try {
    let lista
    try {
      lista = await fetchLatestEpisodesDBS({ force })
    } catch (error) {
      await reportDbsError(conn, 'Consulta AnimeDBS', error)
      return
    }
    if (!lista.length || !global.dbsActiveChats.size) return
    const seen = loadSeen()
    const nuevosPorChat = new Map()
    for (const chatId of global.dbsActiveChats.keys()) {
      if (!Array.isArray(seen[chatId]) || !seen[chatId].length) {
        // Primer sondeo del chat: la portada actual queda como base.
        seedChatSeen(chatId, lista)
        continue
      }
      const visibles = []
      const fallidos = []
      const nuevos = await seleccionarVersionPreferidaDBS(lista, {
        seen: seen[chatId], chatId, skipQueued: true, visibles, fallidos,
      })
      // Solo se marcan los grupos leídos con éxito y sin enlaces; los fallos
      // de red quedan pendientes para el próximo sondeo.
      if (visibles.length) markSeen(chatId, visibles)
      if (fallidos.length) console.log(`[dbs-notify] ${fallidos.length} ficha(s) sin respuesta; se reintentarán en el próximo sondeo.`)
      if (nuevos.length) nuevosPorChat.set(chatId, nuevos)
    }
    const grouped = new Map()
    for (const [chatId, episodes] of nuevosPorChat) {
      for (const ep of episodes) {
        if (!grouped.has(ep.id)) grouped.set(ep.id, { ep, recipients: [] })
        grouped.get(ep.id).recipients.push(chatId)
      }
    }
    for (const { ep, recipients } of grouped.values()) {
      global.dbsEpisodeQueue.push({ recipients, ep, manual: false })
      recipients.forEach(chatId => global.dbsQueuedIds.add(`${chatId}:${ep.id}`))
    }
    if (grouped.size) {
      // Aviso de lote: una sola línea en vez de N mensajes "en cola".
      if (grouped.size > 1) {
        const resumen = [...grouped.values()].slice(0, 8)
          .map(({ ep }, index) => `${index + 1}. *${ep.titulo}* — Ep ${zeroPad(ep.epNum)}`)
          .join('\n')
        for (const chatId of global.dbsActiveChats.keys()) {
          conn?.sendMessage(chatId, {
            text: `📋 *${grouped.size} episodios nuevos en AnimeDBS*\n\n${resumen}\n\n⏳ _Se enviarán de uno en uno..._`,
          }).catch(() => {})
        }
      }
      procesarCola().catch(error => reportDbsError(global.dbsConn, 'Procesamiento de cola', error))
    }
  } finally {
    global.dbsChecking = false
    global.dbsLastCheckAt = Date.now()
  }
}

/**
 * `force` sirve para el comando manual: si el usuario pide `.dbscheck` no
 * tiene sentido devolverle un sondeo cacheado de hace 40 segundos.
 */
async function checkNuevosEpisodios(_chatId, conn, options = {}) {
  return checkNuevosEpisodiosGlobal(conn || global.dbsConn, options)
}

function iniciarSondeoGlobal(conn, intervalSec, checkNow = false) {
  if (conn) global.dbsConn = conn
  const intervalo = Math.min(Math.max(Number(intervalSec) || CHECK_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS)
  if (global.dbsGlobalTimer) clearInterval(global.dbsGlobalTimer)
  global.dbsGlobalTimer = setInterval(() => {
    if (global.dbsConn) checkNuevosEpisodiosGlobal(global.dbsConn).catch(error => reportDbsError(global.dbsConn, 'Sondeo global', error))
  }, intervalo * 1000)
  if (global.dbsGlobalTimer.unref) global.dbsGlobalTimer.unref()
  if (checkNow && global.dbsConn) checkNuevosEpisodiosGlobal(global.dbsConn).catch(error => reportDbsError(global.dbsConn, 'Sondeo inicial', error))
}

function iniciarNotificador(chatId, conn, intervalSec = null, checkNow = false) {
  if (conn) global.dbsConn = conn
  intervalSec = Math.min(Math.max(Number(intervalSec) || getGlobalIntervalSec(), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS)
  const state = loadState()
  const startedAt = state[chatId]?.startedAt || Date.now()
  const sentCount = Number(state[chatId]?.sentCount) || 0
  global.dbsActiveChats.set(chatId, { intervalSec, startedAt, sentCount })
  updateState(saved => {
    saved[chatId] = { intervalSec, startedAt, sentCount }
  })
  // El sondeo global corre al ritmo más exigente de los chats activos.
  const interval = Math.min(...[...global.dbsActiveChats.values()].map(entry => entry.intervalSec))
  iniciarSondeoGlobal(conn, interval, checkNow)
}

function detenerNotificador(chatId) {
  global.dbsActiveChats.delete(chatId)
  for (const item of global.dbsEpisodeQueue) {
    if (item.recipients?.includes(chatId)) item.recipients = item.recipients.filter(id => id !== chatId)
    for (const seenId of item.ep?.variantSeenIds || [item.ep?.id]) global.dbsQueuedIds.delete(`${chatId}:${seenId}`)
  }
  global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(item => item.recipients?.length || item.manual)
  updateState(state => {
    delete state[chatId]
  })
  if (!global.dbsActiveChats.size && global.dbsGlobalTimer) {
    clearInterval(global.dbsGlobalTimer)
    global.dbsGlobalTimer = null
  }
}

// Si una versión anterior dejó un watchdog activo durante una recarga, se
// cancela para que ningún comando vuelva a activar DBS automáticamente.
if (global.dbsWatchdog) {
  clearInterval(global.dbsWatchdog)
  global.dbsWatchdog = null
}

limpiarTempViejos()

// ─── Comandos ─────────────────────────────────────────────────────────────────

/**
 * Mensaje para el chat cuando falla el acceso al sitio. Antes se reenviaba el
 * texto crudo de axios ("Request failed with status code 403"), que no dice
 * nada ni al dueño ni a quien puede arreglarlo.
 */
function mensajeDeError(error) {
  if (esErrorDeBloqueo(error)) return BLOQUEO_TEXTO
  return `❌ Error: ${error.message}`
}

function estadoTexto(m) {
  const active = global.dbsActiveChats.get(m.chat)
  const cola = global.dbsEpisodeQueue.filter(item => item.recipients?.includes(m.chat) || item.chatId === m.chat)
  const vistos = (loadSeen()[m.chat] || []).length
  const ultimoChequeo = global.dbsLastCheckAt
    ? `hace ${formatActiveTime(global.dbsLastCheckAt)}`
    : 'pendiente'
  let texto = [
    '📡 *Estado AnimeDBS (SUB + LAT)*',
    '',
    active ? `✅ *Activo* — cada ${formatInterval(active.intervalSec)}` : '🔴 *Inactivo*',
    `📋 Cola: *${cola.length}* pendiente(s)`,
    `🔵 Procesando: *${global.dbsQueueRunning ? 'Sí' : 'No'}*`,
    `👁️ Vistos: *${vistos}*`,
    `🔄 Último chequeo: *${ultimoChequeo}*`,
  ].join('\n')
  if (cola.length) {
    texto += '\n\n*En cola:*\n' + cola.slice(0, 5)
      .map((item, index) => `  ${index + 1}. *${item.ep.titulo}* ep ${zeroPad(item.ep.epNum)}`)
      .join('\n')
  }
  return texto
}

let handler = async (m, { conn, text, usedPrefix, command, isOwner }) => {
  if (conn) global.dbsConn = conn
  const OWNER_COMMANDS = ['dbsstart', 'dbsstop', 'dbsinterval', 'dbsflush', 'dbsunblock', 'dbsexample']
  if (OWNER_COMMANDS.includes(command) && !isOwner) {
    return conn.sendMessage(m.chat, { text: '⛔ Solo el *owner* puede usar este comando.' }, { quoted: m })
  }

  if (command === 'dbsstart') {
    const value = Number.parseInt(text?.trim(), 10)
    const intervalSec = Number.isInteger(value) && value >= MIN_INTERVAL_SECONDS && value <= MAX_INTERVAL_SECONDS
      ? value
      : CHECK_INTERVAL_SECONDS
    const configuredCentral = getCentralChatId()
    const esCentral = !configuredCentral || configuredCentral === m.chat
    if (!configuredCentral) setCentralChatId(m.chat)
    iniciarNotificador(m.chat, conn, intervalSec, false)
    let lista = []
    try {
      lista = await fetchLatestEpisodesDBS({ force: true })
      seedChatSeen(m.chat, lista)
    } catch (_) {}
    await conn.sendMessage(m.chat, {
      text: [
        '✅ *Notificador AnimeDBS activado*',
        '',
        `┃ ⏱️ *Intervalo:* \`${formatInterval(intervalSec)}\``,
        '┃ 🌐 *AnimeDBS* — `SUB + Audio Latino (LAT)`',
        `┃ ${esCentral ? '🎯 *Grupo central*' : '📨 *Grupo receptor*'}`,
        esCentral ? '┃ 📤 Los demás grupos recibirán reenvíos desde aquí.' : `┃ 🎯 *Central:* \`${getCentralChatId()}\``,
        `📋 *${lista.length}* episodios registrados como base.`,
        '> Solo los nuevos se enviarán.',
        `*Usa \`${usedPrefix}dbsstop\` para detener*`,
        `*Usa \`${usedPrefix}dbsstatus\` para ver el estado*`,
      ].join('\n'),
    }, { quoted: m })
    return
  }

  if (command === 'dbsstop') {
    const entry = global.dbsActiveChats.get(m.chat)
    if (!entry) return m.reply('ℹ️ El notificador no estaba activo.')
    if (getCentralChatId() === m.chat) {
      const otrosActivos = [...global.dbsActiveChats.keys()].filter(chatId => chatId !== m.chat)
      if (otrosActivos.length) {
        return m.reply('⛔ Este es el grupo central. Detén primero los grupos receptores o deja el central activo para que pueda reenviar los archivos.')
      }
      clearCentralChatId()
    }
    const activeTime = formatActiveTime(entry.startedAt)
    const sentCount = Number(entry.sentCount) || 0
    detenerNotificador(m.chat)
    return m.reply(`🛑 *Notificador detenido*\n\n├ Activo: *${activeTime}*\n└ Avisos enviados: *${sentCount}*\n\n*Usa ${usedPrefix}dbsstart para reactivarlo.*`)
  }

  if (command === 'dbsstatus') return m.reply(estadoTexto(m))

  if (command === 'dbsqueue') {
    if (!global.dbsEpisodeQueue.length) return m.reply('✅ Cola vacía.')
    return m.reply([
      `📋 *Cola (${global.dbsEpisodeQueue.length}):*`,
      '',
      ...global.dbsEpisodeQueue.map((item, index) =>
        `${index + 1}. *${item.ep.titulo}* ep ${zeroPad(item.ep.epNum)} [${item.recipients?.includes(m.chat) ? 'este chat' : 'otro chat'}]`),
    ].join('\n'))
  }

  if (command === 'dbsflush') {
    let removed = 0
    for (const item of global.dbsEpisodeQueue) {
      if (!item.recipients?.includes(m.chat)) continue
      item.recipients = item.recipients.filter(id => id !== m.chat)
      clearQueuedIds(item, [m.chat])
      removed++
    }
    global.dbsEpisodeQueue = global.dbsEpisodeQueue.filter(item => item.recipients?.length || item.manual)
    return m.reply(`🗑️ *${removed}* episodio(s) eliminado(s) de este chat.`)
  }

  if (command === 'dbsunblock') {
    const estaba = global.dbsQueueRunning
    if (!global.dbsEpisodeQueue.length) return m.reply('🔓 Cola libre.\nℹ️ No hay episodios pendientes.')
    if (estaba) {
      // No se toca el flag a la ligera: si el consumidor sigue vivo y solo está
      // esperando al servidor, liberarlo aquí provocaría dos envíos del mismo
      // episodio. Se informa y se deja que termine.
      const esperando = Date.now() - Number(global.dbsQueueLastProgress || 0) > 15 * 60_000
      if (!esperando) {
        return m.reply(`⏳ La cola sigue trabajando (${global.dbsEpisodeQueue.length} pendiente(s)).\n> Usa *.dbsstatus* para ver el avance.`)
      }
      global.dbsQueueRunning = false
    }
    await m.reply(`🔓 Cola desbloqueada${estaba ? ' (estaba trabada)' : ''}.\n▶️ Reanudando ${global.dbsEpisodeQueue.length} episodio(s)...`)
    procesarCola().catch(() => {})
    return
  }

  if (command === 'dbscheck') {
    await m.reply('🔍 Chequeando episodios SUB + LAT de AnimeDBS...')
    try {
      await checkNuevosEpisodios(m.chat, conn, { force: true })
      if (!global.dbsEpisodeQueue.some(item => item.recipients?.includes(m.chat) || item.chatId === m.chat)) {
        await m.reply('✅ Sin episodios nuevos.')
      }
    } catch (error) {
      await m.reply(mensajeDeError(error))
    }
    return
  }

  if (command === 'dbsinterval') {
    const seconds = parseIntervalInput(text)
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
      return m.reply(`❌ Usa entre *${MIN_INTERVAL_SECONDS} segundos* y *${MAX_INTERVAL_SECONDS / 60} minutos*.\nEjemplos: *${usedPrefix}dbsinterval 60s* o *${usedPrefix}dbsinterval 10m*`)
    }
    if (!global.dbsActiveChats.has(m.chat)) return m.reply(`⚠️ Usa *${usedPrefix}dbsstart* primero.`)
    setGlobalIntervalSec(seconds)
    for (const chatId of Object.keys(loadState()).filter(id => id !== '__config')) {
      iniciarNotificador(chatId, conn, seconds, false)
    }
    return m.reply(`⏱️ Intervalo global actualizado a *${formatInterval(seconds)}*.`)
  }

  if (command === 'dbsexample') {
    const cantidad = Math.min(Math.max(parseInt(text?.trim(), 10) || 1, 1), 10)
    await m.reply(`🔍 Obteniendo los *${cantidad}* episodio(s) más reciente(s) de *AnimeDBS*...`)
    let lista
    try {
      lista = await fetchLatestEpisodesDBS({ force: true })
      if (!lista.length) return m.reply('❌ Sin episodios de AnimeDBS disponibles.')
      lista = await seleccionarVersionPreferidaDBS(lista, { limit: cantidad })
      if (!lista.length) return m.reply('❌ No hay enlaces SUB ni LAT disponibles.')
    } catch (error) {
      return m.reply(mensajeDeError(error))
    }
    const seleccion = lista.slice(0, cantidad)
    if (seleccion.length > 1) {
      await m.reply([
        `📋 *${seleccion.length} episodios más recientes (según fecha de publicación):*`,
        '',
        ...seleccion.map((ep, index) => `${index + 1}. *${ep.titulo}* — Ep ${zeroPad(ep.epNum)} (${ep.idioma.toUpperCase()})`),
        '',
        '⏳ _Se enviarán de uno en uno..._',
      ].join('\n'))
    }
    for (const ep of seleccion) {
      const id = `${m.chat}:${ep.id}`
      if (global.dbsQueuedIds.has(id)) continue
      global.dbsEpisodeQueue.push({ recipients: [m.chat], ep, manual: true })
      global.dbsQueuedIds.add(id)
    }
    procesarCola().catch(() => {})
    return
  }
}

handler.command = /^(dbsstart|dbsstop|dbsstatus|dbscheck|dbsqueue|dbsflush|dbsunblock|dbsinterval|dbsexample)$/i
handler.tags = ['anime', 'notificaciones']
handler.help = ['dbsstart [segundos]', 'dbsstop', 'dbsstatus', 'dbscheck', 'dbsqueue', 'dbsflush', 'dbsunblock', 'dbsinterval <segundos>', 'dbsexample [N]']
handler.before = async (_m, { conn }) => { if (conn) global.dbsConn = conn }
export default handler
