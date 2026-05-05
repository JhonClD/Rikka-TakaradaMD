// subbot.js — Comandos de gestión de sub-bots
// Portado de YukiBot-MD → Rikka-TakaradaMD
// Comandos: .code, .qr, .listsub, .delsub, .subreload

import { startSubBot, listSubBots, removeSubBot } from '../src/libraries/subBotManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');
const COOLDOWN_MS = 120_000; // 2 minutos entre intentos
const MAX_SUBS    = 50;

// Flags por usuario para evitar doble solicitud simultánea
const commandFlags = {};

function msToTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  if (m > 0) return `${m} minuto${m !== 1 ? 's' : ''}, ${sec} segundo${sec !== 1 ? 's' : ''}`;
  return `${sec} segundo${sec !== 1 ? 's' : ''}`;
}

const handler = async (m, { conn, command, args, usedPrefix, isOwner, isROwner }) => {
  const user = global.db.data.users[m.sender];

  // ─── .code / .qr ─────────────────────────────────────────────────────────
  if (['code', 'qr'].includes(command)) {
    // Cooldown por usuario
    const lastSub = user.Subs || 0;
    const diff    = Date.now() - lastSub;
    if (diff < COOLDOWN_MS) {
      return m.reply(`ꕥ Debes esperar *${msToTime(COOLDOWN_MS - diff)}* para volver a vincular un socket.`);
    }

    // Límite máximo de sub-bots
    const saved = fs.existsSync(JADIBTS_DIR)
      ? fs.readdirSync(JADIBTS_DIR).filter((d) => fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))).length
      : 0;
    if (saved >= MAX_SUBS) {
      return m.reply('✐ No hay espacios disponibles para registrar un `Sub-Bot`.');
    }

    const isCode  = command === 'code';
    const phone   = args[0] ? args[0].replace(/\D/g, '') : m.sender.split('@')[0];

    const captionCode = `\`✤\` Vincula tu *cuenta* usando el *código.*\n\n> ✥ Sigue las *instrucciones*\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Selecciona *Vincular con el número de teléfono*\n\nꕤ *\`Importante\`*\n> ₊·( 🜸 ) ➭ Este *Código* solo funciona en el *número que lo solicitó*`;

    const captionQR = `\`✤\` Vincula tu *cuenta* usando *código QR.*\n\n> ✥ Sigue las *instrucciones*\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Escanea el código *QR.*\n\n> ₊·( 🜸 ) ➭ No es recomendable usar tu cuenta principal para registrar un socket.`;

    commandFlags[m.sender] = true;
    user.Subs = Date.now();

    await startSubBot(m, conn, isCode ? captionCode : captionQR, isCode, phone, m.chat, commandFlags, true);
    return;
  }

  // ─── .listsub ─────────────────────────────────────────────────────────────
  if (['listsub', 'listbot', 'subbots'].includes(command)) {
    const { active, saved } = listSubBots();

    if (!saved.length) return m.reply('ꕥ No hay sub-bots registrados.');

    let text = `*✿ Lista de Sub-Bots*\n\n`;
    text += `❏ Guardados: *${saved.length}* | Activos: *${active.length}*\n\n`;

    for (const dir of saved) {
      const isActive = active.some((c) => c.userId === dir);
      const status   = isActive ? '🟢 Conectado' : '🔴 Desconectado';
      text += `» *+${dir}* — ${status}\n`;
    }

    return m.reply(text.trim());
  }

  // ─── .delsub ─────────────────────────────────────────────────────────────
  if (['delsub', 'delbot', 'removesub'].includes(command)) {
    if (!isOwner && !isROwner) return m.reply('ꕥ Solo el *owner* puede usar este comando.');

    const target = args[0]
      ? args[0].replace(/\D/g, '')
      : (m.mentionedJid?.[0] || m.quoted?.sender || '').split('@')[0];

    if (!target) return m.reply(`❀ Uso: *${usedPrefix}delsub <número>*`);

    const sessionPath = path.join(JADIBTS_DIR, target);
    if (!fs.existsSync(sessionPath)) {
      return m.reply(`ꕥ No se encontró el sub-bot *+${target}*.`);
    }

    const removed = await removeSubBot(target);
    if (removed) {
      return m.reply(`✅ Sub-bot *+${target}* desconectado y sesión eliminada.`);
    } else {
      return m.reply(`❌ No se pudo eliminar el sub-bot *+${target}*.`);
    }
  }

  // ─── .subreload ───────────────────────────────────────────────────────────
  if (['subreload', 'reloadsub'].includes(command)) {
    if (!isOwner && !isROwner) return m.reply('ꕥ Solo el *owner* puede usar este comando.');

    const { active } = listSubBots();
    if (!active.length) return m.reply('ꕥ No hay sub-bots activos para recargar.');

    let count = 0;
    for (const sock of active) {
      if (typeof sock.subreloadHandler === 'function') {
        await sock.subreloadHandler(false).catch(console.error);
        count++;
      }
    }
    return m.reply(`✅ Handler recargado en *${count}* sub-bot${count !== 1 ? 's' : ''}.`);
  }
};

handler.command = ['code', 'qr', 'listsub', 'listbot', 'subbots', 'delsub', 'delbot', 'removesub', 'subreload', 'reloadsub'];
handler.tags    = ['owner', 'subbot'];
handler.help    = [
  'code [número] — Vincular sub-bot con código de pareo',
  'qr — Vincular sub-bot con QR',
  'listsub — Ver sub-bots registrados',
  'delsub <número> — Eliminar un sub-bot',
  'subreload — Recargar handler en todos los sub-bots',
];

export default handler;
