const handler = async (m, { conn, args, usedPrefix, command, isAdmin, isBotAdmin, isOwner }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');
  if (!isAdmin && !isOwner) return m.reply('❌ Solo administradores pueden usar este comando.');

  const chat = global.db.data.chats[m.chat];
  const sub = args[0]?.toLowerCase();

  if (!sub) {
    const estado = chat.welcome ? '✅ Activado' : '❌ Desactivado';
    return m.reply(
      `👋 *Bienvenida/Despedida*\n\nEstado: ${estado}\n\n` +
      `• *${usedPrefix}welcome on/off* → Activar/Desactivar\n` +
      `• *${usedPrefix}welcome msg* <texto> → Mensaje de bienvenida\n  Variables: @user, @subject, @desc\n` +
      `• *${usedPrefix}welcome bye* <texto> → Mensaje de despedida\n  Variables: @user\n` +
      `• *${usedPrefix}welcome reset* → Restablecer mensajes por defecto`
    );
  }

  if (sub === 'on') {
    chat.welcome = true;
    return m.reply('✅ *Bienvenida/Despedida activada.*');
  }

  if (sub === 'off') {
    chat.welcome = false;
    return m.reply('❌ *Bienvenida/Despedida desactivada.*');
  }

  if (sub === 'msg') {
    if (!args[1]) return m.reply(`❓ Uso: *${usedPrefix}welcome msg* <texto>\nVariables: @user, @subject, @desc`);
    chat.sWelcome = args.slice(1).join(' ');
    return m.reply('✅ *Mensaje de bienvenida actualizado.*\n\n' + chat.sWelcome);
  }

  if (sub === 'bye') {
    if (!args[1]) return m.reply(`❓ Uso: *${usedPrefix}welcome bye* <texto>\nVariables: @user`);
    chat.sBye = args.slice(1).join(' ');
    return m.reply('✅ *Mensaje de despedida actualizado.*\n\n' + chat.sBye);
  }

  if (sub === 'reset') {
    chat.sWelcome = '';
    chat.sBye = '';
    return m.reply('🔄 *Mensajes restablecidos al valor por defecto.*');
  }

  throw `❓ *Uso:* ${usedPrefix}welcome <on|off|msg|bye|reset>`;
};

handler.help = ['welcome <on|off|msg|bye|reset>'];
handler.tags = ['group'];
handler.command = ['welcome', 'selamat', 'bienvenida'];
handler.group = true;

export default handler;
