// gacha-rw.js — Roll Waifu (Gacha principal)
// Portado de YukiBot-MD → Rikka-TakaradaMD

import axios from 'axios';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH  = path.join(__dirname, '../core/characters.json');
const rollLocks  = new Map();

function cleanOldLocks() {
  const now = Date.now();
  for (const [uid, t] of rollLocks) if (now - t > 30000) rollLocks.delete(uid);
}

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
  if (url.includes('safebooru.org'))    return 'https://safebooru.org/';
  if (url.includes('danbooru.donmai'))  return 'https://danbooru.donmai.us/';
  if (url.includes('gelbooru.com'))     return 'https://gelbooru.com/';
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

const handler = async (m, { conn, usedPrefix }) => {
  const userId = m.sender;
  const chatId = m.chat;
  cleanOldLocks();

  if (rollLocks.has(userId)) {
    const t = rollLocks.get(userId);
    if (Date.now() - t < 15000) return;
    rollLocks.delete(userId);
  }

  // Inicializar estructuras del chat en la DB de Rikka
  if (!global.db.data.chats[chatId])         global.db.data.chats[chatId] = {};
  const chat = global.db.data.chats[chatId];
  chat.users = chat.users || {};
  chat.characters = chat.characters || {};
  chat.rolls = chat.rolls || {};

  // Verificar si gacha está habilitado (si no existe el flag, permitir por defecto)
  if (chat.gacha === false) {
    return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con:\n» *${usedPrefix}gacha on*`);
  }

  if (!chat.users[userId]) chat.users[userId] = {};
  const me = chat.users[userId];
  const now = Date.now();
  const cooldown = 15 * 60 * 1000;

  if (me.lastRoll && now < me.lastRoll) {
    const r = Math.ceil((me.lastRoll - now) / 1000);
    const min = Math.floor(r / 60), sec = r % 60;
    let t = '';
    if (min > 0) t += `${min} minuto${min !== 1 ? 's' : ''} `;
    if (sec > 0 || !t) t += `${sec} segundo${sec !== 1 ? 's' : ''}`;
    return m.reply(`ꕥ Debes esperar *${t.trim()}* para usar *${usedPrefix}rw* de nuevo.`);
  }

  rollLocks.set(userId, now);

  try {
    const db       = await loadCharacters();
    const all      = flattenCharacters(db);
    if (!all.length) return m.reply('ꕥ No hay personajes cargados en la base de datos.');

    const selected = all[Math.floor(Math.random() * all.length)];
    const id       = String(selected.id);
    const source   = getSeriesName(db, selected.id);
    const baseTag  = formatTag(selected.tags?.[0] || '');
    const mediaList = await buscarImagen(baseTag);
    const media    = mediaList[Math.floor(Math.random() * mediaList.length)];

    if (!media) {
      rollLocks.delete(userId);
      return m.reply(`ꕥ No se encontraron imágenes para *${selected.name}*.`);
    }

    if (!chat.characters[selected.id]) chat.characters[selected.id] = {};
    const record    = chat.characters[selected.id];
    const globalRec = global.db.data.characters?.[selected.id] || {};

    record.name         = String(selected.name || 'Sin nombre');
    record.value        = typeof globalRec.value === 'number' ? globalRec.value : Number(selected.value) || 100;
    record.votes        = Number(record.votes || globalRec.votes || 0);
    record.reservedBy   = userId;
    record.reservedUntil = now + 20000;
    record.expiresAt    = now + 60000;

    const owner = typeof record.user === 'string' && record.user.length
      ? (global.db.data.users?.[record.user]?.name || record.user.split('@')[0]).trim()
      : 'libre';

    const msg = `❀ Nombre » *${record.name}*\n⚥ Género » *${selected.gender || 'Desconocido'}*\n✰ Valor » *${record.value.toLocaleString()}*\n♡ Estado » *${record.user ? `Reclamado por ${owner}` : 'Libre'}*\n❖ Fuente » *${source}*\n\n_Responde con_ *${usedPrefix}c* _para reclamar_`;

    const imgRes = await axios.get(media, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: getReferer(media) }
    });

    const sent = await conn.sendMessage(chatId, {
      image: Buffer.from(imgRes.data),
      caption: msg,
    }, { quoted: m });

    chat.rolls[sent.key.id] = {
      id,
      name: record.name,
      expiresAt: record.expiresAt,
      reservedBy: userId,
      reservedUntil: record.reservedUntil,
    };
    me.lastRoll = now + cooldown;

  } catch (e) {
    await m.reply(`❌ Error en *${usedPrefix}rw*: ${e.message}`);
  } finally {
    rollLocks.delete(userId);
  }
};

handler.command = ['rollwaifu', 'rw', 'roll'];
handler.tags    = ['gacha'];
handler.help    = ['rw — Hacer un roll de waifu aleatoria'];
handler.group   = true;

export default handler;
