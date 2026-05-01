import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import fs        from 'fs'
import path      from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'

// ─── Cancelaciones activas ────────────────────────────────────────────────────

global.megaActiveDownloads = global.megaActiveDownloads || new Map()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576)    return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1024).toFixed(2) + ' KB'
}

function progressBar(pct, width = 16) {
  const filled = Math.round(width * pct / 100)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function buildStatus(emoji, label, pct, done, total, speed) {
  return (
    `${emoji} *${label}*\n` +
    `\`[${progressBar(pct)}] ${pct.toFixed(1)}%\`\n` +
    `📦 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
    `⚡ ${fmtBytes(speed)}/s`
  )
}

function parseMegaError(err) {
  const msg = err?.message || String(err)
  if (msg.includes('EOVERQUOTA') || msg.includes('-18')) return '❌ Cuota de Mega excedida. Intenta más tarde.'
  if (msg.includes('ENOENT')     || msg.includes('-9'))  return '❌ Archivo no encontrado en Mega.'
  if (msg.includes('EACCESS')    || msg.includes('-11')) return '❌ Sin acceso al archivo (puede ser privado).'
  return `❌ Error de Mega: ${msg}`
}

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command }) => {
  // ── Cancelar descarga activa ───────────────────────────────────────────────
  if (/^(cancelar|stop)$/i.test(command)) {
    const quotedId = m.quoted?.id
    if (!quotedId) return m.reply('❌ Responde al mensaje de progreso de la descarga.')
    const dl = global.megaActiveDownloads.get(quotedId)
    if (!dl) return m.reply('❌ No hay descarga activa para ese mensaje.')
    dl.controller.abort()
    global.megaActiveDownloads.delete(quotedId)
    return m.reply('🚫 *Descarga cancelada.*')
  }

  const url = args[0]
  if (!url || !/mega\.nz/i.test(url)) {
    throw (
      `☁️ *Mega Downloader*\n\n` +
      `Envía el enlace de Mega.\n` +
      `_Ej: ${usedPrefix + command} https://mega.nz/file/XXXXX#YYYYY_\n\n` +
      `Para cancelar, responde al mensaje de progreso con *.cancelar*`
    )
  }

  const controller = new AbortController()
  const { signal } = controller
  let tempPath

  const { key: statusKey } = await m.reply('🔄 _Obteniendo información del archivo..._')
  const editStatus = txt => conn.sendMessage(m.chat, { text: txt, edit: statusKey })

  try {
    // ── Cargar metadatos ────────────────────────────────────────────────────
    let file
    try {
      file = MegaFile.fromURL(url)
      await file.loadAttributes()
    } catch (err) {
      throw parseMegaError(err)
    }

    const name      = file.name || 'archivo_mega'
    const sizeBytes = file.size
    const safeName  = name.replace(/[/\\:*?"<>|]/g, '_')

    await editStatus(
      `☁️ *${name}*\n` +
      `⚖️ ${fmtBytes(sizeBytes)}\n` +
      `🔄 _Iniciando descarga..._\n` +
      `_Responde este mensaje con_ *.cancelar* _para detener._`
    )

    global.megaActiveDownloads.set(statusKey.id, { controller })

    // ── Descarga con progreso ────────────────────────────────────────────────
    tempPath = path.join(tmpdir(), `mega_${Date.now()}_${safeName}`)

    const fileStream = file.download({ signal })

    let dlBytes = 0
    const dlStart    = Date.now()
    let lastWAUpdate = 0

    // Monitor de progreso de descarga vía eventos del stream de Mega
    fileStream.on('data', chunk => {
      dlBytes += chunk.length
      const now   = Date.now()
      const secs  = (now - dlStart) / 1000 || 0.001
      const speed = dlBytes / secs
      const pct   = (dlBytes / sizeBytes) * 100

      process.stdout.write(
        `\r[Mega] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)}/${fmtBytes(sizeBytes)} | ${fmtBytes(speed)}/s`
      )

      if (now - lastWAUpdate > 3000) {
        lastWAUpdate = now
        editStatus(buildStatus('📥', 'Descargando de Mega', pct, dlBytes, sizeBytes, speed))
      }
    })

    try {
      await pipeline(fileStream, fs.createWriteStream(tempPath), { signal })
    } catch (err) {
      throw parseMegaError(err)
    }

    console.log(`\n[Mega] ✅ Descarga completa: ${name}`)

    // ── Subida con progreso ──────────────────────────────────────────────────
    await editStatus('✅ _Descarga completa._\n📤 _Subiendo a WhatsApp..._')

    const realSize = fs.statSync(tempPath).size
    let upBytes  = 0
    const upStart = Date.now()
    let lastUpWA  = 0

    const upStream = new Transform({
      transform(chunk, _, cb) {
        upBytes += chunk.length
        const now   = Date.now()
        const secs  = (now - upStart) / 1000 || 0.001
        const speed = upBytes / secs
        const pct   = (upBytes / realSize) * 100

        process.stdout.write(
          `\r[Mega] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(realSize)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastUpWA > 3000) {
          lastUpWA = now
          editStatus(buildStatus('📤', 'Subiendo a WhatsApp', pct, upBytes, realSize, speed))
        }
        cb(null, chunk)
      },
    })

    const readStream = fs.createReadStream(tempPath).pipe(upStream)

    await conn.sendMessage(m.chat, {
      document : { stream: readStream },
      fileName : name,
      mimetype : mimeLookup(name) || 'application/octet-stream',
      caption  :
        `✅ *${name}*\n` +
        `⚖️ *Tamaño:* ${fmtBytes(realSize)}\n` +
        `🚀 _Enviado con éxito._`,
    }, { quoted: m })

    console.log(`\n[Mega] 🚀 Enviado a ${m.sender}`)
    await editStatus('✅ *¡Listo!* Archivo enviado correctamente.')
    global.megaActiveDownloads.delete(statusKey.id)

  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
      console.log('\n[Mega] 🛑 Descarga cancelada.')
      await editStatus('🚫 *Descarga cancelada.*')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[Mega ERROR]', e)
    }
    global.megaActiveDownloads.delete(statusKey?.id)
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

handler.help    = ['mega <enlace>', 'mg <enlace>']
handler.tags    = ['downloader']
handler.command = /^(mega|mg|cancelar|stop)$/i

export default handler
  
