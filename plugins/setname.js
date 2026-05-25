const handler = async (m, { conn, args, isOwner, usedPrefix, command }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const settings = global.db.data.settings[conn.user.jid] || {};
  const value = args.join(' ').trim();

  if (!value) return m.reply(
    `꒰ ✰ ꒱ *Set Name* ⸙͎\n` +
    `┊ ↳ Uso: *${usedPrefix + command} Corto / Nombre Largo*\n` +
    `╰─► Ejemplo: *${usedPrefix + command} Rikka / Rikka Takarada*`
  );

  const formatted = value.replace(/\s*\/\s*/g, '/');
  let [short, long] = formatted.includes('/') ? formatted.split('/') : [value, value];

  if (!short || !long) return m.reply('꒰ ✗ ꒱ Usa el formato: *Nombre Corto / Nombre Largo*');
  if (/\s/.test(short.trim())) return m.reply('꒰ ✗ ꒱ El nombre corto no puede contener espacios.');

  settings.namebot = short.trim();
  settings.botname = long.trim();
  global.db.data.settings[conn.user.jid] = settings;

  return m.reply(
    `꒰ ✰ ꒱ *Nombre actualizado* ♡\n` +
    `┊ೃ ⇢ Corto › *${short.trim()}*\n` +
    `┊ೃ ⇢ Largo › *${long.trim()}*\n` +
    `╰─► ༉‧₊˚✧`
  );
};

handler.help = ['setname <corto / largo>'];
handler.tags = ['owner'];
handler.command = ['setbotname', 'setname'];
handler.owner = true;

export default handler;
