// trace-moe.js — Identifica el anime, episodio y minuto exacto desde una captura.
// Uso: responde a una imagen/sticker/gif/video con .trace o envíala con el comando.
import fetch from 'node-fetch'

const API = 'https://api.trace.moe/search?anilistInfo&cutBorders'
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const API_TIMEOUT_MS = 45_000

const fmtTime = (seconds = 0) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = value % 60
  const pad = (number) => String(number).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

const handler = async (m, { conn, usedPrefix, command }) => {
  const quoted = m.quoted ? m.quoted : m
  const mime = String((quoted.msg || quoted).mimetype || quoted.mediaType || '').toLowerCase()

  if (!/image|video|webp/.test(mime)) {
    return m.reply(
      `📸 Responde a una *imagen, sticker, gif o video* con *${usedPrefix + command}* para encontrar de qué anime es.`
    )
  }

  await m.reply('🔎 Buscando la escena...')

  try {
    const media = await quoted.download()
    if (!media?.length) throw new Error('No se pudo descargar el archivo.')
    if (media.length > MAX_MEDIA_BYTES) throw new Error('El archivo supera los 25 MB.')

    const response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': mime.split(';')[0] || 'application/octet-stream' },
      body: media,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })

    if (response.status === 429) throw new Error('Límite de peticiones alcanzado; intenta en un momento.')
    if (response.status === 402) throw new Error('La cuota de la API trace.moe se agotó.')

    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `trace.moe respondió HTTP ${response.status}.`)
    if (data.error) throw new Error(data.error)

    const best = data.result?.[0]
    if (!best) throw new Error('No se encontraron resultados.')

    const info = best.anilist || {}
    const titles = info.title || {}
    const title = titles.romaji || titles.english || titles.native || 'Desconocido'
    const similarity = (Number(best.similarity || 0) * 100).toFixed(1)
    const lowSimilarity = Number(best.similarity) < 0.9

    const caption = [
      `🎌 *${title}*`,
      titles.native && titles.native !== title ? `🈶 ${titles.native}` : null,
      titles.english && titles.english !== title ? `🇬🇧 ${titles.english}` : null,
      '',
      `📺 Episodio: *${best.episode ?? 'N/A'}*`,
      `⏱️ Minuto: *${fmtTime(best.from)} – ${fmtTime(best.to)}*`,
      `🎯 Similitud: *${similarity}%*${lowSimilarity ? ' ⚠️ (baja, puede ser incorrecto)' : ''}`,
      info.id ? `🔗 https://anilist.co/anime/${info.id}` : null,
      info.idMal ? `🔗 https://myanimelist.net/anime/${info.idMal}` : null,
    ].filter((line) => line !== null).join('\n')

    // No enviar una vista previa si AniList marca el título como contenido adulto.
    if (info.isAdult) {
      return conn.sendMessage(m.chat, { text: `${caption}\n\n🔞 Vista previa omitida.` }, { quoted: m })
    }

    try {
      if (!best.video) throw new Error('trace.moe no devolvió vista previa de video.')
      await conn.sendMessage(
        m.chat,
        { video: { url: `${best.video}&size=l` }, caption, gifPlayback: false },
        { quoted: m }
      )
    } catch {
      try {
        if (!best.image) throw new Error('trace.moe no devolvió imagen de vista previa.')
        await conn.sendMessage(m.chat, { image: { url: `${best.image}&size=l` }, caption }, { quoted: m })
      } catch {
        await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
      }
    }
  } catch (error) {
    console.error('[trace-moe]', error)
    await m.reply(`❌ ${error.message || 'Error al buscar la escena.'}`)
  }
}

handler.help = ['trace', 'whatanime']
handler.tags = ['anime']
handler.command = /^(trace|tracemoe|whatanime|rastrear|rastreamoe)$/i

export default handler
