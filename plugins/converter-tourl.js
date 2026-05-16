import { uploadWithFallback } from '../src/libraries/uploadImage.js'

const handler = async (m, { conn, text }) => {
  const q = m.quoted ? m.quoted : m
  let buffer
  let mime = (q.msg || q).mimetype || ''
  let originalName = (q.msg || q).fileName || ''

  if (text) {
    buffer = Buffer.from(text, 'utf-8')
    mime = 'text/plain'
  } else if (!mime || mime === 'text/plain' || !/image|video|audio|sticker|document/.test(mime)) {
    const content = q.text || q.caption || (q.msg && (q.msg.text || q.msg.caption)) || ''
    if (content) {
      buffer = Buffer.from(content, 'utf-8')
      mime = 'text/plain'
    }
  }

  if (!buffer) {
    buffer = await q.download?.().catch(() => null)
  }

  if (!buffer || buffer.length === 0) throw '❌ No se encontró contenido.'

  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚ Subiendo...')

  try {
    const { url: link, service, finalMime, finalExt } = await uploadWithFallback(buffer, 'txt', mime)

    const urlObj = (() => { try { return new URL(link) } catch { return null } })()
    const displayFileName = originalName || urlObj?.pathname?.split('/').pop() || `file_${Date.now()}.${finalExt}`

    const pesoTxt = buffer.length >= 1024 * 1024
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
      : `${(buffer.length / 1024).toFixed(1)} KB`

    await conn.sendMessage(m.chat, {
      text: `ִֶָ𓂃 ࣪˖ ִֶָ *FILE UPLOADED* ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
            `⭑ ₊ ⭒ *NAME* ꩜ \`${displayFileName}\`\n` +
            `⭑ ₊ ⭒ *SIZE* ꩜ \`${pesoTxt}\`\n` +
            `⭑ ₊ ⭒ *TYPE* ꩜ \`${finalMime}\`\n` +
            `⭑ ₊ ⭒ *SERVER* ꩜ \`${service}\`\n\n` +
            `˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗ *URL*\n` +
            `${link}\n\n` +
            `✧˚ ༘ ⋆｡˚ 𖥔 ࣪˖`,
      edit: statusKey
    }, { quoted: m })
  } catch (e) {
    await conn.sendMessage(m.chat, { text: `❌ Error: ${e.message}`, edit: statusKey }, { quoted: m })
  }
}

handler.help = ['tourl']
handler.tags = ['converter']
handler.command = /^(upload|uploader|tourl)$/i

export default handler
