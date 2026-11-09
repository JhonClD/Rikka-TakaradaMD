import axios from 'axios'
import * as cheerio from 'cheerio'
import { lookup as mimeLookup } from 'mime-types'
import fs from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Transform, PassThrough } from 'stream'
import https from 'https'

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })

global.mfActiveDownloads = global.mfActiveDownloads || new Map()
global.mfUserDownloads = global.mfUserDownloads || new Map()

const MAX_SIZE = 2 * 1024 ** 3
const IDLE_TIMEOUT = 60000
const EDIT_INTERVAL = 3000

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1024).toFixed(2) + ' KB'
}

function progressBar(pct, width = 16) {
  const filled = Math.round(width * pct / 100)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function buildStatus(emoji, label, pct, done, total, speed) {
  if (total > 0) {
    return (
      `${emoji} *${label}*\n` +
      `\`[${progressBar(pct)}] ${pct.toFixed(1)}%\`\n` +
      `📦 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
      `⚡ ${fmtBytes(speed)}/s`
    )
  }
  return (
    `${emoji} *${label}*\n` +
    `📦 ${fmtBytes(done)}\n` +
    `⚡ ${fmtBytes(speed)}/s`
  )
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 200)
}

function isAbort(e) {
  return (
    e?.name === 'AbortError' ||
    e?.name === 'CanceledError' ||
    e?.code === 'ERR_CANCELED' ||
    e?.code === 'ABORT_ERR'
  )
}

function createSpeedSampler(windowSize = 5) {
  const samples = []
  return {
    sample(bytes, elapsedMs) {
      const speed = bytes / (elapsedMs / 1000 || 0.001)
      samples.push(speed)
      if (samples.length > windowSize) samples.shift()
      return samples.reduce((a, b) => a + b, 0) / samples.length
    }
  }
}

function makeWatchdog(controller) {
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > IDLE_TIMEOUT) {
      controller.abort()
      clearInterval(timer)
    }
  }, 5000)
  timer.unref?.()
  return {
    ping() { last = Date.now() },
    stop() { clearInterval(timer) }
  }
}

async function mediafireDl(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent,
    timeout: 15000,
  })
  const $ = cheerio.load(res.data)
  const link =
    $('#downloadButton').attr('href') ||
    res.data.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/)?.[1]

  if (!link) throw new Error('El enlace no es válido o el archivo fue eliminado.')

  const name =
    $('.promoDownloadName').first().attr('title') ||
    $('.filename').first().text().trim() ||
    link.split('/').pop().split('?')[0] ||
    'archivo'

  return { name: name.replace(/\s+/g, ' ').trim(), link }
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  if (/^(cancelar|stop)$/i.test(command)) {
    const userKey = m.chat + ':' + m.sender
    const dl = global.mfActiveDownloads.get(userKey)
    if (!dl) return m.reply('❌ No hay descarga activa para este chat.')
    dl.controller.abort()
    return
  }

  const url = args[0]
  if (!url || !/mediafire\.com/i.test(url)) {
    throw (
      `🔥 *MediaFire Downloader*\n\n` +
      `Envía el enlace de MediaFire.\n` +
      `_Ej: ${usedPrefix + command} https://www.mediafire.com/file/XXXXX_`
    )
  }

  const userKey = m.chat + ':' + m.sender
  if (global.mfUserDownloads.get(userKey)) {
    return m.reply('⚠️ Ya tienes una descarga en curso. Usa *.cancelar* para detenerla.')
  }

  const controller = new AbortController()
  const { signal } = controller
  let tempPath
  let watchdog
  let statusKey

  const statusMsg = await conn.sendMessage(m.chat, {
    text: '🔄 _Obteniendo información del archivo..._',
  })
  statusKey = statusMsg.key

  const editStatus = async (txt) => {
    try {
      await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
    } catch {}
  }

  try {
    const mfData = await mediafireDl(url)

    let sizeBytes = 0
    try {
      const head = await axios.head(mfData.link, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpsAgent,
        signal,
        timeout: 10000,
      })
      sizeBytes = parseInt(head.headers['content-length'] || '0') || 0
    } catch (e) {
      if (isAbort(e)) throw e
    }

    if (sizeBytes > MAX_SIZE) {
      await editStatus(`❌ El archivo (${fmtBytes(sizeBytes)}) supera el límite de WhatsApp (2 GB).`)
      return
    }

    await editStatus(
      `🔥 *${mfData.name}*\n` +
      (sizeBytes > 0 ? `⚖️ ${fmtBytes(sizeBytes)}\n` : '⚖️ _Tamaño desconocido_\n') +
      `🔄 _Iniciando descarga..._\n` +
      `_Usa_ *.cancelar* _para detener._`
    )

    global.mfActiveDownloads.set(userKey, { controller })
    global.mfUserDownloads.set(userKey, true)

    tempPath = join(tmpdir(), `mf_${Date.now()}_${sanitize(mfData.name)}`)

    const response = await axios({
      method: 'get',
      url: mfData.link,
      responseType: 'stream',
      signal,
      httpsAgent,
      timeout: 0,
    })

    watchdog = makeWatchdog(controller)

    let dlBytes = 0
    const dlStart = Date.now()
    let lastWAUpdate = 0
    const dlSampler = createSpeedSampler()

    const dlStream = new Transform({
      transform(chunk, _, cb) {
        dlBytes += chunk.length
        watchdog.ping()
        const now = Date.now()
        const speed = dlSampler.sample(dlBytes, now - dlStart)
        const pct = sizeBytes > 0 ? (dlBytes / sizeBytes) * 100 : 0

        process.stdout.write(
          `\r[MediaFire] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastWAUpdate > EDIT_INTERVAL) {
          lastWAUpdate = now
          editStatus(buildStatus('📥', 'Descargando de MediaFire', pct, dlBytes, sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    await pipeline(response.data, dlStream, fs.createWriteStream(tempPath), { signal })
    watchdog.stop()
    watchdog = null
    console.log(`\n[MediaFire] ✅ Descarga completa: ${mfData.name}`)

    await editStatus('✅ _Descarga completa._\n📤 _Subiendo a WhatsApp..._')

    const realSize = fs.statSync(tempPath).size
    let upBytes = 0
    const upStart = Date.now()
    let lastUpWA = 0
    const upSampler = createSpeedSampler()

    const upStream = new Transform({
      transform(chunk, _, cb) {
        upBytes += chunk.length
        const now = Date.now()
        const speed = upSampler.sample(upBytes, now - upStart)
        const pct = realSize > 0 ? (upBytes / realSize) * 100 : 0

        process.stdout.write(
          `\r[MediaFire] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(realSize)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastUpWA > EDIT_INTERVAL) {
          lastUpWA = now
          editStatus(buildStatus('📤', 'Subiendo a WhatsApp', pct, upBytes, realSize, speed))
        }
        cb(null, chunk)
      },
    })

    const pass = new PassThrough()
    pipeline(fs.createReadStream(tempPath), upStream, pass).catch(err => pass.destroy(err))

    await conn.sendMessage(
      m.chat,
      {
        document: { stream: pass },
        fileName: mfData.name,
        mimetype: mimeLookup(mfData.name) || 'application/octet-stream',
        caption:
          `✅ *${mfData.name}*\n` +
          `⚖️ *Tamaño:* ${fmtBytes(realSize)}\n` +
          `🚀 _Enviado con éxito._`,
      },
      { quoted: m }
    )

    console.log(`\n[MediaFire] 🚀 Enviado a ${m.sender}`)
    await editStatus('✅ *¡Listo!* Archivo enviado correctamente.')
  } catch (e) {
    if (isAbort(e)) {
      console.log('\n[MediaFire] 🛑 Descarga cancelada.')
      await editStatus('🚫 *Descarga cancelada.*')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[MediaFire ERROR]', e)
    }
  } finally {
    if (watchdog) watchdog.stop()
    global.mfActiveDownloads.delete(userKey)
    global.mfUserDownloads.delete(userKey)
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath) } catch {}
    }
  }
}

handler.help = ['mediafire <enlace>', 'mf <enlace>']
handler.tags = ['downloader']
handler.command = /^(mediafire|mf|cancelar|stop)$/i

export default handler
