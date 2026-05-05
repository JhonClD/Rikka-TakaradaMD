// subbot.js — Gestión de sub-bots para Rikka-TakaradaMD
// Self-contained: no depende de exports del subBotManager ofuscado

import {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { makeWASocket } from '../src/libraries/simple.js';
import store from '../src/libraries/store.js';
import NodeCache from 'node-cache';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS    = path.join(__dirname, '../jadibts');
const COOLDOWN   = 120000;
const MAX_SUBS   = 50;
const silentLog  = pino({ level: 'silent' });
const cmdFlags   = {};
const reintentos = {};
const delay      = (ms) => new Promise(r => setTimeout(r, ms));
const cleanJid   = (j) => String(j).replace(/:\d+/, '').split('@')[0];

if (!fs.existsSync(JADIBTS)) fs.mkdirSync(JADIBTS, { recursive: true });
if (!global.conns) global.conns = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function msToTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0
    ? m + ' minuto' + (m !== 1 ? 's' : '') + ', ' + sec + ' segundo' + (sec !== 1 ? 's' : '')
    : sec + ' segundo' + (sec !== 1 ? 's' : '');
}

function listSubBots() {
  const active = global.conns.filter(c => c.isInit && c.userId);
  const saved  = fs.existsSync(JADIBTS)
    ? fs.readdirSync(JADIBTS).filter(d => fs.existsSync(path.join(JADIBTS, d, 'creds.json')))
    : [];
  return { active, saved };
}

async function removeSubBot(userId) {
  const clean  = cleanJid(userId);
  const folder = path.join(JADIBTS, clean);
  const idx    = global.conns.findIndex(c => c.userId === clean);
  if (idx >= 0) {
    const sock = global.conns[idx];
    sock.fstop = true;
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

// ─── Registrar handlers del handler.js principal en el sub-bot ────────────────
async function registerHandlers(sock) {
  try {
    const handlerPath = path.join(__dirname, '../handler.js');
    const mod = await import(handlerPath + '?t=' + Date.now()).catch(console.error);
    if (!mod || !mod.handler) {
      return console.error('[SUB-BOT] handler.js no exporta handler');
    }
    store.bind(sock);

    const evMap = [
      ['messages.upsert',          '_msgHandler',  'handler'],
      ['group-participants.update', '_partUpdate',  'participantsUpdate'],
      ['groups.update',             '_grpUpdate',   'groupsUpdate'],
      ['message.delete',            '_delUpdate',   'deleteUpdate'],
      ['call',                      '_callUpdate',  'callUpdate'],
    ];
    for (const [evt, key] of evMap) {
      if (sock[key]) sock.ev.off(evt, sock[key]);
    }
    for (const [evt, key, exportName] of evMap) {
      if (!mod[exportName]) continue;
      sock[key] = mod[exportName].bind(sock);
      sock.ev.on(evt, sock[key]);
    }
    sock.handler            = sock._msgHandler;
    sock.participantsUpdate = sock._partUpdate;
    sock.groupsUpdate       = sock._grpUpdate;
    sock.subreloadHandler   = () => registerHandlers(sock);
  } catch (e) {
    console.error('[SUB-BOT] Error registrando handlers:', e.message);
  }
}

// ─── Iniciar sub-bot ──────────────────────────────────────────────────────────
async function startSubBot(m, client, caption, isCode, phone, chatId, flags, isCmd) {
  const id       = phone || (m ? m.sender.split('@')[0] : '');
  const folder   = path.join(JADIBTS, id);
  const senderId = m ? m.sender : '';

  try {
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version }          = await fetchLatestBaileysVersion();
    const msgRetry             = new NodeCache({ stdTTL: 0, checkperiod: 0 });

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
      getMessage: async (key) => {
        const msg = await store.loadMessage(jidNormalizedUser(key.remoteJid), key.id);
        return msg ? msg.message : '';
      },
      msgRetryCounterCache: msgRetry,
      version,
      keepAliveIntervalMs:  60000,
      maxIdleTimeMs:        120000,
      waWebSocketUrl:       'wss://web.whatsapp.com/ws/chat?ED=CAIICA',
    };

    let sock = makeWASocket(cfg);
    sock.isInit = false;
    sock.userId = null;
    sock.uptime = Date.now();
    sock.ev.on('creds.update', saveCreds);

    // Watchdog — si el user desaparece después de conectar, limpiar
    const watchdog = setInterval(() => {
      if (sock.isInit && !sock.user) {
        clearInterval(watchdog);
        try { sock.ws.close(); } catch {}
        sock.ev.removeAllListeners();
        const idx = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);
      }
    }, 60000);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      // ── Conectado ──────────────────────────────────────────────────────────
      if (connection === 'open') {
        clearInterval(watchdog);
        sock.isInit = true;
        sock.userId = cleanJid(sock.user ? sock.user.id : '');
        const botJid = sock.userId + '@s.whatsapp.net';

        if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
        global.db.data.settings[botJid].type = 'Sub';

        if (!global.conns.find(c => c.userId === sock.userId)) global.conns.push(sock);
        delete reintentos[sock.userId || id];

        await registerHandlers(sock);
        console.log('[SUB-BOT] Conectado: ' + sock.userId);
      }

      // ── Desconectado ───────────────────────────────────────────────────────
      if (connection === 'close') {
        clearInterval(watchdog);
        const botId = sock.userId || id;
        const code  = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output)
          ? (lastDisconnect.error.output.statusCode || 0) : 0;

        const idx = global.conns.indexOf(sock);
        if (idx >= 0) global.conns.splice(idx, 1);

        if (sock.fstop) {
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
            console.log('[SUB-BOT] ' + botId + ' falló 5 veces — eliminando sesión');
            try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
            delete reintentos[botId];
            return;
          }
        }
        console.log('[SUB-BOT] ' + botId + ' reconectando... (código ' + code + ')');
        await delay(3000);
        return startSubBot(m, client, caption, isCode, phone, chatId, flags, isCmd);
      }

      // ── QR recibido ────────────────────────────────────────────────────────
      if (qr && client && chatId && flags[senderId]) {
        if (isCode) {
          try {
            let code = await sock.requestPairingCode(id.replace(/\D/g, ''));
            code = code.match(/.{1,4}/g).join('-');
            const msgCap  = await client.sendMessage(chatId, { text: caption }, { quoted: m });
            const msgCode = await client.sendMessage(chatId, { text: '*' + code + '*' }, { quoted: m });
            delete flags[senderId];
            setTimeout(async () => {
              try { await client.sendMessage(chatId, { delete: msgCap.key }); } catch {}
              try { await client.sendMessage(chatId, { delete: msgCode.key }); } catch {}
            }, 60000);
          } catch (e) {
            console.error('[SUB-BOT] Error código pareo:', e.message);
          }
        } else {
          try {
            const buf = await qrcode.toBuffer(qr, { scale: 8 });
            const sentQR = await client.sendMessage(chatId, { image: buf, caption }, { quoted: m });
            delete flags[senderId];
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

// ─── Handler del plugin ───────────────────────────────────────────────────────
const handler = async (m, { conn, command, args, usedPrefix, isOwner, isROwner }) => {
  const user = global.db.data.users[m.sender];
  if (!user) return;

  // .code / .qr
  if (command === 'code' || command === 'qr') {
    const lastSub = user.Subs || 0;
    const diff    = Date.now() - lastSub;
    if (diff < COOLDOWN) {
      return m.reply('⇢ ʚ Espera *' + msToTime(COOLDOWN - diff) + '* para volver a vincular ɞ');
    }
    const { saved } = listSubBots();
    if (saved.length >= MAX_SUBS) {
      return m.reply('↳ ✗ No hay espacios disponibles para registrar un Sub-Bot.');
    }

    const isCode = command === 'code';
    const phone  = args[0] ? args[0].replace(/\D/g, '') : m.sender.split('@')[0];

    const capCode = '`✤` Vincula tu *cuenta* usando el *código.*\n\n> ✥ Sigue las instrucciones\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Selecciona *Vincular con el número de teléfono*\n\nꕤ *`Importante`*\n> ₊·( 🜸 ) ➭ Este Código solo funciona en el número que lo solicitó';
    const capQR   = '`✤` Vincula tu *cuenta* usando *código QR.*\n\n> ✥ Sigue las instrucciones\n\n*›* Click en los *3 puntos*\n*›* Toque *dispositivos vinculados*\n*›* Vincular *nuevo dispositivo*\n*›* Escanea el código QR.\n\n> ₊·( 🜸 ) ➭ No uses tu cuenta principal.';

    cmdFlags[m.sender] = true;
    user.Subs = Date.now();
    await startSubBot(m, conn, isCode ? capCode : capQR, isCode, phone, m.chat, cmdFlags, true);
    return;
  }

  // .listsub
  if (command === 'listsub' || command === 'listbot' || command === 'subbots') {
    const { active, saved } = listSubBots();
    if (!saved.length) return m.reply('↳ No hay sub-bots registrados aún.');
    let text = '˗ˏˋ *Sub-Bots* ˎˊ-\n⇢ Guardados: *' + saved.length + '* ˑ Activos: *' + active.length + '*\n\n';
    for (const dir of saved) {
      const on = active.some(c => c.userId === dir);
      text += '⇢ *+' + dir + '* ➤ ' + (on ? '🟢 Conectado' : '🔴 Desconectado') + '\n';
    }
    return m.reply(text.trim());
  }

  // .delsub
  if (command === 'delsub' || command === 'delbot' || command === 'removesub') {
    if (!isOwner && !isROwner) return m.reply('↳ ✗ Solo el *owner* puede usar este comando.');
    const raw    = args[0] || (m.mentionedJid && m.mentionedJid[0] ? m.mentionedJid[0] : (m.quoted ? m.quoted.sender : ''));
    const target = cleanJid(raw);
    if (!target) return m.reply('⸙͎ Uso: *' + usedPrefix + 'delsub <número>*');
    if (!fs.existsSync(path.join(JADIBTS, target))) return m.reply('ꕥ No se encontró el sub-bot *+' + target + '*.');
    const ok = await removeSubBot(target);
    return m.reply(ok ? '✩ Sub-bot *+' + target + '* eliminado ❁' : '↳ ✗ No se pudo eliminar *+' + target + '*');
  }

  // .subreload
  if (command === 'subreload' || command === 'reloadsub') {
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
           
