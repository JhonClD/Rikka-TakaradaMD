// byse-dl.js — descargador de https://byse.sx (y sus mirrors de la red Byse).
//
// Byse es la infraestructura que hay detrás de media docena de hosts que ya
// aparecen en los notificadores del repo (tioanime-notify, jk-notify): la página
// `/e/{código}` es solo un cascarón y las fuentes reales salen de su API.
//
// El camino corto: `GET /api/videos/{código}` devuelve `playback` con el vídeo
// cifrado en AES-256-GCM. La clave está partida en 30 trozos dentro de
// `key_parts` y solo dos son reales; los demás son ruido. Según la versión del
// cifrado, los trozos útiles se eligen de una de estas dos formas:
//
//   · versión antigua  → índices [v, 31 - v] (1-based) dentro de key_parts
//   · versión actual   → los dos trozos que miden 16 bytes (16 + 16 = AES-256)
//
// El camino largo (el que usa hoy la web en producción) añade un reto antes de
// entregar el vídeo:
//
//   challenge → attest (firma ECDSA P-256 + huella del cliente) → captcha (PoW)
//   → captcha/verify → embed/playback
//
// El PoW no es SHA-256: es un hash propio de 512 palabras con rondas tipo
// ChaCha, así que se reimplementa aquí abajo. Se resuelve por lotes con
// `setImmediate` entre tandas para no congelar el bucle de eventos del bot
// (el proceso atiende a todos los chats) y se puede cancelar con `.cancelar`.
//
// Además del cifrado, Byse rota de dominio cada pocas semanas. Se aceptan los
// mirrors conocidos y cualquier host de la familia `byse*.tld`; el flujo se
// reintenta contra el host del `embed_frame_url` que devuelve la API, que es
// donde de verdad está el reproductor.
//
// El resultado suele ser un `master.m3u8`, así que el troceado HLS se baja y
// se remuxea con ffmpeg (mp4, copia de códecs, sin recodificar).

import { createDecipheriv, generateKeyPairSync, sign as firmar, randomBytes } from 'node:crypto'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { isIP } from 'node:net'
import axios from 'axios'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const CABECERAS_BASE = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}
const MAX_DESCARGA_BYTES = Math.min(1500, Math.max(20, Number(process.env.BYSE_MAX_MB) || 1500)) * 1024 * 1024
const TIEMPO_MAX_DESCARGA_MS = Math.max(60_000, Number(process.env.BYSE_TIMEOUT_MS) || 60 * 60_000)
const TIEMPO_PAGINA_MS = 25_000
const TIEMPO_API_MS = 20_000
const TIEMPO_MAX_POW_MS = 90_000
const POW_MAX_ITER = 2_000_000
const POW_LOTE = 25_000
const MIN_BYTES_VALIDOS = 32 * 1024
const INTERVALO_ESTADO_MS = 5_000

// Hosts de la red Byse vistos en los extractores de la comunidad (Kotlin/
// TypeScript) y en los notificadores de este repo. La lista abierta de abajo
// (`byse*.tld`) cubre los dominios nuevos sin esperar a un parche.
const HOSTS_CONOCIDOS = new Set([
  'byse.sx',
  'bysekoze.com',
  'bysesukior.com',
  'bysedikamoum.com',
  'bysebuho.com',
  'bysewihe.com',
  'byselapuix.com',
  'byseqekaho.com',
  'bysetayico.com',
  'bysevepoin.com',
  'bysezejataos.com',
  'bysejikuar.com',
  'bysefujedu.com',
  'bysesayeveum.com',
  'embedplaybyse.top',
  'f16px.com',
  'cinegrab.com',
  'moonmov.pro',
])
const HOST_FAMILIA_BYSE = /^byse[a-z0-9]{0,16}\.(?:sx|com|top|xyz|net|to|in|sbs|cyou|lol)$/i

function log(evento, datos = {}) {
  const ahora = new Date().toLocaleTimeString('es-MX', { hour12: false })
  const color = process.stdout.isTTY && !process.env.NO_COLOR
  const cyan = color ? '\u001b[36m' : ''
  const reset = color ? '\u001b[0m' : ''
  console.log(`${cyan}[BYSE ${ahora}]${reset} ${evento}${Object.keys(datos).length ? ` ${JSON.stringify(datos)}` : ''}`)
}

function formatearBytes(valor) {
  const bytes = Number(valor) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatearTiempo(segundos) {
  const valor = Math.max(0, Math.floor(Number(segundos) || 0))
  const horas = Math.floor(valor / 3600)
  const minutos = Math.floor((valor % 3600) / 60)
  const resto = valor % 60
  return horas ? `${horas}:${String(minutos).padStart(2, '0')}:${String(resto).padStart(2, '0')}` : `${minutos}:${String(resto).padStart(2, '0')}`
}

let ultimaSalidaProgreso = 0
function progresoTerminal({ visto, total, velocidad, bytesSalida, reintento, modo }) {
  if (reintento) {
    if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write(`\r\u001b[2K  ↻ Reintentando: ${reintento}\n`)
    else log('reintentando descarga', { variante: reintento })
    return
  }
  const porcentaje = total > 0 ? Math.min(100, Math.max(0, (visto / total) * 100)) : null
  const cantidad = modo === 'hls'
    ? `${formatearTiempo(visto)}${total > 0 ? ` / ${formatearTiempo(total)}` : ''}`
    : `${formatearBytes(visto)}${total > 0 ? ` / ${formatearBytes(total)}` : ''}`
  const etiqueta = modo === 'hls' ? 'FFmpeg' : 'Descarga'
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    if (Date.now() - ultimaSalidaProgreso >= 5000) {
      ultimaSalidaProgreso = Date.now()
      log(`progreso ${etiqueta}`, { avance: cantidad, porcentaje: porcentaje == null ? null : `${porcentaje.toFixed(1)}%`, salida: bytesSalida ? formatearBytes(bytesSalida) : undefined, velocidad: velocidad ? `${velocidad}x` : undefined })
    }
    return
  }
  const largo = 22
  const llenas = porcentaje == null ? 0 : Math.round((porcentaje / 100) * largo)
  const barra = `${'█'.repeat(llenas)}${'░'.repeat(largo - llenas)}`
  const avance = porcentaje == null ? '' : ` ${porcentaje.toFixed(1)}% [${barra}]`
  const rapidez = velocidad ? ` · ${velocidad}x` : ''
  const salida = modo === 'hls' && bytesSalida ? ` · MP4 ${formatearBytes(bytesSalida)}` : ''
  process.stdout.write(`\r\u001b[2K  ${etiqueta} ↓ ${cantidad}${avance}${rapidez}${salida}`)
}

function iniciarSpinnerTerminal(etiqueta) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    log(etiqueta)
    return () => {}
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let indice = 0
  const dibujar = () => process.stdout.write(`\r\u001b[2K  ${frames[indice++ % frames.length]} ${etiqueta}`)
  dibujar()
  const timer = setInterval(dibujar, 120)
  timer.unref?.()
  return (resultado) => {
    clearInterval(timer)
    process.stdout.write(`\r\u001b[2K  ${resultado}\n`)
  }
}

function errorAbortado() {
  const error = new Error('Descarga cancelada por el usuario.')
  error.name = 'AbortError'
  error.cancelado = true
  return error
}

function esCancelacion(error) {
  return Boolean(error?.cancelado) || error?.name === 'AbortError' || error?.name === 'CanceledError' ||
    error?.code === 'ERR_CANCELED' || error?.code === 'ABORT_ERR'
}

// ── Validación de enlaces ────────────────────────────────────────────────────

function esHostByse(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host || isIP(host) || !host.includes('.')) return false
  if (/^(?:localhost|local|internal|test|invalid|example)$/.test(host)) return false
  if (/(?:^|\.)(?:localhost|local|internal)$/.test(host)) return false
  return HOSTS_CONOCIDOS.has(host) || HOST_FAMILIA_BYSE.test(host)
}

/** URL pública (http/https, sin credenciales ni IP privada) — evita SSRF. */
function urlPublica(valor) {
  try {
    const url = new URL(String(valor || '').trim())
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.local')) return null
    if (isIP(host)) {
      const [a, b] = host.split('.').map(Number)
      if (host.includes(':')) return null
      if (a === 0 || a === 10 || a === 127 || a >= 224) return null
      if (a === 169 && b === 254) return null
      if (a === 172 && b >= 16 && b <= 31) return null
      if (a === 192 && b === 168) return null
      if (a === 100 && b >= 64 && b <= 127) return null
    }
    return url
  } catch (_) {
    return null
  }
}

const CODIGO_SUELTO = /^[A-Za-z0-9]{6,20}$/

/**
 * Extrae `{ host, code }` de un enlace de Byse o de un código pelado.
 * Acepta /e/{c}, /d/{c}, /v/{c}, /download/{c}, /video/{c}, /{c} y `{c}.html`.
 */
export function parseByseUrl(valor) {
  const texto = String(valor || '').trim()
  if (!texto) throw new Error('Falta el enlace de Byse.')

  if (CODIGO_SUELTO.test(texto)) return { host: 'byse.sx', code: texto, pageUrl: `https://byse.sx/e/${texto}` }

  // "bysedikamoum.com/xyz987abc" sin esquema: se asume https.
  const conEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(texto) ? texto : `https://${texto.replace(/^\/+/, '')}`
  const url = urlPublica(conEsquema)
  if (!url) throw new Error('El enlace no es una URL válida.')
  if (!esHostByse(url.hostname)) throw new Error(`Solo acepto enlaces de byse.sx (o sus mirrors). Recibí: ${url.hostname}`)

  const partes = url.pathname.split('/').filter(Boolean)
  let code = null
  if (partes.length >= 2 && /^(?:e|d|v|download|video|file|embed)$/i.test(partes[0])) code = partes[1]
  else if (partes.length >= 1) code = partes[partes.length - 1]
  code = String(code || '').replace(/\.html?$/i, '')

  if (!code || !/^[A-Za-z0-9_-]{4,32}$/.test(code)) {
    throw new Error('No pude reconocer el código del vídeo en ese enlace.')
  }

  const host = url.hostname.toLowerCase()
  return { host, code, pageUrl: `https://${host}/e/${code}` }
}

function buscarEnlace(texto) {
  const crudo = String(texto || '')
  const enlace = crudo.match(/https?:\/\/[^\s<>"']+/i)
  if (enlace) return enlace[0].replace(/[),.!?;:'"\]}]+$/g, '')
  const suelto = crudo.split(/\s+/).find((trozo) => CODIGO_SUELTO.test(trozo))
  return suelto || ''
}

// ── Capa HTTP ────────────────────────────────────────────────────────────────
// Mismo orden que el resto del repo: primero una huella TLS de Chrome real
// (wreq-js), luego la fetch nativa y al final axios. Byse vive detrás de un CDN
// que rechaza clientes con TLS de Node, así que axios es solo el último recurso.

let moduloWreq = null
let wreqFallido = false
async function getWreq() {
  if (moduloWreq || wreqFallido) return moduloWreq
  try {
    moduloWreq = await import('wreq-js')
  } catch (error) {
    wreqFallido = true
    log('wreq-js no disponible', { error: error?.message || String(error) })
  }
  return moduloWreq
}

function senalConTiempo(signal, ms) {
  const propio = AbortSignal.timeout(ms)
  if (!signal) return propio
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, propio])
  return propio
}

async function pedir(url, opciones = {}) {
  const { metodo = 'GET', cabeceras = {}, cuerpo = null, timeout = TIEMPO_PAGINA_MS, signal } = opciones
  const cabecerasFinales = { ...CABECERAS_BASE, ...cabeceras }
  const errores = []

  const wreq = await getWreq()
  if (wreq?.fetch) {
    try {
      const respuesta = await wreq.fetch(url, {
        browser: 'chrome_136',
        os: 'windows',
        method: metodo,
        headers: cabecerasFinales,
        redirect: 'follow',
        ...(cuerpo == null ? {} : { body: cuerpo }),
        signal: senalConTiempo(signal, timeout),
      })
      const texto = await respuesta.text()
      if (!respuesta.ok) throw new Error(`wreq HTTP ${respuesta.status}`)
      return { texto, status: respuesta.status, url: respuesta.url || url, cabeceras: Object.fromEntries(respuesta.headers) }
    } catch (error) {
      if (esCancelacion(error) && signal?.aborted) throw errorAbortado()
      errores.push(`wreq: ${error?.message || error}`)
    }
  }

  try {
    const respuesta = await globalThis.fetch(url, {
      method: metodo,
      headers: cabecerasFinales,
      redirect: 'follow',
      ...(cuerpo == null ? {} : { body: cuerpo }),
      signal: senalConTiempo(signal, timeout),
    })
    const texto = await respuesta.text()
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
    return { texto, status: respuesta.status, url: respuesta.url || url, cabeceras: Object.fromEntries(respuesta.headers) }
  } catch (error) {
    if (esCancelacion(error) && signal?.aborted) throw errorAbortado()
    errores.push(`fetch: ${error?.message || error}`)
  }

  try {
    const respuesta = await axios.request({
      url,
      method: metodo,
      headers: cabecerasFinales,
      data: cuerpo,
      timeout,
      maxRedirects: 5,
      signal,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400,
    })
    return {
      texto: typeof respuesta.data === 'string' ? respuesta.data : JSON.stringify(respuesta.data),
      status: respuesta.status,
      url: respuesta.request?.res?.responseUrl || url,
      cabeceras: respuesta.headers || {},
    }
  } catch (error) {
    if (esCancelacion(error) && signal?.aborted) throw errorAbortado()
    errores.push(`axios: ${error?.message || error}`)
  }

  throw new Error(`No pude conectar con ${new URL(url).host}: ${errores.join(' | ')}`)
}

async function pedirJson(url, opciones = {}) {
  const respuesta = await pedir(url, opciones)
  try {
    return { datos: JSON.parse(respuesta.texto), respuesta }
  } catch (_) {
    throw new Error(`Respuesta no JSON de ${new URL(url).host}`)
  }
}

async function pedirPost(url, cuerpo, opciones = {}) {
  return pedir(url, { ...opciones, metodo: 'POST', cuerpo: JSON.stringify(cuerpo ?? {}), cabeceras: { 'Content-Type': 'application/json', ...(opciones.cabeceras || {}) } })
}

// ── Cifrado de la API de Byse ────────────────────────────────────────────────

function b64urlABuffer(texto) {
  const normal = String(texto || '').replace(/-/g, '+').replace(/_/g, '/')
  const relleno = normal.length % 4 === 0 ? '' : '='.repeat(4 - (normal.length % 4))
  return Buffer.from(normal + relleno, 'base64')
}

function aB64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Claves candidatas para `playback.key_parts`.
 *
 * Son 30 trozos y solo dos sirven. En vez de adivinar el esquema de la versión,
 * se generan las combinaciones plausibles y se prueban en orden: la que
 * descifra algo con forma de `{ sources: [...] }` gana.
 */
function clavesCandidatas(playback) {
  const partes = (Array.isArray(playback?.key_parts) ? playback.key_parts : [])
    .filter((parte) => typeof parte === 'string' && parte.length > 0)
    .map((parte) => {
      try { return b64urlABuffer(parte) } catch (_) { return null }
    })
    .filter((buffer) => buffer && buffer.length > 0)

  const candidatas = []
  const agregar = (buffer) => {
    if (!buffer || buffer.length !== 32) return
    const huella = buffer.toString('hex')
    if (candidatas.some((otra) => otra.toString('hex') === huella)) return
    candidatas.push(buffer)
  }

  const version = Number(playback?.version)
  if (Number.isFinite(version) && version >= 1 && version <= 20) {
    const a = partes[version - 1]
    const b = partes[31 - version - 1]
    if (a && b) agregar(Buffer.concat([a, b]))
  }

  const de16 = partes.filter((parte) => parte.length === 16)
  if (de16.length >= 2) agregar(Buffer.concat([de16[0], de16[1]]))

  for (let i = 0; i < partes.length - 1 && candidatas.length < 4; i++) {
    agregar(Buffer.concat([partes[i], partes[i + 1]]))
  }
  return candidatas
}

function leerPlayback(playback, iva, cifrado, clave) {
  const iv = b64urlABuffer(iva)
  const bruto = b64urlABuffer(cifrado)
  if (bruto.length <= 16) return null

  // 1) AES-256-GCM estándar: etiqueta de autenticación (16 B) al final.
  try {
    if (iv.length === 12) {
      const descifrador = createDecipheriv('aes-256-gcm', clave, iv)
      descifrador.setAuthTag(bruto.subarray(bruto.length - 16))
      const claro = Buffer.concat([descifrador.update(bruto.subarray(0, bruto.length - 16)), descifrador.final()])
      return claro
    }
  } catch (_) {}

  // 2) AES-CTR con el mismo contador que GCM (IV ‖ 00000002) y la etiqueta
  //    descartada: así se abre el cifrado antiguo, que reutilizaba el payload
  //    de GCM pero se servía sin verificación.
  try {
    if (iv.length === 12) {
      const contador = Buffer.concat([iv, Buffer.from([0, 0, 0, 2])])
      const descifrador = createDecipheriv('aes-256-ctr', clave, contador)
      return Buffer.concat([descifrador.update(bruto.subarray(0, bruto.length - 16)), descifrador.final()])
    }
  } catch (_) {}
  return null
}

/** Descifra `playback` y devuelve la lista de fuentes `{ url, label, height }`. */
export function descifrarPlayback(playback) {
  if (!playback || typeof playback !== 'object') return []
  const iva = playback.iv
  const cifrado = playback.payload
  if (!iva || !cifrado) return []

  for (const clave of clavesCandidatas(playback)) {
    const claro = leerPlayback(playback, iva, cifrado, clave)
    if (!claro) continue
    const texto = claro.toString('utf8').replace(/^\uFEFF/, '').trim()
    let datos = null
    try {
      datos = JSON.parse(texto)
    } catch (_) {
      // Algunas respuestas traen el JSON con barras escapadas de más.
      try { datos = JSON.parse(texto.replace(/\\\//g, '/')) } catch (_) { continue }
    }
    const fuentes = Array.isArray(datos?.sources) ? datos.sources : []
    const validas = fuentes
      .filter((fuente) => fuente && typeof fuente.url === 'string' && /^https?:\/\//i.test(fuente.url))
      .map((fuente) => ({
        url: fuente.url.replace(/\\u0026/gi, '&').replace(/\\\//g, '/'),
        label: String(fuente.label || fuente.quality || ''),
        height: Number(fuente.height) || 0,
      }))
    if (validas.length) return validas
  }
  return []
}

function mejorFuente(fuentes) {
  if (!fuentes?.length) return null
  const puntuar = (fuente) => {
    let puntos = Number(fuente.height) || 0
    const etiqueta = String(fuente.label || '').toLowerCase()
    const resolucion = /(\d{3,4})/.exec(etiqueta)
    if (resolucion) puntos += Number(resolucion[1]) / 10
    if (/\.m3u8|\/hls\//i.test(fuente.url)) puntos += 500
    if (/hls2/.test(etiqueta)) puntos += 40
    if (/\.txt$/.test(fuente.url)) puntos -= 200
    return puntos
  }
  return [...fuentes].sort((a, b) => puntuar(b) - puntuar(a))[0]
}

// ── Extracción desde el HTML ─────────────────────────────────────────────────

/** Desempaqueta un script p.a.c.k.e.r (radix 36/62) sin ejecutarlo. */
function desempaquetar(packed) {
  try {
    const coincidencia = String(packed).match(/}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/)
    if (!coincidencia) return null
    const carga = coincidencia[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    const base = parseInt(coincidencia[2], 10) || 36
    const diccionario = coincidencia[4].replace(/\\'/g, "'").split('|')
    return carga.replace(/\b\w+\b/g, (palabra) => {
      const indice = parseInt(palabra, base)
      return Number.isInteger(indice) && diccionario[indice] !== undefined && diccionario[indice] !== ''
        ? diccionario[indice]
        : palabra
    })
  } catch (_) {
    return null
  }
}

function limpiarUrl(valor, base) {
  const limpio = String(valor || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .trim()
  try {
    return new URL(limpio, base).href
  } catch (_) {
    return null
  }
}

/** Busca un `master.m3u8` (o un mp4 directo) dentro del HTML o de un script. */
function extraerMedioDeTexto(texto, base) {
  if (!texto) return null
  const fuentes = []

  for (const coincidencia of String(texto).matchAll(/["']([^"']*\.m3u8[^"']*)["']/gi)) {
    const url = limpiarUrl(coincidencia[1], base)
    if (url) fuentes.push(url)
  }
  for (const coincidencia of String(texto).matchAll(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi)) {
    const url = limpiarUrl(coincidencia[0], base)
    if (url) fuentes.push(url)
  }
  if (!fuentes.length) {
    for (const patron of [
      /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i,
      /["']?file["']?\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
      /["']?src["']?\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
      /["'](https?:[^"']+\.mp4[^"']*)["']/i,
    ]) {
      const coincidencia = String(texto).match(patron)
      const url = coincidencia?.[1] ? limpiarUrl(coincidencia[1], base) : null
      if (url) fuentes.push(url)
    }
  }

  const unicas = [...new Set(fuentes)].filter((url) => urlPublica(url))
  if (!unicas.length) return null
  return unicas.find((url) => /master\.m3u8|\/hls/i.test(url)) || unicas[0]
}

// Títulos que Byse pone por defecto en el cascarón del embed. No sirven como
// nombre de archivo: son todos iguales y no dicen nada del vídeo.
const TITULO_GENERICO = /^(?:byse(?:\s+(?:frontend|player|video|stream)|\s*[-|·].*)?|video\s*player|player|watch|loading|embed|home|dashboard|login)$/i

function esTituloGenerico(valor) {
  const limpio = String(valor || '').replace(/\s+/g, ' ').trim()
  if (!limpio || limpio.length > 140) return true
  if (TITULO_GENERICO.test(limpio)) return true
  // "Byse Frontend", "Byse - Watch", "Video player | Byse"…
  return /^byse\b/i.test(limpio) && limpio.split(/\s+/).length <= 3
}

function extraerTitulo(html, codigo) {
  const crudo = String(html || '')
  const og = crudo.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  const tituloEl = crudo.match(/<title[^>]*>([^<]+)<\/title>/i)
  const json = crudo.match(/"title"\s*:\s*"([^"]{2,180})"/)
  const valor = (og?.[1] || json?.[1] || tituloEl?.[1] || '').replace(/\s+/g, ' ').trim()
  if (esTituloGenerico(valor)) return codigo
  const limpio = valor
    .replace(/\s*[-|·]\s*Byse.*$/i, '')
    .replace(/\.(?:mp4|mkv|webm)$/i, '')
    .trim()
    .slice(0, 140)
  return esTituloGenerico(limpio) ? codigo : limpio
}

// ── Reto de acceso (challenge → attest → captcha PoW → playback) ────────────

const POW_INIT = -1640531535
const POW_FINAL = -2048144777

function rotarIzquierda(valor, bits) {
  return ((valor << bits) | (valor >>> (32 - bits))) | 0
}

/**
 * Hash propio de Byse para el PoW: no es SHA ni MD5, es un generador de 512
 * palabras con rondas tipo ChaCha y una mezcla final. Portado 1:1 del
 * extractor público (Kotlin) que resolvía este mismo captcha.
 */
export function powHash(entrada) {
  let s0 = 1779033703
  let s1 = -1150833019
  let s2 = 1013904242
  let s3 = -1521486534

  const ronda = () => {
    s0 = (s0 + s1) | 0; s3 = rotarIzquierda(s3 ^ s0, 16)
    s2 = (s2 + s3) | 0; s1 = rotarIzquierda(s1 ^ s2, 12)
    s0 = (s0 + s1) | 0; s3 = rotarIzquierda(s3 ^ s0, 8)
    s2 = (s2 + s3) | 0; s1 = rotarIzquierda(s1 ^ s2, 7)
  }

  for (let i = 0; i < entrada.length; i++) {
    s0 = rotarIzquierda((s0 + (entrada[i] & 0xff)) | 0, 7)
    ronda()
  }
  for (let i = 0; i < 8; i++) ronda()

  const buffer = new Int32Array(512)
  for (let i = 0; i < 512; i++) {
    ronda()
    buffer[i] = s0 ^ s2
  }

  for (let vuelta = 0; vuelta < 2; vuelta++) {
    for (let i = 0; i < 512; i++) {
      let mezcla = (buffer[i] + buffer[buffer[i] & 511]) | 0
      mezcla = rotarIzquierda(mezcla, 13)
      mezcla = mezcla ^ Math.imul(buffer[(i + 1) & 511], POW_INIT)
      buffer[i] = mezcla
      s0 = s0 ^ mezcla
      ronda()
    }
  }
  ronda()

  let salida = s0
  for (let i = 0; i < 64; i++) {
    const valor = buffer[i]
    salida = rotarIzquierda((salida + valor) | 0, 5) ^ Math.imul(valor, POW_FINAL)
  }
  return (salida ^ s2) | 0
}

/**
 * Busca el contador cuyo hash arranca con `dificultad` bits en cero.
 * Va por tandas y cede el turno al bucle de eventos para no bloquear al bot.
 */
export async function resolverPow(nonce, dificultad, signal) {
  const objetivo = Math.min(Math.max(Number(dificultad) || 16, 1), 32)
  const prefijo = Buffer.from(`${nonce}:`, 'latin1')
  const limite = Date.now() + TIEMPO_MAX_POW_MS
  let contador = 0

  while (contador < POW_MAX_ITER) {
    const fin = Math.min(contador + POW_LOTE, POW_MAX_ITER)
    for (; contador < fin; contador++) {
      const entrada = Buffer.concat([prefijo, Buffer.from(String(contador), 'latin1')])
      if (Math.clz32(powHash(entrada)) >= objetivo) return String(contador)
    }
    if (signal?.aborted) throw errorAbortado()
    if (Date.now() > limite) break
    await new Promise((resolver) => setImmediate(resolver))
  }
  log('PoW sin solución', { dificultad: objetivo, iteraciones: contador })
  return null
}

function huellaCliente() {
  const anchos = [1920, 2560, 1366, 1440, 1680]
  const altos = [1080, 1440, 768, 900, 1050]
  const indice = Math.floor(Math.random() * anchos.length)
  const aleatorio = () => aB64url(randomBytes(32))
  return {
    user_agent: UA,
    pixel_ratio: 1,
    screen_width: anchos[indice],
    screen_height: altos[indice],
    color_depth: 24,
    languages: ['es-419', 'es', 'en-US'],
    timezone: 'America/Lima',
    hardware_concurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
    touch_points: 0,
    webgl_vendor: 'Intel',
    webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)',
    canvas_hash: aleatorio(),
    audio_hash: aleatorio(),
    webgl_params_hash: aleatorio(),
    fonts_hash: aleatorio(),
    codecs_hash: aleatorio(),
    media_devices: 'ai0ao0vi0',
    pointer_type: 'fine,hover',
    extra: { vendor: '', appVersion: '5.0 (Windows)' },
  }
}

/**
 * Completa el reto de acceso del reproductor y devuelve `playback`.
 * Devuelve null (sin lanzar) cuando el host aún no exige reto o lo rechaza:
 * el llamador sigue con las otras estrategias.
 */
async function obtenerPlaybackConReto(host, codigo, parentUrl, signal) {
  const origen = `https://${host}`
  const cabecerasApi = { Referer: `${origen}/`, Origin: origen, Accept: '*/*' }
  const cabecerasReto = { ...cabecerasApi, Referer: parentUrl || `${origen}/` }

  let reto
  try {
    reto = await pedirPost(`${origen}/api/videos/access/challenge`, {}, { cabeceras: cabecerasReto, timeout: TIEMPO_API_MS, signal })
  } catch (error) {
    log('challenge no disponible', { host, error: error?.message || String(error) })
    return null
  }
  let datosReto
  try { datosReto = JSON.parse(reto.texto) } catch (_) { return null }
  if (!datosReto?.nonce || !datosReto?.challenge_id) {
    log('challenge vacío', { host })
    return null
  }

  // attest: se firma el nonce con una clave ECDSA P-256 efímera y se manda la
  // clave pública en JWK, igual que hace el reproductor en el navegador.
  let firma
  let jwk
  try {
    const par = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    firma = aB64url(firmar('sha256', Buffer.from(String(datosReto.nonce), 'utf8'), { key: par.privateKey, dsaEncoding: 'ieee-p1363' }))
    jwk = par.publicKey.export({ format: 'jwk' })
  } catch (error) {
    log('no pude generar la firma ECDSA', { error: error?.message || String(error) })
    return null
  }

  let attest
  try {
    const respuesta = await pedirPost(`${origen}/api/videos/access/attest`, {
      viewer_id: '',
      device_id: '',
      challenge_id: datosReto.challenge_id,
      nonce: datosReto.nonce,
      signature: firma,
      public_key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      client: huellaCliente(),
      storage: {},
      attributes: { entropy: 'low' },
    }, { cabeceras: cabecerasReto, timeout: TIEMPO_API_MS, signal })
    attest = JSON.parse(respuesta.texto)
  } catch (error) {
    log('attest rechazado', { host, error: error?.message || String(error) })
    return null
  }
  if (!attest?.token) {
    log('attest sin token', { host })
    return null
  }

  const huella = {
    token: attest.token,
    viewer_id: attest.viewer_id || '',
    device_id: attest.device_id || '',
    confidence: attest.confidence ?? 0.5,
  }
  const cookies = [huella.viewer_id && `byse_viewer_id=${huella.viewer_id}`, huella.device_id && `byse_device_id=${huella.device_id}`]
    .filter(Boolean)
    .join('; ')
  const cabecerasEmbed = {
    ...cabecerasApi,
    'X-Embed-Origin': host,
    'X-Embed-Referer': `${origen}/`,
    'X-Embed-Parent': parentUrl || `${origen}/`,
    ...(cookies ? { Cookie: cookies } : {}),
  }

  let captcha
  try {
    const respuesta = await pedirPost(`${origen}/api/videos/${codigo}/embed/captcha`, { fingerprint: huella }, { cabeceras: cabecerasEmbed, timeout: TIEMPO_API_MS, signal })
    captcha = JSON.parse(respuesta.texto)
  } catch (error) {
    log('captcha no disponible', { host, error: error?.message || String(error) })
    return null
  }
  if (!captcha?.pow_nonce || !captcha?.pow_token) {
    log('captcha vacío', { host })
    return null
  }

  const inicio = Date.now()
  const solucion = await resolverPow(captcha.pow_nonce, captcha.pow_difficulty ?? 16, signal)
  if (solucion == null) return null
  log('PoW resuelto', { host, dificultad: captcha.pow_difficulty ?? 16, ms: Date.now() - inicio })

  let verificacion
  try {
    const respuesta = await pedirPost(`${origen}/api/videos/${codigo}/embed/captcha/verify`, {
      pow_token: captcha.pow_token,
      solution: solucion,
      fingerprint: huella,
    }, { cabeceras: cabecerasEmbed, timeout: TIEMPO_API_MS, signal })
    verificacion = JSON.parse(respuesta.texto)
  } catch (error) {
    log('verify rechazado', { host, error: error?.message || String(error) })
    return null
  }
  if (verificacion?.status !== 'ok' || !verificacion?.token) {
    log('verify sin token', { host, status: verificacion?.status || 'desconocido' })
    return null
  }

  try {
    const respuesta = await pedirPost(`${origen}/api/videos/${codigo}/embed/playback`, { fingerprint: huella }, {
      cabeceras: { ...cabecerasEmbed, 'X-Captcha-Token': verificacion.token },
      timeout: TIEMPO_API_MS,
      signal,
    })
    const datos = JSON.parse(respuesta.texto)
    return datos?.playback || null
  } catch (error) {
    log('playback rechazado', { host, error: error?.message || String(error) })
    return null
  }
}

// ── Cadena de resolución ─────────────────────────────────────────────────────

async function fuentesDesdeApi(host, codigo, parentUrl, signal) {
  try {
    const { datos } = await pedirJson(`https://${host}/api/videos/${codigo}`, {
      cabeceras: { Referer: parentUrl || `https://${host}/`, Accept: 'application/json' },
      timeout: TIEMPO_API_MS,
      signal,
    })
    const fuentes = descifrarPlayback(datos?.playback)
    if (fuentes.length) {
      return {
        fuentes,
        titulo: typeof datos?.title === 'string' ? datos.title : '',
        estado: datos?.processing?.encoding?.state || '',
        origen: `api:${host}`,
      }
    }
    if (datos?.processing?.encoding?.state) {
      return { fuentes: [], titulo: typeof datos?.title === 'string' ? datos.title : '', estado: datos.processing.encoding.state, origen: `api:${host}` }
    }
    return null
  } catch (error) {
    log('API sin playback', { host, codigo, error: error?.message || String(error) })
    return null
  }
}

async function embedDesdeApi(host, codigo, signal) {
  try {
    const { datos } = await pedirJson(`https://${host}/api/videos/${codigo}/embed/details`, {
      cabeceras: { Referer: `https://${host}/`, Accept: 'application/json' },
      timeout: TIEMPO_API_MS,
      signal,
    })
    const marco = urlPublica(datos?.embed_frame_url || datos?.embed_url || '')
    if (!marco) return null
    const partes = marco.pathname.split('/').filter(Boolean)
    const nuevoCodigo = partes[partes.length - 1]?.replace(/\.html?$/i, '') || codigo
    return {
      host: marco.hostname.toLowerCase(),
      codigo: nuevoCodigo,
      parent: marco.href,
      titulo: typeof datos?.title === 'string' ? datos.title : '',
    }
  } catch (_) {
    return null
  }
}

/**
 * Resuelve el enlace de vídeo real. Prueba, en orden: el HTML de la página,
 * la API del host, el reto de acceso y, si la API apunta a otro host (el
 * reproductor vive en un dominio distinto), se repite la cadena allí.
 */
async function resolverFuente(info, signal) {
  const notas = []
  const vistos = new Set()
  let host = info.host
  let codigo = info.code
  let parent = `https://${info.host}/`
  let titulo = ''
  let estadoCodificacion = ''

  // 1) HTML de la página: algunos embeds antiguos dejan el m3u8 a la vista.
  const paginas = [`https://${host}/e/${codigo}`, `https://${host}/d/${codigo}`, `https://${host}/${codigo}`]
  for (const pagina of paginas) {
    let respuesta
    try {
      respuesta = await pedir(pagina, { cabeceras: CABECERAS_BASE, timeout: TIEMPO_PAGINA_MS, signal })
    } catch (error) {
      if (esCancelacion(error)) throw error
      notas.push(`${pagina}: ${error?.message || error}`)
      continue
    }
    const tituloPagina = extraerTitulo(respuesta.texto, '')
    if (tituloPagina && !titulo) titulo = tituloPagina
    let medio = extraerMedioDeTexto(respuesta.texto, respuesta.url || pagina)
    if (!medio) {
      const empaquetado = respuesta.texto.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      if (empaquetado) medio = extraerMedioDeTexto(desempaquetar(empaquetado[0]) || '', respuesta.url || pagina)
    }
    if (medio) {
      log('fuente encontrada en HTML', { host, codigo, url: medio.slice(0, 120) })
      return { url: medio, referer: `https://${host}/`, titulo, notas }
    }
    if (respuesta.url && respuesta.url !== pagina) {
      const destino = urlPublica(respuesta.url)
      if (destino && esHostByse(destino.hostname)) {
        const partes = destino.pathname.split('/').filter(Boolean)
        const posible = partes[partes.length - 1]?.replace(/\.html?$/i, '')
        if (posible && /^[A-Za-z0-9_-]{4,32}$/.test(posible) && destino.hostname !== host) {
          host = destino.hostname.toLowerCase()
          codigo = posible
        }
      }
    }
    break
  }

  // 2) API + reto + salto al host del reproductor.
  for (let nivel = 0; nivel < 3; nivel++) {
    const huella = `${host}|${codigo}`
    if (vistos.has(huella)) break
    vistos.add(huella)

    const directa = await fuentesDesdeApi(host, codigo, parent, signal)
    if (directa?.titulo && !titulo && !esTituloGenerico(directa.titulo)) titulo = directa.titulo

    if (directa?.estado) estadoCodificacion = directa.estado
    const elegida = mejorFuente(directa?.fuentes)
    if (elegida) {
      log('fuente encontrada por API', { host, codigo, url: elegida.url.slice(0, 120) })
      return { url: elegida.url, referer: `https://${host}/`, titulo, notas }
    }

    const playback = await obtenerPlaybackConReto(host, codigo, parent, signal)
    const conReto = mejorFuente(descifrarPlayback(playback))
    if (conReto) {
      log('fuente encontrada por reto', { host, codigo, url: conReto.url.slice(0, 120) })
      return { url: conReto.url, referer: `https://${host}/`, titulo, notas }
    }

    const siguiente = await embedDesdeApi(host, codigo, signal)
    if (!siguiente || !esHostByse(siguiente.host)) break
    if (siguiente.titulo && !titulo && !esTituloGenerico(siguiente.titulo)) titulo = siguiente.titulo
    host = siguiente.host
    codigo = siguiente.codigo
    parent = siguiente.parent
  }

  const esperando = /pending|processing|queued|encoding/i.test(estadoCodificacion)
  const detalle = esperando
    ? `El vídeo todavía se está codificando en Byse (estado: ${estadoCodificacion}). Inténtalo en unos minutos.`
    : `No pude extraer el vídeo. ${notas.slice(-3).join(' | ')}`
  const error = new Error(detalle.trim())
  error.notas = notas
  throw error
}

// ── Descarga ─────────────────────────────────────────────────────────────────

let rutaFfmpeg = null
async function getFfmpeg() {
  if (rutaFfmpeg) return rutaFfmpeg

  // Permite fijar explícitamente el binario (por ejemplo /usr/bin/ffmpeg).
  const configurado = String(process.env.FFMPEG_PATH || '').trim()
  if (configurado) {
    rutaFfmpeg = configurado
    log('se usará FFMPEG_PATH', { ruta: rutaFfmpeg })
    return rutaFfmpeg
  }

  // Prefiere FFmpeg del sistema: en algunos VPS el binario de ffmpeg-static
  // arranca pero se cae al procesar ciertos manifiestos HLS.
  for (const ruta of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try {
      await access(ruta, fsConstants.X_OK)
      rutaFfmpeg = ruta
      log('se usará FFmpeg del sistema', { ruta })
      return rutaFfmpeg
    } catch (_) {}
  }

  try {
    const modulo = await import('ffmpeg-static')
    const ruta = modulo?.default || modulo
    if (typeof ruta === 'string' && ruta) {
      rutaFfmpeg = ruta
      return rutaFfmpeg
    }
  } catch (_) {}
  log('no se encontró FFmpeg estático ni en rutas habituales; se usará el PATH')
  rutaFfmpeg = 'ffmpeg'
  return rutaFfmpeg
}

function cabecerasFfmpeg(url, referer) {
  const origen = (() => {
    try { return new URL(referer || url).origin + '/' } catch (_) { return '' }
  })()
  const pares = { 'User-Agent': UA, Referer: referer || origen, Origin: origen.replace(/\/$/, '') }
  return Object.entries(pares)
    .filter(([, valor]) => valor)
    .map(([nombre, valor]) => `${nombre}: ${String(valor).replace(/[\r\n]/g, '')}\r\n`)
    .join('')
}

// Líneas que escribe `-progress`: sirven para el porcentaje, nunca como excusa
// de error. Antes acababan en el mensaje al usuario ("ffmpeg stats and
// -progress period set to 2"), tapando el motivo real.
const RUIDO_FFMPEG = /^(?:out_time(?:_us|_ms)?|speed|bitrate|total_size|frame|fps|progress|dup_frames|drop_frames|stream_\d+_\d+_q|stats_period)\s*=/i

function unaLinea(valor, maximo = 200) {
  return String(valor || '').replace(/\s+/g, ' ').trim().slice(0, maximo)
}

/**
 * Corre ffmpeg y devuelve el motivo real de un fallo.
 *
 * `code` nulo en el evento `close` significa que el proceso murió por una
 * señal (SIGKILL por memoria, SIGSEGV por binario incompatible, SIGTERM…), no
 * que ffmpeg "terminara mal": el mensaje tiene que decirlo.
 */
function correrFfmpeg(binario, argumentos, { salida, signal, alProgresar }) {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(binario, argumentos, { stdio: ['ignore', 'ignore', 'pipe'] })
    const diagnosticos = []
    let duracion = 0
    let bytesSalida = 0
    let ultimoAviso = 0
    let velocidad = ''
    let pendiente = ''
    let detenido = false

    const matar = () => {
      detenido = true
      try { hijo.kill('SIGKILL') } catch (_) {}
    }
    const temporizador = setTimeout(() => {
      log('ffmpeg agotó el tiempo', { limiteMin: Math.round(TIEMPO_MAX_DESCARGA_MS / 60000) })
      matar()
    }, TIEMPO_MAX_DESCARGA_MS)
    const alAbortar = () => matar()
    if (signal) {
      if (signal.aborted) alAbortar()
      else signal.addEventListener('abort', alAbortar, { once: true })
    }

    hijo.stderr.on('data', (trozo) => {
      pendiente += trozo.toString()
      const lineas = pendiente.split(/\r?\n/)
      pendiente = lineas.pop() || ''
      for (const linea of lineas) {
        const limpia = linea.trim()
        if (!limpia) continue

        const marca = /^Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(limpia)
        if (marca && !duracion) {
          duracion = Number(marca[1]) * 3600 + Number(marca[2]) * 60 + Number(marca[3])
        }

        // El progreso se interpreta ANTES de descartar el ruido: `out_time` y
        // `speed` son líneas distintas de `-progress`, así que la velocidad se
        // guarda y se adjunta al siguiente avance.
        const rapidez = /^speed=\s*([\d.]+)x/i.exec(limpia)
        if (rapidez) velocidad = rapidez[1]

        const tamanio = /^total_size=(\d+)/i.exec(limpia)
        if (tamanio) bytesSalida = Number(tamanio[1])

        const avance = /^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(limpia)
        if (avance && Date.now() - ultimoAviso >= 900) {
          ultimoAviso = Date.now()
          const visto = Number(avance[1]) * 3600 + Number(avance[2]) * 60 + Number(avance[3])
          alProgresar?.({ visto, total: duracion, velocidad: velocidad || null, bytesSalida })
        }
        if (RUIDO_FFMPEG.test(limpia)) continue

        diagnosticos.push(limpia)
        if (diagnosticos.length > 40) diagnosticos.shift()
      }
    })

    hijo.once('error', (error) => {
      clearTimeout(temporizador)
      signal?.removeEventListener?.('abort', alAbortar)
      if (signal?.aborted) return rechazar(errorAbortado())
      const faltante = error?.code === 'ENOENT'
      rechazar(new Error(faltante
        ? `No encuentro ffmpeg (${binario}). Instala ffmpeg-static o define FFMPEG_PATH; sin él no puedo unir el HLS.`
        : `ffmpeg no pudo arrancar: ${error?.message || error}`))
    })

    hijo.once('close', (codigo, senal) => {
      clearTimeout(temporizador)
      signal?.removeEventListener?.('abort', alAbortar)
      if (signal?.aborted) return rechazar(errorAbortado())
      if (detenido) {
        const error = new Error('ffmpeg se detuvo antes de terminar (tiempo límite o cancelación).')
        error.detenido = true
        return rechazar(error)
      }
      if (codigo === 0) return resolver(salida)

      const detalle = unaLinea(diagnosticos.slice(-4).join(' | '), 300) || 'sin diagnóstico'
      const error = new Error(senal
        ? `ffmpeg murió por la señal ${senal}${senal === 'SIGKILL' ? ' (sin memoria o cancelado por el sistema)' : ''}: ${detalle}`
        : `ffmpeg terminó con código ${codigo}: ${detalle}`)
      error.senal = senal || null
      error.codigoFfmpeg = codigo
      error.diagnostico = detalle
      rechazar(error)
    })
  })
}

/** ¿Vale la pena reintentar sin `-bsf:a` / sin `+faststart` con este error? */
function errorReintentable(error) {
  if (!error || error.cancelado || error.detenido) return false
  const texto = `${error.message || ''} ${error.diagnostico || ''}`
  // Señales: SIGKILL suele ser memoria (faststart con archivos grandes) y
  // SIGSEGV un build roto, pero un reintento más ligero a veces pasa.
  return /Invalid data|adts|aac|bitstream|not supported|unsupported|moov|faststart|SIGKILL|SIGSEGV|Conversion failed|Error while opening/i.test(texto)
}

/**
 * Baja un HLS (troceado) y lo remuxea a mp4 sin recodificar.
 *
 * Va por intentos de menos a más: `+faststart` exige reservar el moov en
 * memoria y con vídeos largos el proceso se queda sin memoria y muere. Se
 * reintenta sin el `-bsf` de audio y, al final, sin `+faststart` (el mp4 queda
 * reproducible igual, solo que el índice va al final).
 */
async function descargarHls({ url, referer, salida, signal, alProgresar }) {
  const binario = await getFfmpeg()
  const inicioFfmpeg = Date.now()
  log('FFmpeg iniciado: uniendo segmentos HLS sin recodificar', { binario, contenedor: 'MP4' })
  const base = [
    '-hide_banner', '-loglevel', 'info', '-nostdin', '-y',
    '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
    '-user_agent', UA,
    '-headers', cabecerasFfmpeg(url, referer),
    '-rw_timeout', '20000000',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '403,408,429,500,502,503,504',
    '-reconnect_delay_max', '5',
    '-progress', 'pipe:2', '-stats_period', '2',
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
  ]

  const variantes = [
    { etiqueta: 'normal', extra: ['-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'] },
    { etiqueta: 'sin bsf de audio', extra: ['-movflags', '+faststart'] },
    { etiqueta: 'sin faststart (ahorra memoria)', extra: [] },
  ]

  const errores = []
  let ultimoError = null
  for (const [indice, variante] of variantes.entries()) {
    if (signal?.aborted) throw errorAbortado()
    if (indice > 0) {
      log('reintentando ffmpeg', { variante: variante.etiqueta, anterior: unaLinea(errores.at(-1), 180) })
      await rm(salida, { force: true }).catch(() => {})
      alProgresar?.({ visto: 0, total: 0, velocidad: null, reintento: variante.etiqueta })
    }
    try {
      await correrFfmpeg(binario, [...base, ...variante.extra, '-f', 'mp4', salida], { salida, signal, alProgresar })
      if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write('\n')
      log('FFmpeg terminó correctamente', { variante: variante.etiqueta, segundos: Math.round((Date.now() - inicioFfmpeg) / 1000) })
      if (indice > 0) log('ffmpeg funcionó con la variante ligera', { variante: variante.etiqueta })
      return salida
    } catch (error) {
      if (esCancelacion(error) || error.detenido) throw error
      errores.push(`${variante.etiqueta}: ${error.message}`)
      ultimoError = error
      if (!errorReintentable(error)) break
    }
  }

  const error = new Error(ultimoError?.message || 'ffmpeg no pudo procesar el HLS.')
  error.intentos = errores
  throw error
}

/** Baja un mp4 directo por streaming, con límite de tamaño y progreso. */
async function descargarDirecto({ url, referer, salida, signal, alProgresar }) {
  const respuesta = await axios.get(url, {
    responseType: 'stream',
    headers: { ...CABECERAS_BASE, Accept: '*/*', Referer: referer || '' },
    timeout: 120_000,
    maxRedirects: 8,
    signal,
    validateStatus: (status) => status >= 200 && status < 400,
  })

  const tipo = String(respuesta.headers['content-type'] || '').toLowerCase()
  const total = Number(respuesta.headers['content-length'] || 0)
  if (/text\/html|application\/json/i.test(tipo)) {
    respuesta.data.destroy()
    throw new Error('El servidor devolvió una página en lugar del vídeo.')
  }
  if (total > MAX_DESCARGA_BYTES) {
    respuesta.data.destroy()
    throw new Error(`El archivo supera el límite de ${formatearBytes(MAX_DESCARGA_BYTES)}.`)
  }

  let descargado = 0
  let ultimoAviso = 0
  const medidor = new Transform({
    transform(trozo, _codificacion, siguiente) {
      descargado += trozo.length
      if (descargado > MAX_DESCARGA_BYTES) {
        return siguiente(new Error(`El archivo supera el límite de ${formatearBytes(MAX_DESCARGA_BYTES)}.`))
      }
      if (Date.now() - ultimoAviso >= 1000) {
        ultimoAviso = Date.now()
        alProgresar?.({ visto: descargado, total, velocidad: null })
      }
      siguiente(null, trozo)
    },
  })

  try {
    await pipeline(respuesta.data, medidor, createWriteStream(salida), { signal })
  } catch (error) {
    await rm(salida, { force: true }).catch(() => {})
    if (esCancelacion(error) || signal?.aborted) throw errorAbortado()
    throw error
  }
  return salida
}

function nombreSeguro(titulo, codigo) {
  // `[\/:*?"<>|]` no vale en Windows y `/` partiría la ruta en Linux.
  const base = String(titulo || codigo || 'byse')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  return base || `byse-${codigo}`
}

export async function downloadByseFile(inputUrl, outputPath, options = {}) {
  const info = parseByseUrl(inputUrl)
  const signal = options.signal || new AbortController().signal
  const fuente = await resolverFuente(info, signal)
  if (signal.aborted) throw errorAbortado()
  if (/\.m3u8|\/hls\//i.test(fuente.url)) {
    await descargarHls({ url: fuente.url, referer: fuente.referer, salida: outputPath, signal, alProgresar: options.onProgress })
  } else {
    try {
      await descargarDirecto({ url: fuente.url, referer: fuente.referer, salida: outputPath, signal, alProgresar: options.onProgress })
    } catch (error) {
      if (esCancelacion(error) || signal.aborted) throw error
      await descargarHls({ url: fuente.url, referer: fuente.referer, salida: outputPath, signal, alProgresar: options.onProgress })
    }
  }
  const archivo = await stat(outputPath)
  if (!archivo.size || archivo.size < MIN_BYTES_VALIDOS) {
    await rm(outputPath, { force: true }).catch(() => {})
    throw new Error('La descarga de Byse quedó vacía o incompleta.')
  }
  return { filePath: outputPath, fileSize: archivo.size, extension: '.mp4', mimetype: 'video/mp4', title: fuente.titulo || info.code }
}

// ── Handler ──────────────────────────────────────────────────────────────────

const handler = async (m, { conn, text, args, usedPrefix, command, prefix }) => {
  const entrada = buscarEnlace(text || (args || []).join(' ') || (m.quoted && (m.quoted.text || m.quoted.caption)) || '')
  const ejemplo = `${usedPrefix || prefix || '.'}${command || 'byse'} https://byse.sx/e/1vtkmhfb44rj`

  if (!entrada) {
    return m.reply(
      `🎬 *Byse Downloader*\n\n` +
      `Envía (o responde a) un enlace de *byse.sx*.\n` +
      `_Ejemplo:_ ${ejemplo}\n` +
      `_También acepto solo el código:_ ${usedPrefix || prefix || '.'}${command || 'byse'} 1vtkmhfb44rj`,
    )
  }

  let info
  try {
    info = parseByseUrl(entrada)
  } catch (error) {
    return m.reply(`❌ ${error?.message || error}`)
  }

  const clave = downloadKey(m)
  if (hasDownload(clave, 'byse')) {
    return m.reply('⚠️ Ya tienes una descarga de Byse en curso en este chat. Usa *.cancelar byse* para detenerla.')
  }

  const controlador = new AbortController()
  const { signal } = controlador
  const reaccionar = async (emoji) => {
    try {
      await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
    } catch (_) {}
  }

  let carpeta = null
  let llaveEstado = null

  const editarEstado = async (texto) => {
    if (!llaveEstado) return false
    try {
      await conn.sendMessage(m.chat, { text: texto, edit: llaveEstado }, { quoted: m })
      return true
    } catch (_) {
      return false
    }
  }

  // Si el fallo ocurre antes de tener mensaje de estado (resolución del
  // enlace), editar no sirve: hay que contestar de forma normal.
  const notificar = async (texto) => {
    if (await editarEstado(texto)) return
    try { await m.reply(texto) } catch (_) {}
  }

  try {
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    log('nueva descarga', { codigo: info.code, host: info.host })
    await reaccionar('⏳')
    const estado = await conn.sendMessage(m.chat, {
      text: `🔎 *Byse* · buscando el vídeo...\n_Código:_ \`${info.code}\``,
    }, { quoted: m })
    llaveEstado = estado?.key || null

    const detenerResolucion = iniciarSpinnerTerminal(`Resolviendo enlace Byse (${info.code})...`)
    let fuente
    try {
      fuente = await resolverFuente(info, signal)
      detenerResolucion(`✓ Enlace resuelto: ${fuente.titulo || info.code}`)
    } catch (error) {
      detenerResolucion(`✗ No se pudo resolver: ${unaLinea(error?.message || error, 120)}`)
      throw error
    }
    if (signal.aborted) throw errorAbortado()
    const titulo = fuente.titulo || info.code
    log('fuente resuelta', { host: info.host, codigo: info.code, titulo, hls: /\.m3u8|\/hls/i.test(fuente.url) })

    await editarEstado(`🎬 *${titulo}*\n📡 _Servidor resuelto. Descargando..._\n_Usa_ *.cancelar byse* _para detener._`)

    carpeta = await mkdtemp(join(tmpdir(), 'rikka-byse-'))
    const base = nombreSeguro(titulo, info.code)
    const salida = join(carpeta, `${base}.mp4`)

    let ultimoTexto = ''
    let ultimoEnvio = 0
    let ultimoVisto = 0
    let ultimoBytesFfmpeg = 0
    let ultimaVelocidad = ''
    const esHls = /\.m3u8|\/hls/i.test(fuente.url)
    const inicioDescarga = Date.now()
    log('descarga iniciada', { titulo, tipo: esHls ? 'HLS' : 'directa' })
    const alProgresar = ({ visto, total, velocidad, bytesSalida, reintento }) => {
      // ffmpeg manda el avance (out_time) y la velocidad (speed) en líneas
      // distintas: se combinan aquí para no perder ninguna de las dos.
      if (reintento) {
        ultimoVisto = 0
        ultimoBytesFfmpeg = 0
        ultimaVelocidad = ''
        progresoTerminal({ visto: 0, total: 0, reintento })
        return editarEstado(`🔁 *${titulo}*\n_Reintentando con un modo más ligero (${reintento})..._`)
      }
      if (Number(visto) >= 0) ultimoVisto = Number(visto)
      if (Number(bytesSalida) >= 0) ultimoBytesFfmpeg = Number(bytesSalida || 0)
      if (velocidad) ultimaVelocidad = String(velocidad)
      progresoTerminal({ visto: ultimoVisto, total, velocidad: ultimaVelocidad, bytesSalida: ultimoBytesFfmpeg, modo: esHls ? 'hls' : 'directo' })
      const porcentaje = total > 0 ? Math.min(100, (ultimoVisto / total) * 100) : null
      const llenas = porcentaje == null ? 0 : Math.round(porcentaje / 100 * 14)
      const barra = porcentaje == null ? '' : `${'█'.repeat(llenas)}${'░'.repeat(14 - llenas)}`
      const cola = `${ultimaVelocidad ? ` · ⚡ ${ultimaVelocidad}x` : ''}`
      const texto = porcentaje == null
        ? `📥 *${titulo}*\n📦 ${formatearBytes(ultimoVisto)}${cola}`
        : `📥 *${titulo}*\n\`[${barra}] ${porcentaje.toFixed(1)}%\`\n📦 ${formatearBytes(ultimoVisto)} / ${formatearBytes(total)}${cola}`
      if (texto === ultimoTexto) return
      if (Date.now() - ultimoEnvio < INTERVALO_ESTADO_MS) return
      ultimoTexto = texto
      ultimoEnvio = Date.now()
      editarEstado(texto)
    }

    const registro = startDownload(clave, 'byse', controlador, { label: `🎬 Byse · ${titulo}` })
    try {
      if (/\.m3u8|\/hls\//i.test(fuente.url)) {
        await descargarHls({ url: fuente.url, referer: fuente.referer, salida, signal, alProgresar })
      } else {
        try {
          await descargarDirecto({ url: fuente.url, referer: fuente.referer, salida, signal, alProgresar })
        } catch (error) {
          if (esCancelacion(error)) throw error
          // Si el "mp4" era en realidad un manifiesto, ffmpeg aún puede salvarlo.
          log('descarga directa falló; reintentando como HLS', { error: error?.message || String(error) })
          await descargarHls({ url: fuente.url, referer: fuente.referer, salida, signal, alProgresar })
        }
      }
    } finally {
      registro()
    }

    if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write('\n')

    if (signal.aborted) throw errorAbortado()

    const archivo = await stat(salida)
    if (!archivo.size || archivo.size < MIN_BYTES_VALIDOS) {
      throw new Error('La descarga quedó vacía o incompleta. Puede que el vídeo aún se esté procesando.')
    }

    log('descarga terminada', { titulo, bytes: archivo.size, tamano: formatearBytes(archivo.size), segundos: Math.round((Date.now() - inicioDescarga) / 1000) })
    await editarEstado(`📤 *${titulo}*\n⚖️ ${formatearBytes(archivo.size)}\n_Subiendo a WhatsApp..._`)

    const detenerSubida = iniciarSpinnerTerminal(`Subiendo ${formatearBytes(archivo.size)} a WhatsApp (Baileys no informa porcentaje)...`)
    const inicioSubida = Date.now()
    try {
      await conn.sendMessage(m.chat, {
        document: { url: salida },
        fileName: `${base}.mp4`,
        mimetype: 'video/mp4',
        caption: `✅ *${titulo}*\n📦 ${formatearBytes(archivo.size)}\n🌐 Byse · \`${info.code}\``,
      }, { quoted: m })
      detenerSubida(`✓ Subida completada en ${formatearTiempo((Date.now() - inicioSubida) / 1000)}`)
    } catch (error) {
      detenerSubida(`✗ Falló la subida: ${unaLinea(error?.message || error, 120)}`)
      throw error
    }

    await editarEstado(`✅ *${titulo}*\n📦 ${formatearBytes(archivo.size)}\n_Enviado._`)
    await reaccionar('✅')
    log('envío completado', { codigo: info.code, bytes: archivo.size })
  } catch (error) {
    if (esCancelacion(error) || signal.aborted) {
      await notificar('🚫 *Descarga cancelada.*')
      await reaccionar('🚫')
      return
    }
    const mensaje = String(error?.message || error || 'error desconocido')
    if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write('\n')
    log('descarga fallida', { codigo: info.code, error: unaLinea(mensaje, 200) })
    console.error('[Byse-DL]', error?.stack || mensaje)
    await reaccionar('❌')
    const propio = /supera el límite|No pude extraer|todavía se está codificando|No pude conectar|No encuentro ffmpeg|ffmpeg murió|ffmpeg terminó/i.test(mensaje)
    const intentos = Array.isArray(error?.intentos) && error.intentos.length > 1
      ? `\n_Intentos:_ ${error.intentos.map((intento) => unaLinea(intento, 150)).join(' · ')}`
      : ''
    const detalle = `${propio ? mensaje : `No pude completar la descarga: ${mensaje}`}${intentos}`
    await notificar(`❌ *Byse*\n${detalle.slice(0, 500)}`)
  } finally {
    finishDownload(downloadKey(m), 'byse', controlador)
    // El temporal se borra siempre: WhatsApp ya copió el archivo al enviarlo.
    if (carpeta) await rm(carpeta, { recursive: true, force: true }).catch(() => {})
    log('proceso terminado', { codigo: info.code })
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }
}

handler.help = ['byse <enlace|código>', 'bysedl <enlace>']
handler.tags = ['downloader']
handler.command = /^(byse|bysedl|bysedownload)$/i

export default handler
