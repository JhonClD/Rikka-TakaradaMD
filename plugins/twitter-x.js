import axios from 'axios'

const SIZE_LIMIT = 20 * 1024 * 1024

const formatBytes = (b) => {
  if (!b || b === 0) return 'N/A'
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB'
  if (b >= 1024)        return (b / 1024).toFixed(1) + ' KB'
  return b + ' B'
}

const formatDate = (iso) => {
  if (!iso) return 'N/A'
  const d = new Date(iso)
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
}

const sanitize = (str = '') => str.replace(/[\\/:*?"<>|]/g, '').trim() || 'twitter_video'

const buildCaption = ({ username, name, title, size, type, fecha, url }) =>
`ִֶָ𓂃 ࣪˖ ִֶָ  *FILE INFO* ִֶָ𓂃 ࣪˖ ִֶָ

⭑ ₊ ⭒  *USER* ꩜  \`${name || username || 'N/A'}\`
⭑ ₊ ⭒  *TITLE* ꩜  \`${title || 'Sin título'}\`
⭑ ₊ ⭒  *SIZE* ꩜  \`${size}\`
⭑ ₊ ⭒  *TYPE* ꩜  \`${type}\`
⭑ ₊ ⭒  *FECHA* ꩜  \`${fecha}\`

˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  *URL*
${url}

✧˚ ༘ ⋆｡˚  𖥔 ࣪˖`

const _twitterapi  = (id) => `https://info.tweeload.site/status/${id}.json`

const getAuthorization = async () => {
  const { data } = await axios.get('https://pastebin.com/raw/SnCfd4ru')
  return data
}

const TwitterDL = async (url) => {
  const id = url.match(/\/([\d]+)/)
  if (!id) return { status: 'error', message: '❌ URL inválida. Usa un link de X/Twitter con un ID de tweet.' }

  const response = await axios.get(_twitterapi(id[1]), {
    headers: {
      Authorization: await getAuthorization(),
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36',
    },
  })

  if (response.data.code !== 200)
    return { status: 'error', message: '❌ No se pudo obtener el tweet. Verifica el link.' }

  const tweet  = response.data.tweet
  const author = {
    id:       tweet.author?.id,
    name:     tweet.author?.name,
    username: tweet.author?.screen_name,
  }

  let media = [], type

  if (tweet?.media?.videos?.length) {
    type = 'video'
    tweet.media.videos.forEach((v) => {
      const variants = []
      v.video_urls?.forEach((z) => {
        const resMatch = z.url.match(/([\d ]{2,5}[x][\d ]{2,5})/)
        variants.push({ bitrate: z.bitrate || 0, url: z.url, resolution: resMatch ? resMatch[0] : 'HD' })
      })
      variants.sort((a, b) => b.bitrate - a.bitrate)
      if (variants.length) media.push({ type: v.type, result: variants })
    })
  } else if (tweet?.media?.photos?.length) {
    type = 'photo'
    tweet.media.photos.forEach((v) => media.push(v))
  }

  return {
    status: 'success',
    result: {
      caption:   tweet.text || '',
      createdAt: tweet.created_at || null,
      author,
      type,
      media: media.length ? media : null,
    },
  }
}

let enviando = false

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text?.trim())
    return conn.sendMessage(
      m.chat,
      { text: `⭑ Envía el link de un tweet junto al comando.\n\n*Ejemplo:*\n${usedPrefix + command} https://x.com/usuario/status/123456789` },
      { quoted: m }
    )

  if (enviando) return conn.sendMessage(m.chat, { text: '⏳ Ya hay una descarga en curso, espera un momento.' }, { quoted: m })
  enviando = true

  try {
    await conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })

    let res
    try {
      res = await TwitterDL(text.trim())
    } catch (e) {
      enviando = false
      await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
      return conn.sendMessage(m.chat, { text: `❌ Error al contactar la API de Twitter.\n\`${e.message}\`` }, { quoted: m })
    }

    if (res.status === 'error') {
      enviando = false
      await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
      return conn.sendMessage(m.chat, { text: res.message }, { quoted: m })
    }

    if (!res.result?.media?.length) {
      enviando = false
      await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
      return conn.sendMessage(m.chat, { text: '❌ No se encontró media en ese tweet.' }, { quoted: m })
    }

    const { result } = res
    const { author, type, media, caption: tweetText, createdAt } = result

    if (type === 'photo') {
      for (let i = 0; i < media.length; i++) {
        const photoUrl = media[i].url || media[i]
        const infoCaption = buildCaption({
          username: author.username,
          name:     author.name,
          title:    tweetText ? tweetText.slice(0, 60) + (tweetText.length > 60 ? '…' : '') : 'Sin título',
          size:     'N/A',
          type:     'image/jpeg',
          fecha:    formatDate(createdAt),
          url:      text.trim(),
        })

        await conn.sendMessage(
          m.chat,
          { image: { url: photoUrl }, caption: infoCaption },
          { quoted: m }
        )
      }

      await conn.sendMessage(m.chat, { react: { text: '🔗', key: m.key } })
      enviando = false
      return
    }

    if (type === 'video') {
      for (let i = 0; i < media.length; i++) {
        const variants = media[i].result
        if (!variants?.length) continue

        const best = variants[0]
        const videoUrl = best.url

        let buffer, contentSize
        try {
          const dl = await axios.get(videoUrl, { responseType: 'arraybuffer' })
          buffer      = Buffer.from(dl.data)
          contentSize = buffer.length
        } catch (e) {
          await conn.sendMessage(m.chat, { text: `❌ No se pudo descargar el video #${i + 1}.\n\`${e.message}\`` }, { quoted: m })
          continue
        }

        const titleRaw  = tweetText ? tweetText.slice(0, 80) : `tweet_${author.username || 'video'}`
        const fileName  = sanitize(titleRaw) + '.mp4'
        const infoCaption = buildCaption({
          username: author.username,
          name:     author.name,
          title:    tweetText ? tweetText.slice(0, 60) + (tweetText.length > 60 ? '…' : '') : 'Sin título',
          size:     formatBytes(contentSize),
          type:     'video/mp4',
          fecha:    formatDate(createdAt),
          url:      text.trim(),
        })

        if (contentSize > SIZE_LIMIT) {
          await conn.sendMessage(
            m.chat,
            {
              document: buffer,
              mimetype: 'video/mp4',
              fileName,
              caption:  infoCaption,
            },
            { quoted: m }
          )
        } else {
          await conn.sendMessage(
            m.chat,
            {
              video:   buffer,
              mimetype: 'video/mp4',
              caption: infoCaption,
            },
            { quoted: m }
          )
        }
      }

      await conn.sendMessage(m.chat, { react: { text: '🔗', key: m.key } })
      enviando = false
      return
    }

    enviando = false
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    conn.sendMessage(m.chat, { text: '❌ Tipo de media no soportado.' }, { quoted: m })

  } catch (e) {
    enviando = false
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    console.error('[Twitter-DL]', e)
    conn.sendMessage(m.chat, { text: `❌ Error inesperado.\n\`${e.message}\`` }, { quoted: m })
  }
}

handler.help    = ['x <url>', 'twitter <url>']
handler.tags    = ['downloader']
handler.command = /^(x|twitter|xdl|dlx|twdl|twt|twitterdl)$/i

export default handler

