const fs = require('node:fs')
const { spawn } = require('node:child_process')

function getFfmpegPath() {
  try {
    const ffmpegPath = require('ffmpeg-static')
    if (ffmpegPath && fs.existsSync(ffmpegPath)) return ffmpegPath
  } catch (_) {}
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

async function createJpegThumbnail(filePath) {
  if (!filePath) return null
  return new Promise(resolve => {
    let child
    try {
      child = spawn(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error',
        '-ss', '1', '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=480:-2',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (_) {
      return resolve(null)
    }
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.once('error', () => resolve(null))
    child.once('close', code => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null))
  })
}

module.exports = { createJpegThumbnail }
