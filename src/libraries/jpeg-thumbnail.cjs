const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

let cachedFfmpegPath

function getFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath
  try {
    const ffmpegPath = require('ffmpeg-static')
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      cachedFfmpegPath = ffmpegPath
      return cachedFfmpegPath
    }
  } catch (_) {}
  cachedFfmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
  return cachedFfmpegPath
}

function extractFrame(filePath, seekSeconds, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(seekSeconds),
        '-i', path.resolve(filePath),
        '-frames:v', '1',
        '-vf', "scale='min(480,iw)':-2",
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '5',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (_) {
      return resolve(null)
    }

    const chunks = []
    let settled = false
    const done = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(null)
    }, timeoutMs)

    child.stdout.on('data', chunk => chunks.push(chunk))
    child.once('error', () => done(null))
    child.once('close', code => {
      done(code === 0 && chunks.length ? Buffer.concat(chunks) : null)
    })
  })
}

async function createJpegThumbnail(filePath, { seekSeconds = 1, timeoutMs = 15_000 } = {}) {
  if (!filePath) return null
  const thumb = await extractFrame(filePath, seekSeconds, timeoutMs)
  if (thumb || seekSeconds === 0) return thumb
  return extractFrame(filePath, 0, timeoutMs)
}

module.exports = { createJpegThumbnail }
