import { generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import fs   from 'fs'
import path from 'path'
import { lookup as mimeLookup } from 'mime-types'
import { pipeline } from 'stream/promises'

import {
  SITIOS,
  getSitioPorId,
  getSitioPorDominio,
  guardarPicks,
  cargarPicks,
  mediafireDl,
  CONFIG,
  randomUA,
  httpsAgent,
  normalizarMegaUrl,
  numToLetter,
  enviarListaWA,
  buscarResultadosAnimeFLV,
  mostrarInfoYEpisodios,
  puntuarMatch,
  parseMegaError,
  descargarMega,
  descargarConYtDlp,
  ejecutarDescargaServidor,
  MegaQuotaError,
  esServidorConocido,
} from '../src/libraries/anime-dl.js'

const handler = async (m, { conn, text, args, usedPrefix, command }) => {

  if (command === 'anilist') {
    const lista = SITIOS.map(s => `*${s.id}.* ${s.nombre}\n   🔗 ${s.url}`).join('\n\n')
    return m.reply(
      `*🎌 Sitios de Anime Disponibles*\n\n${lista}\n\n` +
      `*¿Cómo usar?*\n` +
      `• *.animedl <nombre> <ep>*\n` +
      `• *.animedl <nombre> t<N> <ep>*\n` +
      `• *.animedl <S> <nombre> t<N> <ep>*\n\n` +
      `*Ejemplos:*\n` +
      `  .animedl one piece 1100\n` +
      `  .animedl shingeki no kyojin t4 1\n` +
      `  .animedl 7 naruto shippuden t2 30\n\n` +
      `_t<N> = temporada. Sin t = temporada 1_`
    )
  }

  if (command === 'cancelar' || command === 'stop') {
    const quotedMsgId = m.quoted?.id
    if (!quotedMsgId) return m.reply(`❌ Responde al mensaje de progreso de la descarga.`)
    const dl = global.activeDownloads.get(quotedMsgId)
    if (!dl) return m.reply(`❌ No hay descarga activa para ese mensaje.`)
    dl.controller.abort()
    global.activeDownloads.delete(quotedMsgId)
    return m.reply(`🚫 Descarga cancelada.`)
  }

  const letraInput = text?.trim().toLowerCase()
  if (/^[a-z]$/.test(letraInput)) {
    const animeSearch = global.pendingAnimeSearch.get(m.chat)
    if (animeSearch) {
      if (animeSearch.owner && animeSearch.owner !== m.sender) {
        return conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, esta selección pertenece a otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
      }
      const idxSearch = letraInput.charCodeAt(0) - 97
      const elegido   = animeSearch.resultados[idxSearch]
      if (!elegido) return m.reply(`❌ Letra inválida. Elige entre *a* y *${numToLetter(animeSearch.resultados.length - 1)}*.`)
      global.pendingAnimeSearch.delete(m.chat)
      return mostrarInfoYEpisodios(elegido, m, conn, usedPrefix, animeSearch.temporada)
    }
  }

  if ((command === 'animedl' || command === 'dl') && /^(\d+|[a-z])$/i.test(text?.trim())) {
    const pick = global.pendingServerPicks.get(m.chat)
    if (pick) {
      if (pick.owner && pick.owner !== m.sender) {
        return conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, esta selección pertenece a otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
      }
      const raw = text.trim().toLowerCase()
      const num = /^[a-z]$/.test(raw) ? raw.charCodeAt(0) - 96 : parseInt(raw)
      if (num < 1 || num > pick.servers.length) {
        return m.reply(`❌ Selección inválida. Elige entre *a* y *${numToLetter(pick.servers.length - 1)}* (o *1*–*${pick.servers.length}*).`)
      }
      global.pendingServerPicks.delete(m.chat)
      const sk = `${m.chat}|${m.sender}`
      delete global.animeDlSessions[sk]
      guardarPicks()
      return ejecutarDescargaServidor(pick.servers, num - 1, pick, m, conn)
    }
  }

  if (!text || !text.trim()) {
    return m.reply(
      `*🎌 Descargador de Anime + Archivos*\n\n` +
      `*Comandos:*\n` +
      `• *.anilist* — Ver sitios disponibles (${SITIOS.length} sitios)\n` +
      `• *.animedl <nombre> <ep>* — Buscar en todos\n` +
      `• *.animedl <nombre> t<N> <ep>* — Temporada N\n` +
      `• *.animedl <S> <nombre> t<N> <ep>* — Sitio S + temporada N\n` +
      `• *.animedl <url>* — URL directa del episodio\n` +
      `• *.animedl <url mega/mediafire>* — Descargar archivo\n\n` +
      `*Ejemplos:*\n` +
      `  .animedl shingeki no kyojin t4 1\n` +
      `  .animedl 7 tioanime naruto 1\n\n` +
      `_Usa .anilist para ver los números de sitio_`
    )
  }

  const rawArg      = (args?.[0] || text?.trim() || '')
  const isMega      = /mega\.nz/.test(rawArg)
  const isMediaFire = /mediafire\.com/.test(rawArg)

  if (isMega || isMediaFire) {
    const { default: axios } = await import('axios')
    const controller = new AbortController()
    const { signal } = controller
    let tempPath, msgId

    try {
      const { key } = await m.reply(`⏳ *Preparando descarga...*`)
      msgId = key.id
      global.activeDownloads.set(msgId, { controller })

      if (isMega) {
        const tmpMega = path.join(process.env.TMPDIR || '/tmp', `mega_ytdlp_${Date.now()}`)
        fs.mkdirSync(tmpMega, { recursive: true })

        let megaFileName = null
        let megaSizeH    = null

        let usedYtDlp = false
        try {
          await conn.sendMessage(m.chat, { text: `📥 *Mega:* descargando con yt-dlp...`, edit: key })
          tempPath = await descargarConYtDlp(rawArg, tmpMega)
          megaFileName = path.basename(tempPath)
          megaSizeH    = (fs.statSync(tempPath).size / 1024 / 1024).toFixed(2) + ' MB'
          usedYtDlp = true
        } catch (ytErr) {
          console.log(`[mega] yt-dlp falló (${ytErr.message.slice(0, 60)}), usando megajs...`)
          fs.rmSync(tmpMega, { recursive: true, force: true })
        }

        if (!usedYtDlp) {
          const { File: MegaFile } = await import('megajs')
          let file
          try {
            file = MegaFile.fromURL(rawArg)
            await file.loadAttributes()
          } catch (err) { return m.reply(parseMegaError(err)) }

          megaFileName = file.name
          megaSizeH    = (file.size / 1024 / 1024).toFixed(2) + ' MB'
          await conn.sendMessage(m.chat, { text: `📥 *Mega:* ${megaFileName}\n⚖️ ${megaSizeH}\n\n_Descargando..._`, edit: key })
          tempPath = path.join(process.env.TMPDIR || '/tmp', `mega_${Date.now()}_${megaFileName}`)

          let fileStream
          try { fileStream = file.download({ signal }) }
          catch (err) { return m.reply(parseMegaError(err)) }

          let dld = 0
          fileStream.on('data', (chunk) => {
            dld += chunk.length
            process.stdout.write(`\r[MEGA] ${((dld / file.size) * 100).toFixed(1)}% | ${(dld / 1024 / 1024).toFixed(2)} MB`)
          })
          try {
            await pipeline(fileStream, fs.createWriteStream(tempPath), { signal })
          } catch (err) {
            if (err.name === 'AbortError') throw err
            return m.reply(parseMegaError(err))
          }
        }

        await conn.sendMessage(m.chat, { text: `⬆️ Subiendo a WhatsApp...`, edit: key })
        const { lookup } = await import('mime-types')
        await conn.sendMessage(m.chat, {
          document: { url: tempPath },
          fileName: megaFileName,
          mimetype: lookup(megaFileName) || 'application/octet-stream',
          caption: `✅ *${megaFileName}*\n⚖️ ${megaSizeH}`,
        }, { quoted: m })

      } else {
        let mfData
        try { mfData = await mediafireDl(rawArg) }
        catch (err) { return m.reply(`❌ Error MediaFire: ${err.message}`) }
        if (!mfData.link) return m.reply(`❌ No encontré el enlace de descarga.`)

        const { name, link: downloadUrl } = mfData
        let sizeBytes = 0
        try {
          const head = await axios.head(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, httpsAgent, signal })
          sizeBytes  = parseInt(head.headers['content-length'] || '0')
        } catch (_) {}
        const sizeH = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '?'

        await conn.sendMessage(m.chat, { text: `📥 *MediaFire:* ${name}\n⚖️ ${sizeH}\n\n_Descargando..._`, edit: key })
        tempPath = path.join(process.env.TMPDIR || '/tmp', `mf_${Date.now()}_${name}`)

        const response = await axios({ method: 'get', url: downloadUrl, responseType: 'stream', signal, httpsAgent })
        let dld = 0, mfLastTime = Date.now(), mfLastDld = 0
        response.data.on('data', (chunk) => {
          dld += chunk.length
          const now = Date.now()
          const dt  = (now - mfLastTime) / 1000
          if (dt >= 0.5) {
            const speed = ((dld - mfLastDld) / dt / 1024 / 1024).toFixed(1)
            mfLastTime  = now
            mfLastDld   = dld
            const p     = sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) : '?'
            const dlMB  = (dld / 1024 / 1024).toFixed(1)
            const totMB = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : '?'
            process.stdout.write(`\r[MediaFire] ${p}% | ${dlMB} MB / ${totMB} MB | ${speed} MB/s`)
          }
        })
        await pipeline(response.data, fs.createWriteStream(tempPath), { signal })
        console.log(`\n[MediaFire] ✅ ${name}`)

        await conn.sendMessage(m.chat, { text: `⬆️ Subiendo a WhatsApp...`, edit: key })
        const { lookup } = await import('mime-types')
        await conn.sendMessage(m.chat, {
          document: { url: tempPath },
          fileName: name,
          mimetype: lookup(name) || 'application/octet-stream',
          caption: `✅ *${name}*\n⚖️ ${sizeH}`,
        }, { quoted: m })
      }

      global.activeDownloads.delete(msgId)
    } catch (err) {
      console.error('[animedl] Error:', err)
      if (err.name !== 'AbortError') await m.reply(`❌ Error: ${err.message}`)
      if (msgId) global.activeDownloads.delete(msgId)
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
    return
  }

  const rawArgs = text.trim().split(/\s+/)

  let sitioElegido  = null
  let argsParaAnime = rawArgs

  if (/^\d+$/.test(rawArgs[0]) && rawArgs.length >= 3) {
    const idNum           = parseInt(rawArgs[0])
    const sitioCandidate  = getSitioPorId(idNum)
    if (sitioCandidate && !isNaN(rawArgs[rawArgs.length - 1])) {
      sitioElegido  = sitioCandidate
      argsParaAnime = rawArgs.slice(1)
    }
  }

  let episodeUrl = null

  let nombre = null, episodio = null, temporada = 1

  if (argsParaAnime[0]?.startsWith('http')) {
    episodeUrl   = argsParaAnime[0]
    sitioElegido = getSitioPorDominio(episodeUrl)
    try {
      const pathname = new URL(episodeUrl).pathname.replace(/\/+$/, '')
      const parts    = pathname.split('/').filter(Boolean)
      const lastSeg  = parts[parts.length - 1]

      if (/^\d+$/.test(lastSeg)) {
        // Formato: /slug/8/ (JKanime)
        episodio = parseInt(lastSeg)
        const slugSeg = parts[parts.length - 2] || parts[0]
        nombre = slugSeg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      } else {
        // Formato: /ver/slug-episodio-8 (AnimeFLV, LatAnime, MonosChinos)
        const m = lastSeg.match(/^(.*?)(?:-episodio)?-(\d+)$/)
        if (m) {
          episodio = parseInt(m[2])
          nombre   = m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        } else {
          nombre = lastSeg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        }
      }
    } catch (_) {}
  } else {
    const lastToken = argsParaAnime[argsParaAnime.length - 1]
    episodio  = isNaN(lastToken) ? null : parseInt(lastToken)

    if (episodio === null) {
      let tokensSinEp = [...argsParaAnime]
      temporada   = 1
      const tempIdx2  = tokensSinEp.findIndex(t => /^t(?:emperada|emp)?(\d+)$/i.test(t))
      if (tempIdx2 !== -1) {
        temporada    = parseInt(tokensSinEp[tempIdx2].match(/(\d+)/)[1])
        tokensSinEp  = tokensSinEp.filter((_, i) => i !== tempIdx2)
      }
      const nombreBusq = tokensSinEp.join(' ')
      if (!nombreBusq) return m.reply(`❌ Escribe el nombre del anime.\nEjemplo: *.animedl naruto*`)

      const { key: statusKey } = await m.reply(`🔎 Buscando *${nombreBusq}*...`)
      const editStatus = async (txt) => {
        try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }) } catch (_) {}
      }

      const resultados = await buscarResultadosAnimeFLV(nombreBusq, temporada)

      if (resultados.length === 0) {
        return editStatus(
          `❌ No encontré ningún anime llamado *${nombreBusq}*.\n\n` +
          `Prueba con el sitio + episodio:\n  ${usedPrefix}animedl ${nombreBusq} 1`
        )
      }

      if (resultados.length === 1 || puntuarMatch(resultados[0].title, nombreBusq) >= 85) {
        return mostrarInfoYEpisodios(resultados[0], m, conn, usedPrefix, temporada, statusKey)
      }

      await editStatus(`🔍 *${resultados.length} resultados para "${nombreBusq}"* — elige uno:`)

      const maxR = Math.min(resultados.length, 26)
      global.pendingAnimeSearch.set(m.chat, {
        resultados: resultados.slice(0, maxR),
        nombre    : nombreBusq,
        temporada,
        owner     : m.sender,
        timestamp : Date.now(),
        usedPrefix,
      })

      return enviarListaWA(conn, m, {
        title     : `🔍 Resultados para "${nombreBusq}"`,
        body      : `Encontré ${resultados.length} resultados. Elige el anime correcto:`,
        buttonText: 'ELEGIR ANIME',
        sections  : [{
          title: 'Animes encontrados',
          rows : resultados.slice(0, maxR).map(r => ({
            title      : r.title,
            description: r.sitio?.nombre || 'AnimeFLV',
            id         : `__animeselect__${r.slug}`,
          })),
        }],
      })
    }

    let tokensSinEp = argsParaAnime.slice(0, -1)

    const tempIdx = tokensSinEp.findIndex(t => /^t(?:emperada|emp)?(\d+)$/i.test(t))
    if (tempIdx !== -1) {
      const match = tokensSinEp[tempIdx].match(/(\d+)/)
      temporada   = parseInt(match[1])
      tokensSinEp = tokensSinEp.filter((_, i) => i !== tempIdx)
    }

    nombre = tokensSinEp.join(' ')
    if (!nombre) return m.reply(`❌ Falta el nombre del anime.\nEjemplo: *.animedl one piece t1 1*`)

    const labelTemp  = temporada > 1 ? ` temporada *${temporada}*` : ''
    const labelSitio = sitioElegido ? ` en *${sitioElegido.nombre}*` : ' en todos los sitios'

    await m.reply(`🔎 Buscando *${nombre}*${labelTemp} ep *${episodio}*${labelSitio}...`)

    if (sitioElegido) {
      episodeUrl = await sitioElegido.buscar(nombre, episodio, temporada)
      if (!episodeUrl) {
        const tSuffix = temporada > 1 ? ` t${temporada}` : ''
        return m.reply(
          `❌ No encontré *${nombre}* ep *${episodio}*${temporada > 1 ? ` (temporada ${temporada})` : ''} en *${sitioElegido.nombre}*.\n\n` +
          `Prueba con otro sitio:\n` +
          SITIOS.filter(s => s.id !== sitioElegido.id)
                .map(s => `  .animedl ${s.id} ${nombre}${tSuffix} ${episodio}`)
                .join('\n')
        )
      }
    } else {
      for (const sitio of SITIOS) {
        try {
          episodeUrl = await sitio.buscar(nombre, episodio, temporada)
          if (episodeUrl) {
            sitioElegido = sitio
            await m.reply(`✅ Encontrado en *${sitio.nombre}*`)
            break
          }
        } catch (err) { console.error(`[busqueda] ${sitio.nombre}:`, err.message) }
      }
      if (!episodeUrl) {
        return m.reply(
          `❌ No encontré *${nombre}* ep *${episodio}*${temporada > 1 ? ` (temporada ${temporada})` : ''} en ningún sitio.\n` +
          `Prueba con la URL directa del episodio.`
        )
      }
    }
  }

  await m.reply(
    `📡 Extrayendo servidores de *${sitioElegido?.nombre || 'sitio desconocido'}*...\n` +
    `🔗 ${episodeUrl}`
  )

  let servidores = []
  try {
    servidores = sitioElegido?.scrape
      ? await sitioElegido.scrape(episodeUrl)
      : [{ nombre: 'directo', url: episodeUrl, directo: true }]
  } catch (err) {
    return m.reply(`❌ Error al analizar la página:\n\`${err.message}\``)
  }

  if (servidores.length === 0) {
    return m.reply('❌ No encontré servidores de video en esa página.')
  }

  const esMegaMf  = s => /mega\.nz|mega\.co\.nz|mediafire\.com/.test(s.url)
  const megaYMf   = servidores.filter(s =>  esMegaMf(s))
  const sinMegaMf = servidores.filter(s => !esMegaMf(s))

  const conocidosSinMegaMf = sinMegaMf.filter(s => esServidorConocido(s.nombre, s.url))
  const baseParaIntentos   = conocidosSinMegaMf.length > 0 ? conocidosSinMegaMf : sinMegaMf

  const directas  = baseParaIntentos.filter(s => s.directo && CONFIG.videoExtensions.test(s.url))
  const listaIntentos = [
    ...megaYMf,
    ...(directas.length > 0
      ? [...directas, ...baseParaIntentos.filter(s => !s.directo)]
      : baseParaIntentos),
  ]

  const tmpDir = path.join(process.env.TMPDIR || '/tmp', `anime_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const servidorEmojis = { mega: '📦', mediafire: '📦', mp4upload: '📹', filemoon: '🌙',
    streamwish: '⭐', streamtape: '📼', doodstream: '🟣', voe: '🟠', upstream: '🔵',
    okru: '🔴', vidhide: '🟡', mixdrop: '🔵', generico: '🎬',
    savefiles: '💾', gofile: '💾', byse: '⭐', dsvplay: '▶️', lulu: '⭐' }
  const emoji = (nombre) => {
    const n = nombre?.toLowerCase() || ''
    return Object.entries(servidorEmojis).find(([k]) => n.includes(k))?.[1] || '🎬'
  }

  const sessionKey = `${m.chat}|${m.sender}`
  global.pendingServerPicks.set(m.chat, {
    servers     : listaIntentos,
    tmpDir,
    sitioElegido,
    argsParaAnime,
    nombre      : nombre ?? null,
    episodio    : episodio ?? null,
    temporada   : temporada ?? 1,
    timestamp   : Date.now(),
    owner       : m.sender,
  })
  global.animeDlSessions[sessionKey] = {
    owner : m.sender,
    chat  : m.chat,
    expiry: Date.now() + 10 * 60 * 1000,
  }
  guardarPicks()

  const device   = getDevice(m.key.id)
  const isMobile = device !== 'desktop' && device !== 'web'

  if (isMobile) {
    try {
      const filas = listaIntentos.map((s, i) => ({
        header     : `${emoji(s.nombre)} ${s.nombre.toUpperCase()}`,
        title      : `${emoji(s.nombre)} ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`,
        description: s.directo ? 'Link directo — más rápido' : 'Servidor de streaming',
        id         : `${usedPrefix}dl ${i + 1}`,
      }))

      const interactiveMessage = {
        body  : { text: `✅ = link directo (más rápido)\nElige el servidor para descargar.` },
        footer: { text: global.wm || 'Kana Arima Bot' },
        header: { title: `🎬 ${sitioElegido?.nombre || 'Anime'} — ${listaIntentos.length} servidores`, hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title   : 'ELEGIR SERVIDOR',
              sections: [{
                title          : 'Servidores disponibles',
                highlight_label: '',
                rows           : filas,
              }],
            }),
          }],
          messageParamsJson: '',
        },
      }

      const msg = generateWAMessageFromContent(
        m.chat,
        { viewOnceMessage: { message: { interactiveMessage } } },
        { userJid: conn.user.jid, quoted: m }
      )
      await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id })
    } catch (err) {
      console.error('[animedl interactiveMsg]', err.message)
      const listaTxt = listaIntentos
        .map((s, i) => `${emoji(s.nombre)} *${numToLetter(i)}.* ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`)
        .join('\n')
      await m.reply(
        `🎬 *${sitioElegido?.nombre || 'Anime'} — Servidores (${listaIntentos.length}):*\n\n` +
        `${listaTxt}\n\n✅ = directo\n_Responde con_ *.dl <letra>* (ej: *.dl a*)`
      )
    }
  } else {
    const listaTxt = listaIntentos
      .map((s, i) => `${emoji(s.nombre)} *${numToLetter(i)}.* ${s.nombre.toUpperCase()}${s.directo ? ' ✅' : ''}`)
      .join('\n')
    await m.reply(
      `🎬 *${sitioElegido?.nombre || 'Anime'} — Servidores (${listaIntentos.length}):*\n\n` +
      `${listaTxt}\n\n✅ = directo\n_Responde con_ *.dl <letra>* (ej: *.dl a*)`
    )
  }
}

handler.before = async function (m, { conn }) {
  const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (nativeFlow) {
    try {
      const params     = JSON.parse(nativeFlow.paramsJson || '{}')
      const selectedId = params?.id || null
      if (!selectedId) return false

      if (selectedId.startsWith('__animeselect__')) {
        const slug        = selectedId.replace('__animeselect__', '')
        const animeSearch = global.pendingAnimeSearch.get(m.chat)
        if (!animeSearch) return false

        if (animeSearch.owner && animeSearch.owner !== m.sender) {
          await conn.sendMessage(m.chat,
            { text: `⛔ @${m.sender.split('@')[0]}, estos botones son de otro usuario.` },
            { quoted: m, mentions: [m.sender] }
          )
          return true
        }

        global.pendingAnimeSearch.delete(m.chat)
        const elegido = animeSearch.resultados.find(r => r.slug === slug)
        if (!elegido) return false

        await mostrarInfoYEpisodios(elegido, m, conn, animeSearch.usedPrefix || '.', animeSearch.temporada)
        return true
      }

      const pick = global.pendingServerPicks.get(m.chat)
      if (!pick) return false

      if (pick.owner && pick.owner !== m.sender) {
        await conn.sendMessage(m.chat,
          { text: `⛔ @${m.sender.split('@')[0]}, estos botones son de otro usuario.` },
          { quoted: m, mentions: [m.sender] }
        )
        return true
      }

      const sk = `${m.chat}|${m.sender}`
      delete global.animeDlSessions[sk]

      const usedPrefix = selectedId.trim()[0]
      const [command, ...argParts] = selectedId.trim().slice(1).split(' ')
      const text = argParts.join(' ')
      try {
        await handler.call(conn, m, { conn, text, usedPrefix, command })
      } catch (e) {
        console.error('[animeDL before] Error ejecutando handler:', e.message)
      }
      return true
    } catch (_) {}
    return false
  }
  return false
}

handler.help    = ['animedl <nombre> [tN] <ep>', 'animedl <S> <nombre> [tN] <ep>', 'anilist']
handler.tags    = ['descargas']
handler.command = /^(animedl|dl|anilist|cancelar|stop)$/i

cargarPicks()

export default handler
