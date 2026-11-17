import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_DOWNLOAD_BYTES = Math.min(2048, Math.max(20, Number(process.env.MP4UPLOAD_MAX_MB) || 2048)) * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.MP4UPLOAD_TIMEOUT_MS) || 30 * 60_000)
const MIN_VALID_BYTES = 256 * 1024
const TEMP_ROOT = path.resolve(process.env.MP4UPLOAD_TEMP_DIR || path.join(os.tmpdir(), 'rikka-mp4upload'))

function allowedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === 'mp4upload.com' || host.endsWith('.mp4upload.com')
}

export function parseMp4UploadUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch (_) {
    throw new Error('El enlace no es una URL válida de MP4Upload.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !allowedHost(url.hostname)) {
    throw new Error('Solo acepto enlaces de mp4upload.com.')
  }
  const pathMatch = url.pathname.match(/^\/(?:embed-)?([a-z0-9_-]{4,80})(?:\.html)?\/?$/i)
  if (!pathMatch) throw new Error('No pude reconocer el identificador del video en el enlace MP4Upload.')
  return { id: pathMatch[1], url: url.href }
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`
}

export function extractMp4UploadMedia(html, id) {
  const source = String(html || '').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&')
  const patterns = [
    /https?:\/\/(?:www\d{1,2}|s\d+)\.mp4upload\.com:\d+\/d\/[a-z0-9]{20,80}\/[a-z0-9._%+-]+(?:\?[^"'\s<>]*)?/ig,
    /https?:\/\/(?:www\d{1,2}|s\d+)\.mp4upload\.com\/d\/[a-z0-9]{20,80}\/[a-z0-9._%+-]+(?:\?[^"'\s<>]*)?/ig,
    /(?:file|src|source|video_url)\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']*)?)["']/ig,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1] || match[0]
      try {
        const url = new URL(raw)
        if (url.protocol === 'https:' && allowedHost(url.hostname) && /\.mp4(?:[?#]|$)/i.test(url.pathname + url.search)) return url.href
      } catch (_) {}
    }
  }

  // MP4Upload embeds its media host, token, and port in a pipe-delimited player value.
  // Build the direct URL only from a strict host/token match and the filename shown by the page.
  const packed = source.match(/(?:^|[^a-z0-9])((?:www\d{1,2}|s\d+))\|[^|]{0,120}\|poster\|[a-z0-9]+\|(?:nivideo|video)\|([a-z0-9]{56})\|(\d{1,5})(?:[^0-9]|$)/i)
  const heading = source.match(/<h2[^>]*>\s*Download\s+File\s+(.+?)\s*<\/h2>/i)
  if (packed && heading) {
    const filename = heading[1].replace(/<[^>]*>/g, '').trim()
    const host = packed[1].toLowerCase()
    const token = packed[2].toLowerCase()
    const port = Number(packed[3])
    if (allowedHost(`${host}.mp4upload.com`) && port > 0 && port <= 65535 && filename && /^[a-z0-9._%+-]+$/i.test(filename)) {
      return `https://${host}.mp4upload.com:${port}/d/${token}/${filename}`
    }
  }

  throw new Error(`No pude extraer el video de MP4Upload (ID ${id}). El formato de esa página puede haber cambiado.`)
}

async function getMp4UploadPage(id, inputUrl) {
  const primary = inputUrl.includes(`/embed-${id}.html`) ? inputUrl : `https://www.mp4upload.com/${id}`
  const alternatives = [primary, `https://www.mp4upload.com/embed-${id}.html`, `https://www.mp4upload.com/${id}`]
  let lastError
  for (const url of [...new Set(alternatives)]) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
        timeout: 20_000,
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        responseType: 'text',
        validateStatus: status => status >= 200 && status < 400,
      })
      const finalUrl = response.request?.res?.responseUrl || url
      if (!allowedHost(new URL(finalUrl).hostname)) throw new Error('MP4Upload redirigió a un host no permitido.')
      const html = String(response.data || '')
      try { return { html, mediaUrl: extractMp4UploadMedia(html, id) } } catch (error) { lastError = error }
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('No pude abrir la página de MP4Upload.')
}

async function downloadMedia(mediaUrl, destPath, referer) {
  const response = await axios.get(mediaUrl, {
    responseType: 'stream',
    headers: { 'User-Agent': UA, Accept: '*/*', Referer: referer },
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    validateStatus: status => status >= 200 && status < 300,
  })
  const finalUrl = response.request?.res?.responseUrl || mediaUrl
  if (!allowedHost(new URL(finalUrl).hostname)) {
    response.data.destroy()
    throw new Error('El enlace de video redirigió fuera de MP4Upload.')
  }
  const contentType = String(response.headers['content-type'] || '').toLowerCase()
  if (/text\/html|application\/json|javascript/i.test(contentType)) {
    response.data.destroy()
    throw new Error('MP4Upload devolvió una página de error, no el archivo de video.')
  }
  const expected = Number(response.headers['content-length'] || 0)
  if (expected > MAX_DOWNLOAD_BYTES) {
    response.data.destroy()
    throw new Error(`El video supera el límite de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`)
  }
  const startedAt = Date.now()
  const host = new URL(finalUrl).hostname
  let bytes = 0
  let lastRenderAt = 0
  let lastLoggedAt = startedAt
  let nextLogAt = 16 * 1024 * 1024
  const renderProgress = (force = false) => {
    const now = Date.now()
    const elapsed = Math.max((now - startedAt) / 1000, 0.001)
    const speed = bytes / elapsed
    const percent = expected ? Math.min(100, bytes / expected * 100) : null
    if (process.stdout.isTTY) {
      if (!force && now - lastRenderAt < 1000) return
      lastRenderAt = now
      const width = 22
      const filled = percent == null ? 0 : Math.round(width * percent / 100)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
      const progress = percent == null ? '  --.-%' : `${percent.toFixed(1).padStart(5)}%`
      process.stdout.write(`\r[MP4UPLOAD] [${bar}] ${progress} | ${formatBytes(bytes)}${expected ? ` / ${formatBytes(expected)}` : ''} | ${formatBytes(speed)}/s | ${formatDuration(elapsed)}   `)
      return
    }
    if (force || now - lastLoggedAt >= 10_000 || bytes >= nextLogAt) {
      const progress = percent == null ? 'porcentaje n/d' : `${percent.toFixed(1)}%`
      console.log(`[MP4UPLOAD] ${progress} · ${formatBytes(bytes)}${expected ? ` / ${formatBytes(expected)}` : ''} · ${formatBytes(speed)}/s · ${formatDuration(elapsed)} · ${host}`)
      lastLoggedAt = now
      while (bytes >= nextLogAt) nextLogAt += 16 * 1024 * 1024
    }
  }
  console.log(`[MP4UPLOAD] Descargando desde ${host} · tamaño esperado: ${expected ? formatBytes(expected) : 'desconocido'}`)
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_DOWNLOAD_BYTES) callback(new Error(`El video supera el límite de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`))
      else {
        renderProgress()
        callback(null, chunk)
      }
    },
  })
  try {
    await pipeline(response.data, limiter, fs.createWriteStream(destPath, { flags: 'wx' }))
  } catch (error) {
    if (process.stdout.isTTY) process.stdout.write('\n')
    await fs.promises.rm(destPath, { force: true })
    throw error
  }
  renderProgress(true)
  if (process.stdout.isTTY) process.stdout.write('\n')
  const stat = await fs.promises.stat(destPath)
  if (stat.size < MIN_VALID_BYTES) {
    await fs.promises.rm(destPath, { force: true })
    throw new Error('El archivo recibido parece incompleto o no es un video válido.')
  }
  console.log(`[MP4UPLOAD] Descarga completa · ${formatBytes(stat.size)} · ${formatDuration((Date.now() - startedAt) / 1000)}`)
  return stat
}

function getInput(m, text, args) {
  const quoted = m.quoted?.text || m.quoted?.caption || ''
  const value = String(text || args?.[0] || quoted || '').match(/https?:\/\/[^\s<>]+/i)?.[0] || ''
  return value.replace(/[),.!?;:'"\]}>]+$/g, '')
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = getInput(m, text, args)
  if (!input) return m.reply(`Envía o responde a un enlace MP4Upload.\nEjemplo: *${usedPrefix || '.'}${command || 'mp4upload'} https://www.mp4upload.com/ID*`)

  let parsed
  try { parsed = parseMp4UploadUrl(input) } catch (error) { return m.reply(`❌ ${error.message}`) }

  if (!global.mp4UploadActiveDownloads) global.mp4UploadActiveDownloads = new Set()
  const lockKey = `${m.chat}:${m.sender}`
  if (global.mp4UploadActiveDownloads.has(lockKey)) return m.reply('⏳ Ya tienes una descarga MP4Upload activa en este chat.')
  global.mp4UploadActiveDownloads.add(lockKey)

  const tempDir = path.join(TEMP_ROOT, randomUUID())
  const outputPath = path.join(tempDir, `mp4upload-${parsed.id}.mp4`)
  let statusKey = null
  const update = async message => {
    if (statusKey) {
      try { await conn.sendMessage(m.chat, { text: message, edit: statusKey }) } catch (_) {}
    }
  }
  try {
    await fs.promises.mkdir(tempDir, { recursive: true })
    console.log(`[MP4UPLOAD] Resolviendo enlace · ID ${parsed.id}`)
    const sent = await conn.sendMessage(m.chat, { text: `🔎 Resolviendo MP4Upload · ID ${parsed.id}…` }, { quoted: m })
    statusKey = sent?.key || null
    const { mediaUrl } = await getMp4UploadPage(parsed.id, parsed.url)
    console.log(`[MP4UPLOAD] Video encontrado en ${new URL(mediaUrl).hostname} · URL ocultada`)
    await update('⬇️ Descargando desde MP4Upload…')
    const stat = await downloadMedia(mediaUrl, outputPath, parsed.url)
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
    const filename = `MP4Upload-${parsed.id}.mp4`
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName: filename,
      mimetype: 'video/mp4',
      caption: `✅ Descarga MP4Upload completada\n📦 Tamaño: ${sizeMB} MB`,
    }, { quoted: m })
    console.log(`[MP4UPLOAD] Enviado a WhatsApp · ${filename} · ${sizeMB} MB`)
    await update(`✅ Enviado: ${filename}`)
  } catch (error) {
    console.error(`[MP4UPLOAD] Error · ID ${parsed.id} · ${error?.message || error}`)
    const message = `❌ ${String(error?.message || 'Falló la descarga MP4Upload.').slice(0, 500)}`
    if (statusKey) await update(message)
    else await m.reply(message)
  } finally {
    global.mp4UploadActiveDownloads.delete(lockKey)
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['mp4upload <enlace>']
handler.tags = ['downloader']
handler.command = /^(mp4upload|mp4u|mp4down)$/i
handler.limit = false

export default handler
