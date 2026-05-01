import axios    from 'axios'
import * as cheerio from 'cheerio'
import { lookup as mimeLookup } from 'mime-types'
import fs        from 'fs'
import { join }  from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import https     from 'https'

// ─── Agente persistente ───────────────────────────────────────────────────────

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })

// ─── Cancelaciones activas ────────────────────────────────────────────────────

global.mfActiveDownloads = global.mfActiveDownloads || new Map()

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

// ─── MediaFire scraper ────────────────────────────────────────────────────────

async function mediafireDl(url) {
  const res = await axios.get(url, {
    headers   : { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent,
    timeout   : 15000,
  })
  const $ = cheerio.load(res.data)
  const link =
    $('#downloadButton').attr('href') ||
    res.data.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/)?.[1]

  if (!link) throw '❌ No se pudo obtener el enlace de descarga de MediaFire.'

  const name =
    $('.promoDownloadName').first().attr('title') ||
    $('.filename').first().text().trim() ||
    link.split('/').pop().split('?')[0] ||
    'archivo'

  return { name: name.replace(/\s+/g, ' ').trim(), link }
}

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command }) => {
  // ── Cancelar descarga activa ───────────────────────────────────────────────
  if (/^(cancelar|stop)$/i.test(command)) {
    const quotedId = m.quoted?.id
    if (!quotedId) return m.reply('❌ Responde al mensaje de progreso de la descarga.')
    const dl = global.mfActiveDownloads.get(quotedId)
    if (!dl) return m.reply('❌ No hay descarga activa para ese mensaje.')
    dl.controller.abort()
    global.mfActiveDownloads.delete(quotedId)
    return m.reply('🚫 *Descarga cancelada.*')
  }

  const url = args[0]
  if (!url || !/mediafire\.com/i.test(url)) {
    throw (
      `🔥 *MediaFire Downloader*\n\n` +
      `Envía el enlace de MediaFire.\n` +
      `_Ej: ${usedPrefix + command} https://www.mediafire.com/file/XXXXX_`
    )
  }

  const controller = new AbortController()
  const { signal } = controller
  let tempPath

  const { key: statusKey } = await m.reply('🔄 _Obteniendo información del archivo..._')
  const editStatus = txt => conn.sendMessage(m.chat, { text: txt, edit: statusKey })

  try {
    const mfData = await mediafireDl(url)

    // Obtener tamaño real con HEAD
    const head = await axios.head(mfData.link, {
      headers   : { 'User-Agent': 'Mozilla/5.0' },
      httpsAgent,
      signal,
      timeout   : 10000,
    })
    const sizeBytes = parseInt(head.headers['content-length'] || '0')

    await editStatus(
      `🔥 *${mfData.name}*\n` +
      `⚖️ ${fmtBytes(sizeBytes)}\n` +
      `🔄 _Iniciando descarga..._\n` +
      `_Responde este mensaje con_ *.cancelar* _para detener._`
    )

    global.mfActiveDownloads.set(statusKey.id, { controller })

    // ── Descarga con progreso ─────────────────────────────────────────────
    tempPath = join(tmpdir(), `mf_${Date.now()}_${mfData.name.replace(/[/\\:*?"<>|]/g, '_')}`)

    const response = await axios({
      method      : 'get',
      url         : mfData.link,
      responseType: 'stream',
      signal,
      httpsAgent,
      timeout     : 0,
    })

    let dlBytes = 0
    const dlStart = Date.now()
    let lastWAUpdate = 0

    const dlStream = new Transform({
      transform(chunk, _, cb) {
        dlBytes += chunk.length
        const now   = Date.now()
        const secs  = (now - dlStart) / 1000 || 0.001
        const speed = dlBytes / secs
        const pct   = sizeBytes > 0 ? (dlBytes / sizeBytes) * 100 : 0

        process.stdout.write(
          `\r[MediaFire] 📥 ${pct.toFixed(1)}% | ${fmtBytes(dlBytes)} | ${fmtBytes(speed)}/s`
        )

        if (now - lastWAUpdate > 3000) {
          lastWAUpdate = now
          editStatus(buildStatus('📥', 'Descargando de MediaFire', pct, dlBytes, sizeBytes, speed))
        }
        cb(null, chunk)
      },
    })

    await pipeline(response.data, dlStream, fs.createWriteStream(tempPath), { signal })
    console.log(`\n[MediaFire] ✅ Descarga completa: ${mfData.name}`)

    // ── Subida con progreso ───────────────────────────────────────────────
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
          `\r[MediaFire] 📤 ${pct.toFixed(1)}% | ${fmtBytes(upBytes)}/${fmtBytes(realSize)} | ${fmtBytes(speed)}/s`
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
      fileName : mfData.name,
      mimetype : mimeLookup(mfData.name) || 'application/octet-stream',
      caption  :
        `✅ *${mfData.name}*\n` +
        `⚖️ *Tamaño:* ${fmtBytes(realSize)}\n` +
        `🚀 _Enviado con éxito._`,
    }, { quoted: m })

    console.log(`\n[MediaFire] 🚀 Enviado a ${m.sender}`)
    await editStatus('✅ *¡Listo!* Archivo enviado correctamente.')
    global.mfActiveDownloads.delete(statusKey.id)

  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
      console.log('\n[MediaFire] 🛑 Descarga cancelada.')
    } else {
      const msg = typeof e === 'string' ? e : `❌ *Error:* ${e.message}`
      await editStatus(msg)
      console.error('\n[MediaFire ERROR]', e)
    }
    global.mfActiveDownloads.delete(statusKey?.id)
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

handler.help    = ['mediafire <enlace>', 'mf <enlace>']
handler.tags    = ['downloader']
handler.command = /^(mediafire|mf|cancelar|stop)$/i

export default handler
      
