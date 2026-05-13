/**
 * subsRikka.js
 * ╭──────────────────────────────────────────────╮
 * │  Sistema de Sub-Bots — Rikka-TakaradaMD      │
 * │  Carpeta de sesiones: ./jadibts/             │
 * ╰──────────────────────────────────────────────╯
 *
 * Fix 1: requestPairingCode se llama en el primer evento 'qr' (WS listo),
 *        NO dentro de un qr repetido ni antes del handshake.
 * Fix 2: messages.upsert enlaza handler.js con .bind(sock), igual que
 *        el subBotManager original (conn.handler = mod.handler.bind(conn)).
 */

import { makeWASocket } from './simple.js';
import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcode   from 'qrcode';
import NodeCache from 'node-cache';
import pino     from 'pino';
import fs       from 'fs';
import path     from 'path';
import chalk    from 'chalk';
import { fileURLToPath } from 'url';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const HANDLER_PATH = path.join(__dirname, '../../handler.js');
const JADIBTS_DIR  = path.join(__dirname, '../../jadibts');

const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;

if (!global.conns || !Array.isArray(global.conns)) global.conns = [];
const reintentos = {};

const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const userDevicesCache     = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const groupCache           = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

const cleanJid = (jid = '') => jid.replace(/:\d+/, '').split('@')[0];
const delay    = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cache del módulo handler ─────────────────────────────────────────────────
let _cachedHandler = null;
async function _loadHandler(forceReload = false) {
  if (_cachedHandler && !forceReload) return _cachedHandler;
  try {
    const mod = await import(`${HANDLER_PATH}?update=${Date.now()}`);
    if (mod?.handler && typeof mod.handler === 'function') {
      _cachedHandler = mod;
      return mod;
    }
    console.log(chalk.gray('╰─► ✗ [subsRikka] handler.js no exporta `handler`'));
  } catch (e) {
    console.log(chalk.gray(`╰─► ✗ [subsRikka] Error cargando handler.js: ${e?.message}`));
  }
  return null;
}

// ── Enlazar handler al socket (igual que subBotManager original) ─────────────
async function _bindHandler(sock, forceReload = false) {
  const mod = await _loadHandler(forceReload);
  if (!mod) return;

  // Desregistrar listeners anteriores
  if (sock.handler)            sock.ev.off('messages.upsert',          sock.handler);
  if (sock.participantsUpdate) sock.ev.off('group-participants.update', sock.participantsUpdate);
  if (sock.groupsUpdate)       sock.ev.off('groups.update',             sock.groupsUpdate);
  if (sock.onDelete)           sock.ev.off('message.delete',            sock.onDelete);
  if (sock.callUpdate)         sock.ev.off('call',                      sock.callUpdate);

  // Registrar nuevos listeners enlazados al socket
  sock.handler            = mod.handler.bind(sock);
  sock.participantsUpdate = mod.participantsUpdate?.bind(sock);
  sock.groupsUpdate       = mod.groupsUpdate?.bind(sock);
  sock.onDelete           = mod.deleteUpdate?.bind(sock);
  sock.callUpdate         = mod.callUpdate?.bind(sock);

  sock.ev.on('messages.upsert', sock.handler);
  if (sock.participantsUpdate) sock.ev.on('group-participants.update', sock.participantsUpdate);
  if (sock.groupsUpdate)       sock.ev.on('groups.update',             sock.groupsUpdate);
  if (sock.onDelete)           sock.ev.on('message.delete',            sock.onDelete);
  if (sock.callUpdate)         sock.ev.on('call',                      sock.callUpdate);

  sock.subreloadHandler = (reload = true) => _bindHandler(sock, reload);
}

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
      await startSubBot(null, null, '', false, userId, null, {}, false);
    } catch (e) {
      console.log(chalk.gray(`╰─► ✗ Error iniciando sub-bot ${userId}: ${e?.message || e}`));
    }
    await delay(2500);
  }
}

// ── Función principal ────────────────────────────────────────────────────────
export async function startSubBot(
  m,
  client,
  caption      = '',
  isCode       = false,
  phone        = '',
  chatId       = null,
  commandFlags = {},
  isCommand    = false
) {
  const id            = phone || (m?.sender || '').split('@')[0];
  const sessionFolder = path.join(JADIBTS_DIR, id);
  const senderId      = m?.sender;

  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger:    pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser:   ['Rikka-TakaradaMD', 'Safari', '2.0.0'],
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    markOnlineOnConnect:            true,
    generateHighQualityLinkPreview: true,
    syncFullHistory:                false,
    getMessage:                     async () => '',
    msgRetryCounterCache,
    userDevicesCache,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    keepAliveIntervalMs: 60_000,
    maxIdleTimeMs:       120_000,
  });

  sock.isInit = false;
  sock.uptime = Date.now();

  sock.ev.on('creds.update', saveCreds);

  // ── FIX 1: pairing code ───────────────────────────────────────────────────
  // requestPairingCode se debe llamar EXACTAMENTE UNA VEZ, en el primer
  // evento 'qr' (que indica que el handshake WS completó y WA está esperando
  // vinculación). En llamadas posteriores del mismo qr solo se ignora.
  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, isNewLogin, qr }) => {
    if (isNewLogin) sock.isInit = false;

    // ── Pairing code (una sola vez en el primer qr) ─────────────────────
    if (qr && isCode && phone && client && chatId && commandFlags?.[senderId] && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const cleanPhone = phone.replace(/\D/g, '');
        let code = await sock.requestPairingCode(cleanPhone);
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
        pairingCodeRequested = false;
        console.error(chalk.gray(`╰─► ✗ [Código Error] ${err?.message || err}`));
        try { await m.reply(`╰─► ✗ Error al generar código:\n┊ _${err?.message}_`); } catch {}
      }
    }

    // ── QR visual ──────────────────────────────────────────────────────
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
        console.error(chalk.gray(`╰─► ✗ [QR Error] ${err?.message || err}`));
      }
    }

    // ── Conectado ────────────────────────────────────────────────────────
    if (connection === 'open') {
      sock.uptime = Date.now();
      sock.isInit = true;
      sock.userId = cleanJid(sock.user?.id || '');

      const botDir = `${sock.userId}@s.whatsapp.net`;
      if (global.db?.data?.settings) {
        if (!global.db.data.settings[botDir]) global.db.data.settings[botDir] = {};
        global.db.data.settings[botDir].type = 'Sub';
      }

      if (!global.conns.find((c) => c.userId === sock.userId)) {
        global.conns.push(sock);
      }

      delete reintentos[sock.userId || id];
      await _joinChannels(sock);

      // FIX 2: enlazar handler correctamente
      await _bindHandler(sock);

      console.log(
        chalk.hex('#b2f7ef')('╰─► ✧ Sub-bot conectado') +
        chalk.hex('#dec0f1')(` ❁ ${sock.userId}`)
      );
    }

    // ── Desconectado ────────────────────────────────────────────────────
    if (connection === 'close') {
      const botId    = sock.userId || id;
      const reason   = lastDisconnect?.error?.output?.statusCode
                     || lastDisconnect?.reason
                     || 0;
      const intentos = (reintentos[botId] || 0) + 1;
      reintentos[botId] = intentos;
      _removeFromConns(sock);

      if ([401, 403].includes(reason)) {
        if (intentos <= MAX_RETRIES) {
          console.log(chalk.gray(`╰─► ⇄ Sub-bot ${botId} cerró (${reason}) — intento ${intentos}/${MAX_RETRIES}`));
          setTimeout(() => startSubBot(m, client, caption, isCode, phone, chatId, {}, isCommand), RETRY_DELAY);
        } else {
          console.log(chalk.gray(`╰─► ✗ Sub-bot ${botId} falló tras ${MAX_RETRIES} intentos. Eliminando.`));
          try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
          delete reintentos[botId];
        }
        return;
      }

      if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
        console.log(chalk.gray(`╰─► ✗ Sub-bot ${botId} sesión terminada. Eliminando.`));
        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
        delete reintentos[botId];
        return;
      }

      // Recuperable o razón desconocida
      console.log(chalk.gray(`╰─► ↺ Sub-bot ${botId} reconectando (razón: ${reason})...`));
      setTimeout(() => startSubBot(m, client, caption, isCode, phone, chatId, {}, isCommand), RETRY_DELAY);
    }
  });

  process.on('uncaughtException', (err) => {
    const msg = err?.message || '';
    if (msg.includes('rate-overlimit') || msg.includes('timed out') || msg.includes('Connection Closed')) return;
    console.error(chalk.gray('[subsRikka]'), msg.slice(0, 120));
  });

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

// ── Watcher periódico (cada 60 s) ────────────────────────────────────────────
export function startSubBotWatcher() {
  const run = async () => {
    if (!fs.existsSync(JADIBTS_DIR)) return;
    for (const userId of fs.readdirSync(JADIBTS_DIR)) {
      const credsPath = path.join(JADIBTS_DIR, userId, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      if (global.conns.some((c) => c.userId === userId)) continue;
      try {
        await startSubBot(null, null, '', false, userId, null, {}, false);
      } catch {}
      await delay(2500);
    }
    setTimeout(run, 60_000);
  };
  setTimeout(run, 60_000);
}
