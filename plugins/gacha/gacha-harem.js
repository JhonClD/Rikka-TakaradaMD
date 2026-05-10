// gacha-harem.js — Ver colección de waifus
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
function flattenCharacters(structure) {
  return Object.values(structure).flatMap(s => Array.isArray(s.characters) ? s.characters : []);
}

const handler = async (m, { conn, args, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];



  if (chat.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  // Resolver a quién ver el harem
  let userId = m.mentionedJid?.[0] || (m.quoted ? m.quoted.sender : m.sender);
  // LID resolve
  if (m.isGroup && !userId.endsWith('@s.whatsapp.net')) {
    try {
      const meta = await conn.groupMetadata(m.chat);
      for (const p of meta.participants || []) {
        if (p?.id?.split('@')[0] === userId.split('@')[0]) { userId = p.id; break; }
      }
    } catch { /* ignore */ }
  }

  const name = global.db.data.users[userId]?.name || userId.split('@')[0];
  let structure;
  try { structure = await loadCharacters(); } catch { return m.reply('❲ ✗ ❳ No se pudo leer characters.json'); }
  const allCharacters = flattenCharacters(structure);

  const ownedIDs = Object.entries(chat.gacha_characters)
    .filter(([, c]) => (c.user || '').replace(/\D/g, '') === userId.replace(/\D/g, ''))
    .map(([id]) => id);

  if (!ownedIDs.length) {
    const msg = userId === m.sender ? 'ꕥ No tienes personajes reclamados.' : `ꕥ *${name}* no tiene personajes reclamados.`;
    return conn.sendMessage(m.chat, { text: msg, mentions: [userId] }, { quoted: m });
  }

  // Ordenar por valor
  ownedIDs.sort((a, b) => {
    const va = global.db.data.characters?.[a]?.value ?? chat.gacha_characters[a]?.value ?? 0;
    const vb = global.db.data.characters?.[b]?.value ?? chat.gacha_characters[b]?.value ?? 0;
    return vb - va;
  });

  const page = parseInt(args[0]) || 1;
  const perPage = 50;
  const totalPages = Math.ceil(ownedIDs.length / perPage);
  if (page < 1 || page > totalPages) return m.reply(`↳ ✗ Página inválida. Total: *${totalPages}* páginas.`);

  const start = (page - 1) * perPage;
  let message = `˗ˏˋ *Harem de ${name}* ˎˊ-\n⇢ Personajes: *${ownedIDs.length}*\n\n`;

  for (let i = start; i < Math.min(start + perPage, ownedIDs.length); i++) {
    const id = ownedIDs[i];
    const globalRec = global.db.data.characters?.[id] || {};
    const jsonRec   = allCharacters.find(c => c.id == id);
    const charName  = jsonRec?.name || chat.gacha_characters[id]?.name || globalRec.name || `ID:${id}`;
    const value     = typeof globalRec.value === 'number' ? globalRec.value : (jsonRec?.value || 0);
    message += `» *${charName}* (*${value.toLocaleString()}*)\n`;
  }
  message += `\n↳ Página *${page}* de *${totalPages}*`;

  await conn.sendMessage(m.chat, { text: message.trim(), mentions: [userId] }, { quoted: m });
};

handler.command = ['harem', 'waifus', 'claims', 'mischicas'];
handler.tags    = ['gacha'];
handler.help    = ['harem — Ver tus waifus reclamadas'];
handler.group   = true;

export default handler;
