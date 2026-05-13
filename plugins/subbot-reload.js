/**
 * subbot-reload.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Reconexión de Sub-Bot — Rikka-TakaradaMD               │
 * │  Comando: .reload                                        │
 * │  Solo funciona desde una instancia de sub-bot           │
 * ╰──────────────────────────────────────────────────────────╯
 */

import { startSubBot } from '../src/libraries/subsRikka.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jidDecode } from '@whiskeysockets/baileys';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');

const handler = async (m, { conn, isOwner, usedPrefix }) => {
  // ── Verificar que sea un sub-bot ──
  const rawId    = conn.user?.id || '';
  const decoded  = jidDecode(rawId);
  const cleanId  = decoded?.user || rawId.split('@')[0];

  const sessionPath = path.join(JADIBTS_DIR, cleanId);

  if (!fs.existsSync(sessionPath)) {
    return m.reply(
      `╰─► ✗ Este comando solo puede usarse desde una instancia de *sub-bot*.\n` +
      `┊ Usa *${usedPrefix}code* o *${usedPrefix}qr* para vincular uno.`
    );
  }

  if (!isOwner) {
    return m.reply('╰─► ✗ Solo el *owner* puede recargar el sub-bot.');
  }

  // ── Verificar que NO sea el bot principal ──
  const mainJid = (global.conn?.user?.jid || '').split(':')[0] + '@s.whatsapp.net';
  const thisJid = `${cleanId}@s.whatsapp.net`;

  if (thisJid === mainJid) {
    return m.reply(
      `╰─► ✗ Este comando no puede usarse en el bot *principal*.\n` +
      `┊ Solo funciona en sub-bots.`
    );
  }

  const caption =
    `╭──── ✧ Sub-Bot Reiniciado ────╮\n` +
    `┊ ↳ *${cleanId}* reconectándose\n` +
    `┊ ꒰ ✰ ꒱ La sesión se restablecerá sola\n` +
    `╰───── ❁ཻུ۪۪ ──────────────────╯`;

  await m.reply(caption);

  // Iniciar reconexión en 2 s para dar tiempo al reply
  setTimeout(() => {
    startSubBot(m, conn, caption, false, cleanId, m.chat, {}, true)
      .catch((e) => console.log(`╰─► ✗ Error reload: ${e?.message || e}`));
  }, 2_000);
};

handler.help    = ['reload'];
handler.tags    = ['subbot'];
handler.command = /^reload$/i;
handler.owner   = true;

export default handler;
