// plugins/mixdrop-dl.js — Descargador independiente para Mixdrop y mirrors
// Desempaqueta MDCore.wurl en base-62 (sin eval) y descarga MP4 en paralelo.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
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
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.MIXDROP_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024

const MIXDROP_HOST_RE = /(?:^|\.)(?:mixdrop[a-z0-9]*\.|mxdrop\.|mdbekjwqa\.|mdy48tn97\.|mdfx9dc8n\.|mdzsmutpcvykb\.)/i

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

function safeName(value, fallback = 'mixdrop-video') {
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

function unpackAll(html) {
  const outputs = []
  const re = /eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]*?\}\s*\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g
  for (const m of String(html || '').matchAll(re)) {
    try {
      const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
      const radix = Number(m[2]) || 36
      const count = Number(m[3]) || 0
      const symtab = m[4].split('|')
      const encode = (n) => {
        const d = n % radix
        const c = d > 35 ? String.fromCharCode(d + 29) : d.toString(36)
        return (n < radix ? '' : encode(Math.floor(n / radix))) + c
      }
      const table = new Map()
      for (let i = Math.max(count, symtab.length) - 1; i >= 0; i -= 1) {
        const key = encode(i)
        table.set(key, symtab[i] || key)
      }
      outputs.push(payload.replace(/\b\w+\b/g, w => (table.has(w) ? table.get(w) : w)))
    } catch (_) {}
  }
  return outputs
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

async function clientFetch(session, url, { method = 'GET', headers = {}, timeout = PAGE_TIMEOUT_MS, signal } = {}) {
  const reqHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null && v !== '') reqHeaders[k.toLowerCase()] = String(v)
  }
  const combined = combineSignal(signal, timeout)
  if (session) return session.fetch(url, { method, headers: reqHeaders, timeout, redirect: 'follow', signal: combined })
  return globalThis.fetch(url, {
    method,
    headers: { 'user-agent': activeUa, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...reqHeaders },
    redirect: 'follow',
    signal: combined,
  })
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

export function parseMixdropUrl(value) {
  let raw = (String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim())
    .replace(/[),.!?;:'"\]}>]+$/g, '')
  raw = raw.replace(/^.*?\/jkvmixdrop\.php\?u=/i, 'https://mixdrop.ag/e/')
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de Mixdrop.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !MIXDROP_HOST_RE.test(url.hostname)) {
    throw new Error('Solo acepto enlaces de Mixdrop o sus mirrors conocidos.')
  }
  const m = url.pathname.match(/^\/(?:(?:e|f|d)\/)?([a-z0-9_-]{6,64})(?:\/|$)/i)
  if (!m) throw new Error('No pude reconocer el identificador del video en Mixdrop.')
  const id = m[1]
  const embedUrl = `${url.origin}/e/${id}`
  return { id, url: embedUrl, candidates: [...new Set([embedUrl, url.href])] }
}

export function extractMixdropMedia(html, pageUrl = 'https://mixdrop.co/') {
  const chunks = [...unpackAll(html), String(html || '')]
  const patterns = [
    /MDCore\.wurl\s*=\s*["']([^"']+)["']/i,
    /\bwurl\s*=\s*["']([^"']+)["']/i,
    /\bvsrc\s*=\s*["']([^"']+)["']/i,
    /\bfurl\s*=\s*["']([^"']+)["']/i,
  ]
  for (const chunk of chunks) {
    const clean = chunk.replace(/\\\//g, '/')
    for (const re of patterns) {
      const m = clean.match(re)
      if (!m?.[1]) continue
      const mediaUrl = safeHttpUrl(m[1], pageUrl)
      if (mediaUrl) {
        return { url: mediaUrl, referer: `${new URL(pageUrl).origin}/` }
      }
    }
  }
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
      throw new Error('Mixdrop devolvió HTML/error en lugar de video.')
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

async function downloadDirectMp4(session, mediaUrl, destPath, referer, signal) {
  const partPath = `${destPath}.part`
  const headers = { accept: '*/*', ...(referer ? { referer } : {}) }
  let sizeBytes = 0
  let supportsRanges = false
  try {
    const head = await clientFetch(session, mediaUrl, { method: 'HEAD', headers, timeout: 12_000, signal })
    await cancelBody(head)
    if (head.ok) {
      const ct = String(head.headers?.get?.('content-type') || '').toLowerCase()
      if (/text\/html|application\/json/i.test(ct)) throw new Error(`Mixdrop devolvió ${ct} en lugar de video.`)
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
          await Promise.all(ranges.map(async ({ start, end }) => {
            const r = await clientFetch(session, mediaUrl, {
              headers: { ...headers, range: `bytes=${start}-${end}` },
              timeout: DOWNLOAD_TIMEOUT_MS,
              signal: ctrl.signal,
            })
            if (r.status !== 206) { await cancelBody(r); throw new Error(`HTTP ${r.status}`) }
            let pos = start
            for await (const c of toNodeReadable(r)) {
              const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
              await fh.write(b, 0, b.length, pos)
              pos += b.length
              watchdog.ping()
            }
            if (pos - start !== end - start + 1) throw new Error('Bloque incompleto')
          }))
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
      const res = await clientFetch(session, mediaUrl, { headers, timeout: DOWNLOAD_TIMEOUT_MS, signal: ctrl.signal })
      if (!res.ok) { await cancelBody(res); throw new Error(`HTTP ${res.status}`) }
      let bytes = 0
      const guard = new Transform({
        transform(c, _e, cb) {
          bytes += c.length
          watchdog.ping()
          if (bytes > MAX_VIDEO_BYTES) cb(new Error('El video supera el límite de 2 GB.'))
          else cb(null, c)
        },
      })
      await pipeline(toNodeReadable(res), guard, fs.createWriteStream(partPath))
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

export async function downloadMixdropFile(inputUrl, outputPath, { signal } = {}) {
  const parsed = parseMixdropUrl(inputUrl)
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
        const res = await clientFetch(session, candidate, {
          headers: { referer: `${new URL(candidate).origin}/` },
          signal,
        })
        if (!res.ok) { await cancelBody(res); lastErr = new Error(`Mixdrop devolvió HTTP ${res.status}.`); continue }
        const html = await res.text()
        media = extractMixdropMedia(html, res.url || candidate)
        if (media) break
        lastErr = new Error('Mixdrop no expuso el enlace wurl del video.')
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        lastErr = err
      }
    }
    if (!media) throw lastErr || new Error('No se pudo extraer el video de Mixdrop.')

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
    return m.reply(`Envía o responde a un enlace de Mixdrop.\nEjemplo: *${usedPrefix || '.'}${command || 'mixdrop'} https://mixdrop.ag/e/ID*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'mixdrop') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseMixdropUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'mixdrop')) return m.reply('⏳ Ya tienes una descarga de Mixdrop activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'mixdrop', controller, { label: `Mixdrop (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `mixdrop_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `Mixdrop-${safeName(parsed.id)}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo *Mixdrop* · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *Mixdrop*…')
    const { fileSize } = await downloadMixdropFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `Mixdrop-${safeName(parsed.id)}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *Mixdrop* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de Mixdrop cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde Mixdrop.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'mixdrop', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['mixdrop <enlace>']
handler.tags = ['downloader']
handler.command = /^(mixdrop|mixdropdl|mdrop)$/i

export default handler
