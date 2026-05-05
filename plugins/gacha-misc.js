// gacha-misc.js — setfav, charimage, charinfo, removesale
// Portado de YukiBot-MD → Rikka-TakaradaMD

import axios from 'axios';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH  = path.join(__dirname, '../core/characters.json');

async function loadCharacters() {
  try { await fs.access(FILE_PATH); } catch { await fs.writeFile(FILE_PATH, '{}'); }
  return JSON.parse(await fs.readFile(FILE_PATH, 'utf-8'));
}
function flattenCharacters(db) {
  return Object.values(db).flatMap(s => Array.isArray(s.characters) ? s.characters : []);
}
function getSeriesName(db, id) {
  return Object.entries(db).find(([, s]) =>
    Array.isArray(s.characters) && s.characters.some(c => String(c.id) === String(id))
  )?.[1]?.name || 'Desconocido';
}
function formatTag(tag) {
  return String(tag).trim().toLowerCase().replace(/\s+/g, '_');
}
function getReferer(url) {
  if (url.includes('safebooru.org'))   return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai')) return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com'))    return 'https://gelbooru.com/';
  return '';
}
async function buscarImagen(tag) {
  const q = formatTag(tag);
  const sources = [
    {
      url: `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=${q}&limit=100`,
      extract: d => {
        const posts = Array.isArray(d) ? d : d?.post || [];
        return posts.map(i => i?.file_url || (i?.directory && i?.image
          ? `https://safebooru.org/images/${i.directory}/${i.image}` : null))
          .filter(u => typeof u === 'string' && /\.(jpe?g|png)(\?.*)?$/i.test(u));
      }
    },
    {
      url: `https://danbooru.donmai.us/posts.json?tags=${q}&limit=100`,
      extract: d => (Array.isArray(d) ? d : [])
        .map(i => i?.file_url || i?.large_file_url)
        .filter(u => typeof u === 'string' && /\.(jpe?g|png)(\?.*)?$/i.test(u))
    },
    {
      url: `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&tags=${q}&limit=100&api_key=98f554258c88c44f4dd28ccde0c28f36682b2a992490ab35ebcc7baf7e196a86d7550b174bce577b8cc3f544e9b3ad0f6aeb09ad63bf89a9141cc3eddb6fbfd2&user_id=1917269`,
      extract: d => (Array.isArray(d) ? d : d?.post || d?.data || [])
        .map(i => i?.file_url)
        .filter(u => typeof u === 'string' && /\.(jpe?g|png)(\?.*)?$/i.test(u))
    }
  ];
  const results = await Promise.allSettled(sources.map(async s => {
    const res = await axios.get(s.url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 8000 });
    return s.extract(res.data);
  }));
  return [...new Set(results.filter(r => r.status === 'fulfilled' && r.value.length).flatMap(r => r.value))];
}

function findCharacter(allChars, query) {
  const q = query.toLowerCase().trim();
  return allChars.find(c => String(c.name).toLowerCase() === q)
    || allChars.find(c => String(c.name).toLowerCase().includes(q) || (Array.isArray(c.tags) && c.tags.some(t => t.toLowerCase().includes(q))))
    || allChars.find(c => q.split(' ').some(w => String(c.name).toLowerCase().includes(w) || (Array.isArray(c.tags) && c.tags.some(t => t.toLowerCase().includes(w)))));
}

const handler = async (m, { conn, command, args, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];




  if (chat.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  // ─── SETFAV ─────────────────────────────────────────────────
  if (['setfav', 'setfavourite', 'favorito'].includes(command)) {
    if (!args.length) return m.reply(`⸙͎ Uso: *${usedPrefix}setfav <personaje>*`);
    if (!chat.users[m.sender]) chat.users[m.sender] = {};
    const me = chat.users[m.sender];
    if (!Array.isArray(me.gacha_characters)) me.gacha_characters = [];
    let structure;
    try { structure = await loadCharacters(); } catch { return m.reply('❲ ✗ ❳ No se pudo leer characters.json'); }
    const character = findCharacter(flattenCharacters(structure), args.join(' '));
    if (!character) return m.reply(`❲ ✗ ❳ No se encontró *${args.join(' ')}*`);
    if (!me.gacha_characters.includes(character.id) && !me.gacha_characters.includes(String(character.id))) {
      return m.reply(`↳ ✗ *${character.name}* no está en tu colección.`);
    }
    const prevId = me.gacha_favorite;
    me.gacha_favorite = character.id;
    if (!global.db.data.users[m.sender]) global.db.data.users[m.sender] = {};
    global.db.data.users[m.sender].favorite = character.id;
    if (prevId && prevId !== character.id) {
      const prev = global.db.data.characters?.[prevId];
      const prevName = typeof prev?.name === 'string' ? prev.name : 'personaje anterior';
      return m.reply(`✩ Reemplazaste *${prevName}* por *${character.name}* como favorita ❁`);
    }
    return m.reply(`✩ *${character.name}* es ahora tu favorita ❁`);
  }

  // ─── CHARIMAGE / CHARINFO ───────────────────────────────────
  if (['charimage', 'waifuimage', 'cimage', 'wimage', 'charinfo', 'wifu'].includes(command)) {
    if (!args.length) return m.reply(`⸙͎ Uso: *${usedPrefix}${command} <personaje>*`);
    let structure;
    try { structure = await loadCharacters(); } catch { return m.reply('❲ ✗ ❳ No se pudo leer characters.json'); }
    const character = findCharacter(flattenCharacters(structure), args.join(' '));
    if (!character) return m.reply(`❲ ✗ ❳ No se encontró *${args.join(' ')}*`);
    const tag = Array.isArray(character.tags) ? character.tags[0] : null;
    if (!tag) return m.reply(`↳ ✗ *${character.name}* no tiene tag disponible.`);
    const mediaList = await buscarImagen(tag);
    const media = mediaList[Math.floor(Math.random() * mediaList.length)];
    if (!media) return m.reply(`❲ ✗ ❳ No se encontraron imágenes para *${character.name}*`);
    const source = getSeriesName(structure, character.id);
    const msg = `❀ Nombre » *${character.name}*\n⚥ Género » *${character.gender || 'Desconocido'}*\n❖ Fuente » *${source}*`;
    const imgRes = await axios.get(media, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: getReferer(media) }
    });
    return conn.sendMessage(m.chat, { image: Buffer.from(imgRes.data), caption: msg }, { quoted: m });
  }

  // ─── REMOVESALE ─────────────────────────────────────────────
  if (['removesale', 'quitarventa', 'cancelsale'].includes(command)) {
    if (!args.length) return m.reply(`⸙͎ Uso: *${usedPrefix}removesale <personaje>*`);
    const name   = args.join(' ').toLowerCase();
    const idDel  = Object.keys(chat.gacha_sales).find(id => (chat.gacha_sales[id]?.name || '').toLowerCase() === name);
    if (!idDel) return m.reply(`❲ ✗ ❳ No se encontró *${args.join(' ')}* en venta.`);
    if (chat.gacha_sales[idDel].user !== m.sender) return m.reply('↳ ✗ Solo el vendedor puede retirarlo de venta.');
    const charName = chat.gacha_sales[idDel].name;
    delete chat.gacha_sales[idDel];
    return m.reply(`✩ *${charName}* retirado de la venta ❁`);
  }
};

handler.command = [
  'setfav', 'setfavourite', 'favorito',
  'charimage', 'waifuimage', 'cimage', 'wimage', 'charinfo', 'wifu',
  'removesale', 'quitarventa', 'cancelsale',
];
handler.tags    = ['gacha'];
handler.help    = [
  'setfav <personaje> — Establecer waifu favorita',
  'charimage <personaje> — Ver imagen de un personaje',
  'removesale <personaje> — Retirar personaje de venta',
];
handler.group   = true;

export default handler;
