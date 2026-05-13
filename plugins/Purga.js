const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  // 1. Forzar obtención de metadatos actualizados
  const metadata = await conn.groupMetadata(m.chat)
  const participants = metadata.participants

  // 2. Normalizar el ID del bot (quitar el :1 del multi-device)
  const botJid = conn.user.id.split(':')[0] + '@s.whatsapp.net'
  
  // 3. Verificar internamente los permisos
  const botInGroup = participants.find(p => p.id === botJid)
  const senderInGroup = participants.find(p => p.id === m.sender)

  const isBotAdmin = botInGroup?.admin === 'admin' || botInGroup?.admin === 'superadmin'
  const isAdmin = senderInGroup?.admin === 'admin' || senderInGroup?.admin === 'superadmin'

  if (!isAdmin) return m.reply('❌ Solo los administradores pueden usar este comando.')
  if (!isBotAdmin) return m.reply('❌ El bot necesita ser administrador para expulsar miembros.')

  // 4. Filtrar objetivos (No admins, no el bot)
  const targets = participants.filter(p => {
    const isBot = p.id === botJid
    const isSpecialAdmin = p.admin === 'superadmin' || p.admin === 'admin'
    return !isBot && !isSpecialAdmin
  }).map(p => p.id)

  if (targets.length === 0) return m.reply('⚠️ No hay miembros comunes para purgar.')

  await m.reply(`🔄 Iniciando purga de *${targets.length}* miembro(s)...\n*Aviso:* Esto puede tardar un momento.`)

  let removidos = 0
  let fallidos = 0

  for (const jid of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      removidos++
      // Delay de 1 segundo para evitar baneos o bloqueos de flujo
      await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      fallidos++
      console.error(`Error al eliminar a ${jid}:`, e)
    }
  }

  const resultText = 
    `╔═══════════════╗\n` +
    `  ✦ *Purga completada*\n` +
    `╚═══════════════╝\n\n` +
    `✅ Removidos: *${removidos}*\n` +
    `❌ Fallidos:  *${fallidos}*\n\n` +
    `*Operación finalizada.*`

  await conn.sendMessage(m.chat, { text: resultText }, { quoted: m })
}

handler.help    = ['kickall']
handler.tags    = ['group']
handler.command = /^(kickall|purge|purgar|limpiargrupo)$/i
handler.group   = true
// Desactivamos la validación automática del handler para que use la interna del plugin
handler.admin   = false 
handler.botAdmin = false

export default handler
