import { downloadContentFromMessage } from '@whiskeysockets/baileys'
import fs                              from 'fs-extra'
import path                            from 'path'
import { fileTypeFromBuffer }          from 'file-type'
import mime                            from 'mime-types'
import { spawn, execSync, execFile }   from 'child_process'
import { promisify }                   from 'util'
import sharp                           from 'sharp'
import { PDFDocument }                 from 'pdf-lib'
import archiver                        from 'archiver'
import { toMP3, ffmpeg as ffBase }     from '../src/libraries/converter.js'

const execFileAsync = promisify(execFile)

const TMP = process.env.TMPDIR || '/tmp'

const MIME_MAP = {
  mp4:  'video/mp4',
  mkv:  'video/x-matroska',
  webm: 'video/webm',
  avi:  'video/x-msvideo',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  opus: 'audio/opus',
  ogg:  'audio/ogg',
  m4a:  'audio/mp4',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf:  'application/pdf',
  txt:  'text/plain',
  zip:  'application/zip',
  rar:  'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar:  'application/x-tar',
  gz:   'application/gzip',
  bz2:  'application/x-bzip2',
  xz:   'application/x-xz',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc:  'application/msword',
  xls:  'application/vnd.ms-excel',
  ppt:  'application/vnd.ms-powerpoint',
  apk:  'application/vnd.android.package-archive',
  json: 'application/json',
  xml:  'application/xml',
  csv:  'text/csv',
  html: 'text/html',
  js:   'application/javascript',
}

const AUDIO_CODEC_MAP = {
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '2'],
  wav:  ['-c:a', 'pcm_s16le'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '4'],
  m4a:  ['-c:a', 'aac', '-b:a', '192k'],
}

const VIDEO_ARGS = [
  '-c:v', 'libx264', '-c:a', 'aac',
  '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
  '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-preset', 'fast',
]

const VIDEO_EXTS   = new Set(['mp4', 'mkv', 'webm', 'avi'])
const AUDIO_EXTS   = new Set(['mp3', 'wav', 'opus', 'ogg', 'm4a'])
const IMAGE_EXTS   = new Set(['png', 'jpg', 'jpeg', 'webp'])
const DOC_EXTS     = new Set(['pdf', 'txt'])
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])

const tmpPath = (ext) =>
  path.join(TMP, `rcv_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`)

const getExt = (name = '') => path.extname(name).slice(1).toLowerCase()

function extCat(ext) {
  if (VIDEO_EXTS.has(ext))   return 'video'
  if (AUDIO_EXTS.has(ext))   return 'audio'
  if (IMAGE_EXTS.has(ext))   return 'image'
  if (DOC_EXTS.has(ext))     return 'doc'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  return null
}

async function cleanup(...paths) {
  for (const p of paths) await fs.remove(p).catch(() => {})
}

function sysAvailable(cmd) {
  try { execSync(`which ${cmd} 2>/dev/null`); return true }
  catch { return false }
}

async function downloadMedia(mediaMsg, type) {
  const stream = await downloadContentFromMessage(mediaMsg, type)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function detectMedia(quoted) {
  const msg = quoted?.message || quoted || {}
  if (msg.videoMessage)    return { type: 'video',    mediaMsg: msg.videoMessage }
  if (msg.audioMessage)    return { type: 'audio',    mediaMsg: msg.audioMessage }
  if (msg.imageMessage)    return { type: 'image',    mediaMsg: msg.imageMessage }
  if (msg.documentMessage) return { type: 'document', mediaMsg: msg.documentMessage }
  const dwc = msg.documentWithCaptionMessage?.message
  if (dwc?.documentMessage) return { type: 'document', mediaMsg: dwc.documentMessage }
  if (dwc?.videoMessage)    return { type: 'video',    mediaMsg: dwc.videoMessage }
  return null
}

async function sendMedia(conn, m, filePath, fileName, ext) {
  const mimeType = MIME_MAP[ext] || mime.lookup(fileName) || 'application/octet-stream'
  const cat      = extCat(ext)
  const opts     = { quoted: m }

  if (cat === 'video') {
    return conn.sendMessage(m.chat, {
      video: { url: filePath }, fileName, mimetype: mimeType,
      caption: `✅ *${fileName}*`,
    }, opts)
  }
  if (cat === 'audio') {
    return conn.sendMessage(m.chat, {
      audio: { url: filePath }, fileName, mimetype: mimeType, ptt: false,
    }, opts)
  }
  if (cat === 'image') {
    return conn.sendMessage(m.chat, {
      image: { url: filePath }, caption: `✅ *${fileName}*`, mimetype: mimeType,
    }, opts)
  }
  return conn.sendMessage(m.chat, {
    document: { url: filePath }, fileName, mimetype: mimeType,
    caption: `✅ *${fileName}*`,
  }, opts)
}

function ffAudioToMp4(buf, origExt) {
  return new Promise(async (resolve, reject) => {
    const inPath  = tmpPath(origExt)
    const outPath = tmpPath('mp4')
    await fs.writeFile(inPath, buf)
    const proc = spawn('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25',
      '-i', inPath,
      '-c:v', 'libx264', '-c:a', 'aac',
      '-shortest', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ])
    proc.on('error', async (err) => { await cleanup(inPath, outPath); reject(err) })
    proc.on('close', async (code) => {
      await cleanup(inPath)
      if (code !== 0) { await cleanup(outPath); return reject(new Error(`FFmpeg error code ${code}`)) }
      resolve({ filename: outPath, delete: () => cleanup(outPath) })
    })
  })
}

function ffImageToMp4(buf, origExt) {
  return new Promise(async (resolve, reject) => {
    const inPath  = tmpPath(origExt)
    const outPath = tmpPath('mp4')
    await fs.writeFile(inPath, buf)
    const proc = spawn('ffmpeg', [
      '-y', '-loop', '1', '-i', inPath,
      '-t', '5', '-r', '25',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ])
    proc.on('error', async (err) => { await cleanup(inPath, outPath); reject(err) })
    proc.on('close', async (code) => {
      await cleanup(inPath)
      if (code !== 0) { await cleanup(outPath); return reject(new Error(`FFmpeg error code ${code}`)) }
      resolve({ filename: outPath, delete: () => cleanup(outPath) })
    })
  })
}

function createZip(inputFile, outputZip, entryName) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outputZip)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    archive.on('error', (err) => reject(new Error(`ZIP: ${err.message}`)))
    archive.pipe(output)
    archive.file(inputFile, { name: entryName })
    archive.finalize()
  })
}

async function createRar(inputFile, outputRar, entryName) {
  const tmpDir    = path.dirname(inputFile)
  const namedCopy = path.join(tmpDir, entryName)
  await fs.copy(inputFile, namedCopy)
  try {
    await execFileAsync('rar', ['a', '-ep', outputRar, namedCopy])
  } finally {
    await fs.remove(namedCopy).catch(() => {})
  }
}

async function create7z(inputFile, output7z, entryName) {
  const tmpDir    = path.dirname(inputFile)
  const namedCopy = path.join(tmpDir, entryName)
  await fs.copy(inputFile, namedCopy)
  try {
    await execFileAsync('7z', ['a', '-mx=9', output7z, namedCopy])
  } finally {
    await fs.remove(namedCopy).catch(() => {})
  }
}

function getOrigName(media, detectedExt) {
  if (media.mediaMsg.fileName) return media.mediaMsg.fileName
  const fallbackExt = detectedExt || { video: 'mp4', audio: 'mp3', image: 'jpg', document: 'bin' }[media.type] || 'bin'
  return `archivo.${fallbackExt}`
}

async function cmdRename(m, conn, args) {
  if (!m.quoted) {
    return m.reply(
      '❌ *Responde a un archivo* y escribe el nuevo nombre.\n\n' +
      '*Ejemplos:*\n' +
      '`.rm Jhon.mkv`\n' +
      '`.rename Solo Leveling.mp4`\n' +
      '`.rm canción.mp3`\n' +
      '`.rm foto.png`'
    )
  }

  const newName = args.join(' ').trim()
  if (!newName) return m.reply('❌ Escribe el nuevo nombre.\n*Uso:* `.rm <nombre.ext>`')

  const newExt = getExt(newName)
  if (!newExt) return m.reply('❌ El nombre debe incluir extensión.\n*Ejemplo:* `.rm video.mp4`')

  if (ARCHIVE_EXTS.has(newExt)) {
    const sugerido = { zip: '.tozip', rar: '.torar', '7z': '.to7z' }[newExt] || '.tozip'
    return m.reply(`❌ Para crear archivos \`.${newExt}\` usa el comando dedicado:\n\n*${sugerido}*`)
  }

  if (!MIME_MAP[newExt]) {
    return m.reply(
      `❌ Extensión \`.${newExt}\` no soportada.\n\n` +
      '*Formatos válidos:*\n' +
      '🎬 `mp4 mkv webm avi`\n' +
      '🎵 `mp3 wav opus ogg m4a`\n' +
      '🖼️ `png jpg jpeg webp`\n' +
      '📄 `pdf txt`'
    )
  }

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia en el mensaje citado.')

  await m.reply('⏳ Descargando archivo...')

  const buf      = await downloadMedia(media.mediaMsg, media.type)
  const detected = await fileTypeFromBuffer(buf)
  const origExt  = detected?.ext || getExt(getOrigName(media, null))

  if (origExt === newExt) {
    const outPath = tmpPath(newExt)
    await fs.writeFile(outPath, buf)
    try {
      await sendMedia(conn, m, outPath, newName, newExt)
    } finally {
      await cleanup(outPath)
    }
    return
  }

  const origCat = extCat(origExt)
  const newCat  = extCat(newExt)

  await m.reply(`⚙️ Convirtiendo \`.${origExt}\` → \`.${newExt}\`...`)

  if (origCat === 'video' && newCat === 'video') {
    const result = await ffBase(buf, VIDEO_ARGS, origExt, newExt)
    try {
      await sendMedia(conn, m, result.filename, newName, newExt)
    } finally {
      await result.delete()
    }
  } else if (origCat === 'audio' && newCat === 'audio') {
    const result = await ffBase(buf, ['-vn', ...(AUDIO_CODEC_MAP[newExt] || ['-c:a', 'aac'])], origExt, newExt)
    try {
      await sendMedia(conn, m, result.filename, newName, newExt)
    } finally {
      await result.delete()
    }
  } else if (origCat === 'image' && newCat === 'image') {
    const outPath = tmpPath(newExt)
    await sharp(buf).toFile(outPath)
    try {
      await sendMedia(conn, m, outPath, newName, newExt)
    } finally {
      await cleanup(outPath)
    }
  } else {
    return m.reply(
      `❌ No se puede convertir \`.${origExt}\` → \`.${newExt}\` con \`.rm\`.\n\n` +
      '*Usa los comandos especializados:*\n' +
      '🎵 `.tomp3` · 🎬 `.tomp4` · 📄 `.topdf` · 📁 `.todoc`\n' +
      '🗜️ `.tozip` · `.torar` · `.to7z`'
    )
  }
}

async function cmdToMp3(m, conn) {
  if (!m.quoted) return m.reply('❌ Responde a un *video o audio*.\n*Uso:* `.tomp3`')

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')
  if (media.type === 'image') return m.reply('❌ No es posible convertir una imagen a MP3.')

  await m.reply('🎵 Extrayendo audio en MP3...')

  const buf     = await downloadMedia(media.mediaMsg, media.type)
  const det     = await fileTypeFromBuffer(buf)
  const origExt = det?.ext || 'mp4'
  const result  = await toMP3(buf, origExt)

  const base = media.mediaMsg.fileName
    ? path.basename(media.mediaMsg.fileName, path.extname(media.mediaMsg.fileName))
    : 'audio'

  try {
    await conn.sendMessage(m.chat, {
      audio: { url: result.filename }, fileName: `${base}.mp3`,
      mimetype: 'audio/mpeg', ptt: false,
    }, { quoted: m })
  } finally {
    await result.delete()
  }
}

async function cmdToMp4(m, conn) {
  if (!m.quoted) return m.reply('❌ Responde a un *video, audio o imagen*.\n*Uso:* `.tomp4`')

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')

  await m.reply('🎬 Convirtiendo a MP4...')

  const buf     = await downloadMedia(media.mediaMsg, media.type)
  const det     = await fileTypeFromBuffer(buf)
  const origExt = det?.ext || { video: 'mp4', audio: 'mp3', image: 'jpg', document: 'mp4' }[media.type] || 'bin'
  const cat     = extCat(origExt) || media.type

  const base = media.mediaMsg.fileName
    ? path.basename(media.mediaMsg.fileName, path.extname(media.mediaMsg.fileName))
    : 'video'

  let result
  if (cat === 'video' || media.type === 'document') {
    result = await ffBase(buf, VIDEO_ARGS, origExt, 'mp4')
  } else if (cat === 'audio') {
    result = await ffAudioToMp4(buf, origExt)
  } else if (cat === 'image') {
    result = await ffImageToMp4(buf, origExt)
  } else {
    return m.reply('❌ Tipo de archivo no compatible con `.tomp4`.')
  }

  try {
    await conn.sendMessage(m.chat, {
      video: { url: result.filename }, fileName: `${base}.mp4`,
      mimetype: 'video/mp4', caption: `✅ *${base}.mp4*`,
    }, { quoted: m })
  } finally {
    await result.delete()
  }
}

async function cmdToPdf(m, conn) {
  if (!m.quoted) return m.reply('❌ Responde a una *imagen o texto*.\n*Uso:* `.topdf`')

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')

  await m.reply('📄 Generando PDF...')

  const buf     = await downloadMedia(media.mediaMsg, media.type)
  const det     = await fileTypeFromBuffer(buf)
  const origExt = det?.ext || getExt(media.mediaMsg.fileName || '') || 'bin'
  const cat     = extCat(origExt) || media.type
  const outPath = tmpPath('pdf')

  try {
    if (cat === 'image') {
      const pdfDoc = await PDFDocument.create()
      let imgEmbed
      if (['jpg', 'jpeg'].includes(origExt)) {
        imgEmbed = await pdfDoc.embedJpg(buf)
      } else {
        const pngBuf = await sharp(buf).png().toBuffer()
        imgEmbed     = await pdfDoc.embedPng(pngBuf)
      }
      const { width, height } = imgEmbed
      const page = pdfDoc.addPage([width, height])
      page.drawImage(imgEmbed, { x: 0, y: 0, width, height })
      await fs.writeFile(outPath, await pdfDoc.save())

    } else if (origExt === 'txt' || (cat === 'doc' && origExt !== 'pdf')) {
      const { default: PDFKit } = await import('pdfkit')
      await new Promise((resolve, reject) => {
        const doc = new PDFKit({ margin: 50 })
        const ws  = fs.createWriteStream(outPath)
        doc.pipe(ws)
        doc.font('Helvetica').fontSize(12)
           .text(buf.toString('utf-8'), { align: 'left', lineGap: 4 })
        doc.end()
        ws.on('finish', resolve)
        ws.on('error',  reject)
      })

    } else {
      return m.reply(
        '❌ Tipo no soportado para `.topdf`.\n\n' +
        '*Soportados:* imágenes (`png jpg jpeg webp`) y texto (`txt`)'
      )
    }

    const base = media.mediaMsg.fileName
      ? path.basename(media.mediaMsg.fileName, path.extname(media.mediaMsg.fileName))
      : 'documento'

    await conn.sendMessage(m.chat, {
      document: { url: outPath }, fileName: `${base}.pdf`,
      mimetype: 'application/pdf', caption: `✅ *${base}.pdf*`,
    }, { quoted: m })

  } finally {
    await cleanup(outPath)
  }
}

async function cmdTodoc(m, conn, args) {
  if (!m.quoted) {
    return m.reply(
      '❌ Responde a cualquier archivo para enviarlo como documento.\n\n' +
      '*Uso:*\n' +
      '`.todoc` — con nombre original\n' +
      '`.todoc NuevoNombre.mp4` — renombrando al enviar\n\n' +
      '💡 Útil para evitar la compresión de WhatsApp en videos e imágenes.'
    )
  }

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia en el mensaje citado.')

  await m.reply('📁 Preparando documento...')

  const buf     = await downloadMedia(media.mediaMsg, media.type)
  const det     = await fileTypeFromBuffer(buf)
  const origExt = det?.ext || getExt(media.mediaMsg.fileName || '') ||
    { video: 'mp4', audio: 'mp3', image: 'jpg', document: 'bin' }[media.type] || 'bin'

  const origName   = media.mediaMsg.fileName || `archivo.${origExt}`
  const customName = args.join(' ').trim()
  const finalName  = customName || origName
  const finalExt   = getExt(finalName) || origExt
  const mimeType   = MIME_MAP[finalExt] || mime.lookup(finalName) || 'application/octet-stream'
  const outPath    = tmpPath(finalExt)

  await fs.writeFile(outPath, buf)

  try {
    await conn.sendMessage(m.chat, {
      document: { url: outPath }, fileName: finalName,
      mimetype: mimeType, caption: `✅ *${finalName}*`,
    }, { quoted: m })
  } finally {
    await cleanup(outPath)
  }
}

async function cmdTozip(m, conn, args) {
  if (!m.quoted) {
    return m.reply(
      '❌ Responde a un archivo para comprimirlo en ZIP.\n\n' +
      '*Uso:*\n' +
      '`.tozip` — nombre automático\n' +
      '`.tozip MiArchivo` — nombre personalizado del zip'
    )
  }

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')

  await m.reply('🗜️ Creando archivo ZIP...')

  const buf      = await downloadMedia(media.mediaMsg, media.type)
  const det      = await fileTypeFromBuffer(buf)
  const origName = getOrigName(media, det?.ext)
  const origExt  = det?.ext || getExt(origName)
  const base     = path.basename(origName, path.extname(origName))

  const customBase = args.join(' ').trim()
  const zipName    = customBase ? `${customBase}.zip` : `${base}.zip`

  const inPath  = tmpPath(origExt || 'bin')
  const outPath = tmpPath('zip')
  await fs.writeFile(inPath, buf)

  try {
    await createZip(inPath, outPath, origName)
    const stat = await fs.stat(outPath)
    const size = (stat.size / 1024 / 1024).toFixed(2)

    await conn.sendMessage(m.chat, {
      document: { url: outPath }, fileName: zipName,
      mimetype: 'application/zip', caption: `✅ *${zipName}*\n📦 Tamaño: ${size} MB`,
    }, { quoted: m })
  } finally {
    await cleanup(inPath, outPath)
  }
}

async function cmdTorar(m, conn, args) {
  if (!m.quoted) {
    return m.reply(
      '❌ Responde a un archivo para comprimirlo en RAR.\n\n' +
      '*Uso:* `.torar [nombre opcional]`\n\n' +
      '⚠️ Requiere: `pkg install rar`'
    )
  }

  if (!sysAvailable('rar')) {
    return m.reply(
      '❌ El comando `rar` no está disponible en el sistema.\n\n' +
      '*Instalar en Termux:*\n```pkg install rar```\n\n' +
      '💡 Alternativa: usa `.tozip` — no requiere instalación extra.'
    )
  }

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')

  await m.reply('🗜️ Creando archivo RAR...')

  const buf      = await downloadMedia(media.mediaMsg, media.type)
  const det      = await fileTypeFromBuffer(buf)
  const origName = getOrigName(media, det?.ext)
  const origExt  = det?.ext || getExt(origName)
  const base     = path.basename(origName, path.extname(origName))

  const customBase = args.join(' ').trim()
  const rarName    = customBase ? `${customBase}.rar` : `${base}.rar`

  const inPath  = tmpPath(origExt || 'bin')
  const outPath = tmpPath('rar')
  await fs.writeFile(inPath, buf)

  try {
    await createRar(inPath, outPath, origName)
    const stat = await fs.stat(outPath)
    const size = (stat.size / 1024 / 1024).toFixed(2)

    await conn.sendMessage(m.chat, {
      document: { url: outPath }, fileName: rarName,
      mimetype: 'application/vnd.rar', caption: `✅ *${rarName}*\n📦 Tamaño: ${size} MB`,
    }, { quoted: m })
  } finally {
    await cleanup(inPath, outPath)
  }
}

async function cmdTo7z(m, conn, args) {
  if (!m.quoted) {
    return m.reply(
      '❌ Responde a un archivo para comprimirlo en 7Z.\n\n' +
      '*Uso:* `.to7z [nombre opcional]`\n\n' +
      '⚠️ Requiere: `pkg install p7zip`'
    )
  }

  if (!sysAvailable('7z')) {
    return m.reply(
      '❌ El comando `7z` no está disponible en el sistema.\n\n' +
      '*Instalar en Termux:*\n```pkg install p7zip```\n\n' +
      '💡 Alternativa: usa `.tozip` — no requiere instalación extra.'
    )
  }

  const media = detectMedia(m.quoted)
  if (!media) return m.reply('❌ No se detectó un archivo multimedia.')

  await m.reply('🗜️ Creando archivo 7Z...')

  const buf      = await downloadMedia(media.mediaMsg, media.type)
  const det      = await fileTypeFromBuffer(buf)
  const origName = getOrigName(media, det?.ext)
  const origExt  = det?.ext || getExt(origName)
  const base     = path.basename(origName, path.extname(origName))

  const customBase = args.join(' ').trim()
  const z7Name     = customBase ? `${customBase}.7z` : `${base}.7z`

  const inPath  = tmpPath(origExt || 'bin')
  const outPath = tmpPath('7z')
  await fs.writeFile(inPath, buf)

  try {
    await create7z(inPath, outPath, origName)
    const stat = await fs.stat(outPath)
    const size = (stat.size / 1024 / 1024).toFixed(2)

    await conn.sendMessage(m.chat, {
      document: { url: outPath }, fileName: z7Name,
      mimetype: 'application/x-7z-compressed', caption: `✅ *${z7Name}*\n📦 Tamaño: ${size} MB`,
    }, { quoted: m })
  } finally {
    await cleanup(inPath, outPath)
  }
}

let handler = async (m, { conn, args, command }) => {
  try {
    switch (command.toLowerCase()) {
      case 'rm':
      case 'rename':  return await cmdRename(m, conn, args)
      case 'tomp3':   return await cmdToMp3(m, conn)
      case 'tomp4':   return await cmdToMp4(m, conn)
      case 'topdf':   return await cmdToPdf(m, conn)
      case 'todoc':   return await cmdTodoc(m, conn, args)
      case 'tozip':   return await cmdTozip(m, conn, args)
      case 'torar':   return await cmdTorar(m, conn, args)
      case 'to7z':    return await cmdTo7z(m, conn, args)
    }
  } catch (err) {
    console.error('[rename-convert] Error:', err)
    await m.reply(
      `❌ *Error en la operación:*\n` +
      `\`${(err.message || String(err)).slice(0, 300)}\`\n\n` +
      `_Verifica que el archivo no esté corrupto e intenta de nuevo._`
    )
  }
}

handler.help    = ['rm <nombre.ext>', 'rename <nombre.ext>', 'tomp3', 'tomp4', 'topdf', 'todoc [nombre.ext]', 'tozip [nombre]', 'torar [nombre]', 'to7z [nombre]']
handler.tags    = ['tools', 'files', 'convert', 'media', 'archive']
handler.command = /^(rm|rename|tomp3|tomp4|topdf|todoc|tozip|torar|to7z)$/i

export default handler
