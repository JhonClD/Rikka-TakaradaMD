// plugins/vidhide-dl.js — Descargador independiente para VidHide / FileLions / EarnVids
// Soporta callistanise (/file/, /v/), morencius, peytonepre, smoothpre y failover de mirrors.
// Desempaqueta scripts base-62 (sin eval), selecciona mejor calidad HLS y remuxea a MP4.

import * as cheerio from 'cheerio'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createDecipheriv, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegStatic from 'ffmpeg-static'
import { TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'
import { resolveJkAnimeEpisodeInput } from './lib/jkanime-episode-servers.js'

const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 20_000
const SEGMENT_TIMEOUT_MS = 180_000
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.VIDHIDE_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const HLS_CONCURRENCY = 2

const VIDHIDE_HOST_RE = /(?:^|\.)(?:vidhide[a-z0-9]*\.|filelions\.|dhtpre\.|peytonepre\.|movearnpre\.|niikaplayerr\.|dinisglows\.|ryderjet\.|smoothpre\.|earnvids[a-z0-9]*\.|callistanise\.|morencius\.|seraphinapl\.|mivalyo\.|bingezove\.|premilkyway\.|dintezuvio\.|minochinos\.|taylorplayer\.|guccihide\.|ahvsh\.|streamhide\.)/i

const ACTIVE_MIRRORS = ['callistanise.com', 'morencius.com', 'peytonepre.com', 'smoothpre.com']

let wreqPromise = null
let wreqUnavailable = false
let activeUa = FALLBACK_UA

function resolveFfmpegBin() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    ffmpegStatic,
  ].filter(Boolean)
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return bin
    } catch (_) {}
  }
  return 'ffmpeg'
}

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

function safeName(value, fallback = 'vidhide-video') {
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

async function clientFetch(session, url, { headers = {}, timeout = PAGE_TIMEOUT_MS, signal, preferNative = false } = {}) {
  const reqHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null && v !== '') reqHeaders[k.toLowerCase()] = String(v)
  }
  const nativeCall = () => globalThis.fetch(url, {
    headers: { 'user-agent': activeUa, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...reqHeaders },
    redirect: 'follow',
    signal: combineSignal(signal, timeout),
  })
  const wreqCall = () => session.fetch(url, {
    headers: reqHeaders,
    timeout,
    redirect: 'follow',
    signal: combineSignal(signal, timeout),
  })

  if (!session || preferNative) {
    try {
      return await nativeCall()
    } catch (err) {
      if (signal?.aborted || !session) throw err
      return wreqCall()
    }
  }
  try {
    return await wreqCall()
  } catch (err) {
    if (signal?.aborted) throw err
    return nativeCall()
  }
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

export function parseVidHideUrl(value) {
  const raw = (String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim())
    .replace(/[),.!?;:'"\]}>]+$/g, '')
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de VidHide.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !VIDHIDE_HOST_RE.test(url.hostname)) {
    throw new Error('Solo acepto enlaces de VidHide / FileLions o sus mirrors conocidos (ej. callistanise.com, morencius.com, peytonepre.com).')
  }
  const m = url.pathname.match(/^\/(?:(?:e|v|d|f|w|file|embed|download)\/)?([a-z0-9_-]{6,64})(?:\/|$)/i)
  if (!m) throw new Error('No pude reconocer el identificador del video en VidHide.')
  const id = m[1]
  const embedUrl = `${url.origin}/v/${id}`
  const altEmbed = `${url.origin}/embed/${id}`
  const mirrorUrls = ACTIVE_MIRRORS
    .filter(host => host !== url.hostname.toLowerCase())
    .map(host => `https://${host}/v/${id}`)
  const candidates = [...new Set([embedUrl, url.href, altEmbed, ...mirrorUrls])]
  return { id, url: url.href, candidates }
}

export function extractVidHideMedia(html, pageUrl) {
  const chunks = [...unpackAll(html), String(html || '')]
  const origin = new URL(pageUrl).origin

  for (const chunk of chunks) {
    const clean = chunk.replace(/\\\//g, '/')
    const linksMatch = clean.match(/\blinks\s*=\s*(\{[^}]+\})/i)
    if (linksMatch) {
      try {
        const obj = JSON.parse(linksMatch[1])
        for (const key of ['hls4', 'hls2', 'hls3', 'mp4']) {
          const mediaUrl = safeHttpUrl(obj[key], pageUrl)
          if (mediaUrl) {
            return {
              url: mediaUrl,
              type: /\.m3u8(?:[?#]|$)/i.test(mediaUrl) || key.startsWith('hls') ? 'hls' : 'mp4',
              referer: `${origin}/`,
            }
          }
        }
      } catch (_) {}
    }

    const patterns = [
      /sources\s*:\s*\[\s*\{[^}]*?(?:file|src)\s*:\s*["']([^"']+)["']/i,
      /(?:file|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/i,
    ]
    for (const re of patterns) {
      const m = clean.match(re)
      if (!m?.[1]) continue
      const mediaUrl = safeHttpUrl(m[1], pageUrl)
      if (mediaUrl) {
        return {
          url: mediaUrl,
          type: /\.m3u8(?:[?#]|$)/i.test(mediaUrl) ? 'hls' : 'mp4',
          referer: `${origin}/`,
        }
      }
    }
  }
  return null
}

function stripDisguisedTsPrefix(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 188) return buf
  if (buf[0] === 0x47 && (buf.length < 376 || buf[188] === 0x47)) return buf

  const pngEnd = buf.indexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  if (pngEnd !== -1 && pngEnd + 8 < buf.length && buf[pngEnd + 8] === 0x47) {
    return buf.subarray(pngEnd + 8)
  }

  const limit = Math.min(buf.length - 564, 65_536)
  for (let i = 1; i <= limit; i += 1) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47 && (i + 564 >= buf.length || buf[i + 564] === 0x47)) {
      return buf.subarray(i)
    }
  }
  return buf
}

function selectBestHlsVariant(masterText, masterUrl) {
  const lines = String(masterText || '').split(/\r?\n/).map(l => l.trim())
  if (/^#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/im.test(masterText)) return null
  const variants = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue
    const bw = Number(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || 0)
    const resH = Number(lines[i].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0)
    let j = i + 1
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j += 1
    if (j < lines.length) {
      const url = safeHttpUrl(lines[j], masterUrl)
      if (url) variants.push({ url, bw, resH })
    }
  }
  if (!variants.length) return null
  variants.sort((a, b) => (b.bw - a.bw) || (b.resH - a.resH))
  return variants[0].url
}

function parseMediaPlaylist(text, playlistUrl) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim())
  if (lines.some(l => l.startsWith('#EXT-X-MAP:') || l.startsWith('#EXT-X-BYTERANGE:'))) return null
  let mediaSequence = 0
  let keyInfo = null
  const segments = []
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = line.match(/METHOD=([^,\s]+)/i)?.[1]?.toUpperCase() || 'NONE'
      if (method === 'NONE') {
        keyInfo = null
      } else if (method === 'AES-128') {
        const uri = line.match(/URI="([^"]+)"/i)?.[1]
        const ivHex = line.match(/IV=0x([0-9a-f]+)/i)?.[1] || null
        const keyUrl = safeHttpUrl(uri, playlistUrl)
        if (!keyUrl) return null
        keyInfo = { method, keyUrl, ivHex }
      } else {
        return null
      }
    } else if (!line.startsWith('#')) {
      const segUrl = safeHttpUrl(line, playlistUrl)
      if (segUrl) segments.push({ url: segUrl, key: keyInfo ? { ...keyInfo } : null, seq: mediaSequence + segments.length })
    }
  }
  return segments.length ? segments : null
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
      throw new Error('VidHide devolvió HTML/error en lugar de video.')
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
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(createAbortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  const watchdog = createIdleWatchdog(() => ctrl.abort(new Error('Descarga sin datos durante 90s.')))
  try {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    const res = await clientFetch(session, mediaUrl, {
      headers: { accept: '*/*', ...(referer ? { referer } : {}) },
      timeout: DOWNLOAD_TIMEOUT_MS,
      signal: ctrl.signal,
      preferNative: true,
    })
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

function spawnProcess(bin, args, timeoutMs, signal, label) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError())
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errBuf = ''
    proc.stderr.on('data', d => { errBuf = (errBuf + d.toString()).slice(-8192) })
    const onAbort = () => { proc.kill('SIGKILL'); reject(createAbortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${label} timeout`)) }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(errBuf.trim() || `${label} código ${code}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}

async function remuxTsToMp4(tsPath, destPath, signal) {
  const ffmpegBin = resolveFfmpegBin()
  const partPath = `${destPath}.part.mp4`
  const variants = [
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', tsPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', partPath],
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', tsPath, '-c', 'copy', '-movflags', '+faststart', partPath],
  ]
  let lastErr = null
  for (const args of variants) {
    try {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      await spawnProcess(ffmpegBin, args, DOWNLOAD_TIMEOUT_MS, signal, 'ffmpeg')
      const stat = await validateVideo(partPath)
      await fsp.rename(partPath, destPath)
      return stat
    } catch (err) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
  }
  throw lastErr || new Error('ffmpeg no pudo remuxear el video.')
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

async function readStreamBuffer(res, watchdog) {
  const chunks = []
  for await (const c of toNodeReadable(res)) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
    chunks.push(b)
    watchdog?.ping()
  }
  return Buffer.concat(chunks)
}

async function fetchSegmentBuffer(session, segUrl, referer, signal, watchdog) {
  const origin = referer ? referer.replace(/\/$/, '') : ''
  const attempts = [
    { headers: { accept: '*/*', ...(referer ? { referer, origin } : {}) }, useWreq: false },
    { headers: { accept: '*/*' }, useWreq: false },
    { headers: { accept: '*/*', ...(referer ? { referer, origin } : {}) }, useWreq: false },
    { headers: { accept: '*/*', ...(referer ? { referer, origin } : {}) }, useWreq: true },
  ]
  let lastErr = null
  for (let i = 0; i < attempts.length; i += 1) {
    if (signal?.aborted) throw createAbortError()
    const { headers, useWreq } = attempts[i]
    try {
      const res = useWreq && session
        ? await session.fetch(segUrl, { headers, timeout: SEGMENT_TIMEOUT_MS, redirect: 'follow', signal: combineSignal(signal, SEGMENT_TIMEOUT_MS) })
        : await globalThis.fetch(segUrl, {
          headers: { 'user-agent': activeUa, ...headers },
          redirect: 'follow',
          signal: combineSignal(signal, SEGMENT_TIMEOUT_MS),
        })
      if (!res.ok) { await cancelBody(res); lastErr = new Error(`Segmento HTTP ${res.status}`); continue }
      const buf = await readStreamBuffer(res, watchdog)
      if (buf.length > 0) return buf
      lastErr = new Error('Segmento vacío')
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
    if (i + 1 < attempts.length) await sleep(600 * (i + 1), signal)
  }
  throw lastErr || new Error('No se pudo descargar un segmento HLS.')
}

async function resolveHlsVariant(session, m3u8Url, referer, signal) {
  const origin = referer ? referer.replace(/\/$/, '') : ''
  const reqHeaders = { accept: '*/*', ...(referer ? { referer, origin } : {}) }
  const masterRes = await clientFetch(session, m3u8Url, { headers: reqHeaders, timeout: PAGE_TIMEOUT_MS, signal, preferNative: true })
  if (!masterRes.ok) { await cancelBody(masterRes); throw new Error(`M3U8 devolvió HTTP ${masterRes.status}`) }
  let playlistUrl = masterRes.url || m3u8Url
  let playlistText = await masterRes.text()
  let variantUrl = playlistUrl

  if (/#EXT-X-STREAM-INF:/i.test(playlistText)) {
    const bestUrl = selectBestHlsVariant(playlistText, playlistUrl)
    if (!bestUrl) return { playlistUrl, playlistText, variantUrl, segments: null }
    variantUrl = bestUrl
    const varRes = await clientFetch(session, bestUrl, { headers: reqHeaders, timeout: PAGE_TIMEOUT_MS, signal, preferNative: true })
    if (!varRes.ok) { await cancelBody(varRes); throw new Error(`Variante HLS devolvió HTTP ${varRes.status}`) }
    playlistUrl = varRes.url || bestUrl
    playlistText = await varRes.text()
  }

  return { playlistUrl, playlistText, variantUrl, segments: parseMediaPlaylist(playlistText, playlistUrl) }
}

async function downloadHlsNative(session, resolved, destPath, referer, signal, onProgress) {
  const { segments, playlistUrl } = resolved
  if (!segments) throw new Error('Formato HLS no apto para descarga nativa.')
  // CDNs como acek-cdn.com (?sp=500) penalizan múltiples conexiones simultáneas (~67 KB/s vs ~480 KB/s en 1 hilo).
  const concurrency = /[?&]sp=\d+/i.test(String(playlistUrl || '')) ? 1 : HLS_CONCURRENCY

  const keyCache = new Map()
  const tsPath = `${destPath}.stream.ts`
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(createAbortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  const watchdog = createIdleWatchdog(() => ctrl.abort(new Error('Descarga HLS sin datos durante 90s.')))

  try {
    await fsp.rm(tsPath, { force: true }).catch(() => {})
    const fh = await fsp.open(tsPath, 'w')
    let totalBytes = 0
    let done = 0
    let lastReport = 0
    try {
      for (let i = 0; i < segments.length; i += concurrency) {
        if (ctrl.signal.aborted) throw createAbortError()
        const batch = segments.slice(i, i + concurrency)
        const buffers = await Promise.all(batch.map(async (seg) => {
          let raw = await fetchSegmentBuffer(session, seg.url, referer, ctrl.signal, watchdog)
          if (seg.key?.method === 'AES-128') {
            let keyBuf = keyCache.get(seg.key.keyUrl)
            if (!keyBuf) {
              keyBuf = await fetchSegmentBuffer(session, seg.key.keyUrl, referer, ctrl.signal, watchdog)
              keyCache.set(seg.key.keyUrl, keyBuf)
            }
            const iv = Buffer.alloc(16)
            if (seg.key.ivHex) {
              Buffer.from(seg.key.ivHex.padStart(32, '0').slice(-32), 'hex').copy(iv)
            } else {
              iv.writeBigUInt64BE(BigInt(seg.seq), 8)
            }
            const decipher = createDecipheriv('aes-128-cbc', keyBuf, iv)
            raw = Buffer.concat([decipher.update(raw), decipher.final()])
          }
          return stripDisguisedTsPrefix(raw)
        }))
        for (const chunk of buffers) {
          totalBytes += chunk.length
          done += 1
          if (totalBytes > MAX_VIDEO_BYTES) throw new Error('El video supera el límite de 2 GB.')
          await fh.write(chunk)
        }
        const now = Date.now()
        if (onProgress && (now - lastReport >= 12_000 || done === segments.length)) {
          lastReport = now
          onProgress({ done, total: segments.length, bytes: totalBytes })
        }
      }
    } finally {
      await fh.close()
    }
    return await remuxTsToMp4(tsPath, destPath, signal)
  } finally {
    watchdog.stop()
    signal?.removeEventListener('abort', onAbort)
    await fsp.rm(tsPath, { force: true }).catch(() => {})
  }
}

async function downloadHlsStream(session, m3u8Url, destPath, referer, signal, onProgress) {
  let nativeErr = null
  let targetUrl = m3u8Url
  try {
    const resolved = await resolveHlsVariant(session, m3u8Url, referer, signal)
    if (resolved.variantUrl) targetUrl = resolved.variantUrl
    return await downloadHlsNative(session, resolved, destPath, referer, signal, onProgress)
  } catch (err) {
    if (signal?.aborted) throw createAbortError()
    nativeErr = err
  }

  const dir = path.dirname(destPath)
  const tmpBase = path.join(dir, `vidhide_${Date.now()}`)
  const ytArgs = [
    '--no-check-certificate', '--no-warnings', '--concurrent-fragments', '4',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${activeUa}`,
    '--add-header', `Referer: ${referer}`,
    '-o', `${tmpBase}.%(ext)s`,
    targetUrl,
  ]
  try {
    await spawnProcess('yt-dlp', ytArgs, DOWNLOAD_TIMEOUT_MS, signal, 'yt-dlp')
    const files = (await fsp.readdir(dir)).filter(f => f.startsWith(path.basename(tmpBase)) && /\.(mp4|mkv|webm)$/i.test(f))
    if (!files.length) throw new Error('yt-dlp no generó archivo')
    const src = path.join(dir, files[0])
    const stat = await validateVideo(src)
    await fsp.rename(src, destPath)
    return stat
  } catch (ytErr) {
    if (signal?.aborted) throw createAbortError()
    const partPath = `${destPath}.part.mp4`
    try {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      await spawnProcess(resolveFfmpegBin(), [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
        '-user_agent', activeUa,
        '-headers', `Referer: ${referer}\r\n`,
        '-rw_timeout', '60000000',
        '-http_persistent', '0',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_on_http_error', '403,408,429,500,502,503,504',
        '-reconnect_delay_max', '5',
        '-i', targetUrl,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        partPath,
      ], DOWNLOAD_TIMEOUT_MS, signal, 'ffmpeg')
      const stat = await validateVideo(partPath)
      await fsp.rename(partPath, destPath)
      return stat
    } catch (ffErr) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      throw new Error(`HLS falló (nativo: ${nativeErr?.message || 'n/a'} | yt-dlp: ${ytErr.message} | ffmpeg: ${ffErr.message})`)
    }
  }
}

export async function downloadVidHideFile(inputUrl, outputPath, { signal, onProgress } = {}) {
  const parsed = parseVidHideUrl(inputUrl)
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
        let currentUrl = candidate
        let referer = `${new URL(candidate).origin}/`
        for (let hop = 0; hop < 3; hop += 1) {
          const res = await clientFetch(session, currentUrl, { headers: { referer }, signal })
          if (!res.ok) { await cancelBody(res); lastErr = new Error(`VidHide devolvió HTTP ${res.status}.`); break }
          const finalUrl = res.url || currentUrl
          const html = await res.text()
          media = extractVidHideMedia(html, finalUrl)
          if (media) break
          const $ = cheerio.load(html)
          const iframeSrc = $('iframe[src]').first().attr('src')
          const nextUrl = safeHttpUrl(iframeSrc, finalUrl)
          if (!nextUrl || nextUrl === finalUrl) break
          referer = finalUrl
          currentUrl = nextUrl
        }
        if (media) break
        lastErr = lastErr || new Error('VidHide no expuso una fuente m3u8/mp4 reconocible.')
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        lastErr = err
      }
    }
    if (!media) throw lastErr || new Error('No se pudo extraer el video de VidHide.')

    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    const stat = media.type === 'mp4'
      ? await downloadDirectMp4(session, media.url, outputPath, media.referer, signal)
      : await downloadHlsStream(session, media.url, outputPath, media.referer, signal, onProgress)
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
    return m.reply(`Envía o responde a un enlace de VidHide / FileLions.\nEjemplo: *${usedPrefix || '.'}${command || 'vidhide'} https://callistanise.com/file/ID*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'vidhide') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseVidHideUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'vidhide')) return m.reply('⏳ Ya tienes una descarga de VidHide activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'vidhide', controller, { label: `VidHide (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `vidhide_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `VidHide-${safeName(parsed.id)}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo *VidHide* · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *VidHide*…')
    const { fileSize } = await downloadVidHideFile(parsed.url, outputPath, {
      signal: controller.signal,
      onProgress: ({ done, total, bytes }) => {
        void update(`⬇️ Descargando *VidHide*… ${done}/${total} segs (${formatBytes(bytes)})`)
      },
    })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `VidHide-${safeName(parsed.id)}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *VidHide* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de VidHide cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde VidHide.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'vidhide', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['vidhide <enlace>']
handler.tags = ['downloader']
handler.command = /^(vidhide|vidhidedl|vhide)$/i

export default handler
