const HELP_MSG = (type, usedPrefix, command) =>
  `ꕤ *Set ${type === 'welcome' ? 'Welcome' : 'Goodbye'}*\n\n` +
  `*❒ Variables disponibles:*\n` +
  `𖣣ֶ ✤ ⬭ @user    → Mención del usuario\n` +
  `𖣣ֶ ✤ ⬭ @group   → Nombre del grupo\n` +
  `𖣣ֶ ✤ ⬭ @desc    → Descripción del grupo\n` +
  `𖣣ֶ ✤ ⬭ @members → Número de miembros\n` +
  `𖣣ֶ ✤ ⬭ @time    → Fecha y hora\n\n` +
  `✿ Para borrar el mensaje configurado: *${usedPrefix + command} clear*`;

const handler = async (m, { command, usedPrefix, args }) => {
  const chatId = m.chat;
  const chat   = global.db.data.chats[chatId] ||= {};
  const isWel  = command === 'setwelcome';
  const field  = isWel ? 'sWelcome' : 'sGoodbye';
  const label  = isWel ? 'bienvenida' : 'despedida';
  const type   = isWel ? 'welcome' : 'goodbye';

  if (!args.length) return m.reply(HELP_MSG(type, usedPrefix, command));

  if (args[0] === 'clear') {
    if (!chat[field]?.trim())
      return m.reply(`✎ No hay ningún mensaje de ${label} configurado.`);
    chat[field] = '';
    return m.reply(`✐ Mensaje de ${label} *eliminado*.`);
  }

  chat[field] = args.join(' ');
  return m.reply(`ꕥ Mensaje de *${label}* establecido correctamente.\n\n_Preview:_\n${chat[field]}`);
};

handler.command = ['setwelcome', 'setgoodbye'];
handler.tags    = ['group'];
handler.group   = true;
handler.admin   = true;

export default handler;
