import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const MAX_INPUT_BYTES = 25 * 1024 * 1024
const DURATION_SECONDS = 3
const SIZE = 720

function getMediaMessage(message) {
  return message?.msg || message || {}
}

function normalizeBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (value?.data) return normalizeBuffer(value.data)
  throw new TypeError('La descarga no devolvió un Buffer válido.')
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1',
      '-i', inputPath,
      '-t', String(DURATION_SECONDS),
      '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE},format=yuv420p`,
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-movflags', '+faststart',
      '-an',
      outputPath,
    ]
    const child = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve()
      reject(new Error(`FFmpeg terminó con código ${code}: ${stderr.slice(-800)}`))
    })
  })
}

const handler = async (m, { conn }) => {
  const quoted = m?.quoted || m
  const media = getMediaMessage(quoted)
  const mime = String(media.mimetype || '').toLowerCase()

  if (!mime.startsWith('image/')) {
    return m.reply('✖ Responde a una imagen o envía una imagen con el comando *redondo*.')
  }

  let inputBuffer
  try {
    inputBuffer = normalizeBuffer(await quoted.download())
  } catch (error) {
    console.error('[video-redondo] Error descargando la imagen:', error?.stack || error)
    return m.reply('❌ No se pudo descargar la imagen.')
  }

  if (!inputBuffer.length) return m.reply('❌ La imagen está vacía.')
  if (inputBuffer.length > MAX_INPUT_BYTES) return m.reply('❌ La imagen supera el límite de 25 MB.')

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-redondo-'))
  const inputPath = path.join(tempDir, 'entrada')
  const outputPath = path.join(tempDir, 'redondo.mp4')

  try {
    await fs.promises.writeFile(inputPath, inputBuffer)
    await runFfmpeg(inputPath, outputPath)
    const videoBuffer = await fs.promises.readFile(outputPath)
    await conn.sendMessage(m.chat, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      fileName: 'video-redondo.mp4',
      ptv: true,
    }, { quoted: m })
  } catch (error) {
    console.error('[video-redondo] Error creando el video:', error?.stack || error)
    return m.reply('❌ No se pudo crear el video circular. Comprueba que FFmpeg esté disponible.')
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.command = /^(redondo|videoredondo|ptv)$/i
handler.help = ['redondo', 'videoredondo', 'ptv']
handler.tags = ['tools', 'media']
handler.limit = false

export default handler
