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

  if (['gacha', 'gacharoll'].includes(command)) {
    return toggle('gacha', 'Gacha',
      'Los usuarios ya pueden usar `.rw`, `.claim`, `.harem` y más.',
      'Los comandos de gacha están bloqueados hasta nuevo aviso.');
  }

  if (['economy', 'economia', 'eco'].includes(command)) {
    return toggle('economy', 'Economía',
      'Los usuarios ya pueden usar `.daily`, `.work`, `.balance` y más.',
      'Los comandos de economía están bloqueados hasta nuevo aviso.');
  }

  if (command === 'nsfw') {
    if (!isBotAdmin) return m.reply('ꕥ El bot debe ser *administrador* para activar el NSFW.');
    return toggle('nsfw', 'NSFW',
      '⚠️ Contenido adulto habilitado. Úsalo con responsabilidad.',
      'El contenido NSFW ha sido bloqueado.');
  }
};

handler.command = ['gacha', 'gacharoll', 'economy', 'economia', 'eco', 'nsfw'];
handler.tags = ['group'];
handler.group = true;
handler.admin = true;

export default handler;
