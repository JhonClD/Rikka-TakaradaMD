import {
  downloadKey,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js'
import {
  buildAlbumChunks,
  buildCaption,
  describeMediaType,
  downloadAllMedia,
  extractTwitterUrl,
  fetchTweetData,
  formatBytes,
  formatDate,
  isAbortError,
  resolveTwitterUrl,
  sanitizeFileName,
} from '../src/libraries/twitter-dl.js'

const SERVICE = 'twitter'

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
  } catch {}
}

async function sendSingleInlineItem(conn, chat, item, caption, quoted) {
  if (item.kind === 'photo') {
    return conn.sendMessage(
      chat,
      {
        image: item.buffer,
        mimetype: item.mimetype || 'image/jpeg',
        ...(caption ? { caption } : {}),
      },
      { quoted },
    )
  }

  return conn.sendMessage(
    chat,
    {
      video: item.buffer,
      mimetype: 'video/mp4',
      ...(item.kind === 'gif' ? { gifPlayback: true } : {}),
      ...(caption ? { caption } : {}),
    },
    { quoted },
  )
}

async function sendInlineMedia(conn, chat, inlineItems, caption, quoted) {
  if (!inlineItems.length) return

  if (inlineItems.length === 1) {
    await sendSingleInlineItem(conn, chat, inlineItems[0], caption, quoted)
    return
  }

  const chunks = buildAlbumChunks(inlineItems, caption)
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    if (chunk.length === 1) {
      await conn.sendMessage(chat, chunk[0], { quoted })
      continue
    }

    try {
      await conn.sendMessage(
        chat,
        { album: chunk },
        { quoted, albumContinueOnError: true },
      )
    } catch (albumErr) {
      console.warn('[Twitter-DL] Falló el envío en álbum, reintentando por separado:', albumErr?.message || albumErr)
      for (const entry of chunk) {
        await conn.sendMessage(chat, entry, { quoted })
      }
    }
  }
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const rawUrl = extractTwitterUrl(
    text,
    args?.join(' '),
    m.quoted?.text,
    m.quoted?.caption,
  )

  if (!rawUrl) {
    return conn.sendMessage(
      m.chat,
      {
        text: `⭑ Envía el link de un tweet junto al comando (o responde a un mensaje con el link).\n\n*Ejemplo:*\n${usedPrefix + command} https://x.com/usuario/status/123456789`,
      },
      { quoted: m },
    )
  }

  const key = downloadKey(m)
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una descarga de X/Twitter en curso. Usa *cancelar* si deseas detenerla.' },
      { quoted: m },
    )
  }

  const controller = new AbortController()
  const finish = startDownload(key, SERVICE, controller, { label: 'Twitter/X' })

  try {
    await safeReact(conn, m, '⏳')

    const resolved = await resolveTwitterUrl(rawUrl, { signal: controller.signal })
    if (!resolved.tweetId) {
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: '❌ URL inválida. Usa un enlace de X/Twitter que apunte a un tweet específico.' },
        { quoted: m },
      )
    }

    let tweet
    try {
      tweet = await fetchTweetData(resolved.tweetId, {
        screenName: resolved.screenName,
        signal: controller.signal,
      })
    } catch (e) {
      if (isAbortError(e) && controller.signal.aborted) throw e
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: `❌ No se pudo obtener el tweet (puede ser privado, eliminado o con restricción).\n\`${e.message}\`` },
        { quoted: m },
      )
    }

    if (!tweet?.media?.length) {
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: '❌ No se encontró ninguna imagen ni video en ese tweet.' },
        { quoted: m },
      )
    }

    const { items, errors } = await downloadAllMedia(tweet.media, {
      signal: controller.signal,
    })

    if (!items.length) {
      await safeReact(conn, m, '❌')
      const detail = errors[0]?.message ? `\n\`${errors[0].message}\`` : ''
      return conn.sendMessage(
        m.chat,
        { text: `❌ No se pudo descargar la media del tweet.${detail}` },
        { quoted: m },
      )
    }

    const inlineItems = items.filter((item) => !item.oversized)
    const docItems = items.filter((item) => item.oversized)
    const cleanUrl = resolved.url

    if (inlineItems.length) {
      const totalInlineBytes = inlineItems.reduce((acc, it) => acc + (it.size || 0), 0)
      const infoCaption = buildCaption({
        username: tweet.author.username,
        name: tweet.author.name,
        title: tweet.text || 'Sin título',
        size: formatBytes(totalInlineBytes),
        type: describeMediaType(inlineItems),
        fecha: formatDate(tweet.createdAt),
        url: cleanUrl,
        stats: tweet.stats,
        isQuotedMedia: tweet.isQuotedMedia,
      })

      await sendInlineMedia(conn, m.chat, inlineItems, infoCaption, m)
    }

    for (let i = 0; i < docItems.length; i++) {
      const item = docItems[i]
      const suffix = docItems.length > 1 ? `_${i + 1}` : ''
      const baseName = sanitizeFileName(
        tweet.text || `tweet_${tweet.author.username || resolved.tweetId}`,
      )
      const fileName = `${baseName}${suffix}.mp4`
      const docCaption = buildCaption({
        username: tweet.author.username,
        name: tweet.author.name,
        title: tweet.text || 'Sin título',
        size: formatBytes(item.size),
        type: `video/mp4 (${item.resolution || 'HD'})`,
        fecha: formatDate(tweet.createdAt),
        url: cleanUrl,
        stats: tweet.stats,
        isQuotedMedia: tweet.isQuotedMedia,
      })

      await conn.sendMessage(
        m.chat,
        {
          document: item.buffer,
          mimetype: 'video/mp4',
          fileName,
          caption: docCaption,
        },
        { quoted: m },
      )
    }

    if (errors.length) {
      await conn.sendMessage(
        m.chat,
        { text: `⚠️ Se omitieron ${errors.length} archivo(s) porque no se pudieron descargar.` },
        { quoted: m },
      )
    }

    await safeReact(conn, m, '✅')
  } catch (e) {
    if (isAbortError(e) && controller.signal.aborted) {
      await safeReact(conn, m, '🛑')
      return conn.sendMessage(
        m.chat,
        { text: '🛑 Descarga de X/Twitter cancelada.' },
        { quoted: m },
      )
    }
    console.error('[Twitter-DL]', e)
    await safeReact(conn, m, '❌')
    return conn.sendMessage(
      m.chat,
      { text: `❌ Error inesperado al procesar el tweet.\n\`${e?.message || e}\`` },
      { quoted: m },
    )
  } finally {
    finish()
  }
}

handler.help = ['x <url>', 'twitter <url>']
handler.tags = ['downloader']
handler.command = /^(x|twitter|xdl|dlx|twdl|twt|twitterdl)$/i

export default handler
