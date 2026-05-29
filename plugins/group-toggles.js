// group-toggles.js — Activar/desactivar Gacha, Economía y NSFW
// Portado de YukiBot-MD → Rikka-TakaradaMD

const handler = async (m, { conn, command, usedPrefix, args, isAdmin, isBotAdmin }) => {
  if (!m.isGroup) return m.reply('ꕥ Este comando solo funciona en grupos.');
  if (!isAdmin && !m.fromMe) return m.reply('ꕥ Solo los *administradores* pueden usar este comando.');

  const chat = global.db.data.chats[m.chat] ||= {};
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

  if (['nsfw'].includes(command)) {
    if (!isBotAdmin) return m.reply('ꕥ El bot debe ser *administrador* para activar el NSFW.');
    return toggle('nsfw', 'NSFW',
      '⚠️ Contenido adulto habilitado. Úsalo con responsabilidad.',
      'El contenido NSFW ha sido bloqueado.');
  }
};

handler.command = ['gacha', 'gacharoll', 'economy', 'economia', 'eco', 'nsfw'];
handler.tags = ['group'];
handler.group = true;

export default handler;
