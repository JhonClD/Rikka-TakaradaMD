/**
 * subsRikka.js
 * ╭──────────────────────────────────────────────╮
 * │  Sistema de Sub-Bots — Rikka-TakaradaMD      │
 * │  Basado en la arquitectura de YukiBot-MD      │
 * │  Carpeta de sesiones: ./jadibts/              │
 * ╰──────────────────────────────────────────────╯
 */

import { makeWASocket } from './simple.js';
import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidDecode,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import NodeCache from 'node-cache';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Constantes ──────────────────────────────────────────────────────────────
const JADIBTS_DIR = path.join(__dirname, '../../jadibts');
const MAX_RETRIES  = 5;
const RETRY_DELAY  = 3000;

// ── Estado global ────────────────────────────────────────────────────────────
if (!global.conns || !Array.isArray(global.conns)) global.conns = [];
const reintentos = {};

const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const userDevicesCache     = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const groupCache           = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

const cleanJid = (jid = '') => jid.replace(/:\d+/, '').split('@')[0];
const delay    = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Carga automática al iniciar ──────────────────────────────────────────────
export async function initializeSubBots() {
  if (!fs.existsSync(JADIBTS_DIR)) {
    console.log(chalk.gray('╰─► ⸙ No hay sub-bots previos en ./jadibts/'));
    return;
  }
  const botIds = fs.readdirSync(JADIBTS_DIR);
  if (!botIds.length) {
    console.log(chalk.gray('╰─► ⸙ No se encontraron sesiones en ./jadibts/'));
    return;
  }
  for (const userId of botIds) {
    const credsPath = path.join(JADIBTS_DIR, userId, 'creds.json');
    if (!fs.existsSync(credsPath)) continue;
    if (global.conns.some((c) => c.userId === userId)) continue;
    try {
      console.log(chalk.hex('#dec0f1')(`╰─► ✧ Reconectando sub-bot: ${userId}`));
      await startSubBot(null, null, '✧ Auto-reconexión', false, userId, null, {}, false);
    } catch (e) {
      console.log(chalk.gray(`╰─► ✗ Error al iniciar sub-bot ${userId}: ${e?.message || e}`));
    }
    await delay(2500);
  }
}

// ── Función principal ────────────────────────────────────────────────────────
/**
 * @param {object|null}  m             - Mensaje de contexto (puede ser null en autoload)
 * @param {object|null}  client        - Conexión principal (puede ser null en autoload)
 * @param {string}       caption       - Texto a enviar con el QR / código
 * @param {boolean}      isCode        - true = pairing code, false = QR
 * @param {string}       phone         - Número de teléfono del sub-bot
 * @param {string|null}  chatId        - Chat donde enviar el QR/código
 * @param {object}       commandFlags  - Registro de flags por sender
 * @param {boolean}      isCommand     - Si fue invocado por comando de usuario
 */
export async function startSubBot(
  m,
  client,
  caption = '',
  isCode  = false,
  phone   = '',
  chatId  = null,
  commandFlags = {},
  isCommand = false
) {
  const id            = phone || (m?.sender || '').split('@')[0];
  const sessionFolder = path.join(JADIBTS_DIR, id);
  const senderId      = m?.sender;

  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version }          = await fetchLatestBaileysVersion();

  console.info = () => {};

  const sock = makeWASocket({
    version,
    logger:                    pino({ level: 'silent' }),
    printQRInTerminal:         false,
    browser:                   ['Rikka-TakaradaMD', 'Safari', '2.0.0'],
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    markOnlineOnConnect:       true,
    generateHighQualityLinkPreview: true,
    syncFullHistory:           false,
    getMessage:                async () => '',
    msgRetryCounterCache,
    userDevicesCache,
    cachedGroupMetadata:       async (jid) => groupCache.get(jid),
    keepAliveIntervalMs:       60_000,
    maxIdleTimeMs:             120_000,
  });

  sock.isInit  = false;
  sock.uptime  = Date.now();

  sock.ev.on('creds.update', saveCreds);

  // ── Evento de conexión ──────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, isNewLogin, qr }) => {
    if (isNewLogin) sock.isInit = false;

    // ── Conectado ───────────────────────────────────────────────────────
    if (connection === 'open') {
      sock.uptime  = Date.now();
      sock.isInit  = true;
      sock.userId  = cleanJid(sock.user?.id || '');

      const botDir = `${sock.userId}@s.whatsapp.net`;
      if (!global.db?.data?.settings[botDir]) {
        global.db.data.settings[botDir] = {};
      }
      global.db.data.settings[botDir].type = 'Sub';

      if (!global.conns.find((c) => c.userId === sock.userId)) {
        global.conns.push(sock);
      }

      delete reintentos[sock.userId || id];
      await _joinChannels(sock);

      console.log(
        chalk.hex('#b2f7ef')(`╭─ ✧ Sub-bot conectado`) +
        chalk.hex('#dec0f1')(` ❁ ${sock.userId}`)
      );
    }

    // ── Desconectado ────────────────────────────────────────────────────
    if (connection === 'close') {
      const botId   = sock.userId || id;
      const reason  = lastDisconnect?.error?.output?.statusCode
                    || lastDisconnect?.reason
                    || 0;
      const intentos = (reintentos[botId] || 0) + 1;
      reintentos[botId] = intentos;

      // Sesión inválida / baneada — eliminar y no reintentar
      if ([401, 403].includes(reason)) {
        if (intentos <= MAX_RETRIES) {
          console.log(chalk.gray(
            `╰─► ⇄ Sub-bot ${botId} cerró (${reason}) — intento ${intentos}/${MAX_RETRIES}`
          ));
          setTimeout(() => startSubBot(m, client, caption, isCode, phone, chatId, {}, isCommand), RETRY_DELAY);
        } else {
          console.log(chalk.gray(`╰─► ✗ Sub-bot ${botId} falló tras ${MAX_RETRIES} intentos. Eliminando sesión.`));
          try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
          delete reintentos[botId];
        }
        return;
      }

      // Desconexiones recuperables
      const recov = [
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.timedOut,
        DisconnectReason.connectionReplaced,
        DisconnectReason.restartRequired,
      ];
      if (recov.includes(reason)) {
        console.log(chalk.gray(`╰─► ↺ Sub-bot ${botId} reconectando...`));
        setTimeout(() => startSubBot(m, client, caption, isCode, phone, chatId, {}, isCommand), RETRY_DELAY);
        return;
      }

      // Sesión terminada (logout)
      if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
        console.log(chalk.gray(`╰─► ✗ Sub-bot ${botId} sesión cerrada. Eliminando.`));
        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
        delete reintentos[botId];
        // Remover de global.conns
        _removeFromConns(sock);
        return;
      }

      // Cualquier otra razón — reintentar
      setTimeout(() => startSubBot(m, client, caption, isCode, phone, chatId, {}, isCommand), RETRY_DELAY);
    }

    // ── QR o Código de emparejamiento ──────────────────────────────────
    if (qr && isCode && phone && client && chatId && commandFlags?.[senderId]) {
      try {
        let code = await sock.requestPairingCode(phone);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        const msgCap  = await m.reply(caption);
        const msgCode = await m.reply(`*${code}*`);
        delete commandFlags[senderId];
        setTimeout(async () => {
          try {
            await client.sendMessage(chatId, { delete: msgCap.key });
            await client.sendMessage(chatId, { delete: msgCode.key });
          } catch {}
        }, 60_000);
      } catch (err) {
        console.error('╰─► ✗ [Código Error]', err);
      }
    }

    if (qr && !isCode && client && chatId && commandFlags?.[senderId]) {
      try {
        const qrImg = await qrcode.toBuffer(qr, { scale: 8 });
        const msgQR = await client.sendMessage(
          m.chat,
          { image: qrImg, caption },
          { quoted: m }
        );
        delete commandFlags[senderId];
        setTimeout(async () => {
          try { await client.sendMessage(chatId, { delete: msgQR.key }); } catch {}
        }, 60_000);
      } catch (err) {
        console.error('╰─► ✗ [QR Error]', err);
      }
    }
  });

  // ── Mensajes entrantes al sub-bot ───────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const raw of messages) {
      if (!raw.message) continue;
      try {
        // Importar handler dinámicamente igual que el subBotManager original
        const handlerPath = path.join(__dirname, '../../handler.js');
        const mod = await import(`${handlerPath}?t=${Date.now()}`).catch(() => null);
        if (mod?.default) await mod.default.call(sock, raw);
      } catch (err) {
        console.log(chalk.gray(`╰─► ✗ Sub » ${err?.message || err}`));
      }
    }
  });

  process.on('uncaughtException', console.error);
  return sock;
}

// ── Helpers internos ─────────────────────────────────────────────────────────
function _removeFromConns(sock) {
  const idx = global.conns.indexOf(sock);
  if (idx >= 0) global.conns.splice(idx, 1);
}

async function _joinChannels(client) {
  if (!global.my) return;
  for (const value of Object.values(global.my)) {
    if (typeof value === 'string' && value.endsWith('@newsletter')) {
      await client.newsletterFollow(value).catch(() => {});
    }
  }
}

// ── Bucle de autoload periódico (cada 60 s) ──────────────────────────────────
export function startSubBotWatcher() {
  const run = async () => {
    if (!fs.existsSync(JADIBTS_DIR)) return;
    for (const userId of fs.readdirSync(JADIBTS_DIR)) {
      const credsPath = path.join(JADIBTS_DIR, userId, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      if (global.conns.some((c) => c.userId === userId)) continue;
      try {
        await startSubBot(null, null, '✧ Auto-reconexión', false, userId, null, {}, false);
      } catch {}
      await delay(2500);
    }
    setTimeout(run, 60_000);
  };
  setTimeout(run, 60_000);
}
