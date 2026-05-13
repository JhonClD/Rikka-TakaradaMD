/**
 * subbot-reload.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Reconexión de Sub-Bot — Rikka-TakaradaMD               │
 * │  Comando: .reload  /  .reload <número>                  │
 * │  Desde sub-bot: recarga su propia conexión              │
 * │  Desde bot principal: .reload <número>                  │
 * ╰──────────────────────────────────────────────────────────╯
 */

import { startSubBot } from '../src/libraries/subsRikka.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jidDecode } from '@whiskeysockets/baileys';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');

const handler = async (m, { conn, isOwner, usedPrefix, args }) => {
  if (!isOwner) {
    return m.reply('╰─► ✗ Solo el *owner* puede recargar el sub-bot.');
  }

  // ── Identificar si esta conexión ES un sub-bot ──
  const rawId   = conn.user?.id || '';
  const decoded = jidDecode(rawId);
  const cleanId = decoded?.user || rawId.split(':')[0].split('@')[0];

  const isSub = fs.existsSync(path.join(JADIBTS_DIR, cleanId));

  // ── Modo 1: desde el sub-bot mismo ──────────────────────────────────────
  if (isSub) {
    const caption =
      `╭──── ✧ Sub-Bot Reiniciado ────╮\n` +
      `┊ ↳ *${cleanId}* reconectándose\n` +
      `┊ ꒰ ✰ ꒱ La sesión se restablecerá sola\n` +
      `╰───── ❁ཻུ۪۪ ──────────────────╯`;

    await m.reply(caption);

    setTimeout(() => {
      startSubBot(m, conn, caption, false, cleanId, m.chat, {}, true)
        .catch((e) => console.log(`╰─► ✗ Error reload: ${e?.message || e}`));
    }, 2_000);

    return;
  }

  // ── Modo 2: desde el bot principal ──────────────────────────────────────
  // Requiere número como argumento: .reload <número>
  const targetNum = args[0]?.replace(/\D/g, '');

  if (!targetNum) {
    const subsDisponibles = fs.existsSync(JADIBTS_DIR)
      ? fs.readdirSync(JADIBTS_DIR).filter((d) =>
          fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
        )
      : [];

    const listaText = subsDisponibles.length
      ? `\n┊ Sub-bots registrados:\n┊ ${subsDisponibles.map((s) => `› *${s}*`).join('\n┊ ')}`
      : '\n┊ ◌ No hay sub-bots registrados.';

    return m.reply(
      `╭──── ✧ Reload Sub-Bot ────╮\n` +
      `┊ ↳ Uso: *${usedPrefix}reload <número>*\n` +
      `┊ Ej:  *${usedPrefix}reload 51999888777*` +
      listaText +
      `\n╰───── ❁ཻུ۪۪ ──────────────╯`
    );
  }

  if (!fs.existsSync(path.join(JADIBTS_DIR, targetNum))) {
    return m.reply(
      `╰─► ✗ No existe sesión registrada para *${targetNum}*.\n` +
      `┊ Usa *${usedPrefix}code <número>* para vincularlo.`
    );
  }

  // Verificar que no sea el bot principal
  const mainId = (global.conn?.user?.jid || global.conn?.user?.id || '')
    .replace(/:\d+/, '').split('@')[0];

  if (targetNum === mainId) {
    return m.reply(
      `╰─► ✗ No puedes usar *reload* en el bot *principal*.\n` +
      `┊ Solo funciona en sub-bots.`
    );
  }

  // Desconectar socket activo si existe
  const subSock = (global.conns || []).find(
    (c) => (c.userId || '').replace(/\D/g, '') === targetNum
  );

  if (subSock) {
    try {
      subSock.isInit = false;
      subSock.ws?.close();
    } catch {}
    // Remover de conns para que startSubBot lo registre de nuevo
    const idx = global.conns.indexOf(subSock);
    if (idx >= 0) global.conns.splice(idx, 1);
  }

  const caption =
    `╭──── ✧ Sub-Bot Reiniciado ────╮\n` +
    `┊ ↳ *${targetNum}* reconectándose\n` +
    `┊ ꒰ ✰ ꒱ La sesión se restablecerá sola\n` +
    `╰───── ❁ཻུ۪۪ ──────────────────╯`;

  await m.reply(caption);

  setTimeout(() => {
    startSubBot(null, null, caption, false, targetNum, null, {}, false)
      .catch((e) => console.log(`╰─► ✗ Error reload: ${e?.message || e}`));
  }, 2_000);
};

handler.help    = ['reload', 'reload <número>'];
handler.tags    = ['subbot'];
handler.command = /^reload$/i;
handler.owner   = true;

export default handler;
