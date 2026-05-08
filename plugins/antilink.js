const linkRgx = /https?:\/\/(chat\.whatsapp\.com|t\.me|telegram\.me|vm\.tiktok\.com|tiktok\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|x\.com|twitter\.com)\/\S+/gi

const handler = async (m, { conn, isAdmin, isOwner, isBotAdmin }) => {
  let chat = global.db.data.chats[m.chat]
  if (!chat) global.db.data.chats[m.chat] = chat = {}
  if (/^antilink( (on|off))?$/i.test(m.text?.trim())) {
    if (!isAdmin && !isOwner) return m.reply('Solo administradores.')
    let on = /\bon\b/i.test(m.text) ? true : /\boff\b/i.test(m.text) ? false : !chat.antilink
    chat.antilink = on
    return m.reply(`Antilink ${on ? '✅ activado' : '❌ desactivado'}`)
  }
  if (!chat.antilink || isAdmin || isOwner || !isBotAdmin) return
  if (!m.text) return
  linkRgx.lastIndex = 0
  if (!linkRgx.test(m.text)) return
  await conn.sendMessage(m.chat, { delete: m.key })
  await conn.sendMessage(m.chat, {
    text: `⚠️ @${m.sender.split('@')[0]} no está permitido enviar links.`,
    mentions: [m.sender]
  })
}

handler.all = true
handler.group = true

export default handler
