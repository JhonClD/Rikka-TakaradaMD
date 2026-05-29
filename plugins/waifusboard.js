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
// waifusboard.js — Portado de YukiBot-MD → Rikka-TakaradaMD


const charactersFilePath = './core/characters.json'


const handler = async (m, { conn, command, usedPrefix, args }) => {
    const chat = global.db.data.chats[m.chat]
    if (chat.adminonly || !chat.gacha) {
      return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
    }
    if (!global.db.data.characters) global.db.data.characters = {}
    try {
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const enriched = allCharacters.map(c => {
        if (!global.db.data.characters[c.id]) global.db.data.characters[c.id] = {}
        const record = global.db.data.characters[c.id]
        const value = typeof record.value === 'number' ? record.value : Number(c.value || 0)
        return { name: c.name, value }
      })
      const page = parseInt(args[0]) || 1
      const perPage = 10
      const totalPages = Math.ceil(enriched.length / perPage)
      if (page < 1 || page > totalPages) {
        return m.reply(`ꕥ Página no válida. Hay un total de *${totalPages}* páginas.`)
      }
      const sorted = enriched.sort((a, b) => b.value - a.value)
      const sliced = sorted.slice((page - 1) * perPage, page * perPage)
      let message = '❀ *Personajes con más valor:*\n\n'
      sliced.forEach((char, i) => {
        message += `✰ ${((page - 1) * perPage) + i + 1} » *${char.name}*\n`
        message += `   → Valor: *${char.value.toLocaleString()}*\n`
      })
      message += `\n⌦ Página *${page}* de *${totalPages}*`
      if (page < totalPages) {
        message += `\n> Para ver la siguiente página › *waifusboard ${page + 1}*`
      }
      await conn.sendMessage(m.chat, { text: message.trim() }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['waifusboard', 'waifustop', 'topwaifus', 'wtop'];
handler.tags = ['gacha'];

export default handler;
