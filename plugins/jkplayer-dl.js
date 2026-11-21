// plugins/jkplayer-dl.js — Descargador independiente para enlaces JKPlayer (JKAnime)
// Soporta jkplayer/*, um.php, um2.php, umv.php, stream/jkmedia y /jk.php?u=...

import * as cheerio from 'cheerio'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegStatic from 'ffmpeg-static'
import { TEMP_VIDEOS_DIR } from '../src/funcion/paths.js'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'
import { resolveJkAnimeEpisodeInput } from './lib/jkanime-episode-servers.js'

const JKANIME_URL = String(process.env.JK_BASE_URL || 'https://jkanime.net').replace(/\/+$/, '')
const JKANIME_HOST = (() => {
  try { return new URL(JKANIME_URL).hostname.toLowerCase().replace(/^www\./, '') } catch (_) { return 'jkanime.net' }
})()
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.JKPLAYER_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
const PARALLEL_THREADS = 8
const MIN_PARALLEL_BYTES = 5 * 1024 * 1024
const FFMPEG_BIN = ffmpegStatic || process.env.FFMPEG_PATH || 'ffmpeg'

let wreqPromise = null
let wreqUnavailable = false
let sessionPromise = null
let activeUa = String(process.env.JK_UA || '').trim() || FALLBACK_UA

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

function safeName(value, fallback = 'jkplayer-video') {
  return String(value || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback
}

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === JKANIME_HOST || host.endsWith(`.${JKANIME_HOST}`) || /(^|\.)jkanime\.net$/i.test(host)
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

async function getWreq() {
  if (wreqUnavailable) return null
  if (!wreqPromise) {
    wreqPromise = import('wreq-js')
      .then((mod) => {
        if (!process.env.JK_UA && typeof mod.getEmulationHeaders === 'function') {
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

async function getSession() {
  const wreq = await getWreq()
  if (!wreq) return null
  if (!sessionPromise) {
    const proxy = String(process.env.JK_PROXY_URL || '').trim()
    sessionPromise = wreq.createSession({
      browser: 'chrome',
      os: 'windows',
      timeout: PAGE_TIMEOUT_MS,
      defaultHeaders: { 'accept-language': 'es-419,es;q=0.9,en;q=0.8' },
      ...(proxy ? { proxy } : {}),
    }).then((session) => {
      for (const part of String(process.env.JK_COOKIE || '').split(';')) {
        const idx = part.indexOf('=')
        if (idx <= 0) continue
        try { session.setCookie(part.slice(0, idx).trim(), part.slice(idx + 1).trim(), JKANIME_URL) } catch (_) {}
      }
      return session
    }).catch(() => {
      sessionPromise = null
      return null
    })
  }
  return sessionPromise
}

async function rawFetch(url, { method = 'GET', headers = {}, body, timeout = PAGE_TIMEOUT_MS, signal } = {}) {
  const reqHeaders = {}
  if (process.env.JK_UA) reqHeaders['user-agent'] = activeUa
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null && v !== '') reqHeaders[k.toLowerCase()] = String(v)
  }
  const combined = combineSignal(signal, timeout)
  const session = await getSession()
  if (session) {
    return session.fetch(url, { method, headers: reqHeaders, body, timeout, redirect: 'follow', signal: combined })
  }
  return globalThis.fetch(url, {
    method,
    headers: {
      'user-agent': activeUa,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(process.env.JK_COOKIE ? { cookie: process.env.JK_COOKIE } : {}),
      ...reqHeaders,
    },
    body,
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

export function parseJkPlayerUrl(value) {
  let raw = String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim()
  raw = raw.replace(/[),.!?;:'"\]}>]+$/g, '')
  raw = raw.replace(/^.*?\/jk\.php\?u=/i, `${JKANIME_URL}/`)
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de JKPlayer.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isAllowedHost(url.hostname)) {
    throw new Error('Solo acepto enlaces de JKPlayer en jkanime.net.')
  }
  if (!/^\/(?:jkplayer\/[a-z0-9]+|um2?\.php|umv\.php|c\d+\.php|stream\/jkmedia)/i.test(url.pathname)) {
    throw new Error('El enlace no corresponde a un reproductor JKPlayer válido.')
  }
  const candidates = [url.href]
  const swapped = url.href
    .replace(/jkplayer\/um2\?/i, 'um2.php?')
    .replace(/jkplayer\/umv\?/i, 'umv.php?')
    .replace(/jkplayer\/um\?/i, 'um.php?')
  if (swapped !== url.href) candidates.unshift(swapped)
  const id = url.searchParams.get('e') || url.searchParams.get('u') || url.pathname.split('/').filter(Boolean).at(-1) || 'jkplayer'
  return { url: url.href, candidates, id: safeName(id.slice(0, 32), 'jkplayer') }
}

export function extractJkPlayerMedia(html, pageUrl = `${JKANIME_URL}/`) {
  const source = String(html || '').replace(/\\\//g, '/')
  const dplayerIdx = source.indexOf('new DPlayer({')
  if (dplayerIdx >= 0) {
    const dpMatch = source.slice(dplayerIdx, dplayerIdx + 4096).match(/\burl\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/i)
    if (dpMatch?.[1]) {
      return [{ url: dpMatch[1], type: /\.m3u8(?:[?#]|$)/i.test(dpMatch[1]) ? 'hls' : 'mp4', referer: pageUrl }]
    }
  }

  const $ = cheerio.load(source)
  const domSrc = $('source[src], video[src]').first().attr('src')
  const domUrl = safeHttpUrl(domSrc, pageUrl)
  if (domUrl && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(domUrl)) {
    return [{ url: domUrl, type: /\.m3u8(?:[?#]|$)/i.test(domUrl) ? 'hls' : 'mp4', referer: pageUrl }]
  }

  const candidates = []
  for (const m of source.matchAll(/['"](https?:\/\/[^'"\s\\]+\.(?:m3u8|mp4)[^'"\s\\]*)['"]/gi)) {
    candidates.push({ index: m.index, url: m[1] })
  }
  for (const m of source.matchAll(/atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/gi)) {
    const decoded = decodeBase64(m[2])
    if (decoded && /^https?:\/\//i.test(decoded) && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(decoded)) {
      candidates.push({ index: m.index, url: decoded })
    }
  }
  return candidates
    .sort((a, b) => b.index - a.index)
    .map(c => c.url)
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .map(u => ({ url: u, type: /\.m3u8(?:[?#]|$)/i.test(u) ? 'hls' : 'mp4', referer: pageUrl }))
}

async function resolveNozomiForm(html, pageUrl, signal) {
  const $ = cheerio.load(html)
  const value = $('form input[value]').attr('value')
  if (!value) return null
  const formHeaders = { 'content-type': 'application/x-www-form-urlencoded', referer: pageUrl, origin: JKANIME_URL }
  const r1 = await rawFetch(`${JKANIME_URL}/gsplay/redirect_post.php`, {
    method: 'POST',
    headers: formHeaders,
    body: `data=${encodeURIComponent(value)}`,
    signal,
  })
  await cancelBody(r1)
  const idx = String(r1.url || '').indexOf('player.html#')
  if (idx < 0) return null
  const id = r1.url.slice(idx + 'player.html#'.length)
  if (!id) return null
  const r2 = await rawFetch(`${JKANIME_URL}/gsplay/api.php`, {
    method: 'POST',
    headers: formHeaders,
    body: `v=${encodeURIComponent(id)}`,
    signal,
  })
  if (!r2.ok) { await cancelBody(r2); return null }
  const json = await r2.json().catch(() => null)
  const fileUrl = safeHttpUrl(json?.file, pageUrl)
  if (!fileUrl) return null
  return { url: fileUrl, type: /\.m3u8(?:[?#]|$)/i.test(fileUrl) ? 'hls' : 'mp4', referer: `${JKANIME_URL}/` }
}

async function resolveJkPlayerStream(parsed, signal) {
  let lastErr = null
  for (const candidate of parsed.candidates) {
    try {
      const res = await rawFetch(candidate, { headers: { referer: `${JKANIME_URL}/` }, signal })
      if (!res.ok) {
        await cancelBody(res)
        lastErr = new Error(`JKPlayer devolvió HTTP ${res.status}.`)
        continue
      }
      const ct = String(res.headers?.get?.('content-type') || '').toLowerCase()
      if (ct.startsWith('video/')) {
        await cancelBody(res)
        return { url: res.url || candidate, type: 'mp4', referer: `${JKANIME_URL}/` }
      }
      const html = await res.text()
      const finalUrl = res.url || candidate
      if (/um2/i.test(candidate)) {
        const nozomi = await resolveNozomiForm(html, finalUrl, signal)
        if (nozomi) return nozomi
      }
      const found = extractJkPlayerMedia(html, finalUrl)
      for (const item of found) {
        if (item.type === 'mp4') return item
        try {
          const check = await rawFetch(item.url, { headers: { referer: finalUrl }, timeout: 12_000, signal })
          const body = await check.text()
          if (check.ok && body.includes('#EXTM3U')) return item
        } catch (_) {}
      }
      if (found[0]) return found[0]
      lastErr = new Error('JKPlayer no expuso ningún enlace de video accesible.')
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
  }
  throw lastErr || new Error('No se pudo resolver el video de JKPlayer.')
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

async function downloadDirectMp4(mediaUrl, destPath, referer, signal) {
  const partPath = `${destPath}.part`
  const headers = { accept: '*/*', ...(referer ? { referer } : {}) }
  let sizeBytes = 0
  let supportsRanges = false
  try {
    const head = await rawFetch(mediaUrl, { method: 'HEAD', headers, timeout: 12_000, signal })
    await cancelBody(head)
    if (head.ok) {
      const ct = String(head.headers?.get?.('content-type') || '').toLowerCase()
      if (/text\/html|application\/json/i.test(ct)) throw new Error(`JKPlayer devolvió ${ct} en lugar de video.`)
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
            const r = await rawFetch(mediaUrl, {
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
      const res = await rawFetch(mediaUrl, { headers, timeout: DOWNLOAD_TIMEOUT_MS, signal: ctrl.signal })
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

async function downloadHlsStream(m3u8Url, destPath, referer, signal) {
  const dir = path.dirname(destPath)
  const tmpBase = path.join(dir, `jkplayer_${Date.now()}`)
  const ytArgs = [
    '--no-check-certificate', '--no-warnings', '--concurrent-fragments', '8',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${activeUa}`,
    '--add-header', `Referer: ${referer}`,
    '-o', `${tmpBase}.%(ext)s`,
    m3u8Url,
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
      await spawnProcess(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-headers', `User-Agent: ${activeUa}\r\nReferer: ${referer}\r\n`,
        '-i', m3u8Url,
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
      throw new Error(`HLS falló (yt-dlp: ${ytErr.message} | ffmpeg: ${ffErr.message})`)
    }
  }
}

export async function downloadJkPlayerFile(inputUrl, outputPath, { signal } = {}) {
  const parsed = parseJkPlayerUrl(inputUrl)
  await getWreq()
  const stream = await resolveJkPlayerStream(parsed, signal)
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  await fsp.rm(outputPath, { force: true }).catch(() => {})
  const stat = stream.type === 'mp4'
    ? await downloadDirectMp4(stream.url, outputPath, stream.referer, signal)
    : await downloadHlsStream(stream.url, outputPath, stream.referer, signal)
  return { filePath: outputPath, fileSize: stat.size, extension: '.mp4', mimetype: 'video/mp4' }
}

function getInput(m, text, args) {
  const quoted = m.quoted?.text || m.quoted?.caption || ''
  const value = String(text || args?.[0] || quoted || '').match(/https?:\/\/[^\s<>]+/i)?.[0] || ''
  return value.replace(/[),.!?;:'"\]}>]+$/g, '')
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = getInput(m, text, args)
  if (!input) {
    return m.reply(`Envía o responde a un enlace de JKPlayer.\nEjemplo: *${usedPrefix || '.'}${command || 'jkplayer'} https://jkanime.net/jkplayer/um?e=...*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'jkplayer') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseJkPlayerUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'jkplayer')) return m.reply('⏳ Ya tienes una descarga de JKPlayer activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'jkplayer', controller, { label: `JKPlayer (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `jkplayer_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `JKPlayer-${parsed.id}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: '🔎 Resolviendo enlace de *JKPlayer*…' }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *JKPlayer*…')
    const { fileSize } = await downloadJkPlayerFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `JKPlayer-${parsed.id}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *JKPlayer* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de JKPlayer cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde JKPlayer.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'jkplayer', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['jkplayer <enlace>']
handler.tags = ['downloader']
handler.command = /^(jkplayer|jkplayerdl|jkplay)$/i

export default handler
