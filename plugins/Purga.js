const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  // 1. Obtener metadatos frescos
  const groupMetadata = await conn.groupMetadata(m.chat).catch(_ => null)
  if (!groupMetadata) return m.reply('❌ No pude obtener la información del grupo.')

  const participants = groupMetadata.participants
  
  // 2. Obtener el ID del bot de forma ultra-limpia
  const botId = conn.decodeJid(conn.user.id)
  
  // 3. Encontrar al bot y al remitente en la lista de participantes
  const botInGroup = participants.find(p => p.id === botId)
  const senderInGroup = participants.find(p => p.id === m.sender)

  // 4. Verificar si son administradores (admin o superadmin)
  const isBotAdmin = botInGroup?.admin?.includes('admin')
  const isAdmin = senderInGroup?.admin?.includes('admin')

  if (!isAdmin) return m.reply('❌ Solo administradores pueden usar esto.')
  if (!isBotAdmin) return m.reply('❌ ¡El bot NO es administrador! Por favor, dame admin.')

  // 5. Filtrar objetivos (quitar a todos los que tengan rango y al bot)
  const targets = participants.filter(p => !p.admin && p.id !== botId).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros comunes para purgar.')

  await m.reply(`⚠️ *KICKALL*: Eliminando ${targets.length} miembros...\n*Delay:* 1 segundo por usuario.`)

  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      await new Promise(r => setTimeout(r, 1000)) 
    } catch (e) {
      console.error(`Fallo al eliminar a ${jid}`)
    }
  }

  await m.reply('✅ Purga completada.')
}

handler.help = ['kickall']
handler.tags = ['group']
handler.command = /^(kickall|eliminaratodos)$/i
handler.group = true

export default handler
