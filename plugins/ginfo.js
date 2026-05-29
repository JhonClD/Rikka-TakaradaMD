import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __FILE__ = fileURLToPath(import.meta.url);
const __DIR__ = path.dirname(__FILE__);
const CHARS_PATH = path.join(__DIR__, '../core/characters.json');

async function loadCharacters() {
  try { await fs.access(CHARS_PATH); } catch { await fs.writeFile(CHARS_PATH, '{}'); }
  return JSON.parse(await fs.readFile(CHARS_PATH, 'utf-8'));
}
function flattenCharacters(db) {
  return Object.values(db).flatMap(s => Array.isArray(s.characters) ? s.characters : []);
}
function getCharacterById(id, structure) {
  return flattenCharacters(structure).find(c => String(c.id) === String(id));
}
function getSeriesNameByCharacter(db, id) {
  return Object.entries(db).find(([, s]) => Array.isArray(s.characters) && s.characters.some(c => String(c.id) === String(id)))?.[1]?.name || 'Desconocido';
}

function formatTime(ms) {
  if (ms <= 0) return 'Ahora';
  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);
  parts.push(`${seconds} segundo${seconds !== 1 ? 's' : ''}`);
  return parts.join(' ');
}
// ginfo.js — Portado de YukiBot-MD → Rikka-TakaradaMD


const charactersFilePath = './core/characters.json'


const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat]
      if (!chat.characters) chat.characters = {}
      if (!chat.users) chat.users = {}
      if (!chat.users[m.sender]) chat.users[m.sender] = {}
      const me = chat.users[m.sender]
      const globalUser = global.db.data.users[m.sender]
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
      }
      const now = Date.now()
      const rollLeft = me.lastRoll && now < me.lastRoll ? me.lastRoll - now : 0
      const claimLeft = me.lastClaim && now < me.lastClaim ? me.lastClaim - now : 0
      const voteLeft = globalUser.lastVote && now < globalUser.lastVote ? globalUser.lastVote - now : 0
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const totalCharacters = allCharacters.length
      const totalSeries = Object.keys(structure).length
      const claimedIDs = Object.entries(chat.characters).filter(([, c]) => c.user === m.sender).map(([id]) => id)
      const totalValue = claimedIDs.reduce((sum, id) => {
        const globalVal = global.db.data.characters?.[id]?.value
        const jsonVal = allCharacters.find(c => c.id === id)?.value || 0
        const value = typeof globalVal === 'number' ? globalVal : jsonVal
        return sum + value
      }, 0)
      let userName = global.db.data.users[m.sender]?.name || m.sender.split('@')[0]
      const msg = `*❀ Usuario \`<${userName}>\`*\n\nⴵ RollWaifu » *${formatTime(rollLeft)}*\nⴵ Claim » *${formatTime(claimLeft)}*\nⴵ Vote » *${formatTime(voteLeft)}*\n\n♡ Personajes reclamados » *${claimedIDs.length}*\n✰ Valor total » *${totalValue.toLocaleString()}*\n❏ Personajes totales » *${totalCharacters}*\n❏ Series totales » *${totalSeries}*`
      await conn.sendMessage(m.chat, { text: msg.trim() }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['gachainfo', 'ginfo', 'infogacha'];
handler.tags = ['gacha'];

export default handler;
