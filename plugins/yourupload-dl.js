import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isIP } from 'node:net'
import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const MAX_BYTES = Math.min(2048, Math.max(20, Number(process.env.YOURUPLOAD_MAX_MB) || 2048)) * 1024 * 1024
const TIMEOUT_MS = Math.max(60_000, Number(process.env.YOURUPLOAD_TIMEOUT_MS) || 30 * 60_000)
const MIN_BYTES = 32 * 1024
const UA_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,video/mp4,*/*;q=0.8', 'Accept-Language': 'es-419,es;q=0.9,en;q=0.8' }

function allowedYourUploadHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === 'yourupload.com' || host.endsWith('.yourupload.com')
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null
    if (isIP(host)) {
      if (host.includes(':')) return null
      const [a, b] = host.split('.').map(Number)
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null
    }
    return url
  } catch (_) { return null }
}

export function parseYourUploadUrl(value) {
  const match = String(value || '').trim().match(/https?:\/\/[^\s<>"']+/i)
  const raw = (match?.[0] || String(value || '').trim()).replace(/[),.!?;:'"\]}]+$/g, '')
  const url = isPublicHttpUrl(raw)
  if (!url || url.port || !allowedYourUploadHost(url.hostname)) throw new Error('Solo acepto enlaces públicos de yourupload.com.')
  if (url.pathname === '/' || url.pathname.length < 2) throw new Error('El enlace no contiene un identificador de video de YourUpload.')
  return { url: url.href, id: url.pathname.split('/').filter(Boolean).at(-1).replace(/\.html?$/i, '') }
}

export function extractYourUploadMedia(html) {
  const source = String(html || '').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/\\"/g, '"')
  const patterns = [
    /file\s*:\s*["'](https?:\\?\/\\?\/[^"']+)["']/i,
    /sources?\s*:\s*\[\s*\{[^}]*src\s*:\s*["'](https?:\\?\/\\?\/[^"']+)["']/i,
    /video\s*\[[^\]]+\]\s*=\s*["'](https?:\\?\/\\?\/[^"']+\.mp4[^"']*)["']/i,
    /(?:src|source|href)\s*=\s*["'](https?:\\?\/\\?\/[^"']+\.mp4(?:\?[^"']*)?)["']/i,
    /(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/i,
  ]
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (!match?.[1]) continue
    const candidate = match[1].replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/\\u0026/gi, '&').replace(/[\\]+$/g, '')
    const url = isPublicHttpUrl(candidate)
    if (url && /\.mp4(?:[?#]|$)/i.test(url.pathname + url.search)) return url.href
  }
  throw new Error('No encontré un enlace MP4 en la página de YourUpload; quizá cambió su reproductor.')
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function safeFilename(value) {
  return String(value || 'yourupload-video').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'yourupload-video'
}

function log(event, details = {}) {
  const time = new Date().toLocaleTimeString('es-MX', { hour12: false })
  const color = process.stdout.isTTY && !process.env.NO_COLOR
  console.log(`${color ? '\u001b[36m' : ''}[YOURUPLOAD ${time}]${color ? '\u001b[0m' : ''} ${event}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`)
}

async function getPage(parsed, signal) {
  const response = await axios.get(parsed.url, {
    headers: { ...UA_HEADERS, Referer: parsed.url },
    timeout: 20_000,
    maxRedirects: 6,
    maxContentLength: 8 * 1024 * 1024,
    responseType: 'text',
    signal,
    validateStatus: status => status >= 200 && status < 400,
  })
  const finalUrl = response.request?.res?.responseUrl || parsed.url
  if (!allowedYourUploadHost(new URL(finalUrl).hostname)) throw new Error('YourUpload redirigió la página fuera de su dominio.')
  return { html: String(response.data || ''), finalUrl }
}

async function downloadVideo(mediaUrl, pageUrl, destPath, signal) {
  const response = await axios.get(mediaUrl, {
    responseType: 'stream',
    headers: { ...UA_HEADERS, Accept: 'video/mp4,video/*,*/*;q=0.8', Referer: pageUrl },
    timeout: TIMEOUT_MS,
    maxRedirects: 6,
    maxContentLength: MAX_BYTES,
    signal,
    validateStatus: status => status >= 200 && status < 300,
  })
  const finalUrl = response.request?.res?.responseUrl || mediaUrl
  if (!isPublicHttpUrl(finalUrl)) {
    response.data.destroy()
    throw new Error('El servidor redirigió a una URL no pública; se canceló por seguridad.')
  }
  const contentType = String(response.headers['content-type'] || '').toLowerCase()
  if (/text\/html|application\/json|javascript/i.test(contentType)) {
    response.data.destroy()
    throw new Error('YourUpload devolvió una página en lugar del archivo de video.')
  }
  const expected = Number(response.headers['content-length'] || 0)
  if (expected > MAX_BYTES) {
    response.data.destroy()
    throw new Error(`El archivo supera el límite de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`)
  }

  const startedAt = Date.now()
  const host = new URL(finalUrl).hostname
  let bytes = 0
  let lastRenderAt = 0
  let lastLogAt = startedAt
  let nextLogAt = 16 * 1024 * 1024
  const render = (force = false) => {
    const now = Date.now()
    const elapsed = Math.max((now - startedAt) / 1000, 0.001)
    const speed = bytes / elapsed
    const percent = expected ? Math.min(100, bytes / expected * 100) : null
    if (process.stdout.isTTY && !process.env.NO_COLOR) {
      if (!force && now - lastRenderAt < 800) return
      lastRenderAt = now
      const width = 22
      const filled = percent == null ? 0 : Math.round(width * percent / 100)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
      process.stdout.write(`\r\u001b[2K  YourUpload [${bar}] ${percent == null ? 'tamaño n/d' : `${percent.toFixed(1)}%`} · ${formatBytes(bytes)}${expected ? ` / ${formatBytes(expected)}` : ''} · ${formatBytes(speed)}/s`)
      return
    }
    if (force || now - lastLogAt >= 10_000 || bytes >= nextLogAt) {
      log('progreso de descarga', { porcentaje: percent == null ? null : `${percent.toFixed(1)}%`, bytes: formatBytes(bytes), esperado: expected ? formatBytes(expected) : null, velocidad: `${formatBytes(speed)}/s`, host })
      lastLogAt = now
      while (bytes >= nextLogAt) nextLogAt += 16 * 1024 * 1024
    }
  }

  log('descargando archivo', { host, esperado: expected ? formatBytes(expected) : 'desconocido' })
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_BYTES) return callback(new Error(`El archivo supera el límite de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`))
      render()
      callback(null, chunk)
    },
  })
  try {
    await pipeline(response.data, meter, fs.createWriteStream(destPath, { flags: 'wx' }), { signal })
  } catch (error) {
    if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write('\n')
    await fs.promises.rm(destPath, { force: true }).catch(() => {})
    if (signal?.aborted) {
      const cancelled = new Error('Descarga cancelada.')
      cancelled.name = 'AbortError'
      throw cancelled
    }
    throw error
  }
  render(true)
  if (process.stdout.isTTY && !process.env.NO_COLOR) process.stdout.write('\n')
  const info = await fs.promises.stat(destPath)
  if (info.size < MIN_BYTES) {
    await fs.promises.rm(destPath, { force: true })
    throw new Error('El archivo recibido está vacío o parece incompleto.')
  }
  log('descarga terminada', { tamano: formatBytes(info.size), segundos: Math.round((Date.now() - startedAt) / 1000) })
  return info
}

function extractInput(m, text, args) {
  const quoted = m.quoted?.text || m.quoted?.caption || ''
  return String(text || (args || []).join(' ') || quoted || '').match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.!?;:'"\]}]+$/g, '') || ''
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = extractInput(m, text, args)
  if (!input) return m.reply(`Envía o responde a un enlace de YourUpload.\nEjemplo: *${usedPrefix || '.'}${command || 'yourupload'} https://www.yourupload.com/watch/ID*`)

  let parsed
  try { parsed = parseYourUploadUrl(input) } catch (error) { return m.reply(`❌ ${error.message}`) }

  const key = downloadKey(m)
  if (hasDownload(key, 'yourupload')) return m.reply('⏳ Ya tienes una descarga de YourUpload activa en este chat. Usa *.cancelar yourupload* para detenerla.')

  const controller = new AbortController()
  const { signal } = controller
  const release = startDownload(key, 'yourupload', controller, { label: `YourUpload · ${parsed.id}` })
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rikka-yourupload-'))
  const destPath = path.join(tempDir, `yourupload-${safeFilename(parsed.id)}.mp4`)
  let statusKey = null
  const update = async textValue => {
    if (!statusKey) return
    try { await conn.sendMessage(m.chat, { text: textValue, edit: statusKey }, { quoted: m }) } catch (_) {}
  }

  try {
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    log('nueva descarga', { id: parsed.id })
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo YourUpload · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    const { html, finalUrl } = await getPage(parsed, signal)
    const mediaUrl = extractYourUploadMedia(html)
    log('video resuelto', { pagina: new URL(finalUrl).hostname, hostVideo: new URL(mediaUrl).hostname, url: 'oculta' })
    await update('⬇️ YourUpload encontró el video. Descargando…')
    const info = await downloadVideo(mediaUrl, finalUrl, destPath, signal)
    if (signal.aborted) throw Object.assign(new Error('Descarga cancelada.'), { name: 'AbortError' })

    await update(`📤 Subiendo ${formatBytes(info.size)} a WhatsApp…`)
    log('subiendo a WhatsApp', { tamano: formatBytes(info.size) })
    const uploadStarted = Date.now()
    await conn.sendMessage(m.chat, {
      document: { url: destPath },
      fileName: `YourUpload-${safeFilename(parsed.id)}.mp4`,
      mimetype: 'video/mp4',
      caption: `✅ YourUpload · ${formatBytes(info.size)}`,
    }, { quoted: m })
    log('subida completada', { segundos: Math.round((Date.now() - uploadStarted) / 1000) })
    await update(`✅ YourUpload enviado · ${formatBytes(info.size)}`)
  } catch (error) {
    const cancelled = signal.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED'
    log(cancelled ? 'descarga cancelada' : 'error', { id: parsed.id, mensaje: String(error?.message || error).slice(0, 180) })
    const message = cancelled ? '🚫 Descarga de YourUpload cancelada.' : `❌ YourUpload: ${String(error?.message || error).slice(0, 450)}`
    if (statusKey) await update(message)
    else await m.reply(message)
  } finally {
    release()
    finishDownload(key, 'yourupload', controller)
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    log('proceso terminado', { id: parsed.id })
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }
}

handler.help = ['yourupload <enlace>']
handler.tags = ['downloader']
handler.command = /^(yourupload|yourdl|youdl)$/i
handler.limit = false

export default handler
