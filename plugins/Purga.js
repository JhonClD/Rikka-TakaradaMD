const handler = async (m, { conn, isAdmin, isRAdmin, isBotAdmin }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')
  if (!isAdmin && !isRAdmin) return m.reply('❌ Solo administradores.')
  if (!isBotAdmin) return m.reply('❌ El bot necesita ser administrador.')

  const metadata = await conn.groupMetadata(m.chat)
  const botJid = conn.user.jid || conn.user.id

  const targets = metadata.participants.filter(p => {
    const jid = p.id || p.jid
    if (!jid) return false
    if (jid === botJid) return false
    if (jid.split('@')[0] === botJid.split('@')[0]) return false
    if (p.admin === 'superadmin' || p.admin === 'admin') return false
    return true
  })

  if (!targets.length) return m.reply('⚠️ No hay miembros que purgar.')

  await m.reply(`🔄 Purgando ${targets.length} miembro(s)...`)

  let removidos = 0
  let fallidos = 0

  for (const p of targets) {
    const jid = p.id || p.jid
    try {
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      removidos++
      await new Promise(r => setTimeout(r, 500))
    } catch {
      fallidos++
    }
  }

  await conn.sendMessage(
    m.chat,
    {
      text:
        `╔═══════════════╗\n` +
        `  ✦ *Purga completada*\n` +
        `╚═══════════════╝\n\n` +
        `✅ Removidos: *${removidos}*\n` +
        `❌ Fallidos:  *${fallidos}*`,
    },
    { quoted: m }
  )
}

handler.help    = ['purge', 'purgar']
handler.tags    = ['group']
handler.command = /^(purge|purgar|limpiargrupo)$/i
handler.group   = true
handler.admin   = true
handler.botAdmin = true

export default handler
