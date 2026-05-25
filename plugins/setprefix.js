const handler = async (m, { conn, args, isOwner, usedPrefix, command }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const settings = global.db.data.settings[conn.user.jid] || {};
  const value = args.join(' ').trim();
  const defaultPrefix = ['#', '/', '!', '.'];

  if (!value) {
    const lista = settings.prefix === null
      ? '`sin prefijos`'
      : (Array.isArray(settings.prefix) ? settings.prefix : [settings.prefix || '/']).map(p => `\`${p}\``).join(', ');
    return m.reply(
      `꒰ ✰ ꒱ *Set Prefix* ⸙͎\n` +
      `┊ೃ ⇢ Prefijo actual › ${lista}\n\n` +
      `┊ ↳ Métodos disponibles:\n` +
      `┊ ➛ *Only-Prefix* › ${usedPrefix + command} *.*\n` +
      `┊ ➛ *Multi-Prefix* › ${usedPrefix + command} *!/.#*\n` +
      `┊ ➛ *No-Prefix* › ${usedPrefix + command} *noprefix*\n` +
      `┊ ➛ *Reset* › ${usedPrefix + command} *reset*\n` +
      `╰─► ༉‧₊˚✧`
    );
  }

  if (value.toLowerCase() === 'reset') {
    settings.prefix = defaultPrefix;
    global.db.data.settings[conn.user.jid] = settings;
    return m.reply(`╰─► ✰ Prefijos restaurados › *${defaultPrefix.join(' ')}* ༉‧₊˚✧`);
  }

  if (value.toLowerCase() === 'noprefix') {
    settings.prefix = true;
    global.db.data.settings[conn.user.jid] = settings;
    return m.reply('╰─► ✰ Modo *sin prefijos* activado ♡\n┊ ↳ El bot responderá a comandos sin prefijos.');
  }

  // Usa Intl.Segmenter nativo (Node 16+) — sin dependencias externas
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(value)].map(s => s.segment);
  const lista = [];
  for (const g of graphemes) {
    if (/^[a-zA-Z]+$/.test(g)) continue;
    if (!lista.includes(g)) lista.push(g);
  }

  if (lista.length === 0) return m.reply('꒰ ✗ ꒱ No se detectaron prefijos válidos. Incluye al menos un símbolo o emoji.');
  if (lista.length > 6) return m.reply('꒰ ✗ ꒱ Máximo 6 prefijos permitidos.');

  settings.prefix = lista;
  global.db.data.settings[conn.user.jid] = settings;
  return m.reply(
    `꒰ ✰ ꒱ *Prefijo actualizado* ♡\n` +
    `┊ೃ ⇢ Nuevo prefijo › *${lista.join(' ')}*\n` +
    `╰─► ༉‧₊˚✧`
  );
};

handler.help = ['setprefix <prefijo|noprefix|reset>'];
handler.tags = ['owner'];
handler.command = ['setprefix', 'setbotprefix'];
handler.owner = true;

export default handler;
