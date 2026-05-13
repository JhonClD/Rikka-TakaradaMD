/**
 * subbot-code-qr.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Vinculación de Sub-Bots — Rikka-TakaradaMD             │
 * │  Comandos: .code <número>  /  .qr                       │
 * │  Solo puede ejecutarse por el owner o dueño del socket  │
 * ╰──────────────────────────────────────────────────────────╯
 */

import { startSubBot } from '../src/libraries/subsRikka.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR   = path.join(__dirname, '../jadibts');
const MAX_SUBS      = 50;
const COOLDOWN_MS   = 120_000;          // 2 minutos entre intentos
const commandFlags  = {};               // flag por sender para evitar doble envío

// ── Textos de instrucciones ──────────────────────────────────────────────────
const textoCode = (prefix) =>
`╭──── ✧ Vincular Sub-Bot ────╮
┊ ↳ Método: *Código de 8 dígitos*
┊
┊ ❁ Sigue los pasos:
┊ ⇢ Abre WhatsApp
┊ ⇢ Toca los *3 puntos* ⋅ Ajustes
┊ ⇢ *Dispositivos vinculados*
┊ ⇢ *Vincular nuevo dispositivo*
┊ ⇢ *Vincular con número*
┊
┊ ꒰ ✰ ꒱ El código aparecerá abajo
┊ ꒰ ✗ ꒱ Solo válido para el número solicitante
╰───── ❁ཻུ۪۪ ─────────────────╯`;

const textoQR = (prefix) =>
`╭──── ✧ Vincular Sub-Bot ────╮
┊ ↳ Método: *Código QR*
┊
┊ ❁ Sigue los pasos:
┊ ⇢ Abre WhatsApp
┊ ⇢ Toca los *3 puntos* ⋅ Ajustes
┊ ⇢ *Dispositivos vinculados*
┊ ⇢ *Vincular nuevo dispositivo*
┊ ⇢ Escanea el *QR* que aparecerá
┊
┊ ꒰ ✰ ꒱ No uses tu cuenta principal
┊ ꒰ ✗ ꒱ El QR expira en *60 segundos*
╰───── ❁ཻུ۪۪ ─────────────────╯`;

// ── Handler ──────────────────────────────────────────────────────────────────
const handler = async (m, { conn, isOwner, usedPrefix, command, args }) => {
  // ── Solo owner puede vincular sub-bots ──
  if (!isOwner) {
    return m.reply(
      `╰─► ✗ Solo el *owner* puede vincular sub-bots.\n` +
      `┊ Usa *${usedPrefix}code <número>* o *${usedPrefix}qr*`
    );
  }

  // ── Cooldown por usuario ──
  const now       = Date.now();
  const lastSubs  = global.db?.data?.users?.[m.sender]?.Subs || 0;
  const remaining = COOLDOWN_MS - (now - lastSubs);
  if (remaining > 0) {
    const seg = Math.ceil(remaining / 1000);
    const min = Math.floor(seg / 60);
    const s   = seg % 60;
    const tiempo = min > 0 ? `${min} min ${s} seg` : `${s} segundos`;
    return m.reply(
      `╭─ ꒰ ✗ ꒱ Espera antes de vincular ─╮\n` +
      `┊ ↳ Tiempo restante: *${tiempo}*\n` +
      `╰───── ❁ཻུ۪۪ ──────────────────────╯`
    );
  }

  // ── Límite de sub-bots ──
  if (fs.existsSync(JADIBTS_DIR)) {
    const count = fs.readdirSync(JADIBTS_DIR).filter((d) =>
      fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
    ).length;
    if (count >= MAX_SUBS) {
      return m.reply(
        `╰─► ✗ Se alcanzó el límite de *${MAX_SUBS}* sub-bots registrados.`
      );
    }
  }

  // ── Registrar flag del sender ──
  commandFlags[m.sender] = true;

  const isCode   = /^code$/i.test(command);
  const phone    = args[0]
    ? args[0].replace(/\D/g, '')
    : m.sender.split('@')[0];
  const caption  = isCode ? textoCode(usedPrefix) : textoQR(usedPrefix);

  // ── Guardar timestamp ──
  if (global.db?.data?.users?.[m.sender]) {
    global.db.data.users[m.sender].Subs = now;
  }

  await startSubBot(m, conn, caption, isCode, phone, m.chat, commandFlags, true);
};

handler.help    = ['code <número>', 'qr'];
handler.tags    = ['subbot'];
handler.command = /^(code|qr)$/i;
handler.owner   = true;

export default handler;
