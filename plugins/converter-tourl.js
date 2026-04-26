import uploadImage from '../src/libraries/uploadImage.js'

const handler = async (m, { conn }) => {
  const q    = m.quoted ? m.quoted : m
  const mime = (q.msg || q).mimetype || ''

  if (!mime) return m.reply('˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  Responde o envía un archivo.')

  const { key: statusKey } = await m.reply('✧˚ ༘ ⋆｡˚  Subiendo archivo...')
  const editStatus = async txt => {
    try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }) } catch (_) {}
  }

  try {
    const buffer  = await q.download()
    const pesoTxt = buffer.length >= 1024 * 1024
      ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
      : `${(buffer.length / 1024).toFixed(1)} KB`

    const link = await uploadImage(buffer)
    if (!link) return editStatus('˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  No se pudo obtener el enlace.')

    const urlObj    = (() => { try { return new URL(link) } catch { return null } })()
    const pathParts = urlObj?.pathname?.split('/').filter(Boolean) || []
    const fileId    = pathParts[pathParts.length - 2] || pathParts[pathParts.length - 1] || '—'
    const fileName  = pathParts[pathParts.length - 1] || link.split('/').pop() || '—'

    await editStatus(
      `ִֶָ𓂃 ࣪˖ ִֶָ  *FILE UPLOADED*  ִֶָ𓂃 ࣪˖ ִֶָ\n\n` +
      `⭑ ₊ ⭒  *ID*    ꩜  \`${fileId}\`\n` +
      `⭑ ₊ ⭒  *NAME*  ꩜  \`${fileName}\`\n` +
      `⭑ ₊ ⭒  *SIZE*  ꩜  \`${pesoTxt}\`\n` +
      `⭑ ₊ ⭒  *TYPE*  ꩜  \`${mime}\`\n\n` +
      `˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  *URL*\n` +
      `${link}\n\n` +
      `✧˚ ༘ ⋆｡˚  𖥔 ࣪˖`
    )
  } catch (e) {
    console.error('[tourl]', e.message)
    await editStatus(`˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  Error: ${e.message}`)
  }
}

handler.help    = ['tourl', 'upload <archivo>']
handler.tags    = ['converter']
handler.command = /^(upload|uploader|tourl)$/i

export default handler
