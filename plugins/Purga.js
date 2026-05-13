const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  // 1. Forzar actualización de metadatos (bypass caché)
  // Usamos fetchGroupMetadata si está disponible, o groupMetadata normal
  const metadata = await conn.groupMetadata(m.chat).catch(async () => {
    return await conn.groupMetadata(m.chat) 
  })
  
  const participants = metadata.participants

  // 2. Limpieza extrema de IDs (solo números)
  const getNum = (jid) => jid.split('@')[0].split(':')[0]
  const botNumber = getNum(conn.user.id)
  const senderNumber = getNum(m.sender)

  // 3. Buscar rangos comparando solo los números de teléfono
  const botInGroup = participants.find(p => getNum(p.id) === botNumber)
  const senderInGroup = participants.find(p => getNum(p.id) === senderNumber)

  // 4. Verificación de seguridad
  const isBotAdmin = botInGroup?.admin === 'admin' || botInGroup?.admin === 'superadmin'
  const isUserAdmin = senderInGroup?.admin === 'admin' || senderInGroup?.admin === 'superadmin'

  if (!isUserAdmin) return m.reply('❌ Solo administradores pueden usar este comando.')
  
  if (!isBotAdmin) {
    // Intento final: Si el código dice que no es admin, intentamos una acción ligera 
    // para ver si WhatsApp lo permite, si falla, entonces realmente no es admin.
    try {
      await conn.groupUpdateSubject(m.chat, metadata.subject) 
    } catch {
      return m.reply('❌ El bot no tiene rango de administrador. Por favor, dáselo y vuelve a intentar.')
    }
  }

  // 5. Filtrar solo a los que NO son admins
  const targets = participants.filter(p => !p.admin).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros comunes para eliminar.')

  await m.reply(`⚠️ *EJECUTANDO KICKALL*\nEliminando a *${targets.length}* integrantes...`)

  let removidos = 0
  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      removidos++
      await new Promise(r => setTimeout(r, 1000)) // 1 segundo de espera
    } catch (e) {
      console.log(`Error al eliminar a ${jid}`)
    }
  }

  await m.reply(`✅ *Proceso finalizado*\nSe eliminaron *${removidos}* miembros.`)
}

handler.help = ['kickall']
handler.tags = ['group']
handler.command = /^(kickall|purge)$/i
handler.group = true

export default handler
