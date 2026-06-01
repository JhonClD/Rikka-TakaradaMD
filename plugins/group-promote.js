const handler = async (m, { conn, command, usedPrefix, groupMetadata, participants }) => {
  const who = m.mentionedJid?.[0] || m.quoted?.sender;
  const isProm = ['promote', 'promover'].includes(command);
  const action  = isProm ? 'promote' : 'demote';
  const whoBase = who?.split('@')[0];

  if (!who) {
    return m.reply(
      isProm
        ? '《✧》 Menciona al usuario que deseas *promover* a administrador.'
        : '《✧》 Menciona al usuario que deseas *degradar* de administrador.'
    );
  }

  const participant = participants.find(
    p => p.id?.split('@')[0] === whoBase || p.lid?.split('@')[0] === whoBase
  );
  const targetJid = participant?.id || who;

  if (!isProm) {

    const ownerGroup  = groupMetadata?.owner || m.chat.split('-')[0] + '@s.whatsapp.net';
    const ownerBotJid = global.owner?.map(([n]) => n.replace(/\D/g, '') + '@s.whatsapp.net')[0] || '';

    if (!participant?.admin) {
      return conn.sendMessage(m.chat, {
        text: `《✧》 *@${whoBase}* no es administrador del grupo.`,
        mentions: [who],
      }, { quoted: m });
    }
    if (targetJid === ownerGroup)
      return m.reply('《✧》 No puedes degradar al *creador del grupo*.');
    if (targetJid === ownerBotJid)
      return m.reply('《✧》 No puedes degradar al *creador del bot*.');
    if (targetJid === conn.decodeJid(conn.user.id))
      return m.reply('《✧》 No puedes degradar al *bot*.');
  } else {

    if (participant?.admin) {
      return conn.sendMessage(m.chat, {
        text: `《✧》 *@${whoBase}* ya es administrador del grupo.`,
        mentions: [who],
      }, { quoted: m });
    }
  }

  try {
    await conn.groupParticipantsUpdate(m.chat, [targetJid], action);
    await conn.sendMessage(m.chat, {
      text: isProm
        ? `✿ *@${whoBase}* ha sido *promovido* a administrador del grupo.`
        : `✿ *@${whoBase}* ha sido *degradado* de administrador del grupo.`,
      mentions: [who],
    }, { quoted: m });
  } catch (e) {
    m.reply(`> Error al ejecutar *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
  }
};

handler.command  = ['promote', 'promover', 'demote', 'degradar'];
handler.tags     = ['group'];
handler.group    = true;
handler.admin    = true;
handler.botAdmin = true;

export default handler;
