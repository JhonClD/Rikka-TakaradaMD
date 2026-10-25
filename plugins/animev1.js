import animeV1 from '../src/libraries/animev1.cjs'
import animeV1Downloader from '../src/libraries/animev1-download.cjs'

const SESSION_TTL = 10 * 60 * 1000
const MAX_RESULTS = 8
const MAX_EPISODES_IN_INFO = 30
const MAX_LINKS_IN_REPLY = 12
const DOMAIN = String(process.env.ANIMEV1_DOMAIN || process.env.DEFAULT_ANIME_DOMAIN || 'animeav1.com')
  .replace(/^https?:\/\//i, '')
  .split('/')[0]
  .replace(/^www\./i, '')
  .toLowerCase()

global.animeV1Sessions = global.animeV1Sessions || new Map()
global.animeV1DownloadLocks = global.animeV1DownloadLocks || new Set()

function sessionKey(m) {
  return `${m.chat}|${m.sender}`
}

function getSession(m) {
  const key = sessionKey(m)
  const session = global.animeV1Sessions.get(key)
  if (!session || session.expiresAt < Date.now()) {
    global.animeV1Sessions.delete(key)
    return { key, value: { results: [], selected: null } }
  }
  return { key, value: session }
}

function saveSession(key, value) {
  global.animeV1Sessions.set(key, { ...value, expiresAt: Date.now() + SESSION_TTL })
}

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function allowedAnimeUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./i, '').toLowerCase()
    return url.protocol === 'https:' && (host === DOMAIN || host.endsWith(`.${DOMAIN}`))
      ? url.href
      : null
  } catch (_) {
    return null
  }
}

function parseIndex(value, length) {
  if (!/^\d+$/.test(String(value || ''))) return null
  const index = Number(value) - 1
  return index >= 0 && index < length ? index : null
}

function formatSearchResults(query, results) {
  const lines = results.slice(0, MAX_RESULTS).map((item, index) => {
    const meta = [item.type, item.year, item.status].filter(Boolean).join(' · ')
    return `*${index + 1}.* ${clean(item.title, 120)}${meta ? `\n   ${clean(meta, 100)}` : ''}`
  })
  return `*AnimeV1 · Resultados para “${clean(query, 100)}”*\n\n${lines.join('\n')}\n\n` +
    `Usa *.animev1info <número>* para ver la ficha y episodios.`
}

function formatAnimeInfo(anime, url) {
  const episodes = Array.isArray(anime.episodes) ? anime.episodes : []
  const episodeLines = episodes.slice(0, MAX_EPISODES_IN_INFO).map((episode, index) => {
    const number = episode.number ?? episode.episode ?? index + 1
    return `· *${number}.* ${clean(episode.title || `Episodio ${number}`, 90)}`
  })
  const meta = [anime.type, anime.year, anime.status, anime.score ? `★ ${anime.score}` : null]
    .filter(Boolean).join(' · ')
  const genres = Array.isArray(anime.genres)
    ? anime.genres.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).slice(0, 8).join(', ')
    : ''
  const synopsis = clean(anime.description, 700)
  const total = Number(anime.totalEpisodes) || episodes.length
  return `*${clean(anime.title || 'Anime sin título', 150)}*\n` +
    `${meta ? `${meta}\n` : ''}` +
    `${genres ? `Géneros: ${clean(genres, 200)}\n` : ''}` +
    `${synopsis ? `\n${synopsis}\n` : ''}` +
    `\n*Episodios${total ? ` (${total})` : ''}*\n` +
    `${episodeLines.length ? episodeLines.join('\n') : 'No se encontró una lista de episodios en la ficha.'}` +
    `${episodes.length > MAX_EPISODES_IN_INFO ? `\n… y ${episodes.length - MAX_EPISODES_IN_INFO} más.` : ''}` +
    `\n\nPágina: ${url}\n` +
    `Consulta enlaces con *.animev1ep <episodio>*.`
}

function episodeUrlFromAnime(animeUrl, episode) {
  const anime = animeUrl?.anime || animeUrl || {}
  const item = (anime.episodes || []).find(ep => Number(ep.number ?? ep.episode) === Number(episode))
  if (item?.url) return allowedAnimeUrl(item.url)
  try {
    const base = new URL(animeUrl.url)
    const match = base.pathname.match(/^\/media\/([^/]+)/i)
    if (!match) return null
    return `${base.origin}/media/${encodeURIComponent(match[1])}/${Number(episode)}`
  } catch (_) {
    return null
  }
}

function uniqueLinks(groups) {
  const seen = new Set()
  const output = []
  for (const group of groups) {
    for (const item of group.items || []) {
      const url = allowedAnimeUrl(item.url) || validExternalUrl(item.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      output.push({ label: `${group.label} · ${item.server || 'servidor'}${item.quality ? ` · ${item.quality}` : ''}`, url })
    }
  }
  return output.slice(0, MAX_LINKS_IN_REPLY)
}

function validExternalUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch (_) {
    return null
  }
}

function formatEpisodeLinks(result, variant) {
  const data = result?.data || {}
  const variants = variant ? [variant] : ['SUB', 'DUB']
  const groups = []
  for (const name of variants) {
    const key = name.toUpperCase()
    const stream = data.streamLinks?.[key] || data.servers?.[key.toLowerCase()] || []
    const downloads = data.downloadLinks?.[key] || []
    if (stream.length) groups.push({ label: `${key} · streaming`, items: stream })
    if (downloads.length) groups.push({ label: `${key} · descarga`, items: downloads })
  }
  const links = uniqueLinks(groups)
  if (!links.length) return 'AnimeV1 no devolvió enlaces para ese episodio. Prueba otra variante (sub/dub) o revisa la página del episodio.'
  const header = `*${clean(data.title || `Episodio ${data.episode || ''}`, 120)}*`
  return `${header}\n\n${links.map((item, index) => `*${index + 1}. ${clean(item.label, 100)}*\n${item.url}`).join('\n\n')}`
}

function errorMessage(error) {
  if (error?.statusCode === 404) return 'No encontré ese anime o episodio en AnimeV1.'
  if (error?.statusCode === 400) return clean(error.message, 220)
  if (error?.code === 'ECONNABORTED' || error?.name === 'AbortError') return 'AnimeV1 tardó demasiado en responder. Inténtalo otra vez.'
  return `No pude consultar AnimeV1: ${clean(error?.message || 'error desconocido', 220)}`
}

async function searchAnime(m, text) {
  const query = String(text || '').trim()
  if (!query) return m.reply('Escribe un título. Ejemplo: *.animev1 naruto*')
  const response = await animeV1.searchAnime(query, DOMAIN)
  const results = (response?.data?.results || []).filter(item => item?.title && allowedAnimeUrl(item.url)).slice(0, MAX_RESULTS)
  if (!results.length) return m.reply(`No encontré resultados para *${clean(query, 100)}* en AnimeV1.`)
  const { key, value } = getSession(m)
  saveSession(key, { ...value, query, results, selected: null })
  return m.reply(formatSearchResults(query, results))
}

async function showAnimeInfo(m, text) {
  const input = String(text || '').trim()
  if (!input) return m.reply('Indica un resultado o URL. Ejemplo: *.animev1info 1*')
  const { key, value } = getSession(m)
  let url = allowedAnimeUrl(input)
  if (!url) {
    const index = parseIndex(input, value.results.length)
    if (index == null) {
      return m.reply('Ese número no está en tu búsqueda reciente. Primero usa *.animev1 <título>* o pega una URL válida de AnimeV1.')
    }
    url = allowedAnimeUrl(value.results[index].url)
  }
  if (!url) return m.reply(`Solo acepto páginas de AnimeV1 (${DOMAIN}).`)
  const response = await animeV1.getAnimeInfo(url)
  const anime = response?.data
  if (!anime) return m.reply('AnimeV1 no devolvió la ficha de ese anime.')
  saveSession(key, { ...value, selected: { url, anime } })
  return m.reply(formatAnimeInfo(anime, url))
}

async function resolveEpisodeRequest(m, text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { error: 'Indica un episodio. Ejemplo: *.animev1ep 1*' }
  const { key, value } = getSession(m)
  let episodeUrl = allowedAnimeUrl(parts[0])
  let episodeNumber = null
  let variant = null
  const variantToken = parts.find(part => /^(sub|dub)$/i.test(part))
  if (variantToken) variant = variantToken.toUpperCase()

  if (episodeUrl) {
    if (parts[1] && /^\d+$/.test(parts[1])) episodeNumber = Number(parts[1])
  } else if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const index = parseIndex(parts[0], value.results.length)
    if (index == null) return { error: 'No encuentro ese número de anime en tu búsqueda reciente.' }
    const infoResponse = await animeV1.getAnimeInfo(value.results[index].url)
    const anime = infoResponse?.data
    if (!anime) return { error: 'No pude cargar la ficha del anime seleccionado.' }
    value.selected = { url: value.results[index].url, anime }
    episodeNumber = Number(parts[1])
  } else if (/^\d+$/.test(parts[0]) && value.selected?.anime) {
    episodeNumber = Number(parts[0])
  } else {
    return { error: 'Usa *.animev1ep <episodio>* después de abrir una ficha, o *.animev1ep <número-anime> <episodio>* desde los resultados.' }
  }

  if (!episodeUrl) episodeUrl = episodeUrlFromAnime(value.selected, episodeNumber)
  if (!episodeUrl) return { error: 'No pude construir la URL del episodio. Abre primero la ficha con *.animev1info <número>*.' }
  if (!allowedAnimeUrl(episodeUrl)) return { error: `Solo acepto URLs de AnimeV1 (${DOMAIN}).` }
  const title = value.selected?.anime?.title || value.selected?.title || value.results.find(item => item.url === episodeUrl)?.title || 'anime'
  saveSession(key, value)
  return { key, value, episodeUrl, episodeNumber, variant: variant || 'SUB', title }
}

async function showEpisodeLinks(m, text) {
  const target = await resolveEpisodeRequest(m, text)
  if (target.error) return m.reply(target.error)
  const response = await animeV1.getEpisodeLinks(target.episodeUrl, false)
  return m.reply(formatEpisodeLinks(response, target.variant))
}

async function downloadEpisode(m, conn, text) {
  const target = await resolveEpisodeRequest(m, text)
  if (target.error) return m.reply(target.error)
  if (global.animeV1DownloadLocks.has(target.key)) return m.reply('Ya hay una descarga AnimeV1 activa para este chat. Espera a que termine.')

  global.animeV1DownloadLocks.add(target.key)
  let file = null
  let statusKey = null
  const update = async text => {
    if (statusKey) {
      try { await conn.sendMessage(m.chat, { text, edit: statusKey }) } catch (_) {}
    }
  }
  try {
    const status = await conn.sendMessage(m.chat, {
      text: `⏬ Preparando ${target.variant} · ${clean(target.title, 80)} · episodio ${target.episodeNumber || '?' }…`,
    }, { quoted: m })
    statusKey = status?.key || null
    file = await animeV1Downloader.downloadEpisodeFile(target.episodeUrl, {
      title: target.title,
      episode: target.episodeNumber,
      variant: target.variant,
      onStatus: update,
    })
    await update(`📤 Subiendo ${file.fileName} a WhatsApp…`)
    const caption = `🎬 ${clean(target.title, 100)} · Ep. ${target.episodeNumber || '?'} · ${target.variant}\nServidor: ${clean(file.server, 80)}`
    const sendAsVideo = file.extension === '.mp4' && file.fileSize <= 60 * 1024 * 1024
    const payload = sendAsVideo
      ? { video: { url: file.filePath }, mimetype: 'video/mp4', fileName: file.fileName, caption }
      : { document: { url: file.filePath }, mimetype: file.mimetype, fileName: file.fileName, caption }
    await conn.sendMessage(m.chat, payload, { quoted: m })
    await update(`✅ Descarga enviada: ${file.fileName}`)
  } catch (error) {
    console.error('[animev1 download]', error?.stack || error)
    const message = `❌ ${clean(error?.message || 'Falló la descarga.', 500)}\n\nSi los servidores no se pueden resolver, usa *.animev1ep ${target.episodeNumber || ''}* para obtener sus enlaces.`
    if (statusKey) await update(message)
    else await m.reply(message)
  } finally {
    if (file?.filePath) await animeV1Downloader.cleanupDownloadFile(file.filePath)
    global.animeV1DownloadLocks.delete(target.key)
  }
}

const handler = async (m, { conn, text, command }) => {
  try {
    if (/^animev1help$/i.test(command)) {
      return m.reply(
        '*Comandos AnimeV1*\n\n' +
        '· *.animev1 <título>* — buscar anime\n' +
        '· *.animev1info <número|URL>* — ficha y episodios\n' +
        '· *.animev1ep <episodio> [sub|dub]* — enlaces de la ficha abierta\n' +
        '· *.animev1ep <número-anime> <episodio> [sub|dub]* — enlaces desde resultados\n' +
        '· *.animev1dl <episodio> [sub|dub]* — descargar y enviar el episodio\n' +
        '· *.animev1dl <número-anime> <episodio> [sub|dub]* — descargar desde resultados\n\n' +
        'Las búsquedas y selecciones se guardan durante 10 minutos.'
      )
    }
    if (/^animev1info$/i.test(command)) return await showAnimeInfo(m, text)
    if (/^animev1ep$/i.test(command)) return await showEpisodeLinks(m, text)
    if (/^animev1dl$/i.test(command)) return await downloadEpisode(m, conn, text)
    return await searchAnime(m, text)
  } catch (error) {
    console.error('[animev1]', error?.stack || error)
    return m.reply(errorMessage(error))
  }
}

handler.help = [
  'animev1 <título>',
  'animev1info <número|URL>',
  'animev1ep <episodio> [sub|dub]',
  'animev1dl <episodio> [sub|dub]',
  'animev1help',
]
handler.tags = ['anime']
handler.command = /^(animev1|animev1info|animev1ep|animev1dl|animev1help)$/i

export default handler
