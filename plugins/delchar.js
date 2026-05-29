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
// delchar.js — Portado de YukiBot-MD → Rikka-TakaradaMD


const charactersFilePath = './core/characters.json'

const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat]
      if (!chat.users) chat.users = {}
      if (!chat.characters) chat.characters = {}
      if (!chat.sales) chat.sales = {}
      if (!chat.users[m.sender]) chat.users[m.sender] = {}
      const me = chat.users[m.sender]
      if (!Array.isArray(me.characters)) me.characters = []
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
      }
      if (!me.characters.length) {
        return m.reply(`❀ No tienes personajes reclamados en tu harem.`)
      }
      if (!args.length) {
        return m.reply(`❀ Debes especificar un personaje para eliminar.\n> Ejemplo » *${usedPrefix + command} Yuki Suou*`)
      }
      const inputName = args.join(' ').toLowerCase().trim()
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const character = allCharacters.find(c => c.name.toLowerCase() === inputName)
      if (!character) {
        return m.reply(`ꕥ No se ha encontrado ningún personaje con el nombre *${inputName}*\n> Puedes sugerirlo usando *${usedPrefix}suggest personaje ${inputName}*`)
      }
      const record = chat.characters[character.id]
      if (!record || record.user !== m.sender || !me.characters.includes(character.id)) {
        return m.reply(`ꕥ *${character.name}* no está reclamado por ti.`)
      }
      delete chat.characters[character.id]
      me.characters = me.characters.filter(id => id !== character.id)
      if (chat.sales?.[character.id] && chat.sales[character.id].user === m.sender) {
        delete chat.sales[character.id]
      }
      if (chat.users[m.sender].favorite === character.id) {
        delete chat.users[m.sender].favorite
      }
      if (global.db.data.users?.[m.sender]?.favorite === character.id) {
        delete global.db.data.users[m.sender].favorite
      }
      await conn.sendMessage(m.chat, { text: `❀ *${character.name}* ha sido eliminado de tu lista de reclamados.` }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['delchar', 'deletewaifu', 'delwaifu'];
handler.tags = ['gacha'];
handler.group = true;

export default handler;
