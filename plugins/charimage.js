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

import axios from 'axios';

function formatTag(tag) { return String(tag).trim().toLowerCase().replace(/\s+/g, '_'); }
function getReferer(url) {
  if (url.includes('safebooru.org')) return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai.us')) return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com')) return 'https://gelbooru.com/';
  return '';
}
async function buscarImagenDelirius(tag) {
  const q = formatTag(tag);
  const sources = [
    { url: `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=${q}&limit=100`,
      extract: d => { const p = Array.isArray(d) ? d : d?.post || []; return p.map(i => i?.file_url || (i?.directory && i?.image ? `https://safebooru.org/images/${i.directory}/${i.image}` : null)).filter(u => u && /\.(jpe?g|png)(\?.*)?$/i.test(u)); }},
    { url: `https://danbooru.donmai.us/posts.json?tags=${q}&limit=100`,
      extract: d => (Array.isArray(d) ? d : []).map(i => i?.file_url || i?.large_file_url).filter(u => u && /\.(jpe?g|png)(\?.*)?$/i.test(u)) },
    { url: `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&tags=${q}&limit=100&api_key=98f554258c88c44f4dd28ccde0c28f36682b2a992490ab35ebcc7baf7e196a86d7550b174bce577b8cc3f544e9b3ad0f6aeb09ad63bf89a9141cc3eddb6fbfd2&user_id=1917269`,
      extract: d => { const p = Array.isArray(d) ? d : d?.post || d?.data || []; return p.map(i => i?.file_url).filter(u => u && /\.(jpe?g|png)(\?.*)?$/i.test(u)); }},
  ];
  const results = await Promise.allSettled(sources.map(async s => {
    const r = await axios.get(s.url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 8000 });
    return s.extract(r.data);
  }));
  return [...new Set(results.filter(r => r.status === 'fulfilled' && r.value.length).flatMap(r => r.value))];
}
// charimage.js — Portado de YukiBot-MD → Rikka-TakaradaMD


;
const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat];
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }
      if (!args.length) {
        return m.reply(`❀ Por favor, proporciona el nombre de un personaje.\n> Ejemplo » *${usedPrefix + command} Yuki Suou*`);
      }
      const dbChars = await loadCharacters();
      const allCharacters = flattenCharacters(dbChars);
      const nameQuery = args.join(' ').toLowerCase().trim();
      const character = allCharacters.find(c => String(c.name).toLowerCase() === nameQuery) || allCharacters.find(c => String(c.name).toLowerCase().includes(nameQuery) || (Array.isArray(c.tags) && c.tags.some(tag => tag.toLowerCase().includes(nameQuery)))) || allCharacters.find(c => nameQuery.split(' ').some(q => String(c.name).toLowerCase().includes(q) || (Array.isArray(c.tags) && c.tags.some(tag => tag.toLowerCase().includes(q)))));
      if (!character) {
        return m.reply(`ꕥ No se encontró el personaje *${nameQuery}*.`);
      }
      const tag = Array.isArray(character.tags) ? character.tags[0] : null;
      if (!tag) {
        return m.reply(`ꕥ El personaje *${character.name}* no tiene un tag válido para buscar imágenes.`);
      }
      const mediaList = await buscarImagenDelirius(tag);
      const media = mediaList[Math.floor(Math.random() * mediaList.length)];
      if (!media) {
        return m.reply(`ꕥ No se encontraron imágenes para *${character.name}* con el tag *${tag}*.`);
      }
      const source = getSeriesNameByCharacter(dbChars, character.id);
      const msg = `❀ Nombre » *${character.name}*\n⚥ Género » *${character.gender || 'Desconocido'}*\n❖ Fuente » *${source}*`;
      const imgRes = await axios.get(media, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': getRefererForUrl(media) } });
      const buffer = Buffer.from(imgRes.data);
      await conn.sendMessage(m.chat, { image: buffer, caption: msg }, { quoted: m });
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`);
    }
};

handler.command = ['charimage', 'waifuimage', 'cimage', 'wimage'];
handler.tags = ['gacha'];

export default handler;
