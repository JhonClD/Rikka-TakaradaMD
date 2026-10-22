const handler = async (m, { conn, command, usedPrefix, args, isAdmin, isBotAdmin }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];
  const sub = (args[0] || '').toLowerCase();

  const toggle = (field, label, onMsg, offMsg) => {
    if (sub === 'on') {
      chat[field] = true;
      return m.reply(`✿ *${label}* activado en este grupo.\n> ${onMsg}`);
    } else if (sub === 'off') {
      chat[field] = false;
      return m.reply(`✿ *${label}* desactivado en este grupo.\n> ${offMsg}`);
    } else {
      const estado = chat[field] ? '✅ Activado' : '❌ Desactivado';
      return m.reply(`❀ Estado de *${label}*: ${estado}\n> Usa *${usedPrefix}${command} on/off* para cambiarlo.`);
    }
  };

  if (['economy', 'economia', 'eco'].includes(command)) {
    return toggle('economy', 'Economía',
      'Los usuarios ya pueden usar `.daily`, `.work`, `.balance` y más.',
      'Los comandos de economía están bloqueados hasta nuevo aviso.');
  }

};

handler.command = ['economy', 'economia', 'eco'];
handler.tags = ['group'];
handler.group = true;
handler.admin = true;

export default handler;
