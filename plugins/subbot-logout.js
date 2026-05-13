/**
 * subbot-logout.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Cierre de sesión de Sub-Bot — Rikka-TakaradaMD         │
 * │  Comando: .logout                                        │
 * │  Solo funciona desde una instancia de sub-bot           │
 * ╰──────────────────────────────────────────────────────────╯
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jidDecode } from '@whiskeysockets/baileys';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');

const handler = async (m, { conn, isOwner, usedPrefix }) => {
  // ── Identificar si esta conexión ES un sub-bot ──
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
    return m.reply('╰─► ✗ Solo el *owner* puede cerrar la sesión del sub-bot.');
  }

  try {
    await m.reply(
      `╭──── ✧ Cerrando Sub-Bot ────╮\n` +
      `┊ ↳ Sesión: *${cleanId}*\n` +
      `┊ ↳ Estado: cerrando...\n` +
      `╰───── ❁ཻུ۪۪ ──────────────╯`
    );

    await conn.logout();

    setTimeout(() => {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`╰─► ✗ Sesión de ${cleanId} eliminada.`);
      }

      // Remover de global.conns
      if (global.conns) {
        const idx = global.conns.findIndex((c) => c.userId === cleanId);
        if (idx >= 0) global.conns.splice(idx, 1);
      }
    }, 2_000);

    setTimeout(async () => {
      try {
        await m.reply(
          `╭──── ✧ Sesión Finalizada ────╮\n` +
          `┊ ↳ *${cleanId}* desvinculado\n` +
          `┊ ꒰ ✰ ꒱ Usa *${usedPrefix}code* para reconectar\n` +
          `╰───── ❁ཻུ۪۪ ──────────────╯`
        );
      } catch {}
    }, 3_000);

  } catch (e) {
    await m.reply(`╰─► ✗ Error al cerrar sesión:\n┊ _${e.message}_`);
  }
};

handler.help    = ['logout'];
handler.tags    = ['subbot'];
handler.command = /^logout$/i;
handler.owner   = true;

export default handler;
