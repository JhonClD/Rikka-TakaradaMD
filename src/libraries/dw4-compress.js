import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000
const CRF = 26
const AUDIO_KBPS = 96
const PRESET = 'medium'

function escapeForFilter(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function getWatermarkFilter() {
  const fontPaths = [
    process.env.WM_FONT_PATH,
    '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf',
    '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/data/data/com.termux/files/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
  ].filter(Boolean)
  const fontFile = fontPaths.find(file => fs.existsSync(file))
  if (!fontFile) return null
  return `drawtext=fontfile='${escapeForFilter(fontFile)}':text='By\\:CID':fontcolor=white:fontsize=w*0.04:x=20:y=20:borderw=2:bordercolor=black:alpha='if(lt(t,4),1,if(lt(t,5),5-t,0))'`
}

function readDurationSec(inputPath) {
  try {
    const proc = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', inputPath,
    ], { encoding: 'utf8', timeout: 30_000 })
    const duration = Number.parseFloat(proc.stdout)
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  } catch (_) {
    return 0
  }
}

function writeTerminalProgress(line, label, durationSec) {
  const frame = line.match(/frame=\s*(\d+)/)?.[1]
  if (!frame) return
  const fps = line.match(/fps=\s*([\d.]+)/)?.[1] || '?'
  const time = line.match(/time=\s*([\d:.]+)/)?.[1] || '00:00:00'
  const speed = line.match(/speed=\s*([\d.]+x)/)?.[1] || '?x'
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number)
  const elapsed = hours * 3600 + minutes * 60 + seconds
  const percent = durationSec > 0 ? `${Math.min(100, Math.floor(elapsed / durationSec * 100))}%` : '--%'
  process.stdout.write(`\r[${label}] ${percent} | frame ${frame} | ${time} | ${fps} fps | ${speed}`)
}

export function buildDw4Args(inputPath, outputPath) {
  const scale = 'scale=-2:360:flags=lanczos'
  const watermark = getWatermarkFilter()
  const videoFilter = watermark ? `${scale},${watermark}` : scale

  return [
    '-hide_banner', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', videoFilter,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-movflags', '+faststart',
    outputPath,
  ]
}

export function compressDw4(inputPath, outputPath, { durationSec = 0, onProgress, label = 'DW4' } = {}) {
  if (!fs.existsSync(inputPath)) return Promise.reject(new Error(`No existe el archivo de entrada: ${inputPath}`))
  const actualDurationSec = Number(durationSec) > 0 ? Number(durationSec) : readDurationSec(inputPath)

  return fs.promises.mkdir(path.dirname(outputPath), { recursive: true }).then(() => new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
    const proc = spawn(ffmpegPath, buildDw4Args(inputPath, outputPath), {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let progressBuffer = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      callback(value)
    }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch (_) {}
      finish(reject, new Error('Tiempo límite de /dw4 excedido (20 min).'))
    }, FFMPEG_TIMEOUT_MS)

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 12000) stderr = stderr.slice(-12000)
      if (typeof onProgress === 'function') {
        try { onProgress(chunk) } catch (_) {}
      } else {
        progressBuffer += chunk.toString()
        const lines = progressBuffer.split(/\r\n|\n|\r/)
        progressBuffer = lines.pop() || ''
        for (const line of lines) writeTerminalProgress(line, label, actualDurationSec)
      }
    })
    proc.on('error', error => finish(reject, error))
    proc.on('close', code => {
      if (typeof onProgress !== 'function') {
        writeTerminalProgress(progressBuffer, label, actualDurationSec)
        process.stdout.write('\n')
      }
      if (settled) return
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-8).join('\n')
        return finish(reject, new Error(`FFmpeg /dw4 terminó con código ${code}${detail ? `: ${detail}` : ''}`))
      }
      try {
        const stat = fs.statSync(outputPath)
        if (!stat.size) throw new Error('FFmpeg produjo un archivo vacío.')
        finish(resolve, { filePath: outputPath, size: stat.size })
      } catch (error) {
        finish(reject, error)
      }
    })
  }))
}
