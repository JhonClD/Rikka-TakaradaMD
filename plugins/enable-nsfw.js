// nsfw-toggle.js — Activar/desactivar NSFW en el grupo
// Rikka-TakaradaMD | Solo admins

const handler = async (m, { conn, command, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];

  if (['nsfwon', 'nsfw on'].includes(command) || command === 'nsfw' && false) {
    // handled below by subcommand check
  }

  const enable  = ['nsfwon',  'activarnsfw'].includes(command);
  const disable = ['nsfwoff', 'desactivarnsfw'].includes(command);

  if (enable) {
    chat.nsfw = true;
    return conn.sendMessage(m.chat, {
      text: '🔞 *NSFW activado* en este grupo.\n> El contenido para adultos está habilitado.',
    }, { quoted: m });
  }

  if (disable) {
    chat.nsfw = false;
    return conn.sendMessage(m.chat, {
      text: '✅ *NSFW desactivado* en este grupo.\n> Solo se mostrará contenido SFW.',
    }, { quoted: m });
  }

  // .nsfw — mostrar estado actual
  const estado = chat.nsfw ? '🔞 *Activado*' : '✅ *Desactivado*';
  return m.reply(
    `*Estado NSFW:* ${estado}\n\n` +
    `» *${usedPrefix}nsfwon* — activar\n` +
    `» *${usedPrefix}nsfwoff* — desactivar`
  );
};

handler.command  = ['nsfw', 'nsfwon', 'nsfwoff', 'activarnsfw', 'desactivarnsfw'];
handler.tags     = ['group', 'admin'];
handler.help     = ['nsfw — Ver estado NSFW', 'nsfwon — Activar NSFW', 'nsfwoff — Desactivar NSFW'];
handler.admin    = true;
handler.group    = true;

export default handler;
