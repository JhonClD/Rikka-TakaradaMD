// gacha-ginfo.js — Info de gacha personal del usuario
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
function flattenCharacters(s) {
  return Object.values(s).flatMap(x => Array.isArray(x.characters) ? x.characters : []);
}
function formatTime(ms) {
  if (ms <= 0) return 'Disponible ahora';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = [];
  if (h)   p.push(`${h}h`);
  if (m || h) p.push(`${m}m`);
  p.push(`${sec}s`);
  return p.join(' ');
}

const handler = async (m, { conn, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];


  if (!chat.users[m.sender]) chat.users[m.sender] = {};

  if (chat.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  const me = global.db.data.users[m.sender] || {};
  const globalUser = global.db.data.users[m.sender] || {};
  const now        = Date.now();

  const rollLeft  = me.lastrw  && now < me.lastrw  ? me.lastrw  - now : 0;
  const claimLeft = me.lastclaim && now < me.lastclaim ? me.lastclaim - now : 0;

  let structure;
  try { structure = await loadCharacters(); } catch { return m.reply('❲ ✗ ❳ No se pudo leer characters.json'); }
  const allCharacters  = flattenCharacters(structure);
  const totalCharacters = allCharacters.length;
  const totalSeries    = Object.keys(structure).length;

  const claimedIDs = Object.entries(chat.gacha_characters)
    .filter(([, c]) => c.user === m.sender).map(([id]) => id);
  const totalValue = claimedIDs.reduce((sum, id) => {
    const gv  = global.db.data.characters?.[id]?.value;
    const jv  = allCharacters.find(c => c.id == id)?.value || 0;
    return sum + (typeof gv === 'number' ? gv : jv);
  }, 0);

  const userName = global.db.data.users[m.sender]?.name || m.sender.split('@')[0];
  const msg = `˗ˏˋ *Gacha Info — ${userName}* ˎˊ-\n\n` +
    `⇢ Roll waifu ➤ *${formatTime(rollLeft)}*\n` +
    `⇢ Claim     ➤ *${formatTime(claimLeft)}*\n\n` +
    `⇢ Reclamados ➤ *${claimedIDs.length}*\n` +
    `⇢ Valor total ➤ *¥${totalValue.toLocaleString()}*\n` +
    `⇢ Personajes DB ➤ *${totalCharacters}*\n` +
    `⇢ Series DB ➤ *${totalSeries}*`;

  await conn.sendMessage(m.chat, { text: msg.trim() }, { quoted: m });
};

handler.command = ['gachainfo', 'ginfo', 'infogacha'];
handler.tags    = ['gacha'];
handler.help    = ['ginfo — Ver tu info de gacha (cooldowns, personajes, valor)'];
handler.group   = true;

export default handler;
