/**
 * subbot-logout.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Cierre de sesión de Sub-Bot — Rikka-TakaradaMD         │
 * │  Comando: .logout  /  .logout <número>                  │
 * │  Desde sub-bot: cierra su propia sesión                 │
 * │  Desde bot principal: .logout <número> para un sub-bot  │
 * ╰──────────────────────────────────────────────────────────╯
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jidDecode } from '@whiskeysockets/baileys';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');

const handler = async (m, { conn, isOwner, usedPrefix, args }) => {
  if (!isOwner) {
    return m.reply('╰─► ✗ Solo el *owner* puede cerrar la sesión del sub-bot.');
  }

  // ── Identificar si esta conexión ES un sub-bot ──
  const rawId   = conn.user?.id || '';
  const decoded = jidDecode(rawId);
  const cleanId = decoded?.user || rawId.split(':')[0].split('@')[0];

  const isSub = fs.existsSync(path.join(JADIBTS_DIR, cleanId));

  // ── Modo 1: comando enviado DESDE el sub-bot mismo ──────────────────────
  if (isSub) {
    return _logoutSub(m, conn, cleanId, usedPrefix);
  }

  // ── Modo 2: comando enviado DESDE el bot principal ───────────────────────
  // Requiere número como argumento: .logout <número>
  const targetNum = args[0]?.replace(/\D/g, '');

  if (!targetNum) {
    // Mostrar lista de sub-bots disponibles para orientar al usuario
    const subsDisponibles = fs.existsSync(JADIBTS_DIR)
      ? fs.readdirSync(JADIBTS_DIR).filter((d) =>
          fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
        )
      : [];

    const listaText = subsDisponibles.length
      ? `\n┊ Sub-bots registrados:\n┊ ${subsDisponibles.map((s) => `› *${s}*`).join('\n┊ ')}`
      : '\n┊ ◌ No hay sub-bots registrados.';

    return m.reply(
      `╭──── ✧ Logout Sub-Bot ────╮\n` +
      `┊ ↳ Uso: *${usedPrefix}logout <número>*\n` +
      `┊ Ej:  *${usedPrefix}logout 51999888777*` +
      listaText +
      `\n╰───── ❁ཻུ۪۪ ──────────────╯`
    );
  }

  if (!fs.existsSync(path.join(JADIBTS_DIR, targetNum))) {
    return m.reply(
      `╰─► ✗ No existe sesión registrada para *${targetNum}*.\n` +
      `┊ Usa *${usedPrefix}bots* para ver los sub-bots activos.`
    );
  }

  // Buscar el socket activo del sub-bot en global.conns
  const subSock = (global.conns || []).find(
    (c) => (c.userId || '').replace(/\D/g, '') === targetNum
  );

  if (!subSock) {
    // Sesión existe en disco pero no hay socket activo → borrar carpeta
    await m.reply(
      `╭──── ✧ Limpiando Sub-Bot ────╮\n` +
      `┊ ↳ *${targetNum}* no tiene socket activo\n` +
      `┊ ↳ Eliminando sesión del disco...\n` +
      `╰───── ❁ཻུ۪۪ ──────────────╯`
    );
    try {
      fs.rmSync(path.join(JADIBTS_DIR, targetNum), { recursive: true, force: true });
    } catch (e) {
      await m.reply(`╰─► ✗ Error al eliminar sesión:\n┊ _${e.message}_`);
    }
    return;
  }

  // Sub-bot con socket activo → hacer logout limpio
  return _logoutSub(m, subSock, targetNum, usedPrefix, true);
};

// ── Función interna de logout ────────────────────────────────────────────────
async function _logoutSub(m, sockToLogout, cleanId, usedPrefix, fromMain = false) {
  const sessionPath = path.join(JADIBTS_DIR, cleanId);

  try {
    await m.reply(
      `╭──── ✧ Cerrando Sub-Bot ────╮\n` +
      `┊ ↳ Sesión: *${cleanId}*\n` +
      `┊ ↳ Estado: cerrando...\n` +
      `╰───── ❁ཻུ۪۪ ──────────────╯`
    );

    // Marcar como inactivo antes del logout para evitar reconexión automática
    sockToLogout.isInit = false;

    await sockToLogout.logout();

    setTimeout(() => {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`╰─► ✗ Sesión de ${cleanId} eliminada.`);
      }

      // Remover de global.conns
      if (global.conns) {
        const idx = global.conns.findIndex(
          (c) => (c.userId || '').replace(/\D/g, '') === cleanId.replace(/\D/g, '')
        );
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
}

handler.help    = ['logout', 'logout <número>'];
handler.tags    = ['subbot'];
handler.command = /^logout$/i;
handler.owner   = true;

export default handler;
