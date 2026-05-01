// gacha-claim.js — Reclamar waifu tras un roll
// Portado de YukiBot-MD → Rikka-TakaradaMD

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH  = path.join(__dirname, '../core/characters.json');

async function loadCharacters() {
  const raw = await fs.readFile(FILE_PATH, 'utf-8');
  return JSON.parse(raw);
}

function getCharacterById(id, structure) {
  return Object.values(structure).flatMap(s => s.characters || []).find(c => String(c.id) === String(id));
}

const handler = async (m, { conn, usedPrefix, command }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];
  chat.users = chat.users || {};
  chat.characters = chat.characters || {};
  chat.rolls = chat.rolls || {};

  if (chat.gacha === false) {
    return m.reply(`ꕥ El Gacha está desactivado.\n» *${usedPrefix}gacha on* para activarlo.`);
  }

  if (!chat.users[m.sender]) chat.users[m.sender] = {};
  const me  = chat.users[m.sender];
  const now = Date.now();
  const cooldown = 30 * 60 * 1000;

  if (me.lastClaim && now < me.lastClaim) {
    const r = Math.ceil((me.lastClaim - now) / 1000);
    const min = Math.floor(r / 60), sec = r % 60;
    let t = '';
    if (min > 0) t += `${min} minuto${min !== 1 ? 's' : ''} `;
    if (sec > 0 || !t) t += `${sec} segundo${sec !== 1 ? 's' : ''}`;
    return m.reply(`ꕥ Debes esperar *${t.trim()}* para hacer *claim* de nuevo.`);
  }

  const quotedId = m.quoted?.id;
  if (!quotedId || !chat.rolls[quotedId]) {
    return m.reply(`❀ Debes *citar* un roll válido para reclamar.\nUsa *${usedPrefix}rw* y luego responde el mensaje.`);
  }

  const rollData = chat.rolls[quotedId];
  const id = rollData.id;

  let structure;
  try {
    structure = await loadCharacters();
  } catch {
    return m.reply('ꕥ No se pudo leer la base de datos de personajes.');
  }

  const sourceData = getCharacterById(id, structure);
  if (!sourceData) return m.reply('ꕥ Personaje no encontrado en characters.json.');

  if (!chat.characters[id]) chat.characters[id] = {};
  const record    = chat.characters[id];
  const globalRec = global.db.data.characters?.[id] || {};

  record.name  = record.name || sourceData.name;
  record.value = typeof globalRec.value === 'number' ? globalRec.value : (sourceData.value || 0);
  record.votes = record.votes || 0;

  if (record.reservedBy && record.reservedBy !== m.sender && now < record.reservedUntil) {
    const rName = global.db.data.users[record.reservedBy]?.name || record.reservedBy.split('@')[0];
    const rem   = ((record.reservedUntil - now) / 1000).toFixed(1);
    return m.reply(`ꕥ Este personaje está protegido por *${rName}* durante *${rem}s.*`);
  }

  if (record.expiresAt && now > record.expiresAt && !record.user && !(record.reservedBy && now < record.reservedUntil)) {
    const exp = ((now - record.expiresAt) / 1000).toFixed(1);
    return m.reply(`ꕥ El personaje ha expirado hace ${exp}s.`);
  }

  if (record.user) {
    const ownerName = global.db.data.users[record.user]?.name || `@${record.user.split('@')[0]}`;
    return m.reply(`ꕥ *${record.name}* ya fue reclamado por *${ownerName}*.`);
  }

  record.user      = m.sender;
  record.claimedAt = now;
  delete record.reservedBy;
  delete record.reservedUntil;
  me.lastClaim = now + cooldown;

  if (!Array.isArray(me.characters)) me.characters = [];
  if (!me.characters.includes(id)) me.characters.push(id);

  const displayName = global.db.data.users[m.sender]?.name || m.sender.split('@')[0];
  const custom      = global.db.data.users?.[m.sender]?.claimMessage;
  const duration    = ((now - record.expiresAt + 60000) / 1000).toFixed(1);
  const finalMsg    = custom
    ? custom.replace(/€user/g, `*${displayName}*`).replace(/€character/g, `*${record.name}*`)
    : `*${record.name}* ha sido reclamado por *${displayName}*`;

  await conn.sendMessage(m.chat, { text: `❀ ${finalMsg} (${duration}s)` }, { quoted: m });
  chat.rolls[quotedId].claimed = true;
};

handler.command = ['claim', 'c', 'reclamar'];
handler.tags    = ['gacha'];
handler.help    = ['c — Reclamar el personaje del último roll (citar el mensaje)'];
handler.group   = true;

export default handler;
