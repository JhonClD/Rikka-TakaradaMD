/**
 * subbot-vinculacion.js — Rikka Takarada MD
 * ─────────────────────────────────────────
 * Sistema completo de sub-bots con permisos y límite configurable.
 *
 * ── COMANDOS OWNER ──────────────────────────────────────────────
 *   .enablesubbots          → Activa la función para todos los usuarios
 *   .disablesubbots         → Desactiva la función para todos
 *   .setlimitsubbots <n>    → Establece cuántos sub-bots puede tener cada usuario
 *   .subbotstatus           → Ver estado actual (activo/inactivo + límite)
 *
 * ── COMANDOS USUARIOS (requieren que owner haya activado) ────────
 *   .code <número>          → Vincula sub-bot por código de 8 dígitos
 *   .qr [número]            → Vincula sub-bot por QR (imagen en chat)
 *   .missubbots             → Lista los sub-bots que tienes vinculados
 *   .removesubbot <número>  → Elimina/desvincula uno de tus sub-bots
 *
 * ── ALMACENAMIENTO ──────────────────────────────────────────────
 *   global.db.data.settings[botJid].subbots_enabled  (boolean)
 *   global.db.data.settings[botJid].subbots_limit    (number, default 1)
 *   global.db.data.users[sender].subbot_slots        (array de números)
 */

import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { makeWASocket } from '../src/libraries/simple.js';
import fs   from 'fs';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import QRCode from 'qrcode';
import NodeCache from 'node-cache';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = join(__dirname, '..', 'jadibts');

// ── Helpers ──────────────────────────────────────────────────────────────────

const norm   = (n) => String(n).replace(/[^0-9]/g, '');
const validN = (n) => /^\d{7,15}$/.test(norm(n));
const jidBot = ()  => global.conn?.user?.jid || '';

function getSettings() {
  const jid = jidBot();
  if (!global.db.data.settings[jid]) global.db.data.settings[jid] = {};
  const s = global.db.data.settings[jid];
  if (s.subbots_enabled === undefined) s.subbots_enabled = false;
  if (s.subbots_limit   === undefined) s.subbots_limit   = 1;
  return s;
}

function getUserSlots(sender) {
  if (!global.db.data.users[sender]) global.db.data.users[sender] = {};
  const u = global.db.data.users[sender];
  if (!Array.isArray(u.subbot_slots)) u.subbot_slots = [];
  return u.subbot_slots;
}

function prepararCarpeta(numero) {
  const carpeta = join(JADIBTS_DIR, numero);
  if (!fs.existsSync(JADIBTS_DIR)) fs.mkdirSync(JADIBTS_DIR, { recursive: true });
  if (!fs.existsSync(carpeta))     fs.mkdirSync(carpeta,     { recursive: true });
  return carpeta;
}

async function generarQRBuffer(qrString) {
  return QRCode.toBuffer(qrString, {
    type: 'png', width: 512, margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

// ── Núcleo de vinculación ────────────────────────────────────────────────────

async function iniciarVinculacion(conn, m, numero, metodo, sender) {
  const carpeta = prepararCarpeta(numero);
  const { state, saveCreds } = await useMultiFileAuthState(carpeta);
  const { version }          = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache();

  let vinculado  = false;
  let codEnviado = false;
  let qrEnviado  = false;

  const opciones = {
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger:  pino({ level: 'silent' }),
    browser: ['Rikka-TakaradaMD', 'Safari', '2.0.0'],
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: '' }),
  };

  const tempConn = makeWASocket(opciones);
  tempConn.ev.on('creds.update', saveCreds);

  tempConn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── Código de vinculación ─────────────────────────────────────────────
    if (metodo === 'code' && !codEnviado && connection === 'connecting') {
      if (!tempConn.authState.creds.registered) {
        codEnviado = true;
        setTimeout(async () => {
          try {
            let codigo = await tempConn.requestPairingCode(numero);
            if (!codigo) throw new Error('Código vacío recibido');
            codigo = codigo.match(/.{1,4}/g)?.join('-') || codigo;
            await conn.sendMessage(m.chat, {
              text:
                `╭──────────────────────╮\n` +
                `│  🔐 *SUB-BOT — CÓDIGO*  │\n` +
                `╰──────────────────────╯\n\n` +
                `📱 *Número:* +${numero}\n\n` +
                `🔑 *Tu código de vinculación:*\n` +
                `┌──────────────────┐\n` +
                `│    \`${codigo}\`    │\n` +
                `└──────────────────┘\n\n` +
                `📌 *Pasos:*\n` +
                `1. Abre WhatsApp en *+${numero}*\n` +
                `2. Ve a *Dispositivos vinculados*\n` +
                `3. Pulsa *Vincular dispositivo*\n` +
                `4. Elige *Vincular con número de teléfono*\n` +
                `5. Ingresa el código de arriba\n\n` +
                `⏳ _Expira en ~60 segundos_`,
            }, { quoted: m });
          } catch (err) {
            await conn.sendMessage(m.chat, {
              text: `❌ *Error al obtener código:* ${err.message}\n_Intenta de nuevo con .code ${numero}_`,
            }, { quoted: m });
            tempConn.ev.removeAllListeners();
            try { tempConn.ws.close(); } catch (_) {}
          }
        }, 1500);
      }
    }

    // ── QR ────────────────────────────────────────────────────────────────
    if (metodo === 'qr' && qr && !qrEnviado) {
      qrEnviado = true;
      try {
        const qrBuffer = await generarQRBuffer(qr);
        await conn.sendMessage(m.chat, {
          image: qrBuffer,
          caption:
            `╭─────────────────────╮\n` +
            `│   📷 *SUB-BOT — QR*   │\n` +
            `╰─────────────────────╯\n\n` +
            `📌 *Pasos:*\n` +
            `1. Abre WhatsApp en el número a vincular\n` +
            `2. Ve a *Dispositivos vinculados*\n` +
            `3. Pulsa *Vincular dispositivo*\n` +
            `4. Escanea el QR de arriba\n\n` +
            `⏳ _El QR expira en ~60 s. Si vence, usa .qr de nuevo._`,
        }, { quoted: m });
      } catch (err) {
        await conn.sendMessage(m.chat, {
          text: `❌ *Error al generar QR:* ${err.message}`,
        }, { quoted: m });
      }
      setTimeout(() => { qrEnviado = false; }, 30_000);
    }

    // ── Conectado exitosamente ────────────────────────────────────────────
    if (connection === 'open' && !vinculado) {
      vinculado = true;
      const nombre = tempConn.user?.name || `+${numero}`;
      const jid    = tempConn.user?.id   || `${numero}@s.whatsapp.net`;

      await saveCreds();

      const slots = getUserSlots(sender);
      if (!slots.includes(numero)) slots.push(numero);

      await conn.sendMessage(m.chat, {
        text:
          `╭──────────────────────╮\n` +
          `│  ✅ *SUB-BOT VINCULADO*  │\n` +
          `╰──────────────────────╯\n\n` +
          `🤖 *Nombre:* ${nombre}\n` +
          `📱 *Número:* +${numero}\n` +
          `🆔 *JID:* ${jid}\n\n` +
          `📁 Sesión guardada en \`jadibts/${numero}/\`\n\n` +
          `🔄 _El sub-bot se activará al reiniciar el bot principal._`,
      }, { quoted: m });

      setTimeout(() => {
        tempConn.ev.removeAllListeners();
        try { tempConn.ws.close(); } catch (_) {}
      }, 3000);
    }

    // ── Cerrada / error ───────────────────────────────────────────────────
    if (connection === 'close' && !vinculado) {
      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.output?.payload?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(carpeta, { recursive: true, force: true });
        await conn.sendMessage(m.chat, {
          text: `❌ *Sesión rechazada* para +${numero}.\n_Vuelve a intentarlo._`,
        }, { quoted: m });
      } else if (!vinculado) {
        await conn.sendMessage(m.chat, {
          text:
            `⚠️ *Conexión cerrada antes de completarse.*\n` +
            `Código: \`${code || 'desconocido'}\`\n\n_Intenta de nuevo._`,
        }, { quoted: m });
      }
      tempConn.ev.removeAllListeners();
    }
  });
}

// ── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, command, args, isOwner, isROwner, usedPrefix }) => {
  const cmd      = command.toLowerCase();
  const settings = getSettings();

  // ══════════════════════════════════════════════════════════════════════════
  // COMANDOS DE OWNER
  // ══════════════════════════════════════════════════════════════════════════

  if (cmd === 'enablesubbots') {
    if (!isOwner && !isROwner) return m.reply('❌ Solo el *owner* puede usar este comando.');
    settings.subbots_enabled = true;
    return m.reply(
      `╭──────────────────────╮\n` +
      `│  ✅ *SUBBOTS ACTIVADOS*  │\n` +
      `╰──────────────────────╯\n\n` +
      `🟢 Todos los usuarios ya pueden vincular sub-bots.\n` +
      `📊 Límite actual: *${settings.subbots_limit} sub-bot(s)* por usuario.\n\n` +
      `_Cambia el límite con \`${usedPrefix}setlimitsubbots <n>\`_`
    );
  }

  if (cmd === 'disablesubbots') {
    if (!isOwner && !isROwner) return m.reply('❌ Solo el *owner* puede usar este comando.');
    settings.subbots_enabled = false;
    return m.reply(
      `╭───────────────────────╮\n` +
      `│  🔴 *SUBBOTS DESACTIVADOS* │\n` +
      `╰───────────────────────╯\n\n` +
      `Los usuarios ya no pueden vincular nuevos sub-bots.\n` +
      `_Los ya vinculados siguen funcionando normalmente._`
    );
  }

  if (cmd === 'setlimitsubbots') {
    if (!isOwner && !isROwner) return m.reply('❌ Solo el *owner* puede usar este comando.');
    const n = parseInt(args[0]);
    if (!args[0] || isNaN(n) || n < 1 || n > 50) {
      return m.reply(
        `╭──────────────────────────╮\n` +
        `│  ⚙️ *LÍMITE DE SUB-BOTS*   │\n` +
        `╰──────────────────────────╯\n\n` +
        `📌 *Uso:* \`${usedPrefix}setlimitsubbots <número>\`\n\n` +
        `*Ejemplos:*\n` +
        `• \`${usedPrefix}setlimitsubbots 1\` → 1 sub-bot por usuario\n` +
        `• \`${usedPrefix}setlimitsubbots 3\` → 3 sub-bots por usuario\n\n` +
        `_Límite actual: *${settings.subbots_limit}*_\n` +
        `_Rango: 1 — 50_`
      );
    }
    const anterior = settings.subbots_limit;
    settings.subbots_limit = n;
    return m.reply(
      `╭──────────────────────────╮\n` +
      `│  ✅ *LÍMITE ACTUALIZADO*   │\n` +
      `╰──────────────────────────╯\n\n` +
      `📊 Anterior: *${anterior}* → Nuevo: *${n}* sub-bot(s) por usuario`
    );
  }

  if (cmd === 'subbotstatus') {
    if (!isOwner && !isROwner) return m.reply('❌ Solo el *owner* puede usar este comando.');
    const estado = settings.subbots_enabled ? '🟢 *Activados*' : '🔴 *Desactivados*';
    const users  = global.db.data.users || {};
    let totalSlots = 0, usersConBot = 0;
    for (const u of Object.values(users)) {
      const s = Array.isArray(u.subbot_slots) ? u.subbot_slots.length : 0;
      if (s > 0) { usersConBot++; totalSlots += s; }
    }
    return m.reply(
      `╭──────────────────────────╮\n` +
      `│  📊 *ESTADO DE SUB-BOTS*   │\n` +
      `╰──────────────────────────╯\n\n` +
      `🔌 *Estado:* ${estado}\n` +
      `📏 *Límite por usuario:* ${settings.subbots_limit}\n\n` +
      `👥 *Usuarios con sub-bot:* ${usersConBot}\n` +
      `🤖 *Total sub-bots:* ${totalSlots}\n\n` +
      `── *Comandos* ──\n` +
      `• \`${usedPrefix}enablesubbots\`\n` +
      `• \`${usedPrefix}disablesubbots\`\n` +
      `• \`${usedPrefix}setlimitsubbots <n>\``
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMANDOS DE USUARIO
  // ══════════════════════════════════════════════════════════════════════════

  if (!settings.subbots_enabled && !isOwner && !isROwner) {
    return m.reply(
      `🔒 *La función de sub-bots está desactivada.*\n\n` +
      `_Contacta al owner del bot para activarla._`
    );
  }

  const sender = m.sender;
  const slots  = getUserSlots(sender);
  const limite = settings.subbots_limit;

  if (cmd === 'missubbots') {
    if (slots.length === 0) {
      return m.reply(
        `╭──────────────────────╮\n` +
        `│  🤖 *MIS SUB-BOTS*     │\n` +
        `╰──────────────────────╯\n\n` +
        `No tienes sub-bots vinculados aún.\n\n` +
        `📌 *Vincular:*\n` +
        `• \`${usedPrefix}code <número>\`\n` +
        `• \`${usedPrefix}qr\``
      );
    }
    const lista = slots.map((n, i) => `  ${i + 1}. +${n}`).join('\n');
    return m.reply(
      `╭──────────────────────╮\n` +
      `│  🤖 *MIS SUB-BOTS*     │\n` +
      `╰──────────────────────╯\n\n` +
      `📊 *Slots:* ${slots.length} / ${isOwner || isROwner ? '∞' : limite}\n\n` +
      `*Números vinculados:*\n${lista}\n\n` +
      `_Eliminar: \`${usedPrefix}removesubbot <número>\`_`
    );
  }

  if (cmd === 'removesubbot') {
    if (!args[0]) {
      return m.reply(
        `📌 *Uso:* \`${usedPrefix}removesubbot <número>\`\n\n` +
        `_Ver tus sub-bots: \`${usedPrefix}missubbots\`_`
      );
    }
    const numero = norm(args[0]);
    const idx    = slots.indexOf(numero);
    if (idx === -1 && !isOwner && !isROwner) {
      return m.reply(`❌ No tienes un sub-bot con el número *+${numero}*.\n_Usa \`${usedPrefix}missubbots\` para ver los tuyos._`);
    }
    if (idx !== -1) slots.splice(idx, 1);
    const carpeta = join(JADIBTS_DIR, numero);
    if (fs.existsSync(carpeta)) {
      try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch (_) {}
    }
    return m.reply(
      `╭──────────────────────╮\n` +
      `│  🗑️ *SUB-BOT ELIMINADO* │\n` +
      `╰──────────────────────╯\n\n` +
      `📱 *Número:* +${numero}\n\n` +
      `✅ Sesión eliminada. El sub-bot se desactivará al próximo reinicio.`
    );
  }

  if (cmd === 'code') {
    if (!args[0]) {
      return m.reply(
        `╭──────────────────────╮\n` +
        `│  🔐 *VINCULAR - CÓDIGO*  │\n` +
        `╰──────────────────────╯\n\n` +
        `📌 *Uso:* \`${usedPrefix}code <número>\`\n` +
        `*Ejemplo:* \`${usedPrefix}code 51925092348\`\n\n` +
        `_Slots: ${slots.length} / ${isOwner || isROwner ? '∞' : limite}_`
      );
    }
    const numero = norm(args[0]);
    if (!validN(numero)) return m.reply(`❌ *Número inválido:* \`${args[0]}\`\n_Incluye el código de país. Ej: 51925092348_`);
    if (!isOwner && !isROwner && slots.length >= limite) {
      return m.reply(
        `🚫 *Límite alcanzado.*\n\n` +
        `📊 Tienes *${slots.length}/${limite}* sub-bots.\n\n` +
        `_Elimina uno con \`${usedPrefix}removesubbot <número>\` antes de vincular otro._`
      );
    }
    if (slots.includes(numero)) return m.reply(`⚠️ Ya tienes vinculado *+${numero}*.\n_Usa \`${usedPrefix}missubbots\` para verlos._`);
    if (fs.existsSync(join(JADIBTS_DIR, numero, 'creds.json'))) {
      return m.reply(`⚠️ Ya existe sesión para +${numero}.\nUsa \`${usedPrefix}removesubbot ${numero}\` para limpiarla primero.`);
    }
    await conn.sendMessage(m.chat, {
      text: `⏳ *Iniciando vinculación por código...*\n📱 Número: +${numero}\n\n_Generando código..._`,
    }, { quoted: m });
    await iniciarVinculacion(conn, m, numero, 'code', sender);
  }

  if (cmd === 'qr') {
    const numero = args[0] ? norm(args[0]) : `tmp_${Date.now()}`;
    if (args[0] && !validN(numero)) return m.reply(`❌ *Número inválido:* \`${args[0]}\``);
    if (!isOwner && !isROwner && slots.length >= limite) {
      return m.reply(
        `🚫 *Límite alcanzado.*\n\n` +
        `📊 Tienes *${slots.length}/${limite}* sub-bots.\n\n` +
        `_Elimina uno con \`${usedPrefix}removesubbot <número>\` antes de vincular otro._`
      );
    }
    if (args[0] && slots.includes(numero)) return m.reply(`⚠️ Ya tienes vinculado *+${numero}*.\n_Usa \`${usedPrefix}missubbots\` para verlos._`);
    if (args[0] && fs.existsSync(join(JADIBTS_DIR, numero, 'creds.json'))) {
      return m.reply(`⚠️ Ya existe sesión para +${numero}.\nUsa \`${usedPrefix}removesubbot ${numero}\` para limpiarla primero.`);
    }
    await conn.sendMessage(m.chat, {
      text: `⏳ *Iniciando vinculación por QR...*\n${args[0] ? `📱 Número: +${numero}\n` : ''}\n_Generando QR..._`,
    }, { quoted: m });
    await iniciarVinculacion(conn, m, numero, 'qr', sender);
  }
};

handler.help    = ['enablesubbots', 'disablesubbots', 'setlimitsubbots <n>', 'subbotstatus', 'code <número>', 'qr [número]', 'missubbots', 'removesubbot <número>'];
handler.tags    = ['owner', 'subbot'];
handler.command = /^(enablesubbots|disablesubbots|setlimitsubbots|subbotstatus|code|qr|missubbots|removesubbot)$/i;

export default handler;
