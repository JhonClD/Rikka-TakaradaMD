/**
 * subbot-setowner.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Asignar dueño de Sub-Bot — Rikka-TakaradaMD            │
 * │  Comando: .setbotowner / .setowner                      │
 * │  Permite delegar control del sub-bot a otro usuario     │
 * ╰──────────────────────────────────────────────────────────╯
 */

import { resolveToPhoneJid } from '../src/funcion/lid-resolver.js';

const handler = async (m, { conn, isOwner, isROwner, usedPrefix, command, args }) => {
  const botJid    = `${(conn.user?.jid || conn.user?.id || '').split(':')[0].split('@')[0]}@s.whatsapp.net`;
  const config    = global.db?.data?.settings?.[botJid];

  if (!config) {
    return m.reply('╰─► ✗ No se encontró configuración del bot en la base de datos.');
  }

  // ── Verificar si el caller es owner real o dueño asignado del bot ──
  const assignedOwner = config.owner || '';
  const callerIsOwner =
    isROwner ||
    isOwner  ||
    (assignedOwner && m.sender === assignedOwner);

  if (!callerIsOwner) {
    return m.reply('╰─► ✗ Solo el *owner* o el dueño asignado puede usar este comando.');
  }

  const text = args.join(' ').trim();

  // ── Borrar dueño asignado ──
  if (text.toLowerCase() === 'clear') {
    if (!assignedOwner) {
      return m.reply('╰─► ◌ No hay ningún propietario asignado actualmente.');
    }
    config.owner = '';
    return m.reply(
      `╭──── ✧ Propietario Eliminado ────╮\n` +
      `┊ ↳ Se eliminó el dueño de *${config.namebot || 'Sub-Bot'}*\n` +
      `╰───── ❁ཻུ۪۪ ──────────────────────╯`
    );
  }

  // ── Resolver quién se menciona ──
  const mentioned = m.mentionedJid || [];
  let rawTarget = mentioned.length > 0
    ? mentioned[0]
    : m.quoted?.sender || null;

  // Intentar resolver LID → phone
  if (rawTarget) {
    rawTarget = resolveToPhoneJid(rawTarget, conn) || rawTarget;
  }

  // Fallback: número en el texto
  const limpio = text.replace(/[^0-9]/g, '');
  const nuevo  = rawTarget || (limpio.length >= 10 ? `${limpio}@s.whatsapp.net` : null);

  // ── Si ya hay dueño y no se indicó a quién cambiar ──
  if (assignedOwner && !nuevo) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `╭──── ✧ Dueño actual ────╮\n` +
          `┊ ↳ *${config.namebot || 'Sub-Bot'}*\n` +
          `┊ ⸙ @${assignedOwner.split('@')[0]}\n` +
          `┊\n` +
          `┊ ꒰ ✰ ꒱ Para cambiar:\n` +
          `┊   *${usedPrefix + command}* @usuario\n` +
          `┊ ꒰ ✗ ꒱ Para eliminar:\n` +
          `┊   *${usedPrefix + command} clear*\n` +
          `╰───── ❁ཻུ۪۪ ──────────────╯`,
        mentions: [assignedOwner],
      },
      { quoted: m }
    );
  }

  if (!nuevo) {
    return conn.sendMessage(
      m.chat,
      {
        text:
          `╰─► ✗ Menciona o ingresa el número del nuevo dueño.\n` +
          `┊ Ej: *${usedPrefix + command}* @usuario`,
      },
      { quoted: m }
    );
  }

  const ownerAnterior = assignedOwner ? assignedOwner.split('@')[0] : null;
  const ownerNuevo    = nuevo.split('@')[0];

  config.owner = nuevo;

  const texto = ownerAnterior && ownerAnterior !== ownerNuevo
    ? `╭──── ✧ Dueño Actualizado ────╮\n` +
      `┊ ↳ Bot: *${config.namebot || 'Sub-Bot'}*\n` +
      `┊ ⇢ Antes: @${ownerAnterior}\n` +
      `┊ ⇢ Ahora: @${ownerNuevo}\n` +
      `╰───── ❁ཻུ۪۪ ──────────────────╯`
    : `╭──── ✧ Dueño Asignado ────╮\n` +
      `┊ ↳ Bot: *${config.namebot || 'Sub-Bot'}*\n` +
      `┊ ⸙ Nuevo dueño: @${ownerNuevo}\n` +
      `╰───── ❁ཻུ۪۪ ──────────────╯`;

  const mentions = [nuevo, ...(ownerAnterior && ownerAnterior !== ownerNuevo ? [assignedOwner] : [])];

  await conn.sendMessage(m.chat, { text: texto, mentions }, { quoted: m });
};

handler.help    = ['setbotowner <@usuario>', 'setowner <@usuario>'];
handler.tags    = ['subbot'];
handler.command = /^(setbotowner|setowner)$/i;
handler.owner   = true;

export default handler;
