// gacha-admin.js — Activar/desactivar gacha en el grupo
// Portado de YukiBot-MD → Rikka-TakaradaMD

const handler = async (m, { conn, command, args, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];

  const subCmd = args[0]?.toLowerCase() || command.replace('gacha', '').trim();

  if (subCmd === 'on') {
    chat.gacha = true;
    return m.reply('✩ *Gacha activado* en este grupo ❁\n↳ Comandos: *rw, c, harem, ginfo, wshop, trade...*');
  }

  if (subCmd === 'off') {
    chat.gacha = false;
    return m.reply('↳ ✗ *Gacha desactivado* en este grupo.');
  }

  const estado = chat.gacha === false ? '↳ ✗ Desactivado' : '✩ Activado ❁';
  return m.reply(`˗ˏˋ *Estado del Gacha* ˎˊ-\n⇢ ${estado}\n\n↳ *${usedPrefix}gacha on*  — activar\n↳ *${usedPrefix}gacha off* — desactivar`);
};

handler.command = ['gacha', 'gachaon', 'gachaoff'];
handler.tags    = ['gacha', 'admin'];
handler.help    = ['gacha on/off — Activar o desactivar el gacha en el grupo'];
handler.admin   = true;
handler.group   = true;

export default handler;
