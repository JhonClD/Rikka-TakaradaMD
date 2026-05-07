import { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { jidDecode } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import { makeWASocket } from '../src/libraries/simple.js';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JADIBTS_DIR = path.join(__dirname, '../jadibts');
const commandFlags = {};
const reconnectMap = {};

function msToTime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 60000) % 60);
  const h = Math.floor((ms / 3600000) % 24);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function getBotJid(conn) {
  return conn.user.id.split(':')[0] + '@s.whatsapp.net';
}

function isSocketOwner(conn, sender) {
  const botJid = getBotJid(conn);
  const config = global.db.data.settings[botJid] || {};
  const owners = (global.owner || []).map(n => (Array.isArray(n) ? n[0] : n) + '@s.whatsapp.net');
  return [botJid, ...(config.owner ? [config.owner] : []), ...owners].includes(sender);
}

async function startSubBotFromCommand(m, client, caption, isCode, phone, chatId, flags) {
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
    keepAliveIntervalMs: 60_000,
    maxIdleTimeMs: 120_000,
    version,
  });

  sock.isInit = false;
  sock.ev.on('creds.update', saveCreds);

  let pairingDone = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

    if (connection === 'connecting' && isCode && phone && !pairingDone && flags[senderId]) {
      setTimeout(async () => {
        if (pairingDone) return;
        try {
          if (sock.authState?.creds?.registered) return;
          let code = await sock.requestPairingCode(phone);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          pairingDone = true;
          const mc = await client.sendMessage(chatId, { text: caption }, { quoted: m });
          const mk = await client.sendMessage(chatId, { text: `꒰ ✦ *Tu código:* ꒱\n┊⇢ \`${code}\`` }, { quoted: m });
          delete flags[senderId];
          setTimeout(async () => {
            try { await client.sendMessage(chatId, { delete: mc.key }); } catch {}
            try { await client.sendMessage(chatId, { delete: mk.key }); } catch {}
          }, 90000);
        } catch (e) {
          console.error('[SOCKET] Error código pairing:', e.message);
          if (!pairingDone && flags[senderId]) {
            await client.sendMessage(chatId, { text: `꒰ ✗ ꒱ Error generando código: *${e.message}*\n⸙͎ Verifica que el número sea correcto e intenta de nuevo.` }, { quoted: m }).catch(() => {});
            delete flags[senderId];
          }
        }
      }, 2000);
    }

    if (qr && !isCode && client && chatId && flags[senderId]) {
      try {
        const mq = await client.sendMessage(chatId, {
          image: await qrcode.toBuffer(qr, { scale: 8 }),
          caption,
        }, { quoted: m });
        delete flags[senderId];
        setTimeout(async () => { try { await client.sendMessage(chatId, { delete: mq.key }); } catch {} }, 60000);
      } catch (e) { console.error('[SOCKET] Error QR:', e.message); }
    }

    if (connection === 'open') {
      sock.isInit = true;
      const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!global.db.data.settings[botJid]) global.db.data.settings[botJid] = {};
      global.db.data.settings[botJid].type = 'Sub';
      delete reconnectMap[sessionId];
      if (!global.conns?.find(c => c.user?.id === sock.user?.id)) global.conns?.push(sock);
      console.log(`[SOCKET] +${sessionId} conectado`);
    }

    if (connection === 'close') {
      const reason  = lastDisconnect?.error?.output?.statusCode || 0;
      const retries = (reconnectMap[sessionId] || 0) + 1;
      reconnectMap[sessionId] = retries;
      if (retries > 5) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        delete reconnectMap[sessionId];
        return;
      }
      if ([401, 403, DisconnectReason.loggedOut].includes(reason)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        return;
      }
      setTimeout(() => startSubBotFromCommand(m, client, caption, isCode, phone, chatId, {}), 4000);
    }
  });

  return sock;
}

const handler = async (m, { conn, command, args, text, usedPrefix }) => {
  const botJid = getBotJid(conn);
  const config = global.db.data.settings[botJid] || (global.db.data.settings[botJid] = {});
  const isSockOwner = isSocketOwner(conn, m.sender);

  switch (command) {

    case 'code':
    case 'qr': {
      const user = global.db.data.users[m.sender] || (global.db.data.users[m.sender] = {});
      if (user.Subs && Date.now() - user.Subs < 120000) {
        return m.reply(`꒰ ✗ ꒱ Espera *${msToTime(120000 - (Date.now() - user.Subs))}* antes de vincular otro socket.`);
      }
      if (!fs.existsSync(JADIBTS_DIR)) fs.mkdirSync(JADIBTS_DIR, { recursive: true });
      const subsCount = fs.readdirSync(JADIBTS_DIR).filter(d =>
        fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
      ).length;
      if (subsCount >= 50) return m.reply('꒰ ✗ ꒱ No hay espacios disponibles (máx. 50 sub-bots).');

      const isCode = command === 'code';
      const phone  = args[0] ? args[0].replace(/\D/g, '') : null;

      if (isCode && !phone) {
        return m.reply(`⸙͎ Debes indicar el número con código de país.\n꒰ ✦ Ejemplo ꒱ *${usedPrefix}code 51925092348*`);
      }

      commandFlags[m.sender] = true;

      const capCode = `꒰ ✦ *Vincular Socket* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Ingresa el código en WhatsApp:\n┊⇢ *3 puntos* → *Dispositivos vinculados*\n┊⇢ *Vincular con número de teléfono*\n⌞────────────────⌟`;
      const capQR   = `꒰ ✦ *Vincular Socket* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Escanea el *QR* para vincular:\n┊⇢ *3 puntos* → *Dispositivos vinculados*\n┊⇢ *Vincular nuevo dispositivo*\n⌞────────────────⌟\n\n⸙͎ No uses tu cuenta principal.`;

      await m.reply(`꒰ ✦ ꒱ Iniciando vinculación${isCode ? ` para *+${phone}*` : ' vía QR'}...\n⸙͎ Espera unos segundos.`);
      await startSubBotFromCommand(m, conn, isCode ? capCode : capQR, isCode, phone, m.chat, commandFlags);
      user.Subs = Date.now();
      break;
    }

    case 'bots':
    case 'sockets': {
      const mainJid = global.conn?.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const groupP  = m.isGroup ? ((await conn.groupMetadata(m.chat).catch(() => ({}))).participants || []).map(p => p.id || '') : [];
      const subs    = fs.existsSync(JADIBTS_DIR)
        ? fs.readdirSync(JADIBTS_DIR).filter(d => fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))).map(d => d.replace(/\D/g, ''))
        : [];
      const mentioned = [];
      const lines     = [];
      if (global.db.data.settings[mainJid]) {
        const num = mainJid.split('@')[0];
        if (!m.isGroup || groupP.some(p => p.includes(num))) {
          mentioned.push(mainJid);
          lines.push(`┊⇢ 👑 [Owner *${global.db.data.settings[mainJid]?.botname || 'Rikka'}*] › @${num}`);
        }
      }
      for (const num of subs) {
        const jid = num + '@s.whatsapp.net';
        if (m.isGroup && !groupP.some(p => p.includes(num))) continue;
        mentioned.push(jid);
        lines.push(`┊⇢ 🌸 [Sub *${global.db.data.settings[jid]?.botname || 'Sub'}*] › @${num}`);
      }
      return conn.sendMessage(m.chat, {
        text: `꒰ ✦ *Sockets activos* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Total: *${1 + subs.length}*  ┊  En grupo: *${lines.length}*\n⌞────────────────⌟\n${lines.join('\n') || '┊⇢ Ninguno en este grupo.'}`,
        mentions: mentioned,
      }, { quoted: m });
    }

    case 'join':
    case 'unir': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      if (!args[0]) return m.reply(`⸙͎ Uso: *${usedPrefix}join <link>*`);
      const match = args[0].match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i);
      if (!match) return m.reply('꒰ ✗ ꒱ Enlace inválido.');
      try {
        await conn.groupAcceptInvite(match[1]);
        return m.reply('꒰ ✦ ꒱ Bot unido al grupo exitosamente.');
      } catch (e) { return m.reply(`꒰ ✗ ꒱ No se pudo unir: ${e.message}`); }
    }

    case 'leave': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      try { await conn.groupLeave(args[0] || m.chat); } catch (e) { return m.reply(`꒰ ✗ ꒱ Error: ${e.message}`); }
      break;
    }

    case 'logout': {
      const cleanId  = jidDecode(conn.user?.id || '')?.user || conn.user?.id?.split('@')[0] || '';
      const sessPath = path.join(JADIBTS_DIR, cleanId);
      if (!fs.existsSync(sessPath)) return m.reply('꒰ ✗ ꒱ Solo usable desde un sub-bot.');
      await m.reply('꒰ ✦ ꒱ Cerrando sesión...');
      try {
        await conn.logout();
        setTimeout(() => { try { fs.rmSync(sessPath, { recursive: true, force: true }); } catch {} }, 2000);
        setTimeout(() => m.reply(`꒰ ✦ ꒱ Sesión finalizada.\n┊⇢ Usa *${usedPrefix}code* para reconectar.`), 3000);
      } catch (e) { return m.reply(`꒰ ✗ ꒱ Error: ${e.message}`); }
      break;
    }

    case 'reload': {
      const cleanId  = jidDecode(conn.user?.id || '')?.user || conn.user?.id?.split('@')[0] || '';
      const sessPath = path.join(JADIBTS_DIR, cleanId);
      if (!fs.existsSync(sessPath)) return m.reply('꒰ ✗ ꒱ Solo usable desde un sub-bot.');
      await m.reply('꒰ ✦ ꒱ Reiniciando socket...');
      await startSubBotFromCommand(m, conn, '꒰ ✦ ꒱ Socket reiniciado.', false, args[0]?.replace(/\D/g, '') || m.sender.split('@')[0], m.chat, {});
      break;
    }

    case 'self': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      const sub = args[0]?.toLowerCase();
      if (sub === 'on'  || sub === 'enable')  { config.self = true;  return m.reply('꒰ ✦ ꒱ Modo *Self* activado.'); }
      if (sub === 'off' || sub === 'disable') { config.self = false; return m.reply('꒰ ✦ ꒱ Modo *Self* desactivado.'); }
      return m.reply(`꒰ ✦ *Self* ✦ ꒱\n┊⇢ *Estado:* ${config.self ? '✅ Activado' : '❌ Desactivado'}\n⸙͎ *${usedPrefix}self on/off*`);
    }

    case 'setbotname':
    case 'setname': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      const val = args.join(' ').trim();
      if (!val) return m.reply(`⸙͎ *${usedPrefix}setbotname Corto / Largo*`);
      const [s, l] = val.includes('/') ? val.split('/').map(x => x.trim()) : [val, val];
      if (/\s/.test(s)) return m.reply('꒰ ✗ ꒱ El nombre corto no puede tener espacios.');
      config.namebot = s; config.botname = l;
      return m.reply(`꒰ ✦ ꒱ Nombre actualizado.\n┊⇢ Corto: *${s}*\n┊⇢ Largo: *${l}*`);
    }

    case 'setstatus': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      const val = args.join(' ').trim();
      if (!val) return m.reply(`⸙͎ *${usedPrefix}setstatus <texto>*`);
      await conn.updateProfileStatus(val);
      return m.reply(`꒰ ✦ ꒱ Estado actualizado: *${val}*`);
    }

    case 'setimage':
    case 'setpfp': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      const q = m.quoted || m;
      if (!/image/i.test((q.msg || q).mimetype || q.mediaType || '')) return m.reply('⸙͎ Cita o envía una imagen.');
      const media = await q.download();
      if (!media) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');
      await conn.updateProfilePicture(botJid, media);
      return m.reply('꒰ ✦ ꒱ Foto de perfil actualizada.');
    }

    case 'setprefix':
    case 'setbotprefix': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      const val = args.join(' ').trim();
      if (!val) {
        const act = config.prefix === null ? '`sin prefijo`' : (Array.isArray(config.prefix) ? config.prefix : [config.prefix || '/']).map(p => `\`${p}\``).join(', ');
        return m.reply(`꒰ ✦ *Prefix* ✦ ꒱\n┊⇢ Actual: ${act}\n⸙͎ *${usedPrefix}setprefix .* / *noprefix* / *reset*`);
      }
      if (val === 'reset')    { config.prefix = ['#','/','.','!']; return m.reply(`꒰ ✦ ꒱ Prefijos restaurados.`); }
      if (val === 'noprefix') { config.prefix = true;              return m.reply('꒰ ✦ ꒱ Sin prefijo activado.'); }
      const lista = [...new Set(val.replace(/[a-zA-Z]/g, '').split(''))].filter(Boolean);
      if (!lista.length) return m.reply('꒰ ✗ ꒱ Sin prefijos válidos detectados.');
      if (lista.length > 6)  return m.reply('꒰ ✗ ꒱ Máximo 6 prefijos.');
      config.prefix = lista;
      return m.reply(`꒰ ✦ ꒱ Prefijo cambiado a *${lista.join(' ')}*`);
    }

    case 'setbotowner':
    case 'setowner': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos.');
      if (args[0]?.toLowerCase() === 'clear') {
        if (!config.owner) return m.reply('꒰ ✦ ꒱ No hay propietario asignado.');
        config.owner = '';
        return m.reply('꒰ ✦ ꒱ Propietario del socket eliminado.');
      }
      let who = m.mentionedJid?.[0] || m.quoted?.sender;
      if (!who && args[0]) { const n = args[0].replace(/\D/g, ''); if (n.length >= 10) who = n + '@s.whatsapp.net'; }
      if (!who) return m.reply(`⸙͎ Menciona al nuevo dueño: *${usedPrefix}setowner @usuario*`);
      const old = config.owner;
      config.owner = who;
      const msg = old && old !== who
        ? `꒰ ✦ ꒱ Propietario cambiado de @${old.split('@')[0]} a @${who.split('@')[0]}.`
        : `꒰ ✦ ꒱ @${who.split('@')[0]} asignado como propietario del socket.`;
      return conn.sendMessage(m.chat, { text: msg, mentions: [who, ...(old && old !== who ? [old] : [])] }, { quoted: m });
    }
  }
};

handler.command = [
  'code','qr','bots','sockets',
  'join','unir','leave','logout','reload','self',
  'setbotname','setname','setstatus','setimage','setpfp',
  'setprefix','setbotprefix','setbotowner','setowner',
];
handler.tags = ['socket'];
handler.help = [
  'code <número> — Vincular sub-bot por código',
  'qr — Vincular sub-bot por QR',
  'bots — Ver sockets activos',
  'join <link> — Unir al grupo',
  'leave — Salir del grupo',
  'logout — Cerrar sesión del socket',
  'reload — Reiniciar socket',
  'self on/off — Modo privado',
  'setbotname Corto / Largo',
  'setstatus <texto>',
  'setpfp — Foto de perfil',
  'setprefix <prefix>',
  'setowner @user',
];
export default handler;
      
