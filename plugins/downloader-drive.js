import fetch    from 'node-fetch'
import fs       from 'fs'
import path     from 'path'
import os       from 'os'
import { pipeline }  from 'stream/promises'
import { Transform } from 'stream'

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

// ─── Google Drive API ─────────────────────────────────────────────────────────

async function gdriveDl(url) {
  if (!url?.match(/drive\.google/i)) throw '❌ URL no válida de Google Drive.'

  const idMatch = url.match(/\/d\/(.*?)\//) || url.match(/[?&]id=([^&]+)/)
  const id = idMatch?.[1]
  if (!id) throw '❌ No se pudo extraer el ID del archivo.'

  const res = await fetch(`https://drive.google.com/uc?id=${id}&authuser=0&export=download`, {
    method : 'post',
    headers: {
      'accept-encoding' : 'gzip, deflate, br',
      'content-length'  : '0',
      'Content-Type'    : 'application/x-www-form-urlencoded;charset=UTF-8',
      'origin'          : 'https://drive.google.com',
      'user-agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'x-drive-first-party': 'DriveWebUi',
      'x-json-requested': 'true',
    },
  })

  const raw = await res.text()
  const { fileName, sizeBytes, downloadUrl } = JSON.parse(raw.slice(4))

  if (!downloadUrl) throw '❌ Límite de descarga alcanzado o el archivo es privado.'

  const head = await fetch(downloadUrl, { method: 'HEAD' })
  if (!head.ok) throw `❌ Error HTTP al verificar el archivo: ${head.statusText}`

  return {
    downloadUrl,
    fileName,
    sizeBytes : Number(sizeBytes),
    mimetype  : head.headers.get('content-type') || 'application/octet-stream',
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command }) => {
  if (!args[0]) {
    throw (
      `📁 *Google Drive Downloader*\n\n` +
      `Envía el enlace del archivo de Google Drive.\n` +
      `_Ej: ${usedPrefix + command} https://drive.google.com/file/d/XXXXX/view_`
    )
  }

  const LIMIT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB
  let tempPath

  // Mensaje de estado editable
  const { key: statusKey } = await m.reply('🔄 _Obteniendo información del archivo..._')
  const editStatus = txt => conn.sendMessage(m.chat, { text: txt, edit: statusKey })

  try {
    const info = await gdriveDl(args[0])

    if (info.sizeBytes > LIMIT_BYTES) {
      throw `❌ El archivo es demasiado grande (${fmtBytes(info.sizeBytes)}). Límite: 2 GB.`
    }

    await editStatus(
      `📁 *${info.fileName}*\n` +
      `⚖️ ${fmtBytes(info.sizeBytes)}\n` +
      `🔄 _Iniciando descarga..._`
    )

    // ── Descarga con progreso ───────────────────────────────────────────────
    tempPath = path.join(os.tmpdir(), `gdrive_${Date.now()}_${info.fileName.replace(/[/\\:*?"<>|]/g, '_')}`)

    const fileRes = await fetch(info.downloadUrl)
    if (!fileRes.ok) throw `❌ Error al descargar: ${fileRes.statusText}`

    let dlBytes = 0
    const dlStart = Date.now()
    let lastWAUpdate = 0

    const dlStream = new Transform({
      transform(chunk, _, cb) {
        dlBytes += chunk.length
        const now  = Date.now()
        const secs = (now - dlStart) / 1000 || 0.001
        const speed = dlBytes / secs
        const pct   = (dlBytes / info.sizeBytes) * 100

        // Terminal
        process.stdout.write(
          `\r[GDrive] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)}/${fmtBytes(info.sizeBytes)} | ${fmtBytes(speed)}/s`
        )

        // WhatsApp cada 3 s
        if (now - lastWAUpdate > 3000) {
          lastWAUpdate = now
          editStatus(buildStatus('📥', 'Descargando de Drive', pct, dlBytes, info.sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    await pipeline(fileRes.body, dlStream, fs.createWriteStream(tempPath))
    console.log(`\n[GDrive] ✅ Descarga completa: ${info.fileName}`)

    // ── Subida con progreso ─────────────────────────────────────────────────
    await editStatus(
      `✅ _Descarga completa._\n` +
      `📤 _Subiendo a WhatsApp..._`
    )

    let upBytes = 0
    const upStart = Date.now()
    let lastUpWA  = 0

    const upStream = new Transform({
      transform(chunk, _, cb) {
        upBytes += chunk.length
        const now   = Date.now()
        const secs  = (now - upStart) / 1000 || 0.001
        const speed = upBytes / secs
        const pct   = (upBytes / info.sizeBytes) * 100

        process.stdout.write(
          `\r[GDrive] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(info.sizeBytes)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastUpWA > 3000) {
          lastUpWA = now
          editStatus(buildStatus('📤', 'Subiendo a WhatsApp', pct, upBytes, info.sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    const readStream = fs.createReadStream(tempPath).pipe(upStream)

    await conn.sendMessage(m.chat, {
      document : { stream: readStream },
      fileName : info.fileName,
      mimetype : info.mimetype,
      caption  :
        `✅ *${info.fileName}*\n` +
        `⚖️ *Tamaño:* ${fmtBytes(info.sizeBytes)}\n` +
        `🚀 _Enviado con éxito._`,
    }, { quoted: m })

    console.log(`\n[GDrive] 🚀 Enviado a ${m.sender}`)
    await editStatus(`✅ *¡Listo!* Archivo enviado correctamente.`)

  } catch (e) {
    const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
    await editStatus(msg)
    console.error('\n[GDrive ERROR]', e)
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

handler.help    = ['gdrive <enlace>']
handler.tags    = ['downloader']
handler.command = /^(gdrive|gd|drive)$/i

export default handler

