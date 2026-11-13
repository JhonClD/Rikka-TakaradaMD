import fetch from 'node-fetch'
import { fetch as driveFetch } from 'undici'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { listFiles, downloadFile, getFileMetadata } from 'better-gdrive'

async function compatibleDriveFetch(...args) {
  const response = await driveFetch(...args)
  const body = response.body
  if (body && typeof body.getReader !== 'function' && typeof body.pipe === 'function') {
    return new Response(Readable.toWeb(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return response
}

global.gdActiveDownloads = global.gdActiveDownloads || new Map()
global.gdUserDownloads = global.gdUserDownloads || new Map()

const MAX_SIZE = 2 * 1024 ** 3
const MAX_FOLDER_FILES = 25
const MAX_FOLDER_TOTAL = 2 * 1024 ** 3
const IDLE_TIMEOUT = 60000
const EDIT_INTERVAL = 3000
const SIZE_LIMIT_MESSAGE =
  '⚠️ ʟíᴍɪᴛᴇ ᴅᴇ ᴛᴀᴍᴀñᴏ sᴜᴘᴇʀᴀᴅᴏ 🧸\n\n' +
  'ᴇʟ *ᴀʀᴄʜɪᴠᴏ* sᴜᴘᴇʀó ᴇʟ ʟíᴍɪᴛᴇ ᴅᴇ `2 ɢʙ` ᴅᴇ ᴡʜᴀᴛsᴀᴘᴘ.\n' +
  '*ᴇsᴛᴀᴅᴏ:* 🚫 ɴᴏ sᴇ ᴇɴᴠɪó.'
const RESTRICTED_ACCESS_MESSAGE =
  '🔒 ᴀᴄᴄᴇsᴏ ʀᴇsᴛʀɪɴɢɪᴅᴏ 🧸\n\n' +
  'ʟᴀ *ᴄᴀʀᴘᴇᴛᴀ* ᴏ ᴇʟ *ᴀʀᴄʜɪᴠᴏ* ɴᴏ ᴇs ᴘúʙʟɪᴄᴏ.\n' +
  '*sᴏʟᴜᴄɪóɴ:* ᴄᴀᴍʙɪᴀ ʟᴏs ᴘᴇʀᴍɪsᴏs ᴇɴ ᴅʀɪᴠᴇ ᴀ "ᴄᴜᴀʟǫᴜɪᴇʀ ᴘᴇʀsᴏɴᴀ ᴄᴏɴ ᴇʟ ᴇɴʟᴀᴄᴇ".'

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

const CP1252_BYTES = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}))
function repairMojibake(value) {
  const text = String(value ?? '')
  if (!/[ÃÂâð�]/u.test(text)) return text.normalize('NFC')
  try {
    const bytes = []
    for (const char of text) {
      const code = CP1252_BYTES.get(char) ?? char.codePointAt(0)
      if (code > 0xff) return text.normalize('NFC')
      bytes.push(code)
    }
    const repaired = Buffer.from(bytes).toString('utf8')
    if (!repaired.includes('�')) return repaired.normalize('NFC')
  } catch {}
  return text.normalize('NFC')
}

function sanitize(name) {
  return repairMojibake(name).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 200)
}

function isAbort(e) {
  return (
    e?.name === 'AbortError' ||
    e?.name === 'CanceledError' ||
    e?.code === 'ERR_CANCELED' ||
    e?.code === 'ABORT_ERR' ||
    e?.type === 'aborted' ||
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

function parseGDriveError(e) {
  const msg = e?.message || String(e)
  if (msg.includes('quota') || msg.includes('Too many')) return '❌ Límite de descarga de Google Drive alcanzado. Intenta más tarde.'
  if (msg.includes('404') || msg.includes('notFound')) return '❌ Archivo no encontrado en Google Drive.'
  if (msg.includes('403') || msg.includes('private') || msg.includes('permission')) return RESTRICTED_ACCESS_MESSAGE
  return `❌ Error de Google Drive: ${msg}`
}

function isGDriveFolderUrl(url) {
  return /drive\.google\.com\/drive\/folders\//i.test(String(url || ''))
}
async function gdriveFolderList(url, signal) {
  const entries = await listFiles(url, { signal, fetch: compatibleDriveFetch })
  const files = entries.filter(entry => entry?.id).map((entry, index) => ({
    id: entry.id,
    fileName: sanitize(repairMojibake(entry.name || `archivo_${index + 1}`)),
  }))
  if (!files.length) throw new Error('La carpeta está vacía, es privada o no contiene archivos compatibles.')
  if (files.length > MAX_FOLDER_FILES) throw new Error(`La carpeta contiene ${files.length} archivos. El límite es ${MAX_FOLDER_FILES}.`)
  return files
}

async function gdriveDl(url, signal) {
  if (!url?.match(/drive\.google/i)) throw new Error('URL no válida de Google Drive.')

  const idMatch = url.match(/\/d\/(.*?)\//) || url.match(/[?&]id=([^&]+)/)
  const id = idMatch?.[1]
  if (!id) throw new Error('No se pudo extraer el ID del archivo.')

  const res = await fetch(`https://drive.google.com/uc?id=${id}&authuser=0&export=download`, {
    method: 'post',
    signal,
    headers: {
      'accept-encoding': 'gzip, deflate, br',
      'content-length': '0',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'origin': 'https://drive.google.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'x-drive-first-party': 'DriveWebUi',
      'x-json-requested': 'true',
    },
  })

  const raw = await res.text()
  let parsed
  try {
    parsed = JSON.parse(raw.slice(4))
  } catch {
    throw new Error('Respuesta inválida de Google Drive. Verifica el enlace.')
  }

  const { fileName, sizeBytes, downloadUrl } = parsed || {}
  if (!downloadUrl) throw new Error('Límite de descarga alcanzado o el archivo es privado.')

  const head = await fetch(downloadUrl, { method: 'HEAD', signal })
  if (!head.ok) throw new Error(`Error HTTP al verificar el archivo: ${head.statusText}`)

  return {
    downloadUrl,
    fileName: repairMojibake(fileName || 'archivo'),
    sizeBytes: Number(sizeBytes) || 0,
    mimetype: head.headers.get('content-type') || 'application/octet-stream',
  }
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  if (/^(cancelar|stop)$/i.test(command)) {
    const userKey = m.chat + ':' + m.sender
    const dl = global.gdActiveDownloads.get(userKey)
    if (!dl) return m.reply('❌ No hay descarga activa para este chat.')
    dl.controller.abort()
    return
  }

  if (!args[0]) {
    throw (
      `🔮 ʀɪᴋᴋᴀ ᴅʀɪᴠᴇ ᴅᴏᴡɴʟᴏᴀᴅᴇʀ 🧸\n\n` +
      `ᴇɴᴠíᴀ ᴇʟ ᴇɴʟᴀᴄᴇ ᴅᴇ ᴜɴ *ᴀʀᴄʜɪᴠᴏ* ᴏ *ᴄᴀʀᴘᴇᴛᴀ* ᴘúʙʟɪᴄᴀ ᴅᴇ ɢᴏᴏɢʟᴇ ᴅʀɪᴠᴇ.\n` +
      `*ᴀʀᴄʜɪᴠᴏ:* \`${usedPrefix + command} <enlace>\``
    )
  }

  const userKey = m.chat + ':' + m.sender
  if (global.gdUserDownloads.get(userKey)) {
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
    if (isGDriveFolderUrl(args[0])) {
      let files
      try {
        files = await gdriveFolderList(args[0], signal)
      } catch (err) {
        if (isAbort(err)) throw err
        throw parseGDriveError(err)
      }
      global.gdActiveDownloads.set(userKey, { controller })
      global.gdUserDownloads.set(userKey, true)
      await editStatus(`📁 *Carpeta encontrada*\n📄 ${files.length} archivo(s)\n🔄 _Calculando tamaños..._`)
      const details = []
      let totalBytes = 0
      for (const file of files) {
        const meta = await getFileMetadata(file.id, { signal, fetch: compatibleDriveFetch }).catch(() => ({}))
        const size = Number(meta.size) || 0
        totalBytes += size
        if (size > MAX_SIZE) throw SIZE_LIMIT_MESSAGE
        if (totalBytes > MAX_FOLDER_TOTAL) throw new Error(`La carpeta supera el límite total de ${fmtBytes(MAX_FOLDER_TOTAL)}.`)
        details.push({ ...file, fileName: sanitize(repairMojibake(meta.filename || file.fileName)), mimetype: meta.mimeType || 'application/octet-stream' })
      }
      await editStatus(`📁 *Descargando carpeta*\n📄 ${details.length} archivo(s)\n⚖️ ${fmtBytes(totalBytes)}\n_Se enviará archivo por archivo._`)
      for (let index = 0; index < details.length; index++) {
        const file = details[index]
        if (signal.aborted) throw new Error('Aborted')
        const folderPath = path.join(os.tmpdir(), `gdrive_folder_${Date.now()}_${sanitize(file.fileName)}`)
        try {
          await editStatus(`📥 *${index + 1}/${details.length}* — ${file.fileName}\n_Descargando desde Google Drive..._`)
          await downloadFile(file.id, folderPath, { signal, fetch: compatibleDriveFetch })
          const realSize = fs.statSync(folderPath).size
          if (realSize > MAX_SIZE) throw SIZE_LIMIT_MESSAGE
          await editStatus(`📤 *${index + 1}/${details.length}* — ${file.fileName}\n_Subiendo a WhatsApp..._`)
          await conn.sendMessage(m.chat, {
            document: { url: folderPath },
            fileName: file.fileName,
            mimetype: file.mimetype,
          })
        } finally {
          try { if (fs.existsSync(folderPath)) fs.unlinkSync(folderPath) } catch {}
        }
      }
      await editStatus(`✅ *Carpeta enviada correctamente.*\n📄 ${details.length} archivo(s)`)
      return
    }

    let info
    try {
      info = await gdriveDl(args[0], signal)
    } catch (err) {
      if (isAbort(err)) throw err
      throw parseGDriveError(err)
    }

    if (info.sizeBytes > MAX_SIZE) {
      await editStatus(SIZE_LIMIT_MESSAGE)
      return
    }

    await editStatus(
      `📁 *${info.fileName}*\n` +
      (info.sizeBytes > 0 ? `⚖️ ${fmtBytes(info.sizeBytes)}\n` : '⚖️ _Tamaño desconocido_\n') +
      `🔄 _Iniciando descarga..._\n` +
      `_Usa_ *.cancelar* _para detener._`
    )

    global.gdActiveDownloads.set(userKey, { controller })
    global.gdUserDownloads.set(userKey, true)

    tempPath = path.join(os.tmpdir(), `gdrive_${Date.now()}_${sanitize(info.fileName)}`)

    const fileRes = await fetch(info.downloadUrl, { signal })
    if (!fileRes.ok) throw new Error(`Error al descargar: ${fileRes.statusText}`)

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
        const pct = info.sizeBytes > 0 ? (dlBytes / info.sizeBytes) * 100 : 0

        process.stdout.write(
          `\r[GDrive] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastWAUpdate > EDIT_INTERVAL) {
          lastWAUpdate = now
          editStatus(buildStatus('📥', 'Descargando de Drive', pct, dlBytes, info.sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    try {
      await pipeline(fileRes.body, dlStream, fs.createWriteStream(tempPath), { signal })
    } catch (err) {
      if (isAbort(err)) throw err
      throw parseGDriveError(err)
    }
    watchdog.stop()
    watchdog = null
    console.log(`\n[GDrive] ✅ Descarga completa: ${info.fileName}`)

    await editStatus('✅ _Descarga completa._\n📤 _Subiendo a WhatsApp..._')

    await conn.sendMessage(
      m.chat,
      {
        // Baileys abre esta ruta internamente y evita el choque Node/Web stream.
        document: { url: tempPath },
        fileName: info.fileName,
        mimetype: info.mimetype,
      }
    )
    console.log(`\n[GDrive] 🚀 Enviado a ${m.sender}`)
    await editStatus('✅ *¡Listo!* Archivo enviado correctamente.')
  } catch (e) {
    if (isAbort(e)) {
      console.log('\n[GDrive] 🛑 Descarga cancelada.')
      await editStatus('🚫 *Descarga cancelada.*')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[GDrive ERROR]', e)
    }
  } finally {
    if (watchdog) watchdog.stop()
    global.gdActiveDownloads.delete(userKey)
    global.gdUserDownloads.delete(userKey)
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath) } catch {}
    }
  }
}

handler.help = ['gdrive <enlace archivo|carpeta>']
handler.tags = ['downloader']
handler.command = /^(gdrive|gd|drive|cancelar|stop)$/i

export default handler
