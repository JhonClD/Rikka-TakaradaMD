import { execFile } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 20_000
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 1500 * 1024 ** 2

function isVoeHost(hostname) {
  const host = hostname.toLowerCase()
  return host === 'voe.sx' || host === 'www.voe.sx'
}

function isAllowedManifestHost(hostname) {
  const host = hostname.toLowerCase()
  return host === 'voe.sx' || host.endsWith('.voe.sx') ||
    host === 'voe-network.net' || host.endsWith('.voe-network.net')
}

export function parseVoeUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('El enlace no es una URL válida.')
  }

  if (url.protocol !== 'https:' || !isVoeHost(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Solo se aceptan enlaces HTTPS de voe.sx.')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts.length === 2 && /^(e|v|d)$/i.test(parts[0])
    ? parts[1]
    : parts.length === 1 ? parts[0] : null

  if (!id || !/^[a-z0-9_-]{6,64}$/i.test(id)) {
    throw new Error('No pude reconocer el identificador del video de Voe.')
  }

  return { id, pageUrl: `https://voe.sx/e/${id}` }
}

function decodeUrl(value) {
  return value
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .trim()
}

export function extractVoeManifest(pageHtml) {
  const candidates = []
  const hls = pageHtml.match(/["']hls["']\s*:\s*["']([^"']+)["']/i)?.[1]
  if (hls) candidates.push(decodeUrl(hls))

  const rawManifests = pageHtml.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi) || []
  candidates.push(...rawManifests.map(decodeUrl))

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' && isAllowedManifestHost(url.hostname) && /\.m3u8$/i.test(url.pathname)) {
        return url.toString()
      }
    } catch {
      // Ignorar valores malformados y continuar con los demás candidatos.
    }
  }
  return null
}

function getVoeUrl(text, args = []) {
  const input = String(text || args[0] || '')
  const candidate = input.match(/https?:\/\/[^\s<>]+/i)?.[0] || String(args[0] || '')
  return candidate.replace(/[),.!?;:'"\]}>]+$/g, '')
}

const handler = async (m, { conn, args, text }) => {
  const inputUrl = getVoeUrl(text, args)
  if (!inputUrl) {
    return m.reply('Envía un enlace de Voe. Ejemplo: .voe https://voe.sx/e/abc123xyz789')
  }

  let voe
  try {
    voe = parseVoeUrl(inputUrl)
  } catch (error) {
    return m.reply(`❌ ${error.message}`)
  }

  global.voeActiveDownloads ||= new Set()
  const downloadKey = `${m.chat}:${m.sender}`
  if (global.voeActiveDownloads.has(downloadKey)) {
    return m.reply('⚠️ Ya tienes una descarga de Voe en curso en este chat.')
  }
  global.voeActiveDownloads.add(downloadKey)

  let tempDir
  try {
    await m.reply('🔎 Obteniendo el video de Voe...')

    const pageResponse = await fetch(voe.pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    })

    if (!pageResponse.ok) throw new Error(`Voe respondió HTTP ${pageResponse.status}.`)
    if (!isVoeHost(new URL(pageResponse.url).hostname)) {
      throw new Error('Voe redirigió a un dominio no admitido.')
    }

    const pageHtml = await pageResponse.text()
    if (pageHtml.length > MAX_PAGE_CHARS) throw new Error('La página de Voe es demasiado grande para procesarla.')

    const manifestUrl = extractVoeManifest(pageHtml)
    if (!manifestUrl) {
      throw new Error('No encontré un manifiesto HLS público. El video puede estar eliminado o no disponible.')
    }

    tempDir = await mkdtemp(join(tmpdir(), 'rikka-voe-'))
    const outputPath = join(tempDir, `voe_${voe.id}.mp4`)
    const referer = `${voe.pageUrl}\r\n`
    const headers = `Referer: ${referer}Origin: https://voe.sx/\r\n`

    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'https,http,tcp,tls,crypto,data',
      '-user_agent', USER_AGENT,
      '-headers', headers,
      '-rw_timeout', '20000000',
      '-i', manifestUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4',
      outputPath,
    ], {
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
    })

    const file = await stat(outputPath)
    if (!file.size) throw new Error('FFmpeg no generó un video válido.')
    if (file.size > MAX_VIDEO_SIZE) {
      throw new Error('El video supera el límite de 1,5 GB configurado para este comando.')
    }

    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName: `voe_${voe.id}.mp4`,
      mimetype: 'video/mp4',
      caption: `✅ Video descargado de Voe (${(file.size / 1024 ** 2).toFixed(1)} MB)`,
    }, { quoted: m })
  } catch (error) {
    console.error('[Voe-DL]', error?.message || error)
    await m.reply(`❌ ${error?.message || 'No se pudo descargar el video de Voe.'}`)
  } finally {
    global.voeActiveDownloads.delete(downloadKey)
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['voe <enlace>']
handler.tags = ['downloader']
handler.command = /^(voe|voedl|voedownload)$/i

export default handler
