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
// favtop.js — Portado de YukiBot-MD → Rikka-TakaradaMD


const charactersFilePath = './core/characters.json'

const handler = async (m, { conn, command, usedPrefix, args }) => {
    const chat = global.db.data.chats[m.chat]
    if (chat.adminonly || !chat.gacha) {
      return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
    }
    if (!global.db.data.users) global.db.data.users = {}
    if (!global.db.data.characters) global.db.data.characters = {}
    try {
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const counts = {}
      for (const [id, user] of Object.entries(global.db.data.users)) {
        const favId = user.favorite
        if (favId) counts[favId] = (counts[favId] || 0) + 1
      }
      const enriched = allCharacters.map(c => ({ name: c.name, favorites: counts[c.id] || 0 })).filter(e => e.favorites > 0)
      const page = parseInt(args[0]) || 1
      const perPage = 10
      const totalPages = Math.max(1, Math.ceil(enriched.length / perPage))
      if (page < 1 || page > totalPages) {
        return m.reply(`ꕥ Página no válida. Hay un total de *${totalPages}* páginas.`)
      }
      const sorted = enriched.sort((a, b) => b.favorites - a.favorites)
      const sliced = sorted.slice((page - 1) * perPage, page * perPage)
      let msg = '✰ Top de personajes favoritos:\n\n'
      sliced.forEach((char, i) => {
        msg += `#${(page - 1) * perPage + i + 1} » *${char.name}*\n`
        msg += `   ♡ ${char.favorites} favorito${char.favorites !== 1 ? 's' : ''}.\n`
      })
      msg += `\n> Página ${page} de ${totalPages}`
      await conn.sendMessage(m.chat, { text: msg.trim() }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['favtop', 'favoritetop', 'favboard'];
handler.tags = ['gacha'];
handler.group = true;

export default handler;
