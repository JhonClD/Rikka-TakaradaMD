import animeV1 from '../src/libraries/animev1.cjs'
import animeV1Downloader from '../src/libraries/animev1-download.cjs'

const DOMAIN = String(process.env.ANIMEV1_DOMAIN || process.env.DEFAULT_ANIME_DOMAIN || 'animeav1.com')
  .replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase()
const TTL = 10 * 60 * 1000
const MAX_SEARCH_RESULTS = 12
const MAX_OTHER_RESULTS = 4

global.nidlSessions = global.nidlSessions || new Map()
global.nidlDownloadLocks = global.nidlDownloadLocks || new Set()

function terminalLog(event, details = {}) {
  console.log(`[NIDL][${new Date().toISOString()}] ${event} ${JSON.stringify(details)}`)
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function clean(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function isSoloLeveling(value) {
  return /ore dake level up na ken|solo leveling/i.test(normalize(value))
}

function animeTitle(query, result) {
  if (isSoloLeveling(`${query} ${result.title} ${result.slug || ''}`)) return 'Solo Leveling'
  return clean(result.title || query)
}

function baseSeries(title, slug = '') {
  let value = normalize(title || slug)
  value = value.replace(/\b(?:season|temporada)\s*(?:[2-9]|ii|iii|iv|v|\d+)(?:\s+.*)?$/i, '')
  value = value.replace(/\b(?:2nd|3rd|4th)\s+season(?:\s+.*)?$/i, '')
  value = value.replace(/\bseason\s*(?:[2-9]|ii|iii|iv|v|\d+)(?:\s+.*)?$/i, '')
  value = value.replace(/\s+/g, ' ').trim()
  return value.replace(/\s+(?:arise from the shadow|arise from shadow|surge desde las sombras)$/i, '').trim()
}

function seasonNumber(item) {
  const title = normalize(`${item.title || ''} ${item.slug || ''}`)
  const match = title.match(/\b(?:season|temporada|s)\s*([2-9]|\d{1,2})\b/)
    || title.match(/\b(2nd|3rd|4th)\s+season\b/)
  if (!match) return 1
  const token = match[1]
  return ({ '2nd': 2, '3rd': 3, '4th': 4 })[token] || Number(token) || 1
}

function parseNumber(value) {
  const n = Number(String(value).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

function episodeNumber(episode, index) {
  return parseNumber(episode?.number ?? episode?.episode) || index + 1
}

function isSoloSeasonData(season) {
  return isSoloLeveling(`${season.searchTitle || ''} ${season.anime?.title || ''} ${season.anime?.slug || ''}`)
}

function formatSeasonTitle(season) {
  if (isSoloSeasonData(season)) {
    return season.number === 1
      ? 'Solo Leveling'
      : 'Solo Leveling Segunda Temporada -Surge desde las sombras-'
  }
  return clean(season.anime?.title || season.searchTitle || 'Anime')
}

function formatEpisodeTitle(season, episode, index) {
  const number = episodeNumber(episode, index)
  const title = clean(episode.title)
  return !title || /^episodio\s+\d+(?:\.\d+)?$/i.test(title)
    ? `Episodio ${number}`
    : title
}

function seasonEpisodes(season) {
  return Array.isArray(season?.anime?.episodes) ? season.anime.episodes : []
}

function seasonDescription(season) {
  const count = Number(season.anime?.totalEpisodes) || seasonEpisodes(season).length
  return `❏ *T${season.number}* » ${formatSeasonTitle(season)} (${count || '?'} ep.)`
}

function formatSeasonEpisodeList(season) {
  const episodes = seasonEpisodes(season)
  const head = `*T${season.number} · ${formatSeasonTitle(season)}*`
  if (!episodes.length) return `${head}\n> No encontré la lista de episodios para esta temporada.`
  const lines = episodes.map((episode, index) => {
    const number = episodeNumber(episode, index)
    return `> *${number}.* ${formatEpisodeTitle(season, episode, index)}`
  })
  return `${head}\n${lines.join('\n')}`
}

function menuText(session, onlySeason = null) {
  const title = session.title
  const seasons = session.seasons
  const selected = onlySeason == null ? seasons[0] : seasons.find(item => item.number === onlySeason)
  const header = `「✐」 *${title}*`
  const seasonLines = seasons.map(seasonDescription).join('\n')
  const languages = '❏ Audio » Japonés\n❏ Subs » Español Latino 🇲🇽 / Castellano 🇪🇸'
  const other = session.otherResults.length
    ? `\n\n✐ Otros resultados: ${session.otherResults.map((item, index) => `*${String.fromCharCode(97 + index)})* ${clean(item.title, 90)}`).join(' · ')}`
    : ''
  const instructions = '\n\n✐ Responde a este mensaje con el episodio: *1* · *1 720p* · *1 lat* · *1 sub* · *1 dub* · *s2 5* · *s2* (ver la T2)'
  const summary = `${header}\n${seasonLines}\n${languages}`
  return `${summary}\n\n${formatSeasonEpisodeList(selected)}${instructions}${onlySeason == null ? other : ''}`
}

function sessionKey(m) {
  return `${m.chat}|${m.sender}`
}

function saveSession(key, session) {
  global.nidlSessions.set(key, { ...session, expiresAt: Date.now() + TTL })
}

function getSession(m) {
  const key = sessionKey(m)
  const session = global.nidlSessions.get(key)
  if (!session || session.expiresAt < Date.now()) {
    global.nidlSessions.delete(key)
    return { key, session: null }
  }
  return { key, session }
}

function extractQuotedText(m) {
  const quoted = m.quoted
  return quoted?.text || quoted?.body || quoted?.caption || quoted?.message?.conversation ||
    quoted?.message?.extendedTextMessage?.text || ''
}

function quotedMessageId(m) {
  return m.quoted?.key?.id || m.quoted?.id || m.message?.extendedTextMessage?.contextInfo?.stanzaId || null
}

async function sendMenu(conn, m, session, onlySeason = null) {
  const visible = findSeason(session, onlySeason || session.seasons[0]?.number)
  terminalLog('menú enviado', {
    anime: session.title,
    temporadas: session.seasons.map(item => item.number),
    temporadaVisible: visible?.number || null,
    episodios: visible ? seasonEpisodes(visible).length : 0,
    resultadosAlternativos: session.otherResults.length,
  })
  const sent = await conn.sendMessage(m.chat, { text: menuText(session, onlySeason) }, { quoted: m })
  session.menuMessageId = sent?.key?.id || sent?.id || null
  session.visibleSeason = onlySeason || session.seasons[0]?.number || 1
  saveSession(session.key, session)
  return sent
}

function findSeasonEpisodes(season, requestedEpisode) {
  const episodes = seasonEpisodes(season)
  const target = Number(requestedEpisode)
  return episodes.find((episode, index) => episodeNumber(episode, index) === target)
}

function parseOption(text) {
  const token = String(text || '').toLowerCase()
  if (token === '720p' || token === '480p' || token === '1080p') return { quality: token, variant: 'SUB', label: token }
  if (token === 'dub') return { quality: null, variant: 'DUB', label: 'dub' }
  if (token === 'lat' || token === 'sub') return { quality: null, variant: 'SUB', label: token }
  return { quality: null, variant: 'SUB', label: 'sub' }
}

function parseCommand(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean)
  let option = null
  let season = null
  let episode = null
  let changed = true
  while (tokens.length && changed) {
    changed = false
    const token = tokens[tokens.length - 1].replace(/^\[|\]$/g, '').replace(/^\(|\)$/g, '')
    if (option == null && /^(720p|480p|1080p|lat|sub|dub)$/i.test(token)) {
      option = token.toLowerCase()
      tokens.pop()
      changed = true
    } else if (season == null && /^(?:t|s)\d+$/i.test(token)) {
      season = Number(token.slice(1))
      tokens.pop()
      changed = true
    } else if (episode == null && /^\d+(?:\.\d+)?$/.test(token)) {
      episode = Number(token)
      tokens.pop()
      changed = true
    }
  }
  return { query: tokens.join(' ').trim(), episode, season, option }
}

function formatUsage(prefix = '/') {
  return '「✐」 *Uso de /nidl*\n\n' +
    `❏ *${prefix}nidl nombre del anime* — muestra temporadas y episodios\n` +
    `❏ *${prefix}nidl nombre episodio SUB|DUB* — descarga de T1\n` +
    `❏ *${prefix}nidl nombre episodio SUB|DUB T2* — descarga de otra temporada\n\n` +
    'Ejemplo: */nidl Solo Leveling 5 DUB T2*. No escribas los corchetes de los argumentos opcionales.\n' +
    'Responde al menú: *1* · *1 720p* · *1 lat* · *1 sub* · *1 dub* · *s2 5* · *s2* (ver episodios de T2).'
}

async function loadSeason(item, number) {
  const response = await animeV1.getAnimeInfo(item.url)
  if (!response?.data) throw new Error(`No pude cargar ${item.title || 'la temporada'}.`)
  return { number, url: item.url, searchTitle: item.title, anime: response.data }
}

async function makeSession(m, query, requestedSeason = null) {
  terminalLog('búsqueda iniciada', { query: clean(query), domain: DOMAIN })
  const result = await animeV1.searchAnime(query, DOMAIN)
  const results = (result?.data?.results || []).filter(item => item?.title && item?.url).slice(0, MAX_SEARCH_RESULTS)
  terminalLog('resultados recibidos', { query: clean(query), cantidad: results.length })
  if (!results.length) throw new Error(`No encontré *${clean(query)}* en AnimeV1. Revisa el nombre o intenta con el título japonés/inglés.`)

  const first = results[0]
  const base = baseSeries(first.title, first.slug)
  let seasonResults = results.filter(item => baseSeries(item.title, item.slug) === base)
  if (!seasonResults.length) seasonResults = [first]
  seasonResults = [...new Map(seasonResults.map(item => [item.url, item])).values()]
  seasonResults.sort((a, b) => seasonNumber(a) - seasonNumber(b))

  const seasons = []
  for (const item of seasonResults.slice(0, 5)) {
    const number = seasonNumber(item)
    terminalLog('cargando temporada', { temporada: number, anime: clean(item.title) })
    try {
      const season = await loadSeason(item, number)
      seasons.push(season)
      terminalLog('temporada cargada', { temporada: number, episodios: seasonEpisodes(season).length, anime: clean(item.title) })
    } catch (error) {
      terminalLog('falló carga de temporada', { temporada: number, anime: clean(item.title), error: error.message })
      console.warn('[nidl season]', item.title, error.message)
    }
  }
  if (!seasons.length) throw new Error('Encontré el anime, pero no pude cargar sus temporadas en AnimeV1.')

  const uniqueSeasonNumbers = new Set()
  const uniqueSeasons = seasons.filter(item => {
    if (uniqueSeasonNumbers.has(item.number)) return false
    uniqueSeasonNumbers.add(item.number)
    return true
  })
  const requested = requestedSeason ? uniqueSeasons.find(item => item.number === requestedSeason) : null
  const chosen = requested || uniqueSeasons.find(item => item.number === 1) || uniqueSeasons[0]
  const groupUrls = new Set(seasonResults.map(item => item.url))
  let otherResults = results.filter(item => !groupUrls.has(item.url)).slice(0, MAX_OTHER_RESULTS)
  if (!otherResults.length && query.trim().split(/\s+/).length > 1) {
    try {
      const broadQuery = query.trim().split(/\s+/)[0]
      terminalLog('búsqueda de resultados alternativos', { query: broadQuery })
      const broadResponse = await animeV1.searchAnime(broadQuery, DOMAIN)
      const seen = new Set(groupUrls)
      otherResults = (broadResponse?.data?.results || [])
        .filter(item => item?.title && item?.url && !seen.has(item.url) && baseSeries(item.title, item.slug) !== base)
        .filter(item => {
          if (seen.has(item.url)) return false
          seen.add(item.url)
          return true
        })
        .slice(0, MAX_OTHER_RESULTS)
      terminalLog('resultados alternativos recibidos', { cantidad: otherResults.length })
    } catch (error) {
      console.warn('[nidl related results]', error.message)
    }
  }
  const key = sessionKey(m)
  return {
    key,
    owner: m.sender,
    chat: m.chat,
    query,
    title: animeTitle(query, chosen),
    seasons: uniqueSeasons,
    visibleSeason: chosen.number,
    otherResults,
    menuMessageId: null,
    expiresAt: Date.now() + TTL,
  }
}

function findSeason(session, number) {
  return session.seasons.find(item => item.number === Number(number)) || null
}

async function downloadSelection(m, conn, session, season, episode, option = null) {
  const ep = findSeasonEpisodes(season, episode)
  if (!ep) {
    terminalLog('episodio no encontrado', { anime: session.title, temporada: season.number, episodio: episode })
    await conn.sendMessage(m.chat, { text: `No encuentro el episodio *${episode}* en T${season.number}. Hay ${seasonEpisodes(season).length} episodios registrados.` }, { quoted: m })
    return true
  }
  const lockKey = session.key
  if (global.nidlDownloadLocks.has(lockKey)) {
    terminalLog('descarga duplicada bloqueada', { anime: session.title, temporada: season.number, episodio: episode })
    await conn.sendMessage(m.chat, { text: 'Ya hay una descarga /nidl activa en este chat. Espera a que termine.' }, { quoted: m })
    return true
  }
  global.nidlDownloadLocks.add(lockKey)
  let file = null
  let statusKey = null
  const selectedOption = parseOption(option)
  const episodeName = formatEpisodeTitle(season, ep, seasonEpisodes(season).indexOf(ep))
  const title = `${session.title}-T${season.number}`
  terminalLog('descarga solicitada', {
    anime: session.title,
    temporada: season.number,
    episodio: episode,
    variante: selectedOption.variant,
    calidad: selectedOption.quality || 'automática',
    nombreEpisodio: episodeName,
  })
  const statusText = text => {
    terminalLog('estado', { mensaje: text })
    if (!statusKey) return Promise.resolve()
    return conn.sendMessage(m.chat, { text, edit: statusKey }).catch(() => null)
  }
  try {
    const status = await conn.sendMessage(m.chat, {
      text: `⏬ Preparando *${session.title} · T${season.number} Ep. ${episode}*${selectedOption.quality ? ` · ${selectedOption.quality}` : ''}…`,
    }, { quoted: m })
    statusKey = status?.key || null
    file = await animeV1Downloader.downloadEpisodeFile(ep.url, {
      title,
      episode,
      variant: selectedOption.variant,
      quality: selectedOption.quality,
      onStatus: statusText,
    })
    terminalLog('archivo descargado', {
      archivo: file.fileName,
      tamaño: formatBytes(file.fileSize),
      servidor: file.server,
      variante: file.variant,
    })
    await statusText(`📤 Subiendo *${episodeName}* a WhatsApp…`)
    const audio = selectedOption.variant === 'DUB' ? 'Doblaje (según fuente)' : 'Japonés (SUB)'
    const caption = `🎬 ${session.title} · T${season.number} Ep. ${episode}\n${episodeName}\nAudio: ${audio} · Subs: Español (según fuente)\nServidor: ${clean(file.server, 70)}`
    const isSmallVideo = file.extension === '.mp4' && file.fileSize <= 60 * 1024 * 1024
    const payload = isSmallVideo
      ? { video: { url: file.filePath }, mimetype: 'video/mp4', fileName: file.fileName, caption }
      : { document: { url: file.filePath }, mimetype: file.mimetype, fileName: file.fileName, caption }
    terminalLog('envío a WhatsApp iniciado', {
      tipo: isSmallVideo ? 'video' : 'documento',
      archivo: file.fileName,
      tamaño: formatBytes(file.fileSize),
    })
    await conn.sendMessage(m.chat, payload, { quoted: m })
    terminalLog('envío a WhatsApp completado', { archivo: file.fileName })
    await statusText(`✅ Descarga enviada: *${file.fileName}*`)
  } catch (error) {
    terminalLog('descarga fallida', {
      anime: session.title,
      temporada: season.number,
      episodio: episode,
      error: error?.message || String(error),
    })
    console.error('[nidl download]', error?.stack || error)
    let manualLinks = ''
    try {
      const result = await animeV1.getEpisodeLinks(ep.url, false)
      const key = selectedOption.variant
      const links = [
        ...(result?.data?.downloadLinks?.[key] || []),
        ...(result?.data?.streamLinks?.[key] || []),
      ].filter(item => /^https?:\/\//i.test(item?.url || '') && !/mp4upload/i.test(`${item.server || ''} ${item.url || ''}`)).slice(0, 4)
      if (links.length) {
        manualLinks = `\n\nEnlaces manuales (${key}):\n${links.map(item => `· ${clean(item.server || 'Servidor', 45)}: ${item.url}`).join('\n')}`
        terminalLog('enlaces manuales disponibles', { cantidad: links.length, variante: key })
      }
    } catch (_) {}
    const message = `❌ No se pudo descargar T${season.number} Ep. ${episode}: ${clean(error?.message || 'error desconocido', 350)}${manualLinks || '\n\nPrueba otra vez con /nidl nombre episodio T' + season.number + '.'}`
    if (statusKey) await statusText(message)
    else await conn.sendMessage(m.chat, { text: message }, { quoted: m })
  } finally {
    if (file?.filePath) {
      await animeV1Downloader.cleanupDownloadFile(file.filePath)
    }
    global.nidlDownloadLocks.delete(lockKey)
    terminalLog('proceso terminado', { anime: session.title, temporada: season.number, episodio: episode })
  }
  return true
}

async function selectOtherResult(m, conn, session, letter) {
  const index = letter.toLowerCase().charCodeAt(0) - 97
  const item = session.otherResults[index]
  if (!item) {
    await conn.sendMessage(m.chat, { text: 'Esa letra no corresponde a otro resultado de la lista.' }, { quoted: m })
    return true
  }
  try {
    const selected = await makeSession(m, item.title)
    return await sendMenu(conn, m, selected)
  } catch (error) {
    await conn.sendMessage(m.chat, { text: `❌ ${clean(error.message, 300)}` }, { quoted: m })
    return true
  }
}

async function handleSelection(m, conn, session, input) {
  const text = String(input || '').trim().toLowerCase()
  terminalLog('respuesta al menú recibida', { selección: text })
  const otherMatch = text.match(/^([a-d])$/)
  if (otherMatch) return selectOtherResult(m, conn, session, otherMatch[1])

  const seasonMatch = text.match(/^(?:s|t)(\d+)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(720p|480p|1080p|lat|sub|dub))?$/i)
  if (seasonMatch) {
    const season = findSeason(session, Number(seasonMatch[1]))
    if (!season) {
      await conn.sendMessage(m.chat, { text: `No hay una T${seasonMatch[1]} disponible para *${session.title}*.` }, { quoted: m })
      return true
    }
    if (seasonMatch[2]) return downloadSelection(m, conn, session, season, Number(seasonMatch[2]), seasonMatch[3])
    return sendMenu(conn, m, session, season.number)
  }

  const episodeMatch = text.match(/^(\d+(?:\.\d+)?)(?:\s+(720p|480p|1080p|lat|sub|dub))?$/i)
  if (episodeMatch) {
    const season = findSeason(session, session.visibleSeason) || session.seasons[0]
    return downloadSelection(m, conn, session, season, Number(episodeMatch[1]), episodeMatch[2])
  }

  await conn.sendMessage(m.chat, {
    text: 'No entendí la selección. Responde *1*, *1 720p*, *1 lat*, *1 sub*, *s2 5* para descargar, o *s2* para ver esa temporada.',
  }, { quoted: m })
  return true
}

async function startNidl(m, conn, text) {
  terminalLog('comando recibido', { argumento: clean(text) })
  const parsed = parseCommand(text)
  if (!parsed.query) {
    await m.reply(formatUsage('/'))
    return
  }
  const session = await makeSession(m, parsed.query, parsed.season)
  if (parsed.episode != null) {
    const season = findSeason(session, parsed.season || session.visibleSeason)
    if (!season) {
      await m.reply(`No encontré T${parsed.season} para *${session.title}*.\n${formatUsage('/')}`)
      return
    }
    return downloadSelection(m, conn, session, season, parsed.episode, parsed.option)
  }
  if (parsed.season && !findSeason(session, parsed.season)) {
    await m.reply(`No encontré T${parsed.season} para *${session.title}*.\n${formatUsage('/')}`)
    return
  }
  if (parsed.season) session.visibleSeason = parsed.season
  return sendMenu(conn, m, session, parsed.season)
}

const handler = async (m, { conn, text = '' }) => {
  try {
    await startNidl(m, conn, text)
  } catch (error) {
    terminalLog('error de comando', { error: error?.message || String(error) })
    console.error('[nidl]', error?.stack || error)
    await m.reply(`「✐」 ${clean(error?.message || 'No pude buscar ese anime.', 400)}\n\n${formatUsage('/')}`)
  }
}

handler.before = async function (m, { conn }) {
  const { session } = getSession(m)
  if (!session || !m.quoted) return false
  const quotedId = quotedMessageId(m)
  const quotedText = extractQuotedText(m)
  const isNidlMenu = quotedId && session.menuMessageId && quotedId === session.menuMessageId
  const isNidlText = /「✐」\s*\*.+\*/.test(quotedText) && /Responde a este mensaje con el episodio/i.test(quotedText)
  if (!isNidlMenu && !isNidlText) return false
  const input = m.text || m.body || m.message?.conversation || m.message?.extendedTextMessage?.text || ''
  try {
    return await handleSelection(m, conn, session, input)
  } catch (error) {
    console.error('[nidl selection]', error?.stack || error)
    await conn.sendMessage(m.chat, { text: `❌ ${clean(error?.message || 'No pude procesar esa selección.', 350)}` }, { quoted: m })
    return true
  }
}

handler.help = ['nidl <nombre> [episodio] [SUB|DUB] [T2]']
handler.tags = ['anime', 'downloader']
handler.command = /^(?:nidl)$/i

export default handler
