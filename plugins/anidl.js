import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { lookup as mimeLookup } from 'mime-types'
import { loadEnv } from '../src/funcion/env.js'
import {
  cancelDownloads,
  downloadKey,
  finishDownload,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js'
import jpegThumbnailLibrary from '../src/libraries/jpeg-thumbnail.cjs'
import createTerminalLogger from '../src/libraries/terminal-log.cjs'
import {
  AniDLError,
  buildCommand,
  describeLanguage,
  describeQuality,
  listOutputVideos,
  parseAniDLInput,
  resolveAniDLSetup,
  runAniDLDownload,
} from '../src/libraries/anidl.js'

loadEnv()

const INLINE_VIDEO_MAX_BYTES = 64 * 1024 * 1024
const STATUS_EDIT_INTERVAL_MS = 4_000
const HEARTBEAT_INTERVAL_MS = 12_000

global.anidlRuntime = global.anidlRuntime || { activeJob: null }

const terminalLog = createTerminalLogger('ANIDL')

function fmtBytes(bytes = 0) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtDuration(ms = 0) {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function progressBar(pct = 0, width = 16) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0))
  const filled = Math.round((clamped / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function isAbortError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'CanceledError' ||
    err?.code === 'ERR_CANCELED' ||
    err?.code === 'ABORT_ERR'
  )
}

function createSpeedSampler(windowMs = 5_000) {
  const samples = []
  return {
    sample(totalBytes, now = Date.now()) {
      samples.push([now, totalBytes])
      while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift()
      const [t0, b0] = samples[0]
      const elapsed = now - t0
      return elapsed > 0 ? ((totalBytes - b0) / elapsed) * 1000 : 0
    },
  }
}

function extractQuotedText(m) {
  const q = m?.quoted
  if (!q) return ''
  return (
    q.text ||
    q.body ||
    q.caption ||
    q.message?.conversation ||
    q.message?.extendedTextMessage?.text ||
    q.message?.imageMessage?.caption ||
    q.message?.videoMessage?.caption ||
    ''
  )
}

function formatUsage(prefix = '.') {
  return (
    '🎌 *AniDL · Crunchyroll Downloader*\n\n' +
    `📌 *Uso directo:*\n` +
    `\`${prefix}ani <URL de Crunchyroll> [opciones]\`\n` +
    `📌 *Respondiendo a un mensaje con link:*\n` +
    `\`${prefix}ani [opciones]\`\n\n` +
    '⚡ *Atajos rápidos:*\n' +
    '• `lat` / `cast` / `eng` — audio Español Latino, Castellano o Inglés\n' +
    '• `sub` — audio Japonés + subtítulos Español Latino\n' +
    '• `hardsub` (`hs`) — incrusta subtítulos en Español Latino\n' +
    '• `1080p` (`max`) · `720p` · `480p` · `360p` · `240p` — calidad\n' +
    '• `mp4` · `mkv` · `fonts` · `tsd` · `--doc` · `--cleanup`\n\n' +
    '🛠️ *Opciones avanzadas:*\n' +
    '• `--dubLang <cod>` (`jpn`, `spa-419`, `spa-ES`, `eng`, `por`…)\n' +
    '• `--dlsubs <all|none|cod>` (`es-419`, `es-ES`, `en`…)\n' +
    '• `--hslang <cod>` — hardsubs incrustados\n' +
    '• `-q <0..5>` — `0` = máxima calidad, `4` = ~720p (predeterminado)\n' +
    '• `-e <1|1-3>` — selección de episodios si el enlace es `/series/ID`\n' +
    '• `--partsize <1..64>` — segmentos HLS simultáneos\n\n' +
    '🧭 *Subcomandos:*\n' +
    `• \`${prefix}ani status\` — diagnóstico de AniDL y tarea en curso\n` +
    `• \`${prefix}ani list\` — últimos videos en la carpeta de salida\n` +
    `• \`${prefix}ani cancel\` (o \`${prefix}cancelar\`) — detener descarga activa`
  )
}

function renderDownloadStatus({ target, options, progress, startedAt, prefix }) {
  const elapsed = fmtDuration(Date.now() - startedAt)
  const audioLabel = options.dubLanguages.map(describeLanguage).join(', ')
  const subsLabel = options.downloadSubtitlesList.map(describeLanguage).join(', ')
  const lines = [
    '📥 *Descargando con AniDL · Crunchyroll*',
    progress?.episodeTitle ? `🎬 *${progress.episodeTitle}*` : null,
    `🆔 \`${target.id}\`${options.episodeSelection ? ` · Ep. \`${options.episodeSelection}\`` : ''} · *${options.container.toUpperCase()}*`,
    `🔊 Audio: ${audioLabel}`,
    `💬 Softsubs: ${subsLabel}${options.hardSubtitleLanguage ? ` · Hardsub: ${describeLanguage(options.hardSubtitleLanguage)}` : ''}`,
    `🎞️ Calidad: ${describeQuality(options.quality)}`,
  ].filter(Boolean)

  if (progress?.percent != null) {
    lines.push(`\`[${progressBar(progress.percent)}] ${progress.percent.toFixed(1)}%\``)
  }
  if (progress?.completedParts && progress?.totalParts) {
    lines.push(
      `🧩 Segmentos: ${progress.completedParts}/${progress.totalParts}` +
      (progress.speedText ? ` · ⚡ ${progress.speedText}` : ''),
    )
  }

  lines.push(`🔄 Estado: _${progress?.stageLabel || 'Procesando…'}_ (${elapsed})`)
  lines.push(`_Usa_ *${prefix}cancelar* _o_ *${prefix}ani cancel* _para detener._`)
  return lines.join('\n')
}

function renderUploadStatus(fileName, pct, done, total, speed) {
  return (
    `📤 *Subiendo a WhatsApp*\n` +
    `📄 \`${fileName}\`\n` +
    `\`[${progressBar(pct)}] ${pct.toFixed(1)}%\`\n` +
    `📦 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
    `⚡ ${fmtBytes(speed)}/s`
  )
}

async function handleDiagCommand(m, conn) {
  const setup = resolveAniDLSetup()
  const active = global.anidlRuntime.activeJob
  const videos = setup.outputDir ? listOutputVideos(setup.outputDir, 100) : []
  const totalBytes = videos.reduce((acc, v) => acc + v.size, 0)

  const lines = [
    '🩺 *Diagnóstico de AniDL*',
    '',
    `• Estado: ${setup.ready ? '✅ *Listo*' : '❌ *No disponible*'}`,
    `• Directorio base: \`${setup.workDir || setup.expectedDir || '~/anidl'}\``,
    `• Ejecutable: ${setup.executable ? `\`${setup.executable}\`` : '❌ No encontrado / sin permisos +x'}`,
    `• Carpeta de salida: \`${setup.outputDir || '—'}\``,
    `• FFmpeg en PATH: ${setup.muxers.ffmpeg ? '✅' : '⚠️ No detectado'}`,
    `• MKVMerge en PATH: ${setup.muxers.mkvmerge ? '✅' : '⚠️ No detectado'}`,
    `• Límite WhatsApp: *${setup.maxMb} MB* · Timeout: *${setup.timeoutSeconds}s*`,
    `• Autolimpieza tras envío: *${setup.cleanupDefault ? 'Sí' : 'No (conserva archivos)'}*`,
    `• Videos en carpeta: *${videos.length}* (${fmtBytes(totalBytes)})`,
  ]

  if (active) {
    lines.push(
      '',
      '⏳ *Tarea en ejecución:*',
      `• ID: \`${active.target.id}\` (${fmtDuration(Date.now() - active.startedAt)})`,
      `• Etapa: ${active.lastProgress?.stageLabel || 'Iniciando'}`,
      active.lastProgress?.percent != null ? `• Progreso: ${active.lastProgress.percent.toFixed(1)}%` : null,
    )
  }

  if (!setup.ready) {
    lines.push(
      '',
      '💡 *Cómo configurarlo:*',
      '1. Instala `aniDL` (`multi-downloader-nx`) en `~/anidl/aniDL` con `chmod +x` (o define `ANIDL_DIR` / `ANIDL_BIN` en `.env`).',
      '2. Inicia sesión una vez en tu servidor con `./aniDL --service crunchy --auth`.',
    )
  }

  return conn.sendMessage(m.chat, { text: lines.filter((l) => l !== null).join('\n') }, { quoted: m })
}

async function handleListCommand(m, conn) {
  const setup = resolveAniDLSetup()
  const dir = setup.outputDir || (setup.workDir ? path.join(setup.workDir, 'videos') : null)
  if (!dir || !fs.existsSync(dir)) {
    return conn.sendMessage(m.chat, { text: '📭 La carpeta de videos de AniDL aún no existe o está vacía.' }, { quoted: m })
  }
  const items = listOutputVideos(dir, 15)
  if (!items.length) {
    return conn.sendMessage(m.chat, { text: `📭 No hay videos guardados en \`${dir}\`.` }, { quoted: m })
  }
  const lines = [
    `📂 *Últimos videos en AniDL* (${items.length})`,
    `📍 \`${dir}\``,
    '',
    ...items.map((item, idx) => {
      const name = path.relative(dir, item.filePath)
      const date = new Date(item.mtimeMs).toLocaleString('es-PE', { hour12: false })
      return `*${idx + 1}.* \`${name}\`\n   ⚖️ ${fmtBytes(item.size)} · 🕒 ${date}`
    }),
  ]
  return conn.sendMessage(m.chat, { text: lines.join('\n') }, { quoted: m })
}

function handleCancelCommand(m) {
  const userKey = downloadKey(m)
  const active = global.anidlRuntime.activeJob
  const cancelledRegistry = cancelDownloads(userKey, 'anidl')

  if (active) {
    try {
      active.controller.abort()
    } catch {}
    return m.reply(`⏹️ *Cancelando descarga AniDL* (\`${active.target.id}\`)…`)
  }
  if (cancelledRegistry.length) {
    return m.reply('⏹️ *Descarga AniDL cancelada.*')
  }
  return m.reply('ℹ️ No hay ninguna descarga de AniDL activa en este momento.')
}

const handler = async (m, { conn, text = '', args = [], usedPrefix = '.', isOwner }) => {
  if (!isOwner) {
    await m.reply('⛔ Solo el propietario puede usar AniDL.')
    return
  }

  const sub = String(args[0] || '').trim().toLowerCase()
  const quotedText = extractQuotedText(m)

  if (sub === 'status' || sub === 'diag' || sub === 'info') {
    await handleDiagCommand(m, conn)
    return
  }
  if (sub === 'list' || sub === 'files' || sub === 'ls') {
    await handleListCommand(m, conn)
    return
  }
  if (sub === 'cancel' || sub === 'stop' || sub === 'cancelar') {
    await handleCancelCommand(m)
    return
  }
  if (sub === 'help' || sub === 'ayuda' || (!text.trim() && !quotedText.trim())) {
    await m.reply(formatUsage(usedPrefix))
    return
  }

  const setup = resolveAniDLSetup()
  let parsedInput
  try {
    parsedInput = parseAniDLInput(text, quotedText, {
      quality: setup.defaultQuality,
      cleanup: setup.cleanupDefault,
    })
  } catch (err) {
    if (err instanceof AniDLError) {
      await m.reply(`❌ ${err.message}\n\nUsa *${usedPrefix}ani help* para ver ejemplos y opciones.`)
      return
    }
    throw err
  }

  if (!setup.ready || !setup.workDir || !setup.outputDir || !setup.executable) {
    await m.reply(
      '❌ *AniDL no está listo en este servidor.*\n' +
      `Verifica el ejecutable \`aniDL\` y su configuración local (ruta esperada: \`${setup.expectedDir || '~/anidl'}\`).\n` +
      `Usa *${usedPrefix}ani status* para ver el diagnóstico detallado.`,
    )
    return
  }

  const userKey = downloadKey(m)
  if (hasDownload(userKey, 'anidl')) {
    await m.reply(`⚠️ Ya tienes una descarga AniDL activa. Usa *${usedPrefix}cancelar* o *${usedPrefix}ani cancel* para detenerla.`)
    return
  }

  if (global.anidlRuntime.activeJob) {
    const busy = global.anidlRuntime.activeJob
    await m.reply(
      `⏳ AniDL está ocupado descargando \`${busy.target.id}\` (${fmtDuration(Date.now() - busy.startedAt)}).\n` +
      `Espera a que termine o usa *${usedPrefix}ani cancel* si deseas abortarla.`,
    )
    return
  }

  const { target, options } = parsedInput
  const argv = buildCommand(setup.executable, target, options)
  const controller = new AbortController()
  const { signal } = controller
  const startedAt = Date.now()

  const activeJob = {
    target,
    options,
    controller,
    startedAt,
    chat: m.chat,
    sender: m.sender,
    lastProgress: {
      percent: null,
      completedParts: 0,
      totalParts: 0,
      speedText: null,
      stage: 'starting',
      stageLabel: 'Preparando descarga en AniDL',
      episodeTitle: null,
    },
  }

  global.anidlRuntime.activeJob = activeJob
  startDownload(userKey, 'anidl', controller, {
    label: `🎌 AniDL (${target.id})`,
    meta: { targetId: target.id },
  })

  terminalLog('descarga iniciada', {
    id: target.id,
    tipo: target.kind,
    audio: options.dubLanguages.join(', '),
    subs: options.downloadSubtitles,
    hardsub: options.hardSubtitleLanguage || 'ninguno',
    calidad: options.quality,
    contenedor: options.container,
  })

  let statusKey = null
  let lastEditAt = 0
  let heartbeatTimer = null

  const editStatus = async (newText, { force = false } = {}) => {
    if (!statusKey) return
    const now = Date.now()
    if (!force && now - lastEditAt < STATUS_EDIT_INTERVAL_MS) return
    lastEditAt = now
    try {
      await conn.sendMessage(m.chat, { text: newText, edit: statusKey })
    } catch {}
  }

  try {
    const initialMsg = await conn.sendMessage(
      m.chat,
      {
        text: renderDownloadStatus({
          target,
          options,
          progress: activeJob.lastProgress,
          startedAt,
          prefix: usedPrefix,
        }),
      },
      { quoted: m },
    )
    statusKey = initialMsg?.key || null

    heartbeatTimer = setInterval(() => {
      if (signal.aborted) return
      editStatus(
        renderDownloadStatus({
          target,
          options,
          progress: activeJob.lastProgress,
          startedAt,
          prefix: usedPrefix,
        }),
      )
    }, HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref?.()

    const result = await runAniDLDownload({
      executable: setup.executable,
      argv,
      workDir: setup.workDir,
      outputDir: setup.outputDir,
      timeoutMs: setup.timeoutSeconds * 1000,
      signal,
      onProgress: (progress) => {
        activeJob.lastProgress = progress
        editStatus(
          renderDownloadStatus({
            target,
            options,
            progress,
            startedAt,
            prefix: usedPrefix,
          }),
        )
      },
    })

    clearInterval(heartbeatTimer)
    heartbeatTimer = null

    if (!result.videos.length) {
      await editStatus(
        `⚠️ AniDL finalizó sin errores, pero no se detectaron videos nuevos o modificados en \`${setup.outputDir}\`.`,
        { force: true },
      )
      return
    }

    const maxBytes = setup.maxMb * 1024 * 1024
    const shouldCleanup = Boolean(options.cleanup ?? setup.cleanupDefault)
    let sentCount = 0
    let skippedOversize = 0

    for (const filePath of result.videos) {
      if (signal.aborted) {
        const abortErr = new Error('Descarga cancelada.')
        abortErr.name = 'AbortError'
        throw abortErr
      }

      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }

      const fileName = path.basename(filePath)
      const ext = path.extname(fileName).toLowerCase()

      if (stat.size > maxBytes) {
        skippedOversize += 1
        terminalLog('archivo omitido por tamaño', { archivo: fileName, tamaño: fmtBytes(stat.size) })
        await editStatus(
          `⚠️ \`${fileName}\` (${fmtBytes(stat.size)}) supera el límite configurado de *${setup.maxMb} MB*. El archivo se conservó en el servidor.`,
          { force: true },
        )
        continue
      }

      await editStatus(`📤 Preparando envío de \`${fileName}\` (${fmtBytes(stat.size)})…`, { force: true })

      const jpegThumbnail = await jpegThumbnailLibrary.createJpegThumbnail(filePath).catch(() => null)
      const caption = [
        '🎌 *AniDL · Crunchyroll*',
        `📄 ${fileName.slice(0, 500)}`,
        `🔊 Audio: ${options.dubLanguages.map(describeLanguage).join(', ')}`,
        `💬 Subs: ${options.downloadSubtitlesList.map(describeLanguage).join(', ')}` +
          (options.hardSubtitleLanguage ? ` · Hardsub: ${options.hardSubtitleLanguage}` : ''),
        `⚖️ Tamaño: ${fmtBytes(stat.size)}`,
      ].join('\n')

      const sendInlineVideo = !options.forceDocument && ext === '.mp4' && stat.size <= INLINE_VIDEO_MAX_BYTES

      if (sendInlineVideo) {
        await conn.sendMessage(
          m.chat,
          {
            video: { url: filePath },
            mimetype: 'video/mp4',
            fileName,
            caption,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
          },
          { quoted: m },
        )
      } else {
        let uploadedBytes = 0
        const sampler = createSpeedSampler()
        const progressStream = new Transform({
          transform(chunk, _enc, cb) {
            if (signal.aborted) {
              const abortErr = new Error('Descarga cancelada.')
              abortErr.name = 'AbortError'
              cb(abortErr)
              return
            }
            uploadedBytes += chunk.length
            const now = Date.now()
            const speed = sampler.sample(uploadedBytes, now)
            const pct = stat.size > 0 ? (uploadedBytes / stat.size) * 100 : 0
            editStatus(renderUploadStatus(fileName, pct, uploadedBytes, stat.size, speed))
            cb(null, chunk)
          },
        })

        const pass = new PassThrough()
        pipeline(fs.createReadStream(filePath), progressStream, pass, { signal }).catch((err) => {
          pass.destroy(err)
        })

        const mimetype = ext === '.mkv'
          ? 'video/x-matroska'
          : (mimeLookup(fileName) || 'application/octet-stream')

        await conn.sendMessage(
          m.chat,
          {
            document: { stream: pass },
            mimetype,
            fileName,
            caption,
            ...(jpegThumbnail ? { jpegThumbnail } : {}),
          },
          { quoted: m },
        )
      }

      sentCount += 1
      terminalLog('archivo enviado', {
        archivo: fileName,
        tamaño: fmtBytes(stat.size),
        modo: sendInlineVideo ? 'video' : 'documento',
      })

      if (shouldCleanup) {
        try {
          fs.unlinkSync(filePath)
        } catch {}
      }
    }

    const storageNote = shouldCleanup
      ? 'Los archivos enviados se limpiaron automáticamente del servidor.'
      : `Los archivos permanecen guardados en \`${setup.outputDir}\`.`
    const oversizeNote = skippedOversize > 0
      ? ` (${skippedOversize} omitido(s) por superar ${setup.maxMb} MB)`
      : ''

    await editStatus(
      `✅ *AniDL completado* en ${fmtDuration(Date.now() - startedAt)}.\n` +
      `📦 Enviados: *${sentCount}* archivo(s)${oversizeNote}.\n` +
      `💾 ${storageNote}`,
      { force: true },
    )
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      terminalLog('descarga cancelada', { id: target.id })
      await editStatus('🚫 *Descarga AniDL cancelada.* Los archivos preexistentes no se borraron.', { force: true })
    } else if (err instanceof AniDLError) {
      terminalLog('error de AniDL', { id: target.id, codigo: err.code, mensaje: err.message })
      await editStatus(`❌ *${err.message}*`, { force: true })
    } else {
      terminalLog('fallo inesperado', { id: target.id, error: err?.message || String(err) })
      console.error('[anidl]', err)
      await editStatus('❌ Ocurrió un error al ejecutar AniDL o al subir el archivo a WhatsApp. Los archivos locales se conservaron.', { force: true })
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (global.anidlRuntime.activeJob === activeJob) {
      global.anidlRuntime.activeJob = null
    }
    finishDownload(userKey, 'anidl', controller)
  }
}

handler.help = ['ani <url> [opciones]', 'anidl <url|status|list|cancel>']
handler.tags = ['anime', 'downloader', 'owner']
handler.command = /^(ani|anidl)$/i
handler.owner = true

export default handler
