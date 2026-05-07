/**
 * owner-only.js
 * Cuando está activo, el bot ignora todos los mensajes excepto los del owner.
 * El flag vive en global.soloOwnerMode (se resetea al reiniciar el bot).
 *
 * Comandos (solo owner):
 *   .soloowner on   → Activa el modo
 *   .soloowner off  → Desactiva el modo
 *   .soloowner      → Ver estado actual
 */

const handler = async (m, { isOwner, args, usedPrefix }) => {
  if (!isOwner) return m.reply('❌ Solo el *owner* puede usar este comando.');

  const sub = args[0]?.toLowerCase();

  if (!sub) {
    const estado = global.soloOwnerMode ? '✅ *Activado*' : '❌ *Desactivado*';
    return m.reply(
      `🔒 *Modo Solo Owner*\n\n` +
      `Estado: ${estado}\n\n` +
      `_Cuando está activo, el bot ignora todos los mensajes de usuarios que no sean el owner._\n\n` +
      `• *${usedPrefix}soloowner on* → Activar\n` +
      `• *${usedPrefix}soloowner off* → Desactivar`
    );
  }

  if (sub === 'on') {
    global.soloOwnerMode = true;
    return m.reply('🔒 *Modo Solo Owner activado.*\nEl bot solo responderá al owner.');
  }

  if (sub === 'off') {
    global.soloOwnerMode = false;
    return m.reply('🔓 *Modo Solo Owner desactivado.*\nEl bot responde a todos normalmente.');
  }

  throw `❓ *Uso:*\n• *${usedPrefix}soloowner on*\n• *${usedPrefix}soloowner off*\n• *${usedPrefix}soloowner* → Ver estado`;
};

// Se ejecuta en CADA mensaje antes de procesar cualquier comando.
// Si soloOwnerMode está activo y el que escribe no es owner → vaciar m.text
// para que ningún comando haga match.
handler.all = async function (m) {
  if (!global.soloOwnerMode) return;

  const ownerList = [...(global.owner || [])]
    .flat()
    .map((entry) => {
      const num = Array.isArray(entry) ? entry[0] : entry;
      return String(num).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    });

  const isOwner = ownerList.includes(m.sender) || m.fromMe;
  if (!isOwner) m.text = '';
};

handler.help    = ['soloowner <on|off>'];
handler.tags    = ['owner'];
handler.command = ['soloowner'];

export default handler;

