const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  const groupMetadata = await conn.groupMetadata(m.chat)
  const participants = groupMetadata.participants
  
  // Obtener admins y verificar permisos
  const admins = participants.filter(p => p.admin !== null).map(p => p.id)
  const isBotAdmin = admins.includes(conn.user.id.split(':')[0] + '@s.whatsapp.net')
  const isAdmin = admins.includes(m.sender)

  if (!isAdmin) return m.reply('❌ Solo administradores.')
  if (!isBotAdmin) return m.reply('❌ El bot debe ser admin.')

  const botJid = conn.user.id.split(':')[0] + '@s.whatsapp.net'
  const targets = participants.filter(p => !admins.includes(p.id) && p.id !== botJid).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros para eliminar.')

  await m.reply(`⚠️ *KICKALL*: Eliminando ${targets.length} miembros...`)

  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      await new Promise(r => setTimeout(r, 1000)) // Espera 1 seg entre cada uno
    } catch (e) {
      console.error(e)
    }
  }

  await m.reply('✅ Proceso de eliminación finalizado.')
}

handler.help = ['kickall']
handler.tags = ['group']
handler.command = /^(kickall|eliminaratodos)$/i
handler.group = true

export default handler
