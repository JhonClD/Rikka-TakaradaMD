// Cliente HTTP de AnimeDBS con huella de navegador.
//
// El sitio empezó a responder **403** a `axios` cuando el bot sondea desde una
// IP de datacenter (VPS, Termux con datos móviles, etc.): el WAF mira el
// handshake TLS, no solo el `User-Agent`, así que mandar cabeceras de Chrome no
// alcanza. La solución es hablar con huella de Chrome de verdad (impit / wreq-js
// lo hacen con BoringSSL) y, si aun así lo bloquean, escalar a un proxy o a
// FlareSolverr.
//
// Estrategias, en orden. La primera que responde 2xx gana y **se recuerda**,
// para no gastar tres peticiones por cada ficha durante el resto del proceso:
//
//   1. wreq-js   — huella Chrome (lo que ya usa jk-notify en este repo)
//   2. impit     — huella Chrome; implementación distinta, cubre fallos de wreq
//   3. axios     — navegador "de mentira"; sirve cuando el WAF solo mira headers
//   4. curl      — binario del sistema, otra pila TLS y otra IP de salida
//   5. FlareSolverr — solo si DBS_FLARESOLVERR_URL está configurado
//
// Si todas fallan con 403, el error dice exactamente qué configurar
// (DBS_PROXY_URL o DBS_FLARESOLVERR_URL) en lugar de un "Request failed with
// status code 403" que no deja hacer nada.

import axios from 'axios'
import https from 'https'
import { spawn } from 'child_process'

const ANIMEDBS_URL = 'https://www.animedbs.online'
const TIMEOUT_MS = 20_000
const MAX_REINTENTOS = 3

// Mismo navegador que declara impit/wreq; el UA se toma de ahí para que las
// cabeceras no delaten al cliente real.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
// Perfil que emulan wreq-js e impit; si se cambia uno hay que cambiar el otro,
// porque un UA que no case con el handshake delata igual que un axios.
const PERFIL_WREQ = 'chrome_136'
const PERFIL_NAVEGADOR = 'chrome136'

// Cabeceras de reserva. Si wreq-js está disponible se sustituyen por las de su
// emulación (incluyen sec-ch-ua): un Chrome 136 que no manda client hints es
// tan sospechoso como un axios.
const CABECERAS_BASE = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

/**
 * Cabeceras activas. Se exporta un objeto mutable porque el plugin las importa
 * al cargar y `wreq-js` solo existe después (import dinámico): cuando llega su
 * emulación se reemplaza el contenido, no la referencia.
 */
export const HEADERS = { ...CABECERAS_BASE }

const PROXY_URL = String(
  process.env.DBS_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
).trim()
const FLARESOLVERR_URL = String(process.env.DBS_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '').replace(/\/+$/, '')
const COOKIE_INICIAL = String(process.env.DBS_COOKIE || '').trim()

// UA de la cookie: si el dueño la copió de su navegador, el sitio espera ese UA
// exacto y no el de Chrome 136 que ponemos por defecto.
const ua = String(process.env.DBS_UA || UA).trim()

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8 })

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
        for (const clave of Object.keys(HEADERS)) delete HEADERS[clave]
        Object.assign(HEADERS, plano)
      }
    } catch (_) { /* se conservan las de reserva */ }
  } catch (error) {
    wreqFallido = true
    console.warn(`[dbs-http] wreq-js no disponible: ${error.message}`)
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
      browser: PERFIL_NAVEGADOR,
      timeout: TIMEOUT_MS,
      headers: HEADERS,
      ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}),
    })
  } catch (error) {
    impitFallido = true
    console.warn(`[dbs-http] impit no disponible: ${error.message}`)
  }
  return impitClient
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Cookie vigente: la de entorno (copiada de un navegador) o la de FlareSolverr. */
let cookieSesion = COOKIE_INICIAL
/** UA que dictó FlareSolverr al resolver el desafío; manda sobre el de entorno. */
let uaSesion = ''

/**
 * Cabeceras de una petición concreta.
 *
 * `HEADERS` puede venir de la emulación de wreq (nombres en minúscula) o de la
 * reserva; aquí se normaliza todo a minúsculas para que sobrescribir el UA no
 * deje un `user-agent` viejo al lado.
 */
function cabeceras(extra = {}, { documento = true } = {}) {
  const agente = uaSesion || ua
  const base = documento
    ? HEADERS
    : { accept: '*/*', 'accept-language': HEADERS['accept-language'] || HEADERS['Accept-Language'] }
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
    httpsAgent,
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

async function conFlareSolverr(url, _headers, timeout = TIMEOUT_MS, binario = false) {
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
  if (estrategiaActual == null) return ESTRATEGIAS
  const indice = ESTRATEGIAS.findIndex(estrategia => estrategia.nombre === estrategiaActual)
  if (indice <= 0) return ESTRATEGIAS
  return [ESTRATEGIAS[indice], ...ESTRATEGIAS.slice(0, indice), ...ESTRATEGIAS.slice(indice + 1)]
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
export async function fetchDbs(
  url,
  { headers = {}, timeout = TIMEOUT_MS, documento = true, binario = false, intentos = 1 } = {},
) {
  const totales = Math.min(Math.max(1, intentos), MAX_REINTENTOS)
  let ultimoError = null
  let huboBloqueo = false

  for (let intento = 1; intento <= totales; intento++) {
    if (intento > 1) await sleep(1000 * intento)

    for (const estrategia of ordenar()) {
      try {
        const respuesta = await estrategia.ejecutar(url, cabeceras(headers, { documento }), timeout, binario)
        if (estrategiaActual !== estrategia.nombre) {
          estrategiaActual = estrategia.nombre
          console.log(`[dbs-http] cliente activo: ${estrategia.nombre}`)
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
export function esErrorDeBloqueo(error) {
  return error?.code === 'DBS_FORBIDDEN' || esBloqueo(error)
}

export { ANIMEDBS_URL }
