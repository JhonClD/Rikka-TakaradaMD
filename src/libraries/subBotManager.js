// subBotManager.js — Gestor de Sub-Bots para Rikka-TakaradaMD
// Reescrito limpio inspirado en YukiBot-MD/core/subs.js
// Carpeta de sesiones: ./jadibts/<número>/

import {
  makeWASocket as _makeWASocket,
} from './simple.js';
import store from './store.js';
import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
  jidDecode,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../../jadibts');

if (!fs.existsSync(JADIBTS_DIR)) fs.mkdirSync(JADIBTS_DIR, { recursive: true });
if (!(global.conns instanceof Array)) global.conns = [];

const reintentos = {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanJid = (jid = '') => jid.replace(/:\d+/, '').split('@')[0];
const silentLogger = pino({ level: 'silent' });

// ─── Inicializar todos los sub-bots guardados al arrancar ────────────────────
export async function initializeSubBots() {
  try {
    const modejadibot = global.db?.data?.settings?.[global.conn?.user?.jid]?.modejadibot ?? true;
    if (!modejadibot) {
      console.log('[SUB-BOT] Modo jadibot desactivado en configuración del Bot Principal');
      return;
    }
    if (!fs.existsSync(JADIBTS_DIR)) {
      console.log('[SUB-BOT] No hay sub-bots previamente conectados');
      return;
    }
    const dirs = fs.readdirSync(JADIBTS_DIR);
    for (const dir of dirs) {
      const credsPath = path.join(JADIBTS_DIR, dir, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      let creds;
      try {
        creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      } catch {
        continue;
      }
      if (creds.isInit === true) continue; // ya marcado como init (por startup anterior)
      console.log(`[SUB-BOT] Iniciando sub-bot ${dir}`);
      await startSubBot(null, null, '', false, dir, '', {}, false).catch((e) =>
        console.error(`[SUB-BOT] Error al iniciar sub-bot ${dir}:`, e)
      );
    }
  } catch (e) {
    console.error('[SUB-BOT] Error en initializeSubBots:', e);
  }
}

// ─── Iniciar un sub-bot individual ──────────────────────────────────────────
export async function startSubBot(
  m,
  client,
  caption = '',
  isCode = false,
  phone = '',
  chatId = '',
  commandFlags = {},
  isCommand = false
) {
  const id = phone || (m?.sender || '').split('@')[0];
  const sessionFolder = path.join(JADIBTS_DIR, id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

    const sockConfig = {
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      logger: silentLogger,
      browser: ['Rikka-TakaradaMD', 'Safari', '2.0.0'],
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      getMessage: async (key) => {
        const jid = jidNormalizedUser(key.remoteJid);
        const msg = await store.loadMessage(jid, key.id);
        return msg?.message || '';
      },
      msgRetryCounterCache,
      version,
      keepAliveIntervalMs: 60_000,
      maxIdleTimeMs: 120_000,
      waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat?ED=CAIICA',
    };

    let sock = _makeWASocket(sockConfig);
    sock.isInit = false;
    sock.uptime = Date.now();
    sock.userId = null;

    // Decode JID helper (igual que en simple.js)
    sock.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        const dec = jidDecode(jid) || {};
        return (dec.user && dec.server && dec.user + '@' + dec.server) || jid;
      }
      return jid;
    };

    sock.ev.on('creds.update', saveCreds);

    // ── Watchdog: si pierde el user después de conectarse, limpiar de conns ──
    const watchdog = setInterval(() => {
      if (sock.isInit && !sock.user) {
        try { sock.ws.close(); } catch {}
        sock.ev.removeAllListeners();
        clearInterval(watchdog);
        const idx = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);
      }
    }, 60_000);

    // ── Manejador de conexión ────────────────────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, isNewLogin, qr }) => {
      if (isNewLogin) sock.isInit = false;

      // ── Conexión abierta ─────────────────────────────────────────────────
      if (connection === 'open') {
        sock.isInit = true;
        sock.userId = cleanJid(sock.user?.id || '');
        const botJid = sock.userId + '@s.whatsapp.net';

        // Registrar en settings de la DB
        if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
        global.db.data.settings[botJid].type = 'Sub';

        // Agregar a global.conns si no está ya
        if (!global.conns.find((c) => c.userId === sock.userId)) {
          global.conns.push(sock);
        }

        // Registrar handlers del handler.js principal
        await _registerHandlers(sock);

        delete reintentos[sock.userId || id];
        console.log(`[SUB-BOT] ✅ ${sock.userId} conectado con éxito`);
      }

      // ── Conexión cerrada ─────────────────────────────────────────────────
      if (connection === 'close') {
        const botId = sock.userId || id;
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode ||
          0;

        clearInterval(watchdog);

        // Remover de conns
        const idx = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);

        // Sesión apagada manualmente (fstop)
        if (sock.fstop) {
          console.log(`[SUB-BOT] ${botId} apagado correctamente`);
          return;
        }

        // Sesión inválida / baneada → borrar
        if ([401, 403].includes(statusCode) || statusCode === DisconnectReason.badSession) {
          const intentos = (reintentos[botId] || 0) + 1;
          reintentos[botId] = intentos;
          if (intentos <= 5) {
            console.log(`[SUB-BOT] ${botId} sesión problemática (${statusCode}), intento ${intentos}/5`);
            await delay(3000);
            return startSubBot(m, client, caption, isCode, phone, chatId, commandFlags, isCommand);
          } else {
            console.log(`[SUB-BOT] ${botId} falló 5 veces — eliminando sesión`);
            try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
            delete reintentos[botId];
            return;
          }
        }

        // Logout explícito → borrar sesión
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[SUB-BOT] ${botId} cerró sesión`);
          try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
          return;
        }

        // Reconexión normal para el resto de casos
        const reconnectCodes = [
          DisconnectReason.connectionClosed,
          DisconnectReason.connectionLost,
          DisconnectReason.timedOut,
          DisconnectReason.connectionReplaced,
          DisconnectReason.restartRequired,
        ];
        if (reconnectCodes.includes(statusCode) || statusCode === 0) {
          console.log(`[SUB-BOT] ${botId} perdió conexión (${statusCode}), reconectando...`);
          await delay(3000);
          return startSubBot(m, client, caption, isCode, phone, chatId, commandFlags, isCommand);
        }

        console.log(`[SUB-BOT] ${botId} desconectado por razón desconocida: ${statusCode}`);
        await delay(5000);
        return startSubBot(m, client, caption, isCode, phone, chatId, commandFlags, isCommand);
      }

      // ── QR recibido ──────────────────────────────────────────────────────
      if (qr) {
        const senderId = m?.sender;

        // Modo código de pareo
        if (isCode && phone && client && chatId && commandFlags[senderId]) {
          try {
            let code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
            code = code?.match(/.{1,4}/g)?.join('-') || code;
            const msgCaption = await client.sendMessage(chatId, { text: caption }, { quoted: m });
            const msgCode = await client.sendMessage(chatId, { text: `*${code}*` }, { quoted: m });
            delete commandFlags[senderId];
            // Auto-borrar después de 60s
            setTimeout(async () => {
              try {
                await client.sendMessage(chatId, { delete: msgCaption.key });
                await client.sendMessage(chatId, { delete: msgCode.key });
              } catch {}
            }, 60_000);
          } catch (err) {
            console.error('[SUB-BOT] Error generando código de pareo:', err);
          }
        }

        // Modo QR imagen
        if (!isCode && client && chatId && commandFlags[senderId]) {
          try {
            const qrBuffer = await qrcode.toBuffer(qr, { scale: 8 });
            const sentQR = await client.sendMessage(chatId, {
              image: qrBuffer,
              caption,
            }, { quoted: m });
            delete commandFlags[senderId];
            setTimeout(async () => {
              try { await client.sendMessage(chatId, { delete: sentQR.key }); } catch {}
            }, 60_000);
          } catch (err) {
            console.error('[SUB-BOT] Error enviando QR:', err);
          }
        }
      }
    });

    // ── Mensajes entrantes ───────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!global.reloadHandler) return;
      for (const raw of messages) {
        if (!raw.message) continue;
        try {
          await sock.handler?.({ messages: [raw], type });
        } catch (err) {
          console.error(`[SUB-BOT] ${sock.userId} error en mensaje:`, err.message);
        }
      }
    });

    return sock;
  } catch (e) {
    console.error(`[SUB-BOT] Error al iniciar sub-bot ${id}:`, e);
  }
}

// ─── Registrar los handlers del handler.js en un sock de sub-bot ────────────
async function _registerHandlers(sock) {
  try {
    const handlerPath = path.join(__dirname, '../../handler.js');
    const mod = await import(handlerPath + '?t=' + Date.now()).catch(console.error);
    if (!mod || !mod.handler) {
      console.error('[SUB-BOT] Handler no definido o incompleto');
      return;
    }

    store.bind(sock);

    // Limpiar listeners viejos antes de registrar nuevos
    sock.ev.off('messages.upsert',          sock._handler);
    sock.ev.off('group-participants.update', sock._participantsUpdate);
    sock.ev.off('groups.update',             sock._groupsUpdate);
    sock.ev.off('message.delete',            sock._deleteUpdate);
    sock.ev.off('call',                      sock._callUpdate);

    sock._handler            = mod.handler.bind(sock);
    sock._participantsUpdate = mod.participantsUpdate?.bind(sock);
    sock._groupsUpdate       = mod.groupsUpdate?.bind(sock);
    sock._deleteUpdate       = mod.deleteUpdate?.bind(sock);
    sock._callUpdate         = mod.callUpdate?.bind(sock);

    sock.ev.on('messages.upsert',          sock._handler);
    if (sock._participantsUpdate) sock.ev.on('group-participants.update', sock._participantsUpdate);
    if (sock._groupsUpdate)       sock.ev.on('groups.update',             sock._groupsUpdate);
    if (sock._deleteUpdate)       sock.ev.on('message.delete',            sock._deleteUpdate);
    if (sock._callUpdate)         sock.ev.on('call',                      sock._callUpdate);

    // Asignar subreloadHandler para que handler.js watchFile lo pueda llamar
    sock.subreloadHandler = async (reconnect = false) => {
      await _registerHandlers(sock);
    };

    sock.handler = sock._handler;
  } catch (e) {
    console.error('[SUB-BOT] Error al cargar handler:', e);
  }
}

// ─── Listar sub-bots activos ─────────────────────────────────────────────────
export function listSubBots() {
  const active = global.conns.filter((c) => c.isInit && c.userId);
  const saved  = fs.existsSync(JADIBTS_DIR)
    ? fs.readdirSync(JADIBTS_DIR).filter((d) => fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json')))
    : [];
  return { active, saved };
}

// ─── Desconectar y eliminar un sub-bot ───────────────────────────────────────
export async function removeSubBot(userId) {
  const clean = cleanJid(userId);
  const sessionFolder = path.join(JADIBTS_DIR, clean);

  // Desconectar de conns
  const idx = global.conns.findIndex((c) => c.userId === clean);
  if (idx >= 0) {
    const sock = global.conns[idx];
    sock.fstop = true;
    try { sock.ws.close(); } catch {}
    sock.ev.removeAllListeners();
    global.conns.splice(idx, 1);
  }

  // Borrar sesión del disco
  if (fs.existsSync(sessionFolder)) {
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    return true;
  }
  return false;
}
