const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {}
  const chat = global.db.data.chats[m.chat]
  const sub  = text?.toLowerCase()

  if (sub === 'on') {
    if (chat.nsfw) return m.reply('꒰ 🔞 ꒱ El NSFW ya está *activado* en este grupo.')
    chat.nsfw = true
    return conn.sendMessage(m.chat, {
      text: '꒰ 🔞 ꒱ *NSFW activado*\n┊⇢ Contenido adulto habilitado en este grupo.'
    }, { quoted: m })
  }

  if (sub === 'off') {
    if (!chat.nsfw) return m.reply('꒰ ✅ ꒱ El NSFW ya está *desactivado* en este grupo.')
    chat.nsfw = false
    return conn.sendMessage(m.chat, {
      text: '꒰ ✅ ꒱ *NSFW desactivado*\n┊⇢ Solo contenido SFW a partir de ahora.'
    }, { quoted: m })
  }

  const estado = chat.nsfw ? '🔞 *Activado*' : '✅ *Desactivado*'
  return m.reply(
    `꒰ ✦ *NSFW* ✦ ꒱\n\n┊⇢ *Estado:* ${estado}\n\n` +
    `⸙͎ Uso:\n┊⇢ *${usedPrefix + command} on*\n┊⇢ *${usedPrefix + command} off*`
  )
}

handler.command = ['nsfw']
handler.tags    = ['admin']
handler.help    = ['nsfw on/off']
handler.admin   = true
handler.group   = true
export default handler
