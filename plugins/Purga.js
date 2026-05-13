const handler = async (m, { conn }) => {
  // 1. Validar que el JID sea de un grupo (@g.us)
  const groupJid = m.chat.endsWith('@g.us') ? m.chat : null
  if (!groupJid) return m.reply('❌ Este comando solo funciona dentro de un grupo.')

  try {
    // 2. Forzar la obtención de metadatos usando el JID correcto
    const metadata = await conn.groupMetadata(groupJid)
    const participants = metadata.participants

    // 3. Normalizar IDs para comparación (Bot y Remitente)
    const botJid = conn.user.id.split(':')[0] + '@s.whatsapp.net'
    const userJid = m.sender.split(':')[0] + '@s.whatsapp.net'

    // 4. Buscar los objetos de participante directamente
    const botInGroup = participants.find(p => p.id.includes(botJid.split('@')[0]))
    const userInGroup = participants.find(p => p.id.includes(userJid.split('@')[0]))

    // 5. Verificación de rangos (admin o superadmin)
    const isBotAdmin = botInGroup?.admin !== null && botInGroup?.admin !== undefined
    const isUserAdmin = userInGroup?.admin !== null && userInGroup?.admin !== undefined

    if (!isUserAdmin) return m.reply('❌ Solo administradores pueden usar este comando.')
    if (!isBotAdmin) return m.reply('❌ El bot no detecta su rango de admin. Prueba quitando y volviendo a dar admin.')

    // 6. Filtrar miembros comunes
    const targets = participants.filter(p => !p.admin && p.id !== botInGroup.id).map(p => p.id)

    if (targets.length === 0) return m.reply('⚠️ No hay miembros comunes para eliminar.')

    await m.reply(`🔄 Purgando ${targets.length} miembros...\n*Grupo:* ${metadata.subject}`)

    let removidos = 0
    for (const jid of targets) {
      try {
        await conn.groupParticipantsUpdate(groupJid, [jid], 'remove')
        removidos++
        await new Promise(r => setTimeout(r, 1000)) // Delay de seguridad
      } catch (e) {
        console.error(`Error eliminando a ${jid}:`, e)
      }
    }

    m.reply(`✅ Proceso finalizado. Se eliminaron ${removidos} miembros.`)

  } catch (error) {
    console.error('Error en Kickall:', error)
    m.reply('❌ Error al obtener los datos del grupo. Asegúrate de que el bot esté en el grupo.')
  }
}

handler.help = ['kickall']
handler.tags = ['group']
handler.command = /^(kickall|purge)$/i
handler.group = true

export default handler
