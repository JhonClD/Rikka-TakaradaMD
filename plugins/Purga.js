const norm = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')

const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  const metadata    = await conn.groupMetadata(m.chat)
  const participants = metadata.participants

  const botNum    = norm(conn.user?.id || conn.user?.jid)
  const senderNum = norm(m.sender)

  const botInGroup    = participants.find(p => norm(p.id) === botNum || norm(p.lid) === botNum)
  const senderInGroup = participants.find(p => norm(p.id) === senderNum || norm(p.lid) === senderNum)

  const isBotAdmin    = botInGroup?.admin === 'admin' || botInGroup?.admin === 'superadmin'
  const isSenderAdmin = senderInGroup?.admin === 'admin' || senderInGroup?.admin === 'superadmin'

  if (!isSenderAdmin) return m.reply('❌ Solo los administradores pueden usar este comando.')
  if (!isBotAdmin)    return m.reply('❌ El bot necesita ser administrador para expulsar miembros.')

  const targets = participants.filter(p => {
    if (norm(p.id) === botNum || norm(p.lid) === botNum) return false
    if (p.admin === 'superadmin' || p.admin === 'admin')  return false
    return true
  })

  if (!targets.length) return m.reply('⚠️ No hay miembros comunes para purgar.')

  await m.reply(`🔄 Iniciando purga de *${targets.length}* miembro(s)...`)

  let removidos = 0
  let fallidos  = 0

  for (const p of targets) {
    try {
      await conn.groupParticipantsUpdate(m.chat, [p.id], 'remove')
      removidos++
      await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
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

handler.help    = ['kickall']
handler.tags    = ['group']
handler.command = /^(kickall|purge|purgar|limpiargrupo)$/i
handler.group   = true
handler.admin   = false
handler.botAdmin = false

export default handler
