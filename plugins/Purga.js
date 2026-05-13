const handler = async (m, { conn, isAdmin, isRAdmin, isBotAdmin }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')
  if (!isAdmin && !isRAdmin) return m.reply('❌ Solo administradores.')
  if (!isBotAdmin) return m.reply('❌ El bot necesita ser administrador.')

  // Obtener metadatos actualizados para evitar errores de participantes antiguos
  const metadata = await conn.groupMetadata(m.chat)
  const botJid = conn.user.id.split(':')[0] + '@s.whatsapp.net'

  // Filtrar objetivos: No el bot, no administradores (admin/superadmin)
  const targets = metadata.participants.filter(p => {
    const jid = p.id
    const isBot = jid.split('@')[0] === botJid.split('@')[0]
    const isSpecialAdmin = p.admin === 'superadmin' || p.admin === 'admin'
    return !isBot && !isSpecialAdmin
  }).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros que purgar (solo quedan administradores).')

  await m.reply(`🔄 Iniciando purga de *${targets.length}* miembro(s)...`)

  let removidos = 0
  let fallidos = 0

  for (const jid of targets) {
    try {
      // Usar groupParticipantsUpdate directamente con el ID
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      removidos++
      // Delay de 800ms para mayor seguridad contra el spam-detection
      await new Promise(r => setTimeout(r, 800))
    } catch (e) {
      fallidos++
      console.error(`Error eliminando a ${jid}:`, e)
    }
  }

  const resultText = `╔═══════════════╗\n` +
                     `  ✦ *PURGA COMPLETADA*\n` +
                     `╚═══════════════╝\n\n` +
                     `✅ Removidos: *${removidos}*\n` +
                     `❌ Fallidos:  *${fallidos}*\n\n` +
                     `*Operación finalizada.*`

  await conn.sendMessage(m.chat, { text: resultText }, { quoted: m })
}

handler.help    = ['purge', 'purgar']
handler.tags    = ['group']
handler.command = /^(purge|purgar|limpiargrupo)$/i
handler.group   = true
handler.admin   = true
handler.botAdmin = true

export default handler
