// plugins/embed-dl.js — Descargador genérico para enlaces embed/reproductores públicos
// Soporta MP4/M3U8 directos, iframes anidados, scripts empaquetados base-62,
// DPlayer, JWPlayer, <video>/<source>, yt-dlp y ffmpeg-static.

import * as cheerio from 'cheerio'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegStatic from 'ffmpeg-static'
import { TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'

const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.EMBED_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024
const FFMPEG_BIN = ffmpegStatic || process.env.FFMPEG_PATH || 'ffmpeg'

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

function safeName(value, fallback = 'embed-video') {
  return String(value || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback
}

function isPublicHttpUrl(value, baseUrl) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  try {
    const url = new URL(trimmed, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null
    if (isIP(host)) {
      if (host.includes(':')) return null
      const [a, b] = host.split('.').map(Number)
      if (
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      ) return null
    }
    return url
  } catch (_) {
    return null
  }
}

function decodeBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8').trim()
    if (!decoded || /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded)) return null
    return decoded
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

export function parseEmbedUrl(value) {
  const raw = (String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim())
    .replace(/[),.!?;:'"\]}>]+$/g, '')
  const url = isPublicHttpUrl(raw)
  if (!url) throw new Error('El enlace no es una URL HTTP/HTTPS pública válida.')
  const hostSlug = url.hostname.replace(/^www\./, '').split('.')[0] || 'embed'
  const lastSeg = url.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.html?$/i, '') || 'video'
  return { url: url.href, host: url.hostname, id: safeName(`${hostSlug}-${lastSeg}`.slice(0, 48), 'embed') }
}

export function extractEmbedMedia(html, pageUrl) {
  const source = String(html || '')
  const origin = new URL(pageUrl).origin
  const $ = cheerio.load(source)

  const domSrc = $('source[src*=".m3u8"], source[src*=".mp4"], video[src*=".m3u8"], video[src*=".mp4"]').first().attr('src')
  const domUrl = isPublicHttpUrl(domSrc, pageUrl)
  if (domUrl) {
    return {
      url: domUrl.href,
      type: /\.m3u8(?:[?#]|$)/i.test(domUrl.href) ? 'hls' : 'mp4',
      referer: `${origin}/`,
    }
  }

  const chunks = [...unpackAll(source), source]
  for (const chunk of chunks) {
    const clean = chunk.replace(/\\\//g, '/')
    const dpIdx = clean.indexOf('new DPlayer({')
    if (dpIdx >= 0) {
      const m = clean.slice(dpIdx, dpIdx + 4096).match(/\burl\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/i)
      const u = m?.[1] && isPublicHttpUrl(m[1], pageUrl)
      if (u) return { url: u.href, type: /\.m3u8(?:[?#]|$)/i.test(u.href) ? 'hls' : 'mp4', referer: `${origin}/` }
    }

    const linksMatch = clean.match(/\blinks\s*=\s*(\{[^}]+\})/i)
    if (linksMatch) {
      try {
        const obj = JSON.parse(linksMatch[1])
        for (const key of ['hls4', 'hls2', 'hls3', 'mp4']) {
          const u = isPublicHttpUrl(obj[key], pageUrl)
          if (u) {
            return {
              url: u.href,
              type: /\.m3u8(?:[?#]|$)/i.test(u.href) || key.startsWith('hls') ? 'hls' : 'mp4',
              referer: `${origin}/`,
            }
          }
        }
      } catch (_) {}
    }

    const patterns = [
      /sources\s*:\s*\[\s*\{[^}]*?(?:file|src)\s*:\s*["']([^"']+)["']/i,
      /(?:file|src|video_url|mp4|hls)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/i,
    ]
    for (const re of patterns) {
      const m = clean.match(re)
      const u = m?.[1] && isPublicHttpUrl(m[1], pageUrl)
      if (u) return { url: u.href, type: /\.m3u8(?:[?#]|$)/i.test(u.href) ? 'hls' : 'mp4', referer: `${origin}/` }
    }

    for (const m of clean.matchAll(/atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/gi)) {
      const decoded = decodeBase64(m[2])
      const u = decoded && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(decoded) && isPublicHttpUrl(decoded, pageUrl)
      if (u) return { url: u.href, type: /\.m3u8(?:[?#]|$)/i.test(u.href) ? 'hls' : 'mp4', referer: `${origin}/` }
    }
  }
  return null
}

async function resolveEmbedStream(session, embedUrl, referer, signal) {
  if (/\.mp4(?:[?#]|$)/i.test(embedUrl)) return { url: embedUrl, type: 'mp4', referer: referer || `${new URL(embedUrl).origin}/` }
  if (/\.m3u8(?:[?#]|$)/i.test(embedUrl)) return { url: embedUrl, type: 'hls', referer: referer || `${new URL(embedUrl).origin}/` }

  let currentUrl = embedUrl
  let currentReferer = referer || `${new URL(embedUrl).origin}/`
  const visited = new Set([currentUrl])

  for (let hop = 0; hop < 3; hop += 1) {
    const res = await clientFetch(session, currentUrl, { headers: { referer: currentReferer }, signal })
    if (!res.ok) { await cancelBody(res); return null }
    const ct = String(res.headers?.get?.('content-type') || '').toLowerCase()
    const finalUrl = res.url || currentUrl
    if (ct.startsWith('video/')) {
      await cancelBody(res)
      return { url: finalUrl, type: 'mp4', referer: currentReferer }
    }
    if (ct.includes('mpegurl') || ct.includes('m3u8')) {
      await cancelBody(res)
      return { url: finalUrl, type: 'hls', referer: currentReferer }
    }
    const html = await res.text()
    const found = extractEmbedMedia(html, finalUrl)
    if (found) return found

    const $ = cheerio.load(html)
    const nextRaw = $('iframe[src]').first().attr('src')
    const nextUrl = nextRaw && isPublicHttpUrl(nextRaw, finalUrl)
    if (!nextUrl || visited.has(nextUrl.href)) break
    visited.add(nextUrl.href)
    currentReferer = finalUrl
    currentUrl = nextUrl.href
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
      throw new Error('El servidor devolvió HTML/error en lugar de video.')
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
      if (/text\/html|application\/json/i.test(ct)) throw new Error(`El servidor devolvió ${ct} en lugar de video.`)
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

async function downloadWithYtDlpOrFfmpeg(videoUrl, destPath, referer, isHls, signal) {
  const dir = path.dirname(destPath)
  const tmpBase = path.join(dir, `embed_${Date.now()}`)
  const ytArgs = [
    '--no-check-certificate', '--no-warnings', '--concurrent-fragments', '8',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${activeUa}`,
    '--add-header', `Referer: ${referer}`,
    '-o', `${tmpBase}.%(ext)s`,
    videoUrl,
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
    if (!isHls && !/\.m3u8(?:[?#]|$)/i.test(videoUrl)) throw ytErr
    const partPath = `${destPath}.part.mp4`
    try {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      await spawnProcess(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-headers', `User-Agent: ${activeUa}\r\nReferer: ${referer}\r\n`,
        '-i', videoUrl,
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
      throw new Error(`Descarga falló (yt-dlp: ${ytErr.message} | ffmpeg: ${ffErr.message})`)
    }
  }
}

export async function downloadEmbedFile(inputUrl, outputPath, { referer, signal } = {}) {
  const parsed = parseEmbedUrl(inputUrl)
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
    const resolved = await resolveEmbedStream(session, parsed.url, referer, signal).catch(() => null)
    const videoUrl = resolved?.url || parsed.url
    const videoType = resolved?.type || 'unknown'
    const videoReferer = resolved?.referer || referer || `${new URL(parsed.url).origin}/`

    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.rm(outputPath, { force: true }).catch(() => {})

    let stat
    if (videoType === 'mp4') {
      try {
        stat = await downloadDirectMp4(session, videoUrl, outputPath, videoReferer, signal)
      } catch (err) {
        if (signal?.aborted) throw createAbortError()
        stat = await downloadWithYtDlpOrFfmpeg(videoUrl, outputPath, videoReferer, false, signal)
      }
    } else {
      stat = await downloadWithYtDlpOrFfmpeg(videoUrl, outputPath, videoReferer, videoType === 'hls', signal)
    }
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
    return m.reply(`Envía o responde a un enlace embed de video.\nEjemplo: *${usedPrefix || '.'}${command || 'embed'} https://servidor.ejemplo/e/ID*`)
  }
  let parsed
  try { parsed = parseEmbedUrl(input) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'embed')) return m.reply('⏳ Ya tienes una descarga de Embed activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'embed', controller, { label: `Embed (${parsed.host})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `embed_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `${parsed.id}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Analizando embed en *${parsed.host}*…` }, { quoted: m })
    statusKey = sent?.key || null
    await update(`⬇️ Descargando video desde *${parsed.host}*…`)
    const { fileSize } = await downloadEmbedFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `${parsed.id}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *Embed* (${parsed.host}) completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de Embed cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar el embed.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'embed', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['embed <enlace>']
handler.tags = ['downloader']
handler.command = /^(embed|embeddl|embdl)$/i

export default handler
