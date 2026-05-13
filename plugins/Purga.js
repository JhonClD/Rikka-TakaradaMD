const handler = async (m, { conn, isAdmin, isRAdmin, isBotAdmin }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo puede ejecutarse en grupos.')
  if (!isAdmin && !isRAdmin) return m.reply('❌ Solo los administradores pueden usar este comando.')
  if (!isBotAdmin) return m.reply('❌ El bot necesita ser administrador para realizar esta acción.')

  const metadata = await conn.groupMetadata(m.chat)
  const botJid = conn.user.id.split(':')[0] + '@s.whatsapp.net'

  // Filtrar participantes que no sean el bot ni administradores
  const targets = metadata.participants.filter(p => {
    const jid = p.id
    const isBot = jid.split('@')[0] === botJid.split('@')[0]
    const isSpecialAdmin = p.admin === 'superadmin' || p.admin === 'admin'
    return !isBot && !isSpecialAdmin
  }).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros para eliminar (solo quedan administradores).')

  await m.reply(`⚠️ *EJECUTANDO KICKALL*\nEliminando a *${targets.length}* integrantes del grupo...`)

  let removidos = 0
  let fallidos = 0

  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      removidos++
      // Delay de seguridad para evitar spam-blocks
      await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      fallidos++
    }
  }

  const resultText = `╔═══════════════╗\n` +
                     `  ✦ *KICKALL FINALIZADO*\n` +
                     `╚═══════════════╝\n\n` +
                     `✅ Usuarios eliminados: *${removidos}*\n` +
                     `❌ Errores encontrados: *${fallidos}*\n\n` +
                     `*Limpieza total completada.*`

  await conn.sendMessage(m.chat, { text: resultText }, { quoted: m })
}

handler.help    = ['kickall']
handler.tags    = ['group']
handler.command = /^(kickall|eliminaratodos)$/i
handler.group   = true
handler.admin   = true
handler.botAdmin = true

export default handler
