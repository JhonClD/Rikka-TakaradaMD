// plugins/doodstream-dl.js — Descargador independiente para DoodStream / PlayMogo y mirrors
// Resuelve /pass_md5/ + token + expiry con failover de mirrors y descarga MP4 resiliente.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'
import { resolveJkAnimeEpisodeInput } from './lib/jkanime-episode-servers.js'

const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.DOODSTREAM_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const PARALLEL_THREADS = 4
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024
const MAX_CHUNK_RETRIES = 3
const MAX_SEQ_RETRIES = 5
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const DOOD_HOST_RE = /(?:^|\.)(?:dood(?:stream)?\.|ds2play\.|ds2video\.|dsvplay\.|d000d\.|d0000d\.|do0od\.|dooood\.|doostream\.|d-s\.io|myvidplay\.|vide0\.net|vidply\.|playmogo\.|doply\.|do7go\.)/i
const ACTIVE_MIRRORS = ['myvidplay.com', 'playmogo.com', 'd000d.com', 'ds2play.com']

let wreqPromise = null
let wreqUnavailable = false
let activeUa = FALLBACK_UA

function createAbortError(message = 'Descarga cancelada.') {
  const err = new Error(message)
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function combineSignal(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs)
  if (!signal) return t
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, t])
  return signal
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function safeName(value, fallback = 'doodstream-video') {
  return String(value || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback
}

function safeHttpUrl(value, baseUrl) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  try {
    const url = new URL(trimmed, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch (_) {
    return null
  }
}

async function getWreq() {
  if (wreqUnavailable) return null
  if (!wreqPromise) {
    wreqPromise = import('wreq-js')
      .then((mod) => {
        if (typeof mod.getEmulationHeaders === 'function') {
          const ua = mod.getEmulationHeaders('chrome', 'windows')?.get?.('user-agent')
          if (ua) activeUa = ua
        }
        return mod
      })
      .catch(() => {
        wreqUnavailable = true
        wreqPromise = null
        return null
      })
  }
  return wreqPromise
}

function nodeHttpRequest(url, { method = 'GET', headers = {}, timeout = PAGE_TIMEOUT_MS, signal, maxRedirects = 5, maxVersion = 'TLSv1.2' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError())
    let parsed
    try { parsed = new URL(url) } catch (err) { return reject(err) }
    const isHttps = parsed.protocol === 'https:'
    const mod = isHttps ? https : http
    const opts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      family: 4,
      headers: { 'user-agent': activeUa, accept: '*/*', ...headers },
      ...(isHttps ? { maxVersion } : {}),
    }
    const req = mod.request(opts, (res) => {
      const status = res.statusCode || 0
      const loc = res.headers.location
      if (status >= 300 && status < 400 && loc && maxRedirects > 0) {
        res.resume()
        cleanup()
        const nextUrl = safeHttpUrl(loc, url)
        if (!nextUrl) return reject(new Error(`Redirección inválida (${status})`))
        nodeHttpRequest(nextUrl, { method, headers, timeout, signal, maxRedirects: maxRedirects - 1, maxVersion })
          .then(resolve, reject)
        return
      }
      clearTimeout(timer)
      res.once('close', cleanup)
      res.once('end', cleanup)
      const hdrs = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) hdrs.set(k, v.join(', '))
        else if (v !== undefined) hdrs.set(k, String(v))
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: hdrs,
        body: res,
        async text() {
          const chunks = []
          for await (const c of res) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
          return Buffer.concat(chunks).toString('utf8')
        },
      })
    })
    const onAbort = () => {
      req.destroy(createAbortError())
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      req.destroy(new Error(`Timeout HTTP (${timeout}ms)`))
      reject(new Error(`Timeout HTTP (${timeout}ms)`))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      cleanup()
      reject(err)
    })
    req.end()
  })
}

async function resilientFetch(session, url, { method = 'GET', headers = {}, timeout = PAGE_TIMEOUT_MS, signal, preferNative = false } = {}) {
  const reqHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null && v !== '') reqHeaders[k.toLowerCase()] = String(v)
  }
  const nativeHeaders = { 'user-agent': activeUa, accept: '*/*', ...reqHeaders }
  const nativeCall = () => globalThis.fetch(url, {
    method,
    headers: nativeHeaders,
    redirect: 'follow',
    signal: combineSignal(signal, timeout),
  })
  const tls12Call = () => nodeHttpRequest(url, { method, headers: nativeHeaders, timeout, signal, maxVersion: 'TLSv1.2' })
  const wreqCall = () => session.fetch(url, {
    method,
    headers: reqHeaders,
    timeout,
    redirect: 'follow',
    signal: combineSignal(signal, timeout),
  })

  const order = preferNative
    ? [nativeCall, tls12Call, ...(session ? [wreqCall] : [])]
    : [...(session ? [wreqCall] : []), nativeCall, tls12Call]

  let lastErr = null
  for (let i = 0; i < order.length; i += 1) {
    try {
      const res = await order[i]()
      if ((res.status === 403 || res.status >= 500) && i + 1 < order.length) {
        await cancelBody(res)
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return res
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
  }
  throw lastErr || new Error('Error de red al conectar con DoodStream.')
}

function toNodeReadable(res) {
  if (typeof res?.readable === 'function') return res.readable()
  const body = res?.body
  if (!body) throw new Error('Respuesta sin cuerpo.')
  if (body instanceof Readable || typeof body.pipe === 'function') return body
  if (typeof body.getReader === 'function') return Readable.fromWeb(body)
  if (typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body)
  throw new Error('Flujo HTTP incompatible.')
}

async function cancelBody(res) {
  try {
    if (typeof res?.body?.cancel === 'function') await res.body.cancel()
    else if (typeof res?.body?.destroy === 'function') res.body.destroy()
  } catch (_) {}
}

export function parseDoodStreamUrl(value) {
  const raw = (String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim())
    .replace(/[),.!?;:'"\]}>]+$/g, '')
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de DoodStream.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !DOOD_HOST_RE.test(url.hostname)) {
    throw new Error('Solo acepto enlaces de DoodStream / PlayMogo o sus mirrors conocidos.')
  }
  const m = url.pathname.match(/^\/(?:(?:e|d|f|file|embed|watch)\/)?([a-z0-9_-]{6,64})(?:\/|$)/i)
  if (!m) throw new Error('No pude reconocer el identificador del video en DoodStream.')
  const id = m[1]
  const embedUrl = `${url.origin}/e/${id}`
  const mirrorUrls = ACTIVE_MIRRORS
    .filter(host => host !== url.hostname.toLowerCase())
    .map(host => `https://${host}/e/${id}`)
  return { id, url: embedUrl, candidates: [...new Set([embedUrl, ...mirrorUrls])] }
}

export function extractDoodPassPath(html) {
  const m = String(html || '').match(/\/pass_md5\/[^'"<\s]+/i)
  if (!m) return null
  const passPath = m[0]
  const token = passPath.split('/').filter(Boolean).at(-1) || ''
  return token ? { passPath, token } : null
}

function isCaptchaGate(html, res) {
  const cf = String(res?.headers?.get?.('cf-mitigated') || '').toLowerCase()
  if (cf.includes('challenge')) return true
  return /challenges\.cloudflare\.com|op=validate&gc_response=|loadCaptcha\s*\(|cf-turnstile/i.test(String(html || ''))
}

function randomSuffix(length = 10) {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ALNUM[Math.floor(Math.random() * ALNUM.length)]
  }
  return out
}

async function validateVideo(filePath) {
  const stat = await fsp.stat(filePath)
  if (stat.size < MIN_VALID_BYTES) throw new Error(`Archivo incompleto (${formatBytes(stat.size)}).`)
  if (stat.size > MAX_VIDEO_BYTES) throw new Error(`El video (${formatBytes(stat.size)}) supera el límite de 2 GB.`)
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(Math.min(512, stat.size))
    await fh.read(buf, 0, buf.length, 0)
    const head = buf.toString('utf8').trimStart().toLowerCase()
    if (/^(?:<!doctype\s+html|<html\b|<head\b|\{"(?:error|status|message)")/i.test(head)) {
      throw new Error('DoodStream devolvió HTML/error en lugar de video.')
    }
  } finally {
    await fh.close()
  }
  return stat
}

function createIdleWatchdog(onIdle) {
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      clearInterval(timer)
      onIdle()
    }
  }, 5_000)
  timer.unref?.()
  return { ping() { last = Date.now() }, stop() { clearInterval(timer) } }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function downloadRangeChunk(session, mediaUrl, fh, start, end, headers, watchdog, signal) {
  let pos = start
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt += 1) {
    if (signal?.aborted) throw createAbortError()
    try {
      const r = await resilientFetch(session, mediaUrl, {
        headers: { ...headers, range: `bytes=${pos}-${end}` },
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal,
        preferNative: true,
      })
      if (r.status !== 206) { await cancelBody(r); throw new Error(`HTTP ${r.status}`) }
      for await (const c of toNodeReadable(r)) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
        await fh.write(b, 0, b.length, pos)
        pos += b.length
        watchdog.ping()
      }
      if (pos > end) return
      lastErr = new Error(`Bloque incompleto (${pos - start}/${end - start + 1})`)
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
    if (attempt < MAX_CHUNK_RETRIES) await sleep(600 * attempt, signal)
  }
  throw lastErr || new Error('Falló la descarga de un bloque en DoodStream.')
}

async function downloadSequentialResumable(session, mediaUrl, partPath, headers, expectedSize, watchdog, signal) {
  let downloaded = 0
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_SEQ_RETRIES; attempt += 1) {
    if (signal?.aborted) throw createAbortError()
    try {
      const reqHeaders = downloaded > 0 ? { ...headers, range: `bytes=${downloaded}-` } : headers
      const res = await resilientFetch(session, mediaUrl, {
        headers: reqHeaders,
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal,
        preferNative: true,
      })
      if (downloaded > 0 && res.status === 416) {
        await cancelBody(res)
        if (expectedSize && downloaded >= expectedSize) return
        downloaded = 0
        await fsp.rm(partPath, { force: true }).catch(() => {})
        lastErr = new Error('HTTP 416')
        continue
      }
      if (downloaded > 0 && res.status === 200) {
        downloaded = 0
        await fsp.rm(partPath, { force: true }).catch(() => {})
      } else if (!res.ok && res.status !== 206) {
        await cancelBody(res)
        throw new Error(`HTTP ${res.status}`)
      }
      const ct = String(res.headers?.get?.('content-type') || '').toLowerCase()
      if (/text\/html|application\/json/i.test(ct)) {
        await cancelBody(res)
        throw new Error(`DoodStream devolvió ${ct} en lugar de video.`)
      }
      if (!expectedSize) {
        const cl = Number(res.headers?.get?.('content-length') || 0) || 0
        if (cl > 0) expectedSize = downloaded + cl
      }
      const guard = new Transform({
        transform(c, _e, cb) {
          downloaded += c.length
          watchdog.ping()
          if (downloaded > MAX_VIDEO_BYTES) cb(new Error('El video supera el límite de 2 GB.'))
          else cb(null, c)
        },
      })
      const ws = fs.createWriteStream(partPath, { flags: downloaded > 0 ? 'a' : 'w' })
      await pipeline(toNodeReadable(res), guard, ws)
      if (!expectedSize || downloaded >= expectedSize) return
      lastErr = new Error(`Descarga interrumpida (${formatBytes(downloaded)}/${formatBytes(expectedSize)})`)
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      if (/en lugar de video|supera el límite/i.test(err.message)) throw err
      lastErr = err
      try {
        const st = await fsp.stat(partPath)
        downloaded = st.size
      } catch (_) {
        downloaded = 0
      }
    }
    if (attempt < MAX_SEQ_RETRIES) await sleep(800 * attempt, signal)
  }
  throw lastErr || new Error('No se pudo descargar el MP4 desde DoodStream.')
}

async function downloadDirectMp4(session, mediaUrl, destPath, referer, signal) {
  const partPath = `${destPath}.part`
  const headers = { accept: '*/*', ...(referer ? { referer } : {}) }
  let sizeBytes = 0
  let supportsRanges = false
  try {
    const head = await resilientFetch(session, mediaUrl, { method: 'HEAD', headers, timeout: 15_000, signal, preferNative: true })
    await cancelBody(head)
    if (head.ok) {
      const ct = String(head.headers?.get?.('content-type') || '').toLowerCase()
      if (/text\/html|application\/json/i.test(ct)) throw new Error(`DoodStream devolvió ${ct} en lugar de video.`)
      sizeBytes = Number(head.headers?.get?.('content-length') || 0) || 0
      supportsRanges = /bytes/i.test(head.headers?.get?.('accept-ranges') || '')
    }
  } catch (err) {
    if (signal?.aborted) throw createAbortError()
    if (/en lugar de video/i.test(err.message)) throw err
  }
  if (sizeBytes > MAX_VIDEO_BYTES) throw new Error(`El video (${formatBytes(sizeBytes)}) supera el límite de 2 GB.`)

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(createAbortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  const watchdog = createIdleWatchdog(() => ctrl.abort(new Error('Descarga sin datos durante 90s.')))

  try {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    let parallelOk = false
    if (supportsRanges && sizeBytes >= MIN_PARALLEL_BYTES) {
      try {
        const chunk = Math.ceil(sizeBytes / PARALLEL_THREADS)
        const ranges = []
        for (let i = 0; i < PARALLEL_THREADS; i += 1) {
          const start = i * chunk
          const end = Math.min(start + chunk - 1, sizeBytes - 1)
          if (start <= end) ranges.push({ start, end })
        }
        const fh = await fsp.open(partPath, 'w')
        try {
          await Promise.all(ranges.map(({ start, end }) =>
            downloadRangeChunk(session, mediaUrl, fh, start, end, headers, watchdog, ctrl.signal)))
        } finally {
          await fh.close()
        }
        parallelOk = true
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        await fsp.rm(partPath, { force: true }).catch(() => {})
      }
    }

    if (!parallelOk) {
      await downloadSequentialResumable(session, mediaUrl, partPath, headers, sizeBytes, watchdog, ctrl.signal)
    }

    const stat = await validateVideo(partPath)
    await fsp.rename(partPath, destPath)
    return stat
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    throw err
  } finally {
    watchdog.stop()
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function downloadDoodStreamFile(inputUrl, outputPath, { signal } = {}) {
  const parsed = parseDoodStreamUrl(inputUrl)
  const wreq = await getWreq()
  const session = wreq
    ? await wreq.createSession({
      browser: 'chrome',
      os: 'windows',
      timeout: PAGE_TIMEOUT_MS,
      defaultHeaders: { 'accept-language': 'es-419,es;q=0.9,en;q=0.8' },
    })
    : null
  try {
    let pass = null
    let finalPageUrl = parsed.url
    let origin = new URL(parsed.url).origin
    let lastErr = null
    for (const candidate of parsed.candidates) {
      try {
        const res1 = await resilientFetch(session, candidate, {
          headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', referer: `${new URL(candidate).origin}/` },
          signal,
        })
        const html = await res1.text()
        if (isCaptchaGate(html, res1)) {
          lastErr = new Error(`DoodStream (${new URL(res1.url || candidate).hostname}) solicitó verificación CAPTCHA (Turnstile) desde esta IP y no se puede descargar automáticamente.`)
          break
        }
        if (!res1.ok) {
          lastErr = new Error(`DoodStream devolvió HTTP ${res1.status}.`)
          continue
        }
        finalPageUrl = res1.url || candidate
        origin = new URL(finalPageUrl).origin
        pass = extractDoodPassPath(html)
        if (pass) break
        lastErr = new Error('DoodStream no expuso la ruta /pass_md5/ (video eliminado o bloqueado).')
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        lastErr = err
      }
    }
    if (!pass) throw lastErr || new Error('DoodStream no expuso la ruta /pass_md5/ (video eliminado o bloqueado).')

    const res2 = await resilientFetch(session, `${origin}${pass.passPath}`, {
      headers: { referer: finalPageUrl, 'x-requested-with': 'XMLHttpRequest' },
      signal,
    })
    if (!res2.ok) { await cancelBody(res2); throw new Error(`DoodStream pass_md5 devolvió HTTP ${res2.status}.`) }
    const baseMedia = (await res2.text()).trim()
    if (!/^https?:\/\//i.test(baseMedia)) {
      throw new Error('DoodStream devolvió una URL base inválida para el video.')
    }
    const mediaUrl = `${baseMedia}${randomSuffix(10)}?token=${encodeURIComponent(pass.token)}&expiry=${Date.now()}`

    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    const stat = await downloadDirectMp4(session, mediaUrl, outputPath, `${origin}/`, signal)
    return { filePath: outputPath, fileSize: stat.size, extension: '.mp4', mimetype: 'video/mp4' }
  } finally {
    await session?.close?.().catch(() => {})
  }
}

function getInput(m, text, args) {
  const quoted = m.quoted?.text || m.quoted?.caption || ''
  const value = String(text || args?.[0] || quoted || '').match(/https?:\/\/[^\s<>]+/i)?.[0] || ''
  return value.replace(/[),.!?;:'"\]}>]+$/g, '')
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = getInput(m, text, args)
  if (!input) {
    return m.reply(`Envía o responde a un enlace de DoodStream / PlayMogo.\nEjemplo: *${usedPrefix || '.'}${command || 'doodstream'} https://dsvplay.com/e/ID*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'doodstream') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseDoodStreamUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'doodstream')) return m.reply('⏳ Ya tienes una descarga de DoodStream activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'doodstream', controller, { label: `DoodStream (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `dood_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `DoodStream-${safeName(parsed.id)}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo *DoodStream* · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *DoodStream*…')
    const { fileSize } = await downloadDoodStreamFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `DoodStream-${safeName(parsed.id)}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *DoodStream* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de DoodStream cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde DoodStream.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'doodstream', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['doodstream <enlace>']
handler.tags = ['downloader']
handler.command = /^(doodstream|dooddl|dood)$/i

export default handler
