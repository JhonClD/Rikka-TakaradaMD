import { generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import fs from 'fs'
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
  httpsAgent,
  numToLetter,
  buscarResultadosTodosSitios,
  mostrarInfoYEpisodios,
  parseMegaError,
  descargarConYtDlp,
  ejecutarDescargaServidor,
} from '../src/libraries/anime-dl.js'

const handler = async (m, { conn, text, args, usedPrefix, command }) => {

  if (command === 'anilist') {
    const lista = SITIOS.map(s => `*${s.id}.* ${s.nombre}\n   🔗 ${s.url}`).join('\n\n')
    return m.reply(`*🎌 Sitios Disponibles*\n\n${lista}`)
  }

  if (command === 'cancelar' || command === 'stop') {
    const quotedMsgId = m.quoted?.id
    if (!quotedMsgId) return m.reply(`❌ Responde al mensaje de la descarga.`)
    const dl = global.activeDownloads.get(quotedMsgId)
    if (!dl) return m.reply(`❌ No hay descarga activa.`)
    dl.controller.abort()
    global.activeDownloads.delete(quotedMsgId)
    return m.reply(`🚫 Cancelado.`)
  }

  const letraInput = text?.trim().toLowerCase()
  if (/^[a-z]$/.test(letraInput)) {
    const animeSearch = global.pendingAnimeSearch.get(m.chat)
    if (animeSearch && (!animeSearch.owner || animeSearch.owner === m.sender)) {
      if (animeSearch.tipo === 'multisite') {
        const idxSearch = letraInput.charCodeAt(0) - 97
        const allItems = []
        for (const [sitioId, resultados] of Object.entries(animeSearch.sitiosData)) {
          if (sitioId == 1) { // AnimeFLV
            resultados.slice(0, 5).forEach(r => allItems.push({ sitioId: 1, data: r, tipo: 'animeflv' }))
          } else {
            allItems.push({ sitioId: Number(sitioId), data: resultados[0], tipo: 'sitio' })
          }
        }
        const elegido = allItems[idxSearch]
        if (elegido) {
          global.pendingAnimeSearch.delete(m.chat)
          if (elegido.tipo === 'animeflv') return mostrarInfoYEpisodios(elegido.data, m, conn, usedPrefix, animeSearch.temporada)
          const sitio = SITIOS.find(s => s.id === elegido.sitioId)
          return m.reply(`✅ *${animeSearch.nombreBusq}* en *${sitio?.nombre}*\nUsa: *.animedl ${sitio?.id} ${animeSearch.nombreBusq} 1*`)
        }
      }
    }
  }

  if ((command === 'animedl' || command === 'dl') && /^(\d+|[a-z])$/i.test(text?.trim())) {
    const pick = global.pendingServerPicks.get(m.chat)
    if (pick && (!pick.owner || pick.owner === m.sender)) {
      const raw = text.trim().toLowerCase()
      const num = /^[a-z]$/.test(raw) ? raw.charCodeAt(0) - 96 : parseInt(raw)
      if (num >= 1 && num <= pick.servers.length) {
        global.pendingServerPicks.delete(m.chat)
        return ejecutarDescargaServidor(pick.servers, num - 1, pick, m, conn)
      }
    }
  }

  if (!text || !text.trim()) return m.reply(`*🎌 Anime Downloader*\nUso: *.animedl <nombre> <ep>*`)

  const isMega = /mega\.nz/.test(args[0])
  const isMediaFire = /mediafire\.com/.test(args[0])

  if (isMega || isMediaFire) {
    const { default: axios } = await import('axios')
    const controller = new AbortController()
    let tempPath, msgId
    try {
      const { key } = await m.reply(`⏳ Preparando...`)
      msgId = key.id
      global.activeDownloads.set(msgId, { controller })
      if (isMega) {
        tempPath = await descargarConYtDlp(args[0], '/tmp')
      } else {
        const mf = await mediafireDl(args[0])
        tempPath = path.join('/tmp', mf.name)
        const res = await axios({ method: 'get', url: mf.link, responseType: 'stream', httpsAgent })
        await pipeline(res.data, fs.createWriteStream(tempPath))
      }
      await conn.sendMessage(m.chat, { document: { url: tempPath }, fileName: path.basename(tempPath), mimetype: mimeLookup(tempPath) || 'application/octet-stream' }, { quoted: m })
    } catch (e) { m.reply(`❌ Error: ${e.message}`) }
    finally { if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath) }
    return
  }

  const lastToken = args[args.length - 1]
  const episodio = isNaN(lastToken) ? null : parseInt(lastToken)

  if (episodio === null) {
    let tokens = [...args]
    let temporada = 1
    const tIdx = tokens.findIndex(t => /^t(\d+)$/i.test(t))
    if (tIdx !== -1) {
      temporada = parseInt(tokens[tIdx].match(/(\d+)/)[1])
      tokens.splice(tIdx, 1)
    }
    const nombreBusq = tokens.join(' ')
    const resultadosPorSitio = await buscarResultadosTodosSitios(nombreBusq, temporada)
    if (resultadosPorSitio.size === 0) return m.reply(`❌ Sin resultados.`)

    const cards = []
    const sitiosEncontrados = [...resultadosPorSitio.entries()]

    for (const [sitioId, resultados] of sitiosEncontrados) {
      const sitio = SITIOS.find(s => s.id === sitioId)
      resultados.slice(0, 3).forEach(r => {
        cards.push({
          header: {
            title: r.title || nombreBusq,
            hasMediaAttachment: true,
            ...(r.image ? { imageMessage: { url: r.image } } : { imageMessage: { url: 'https://placehold.jp/600x400.png' } })
          },
          body: { text: `Sitio: ${sitio.nombre}\nTemp: ${temporada}` },
          nativeFlowMessage: {
            buttons: [{
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: 'SELECCIONAR',
                id: `__siteselect__${sitioId}__${r.slug || r.url}`
              })
            }]
          }
        })
      })
    }

    global.pendingAnimeSearch.set(m.chat, { tipo: 'multisite', nombreBusq, temporada, owner: m.sender, sitiosData: Object.fromEntries(sitiosEncontrados) })

    const msg = generateWAMessageFromContent(m.chat, {
      viewOnceMessageV2: {
        message: {
          interactiveMessage: {
            body: { text: `Resultados para: ${nombreBusq}` },
            carouselMessage: { cards }
          }
        }
      }
    }, { userJid: conn.user.jid, quoted: m })
    
    return await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id })
  }

  // Lógica de búsqueda directa con episodio
  let temporada = 1
  let tokens = args.slice(0, -1)
  const tIdx = tokens.findIndex(t => /^t(\d+)$/i.test(t))
  if (tIdx !== -1) {
    temporada = parseInt(tokens[tIdx].match(/(\d+)/)[1])
    tokens.splice(tIdx, 1)
  }
  const nombre = tokens.join(' ')
  let episodeUrl, sitioElegido
  for (const sitio of SITIOS) {
    episodeUrl = await sitio.buscar(nombre, episodio, temporada)
    if (episodeUrl) { sitioElegido = sitio; break }
  }
  if (!episodeUrl) return m.reply(`❌ No encontrado.`)

  const servidores = await sitioElegido.scrape(episodeUrl)
  const pickCards = servidores.map((s, i) => ({
    header: { title: s.nombre.toUpperCase(), hasMediaAttachment: false },
    body: { text: s.directo ? 'Enlace Directo ✅' : 'Streaming' },
    nativeFlowMessage: {
      buttons: [{
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: 'DESCARGAR', id: `${usedPrefix}dl ${i + 1}` })
      }]
    }
  }))

  global.pendingServerPicks.set(m.chat, { servers: servidores, sitioElegido, owner: m.sender })

  const msgSrv = generateWAMessageFromContent(m.chat, {
    viewOnceMessageV2: {
      message: {
        interactiveMessage: {
          body: { text: `Servidores para Ep. ${episodio}` },
          carouselMessage: { cards: pickCards }
        }
      }
    }
  }, { userJid: conn.user.jid, quoted: m })

  await conn.relayMessage(m.chat, msgSrv.message, { messageId: msgSrv.key.id })
}

handler.before = async function (m, { conn }) {
  const response = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (!response) return false
  const { id: selectedId } = JSON.parse(response.paramsJson || '{}')
  if (!selectedId) return false

  if (selectedId.startsWith('__siteselect__')) {
    const search = global.pendingAnimeSearch.get(m.chat)
    if (!search || (search.owner && search.owner !== m.sender)) return true
    const [_, sId, slug] = selectedId.split('__')
    const res = search.sitiosData[sId].find(r => (r.slug || r.url) === slug)
    global.pendingAnimeSearch.delete(m.chat)
    if (sId == 1) await mostrarInfoYEpisodios(res, m, conn, '.', search.temporada)
    else m.reply(`Usa: *.animedl ${sId} ${search.nombreBusq} 1*`)
    return true
  }

  if (selectedId.startsWith('.')) {
    const [cmd, ...args] = selectedId.slice(1).split(' ')
    await handler(m, { conn, text: args.join(' '), args, usedPrefix: '.', command: cmd })
    return true
  }
}

handler.command = /^(animedl|dl|anilist|cancelar|stop)$/i
export default handler
                                 
