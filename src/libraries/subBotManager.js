// subBotManager.js — Reescrito limpio para Rikka-TakaradaMD
// FIX: no asigna propiedades read-only del socket (decodeJid, etc.)
// El estado custom (isInit, userId, fstop, uptime) se guarda en un Map aparte

import { makeWASocket } from './simple.js';
import store from './store.js';
import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS    = path.join(__dirname, '../../jadibts');
const silentLog  = pino({ level: 'silent' });
const delay      = ms => new Promise(r => setTimeout(r, ms));
const cleanJid   = j  => String(j || '').replace(/:\d+/, '').split('@')[0];

// Estado custom por socket — evita asignar props read-only al sock original
const sockMeta = new WeakMap();
const getMeta  = sock => {
  if (!sockMeta.has(sock)) sockMeta.set(sock, { isInit: false, userId: null, fstop: false, uptime: Date.now() });
  return sockMeta.get(sock);
};

if (!fs.existsSync(JADIBTS)) fs.mkdirSync(JADIBTS, { recursive: true });
if (!global.conns) global.conns = [];

const reintentos = {};

// ─── Registrar handlers del handler.js principal ──────────────────────────────
async function registerHandlers(sock) {
  try {
    const handlerPath = path.join(__dirname, '../../handler.js');
    const mod = await import(handlerPath + '?t=' + Date.now()).catch(console.error);
    if (!mod?.handler) return console.error('[SUB-BOT] handler.js no exporta handler');

    store.bind(sock);

    const evMap = [
      ['messages.upsert',          '_h',  'handler'],
      ['group-participants.update', '_p',  'participantsUpdate'],
      ['groups.update',             '_g',  'groupsUpdate'],
      ['message.delete',            '_d',  'deleteUpdate'],
      ['call',                      '_c',  'callUpdate'],
    ];

    // Limpiar listeners viejos (guardados en meta)
    const meta = getMeta(sock);
    for (const [evt, key] of evMap) {
      if (meta[key]) sock.ev.off(evt, meta[key]);
    }
    for (const [evt, key, exp] of evMap) {
      if (!mod[exp]) continue;
      meta[key] = mod[exp].bind(sock);
      sock.ev.on(evt, meta[key]);
    }

    // Alias accesibles desde handler.js watchFile
    sock.handler            = meta._h;
    sock.participantsUpdate = meta._p;
    sock.groupsUpdate       = meta._g;
    sock.subreloadHandler   = () => registerHandlers(sock);
  } catch (e) {
    console.error('[SUB-BOT] Error registrando handlers:', e.message);
  }
}

// ─── Iniciar un sub-bot ───────────────────────────────────────────────────────
export async function startSubBot(
  m, client, caption, isCode, phone, chatId, cmdFlags, isCmd
) {
  const id     = phone || (m ? m.sender.split('@')[0] : '');
  const folder = path.join(JADIBTS, id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version }          = await fetchLatestBaileysVersion();

    const cfg = {
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, silentLog),
      },
      logger:                         silentLog,
      browser:                        ['Rikka-TakaradaMD', 'Safari', '2.0.0'],
      markOnlineOnConnect:            true,
      generateHighQualityLinkPreview: true,
      syncFullHistory:                false,
      getMessage: async key => {
        const msg = await store.loadMessage(jidNormalizedUser(key.remoteJid), key.id);
        return msg?.message || '';
      },
      msgRetryCounterCache: new NodeCache({ stdTTL: 0, checkperiod: 0 }),
      version,
      keepAliveIntervalMs: 60000,
      maxIdleTimeMs:       120000,
      waWebSocketUrl:      'wss://web.whatsapp.com/ws/chat?ED=CAIICA',
    };

    const sock = makeWASocket(cfg);
    const meta = getMeta(sock); // estado en WeakMap, no en el sock directamente
    meta.uptime = Date.now();

    sock.ev.on('creds.update', saveCreds);

    // Watchdog
    const watchdog = setInterval(() => {
      if (meta.isInit && !sock.user) {
        clearInterval(watchdog);
        try { sock.ws.close(); } catch {}
        sock.ev.removeAllListeners();
        const idx = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);
      }
    }, 60000);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      // ── Conectado ───────────────────────────────────────────────────────────
      if (connection === 'open') {
        clearInterval(watchdog);
        meta.isInit = true;
        meta.userId = cleanJid(sock.user?.id || '');
        const botJid = meta.userId + '@s.whatsapp.net';

        if (!global.db?.data?.settings) global.db.data.settings = {};
        if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
        global.db.data.settings[botJid].type = 'Sub';

        // Exponer isInit/userId directamente en el sock para compatibilidad con handler.js
        try { Object.defineProperty(sock, 'isInit', { value: true,        writable: true, configurable: true }); } catch {}
        try { Object.defineProperty(sock, 'userId', { value: meta.userId, writable: true, configurable: true }); } catch {}
        try { Object.defineProperty(sock, 'uptime', { value: meta.uptime, writable: true, configurable: true }); } catch {}

        if (!global.conns.find(c => getMeta(c).userId === meta.userId)) {
          global.conns.push(sock);
        }
        delete reintentos[meta.userId || id];
        await registerHandlers(sock);
        console.log('[SUB-BOT] ✅ Conectado: +' + meta.userId);
      }

      // ── Desconectado ────────────────────────────────────────────────────────
      if (connection === 'close') {
        clearInterval(watchdog);
        const botId = meta.userId || id;
        const code  = lastDisconnect?.error?.output?.statusCode || 0;
        const idx   = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);

        if (meta.fstop) {
          console.log('[SUB-BOT] ' + botId + ' apagado manualmente');
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          console.log('[SUB-BOT] ' + botId + ' cerró sesión — borrando');
          try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
          return;
        }
        if (code === 401 || code === 403) {
          reintentos[botId] = (reintentos[botId] || 0) + 1;
          if (reintentos[botId] > 5) {
            console.log('[SUB-BOT] ' + botId + ' falló 5 veces — eliminando');
            try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
            delete reintentos[botId];
            return;
          }
        }
        console.log('[SUB-BOT] ' + botId + ' reconectando (código ' + code + ')...');
        await delay(3000);
        return startSubBot(m, client, caption, isCode, phone, chatId, cmdFlags, isCmd);
      }

      // ── QR recibido ─────────────────────────────────────────────────────────
      if (qr && client && chatId && cmdFlags?.[m?.sender]) {
        if (isCode) {
          try {
            let code = await sock.requestPairingCode(id.replace(/\D/g, ''));
            // Formatear: XXXX-XXXX
            code = String(code).replace(/\W/g, '').match(/.{1,4}/g)?.join('-') || code;
            const msgCap  = await client.sendMessage(chatId, { text: caption }, { quoted: m });
            const msgCode = await client.sendMessage(chatId, { text: '*' + code + '*' }, { quoted: m });
            delete cmdFlags[m.sender];
            setTimeout(async () => {
              try { await client.sendMessage(chatId, { delete: msgCap.key }); } catch {}
              try { await client.sendMessage(chatId, { delete: msgCode.key }); } catch {}
            }, 60000);
          } catch (e) {
            console.error('[SUB-BOT] Error código pareo:', e.message);
          }
        } else {
          try {
            const qrcode  = (await import('qrcode')).default;
            const buf     = await qrcode.toBuffer(qr, { scale: 8 });
            const sentQR  = await client.sendMessage(chatId, { image: buf, caption }, { quoted: m });
            delete cmdFlags[m.sender];
            setTimeout(async () => {
              try { await client.sendMessage(chatId, { delete: sentQR.key }); } catch {}
            }, 60000);
          } catch (e) {
            console.error('[SUB-BOT] Error QR:', e.message);
          }
        }
      }
    });

    return sock;
  } catch (e) {
    console.error('[SUB-BOT] Error iniciando ' + id + ':', e.message);
  }
}

// ─── Inicializar sub-bots al arrancar ─────────────────────────────────────────
export async function initializeSubBots() {
  try {
    if (!fs.existsSync(JADIBTS)) return;
    const dirs = fs.readdirSync(JADIBTS);
    for (const dir of dirs) {
      const credsPath = path.join(JADIBTS, dir, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      const already = global.conns.find(c => getMeta(c).userId === dir || c.userId === dir);
      if (already) continue;
      console.log('[SUB-BOT] Iniciando sub-bot ' + dir);
      await startSubBot(null, null, '', false, dir, '', {}, false).catch(e =>
        console.error('[SUB-BOT] Error iniciando ' + dir + ':', e.message)
      );
      await delay(1500); // pequeña pausa entre subbots
    }
  } catch (e) {
    console.error('[SUB-BOT] Error en initializeSubBots:', e.message);
  }
}

// ─── Listar sub-bots ──────────────────────────────────────────────────────────
export function listSubBots() {
  const active = global.conns.filter(c => {
    const m = getMeta(c);
    return m.isInit && m.userId;
  });
  const saved = fs.existsSync(JADIBTS)
    ? fs.readdirSync(JADIBTS).filter(d => fs.existsSync(path.join(JADIBTS, d, 'creds.json')))
    : [];
  return { active, saved };
}

// ─── Eliminar un sub-bot ──────────────────────────────────────────────────────
export async function removeSubBot(userId) {
  const clean  = cleanJid(userId);
  const folder = path.join(JADIBTS, clean);
  const idx    = global.conns.findIndex(c => {
    const m = getMeta(c);
    return m.userId === clean || c.userId === clean;
  });
  if (idx >= 0) {
    const sock = global.conns[idx];
    getMeta(sock).fstop = true;
    try { sock.ws.close(); } catch {}
    sock.ev.removeAllListeners();
    global.conns.splice(idx, 1);
  }
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }
  return false;
}
