import { startSubBotFromCommand } from '../src/libraries/subBotManager.js';
import { jidDecode } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const JADIBTS_DIR  = path.join(__dirname, '../jadibts');
const commandFlags = {};

function msToTime(ms) {
  const s   = Math.floor((ms / 1000) % 60);
  const min = Math.floor((ms / (1000 * 60)) % 60);
  const h   = Math.floor((ms / (1000 * 60 * 60)) % 24);
  if (h)   return `${h}h ${min}m ${s}s`;
  if (min) return `${min}m ${s}s`;
  return `${s}s`;
}

function getBotJid(conn) {
  return conn.user.id.split(':')[0] + '@s.whatsapp.net';
}

function isSocketOwner(conn, sender) {
  const botJid   = getBotJid(conn);
  const config   = global.db.data.settings[botJid] || {};
  const owners   = global.owner.map(n => (Array.isArray(n) ? n[0] : n) + '@s.whatsapp.net');
  return [botJid, ...(config.owner ? [config.owner] : []), ...owners].includes(sender);
}

const handler = async (m, { conn, command, args, text, usedPrefix, isOwner, isBotAdmin, isAdmin, participants }) => {
  const botJid = getBotJid(conn);
  const config = global.db.data.settings[botJid] || (global.db.data.settings[botJid] = {});
  const isSockOwner = isSocketOwner(conn, m.sender);

  switch (command) {

    case 'code':
    case 'qr': {
      const db   = global.db.data;
      const user = db.users[m.sender] || (db.users[m.sender] = {});
      if (user.Subs && Date.now() - user.Subs < 120000) {
        const rem = 120000 - (Date.now() - user.Subs);
        return m.reply(`꒰ ✗ ꒱ Espera *${msToTime(rem)}* antes de vincular otro socket.`);
      }
      if (!fs.existsSync(JADIBTS_DIR)) fs.mkdirSync(JADIBTS_DIR, { recursive: true });
      const subsCount = fs.readdirSync(JADIBTS_DIR).filter(d =>
        fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
      ).length;
      if (subsCount >= 50) return m.reply('꒰ ✗ ꒱ No hay espacios disponibles para registrar un sub-bot (máx. 50).');
      commandFlags[m.sender] = true;
      const isCode = command === 'code';
      const phone  = args[0] ? args[0].replace(/\D/g, '') : m.sender.split('@')[0];
      const captionCode = `꒰ ✦ *Vincular Socket* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Usa el *código* para vincular tu cuenta.\n\n┊⇢ Toca los *3 puntos* → *Dispositivos vinculados*\n┊⇢ Toca *Vincular nuevo dispositivo*\n┊⇢ Selecciona *Vincular con número de teléfono*\n⌞────────────────⌟\n\n⸙͎ Este código solo funciona con el número que lo solicitó.`;
      const captionQR  = `꒰ ✦ *Vincular Socket* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Escanea el *código QR* para vincular tu cuenta.\n\n┊⇢ Toca los *3 puntos* → *Dispositivos vinculados*\n┊⇢ Toca *Vincular nuevo dispositivo*\n┊⇢ Escanea el *QR*\n⌞────────────────⌟\n\n⸙͎ No uses tu cuenta principal como socket.`;
      await startSubBotFromCommand(m, conn, isCode ? captionCode : captionQR, isCode, phone, m.chat, commandFlags, true);
      user.Subs = Date.now();
      break;
    }

    case 'bots':
    case 'sockets': {
      const mainJid    = global.conn?.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const groupParts = m.isGroup ? (await conn.groupMetadata(m.chat).catch(() => ({}))).participants?.map(p => p.id || p.jid || p.lid || '') || [] : [];
      const subs = fs.existsSync(JADIBTS_DIR)
        ? fs.readdirSync(JADIBTS_DIR).filter(d => fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))).map(d => d.replace(/\D/g, ''))
        : [];
      const mentioned = [];
      const mainLine  = [];
      const subLines  = [];
      if (global.db.data.settings[mainJid]) {
        const mainNum = mainJid.split('@')[0];
        if (!m.isGroup || groupParts.some(p => p.includes(mainNum))) {
          mentioned.push(mainJid);
          const n = global.db.data.settings[mainJid]?.botname || 'RiKka';
          mainLine.push(`┊⇢ 👑 [Owner *${n}*] › @${mainNum}`);
        }
      }
      for (const num of subs) {
        const jid = num + '@s.whatsapp.net';
        if (m.isGroup && !groupParts.some(p => p.includes(num))) continue;
        mentioned.push(jid);
        const n = global.db.data.settings[jid]?.botname || 'Sub';
        subLines.push(`┊⇢ 🌸 [Sub *${n}*] › @${num}`);
      }
      const total = (global.db.data.settings[mainJid] ? 1 : 0) + subs.length;
      const inGroup = mainLine.length + subLines.length;
      const msg = `꒰ ✦ *Sockets activos* ✦ ꒱\n⌜────────────────⌝\n┊⇢ Total: *${total}*  ┊  En grupo: *${inGroup}*\n┊⇢ 👑 Owner: *${mainLine.length > 0 ? 1 : 0}*  ┊  🌸 Subs: *${subs.length}*\n⌞────────────────⌟\n${[...mainLine, ...subLines].join('\n')}`;
      return conn.sendMessage(m.chat, { text: msg, mentions: mentioned }, { quoted: m });
    }

    case 'join':
    case 'unir': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      if (!args[0]) return m.reply(`⸙͎ Uso: *${usedPrefix}join <enlace del grupo>*`);
      const match = args[0].match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i);
      if (!match) return m.reply('꒰ ✗ ꒱ El enlace ingresado no es válido.');
      try {
        await conn.groupAcceptInvite(match[1]);
        return m.reply(`꒰ ✦ ꒱ El bot se unió al grupo exitosamente.`);
      } catch (e) {
        const err = String(e.message || e);
        if (err.includes('not-authorized') || err.includes('requires-admin'))
          return m.reply('꒰ ✗ ꒱ La unión requiere aprobación de un administrador.');
        return m.reply(`꒰ ✗ ꒱ No se pudo unir al grupo: ${err}`);
      }
    }

    case 'leave': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const groupId = args[0] || m.chat;
      try {
        await conn.groupLeave(groupId);
      } catch (e) {
        return m.reply(`꒰ ✗ ꒱ Error al salir del grupo: ${e.message}`);
      }
      break;
    }

    case 'logout': {
      const rawId   = conn.user?.id || '';
      const decoded = jidDecode(rawId);
      const cleanId = decoded?.user || rawId.split('@')[0];
      const sessPath = path.join(JADIBTS_DIR, cleanId);
      if (!fs.existsSync(sessPath)) return m.reply('꒰ ✗ ꒱ Este comando solo puede usarse desde un sub-bot.');
      await m.reply('꒰ ✦ ꒱ Cerrando sesión del socket...');
      try {
        await conn.logout();
        setTimeout(() => {
          try { fs.rmSync(sessPath, { recursive: true, force: true }); } catch {}
        }, 2000);
        setTimeout(() => m.reply(`꒰ ✦ ꒱ Sesión finalizada.\n┊⇢ Usa *${usedPrefix}code* para reconectarte.`), 3000);
      } catch (e) {
        return m.reply(`꒰ ✗ ꒱ Error al cerrar sesión: ${e.message}`);
      }
      break;
    }

    case 'reload': {
      const rawId   = conn.user?.id || '';
      const decoded = jidDecode(rawId);
      const cleanId = decoded?.user || rawId.split('@')[0];
      const sessPath = path.join(JADIBTS_DIR, cleanId);
      if (!fs.existsSync(sessPath)) return m.reply('꒰ ✗ ꒱ Este comando solo puede usarse desde un sub-bot.');
      await m.reply('꒰ ✦ ꒱ Reiniciando sesión del socket...');
      const phone = args[0] ? args[0].replace(/\D/g, '') : m.sender.split('@')[0];
      await startSubBotFromCommand(m, conn, '꒰ ✦ ꒱ Sesión reiniciada correctamente.', false, phone, m.chat, {}, true);
      break;
    }

    case 'self': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const sub = args[0]?.toLowerCase();
      if (sub === 'on' || sub === 'enable') {
        if (config.self) return m.reply('꒰ ✦ ꒱ El modo *Self* ya estaba activado.');
        config.self = true;
        return m.reply('꒰ ✦ ꒱ Modo *Self* activado.');
      }
      if (sub === 'off' || sub === 'disable') {
        if (!config.self) return m.reply('꒰ ✦ ꒱ El modo *Self* ya estaba desactivado.');
        config.self = false;
        return m.reply('꒰ ✦ ꒱ Modo *Self* desactivado.');
      }
      const estado = config.self ? '✅ Activado' : '❌ Desactivado';
      return m.reply(`꒰ ✦ *Self* ✦ ꒱\n┊⇢ *Estado:* ${estado}\n\n⸙͎ Uso:\n┊⇢ *${usedPrefix}self on/off*`);
    }

    case 'setbotname':
    case 'setname': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const value = args.join(' ').trim();
      if (!value) return m.reply(`⸙͎ Uso: *${usedPrefix}setbotname NombreCorto / Nombre Largo*`);
      const [short, long] = value.includes('/') ? value.split('/').map(s => s.trim()) : [value, value];
      if (!short || !long) return m.reply('꒰ ✗ ꒱ Formato inválido. Usa: NombreCorto / Nombre Largo');
      if (/\s/.test(short)) return m.reply('꒰ ✗ ꒱ El nombre corto no puede tener espacios.');
      config.namebot = short;
      config.botname = long;
      return m.reply(`꒰ ✦ ꒱ Nombre del bot actualizado.\n┊⇢ *Corto:* ${short}\n┊⇢ *Largo:* ${long}`);
    }

    case 'setstatus': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const value = args.join(' ').trim();
      if (!value) return m.reply(`⸙͎ Uso: *${usedPrefix}setstatus <texto>*`);
      await conn.updateProfileStatus(value);
      return m.reply(`꒰ ✦ ꒱ Estado del bot actualizado a: *${value}*`);
    }

    case 'setimage':
    case 'setpfp': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const q    = m.quoted || m;
      const mime = (q.msg || q).mimetype || q.mediaType || '';
      if (!/image/i.test(mime)) return m.reply('⸙͎ Cita o envía una imagen para cambiar la foto del bot.');
      const media = await q.download();
      if (!media) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');
      await conn.updateProfilePicture(botJid, media);
      return m.reply(`꒰ ✦ ꒱ Foto de perfil del bot actualizada.`);
    }

    case 'setprefix':
    case 'setbotprefix': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const value = args.join(' ').trim();
      const defaultPrefixes = ['#', '/', '!', '.'];
      if (!value) {
        const actual = config.prefix === null ? '`sin prefijo`' : (Array.isArray(config.prefix) ? config.prefix : [config.prefix || '/']).map(p => `\`${p}\``).join(', ');
        return m.reply(`꒰ ✦ *Prefix* ✦ ꒱\n┊⇢ Actual: ${actual}\n\n⸙͎ Uso:\n┊⇢ *${usedPrefix}setprefix .* → solo punto\n┊⇢ *${usedPrefix}setprefix !/.#* → múltiple\n┊⇢ *${usedPrefix}setprefix noprefix* → sin prefijo\n┊⇢ *${usedPrefix}setprefix reset* → restaurar`);
      }
      if (value === 'reset') {
        config.prefix = defaultPrefixes;
        return m.reply(`꒰ ✦ ꒱ Prefijos restaurados: *${defaultPrefixes.join(' ')}*`);
      }
      if (value === 'noprefix') {
        config.prefix = true;
        return m.reply('꒰ ✦ ꒱ Modo sin prefijo activado.');
      }
      const lista = [...new Set(value.replace(/[a-zA-Z]/g, '').split(''))].filter(Boolean);
      if (!lista.length) return m.reply('꒰ ✗ ꒱ No se detectaron prefijos válidos.');
      if (lista.length > 6) return m.reply('꒰ ✗ ꒱ Máximo 6 prefijos permitidos.');
      config.prefix = lista;
      return m.reply(`꒰ ✦ ꒱ Prefijo cambiado a *${lista.join(' ')}*`);
    }

    case 'setbotowner':
    case 'setowner': {
      if (!isSockOwner) return m.reply('꒰ ✗ ꒱ Sin permisos para usar este comando.');
      const sub = args[0]?.toLowerCase();
      if (sub === 'clear') {
        if (!config.owner) return m.reply('꒰ ✦ ꒱ No hay propietario asignado actualmente.');
        config.owner = '';
        return m.reply('꒰ ✦ ꒱ Propietario del socket eliminado.');
      }
      let who = m.mentionedJid?.[0] || m.quoted?.sender;
      if (!who && args[0]) {
        const num = args[0].replace(/\D/g, '');
        if (num.length >= 10) who = num + '@s.whatsapp.net';
      }
      if (!who) return m.reply(`⸙͎ Menciona al nuevo dueño del socket.\n↳ *${usedPrefix}setowner @usuario*`);
      if (config.owner && config.owner === who) {
        return conn.sendMessage(m.chat, { text: `꒰ ✦ ꒱ @${who.split('@')[0]} ya es el propietario del socket.`, mentions: [who] }, { quoted: m });
      }
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
  'code', 'qr',
  'bots', 'sockets',
  'join', 'unir',
  'leave',
  'logout',
  'reload',
  'self',
  'setbotname', 'setname',
  'setstatus',
  'setimage', 'setpfp',
  'setprefix', 'setbotprefix',
  'setbotowner', 'setowner',
];
handler.tags = ['socket'];
handler.help = [
  'code/qr — Vincular nuevo sub-bot',
  'bots — Ver sockets activos',
  'join <link> — Unir bot a grupo',
  'leave — Salir del grupo',
  'logout — Cerrar sesión del socket',
  'reload — Reiniciar sesión del socket',
  'self on/off — Modo privado',
  'setbotname Corto / Largo — Nombre del bot',
  'setstatus <texto> — Estado del bot',
  'setpfp — Foto de perfil del bot',
  'setprefix <prefix> — Prefijo del socket',
  'setowner @user — Propietario del socket',
];

export default handler;
