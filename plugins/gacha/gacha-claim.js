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




  if (chat.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  if (!global.db.data.users[m.sender]) global.db.data.users[m.sender] = {};
  const me = global.db.data.users[m.sender];
  const now = Date.now();
  const cooldown = 30 * 60 * 1000;

  if (me.lastclaim && now < me.lastclaim) {
    const r = Math.ceil((me.lastclaim - now) / 1000);
    const min = Math.floor(r / 60), sec = r % 60;
    let t = '';
    if (min > 0) t += `${min} minuto${min !== 1 ? 's' : ''} `;
    if (sec > 0 || !t) t += `${sec} segundo${sec !== 1 ? 's' : ''}`;
    return m.reply(`⇢ ʚ Espera *${t.trim()}* para hacer otro *claim* ɞ`);
  }

  const quotedId = m.quoted?.id;
  if (!quotedId || !chat.gacha_rolls[quotedId]) {
    return m.reply(`⸙͎ Cita un roll válido para reclamar.\n↳ Usa *${usedPrefix}rw* y responde ese mensaje.`);
  }

  const rollData = chat.gacha_rolls[quotedId];
  const id = rollData.id;

  let structure;
  try {
    structure = await loadCharacters();
  } catch {
    return m.reply('❲ ✗ ❳ No se pudo leer la base de datos de personajes.');
  }

  const sourceData = getCharacterById(id, structure);
  if (!sourceData) return m.reply('❲ ✗ ❳ Personaje no encontrado en la base de datos.');

  if (!chat.gacha_characters[id]) chat.gacha_characters[id] = {};
  const record    = chat.gacha_characters[id];
  const globalRec = global.db.data.characters?.[id] || {};

  record.name  = record.name || sourceData.name;
  record.value = typeof globalRec.value === 'number' ? globalRec.value : (sourceData.value || 0);
  record.votes = record.votes || 0;

  if (record.reservedBy && record.reservedBy !== m.sender && now < record.reservedUntil) {
    const rName = global.db.data.users[record.reservedBy]?.name || record.reservedBy.split('@')[0];
    const rem   = ((record.reservedUntil - now) / 1000).toFixed(1);
    return m.reply(`❁ཻུ۪۪ *${rName}* tiene prioridad durante *${rem}s*`);
  }

  if (record.expiresAt && now > record.expiresAt && !record.user && !(record.reservedBy && now < record.reservedUntil)) {
    const exp = ((now - record.expiresAt) / 1000).toFixed(1);
    return m.reply(`↳ ✗ El personaje expiró hace *${exp}s*`);
  }

  if (record.user) {
    const ownerName = global.db.data.users[record.user]?.name || `@${record.user.split('@')[0]}`;
    return m.reply(`❝ *${record.name}* ❞ ya fue reclamado por *${ownerName}*`);
  }

  record.user      = m.sender;
  record.claimedAt = now;
  delete record.reservedBy;
  delete record.reservedUntil;
  me.lastclaim = now + cooldown;

  if (!Array.isArray(me.gacha_characters)) me.gacha_characters = [];
  if (!me.gacha_characters.includes(id)) me.gacha_characters.push(id);

  const displayName = global.db.data.users[m.sender]?.name || m.sender.split('@')[0];
  const custom      = global.db.data.users?.[m.sender]?.claimMessage;
  const duration    = ((now - record.expiresAt + 60000) / 1000).toFixed(1);
  const finalMsg    = custom
    ? custom.replace(/€user/g, `*${displayName}*`).replace(/€character/g, `*${record.name}*`)
    : `*${record.name}* ha sido reclamado por *${displayName}*`;

  await conn.sendMessage(m.chat, { text: `✩ ${finalMsg} ˑ *(${duration}s)*` }, { quoted: m });
  chat.gacha_rolls[quotedId].claimed = true;
};

handler.command = ['claim', 'c', 'reclamar'];
handler.tags    = ['gacha'];
handler.help    = ['c — Reclamar el personaje del último roll (citar el mensaje)'];
handler.group   = true;

export default handler;
