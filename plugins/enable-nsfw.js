const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];

  if (text.toLowerCase() === 'on') {
    if (chat.nsfw) return m.reply('🔞 *El sistema NSFW ya está activado.*');
    chat.nsfw = true;
    return conn.sendMessage(m.chat, {
      text: '🔞 *NSFW activado* en este grupo.\n> Contenido adulto habilitado.',
    }, { quoted: m });
  }

  if (text.toLowerCase() === 'off') {
    if (!chat.nsfw) return m.reply('✅ *El sistema NSFW ya está desactivado.*');
    chat.nsfw = false;
    return conn.sendMessage(m.chat, {
      text: '✅ *NSFW desactivado* en este grupo.\n> Solo contenido SFW.',
    }, { quoted: m });
  }

  const estado = chat.nsfw ? '🔞 *Activado*' : '✅ *Desactivado*';
  return m.reply(
    `*Configuración NSFW*\n\n` +
    `» *Estado:* ${estado}\n\n` +
    `Uso:\n` +
    `» *${usedPrefix + command} on*\n` +
    `» *${usedPrefix + command} off*`
  );
};

handler.command = ['nsfw'];
handler.tags = ['admin'];
handler.help = ['nsfw on', 'nsfw off'];
handler.admin = true;
handler.group = true;

export default handler;
