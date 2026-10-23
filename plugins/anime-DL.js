import { getDevice } from '@this-xys/baileys'
import fs from 'fs'
import path from 'path'

import {
  SITIOS,
  getSitioPorId,
  getSitioPorDominio,
  guardarPicks,
  cargarPicks,
  CONFIG,
  numToLetter,
  ejecutarDescargaServidor,
  esServidorConocido,
  mostrarInfoYEpisodios,
} from '../src/libraries/anime-dl.js'

const SEARCH_TIMEOUT = 12_000
const MAX_RANGE = 12

const sitioFlags = new Set(['-s'])
const temporadaRe = /^(?:t|temp|temporada)(\d+)$/i

export function parseArgs(input = '') {
  const tokens = Array.isArray(input) ? input.slice() : String(input).trim().split(/\s+/).filter(Boolean)
  const result = {
    sitioId: null,
    sitio: null,
    forceServers: false,
    temporada: 1,
    episodio: null,
    hasta: null,
    nombre: '',
    url: null,
    tokens: [],
  }

  const remaining = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (sitioFlags.has(token.toLowerCase())) {
      const value = tokens[i + 1]
      if (value && /^\d+$/.test(value)) {
        result.sitioId = Number(value)
        result.sitio = getSitioPorId(result.sitioId)
        i++
        continue
      }
      remaining.push(token)
      continue
    }
    if (token.toLowerCase() === '--srv') {
      result.forceServers = true
      continue
    }
    const temp = token.match(temporadaRe)
    if (temp) {
      result.temporada = Number(temp[1])
      continue
    }
    remaining.push(token)
  }

  let episodeIndex = -1
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (/^\d+(?:-\d+)?$/.test(remaining[i])) {
      episodeIndex = i
      break
    }
  }
  if (episodeIndex !== -1) {
    const match = remaining[episodeIndex].match(/^(\d+)(?:-(\d+))?$/)
    result.episodio = Number(match[1])
    result.hasta = match[2] ? Number(match[2]) : result.episodio
    remaining.splice(episodeIndex, 1)
  }

  // Compatibilidad con la forma antigua: .animedl <sitio> <nombre> <ep>.
  // Solo se interpreta como sitio si el número existe y queda al menos un token de nombre.
  if (result.sitioId == null && remaining.length >= 2 && /^\d+$/.test(remaining[0])) {
    const legacySite = getSitioPorId(remaining[0])
    if (legacySite) {
      result.sitioId = Number(remaining[0])
      result.sitio = legacySite
      remaining.shift()
    }
  }

  if (remaining[0] && /^https?:\/\//i.test(remaining[0])) {
    result.url = remaining[0]
    result.nombre = remaining.slice(1).join(' ')
  } else {
    result.nombre = remaining.join(' ').trim()
  }
  result.tokens = remaining
  return result
}

function clavePick(m) {
  return `${m.chat}|${m.sender}`
}

function dispositivoMovil(m) {
  const device = getDevice(m.key.id)
  return { device, isMobile: device !== 'desktop' && device !== 'web' }
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function buscarConTimeout(sitio, nombre, episodio, temporada) {
  let timer
  try {
    return await Promise.race([
      sitio.buscar(nombre, episodio, temporada),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout de ${SEARCH_TIMEOUT / 1000}s`)), SEARCH_TIMEOUT)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function buscarAnime(nombre, episodio, temporada, sitioElegido) {
  if (sitioElegido) {
    try {
      return { sitio: sitioElegido, url: await buscarConTimeout(sitioElegido, nombre, episodio, temporada) }
    } catch (error) {
      console.error(`[busqueda] ${sitioElegido.nombre}:`, error.message)
      return { sitio: sitioElegido, url: null, error }
    }
  }

  const resultados = await Promise.allSettled(
    SITIOS.map(sitio => buscarConTimeout(sitio, nombre, episodio, temporada))
  )
  for (let i = 0; i < resultados.length; i++) {
    const item = resultados[i]
    if (item.status === 'fulfilled' && item.value) {
      return { sitio: SITIOS[i], url: item.value }
    }
    if (item.status === 'rejected') {
      console.error(`[busqueda] ${SITIOS[i].nombre}:`, item.reason?.message || item.reason)
    }
  }
  return { sitio: null, url: null }
}

function ordenarServidores(servidores) {
  const esMegaMf = s => /mega\.nz|mega\.co\.nz|mediafire\.com/i.test(s.url || '')
  const megaYMf = servidores.filter(esMegaMf)
  const sinMegaMf = servidores.filter(s => !esMegaMf(s))
  const conocidos = sinMegaMf.filter(s => esServidorConocido(s.nombre, s.url))
  const base = conocidos.length > 0 ? conocidos : sinMegaMf
  const directas = base.filter(s => s.directo && CONFIG.videoExtensions.test(s.url))
  return [
    ...megaYMf,
    ...(directas.length > 0 ? [...directas, ...base.filter(s => !s.directo)] : base),
  ]
}

const servidorEmojis = {
  mega: '📦', mediafire: '📦', mp4upload: '📹', filemoon: '🌙', streamwish: '⭐',
  streamtape: '📼', doodstream: '🟣', filelions: '🟣', voe: '🟠', upstream: '🔵',
  okru: '🔴', vidhide: '🟡', mixdrop: '🔵', savefiles: '💾', gofile: '💾',
}

function emojiServidor(nombre) {
  const key = String(nombre || '').toLowerCase()
  for (const [name, emoji] of Object.entries(servidorEmojis)) {
    if (key.includes(name)) return emoji
  }
  return '🎬'
}

async function enviarSelector(m, conn, servidores, pick, usedPrefix, sitioNombre) {
  const { isMobile } = dispositivoMovil(m)
  const filas = servidores.map((s, i) => ({
    header: `${emojiServidor(s.nombre)} ${String(s.nombre || 'servidor').toUpperCase()}`,
    title: `${emojiServidor(s.nombre)} ${String(s.nombre || 'servidor').toUpperCase()}${s.directo ? ' ✅' : ''}`,
    description: s.directo ? 'Link directo' : 'Servidor de streaming',
    id: `${usedPrefix}dl ${i + 1}`,
  }))

  if (isMobile) {
    try {
      await conn.sendMessage(m.chat, {
        text: 'Elige el servidor para descargar',
        footer: global.wm || 'Rikka-TakaradaMD',
        nativeFlow: [{
          text: 'Elegir servidor',
          icon: 'default',
          sections: [{ title: `${sitioNombre || 'Anime'} · ${servidores.length} servidores`, rows: filas }],
        }],
      }, { quoted: m })
      return true
    } catch (error) {
      console.error('[animedl nativeFlow]', error.message)
    }
  }

  const lista = servidores.map((s, i) =>
    `${emojiServidor(s.nombre)} *${numToLetter(i)}.* ${String(s.nombre || 'servidor').toUpperCase()}${s.directo ? ' ✅' : ''}`
  ).join('\n')
  await m.reply(
    `🎬 *${sitioNombre || 'Anime'} · Servidores (${servidores.length})*\n\n${lista}\n\n` +
    `Responde con *.dl <letra>* o *.dl <número>*`
  )
  return false
}

async function enviarBotonesFinales(m, conn, pick) {
  const { isMobile } = dispositivoMovil(m)
  if (!isMobile || !pick.nombre || pick.episodio == null) return
  const sitio = pick.sitioId ? ` -s ${pick.sitioId}` : ''
  try {
    await conn.sendMessage(m.chat, {
      text: 'Descarga terminada',
      footer: global.wm || 'Rikka-TakaradaMD',
      nativeFlow: [
        {
          text: 'Siguiente episodio',
          id: `.animedl${sitio} ${pick.nombre} t${pick.temporada} ${Number(pick.episodio) + 1}`,
          icon: 'default',
        },
        {
          text: 'Otro servidor',
          id: `.animedl${sitio} ${pick.nombre} t${pick.temporada} ${pick.episodio} --srv`,
          icon: 'default',
        },
      ],
    }, { quoted: m })
  } catch (error) {
    console.error('[animedl botones]', error.message)
  }
}

async function procesarEpisodio({ m, conn, usedPrefix, nombre, episodio, temporada, sitioElegido, forceServers, directEpisodeUrl = null }) {
  const encontrado = directEpisodeUrl
    ? { sitio: sitioElegido, url: directEpisodeUrl }
    : await buscarAnime(nombre, episodio, temporada, sitioElegido)
  const episodeUrl = encontrado.url
  sitioElegido = encontrado.sitio || sitioElegido

  if (!episodeUrl) {
    if (sitioElegido && typeof sitioElegido.mostrarInfoYEpisodios === 'function') {
      return sitioElegido.mostrarInfoYEpisodios({ url: sitioElegido.url, slug: nombre, title: nombre }, m, conn, usedPrefix, temporada)
    }
    const suffix = temporada > 1 ? ` t${temporada}` : ''
    const sitios = sitioElegido
      ? `\nPrueba otro sitio con: ${usedPrefix}animedl -s <id> ${nombre}${suffix} ${episodio}`
      : '\nPrueba con la URL directa del episodio.'
    throw new Error(`No encontré *${nombre}* ep *${episodio}*${temporada > 1 ? ` (temporada ${temporada})` : ''}.${sitios}`)
  }

  await m.reply(`📡 Extrayendo servidores de *${sitioElegido?.nombre || 'sitio desconocido'}*...`)
  let servidores
  try {
    servidores = sitioElegido?.scrape
      ? await sitioElegido.scrape(episodeUrl)
      : [{ nombre: 'directo', url: episodeUrl, directo: true }]
  } catch (error) {
    throw new Error(`Error al analizar la página: ${error.message}`)
  }
  if (!servidores || servidores.length === 0) throw new Error('No encontré servidores de video en esa página')

  const listaIntentos = ordenarServidores(servidores)
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', `anime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const pick = {
    servers: listaIntentos,
    tmpDir,
    controller: new AbortController(),
    sitioElegido,
    sitioId: sitioElegido?.id || null,
    argsParaAnime: [nombre, String(episodio)],
    nombre,
    episodio,
    temporada,
    timestamp: Date.now(),
  }
  const key = clavePick(m)
  global.pendingServerPicks.set(key, pick)
  global.animeDlSessions[key] = { owner: m.sender, chat: m.chat, expiry: Date.now() + 10 * 60 * 1000 }
  guardarPicks()

  if (forceServers) {
    await enviarSelector(m, conn, listaIntentos, pick, usedPrefix, sitioElegido?.nombre)
    return { waiting: true, pick }
  }

  global.pendingServerPicks.delete(key)
  delete global.animeDlSessions[key]
  guardarPicks()
  const descargado = await ejecutarDescargaServidor(listaIntentos, 0, pick, m, conn)
  if (!descargado) {
    pick.tmpDir = path.join(process.env.TMPDIR || '/tmp', `anime_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(pick.tmpDir, { recursive: true })
    global.pendingServerPicks.set(key, pick)
    global.animeDlSessions[key] = { owner: m.sender, chat: m.chat, expiry: Date.now() + 10 * 60 * 1000 }
    guardarPicks()
    await enviarSelector(m, conn, listaIntentos, pick, usedPrefix, sitioElegido?.nombre)
    return { waiting: true, pick }
  }
  await enviarBotonesFinales(m, conn, pick)
  return { waiting: false, pick }
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (command === 'anilist') {
    const lista = SITIOS.map(s => `*${s.id}.* ${s.nombre}\n   ${s.url}`).join('\n\n')
    return m.reply(
      `*Sitios de Anime Disponibles*\n\n${lista}\n\n` +
      `*Uso*\n` +
      `· ${usedPrefix}animedl <nombre> <episodio>\n` +
      `· ${usedPrefix}animedl <nombre> t<N> <episodio>\n` +
      `· ${usedPrefix}animedl -s <id> <nombre> <episodio>\n` +
      `· ${usedPrefix}animedl <nombre> <inicio>-<fin>\n` +
      `· Añade --srv para elegir servidor\n\n` +
      `Ejemplo: ${usedPrefix}animedl naruto t2 1-5`
    )
  }

  if (command === 'cancelar' || command === 'stop') {
    const quotedMsgId = m.quoted?.id
    if (!quotedMsgId) return m.reply('Responde al mensaje de progreso de la descarga')
    const dl = global.activeDownloads.get(quotedMsgId)
    if (!dl) return m.reply('No hay descarga activa para ese mensaje')
    dl.controller.abort()
    global.activeDownloads.delete(quotedMsgId)
    return m.reply('Descarga cancelada')
  }

  if (!text || !text.trim()) {
    return m.reply(
      `*Descargador de Anime*\n\n` +
      `${usedPrefix}animedl <nombre> <episodio>\n` +
      `${usedPrefix}animedl <nombre> t<N> <episodio>\n` +
      `${usedPrefix}animedl -s <id> <nombre> <episodio>\n` +
      `${usedPrefix}animedl <nombre> <inicio>-<fin>\n` +
      `${usedPrefix}animedl <url>\n` +
      `${usedPrefix}animedl <url de Mega o MediaFire>\n\n` +
      `Añade --srv para elegir servidor. Usa ${usedPrefix}anilist para ver los sitios.`
    )
  }

  const parsed = parseArgs(text)
  const directUrl = parsed.url
  const isMega = /mega\.nz|mega\.co\.nz/i.test(directUrl || '')
  const isMediaFire = /mediafire\.com/i.test(directUrl || '')

  if (isMega || isMediaFire) {
    const sitio = isMega ? 'mega' : 'mediafire'
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', `anime_direct_${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const pick = {
      servers: [{ nombre: sitio, url: directUrl }],
      tmpDir,
      controller: new AbortController(),
      sitioElegido: null,
      argsParaAnime: [directUrl],
      nombre: null,
      episodio: null,
      temporada: 1,
      timestamp: Date.now(),
    }
    const key = clavePick(m)
    global.pendingServerPicks.delete(key)
    delete global.animeDlSessions[key]
    await ejecutarDescargaServidor(pick.servers, 0, pick, m, conn)
    return
  }

  if (parsed.url) {
    const sitio = getSitioPorDominio(parsed.url)
    let nombre = parsed.nombre || parsed.url.split('/').filter(Boolean).pop() || 'anime'
    let episodio = parsed.episodio
    try {
      const pathname = decodeURIComponent(new URL(parsed.url).pathname).replace(/\/+$/, '')
      const lastSegment = pathname.split('/').filter(Boolean).pop() || nombre
      const episodeMatch = lastSegment.match(/(?:episodio-|[-/])(\d+)$/i) || pathname.match(/\/(\d+)\/?$/)
      if (episodio == null && episodeMatch) episodio = Number(episodeMatch[1])
      nombre = lastSegment
        .replace(/-episodio-\d+$/i, '')
        .replace(/-\d+$/, '')
        .replace(/-/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase())
    } catch (_) {}
    try {
      await procesarEpisodio({
        m, conn, usedPrefix, nombre, episodio: episodio || 1, temporada: parsed.temporada,
        sitioElegido: sitio, forceServers: parsed.forceServers, directEpisodeUrl: parsed.url,
      })
    } catch (error) {
      return m.reply(`Error: ${error.message}`)
    }
    return
  }

  if (parsed.episodio == null) {
    return m.reply(`Indica el episodio. Ejemplo: ${usedPrefix}animedl naruto t2 1`)
  }
  if (!parsed.nombre) return m.reply(`Falta el nombre del anime. Ejemplo: ${usedPrefix}animedl naruto 1`)
  if (parsed.sitioId != null && !parsed.sitio) return m.reply(`No existe el sitio ${parsed.sitioId}`)

  const finalEp = parsed.hasta == null ? parsed.episodio : parsed.hasta
  if (finalEp < parsed.episodio) return m.reply('El rango de episodios no es válido')
  const total = finalEp - parsed.episodio + 1
  if (total > MAX_RANGE) return m.reply(`El rango máximo es de ${MAX_RANGE} episodios`)

  const resumen = []
  for (let offset = 0; offset < total; offset++) {
    if (global.activeDownloads.get(`${m.chat}|${m.sender}`)?.cancelled) break
    const episodio = parsed.episodio + offset
    if (total > 1) await m.reply(`Episodio ${offset + 1}/${total}`)
    try {
      const outcome = await procesarEpisodio({
        m, conn, usedPrefix, nombre: parsed.nombre, episodio,
        temporada: parsed.temporada, sitioElegido: parsed.sitio, forceServers: parsed.forceServers,
      })
      resumen.push(`${episodio}: ${outcome.waiting ? 'pendiente de servidor' : 'ok'}`)
      if (outcome.waiting) break
    } catch (error) {
      console.error('[animedl episodio]', episodio, error)
      resumen.push(`${episodio}: falló`)
      await m.reply(`Episodio ${episodio}: ${error.message}`)
    }
    if (offset + 1 < total) await esperar(250)
  }
  if (total > 1) await m.reply(`Resumen: ${resumen.join(' · ')}`)
}

handler.before = async function (m, { conn }) {
  const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (!nativeFlow) return false
  try {
    const params = JSON.parse(nativeFlow.paramsJson || '{}')
    const selectedId = String(params?.id || '').trim()
    if (!selectedId || !/^\.(?:dl|animedl)(?:\s|$)/i.test(selectedId)) return false

    const isServerPick = /^\.dl\s+\d+$/i.test(selectedId)
    const key = clavePick(m)
    const pick = global.pendingServerPicks.get(key)
    if (isServerPick && !pick) return false
    if (isServerPick) {
      const num = Number(selectedId.split(/\s+/)[1])
      if (num < 1 || num > pick.servers.length) {
        await m.reply(`Selección inválida. Elige entre 1 y ${pick.servers.length}`)
        return true
      }
      global.pendingServerPicks.delete(key)
      delete global.animeDlSessions[key]
      guardarPicks()
      await ejecutarDescargaServidor(pick.servers, num - 1, pick, m, conn)
      await enviarBotonesFinales(m, conn, pick)
      return true
    }

    const prefix = selectedId[0]
    const parts = selectedId.slice(1).split(/\s+/)
    const command = parts.shift()
    const text = parts.join(' ')
    await handler.call(conn, m, { conn, text, usedPrefix: prefix, command })
    return true
  } catch (error) {
    console.error('[animeDL before]', error.message)
    return false
  }
}

handler.help = ['animedl <nombre> [tN] <ep>', 'animedl -s <id> <nombre> <ep>', 'anilist']
handler.tags = ['descargas']
handler.command = /^(animedl|dl|anilist|cancelar|stop)$/i

cargarPicks()

export default handler
