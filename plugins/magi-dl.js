// plugins/magi-dl.js — Descargador independiente para enlaces Magi (JKAnime)
// Soporta jkplayer/umv?, umv.php? y manifiestos HLS/MP4.

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
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.MAGI_TIMEOUT_MS) || 45 * 60_000)
const IDLE_TIMEOUT_MS = 90_000
const MIN_VALID_BYTES = 128 * 1024
const MAX_VIDEO_BYTES = 2 * 1024 ** 3
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

function safeName(value, fallback = 'magi-video') {
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

async function rawFetch(url, { method = 'GET', headers = {}, timeout = PAGE_TIMEOUT_MS, signal } = {}) {
  const reqHeaders = {}
  if (process.env.JK_UA) reqHeaders['user-agent'] = activeUa
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null && v !== '') reqHeaders[k.toLowerCase()] = String(v)
  }
  const combined = combineSignal(signal, timeout)
  const session = await getSession()
  if (session) return session.fetch(url, { method, headers: reqHeaders, timeout, redirect: 'follow', signal: combined })
  return globalThis.fetch(url, {
    method,
    headers: {
      'user-agent': activeUa,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(process.env.JK_COOKIE ? { cookie: process.env.JK_COOKIE } : {}),
      ...reqHeaders,
    },
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

export function parseMagiUrl(value) {
  let raw = String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)?.[0] || String(value || '').trim()
  raw = raw.replace(/[),.!?;:'"\]}>]+$/g, '')
  raw = raw.replace(/^.*?\/jk\.php\?u=/i, `${JKANIME_URL}/`)
  let url
  try { url = new URL(raw) } catch (_) {
    throw new Error('El enlace no es una URL válida de Magi.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isAllowedHost(url.hostname)) {
    throw new Error('Solo acepto enlaces de Magi en jkanime.net.')
  }
  if (!/^\/(?:jkplayer\/umv|umv\.php)/i.test(url.pathname)) {
    throw new Error('El enlace no corresponde al reproductor Magi (jkplayer/umv o umv.php).')
  }
  const candidates = [url.href]
  const swapped = url.href.replace(/jkplayer\/umv\?/i, 'umv.php?')
  if (swapped !== url.href) candidates.unshift(swapped)
  const id = url.searchParams.get('e') || url.searchParams.get('u') || 'magi'
  return { url: url.href, candidates, id: safeName(id.slice(0, 32), 'magi') }
}

export function extractMagiMedia(html, pageUrl = `${JKANIME_URL}/`) {
  const source = String(html || '').replace(/\\\//g, '/')
  const $ = cheerio.load(source)
  const domHls = safeHttpUrl($('source[src*=".m3u8"]').first().attr('src'), pageUrl)
  if (domHls) return { url: domHls, type: 'hls', referer: `${JKANIME_URL}/` }
  const domAny = safeHttpUrl($('source[src], video[src]').first().attr('src'), pageUrl)
  if (domAny && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(domAny)) {
    return { url: domAny, type: /\.m3u8(?:[?#]|$)/i.test(domAny) ? 'hls' : 'mp4', referer: `${JKANIME_URL}/` }
  }
  const hits = []
  for (const m of source.matchAll(/['"](https?:\/\/[^'"\s\\]+\.(?:m3u8|mp4)[^'"\s\\]*)['"]/gi)) {
    hits.push({ index: m.index, url: m[1] })
  }
  for (const m of source.matchAll(/atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/gi)) {
    const decoded = decodeBase64(m[2])
    if (decoded && /^https?:\/\//i.test(decoded) && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(decoded)) {
      hits.push({ index: m.index, url: decoded })
    }
  }
  hits.sort((a, b) => b.index - a.index)
  if (hits[0]) {
    return { url: hits[0].url, type: /\.m3u8(?:[?#]|$)/i.test(hits[0].url) ? 'hls' : 'mp4', referer: `${JKANIME_URL}/` }
  }
  return null
}

async function resolveMagiStream(parsed, signal) {
  let lastErr = null
  for (const candidate of parsed.candidates) {
    try {
      const res = await rawFetch(candidate, { headers: { referer: `${JKANIME_URL}/` }, signal })
      if (!res.ok) {
        await cancelBody(res)
        lastErr = new Error(`Magi devolvió HTTP ${res.status}.`)
        continue
      }
      const html = await res.text()
      const found = extractMagiMedia(html, res.url || candidate)
      if (found) return found
      lastErr = new Error('Magi no expuso un enlace HLS/MP4 en la página.')
    } catch (err) {
      if (signal?.aborted) throw createAbortError()
      lastErr = err
    }
  }
  throw lastErr || new Error('No se pudo extraer el video de Magi.')
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
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(createAbortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  const watchdog = createIdleWatchdog(() => ctrl.abort(new Error('Descarga sin datos durante 90s.')))
  try {
    await fsp.rm(partPath, { force: true }).catch(() => {})
    const res = await rawFetch(mediaUrl, {
      headers: { accept: '*/*', ...(referer ? { referer } : {}) },
      timeout: DOWNLOAD_TIMEOUT_MS,
      signal: ctrl.signal,
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

async function downloadHlsStream(m3u8Url, destPath, referer, signal) {
  const dir = path.dirname(destPath)
  const tmpBase = path.join(dir, `magi_${Date.now()}`)
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

export async function downloadMagiFile(inputUrl, outputPath, { signal } = {}) {
  const parsed = parseMagiUrl(inputUrl)
  await getWreq()
  const stream = await resolveMagiStream(parsed, signal)
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
    return m.reply(`Envía o responde a un enlace de Magi.\nEjemplo: *${usedPrefix || '.'}${command || 'magi'} https://jkanime.net/jkplayer/umv?e=...*`)
  }
  let resolvedInput = input
  try { resolvedInput = await resolveJkAnimeEpisodeInput(input, 'magi') }
  catch (err) { return m.reply(`❌ ${err.message}`) }
  let parsed
  try { parsed = parseMagiUrl(resolvedInput) } catch (err) { return m.reply(`❌ ${err.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'magi')) return m.reply('⏳ Ya tienes una descarga de Magi activa en este chat. Usa *.cancelar* para detenerla.')

  const controller = new AbortController()
  const release = startDownload(key, 'magi', controller, { label: `Magi (${parsed.id})` })
  const tmpDir = path.join(TEMP_VIDEOS_DIR, `magi_${randomUUID()}`)
  const outputPath = path.join(tmpDir, `Magi-${parsed.id}.mp4`)
  let statusKey = null
  const update = async (msg) => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: msg, edit: statusKey }) } catch (_) {}
  }

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: '🔎 Resolviendo enlace de *Magi*…' }, { quoted: m })
    statusKey = sent?.key || null
    await update('⬇️ Descargando video desde *Magi*…')
    const { fileSize } = await downloadMagiFile(parsed.url, outputPath, { signal: controller.signal })
    let jpegThumbnail
    try { jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(outputPath) } catch (_) {}
    const fileName = `Magi-${parsed.id}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName,
      mimetype: 'video/mp4',
      jpegThumbnail,
      caption: `✅ *Magi* completado\n📦 ${formatBytes(fileSize)}`,
    }, { quoted: m })
    await update(`✅ Enviado: ${fileName} (${formatBytes(fileSize)})`)
  } catch (err) {
    const msg = controller.signal.aborted
      ? '🛑 Descarga de Magi cancelada.'
      : `❌ ${String(err?.message || 'Error al descargar desde Magi.').slice(0, 500)}`
    if (statusKey) await update(msg)
    else await m.reply(msg)
  } finally {
    release()
    finishDownload(key, 'magi', controller)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['magi <enlace>']
handler.tags = ['downloader']
handler.command = /^(magi|magidl|jkmagi)$/i

export default handler
