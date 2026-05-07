import { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import chalk from 'chalk';
import { makeWASocket } from './simple.js';
import store from './store.js';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JADIBTS_DIR = path.join(__dirname, '../../jadibts');

if (!Array.isArray(global.conns)) global.conns = [];

const reconnectCounters = {};
const MAX_RECONNECTS = 5;

export async function initializeSubBots() {
  try {
    const mainJid     = global.conn?.user?.jid;
    const modeEnabled = global.db?.data?.settings?.[mainJid]?.modejadibot ?? true;
    if (!modeEnabled) {
      console.log(chalk.gray('[SUB-BOT] Modo jadibot desactivado'));
      return;
    }
    if (!fs.existsSync(JADIBTS_DIR)) {
      console.log(chalk.gray('[SUB-BOT] No hay sub-bots previamente conectados'));
      return;
    }
    for (const dir of fs.readdirSync(JADIBTS_DIR)) {
      try {
        const credsPath = path.join(JADIBTS_DIR, dir, 'creds.json');
        if (!fs.existsSync(credsPath)) continue;
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        if (creds.fstop === true) continue;
        console.log(chalk.gray(`[SUB-BOT] Iniciando sub-bot ${dir}`));
        await startSubBot(dir);
      } catch (e) {
        console.error(chalk.red(`[SUB-BOT] Error al iniciar ${dir}:`), e);
      }
    }
  } catch (e) {
    console.error(chalk.red('[SUB-BOT] Error en initializeSubBots:'), e);
  }
}

export async function startSubBotFromCommand(m, client, caption = '', isCode = false, phone = '', chatId = '', commandFlags = {}) {
  const senderId   = m?.sender;
  const sessionId  = phone || senderId.split('@')[0];
  const sessionDir = path.join(JADIBTS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    getMessage: async () => '',
    msgRetryCounterCache,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 60_000,
    version,
  });

  sock.isInit = false;
  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (connection === 'connecting' && isCode && phone && !pairingRequested && commandFlags[senderId]) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          if (sock.authState?.creds?.registered) return;
          let code = await sock.requestPairingCode(phone);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          const mc = await client.sendMessage(chatId, { text: caption }, { quoted: m });
          const mk = await client.sendMessage(chatId, { text: `꒰ ✦ *Código de vinculación:* ✦ ꒱\n\`${code}\`` }, { quoted: m });
          delete commandFlags[senderId];
          setTimeout(async () => {
            try { await client.sendMessage(chatId, { delete: mc.key }); } catch {}
            try { await client.sendMessage(chatId, { delete: mk.key }); } catch {}
          }, 90000);
        } catch (e) {
          console.error('[SUB-BOT] Error código pairing:', e.message);
          try {
            await client.sendMessage(chatId, {
              text: `꒰ ✗ ꒱ Error al generar código: *${e.message}*\n⸙͎ Verifica que el número sea correcto con código de país.`
            }, { quoted: m });
          } catch {}
          delete commandFlags[senderId];
        }
      }, 2500);
    }

    if (qr && !isCode && commandFlags[senderId]) {
      try {
        const mq = await client.sendMessage(chatId, {
          image: await qrcode.toBuffer(qr, { scale: 8 }),
          caption,
        }, { quoted: m });
        delete commandFlags[senderId];
        setTimeout(async () => { try { await client.sendMessage(chatId, { delete: mq.key }); } catch {} }, 60000);
      } catch (e) {
        console.error('[SUB-BOT] Error enviando QR:', e.message);
      }
    }

    if (connection === 'open') {
      sock.uptime  = Date.now();
      sock.isInit  = true;
      const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
      global.db.data.settings[botJid].type = 'Sub';
      delete reconnectCounters[sessionId];
      if (!global.conns.find(c => c.user?.id === sock.user?.id)) global.conns.push(sock);
      console.log(chalk.gray(`[SUB-BOT] +${sessionId} conectado`));
    }

    if (connection === 'close') {
      const reason  = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason || 0;
      const retries = (reconnectCounters[sessionId] || 0) + 1;
      reconnectCounters[sessionId] = retries;
      if (retries > MAX_RECONNECTS) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        delete reconnectCounters[sessionId];
        return;
      }
      if ([401, 403, DisconnectReason.loggedOut].includes(reason)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        delete reconnectCounters[sessionId];
        return;
      }
      setTimeout(() => startSubBotFromCommand(m, client, caption, isCode, phone, chatId, {}), 4000);
    }
  });

  return sock;
}

async function startSubBot(sessionId) {
  try {
    const sessionDir = path.join(JADIBTS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

    const connOptions = {
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        try {
          const jid = jidNormalizedUser(key.remoteJid);
          const msg = await store.loadMessage(jid, key.id);
          return msg?.message || '';
        } catch { return ''; }
      },
      msgRetryCounterCache,
      defaultQueryTimeoutMs: undefined,
      version,
    };

    let subConn = makeWASocket(connOptions);
    subConn.isInit = false;
    subConn.uptime = Date.now();

    setInterval(() => {
      if (!subConn.user) {
        try { subConn.ws.close(); } catch {}
        subConn.ev.removeAllListeners();
        const idx = global.conns.indexOf(subConn);
        if (idx >= 0) global.conns.splice(idx, 1);
      }
    }, 60000);

    let handler;

    const subreloadHandler = async (restart = false) => {
      try {
        const mod = await import(path.join(__dirname, '../../handler.js') + `?update=${Date.now()}`).catch(console.error);
        if (mod && Object.keys(mod).length) handler = mod;
      } catch (e) {
        console.error('[SUB-BOT] Error al cargar handler:', e);
        return;
      }
      if (!handler?.handler) {
        console.error('[SUB-BOT] Handler no definido');
        return;
      }
      if (restart) {
        try { subConn.ws.close(); } catch {}
        subConn.ev.removeAllListeners();
        subConn = makeWASocket(connOptions);
      }
      if (!restart) {
        store.bind(subConn);
        subConn.ev.off('messages.upsert',          subConn.handler);
        subConn.ev.off('group-participants.update', subConn.participantsUpdate);
        subConn.ev.off('groups.update',             subConn.groupsUpdate);
        subConn.ev.off('message.delete',            subConn.onDelete);
        subConn.ev.off('call',                      subConn.onCall);
        subConn.ev.off('connection.update',         subConn.connectionUpdate);
        subConn.ev.off('creds.update',              subConn.credsUpdate);
      }
      subConn.handler            = handler.handler.bind(subConn);
      subConn.participantsUpdate = handler.participantsUpdate.bind(subConn);
      subConn.groupsUpdate       = handler.groupsUpdate.bind(subConn);
      subConn.onDelete           = handler.deleteUpdate.bind(subConn);
      subConn.onCall             = handler.callUpdate.bind(subConn);
      subConn.connectionUpdate   = onConnectionUpdate.bind(subConn);
      subConn.credsUpdate        = saveCreds.bind(subConn, true);
      subConn.subreloadHandler   = subreloadHandler;
      subConn.ev.on('messages.upsert',          subConn.handler);
      subConn.ev.on('group-participants.update', subConn.participantsUpdate);
      subConn.ev.on('groups.update',            subConn.groupsUpdate);
      subConn.ev.on('message.delete',           subConn.onDelete);
      subConn.ev.on('call',                     subConn.onCall);
      subConn.ev.on('connection.update',        subConn.connectionUpdate);
      subConn.ev.on('creds.update',             subConn.credsUpdate);
      return true;
    };

    async function onConnectionUpdate({ connection, lastDisconnect, isNewLogin }) {
      if (isNewLogin) subConn.isInit = false;
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;

      if (connection === 'open') {
        subConn.isInit = true;
        const botJid   = subConn.user.id.split(':')[0] + '@s.whatsapp.net';
        if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
        global.db.data.settings[botJid].type = 'Sub';
        delete reconnectCounters[sessionId];
        if (!global.conns.find(c => c.user?.id === subConn.user?.id)) global.conns.push(subConn);
        console.log(chalk.gray(`[SUB-BOT] +${sessionId} conectado`));
      }

      if (connection === 'close') {
        const retries = (reconnectCounters[sessionId] || 0) + 1;
        reconnectCounters[sessionId] = retries;
        if (retries >= MAX_RECONNECTS) {
          const idx = global.conns.indexOf(subConn);
          if (idx >= 0) global.conns.splice(idx, 1);
          return;
        }
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
          try { fs.rmdirSync(path.join(JADIBTS_DIR, sessionId), { recursive: true }); } catch {}
          const idx = global.conns.indexOf(subConn);
          if (idx >= 0) global.conns.splice(idx, 1);
          return;
        }
        await subreloadHandler(true).catch(console.error);
      }
    }

    await subreloadHandler(false);
  } catch (e) {
    console.error(chalk.red(`[SUB-BOT] Error al iniciar sub-bot ${sessionId}:`), e);
  }
}
