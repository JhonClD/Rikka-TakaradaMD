// plugins/streamtape-dl.js — Descargador independiente para StreamTape y mirrors
// Decodifica robotlink/norobotlink/ideoooolink (sin eval), soporta /e/, /v/, /f/ y descarga MP4 resiliente.

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
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.STREAMTAPE_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const PARALLEL_THREADS = 4
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024
const MAX_CHUNK_RETRIES = 3
const MAX_SEQ_RETRIES = 5

const STREAMTAPE_HOST_RE = /(?:^|\.)(?:streamtape\.|strtape\.|strtpe\.|stape\.|shavetape\.|stapadblockuser\.|adblockstrtech\.|tapepops\.|tapeadvertisement\.|watchadsontape\.|antiadtape\.)/i

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

function safeName(value, fallback = 'streamtape-video') {
  return String(value || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback
}

function safeHttpUrl(value, baseUrl) {
  if (typeof value !== 'string') return null
  let trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`
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
  throw lastErr || new Error('Error de red al conectar con StreamTape.')
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

export function parseStreamTapeUrl(value) {
  const raw = (String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim())
    .replace(/[),.!?;:'"\]}>]+$/g, '')
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de StreamTape.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !STREAMTAPE_HOST_RE.test(url.hostname)) {
    throw new Error('Solo acepto enlaces de StreamTape o sus mirrors conocidos.')
  }
  const m = url.pathname.match(/^\/(?:(?:e|v|f|d|file|embed)\/)?([a-z0-9_-]{6,64})(?:\/|$)/i)
  if (!m) throw new Error('No pude reconocer el identificador del video en StreamTape.')
  const id = m[1]
  const embedUrl = `${url.origin}/e/${id}`
  const viewUrl = `${url.origin}/v/${id}`
  return { id, url: embedUrl, candidates: [...new Set([embedUrl, viewUrl, url.href])] }
}

export function extractStreamTapeMedia(html, pageUrl = 'https://streamtape.com/') {
  const source = String(html || '')
  const re = /getElementById\(['"](?:robot|norobot|ideoooo|bot)link['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)((?:\.substring\(\d+\))*)/gi
  let chosen = null
  for (const m of source.matchAll(re)) {
    let suffix = m[2]
    const subs = [...m[3].matchAll(/\.substring\((\d+)\)/g)].map(s => Number(s[1]))
    if (subs.length) {
      for (const n of subs) suffix = suffix.substring(n)
    } else if (suffix.startsWith('xcd')) {
      suffix = suffix.slice(3)
    }
    const rawLink = `${m[1]}${suffix}`
    const candidate = safeHttpUrl(`${rawLink}${rawLink.includes('stream=1') ? '' : '&stream=1'}`, pageUrl)
    if (candidate) chosen = candidate
  }
  if (chosen) return { url: chosen, referer: pageUrl }
  return null
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
      throw new Error('StreamTape devolvió HTML/error en lugar de video.')
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
  throw lastErr || new Error('Falló la descarga de un bloque en StreamTape.')
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
        throw new Error(`StreamTape devolvió ${ct} en lugar de video.`)
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
  throw lastErr || new Error('No se pudo descargar el MP4 desde StreamTape.')
}

async function downloadDirectMp4(session, mediaUrl, destPath, referer, signal) {
  const partPath = `${destPath}.part`
  const headers = { accept: '*/*', ...(referer ? { referer } : {}) }
  let finalMediaUrl = mediaUrl
  let sizeBytes = 0
  let supportsRanges = false
  try {
    const head = await resilientFetch(session, mediaUrl, { method: 'HEAD', headers, timeout: 15_000, signal, preferNative: true })
    await cancelBody(head)
    if (head.ok) {
      if (head.url) finalMediaUrl = head.url
      const ct = String(head.headers?.get?.('content-type') || '').toLowerCase()
      if (/text\/html|application\/json/i.test(ct)) throw new Error(`StreamTape devolvió ${ct} en lugar de video.`)
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
            downloadRangeChunk(session, finalMediaUrl, fh, start, end, headers, watchdog, ctrl.signal)))
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
      await downloadSequentialResumable(session, finalMediaUrl, partPath, headers, sizeBytes, watchdog, ctrl.signal)
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

export async function downloadStreamTapeFile(inputUrl, outputPath, { signal } = {}) {
  const parsed = parseStreamTapeUrl(inputUrl)
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
    let media = null
    let lastErr = null
    for (const candidate of parsed.candidates) {
      try {
        const res = await resilientFetch(session, candidate, {
          headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', referer: `${new URL(candidate).origin}/` },
          signal,
        })
        if (!res.ok) { await cancelBody(res); lastErr = new Error(`StreamTape devolvió HTTP ${res.status}.`); continue }
        const html = await res.text()
        media = extractStreamTapeMedia(html, res.url || candidate)
        if (media) break
        lastErr = new Error('StreamTape no expuso el token robotlink (el video pudo ser eliminado).')
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        lastErr = err
      }
    }
    if (!media) throw lastErr || new Error('No se pudo extraer el video de StreamTape.')

    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    const stat = await downloadDirectMp4(session, media.url, outputPath, media.referer, signal)
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
    return m.reply(`Envía o responde a un enlace de StreamTape.\nEjemplo: *${usedPrefix || '.'}${command || 'streamtape'} https://streamtape.com/e/ID*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'streamtape') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseStreamTapeUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'streamtape')) return m.reply('⏳ Ya tienes una descarga de StreamTape activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'streamtape', controller, { label: `StreamTape (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `streamtape_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `StreamTape-${safeName(parsed.id)}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo *StreamTape* · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *StreamTape*…')
    const { fileSize } = await downloadStreamTapeFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `StreamTape-${safeName(parsed.id)}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *StreamTape* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de StreamTape cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde StreamTape.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'streamtape', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['streamtape <enlace>']
handler.tags = ['downloader']
handler.command = /^(streamtape|streamtapedl|stape)$/i

export default handler
