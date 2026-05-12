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
  numToLetter,
  buscarResultadosTodosSitios,
  mostrarInfoYEpisodios,
  mostrarPortadaSitioExterno,
  parseMegaError,
  descargarConYtDlp,
  ejecutarDescargaServidor,
} from '../src/libraries/anime-dl.js'

// --- FUNCIONES DE UTILIDAD PARA LA BARRA ---
const crearBarra = (p) => {
  const total = 16
  const lleno = Math.floor((p / 100) * total)
  return `[${'█'.repeat(lleno)}${'░'.repeat(total - lleno)}]`
}

const formatSize = (bytes) => {
  if (bytes === 0) return '0.00 B'
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + ['B', 'KB', 'MB', 'GB'][i]
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {

  if (command === 'anilist') {
    const lista = SITIOS.map(s => `*${s.id}.* ${s.nombre}\n   🔗 ${s.url}`).join('\n\n')
    return m.reply(`*🎌 Sitios de Anime Disponibles*\n\n${lista}`)
  }

  // --- LÓGICA DE DESCARGA DIRECTA (MEGA / MEDIAFIRE) ---
  const rawArg = (args?.[0] || text?.trim() || '')
  const isMega = /mega\.nz/.test(rawArg)
  const isMediaFire = /mediafire\.com/.test(rawArg)

  if (isMega || isMediaFire) {
    const { default: axios } = await import('axios')
    const controller = new AbortController()
    const { signal } = controller
    let tempPath, msgId, fileName, totalSize

    try {
      const { key } = await m.reply(`⏳ *Preparando enlace...*`)
      msgId = key.id

      let downloadUrl = rawArg
      if (isMega) {
        const { File: MegaFile } = await import('megajs')
        let file = MegaFile.fromURL(rawArg)
        await file.loadAttributes()
        fileName = file.name
        totalSize = file.size
        const fileStream = file.download({ signal })
        tempPath = path.join(process.env.TMPDIR || '/tmp', `mega_${Date.now()}_${fileName}`)
        
        let dld = 0
        let lastUpdate = 0
        let startTime = Date.now()

        fileStream.on('data', async (chunk) => {
          dld += chunk.length
          const now = Date.now()
          if (now - lastUpdate > 1500) { 
            lastUpdate = now
            const p = ((dld / totalSize) * 100).toFixed(1)
            const speed = (dld / ((now - startTime) / 1000) / 1024 / 1024).toFixed(2)
            const txt = `📥 *Mega:* ${fileName}\n\`${crearBarra(p)} ${p}%\`\n📦 ${formatSize(dld)} / ${formatSize(totalSize)}\n⚡ ${speed} MB/s`
            await conn.sendMessage(m.chat, { text: txt, edit: key })
          }
        })
        await pipeline(fileStream, fs.createWriteStream(tempPath), { signal })
      } else {
        const mf = await mediafireDl(rawArg)
        fileName = mf.name
        downloadUrl = mf.link
        tempPath = path.join(process.env.TMPDIR || '/tmp', `mf_${Date.now()}_${fileName}`)
        const res = await axios({ method: 'get', url: downloadUrl, responseType: 'stream', signal, httpsAgent })
        totalSize = parseInt(res.headers['content-length'] || 0)
        let dld = 0, lastUpdate = 0, startTime = Date.now()

        res.data.on('data', async (chunk) => {
          dld += chunk.length
          const now = Date.now()
          if (now - lastUpdate > 1500) {
            lastUpdate = now
            const p = totalSize ? ((dld / totalSize) * 100).toFixed(1) : '0.0'
            const speed = (dld / ((now - startTime) / 1000) / 1024 / 1024).toFixed(2)
            const txt = `📥 *MediaFire:* ${fileName}\n\`${crearBarra(p)} ${p}%\`\n📦 ${formatSize(dld)} / ${formatSize(totalSize)}\n⚡ ${speed} MB/s`
            await conn.sendMessage(m.chat, { text: txt, edit: key })
          }
        })
        await pipeline(res.data, fs.createWriteStream(tempPath), { signal })
      }

      // --- INTERFAZ DE SUBIDA A WHATSAPP ---
      const stats = fs.statSync(tempPath)
      await conn.sendMessage(m.chat, { 
        text: `📤 *Subiendo a WhatsApp*\n\`${crearBarra(0)} 0.0%\`\n📦 0 B / ${formatSize(stats.size)}`, 
        edit: key 
      })

      await conn.sendMessage(m.chat, {
        document: { url: tempPath },
        fileName: fileName,
        mimetype: mimeLookup(fileName) || 'application/octet-stream',
        caption: `✅ *${fileName}*`
      }, { quoted: m })

      await conn.sendMessage(m.chat, { delete: key })
    } catch (err) {
      await m.reply(`❌ Error: ${err.message}`)
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
    return
  }

  // --- LÓGICA DE BÚSQUEDA DE ANIME ---
  const rawArgs = text.trim().split(/\s+/)
  if (rawArgs.length < 1) return

  // React con lupa para indicar que está buscando sin llenar el chat de texto
  await conn.sendMessage(m.chat, { react: { text: '🔍', key: m.key } })

  let sitioElegido = null
  let argsParaAnime = rawArgs
  let episodeUrl = null

  const lastToken = argsParaAnime[argsParaAnime.length - 1]
  const episodio = isNaN(lastToken) ? null : parseInt(lastToken)

  if (episodio === null) {
    // Si no hay episodio, busca el anime para mostrar portada y selector (Como en tu imagen)
    const nombreBusq = argsParaAnime.join(' ')
    const resultados = await buscarResultadosTodosSitios(nombreBusq, 1)
    
    if (resultados.size === 0) return m.reply(`❌ No encontrado.`)
    
    // Si hay resultados, se delega a la librería para mostrar la interfaz unificada
    const [sitioId, data] = [...resultados.entries()][0]
    const sitio = SITIOS.find(s => s.id === sitioId)
    
    if (sitio.dominio === 'animeflv') {
      return mostrarInfoYEpisodios(data[0], m, conn, usedPrefix, 1)
    } else {
      return mostrarPortadaSitioExterno({ nombreBusq, owner: m.sender }, sitio, m, conn, usedPrefix)
    }
  }

  // Si hay episodio, busca directamente el servidor
  const nombre = argsParaAnime.slice(0, -1).join(' ')
  for (const sitio of SITIOS) {
    try {
      episodeUrl = await sitio.buscar(nombre, episodio, 1)
      if (episodeUrl) { sitioElegido = sitio; break; }
    } catch {}
  }

  if (!episodeUrl) return m.reply(`❌ Ep ${episodio} no encontrado.`)

  let servidores = await sitioElegido.scrape(episodeUrl)
  if (servidores.length === 0) return m.reply('❌ Sin servidores.')

  // Ordenar para priorizar Mega/MediaFire
  const esMegaMf = s => /mega\.nz|mediafire\.com/.test(s.url)
  const listaIntentos = [ ...servidores.filter(esMegaMf), ...servidores.filter(s => !esMegaMf(s)) ]

  // Iniciar descarga automática con el primer servidor disponible
  return ejecutarDescargaServidor(listaIntentos, 0, { servers: listaIntentos, owner: m.sender }, m, conn)
}

handler.help = ['animedl']
handler.tags = ['descargas']
handler.command = /^(animedl|dl|anilist|cancelar|stop)$/i

export default handler
                                  
