const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo puede ejecutarse en grupos.')

  const groupMetadata = await conn.groupMetadata(m.chat)
  const participants = groupMetadata.participants
  
  // Limpiar el ID del bot para asegurar coincidencia
  const botRealId = conn.user.id.split(':')[0] + '@s.whatsapp.net'
  
  // Identificar administradores
  const admins = participants.filter(p => p.admin !== null).map(p => p.id)
  
  // Verificación mejorada
  const isBotAdmin = admins.some(ad => ad.split('@')[0] === botRealId.split('@')[0])
  const isAdmin = admins.some(ad => ad.split('@')[0] === m.sender.split('@')[0])

  if (!isAdmin) return m.reply('❌ Solo los administradores pueden usar este comando.')
  if (!isBotAdmin) return m.reply('❌ El bot necesita tener el rango de administrador para proceder.')

  // Filtrar miembros (excluyendo a todos los admins y al bot)
  const targets = participants.filter(p => p.admin === null && p.id !== botRealId).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros comunes para eliminar.')

  await m.reply(`⚠️ *KICKALL*: Iniciando purga de ${targets.length} miembros...`)

  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      // Delay de 1 segundo para estabilidad
      await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      console.log(`Error al eliminar a ${jid}:`, e)
    }
  }

  await m.reply('✅ Proceso de eliminación masiva completado.')
}

handler.help = ['kickall']
handler.tags = ['group']
handler.command = /^(kickall|eliminaratodos)$/i
handler.group = true

export default handler
