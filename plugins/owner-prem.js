function formatTime(ms) {
  if (ms <= 0) return '0 segundos';
  const days    = Math.floor(ms / 86400000);
  const hours   = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (days)    parts.push(`${days} día${days !== 1 ? 's' : ''}`);
  if (hours)   parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`);
  if (minutes) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);
  if (seconds && !days) parts.push(`${seconds} segundo${seconds !== 1 ? 's' : ''}`);
  return parts.join(', ');
}

function parseTime(str) {
  if (!str) return null;
  const match = str.trim().match(/^(\d+)(s|min|h|d|w|m)$/i);
  if (!match) return null;
  const n    = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const table = { s: 1000, min: 60000, h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
  return n * table[unit];
}

function getTarget(m) {
  if (m.isGroup) {
    return m.mentionedJid?.[0] || m.quoted?.sender || null;
  }
  return m.chat;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const target = getTarget(m);
  const tag    = (jid) => '@' + jid.split('@')[0];

  if (command === 'checkprem') {
    if (!target) {
      return m.reply(
        `꒰ ✗ ꒱ Menciona o cita a un usuario.\n` +
        `┊ ↳ Uso: *${usedPrefix}checkprem @usuario*`
      );
    }
    const user = global.db.data.users[target];
    if (!user) {
      return m.reply(
        `꒰ ✗ ꒱ Usuario no encontrado en la base de datos.\n` +
        `┊ ↳ El usuario debe haber interactuado con el bot al menos una vez.`
      );
    }

    const now      = Date.now();
    const expiry   = user.premiumTime || 0;
    const active   = expiry > now;
    const timeLeft = active ? formatTime(expiry - now) : null;
    const expDate  = active ? new Date(expiry).toLocaleString('es-ES', { timeZone: 'America/Caracas' }) : null;

    const msg = active
      ? `꒰ ✰ ꒱ *Premium activo* ♡\n` +
        `┊ೃ ⇢ Usuario › ${tag(target)}\n` +
        `┊ ↳ Tiempo restante › *${timeLeft}*\n` +
        `┊ ↳ Vence › ${expDate}\n` +
        `╰─► ༉‧₊˚✧`
      : `꒰ ✗ ꒱ *Sin premium*\n` +
        `┊ೃ ⇢ Usuario › ${tag(target)}\n` +
        `┊ ↳ No tiene premium activo.\n` +
        `╰─► ༉‧₊˚✧`;

    return m.reply(msg, null, { mentions: [target] });
  }

  if (command === 'delprem' || command === 'removeprem') {
    if (!target) {
      return m.reply(
        `꒰ ✗ ꒱ Menciona o cita a un usuario.\n` +
        `┊ ↳ Uso: *${usedPrefix}delprem @usuario*`
      );
    }
    const user = global.db.data.users[target];
    if (!user) {
      return m.reply(
        `꒰ ✗ ꒱ Usuario no encontrado en la base de datos.`
      );
    }

    user.premium     = false;
    user.premiumTime = 0;

    const msg =
      `꒰ ✰ ꒱ *Premium removido* ✗\n` +
      `┊ೃ ⇢ Usuario › ${tag(target)}\n` +
      `┊ ↳ El premium ha sido eliminado correctamente.\n` +
      `╰─► ༉‧₊˚✧`;

    return m.reply(msg, null, { mentions: [target] });
  }

  if (!target) {
    return m.reply(
      `꒰ ✗ ꒱ Menciona o cita a un usuario.\n\n` +
      `┊ ↳ *Uso:*\n` +
      `┊ ➛ ${usedPrefix}addprem @user *30s*   (segundos)\n` +
      `┊ ➛ ${usedPrefix}addprem @user *30min* (minutos)\n` +
      `┊ ➛ ${usedPrefix}addprem @user *1h*    (horas)\n` +
      `┊ ➛ ${usedPrefix}addprem @user *7d*    (días)\n` +
      `┊ ➛ ${usedPrefix}addprem @user *2w*    (semanas)\n` +
      `┊ ➛ ${usedPrefix}addprem @user *1m*    (mes)\n` +
      `╰─► ༉‧₊˚✧`
    );
  }

  const cleanText = text.replace(/@\d+/g, '').trim();
  const duration  = parseTime(cleanText);

  if (!duration) {
    return m.reply(
      `꒰ ✗ ꒱ Duración inválida.\n\n` +
      `┊ ↳ Formato: *<número><unidad>*\n` +
      `┊ ➛ *s* = segundos  │  *min* = minutos\n` +
      `┊ ➛ *h* = horas  │  *d* = días\n` +
      `┊ ➛ *w* = semanas  │  *m* = mes\n` +
      `┊ ↳ Ejemplo: *${usedPrefix}addprem @user 30m*\n` +
      `╰─► ༉‧₊˚✧`
    );
  }

  const user = global.db.data.users[target];
  if (!user) {
    return m.reply(
      `꒰ ✗ ꒱ Usuario no encontrado en la base de datos.\n` +
      `┊ ↳ El usuario debe haber interactuado con el bot primero.`
    );
  }

  const now    = Date.now();
  const base   = (user.premiumTime && user.premiumTime > now) ? user.premiumTime : now;
  user.premiumTime = base + duration;
  user.premium     = true;

  const timeAdded  = formatTime(duration);
  const timeTotal  = formatTime(user.premiumTime - now);
  const expDate    = new Date(user.premiumTime).toLocaleString('es-ES', { timeZone: 'America/Caracas' });

  const msg =
    `꒰ ✰ ꒱ *Premium otorgado* ♡\n` +
    `┊ೃ ⇢ Usuario › ${tag(target)}\n` +
    `┊ ↳ Tiempo añadido › *${timeAdded}*\n` +
    `┊ ↳ Total restante › *${timeTotal}*\n` +
    `┊ ↳ Vence › ${expDate}\n` +
    `╰─► ༉‧₊˚✧`;

  return m.reply(msg, null, { mentions: [target] });
};

handler.help    = ['addprem @user <30s|30min|1h|7d|2w|1m>', 'delprem @user', 'checkprem @user'];
handler.tags    = ['owner'];
handler.command = ['addprem', 'delprem', 'removeprem', 'checkprem'];
handler.rowner  = true;

export default handler;
  
