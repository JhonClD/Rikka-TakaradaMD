let handler = async (m, { conn, isAdmin, isOwner }) => {
  let chat = global.db.data.chats[m.chat]
  if (!chat) global.db.data.chats[m.chat] = chat = {}
  if (/^welcome( (on|off))?$/i.test(m.text?.trim())) {
    if (!isAdmin && !isOwner) return m.reply('Solo administradores.')
    let on = /\bon\b/i.test(m.text) ? true : /\boff\b/i.test(m.text) ? false : !chat.welcome
    chat.welcome = on
    return m.reply(`Welcome ${on ? '✅ activado' : '❌ desactivado'}`)
  }
  if (!chat.welcome) return
  if (m.messageStubType === 27) {
    for (let user of m.messageStubParameters || []) {
      await conn.sendMessage(m.chat, {
        text: `¡Bienvenido/a @${user.split('@')[0]}! 🎉\nEspero que disfrutes el grupo.`,
        mentions: [user]
      })
    }
  } else if (m.messageStubType === 28 || m.messageStubType === 29) {
    for (let user of m.messageStubParameters || []) {
      await conn.sendMessage(m.chat, {
        text: `@${user.split('@')[0]} ha salido del grupo. 👋 ¡Hasta pronto!`,
        mentions: [user]
      })
    }
  }
}
handler.all = true
handler.group = true
module.exports = handler
