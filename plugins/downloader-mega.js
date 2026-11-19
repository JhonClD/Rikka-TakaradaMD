import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Transform, PassThrough } from 'stream'

import { downloadKey, hasDownload, startDownload, finishDownload } from '../src/funcion/download-registry.js'

const MAX_SIZE = 2 * 1024 ** 3
const IDLE_TIMEOUT = 60000
const EDIT_INTERVAL = 3000
const CONSOLE_INTERVAL = 1000
const SPEED_WINDOW_MS = 5000
const MAX_LISTED_FILES = 25
// Mismo ajuste que usan dbs-notify y tioanime-notify (megajs usa 4 por defecto).
const MEGA_MAX_CONNECTIONS = Math.min(Math.max(Number(process.env.MEGA_MAX_CONNECTIONS) || 16, 4), 32)

const MEGA_URL_RE = /https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/[^\s]+/i

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1024).toFixed(2) + ' KB'
}

function progressBar(pct, width = 16) {
  const filled = Math.max(0, Math.min(width, Math.round(width * pct / 100)))
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
  return String(name).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'archivo_mega'
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

function abortError() {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

// Velocidad instantánea: bytes transferidos dentro de una ventana deslizante,
// en lugar de promediar la media acumulada desde el inicio.
function createSpeedSampler(windowMs = SPEED_WINDOW_MS) {
  const samples = []
  return {
    sample(totalBytes, now = Date.now()) {
      samples.push([now, totalBytes])
      while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift()
      const [t0, b0] = samples[0]
      const elapsed = now - t0
      return elapsed > 0 ? ((totalBytes - b0) / elapsed) * 1000 : 0
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

function extractMegaUrl(args) {
  const match = args.join(' ').match(MEGA_URL_RE)
  return match ? match[0] : null
}

// Un enlace sin clave de descifrado (#...) no se puede descargar.
function hasDecryptionKey(url) {
  return /#[^\s]+/.test(url)
}

function parseMegaError(err) {
  const msg = err?.message || String(err)
  const code = (n) => new RegExp(`(^|[^\\d])-${n}([^\\d]|$)`).test(msg)
  if (/EOVERQUOTA/i.test(msg) || code(17)) return '❌ Cuota de transferencia de Mega excedida. Intenta más tarde.'
  if (/ETEMPUNAVAIL/i.test(msg) || code(18)) return '❌ Archivo temporalmente no disponible en Mega. Intenta más tarde.'
  if (/ENOENT/i.test(msg) || code(9)) return '❌ Archivo no encontrado en Mega (puede haber sido eliminado).'
  if (/EBLOCKED/i.test(msg) || code(16)) return '❌ Mega bloqueó este enlace.'
  if (/EACCESS/i.test(msg) || code(11)) return '❌ Sin acceso al archivo (puede ser privado).'
  if (/EKEY/i.test(msg) || code(14) || /invalid.*key|key.*(invalid|defined)/i.test(msg)) return '❌ Clave de descifrado inválida. Revisa que el enlace esté completo.'
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return '❌ Error de red al conectar con Mega. Intenta de nuevo.'
  return `❌ Error de Mega: ${msg}`
}

// Aplana una carpeta de Mega en una lista de archivos con su ruta relativa.
function collectFiles(node, prefix = '') {
  const out = []
  for (const child of node.children || []) {
    const rel = prefix ? `${prefix}/${child.name}` : String(child.name)
    if (child.directory) out.push(...collectFiles(child, rel))
    else out.push({ node: child, rel })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function freeDiskBytes(dir) {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return Infinity
  }
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const url = extractMegaUrl(args)
  if (!url) {
    throw (
      `☁️ *Mega Downloader*\n\n` +
      `Envía el enlace de Mega (archivo o carpeta).\n` +
      `_Ej: ${usedPrefix + command} https://mega.nz/file/XXXXX#YYYYY_\n` +
      `_Carpeta: ${usedPrefix + command} https://mega.nz/folder/XXXXX#YYYYY 2_\n\n` +
      `Para cancelar, envía *.cancelar*`
    )
  }
  if (!hasDecryptionKey(url)) {
    throw '❌ El enlace está incompleto: falta la clave de descifrado (la parte después de *#*).'
  }

  const userKey = downloadKey(m)
  if (hasDownload(userKey, 'mega')) {
    return m.reply('⚠️ Ya tienes una descarga en curso. Usa *.cancelar* para detenerla.')
  }

  // Se registra antes de cualquier await para que dos comandos seguidos no se
  // cuelen y para que *.cancelar* funcione desde la primera fase.
  const controller = new AbortController()
  const { signal } = controller
  startDownload(userKey, 'mega', controller, { label: '☁️ Mega' })

  let tempPath
  let watchdog

  const statusMsg = await conn.sendMessage(m.chat, {
    text: '🔄 _Obteniendo información del archivo..._',
  })
  const statusKey = statusMsg.key

  const editStatus = async (txt) => {
    try {
      await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
    } catch {}
  }
  const throwIfAborted = () => { if (signal.aborted) throw abortError() }

  try {
    let root
    try {
      root = MegaFile.fromURL(url)
      await root.loadAttributes()
    } catch (err) {
      if (isAbort(err)) throw err
      throw parseMegaError(err)
    }
    throwIfAborted()

    let file = root
    if (root.directory) {
      const files = collectFiles(root)
      if (!files.length) {
        await editStatus('❌ La carpeta de Mega está vacía.')
        return
      }

      const pick = args.map(Number).find((n) => Number.isInteger(n) && n > 0)
      if (!pick && files.length > 1) {
        const list = files
          .slice(0, MAX_LISTED_FILES)
          .map((f, i) => `*${i + 1}.* ${f.rel} _(${fmtBytes(f.node.size || 0)})_`)
          .join('\n')
        const extra = files.length > MAX_LISTED_FILES ? `\n_…y ${files.length - MAX_LISTED_FILES} más_` : ''
        await editStatus(
          `📁 *${root.name || 'Carpeta de Mega'}* — ${files.length} archivos\n\n${list}${extra}\n\n` +
          `Elige uno con:\n_${usedPrefix + command} <enlace> <número>_`
        )
        return
      }
      if (pick && pick > files.length) {
        await editStatus(`❌ Número inválido. La carpeta tiene ${files.length} archivos.`)
        return
      }
      file = files[(pick || 1) - 1].node
    }

    const name = file.name || 'archivo_mega'
    const sizeBytes = file.size || 0

    if (sizeBytes > MAX_SIZE) {
      await editStatus(`❌ El archivo (${fmtBytes(sizeBytes)}) supera el límite de WhatsApp (2 GB).`)
      return
    }

    // El archivo se guarda completo en disco antes de subirlo.
    if (sizeBytes > 0 && freeDiskBytes(tmpdir()) < sizeBytes * 1.1) {
      await editStatus('❌ No hay espacio libre suficiente en el servidor para descargar este archivo.')
      return
    }

    await editStatus(
      `☁️ *${name}*\n` +
      (sizeBytes > 0 ? `⚖️ ${fmtBytes(sizeBytes)}\n` : '⚖️ _Tamaño desconocido_\n') +
      `🔄 _Iniciando descarga..._\n` +
      `_Usa_ *.cancelar* _para detener._`
    )

    tempPath = path.join(tmpdir(), `mega_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${sanitize(name)}`)

    const fileStream = file.download({ maxConnections: MEGA_MAX_CONNECTIONS, signal })
    signal.addEventListener(
      'abort',
      () => {
        try { fileStream.destroy(abortError()) } catch {}
      },
      { once: true }
    )

    watchdog = makeWatchdog(controller)

    let dlBytes = 0
    let lastWAUpdate = 0
    let lastConsole = 0
    const dlSampler = createSpeedSampler()

    const dlStream = new Transform({
      transform(chunk, _, cb) {
        dlBytes += chunk.length
        watchdog.ping()
        const now = Date.now()
        const speed = dlSampler.sample(dlBytes, now)
        const pct = sizeBytes > 0 ? Math.min((dlBytes / sizeBytes) * 100, 100) : 0

        if (now - lastConsole > CONSOLE_INTERVAL) {
          lastConsole = now
          process.stdout.write(
            `\r[Mega] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)} | ${fmtBytes(speed)}/s`
          )
        }

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
    throwIfAborted()

    await editStatus('✅ _Descarga completa._\n📤 _Subiendo a WhatsApp..._')

    const realSize = fs.statSync(tempPath).size
    let upBytes = 0
    let lastUpWA = 0
    let lastUpConsole = 0
    const upSampler = createSpeedSampler()

    const upStream = new Transform({
      transform(chunk, _, cb) {
        upBytes += chunk.length
        const now = Date.now()
        const speed = upSampler.sample(upBytes, now)
        const pct = realSize > 0 ? Math.min((upBytes / realSize) * 100, 100) : 0

        if (now - lastUpConsole > CONSOLE_INTERVAL) {
          lastUpConsole = now
          process.stdout.write(
            `\r[Mega] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(realSize)} | ${fmtBytes(speed)}/s`
          )
        }

        if (now - lastUpWA > EDIT_INTERVAL) {
          lastUpWA = now
          editStatus(buildStatus('📤', 'Subiendo a WhatsApp', pct, upBytes, realSize, speed))
        }
        cb(null, chunk)
      },
    })

    const upload = new PassThrough()
    // *.cancelar* también debe detener la subida.
    signal.addEventListener('abort', () => upload.destroy(abortError()), { once: true })
    pipeline(fs.createReadStream(tempPath), upStream, upload).catch((err) => upload.destroy(err))

    await conn.sendMessage(
      m.chat,
      {
        document: { stream: upload },
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
    if (isAbort(e) || signal.aborted) {
      console.log('\n[Mega] 🛑 Descarga cancelada.')
      await editStatus('🚫 *Descarga cancelada.*')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[Mega ERROR]', e)
    }
  } finally {
    if (watchdog) watchdog.stop()
    finishDownload(userKey, 'mega', controller)
    if (tempPath) fs.rm(tempPath, { force: true }, () => {})
  }
}

handler.help = ['mega <enlace> [n]', 'mg <enlace> [n]']
handler.tags = ['downloader']
handler.command = /^(mega|mg)$/i

export default handler
