// subbot.js — Comandos de gestión de sub-bots
// Importa desde subBotManager.js (ahora sí exporta listSubBots y removeSubBot)

import { startSubBot, listSubBots, removeSubBot } from '../src/libraries/subBotManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS    = path.join(__dirname, '../jadibts');
const COOLDOWN   = 120000;
const cmdFlags   = {};

const cleanJid = j => String(j || '').replace(/:\d+/, '').split('@')[0];

function msToTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0
    ? m + ' minuto' + (m !== 1 ? 's' : '') + ', ' + sec + ' segundo' + (sec !== 1 ? 's' : '')
    : sec + ' segundo' + (sec !== 1 ? 's' : '');
}

const handler = async (m, { conn, command, args, usedPrefix, isOwner, isROwner }) => {
  const user = global.db.data.users[m.sender];
  if (!user) return;

  // ─── .code / .qr ─────────────────────────────────────────────────────────
  if (command === 'code' || command === 'qr') {
    const lastSub = user.Subs || 0;
    const diff    = Date.now() - lastSub;
    if (diff < COOLDOWN) {
      return m.reply('⇢ ʚ Espera *' + msToTime(COOLDOWN - diff) + '* para volver a vincular ɞ');
    }
    const { saved } = listSubBots();
    if (saved.length >= 50) {
      return m.reply('↳ ✗ No hay espacios disponibles para registrar un Sub-Bot.');
    }

    const isCode = command === 'code';
    const phone  = args[0] ? args[0].replace(/\D/g, '') : m.sender.split('@')[0];

    const capCode = '`✤` Vincula tu *cuenta* usando el *código.*\n\n> ✥ Sigue las instrucciones\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Selecciona *Vincular con el número de teléfono*\n\nꕤ *`Importante`*\n> ↳ Este código solo funciona en el número que lo solicitó';
    const capQR   = '`✤` Vincula tu *cuenta* usando *código QR.*\n\n> ✥ Sigue las instrucciones\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Escanea el código QR.\n\n> ↳ No uses tu cuenta principal.';

    cmdFlags[m.sender] = true;
    user.Subs = Date.now();
    await startSubBot(m, conn, isCode ? capCode : capQR, isCode, phone, m.chat, cmdFlags, true);
    return;
  }

  // ─── .listsub ────────────────────────────────────────────────────────────
  if (['listsub', 'listbot', 'subbots'].includes(command)) {
    const { active, saved } = listSubBots();
    if (!saved.length) return m.reply('↳ No hay sub-bots registrados aún.');
    let text = '˗ˏˋ *Sub-Bots* ˎˊ-\n⇢ Guardados: *' + saved.length + '* ˑ Activos: *' + active.length + '*\n\n';
    for (const dir of saved) {
      const on = active.some(c => c.userId === dir || (c.user && cleanJid(c.user.id) === dir));
      text += '⇢ *+' + dir + '* ➤ ' + (on ? '🟢 Conectado' : '🔴 Desconectado') + '\n';
    }
    return m.reply(text.trim());
  }

  // ─── .delsub ─────────────────────────────────────────────────────────────
  if (['delsub', 'delbot', 'removesub'].includes(command)) {
    if (!isOwner && !isROwner) return m.reply('↳ ✗ Solo el *owner* puede usar este comando.');
    const raw    = args[0] || (m.mentionedJid?.[0] || m.quoted?.sender || '');
    const target = cleanJid(raw);
    if (!target) return m.reply('⸙͎ Uso: *' + usedPrefix + 'delsub <número>*');
    if (!fs.existsSync(path.join(JADIBTS, target))) {
      return m.reply('↳ ✗ No se encontró el sub-bot *+' + target + '*.');
    }
    const ok = await removeSubBot(target);
    return m.reply(ok
      ? '✩ Sub-bot *+' + target + '* eliminado ❁'
      : '↳ ✗ No se pudo eliminar *+' + target + '*'
    );
  }

  // ─── .subreload ──────────────────────────────────────────────────────────
  if (['subreload', 'reloadsub'].includes(command)) {
    if (!isOwner && !isROwner) return m.reply('↳ ✗ Solo el *owner* puede usar este comando.');
    const { active } = listSubBots();
    if (!active.length) return m.reply('↳ No hay sub-bots activos para recargar.');
    let count = 0;
    for (const sock of active) {
      if (typeof sock.subreloadHandler === 'function') {
        await sock.subreloadHandler().catch(console.error);
        count++;
      }
    }
    return m.reply('✩ Handler recargado en *' + count + '* sub-bot' + (count !== 1 ? 's' : '') + ' ❁');
  }
};

handler.command = ['code', 'qr', 'listsub', 'listbot', 'subbots', 'delsub', 'delbot', 'removesub', 'subreload', 'reloadsub'];
handler.tags    = ['owner', 'subbot'];
handler.help    = [
  'code [número] — Vincular sub-bot con código de pareo',
  'qr — Vincular sub-bot con QR',
  'listsub — Ver sub-bots registrados',
  'delsub <número> — Eliminar un sub-bot (owner)',
  'subreload — Recargar handler en todos los sub-bots (owner)',
];

export default handler;
