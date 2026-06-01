const handler = async (m, { conn, command, usedPrefix, groupMetadata, participants }) => {
  const who = m.mentionedJid?.[0] || m.quoted?.sender
  const isProm = ['promote', 'promover'].includes(command)
  const action  = isProm ? 'promote' : 'demote'
  const whoBase = who?.split('@')[0]

  // Verificar que el bot sea admin (detección robusta por número)
  const botNum = (conn.user?.jid || conn.user?.id || '').replace(/\D/g, '')
  const botPart = participants.find(p => {
    const idNum = (p.id || p.jid || '').replace(/\D/g, '')
    const lidNum = (p.lid || '').replace(/\D/g, '')
    return botNum && (idNum === botNum || lidNum === botNum)
  })
  if (!botPart?.admin) {
    return m.reply('《✧》 El bot no es *administrador* del grupo.')
  }

  if (!who) {
    return m.reply(
      isProm
        ? '《✧》 Menciona al usuario que deseas *promover* a administrador.'
        : '《✧》 Menciona al usuario que deseas *degradar* de administrador.'
    )
  }

  const participant = participants.find(
    p => p.id?.split('@')[0] === whoBase || p.lid?.split('@')[0] === whoBase
      || (p.id || '').replace(/\D/g, '') === whoBase?.replace(/\D/g, '')
  )
  const targetJid = participant?.id || who

  if (!isProm) {
    const ownerGroup  = groupMetadata?.owner || m.chat.split('-')[0] + '@s.whatsapp.net'
    const ownerBotJid = global.owner?.map(([n]) => n.replace(/\D/g, '') + '@s.whatsapp.net')[0] || ''

    if (!participant?.admin) {
      return conn.sendMessage(m.chat, {
        text: `《✧》 *@${whoBase}* no es administrador del grupo.`,
        mentions: [who],
      }, { quoted: m })
    }
    if (targetJid === ownerGroup)
      return m.reply('《✧》 No puedes degradar al *creador del grupo*.')
    if (targetJid === ownerBotJid)
      return m.reply('《✧》 No puedes degradar al *creador del bot*.')
    if (targetJid === conn.decodeJid(conn.user.id))
      return m.reply('《✧》 No puedes degradar al *bot*.')
  } else {
    if (participant?.admin) {
      return conn.sendMessage(m.chat, {
        text: `《✧》 *@${whoBase}* ya es administrador del grupo.`,
        mentions: [who],
      }, { quoted: m })
    }
  }

  try {
    await conn.groupParticipantsUpdate(m.chat, [targetJid], action)
    await conn.sendMessage(m.chat, {
      text: isProm
        ? `✿ *@${whoBase}* ha sido *promovido* a administrador del grupo.`
        : `✿ *@${whoBase}* ha sido *degradado* de administrador del grupo.`,
      mentions: [who],
    }, { quoted: m })
  } catch (e) {
    m.reply(`> Error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`)
  }
}

handler.command  = ['promote', 'promover', 'demote', 'degradar']
handler.tags     = ['group']
handler.group    = true
handler.admin    = true
// handler.botAdmin removido — la verificación se hace adentro con detección por número

export default handler
