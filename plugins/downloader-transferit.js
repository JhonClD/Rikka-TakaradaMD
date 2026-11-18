import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'

const ORIGIN = 'https://transfer.it'
const DEFAULT_HOSTS = ['https://bt7.api.mega.co.nz', 'https://g.api.mega.co.nz']
const API_HOSTS = String(process.env.TRANSFERIT_API_HOSTS || DEFAULT_HOSTS.join(','))
  .split(',')
  .map((host) => host.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const MAX_MB = Math.min(2048, Math.max(1, Number(process.env.TRANSFERIT_MAX_MB) || 2048))
const MAX_BYTES = MAX_MB * 1024 * 1024
const API_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 120_000
const EDIT_INTERVAL_MS = 3_000
const RETRYABLE_CODES = new Set([-3, -4, -6, -18, -19])
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])

const ZERO_IV = Buffer.alloc(16)
const MEGA_MAGIC = Buffer.from('MEGA')

class TransferItError extends Error {
  constructor(message, code = null, retryable = false) {
    super(message)
    this.name = 'TransferItError'
    this.code = code
    this.retryable = retryable
  }
}

let sequence = 0

function base64urlDecode(value) {
  const clean = String(value || '')
    .replace(/\s/g, '')
    .replace(/=+$/, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  return Buffer.from(clean, 'base64')
}

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function decodeText(value) {
  try {
    return base64urlDecode(value).toString('utf8').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function foldKey(key) {
  if (!Buffer.isBuffer(key)) return null
  if (key.length === 16) return Buffer.from(key)
  if (key.length !== 32) return null
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) out[i] = key[i] ^ key[i + 16]
  return out
}

function decryptKeyBlocks(encrypted, wrappingKey) {
  if (!encrypted.length || encrypted.length % 16 !== 0) return null
  if (wrappingKey.length !== 16 && wrappingKey.length !== 32) return null
  const algorithm = wrappingKey.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc'
  const out = Buffer.alloc(encrypted.length)
  for (let offset = 0; offset < encrypted.length; offset += 16) {
    const decipher = createDecipheriv(algorithm, wrappingKey, ZERO_IV)
    decipher.setAutoPadding(false)
    out.set(Buffer.concat([
      decipher.update(encrypted.subarray(offset, offset + 16)),
      decipher.final(),
    ]), offset)
  }
  return out
}

function keyCandidates(rawKey, wrappingKey = null) {
  const candidates = []
  for (const entry of String(rawKey || '').split('/').filter(Boolean)) {
    const encoded = entry.includes(':') ? entry.slice(entry.lastIndexOf(':') + 1) : entry
    try {
      const decoded = base64urlDecode(encoded)
      if (decoded.length === 16 || decoded.length === 32) candidates.push(decoded)
      if (wrappingKey && decoded.length && decoded.length % 16 === 0) {
        const unwrapped = decryptKeyBlocks(decoded, wrappingKey)
        if (unwrapped && (unwrapped.length === 16 || unwrapped.length === 32)) {
          candidates.push(unwrapped)
        }
      }
    } catch {}
  }
  return candidates
}

function decryptAttrs(encryptedAttrs, aesKey) {
  const encrypted = base64urlDecode(encryptedAttrs)
  if (!aesKey || aesKey.length !== 16 || !encrypted.length || encrypted.length % 16 !== 0) return ''
  const decipher = createDecipheriv('aes-128-cbc', aesKey, ZERO_IV)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) end--
  const text = plain.subarray(0, end)
  if (text.length < 4 || !text.subarray(0, 4).equals(MEGA_MAGIC)) return ''
  try {
    const attrs = JSON.parse(text.subarray(4).toString('utf8'))
    return typeof attrs?.n === 'string' ? attrs.n : (typeof attrs?.name === 'string' ? attrs.name : '')
  } catch {
    return ''
  }
}

export function decryptNodeAttributes(encryptedAttrs, key) {
  const keys = Buffer.isBuffer(key) ? [key] : keyCandidates(key)
  for (const candidate of keys) {
    const name = decryptAttrs(encryptedAttrs, foldKey(candidate))
    if (name) return name
  }
  throw new TransferItError('No se pudieron descifrar los atributos del nodo.')
}

export function derivePasswordToken(xh, password) {
  const raw = base64urlDecode(xh)
  let salt = raw.subarray(Math.max(0, raw.length - 6))
  if (String(xh).length > 12) {
    const inner = base64urlDecode(raw.toString('latin1'))
    if (inner.length >= 7) salt = inner.subarray(inner.length - 7, inner.length - 1)
  }
  if (salt.length !== 6) throw new TransferItError('El handle del transfer no es válido.')
  const fullSalt = Buffer.concat([salt, salt, salt])
  return base64urlEncode(pbkdf2Sync(String(password).trim(), fullSalt, 100_000, 32, 'sha256'))
}

function cleanFileName(value, fallback = 'archivo.bin') {
  const name = String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 160)
  return name || fallback
}

function tokenize(text) {
  const tokens = []
  let current = ''
  let quote = ''
  for (const char of String(text || '')) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") {
      if (current) {
        tokens.push(current)
        current = ''
      }
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function parseTransferInput(raw) {
  const source = String(raw || '').trim()
  const found = source.match(/(?:https?:\/\/)?(?:www\.)?transfer\.it\/t\/[A-Za-z0-9_-]+[^\s]*/i)
  let xh = ''
  let nodeHandle = ''
  let selector = null
  let password = ''
  let pwToken = ''
  let rest = ''

  if (found) {
    const token = found[0].replace(/[),.!?;:'"\]]+}*$/g, '').replace(/^<|>$/g, '')
    rest = source.slice(found.index + found[0].length).trim()
    let url
    try {
      url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`)
    } catch {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 't' || !/^[A-Za-z0-9_-]{8,24}$/.test(parts[1] || '')) return null
    xh = parts[1]
    if (parts[2]) nodeHandle = decodeURIComponent(parts[2]).replace(/[^A-Za-z0-9_-]/g, '')
    const fragment = decodeURIComponent(url.hash.slice(1) || '')
    if (/^\d+$/.test(fragment)) selector = Number(fragment)
    else if (/^[A-Za-z0-9_-]{6,24}$/.test(fragment)) nodeHandle = fragment
    const queryPw = url.searchParams.get('pw')
    if (queryPw) {
      if (/^[A-Za-z0-9_-]{32,}$/.test(queryPw)) pwToken = queryPw
      else password = queryPw
    }
  } else {
    const first = source.split(/\s+/)[0] || ''
    if (!/^[A-Za-z0-9_-]{8,24}$/.test(first)) return null
    xh = first
    rest = source.slice(first.length).trim()
  }

  for (const token of tokenize(rest)) {
    let match
    if ((match = token.match(/^--(?:file|index|n)=(\d+)$/i))) {
      selector = Number(match[1])
    } else if ((match = token.match(/^--(?:node|handle|h)=([A-Za-z0-9_-]+)$/i))) {
      nodeHandle = match[1]
    } else if ((match = token.match(/^#([A-Za-z0-9_-]+)$/))) {
      if (/^\d+$/.test(match[1])) selector = Number(match[1])
      else nodeHandle = match[1]
    } else if ((match = token.match(/^--(?:password|pass|pw|clave)=(.+)$/i))) {
      password = match[1]
      pwToken = ''
    } else if ((match = token.match(/^--(?:pwtoken|token)=([A-Za-z0-9_-]+)$/i))) {
      pwToken = match[1]
      password = ''
    } else if (/^\d+$/.test(token)) {
      selector = Number(token)
    } else if (!password) {
      password = token
      pwToken = ''
    }
  }

  return {
    xh,
    link: `${ORIGIN}/t/${xh}`,
    nodeHandle: nodeHandle || '',
    selector: selector && selector > 0 ? selector : null,
    password: password.trim(),
    pwToken,
  }
}

function getInput(m, text, args) {
  const candidates = [text, args?.join(' '), m.quoted?.text, m.quoted?.caption]
  for (const candidate of candidates) {
    const parsed = parseTransferInput(candidate)
    if (parsed) return parsed
  }
  return null
}

function negativeCode(data) {
  if (typeof data === 'number' && data < 0) return data
  if (Array.isArray(data) && typeof data[0] === 'number' && data[0] < 0) return data[0]
  return null
}

function apiErrorMessage(code) {
  const messages = {
    [-2]: 'La API rechazó la solicitud.',
    [-3]: 'transfer.it está ocupado; intenta de nuevo en unos segundos.',
    [-4]: 'transfer.it limitó temporalmente las solicitudes.',
    [-6]: 'Demasiadas solicitudes a transfer.it.',
    [-8]: 'El enlace de transfer.it expiró.',
    [-9]: 'El enlace no existe, fue eliminado o expiró.',
    [-11]: 'Acceso denegado al transfer.',
    [-13]: 'La solicitud llegó incompleta; revisa el enlace.',
    [-14]: 'La contraseña del transfer es incorrecta o falta el token de acceso.',
    [-16]: 'Este transfer fue bloqueado.',
    [-17]: 'Se agotó la cuota de descarga.',
    [-18]: 'El servicio está temporalmente no disponible.',
    [-19]: 'Demasiadas conexiones simultáneas con transfer.it.',
  }
  return messages[code] || `transfer.it respondió con el error ${code}.`
}

function abortReason(signal) {
  return signal?.reason || Object.assign(new Error('Abortado'), { name: 'AbortError' })
}

function isAbortError(error) {
  const cause = error?.cause
  return Boolean(
    error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ERR_CANCELED' ||
    error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    cause?.name === 'AbortError' ||
    cause?.code === 'ABORT_ERR',
  )
}

function timedSignal(signal, ms) {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error('Tiempo de espera agotado'), { name: 'TimeoutError' }))
  }, ms)
  timer.unref?.()
  if (signal.aborted) controller.abort(abortReason(signal))
  else signal.addEventListener('abort', () => controller.abort(abortReason(signal)), { once: true })
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function apiUrl(host, { x, pw } = {}) {
  const url = new URL(`${host}/cs`)
  url.searchParams.set('id', String(Date.now() + (sequence++ % 1000)))
  if (x) url.searchParams.set('x', x)
  if (pw) url.searchParams.set('pw', pw)
  return url.toString()
}

function firstObject(value) {
  let result = value
  if (Array.isArray(result)) result = result[0]
  if (Array.isArray(result)) result = result[0]
  return result && typeof result === 'object' ? result : null
}

async function apiCommand(command, { x = '', pw = '', signal } = {}) {
  let lastError = null
  const remember = (error) => {
    const previousIsApiCode = lastError instanceof TransferItError && lastError.code !== null
    const currentIsApiCode = error instanceof TransferItError && error.code !== null
    if (!lastError || currentIsApiCode || !previousIsApiCode) lastError = error
  }

  for (const host of API_HOSTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(apiUrl(host, { x, pw }), {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': ORIGIN,
            'Referer': `${ORIGIN}/`,
          },
          body: JSON.stringify([command]),
          signal: timedSignal(signal, API_TIMEOUT_MS),
        })

        if (RETRYABLE_HTTP.has(response.status) && attempt < 3) {
          await sleep(350 * 2 ** attempt, signal)
          continue
        }
        if (!response.ok) {
          throw new TransferItError(
            response.status === 402
              ? 'transfer.it pidió verificación adicional (HTTP 402). Intenta más tarde.'
              : `transfer.it respondió con HTTP ${response.status}.`,
          )
        }

        const body = await response.text()
        let data
        try {
          data = JSON.parse(body)
        } catch {
          throw new TransferItError('transfer.it devolvió una respuesta inválida.')
        }

        const code = negativeCode(data)
        if (code !== null) {
          const error = new TransferItError(apiErrorMessage(code), code, RETRYABLE_CODES.has(code))
          if (error.retryable && attempt < 3) {
            await sleep(350 * 2 ** attempt, signal)
            continue
          }
          throw error
        }

        const result = Array.isArray(data) ? data[0] : data
        if (result === undefined) throw new TransferItError('transfer.it devolvió una respuesta vacía.')
        return result
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        remember(error)
        break
      }
    }
  }
  throw lastError || new TransferItError('No se pudo contactar con transfer.it.')
}

async function fetchInfo(xh, signal) {
  try {
    return firstObject(await apiCommand({ a: 'xi', xh }, { signal })) || {}
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    console.warn(`[TRANSFERIT] metadatos no disponibles: ${error.message}`)
    return {}
  }
}

async function fetchNodes(xh, pwToken, signal) {
  const result = await apiCommand({ a: 'f', c: 1, r: 1 }, { x: xh, pw: pwToken, signal })
  const payload = firstObject(result)
  const nodes = payload?.f || result?.f
  if (!Array.isArray(nodes)) throw new TransferItError('transfer.it no devolvió la lista de archivos.')
  return nodes
}

async function validatePassword(xh, pwToken, signal) {
  try {
    const result = await apiCommand({ a: 'xv', xh, pw: pwToken }, { signal })
    if (Number(result) !== 1) throw new TransferItError('La contraseña del transfer es incorrecta.', -14)
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    if (error.code === -14) throw new TransferItError('La contraseña del transfer es incorrecta.', -14)
    if (error.code === -8 || error.code === -9 || error.code === -16) throw error
  }
}

function findRootKey(nodes) {
  const root = nodes.find((node) => Number(node.t) === 1 && !node.p) ||
    nodes.find((node) => Number(node.t) === 1)
  for (const candidate of keyCandidates(root?.k)) {
    if (candidate.length === 16 || candidate.length === 32) return candidate
  }
  return null
}

function nodeName(node, index, rootKey) {
  for (const candidate of keyCandidates(node.k, rootKey)) {
    const name = decryptAttrs(node.a, foldKey(candidate))
    if (name) return name
  }
  return `archivo_${index + 1}_${String(node.h || '').slice(0, 8)}`
}

function buildFileList(nodes) {
  const rootKey = findRootKey(nodes)
  const files = []
  for (const node of nodes) {
    if (Number(node.t) !== 0 || !node.h) continue
    const index = files.length
    files.push({
      handle: String(node.h),
      name: cleanFileName(nodeName(node, index, rootKey), `archivo_${index + 1}`),
      size: Math.max(0, Number(node.s) || 0),
      kind: 'file',
    })
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
  return files
}

function zipTarget(info, xh) {
  const handle = typeof info.z === 'string' ? info.z.trim() : ''
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(handle)) return null
  const title = decodeText(info.t) || `transferit-${xh}`
  const name = cleanFileName(`${title.replace(/\.zip$/i, '')}.zip`, `transferit-${xh}.zip`)
  const zipSize = Number(info.zp) || 0
  const totalSize = Array.isArray(info.size) ? Number(info.size[0]) || 0 : 0
  return {
    handle,
    name,
    urlName: `${xh}${handle}.zip`,
    size: zipSize > 1024 ? zipSize : totalSize,
    kind: 'zip',
  }
}

export function buildDownloadUrl(host, xh, handle, fileName, pwToken = '') {
  const base = `${host.replace(/\/+$/, '')}/cs/g?x=${encodeURIComponent(xh)}&n=${encodeURIComponent(handle)}&fn=${encodeURIComponent(fileName)}`
  return pwToken ? `${base}&pw=${encodeURIComponent(pwToken)}` : base
}

async function readErrorBody(response, limit = 300) {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, limit)
  } catch {
    return ''
  }
}

async function openDownload(xh, target, pwToken, signal) {
  let lastError = null
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': '*/*',
    'Referer': `${ORIGIN}/t/${xh}`,
    'Origin': ORIGIN,
  }

  for (const host of API_HOSTS) {
    try {
      const response = await fetch(
        buildDownloadUrl(host, xh, target.handle, target.urlName || target.name, pwToken),
        { headers, signal, redirect: 'follow' },
      )
      const contentType = response.headers.get('content-type') || ''
      const disposition = response.headers.get('content-disposition') || ''
      const landingPage = /^https?:\/\/(?:www\.)?transfer\.it\/t\//i.test(response.url || '')

      if (!response.ok) {
        const detail = await readErrorBody(response)
        throw new TransferItError(
          `No se pudo iniciar la descarga (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`,
        )
      }
      if (landingPage || (/^(?:text\/html|application\/json)/i.test(contentType) && !/attachment/i.test(disposition))) {
        await readErrorBody(response, 200)
        throw new TransferItError(
          landingPage
            ? 'transfer.it devolvió la página del enlace en vez del archivo. Puede haber expirado o requerir verificación.'
            : `transfer.it devolvió ${contentType || 'una respuesta no binaria'} en vez del archivo.`,
        )
      }
      if (!response.body) throw new TransferItError('La descarga llegó sin cuerpo.')

      const declared = Number(response.headers.get('content-length')) || 0
      const size = declared || target.size || 0
      if (size > MAX_BYTES) {
        if (typeof response.body.cancel === 'function') {
          const cancelled = response.body.cancel()
          cancelled?.catch?.(() => {})
        } else {
          response.body.destroy?.()
        }
        throw new TransferItError(`El archivo (${fmtBytes(size)}) supera el límite de ${MAX_MB} MB.`)
      }

      const stream = typeof response.body.getReader === 'function'
        ? Readable.fromWeb(response.body)
        : response.body

      return { stream, size, contentType }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      lastError = error
    }
  }
  throw lastError || new TransferItError('No se pudo abrir la descarga en transfer.it.')
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`
  return `${Math.round(value)} B`
}

function progressBar(percent, width = 16) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  const filled = Math.round(width * pct / 100)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function buildStatus(emoji, label, percent, done, total, speed) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  if (total > 0) {
    return `${emoji} *${label}*\n` +
      `\`[${progressBar(pct)}] ${pct.toFixed(1)}%\`\n` +
      `📦 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
      `⚡ ${fmtBytes(speed)}/s`
  }
  return `${emoji} *${label}*\n📦 ${fmtBytes(done)}\n⚡ ${fmtBytes(speed)}/s`
}

function makeWatchdog(controller) {
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      controller.abort(Object.assign(new Error('Inactividad'), { name: 'AbortError' }))
      clearInterval(timer)
    }
  }, 5_000)
  timer.unref?.()
  return {
    ping() { last = Date.now() },
    stop() { clearInterval(timer) },
  }
}

function makeMeter({ label, emoji, total, maxBytes, watchdog, onTick }) {
  let bytes = 0
  const started = Date.now()
  let lastTick = 0
  const tick = (force = false) => {
    const now = Date.now()
    if (!force && now - lastTick < EDIT_INTERVAL_MS) return
    lastTick = now
    const elapsed = Math.max((now - started) / 1000, 0.001)
    const speed = bytes / elapsed
    const percent = total > 0 ? Math.min(100, bytes / total * 100) : 0
    onTick(buildStatus(emoji, label, percent, bytes, total, speed))
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (maxBytes && bytes > maxBytes) {
        return callback(new TransferItError(`El archivo supera el límite de ${MAX_MB} MB.`))
      }
      watchdog?.ping()
      tick()
      callback(null, chunk)
    },
    flush(callback) {
      tick(true)
      callback()
    },
  })
}

function guessMime(fileName) {
  const ext = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  const types = {
    zip: 'application/zip', pdf: 'application/pdf', txt: 'text/plain',
    json: 'application/json', mp4: 'video/mp4', mkv: 'video/x-matroska',
    webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', apk: 'application/vnd.android.package-archive',
    rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  }
  return types[ext] || 'application/octet-stream'
}

async function downloadToTemp(stream, tempPath, expectedSize, watchdog, signal, update) {
  const meter = makeMeter({
    label: 'Descargando de Transfer.it',
    emoji: '📥',
    total: expectedSize,
    maxBytes: MAX_BYTES,
    watchdog,
    onTick: (text) => { void update(text) },
  })
  await pipeline(stream, meter, fs.createWriteStream(tempPath, { flags: 'wx' }), { signal })
  const realSize = fs.statSync(tempPath).size
  if (!realSize || (expectedSize > 0 && realSize < expectedSize)) {
    throw new TransferItError('La descarga quedó incompleta; inténtalo de nuevo.')
  }
  return realSize
}

function sniffVideoExt(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(64)
    const read = fs.readSync(fd, buf, 0, 64, 0)
    const head = buf.subarray(0, read)
    if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return head.includes(Buffer.from('webm')) ? 'webm' : 'mkv'
    }
    if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4'
    return ''
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function fixVideoName(fileName, realExt) {
  const current = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  if (!realExt || !['mp4', 'mkv', 'webm', 'm4v'].includes(current) || current === realExt) return fileName
  return String(fileName).replace(/\.[a-z0-9]+$/i, `.${realExt}`)
}

async function sendDocument(conn, m, tempPath, target, realSize, update) {
  const sendName = fixVideoName(target.name, sniffVideoExt(tempPath))
  await update('✅ _Descarga completa._\n📤 _Subiendo a WhatsApp..._')
  const pass = new PassThrough()
  const meter = makeMeter({
    label: 'Subiendo a WhatsApp',
    emoji: '📤',
    total: realSize,
    onTick: (text) => { void update(text) },
  })
  pipeline(fs.createReadStream(tempPath), meter, pass).catch((error) => pass.destroy(error))

  await conn.sendMessage(
    m.chat,
    {
      document: { stream: pass },
      fileName: sendName,
      mimetype: guessMime(sendName),
      caption: `✅ *${sendName}*\n📦 *Tamaño:* ${fmtBytes(realSize)}\n🚀 _Descargado de Transfer.it._`,
    },
    { quoted: m },
  )
}

function usage(usedPrefix, command) {
  const prefix = usedPrefix || '.'
  const cmd = command || 'transferit'
  return (
    `📦 *Transfer.it Downloader*\n\n` +
    `Envía un enlace de *transfer.it*:\n` +
    `• \`${prefix}${cmd} https://transfer.it/t/XXXXXXXXXXXX\`\n` +
    `• \`${prefix}${cmd} <enlace> "contraseña"\` _(enlaces protegidos)_\n` +
    `• \`${prefix}${cmd} <enlace> 2 "contraseña"\` _(elegir archivo por número)_\n` +
    `• \`${prefix}${cmd} <enlace>#<handle>\` _(un archivo concreto)_\n\n` +
    `Si la contraseña es numérica usa \`--password=1234\`.\n` +
    `Los transfers con varios archivos se envían como ZIP cuando el servidor lo ofrece.\n` +
    `Para cancelar: \`${prefix}cancelar\`.`
  )
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = getInput(m, text, args)
  if (!input) throw usage(usedPrefix, command)

  const userKey = downloadKey(m)
  if (hasDownload(userKey, 'transferit')) {
    return m.reply('⚠️ Ya tienes una descarga de Transfer.it en curso. Usa *.cancelar* para detenerla.')
  }

  const controller = new AbortController()
  const { signal } = controller
  const prefix = usedPrefix || '.'
  const cmd = command || 'transferit'
  let statusKey = null
  let tempPath = ''
  let watchdog = null

  const sent = await conn.sendMessage(
    m.chat,
    { text: '🔄 _Consultando Transfer.it..._' },
    { quoted: m },
  )
  statusKey = sent?.key || null

  const update = async (message) => {
    if (statusKey) {
      try {
        await conn.sendMessage(m.chat, { text: message, edit: statusKey })
        return
      } catch {}
    }
    try { await m.reply(message) } catch {}
  }

  startDownload(userKey, 'transferit', controller, { label: '📦 Transfer.it' })

  try {
    const info = await fetchInfo(input.xh, signal)
    const needsPassword = Boolean(info.pw) && info.pw !== '0'
    let pwToken = input.pwToken
    let activeToken = needsPassword ? pwToken : ''

    if (needsPassword && !pwToken && !input.password) {
      await update(
        `🔒 *Este transfer está protegido con contraseña.*\n\n` +
        `Ejemplo:\n\`${prefix}${cmd} ${input.link} "tu contraseña"\`\n` +
        `Si es numérica: \`--password=1234\`.`,
      )
      return
    }
    if (needsPassword && !pwToken && input.password) {
      pwToken = derivePasswordToken(input.xh, input.password)
      activeToken = pwToken
    }
    if (needsPassword && pwToken) await validatePassword(input.xh, pwToken, signal)

    let nodes
    try {
      nodes = await fetchNodes(input.xh, activeToken, signal)
    } catch (error) {
      if (error.code !== -14) throw error
      if (!pwToken && input.password) {
        pwToken = derivePasswordToken(input.xh, input.password)
        await validatePassword(input.xh, pwToken, signal)
      }
      if (!pwToken || activeToken === pwToken) {
        await update(
          `🔒 *Contraseña incorrecta o enlace protegido.*\n\n` +
          `\`${prefix}${cmd} ${input.link} "tu contraseña"\``,
        )
        return
      }
      activeToken = pwToken
      nodes = await fetchNodes(input.xh, activeToken, signal)
    }

    const files = buildFileList(nodes)
    const zip = zipTarget(info, input.xh)
    const totalSize = Array.isArray(info.size) ? Number(info.size[0]) || 0 : 0
    let target = null

    if (input.nodeHandle) {
      target = files.find((file) => file.handle === input.nodeHandle) || null
      if (!target) {
        await update(`❌ No encontré el archivo \`${input.nodeHandle}\` en este transfer.`)
        return
      }
    } else if (input.selector !== null) {
      target = files[input.selector - 1] || null
      if (!target) {
        await update(`❌ Número de archivo inválido. Este transfer tiene ${files.length} archivo(s).`)
        return
      }
    } else if (files.length === 1) {
      target = files[0]
    } else if (files.length > 1 && zip) {
      target = zip
    } else if (!files.length && zip) {
      target = zip
    } else if (files.length > 1) {
      const list = files.slice(0, 12).map((file, index) =>
        `\`${String(index + 1).padStart(2, '0')}.\` ${file.name} · ${fmtBytes(file.size)}`,
      ).join('\n')
      await update(
        `📦 *Transfer.it · ${files.length} archivos*\n\n${list}` +
        (files.length > 12 ? `\n_…y ${files.length - 12} más._` : '') +
        `\n\nElige uno:\n\`${prefix}${cmd} ${input.link} <número>${input.password ? ' "tu contraseña"' : ''}\`` +
        `\nO usa \`${prefix}${cmd} ${input.link}#${files[0].handle}\`.`,
      )
      return
    } else {
      await update('❌ Este transfer no contiene archivos descargables.')
      return
    }

    const expectedSize = target.size || (target.kind === 'zip' ? totalSize : 0)
    if (expectedSize > MAX_BYTES) {
      await update(`❌ El archivo (${fmtBytes(expectedSize)}) supera el límite de ${MAX_MB} MB.`)
      return
    }

    await update(
      `📦 *${target.name}*\n` +
      `⚖️ ${expectedSize > 0 ? fmtBytes(expectedSize) : '_Tamaño desconocido_'}\n` +
      `🔄 _Iniciando descarga..._\n` +
      `_Usa_ *${prefix}cancelar* _para detener._`,
    )

    watchdog = makeWatchdog(controller)
    const download = await openDownload(input.xh, target, activeToken, signal)
    tempPath = join(tmpdir(), `transferit_${randomUUID()}_${cleanFileName(target.name, 'archivo.bin')}`)

    const sizeForProgress = download.size || expectedSize
    const realSize = await downloadToTemp(
      download.stream,
      tempPath,
      sizeForProgress,
      watchdog,
      signal,
      update,
    )
    watchdog.stop()
    watchdog = null

    await sendDocument(conn, m, tempPath, target, realSize, update)
    await update(`✅ *¡Listo!* \`${target.name}\` enviado correctamente.`)
  } catch (error) {
    if (controller.signal.aborted) {
      await update('🚫 *Descarga cancelada.*')
    } else {
      const message = error instanceof Error ? error.message : String(error)
      await update(`❌ ${message.slice(0, 500)}`)
      console.error(`[TRANSFERIT] ${message}`)
    }
  } finally {
    watchdog?.stop()
    finishDownload(userKey, 'transferit', controller)
    if (tempPath) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {}
    }
  }
}

handler.help = [
  'transferit <enlace> [contraseña]',
  'transfer <enlace> [número] [contraseña]',
]
handler.tags = ['downloader']
handler.command = /^(transferit|transfer|titdl)$/i
handler.limit = false

export default handler
