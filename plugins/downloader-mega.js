import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Transform, PassThrough } from 'stream'

global.megaActiveDownloads = global.megaActiveDownloads || new Map()
global.megaUserDownloads = global.megaUserDownloads || new Map()

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
    e?.code === 'ABORT_ERR' ||
    e?.message === 'Aborted'
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

function parseMegaError(err) {
  const msg = err?.message || String(err)
  if (msg.includes('EOVERQUOTA') || msg.includes('-18')) return '❌ Cuota de Mega excedida. Intenta más tarde.'
  if (msg.includes('ENOENT') || msg.includes('-9')) return '❌ Archivo no encontrado en Mega.'
  if (msg.includes('EACCESS') || msg.includes('-11')) return '❌ Sin acceso al archivo (puede ser privado).'
  return `❌ Error de Mega: ${msg}`
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  if (/^(cancelar|stop)$/i.test(command)) {
    const userKey = m.chat + ':' + m.sender
    const dl = global.megaActiveDownloads.get(userKey)
    if (!dl) return m.reply('❌ No hay descarga activa para este chat.')
    dl.controller.abort()
    return
  }

  const url = args[0]
  if (!url || !/mega\.nz/i.test(url)) {
    throw (
      `☁️ *Mega Downloader*\n\n` +
      `Envía el enlace de Mega.\n` +
      `_Ej: ${usedPrefix + command} https://mega.nz/file/XXXXX#YYYYY_\n\n` +
      `Para cancelar, envía *.cancelar*`
    )
  }

  const userKey = m.chat + ':' + m.sender
  if (global.megaUserDownloads.get(userKey)) {
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
    let file
    try {
      file = MegaFile.fromURL(url)
      await file.loadAttributes()
    } catch (err) {
      if (isAbort(err)) throw err
      throw parseMegaError(err)
    }

    const name = file.name || 'archivo_mega'
    const sizeBytes = file.size || 0

    if (sizeBytes > MAX_SIZE) {
      await editStatus(`❌ El archivo (${fmtBytes(sizeBytes)}) supera el límite de WhatsApp (2 GB).`)
      return
    }

    await editStatus(
      `☁️ *${name}*\n` +
      (sizeBytes > 0 ? `⚖️ ${fmtBytes(sizeBytes)}\n` : '⚖️ _Tamaño desconocido_\n') +
      `🔄 _Iniciando descarga..._\n` +
      `_Usa_ *.cancelar* _para detener._`
    )

    global.megaActiveDownloads.set(userKey, { controller })
    global.megaUserDownloads.set(userKey, true)

    tempPath = path.join(tmpdir(), `mega_${Date.now()}_${sanitize(name)}`)

    const fileStream = file.download({ signal })
    signal.addEventListener(
      'abort',
      () => {
        try {
          fileStream.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        } catch {}
      },
      { once: true }
    )

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
          `\r[Mega] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastWAUpdate > EDIT_INTERVAL) {
          lastWAUpdate = now
          editStatus(buildStatus('📥', 'Descargando de Mega', pct, dlBytes, sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    try {
      await pipeline(fileStream, dlStream, fs.createWriteStream(tempPath), { signal })
    } catch (err) {
      if (isAbort(err)) throw err
      throw parseMegaError(err)
    }
    watchdog.stop()
    watchdog = null
    console.log(`\n[Mega] ✅ Descarga completa: ${name}`)

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
          `\r[Mega] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(realSize)} | ${fmtBytes(speed)}/s`
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
        fileName: name,
        mimetype: mimeLookup(name) || 'application/octet-stream',
        caption:
          `✅ *${name}*\n` +
          `⚖️ *Tamaño:* ${fmtBytes(realSize)}\n` +
          `🚀 _Enviado con éxito._`,
      },
      { quoted: m }
    )

    console.log(`\n[Mega] 🚀 Enviado a ${m.sender}`)
    await editStatus('✅ *¡Listo!* Archivo enviado correctamente.')
  } catch (e) {
    if (isAbort(e)) {
      console.log('\n[Mega] 🛑 Descarga cancelada.')
      await editStatus('🚫 *Descarga cancelada.*')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[Mega ERROR]', e)
    }
  } finally {
    if (watchdog) watchdog.stop()
    global.megaActiveDownloads.delete(userKey)
    global.megaUserDownloads.delete(userKey)
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath) } catch {}
    }
  }
}

handler.help = ['mega <enlace>', 'mg <enlace>']
handler.tags = ['downloader']
handler.command = /^(mega|mg|cancelar|stop)$/i

export default handler
