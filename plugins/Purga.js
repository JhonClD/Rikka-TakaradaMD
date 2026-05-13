import { resolveToPhoneJidAsync, isLidJid } from '../src/funcion/lid-resolver.js'

const normNum = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')

const handler = async (m, { conn }) => {
  if (!m.isGroup) return m.reply('❌ Solo en grupos.')

  const metadata     = await conn.groupMetadata(m.chat)
  const participants = metadata.participants

  // Resolver sender: si es LID → obtener el JID de teléfono real
  const rawSender  = m.sender || ''
  const senderJid  = isLidJid(rawSender)
    ? await resolveToPhoneJidAsync(rawSender, conn)
    : rawSender
  const senderNum  = normNum(senderJid)

  // Número del bot (normalizado)
  const botNum = normNum(conn.user?.id || conn.user?.jid)

  // Buscar el bot y el sender en los participantes
  const botInGroup = participants.find(p =>
    normNum(p.id) === botNum || normNum(p.lid) === botNum
  )
  const senderInGroup = participants.find(p =>
    normNum(p.id) === senderNum || normNum(p.lid) === senderNum
  )

  const isBotAdmin    = botInGroup?.admin === 'admin' || botInGroup?.admin === 'superadmin'
  const isSenderAdmin = senderInGroup?.admin === 'admin' || senderInGroup?.admin === 'superadmin'

  if (!isSenderAdmin) return m.reply('❌ Solo los administradores pueden usar este comando.')
  if (!isBotAdmin)    return m.reply('❌ El bot necesita ser administrador para expulsar miembros.')

  const targets = participants.filter(p => {
    if (normNum(p.id) === botNum || normNum(p.lid) === botNum) return false
    if (p.admin === 'superadmin' || p.admin === 'admin')        return false
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

handler.help     = ['kickall']
handler.tags     = ['group']
handler.command  = /^(kickall|purge|purgar|limpiargrupo)$/i
handler.group    = true
handler.admin    = false
handler.botAdmin = false

export default handler
