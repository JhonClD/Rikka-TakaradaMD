import { uploadWithFallback, uploadToServiceByIndex, SERVICES } from '../src/libraries/uploadFile.js'

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const q = m.quoted ? m.quoted : m
  let buffer
  let mime = (q.msg || q).mimetype || ''
  let originalName = (q.msg || q).fileName || ''

  const numMatch = command.match(/(\d+)$/)
  const serviceIndex = numMatch ? parseInt(numMatch[1]) - 1 : null
  const isListCmd = /^(tourllist|urllist)$/i.test(command)

  if (isListCmd) {
    const lista = SERVICES.map((s, i) =>
      `  *${i + 1}.* ${s.name} → \`${usedPrefix}tourl${i + 1}\``
    ).join('\n')
    return m.reply(
      `✧˚ ༘ ⋆｡˚ *SERVIDORES DISPONIBLES*\n\n${lista}\n\n` +
      `˗ˏˋ Sin número = auto (fallback) ˎˊ˗`
    )
  }

  if (serviceIndex !== null && (serviceIndex < 0 || serviceIndex >= SERVICES.length)) {
    const max = SERVICES.length
    return m.reply(`❌ Servidor inválido. Usa del 1 al ${max}.\nVer lista: ${usedPrefix}tourllist`)
  }

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

  const serverLabel = serviceIndex !== null
    ? `al servidor *${SERVICES[serviceIndex].name}*`
    : `(auto fallback)`

  const { key: statusKey } = await m.reply(`✧˚ ༘ ⋆｡˚ Subiendo ${serverLabel}...`)

  try {
    const result = serviceIndex !== null
      ? await uploadToServiceByIndex(buffer, serviceIndex, 'txt', mime)
      : await uploadWithFallback(buffer, 'txt', mime)

    const { url: link, service, finalMime, finalExt } = result

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
    await conn.sendMessage(m.chat, { text: `❌ Error: ${e?.message || e}`, edit: statusKey }, { quoted: m })
  }
}

handler.help = ['tourl', 'tourl[1-13]', 'tourllist']
handler.tags = ['converter']
handler.command = /^(upload|uploader|tourl\d*|tourllist|urllist)$/i

export default handler
