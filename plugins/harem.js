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
// harem.js — Portado de YukiBot-MD → Rikka-TakaradaMD


async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}

const charactersFilePath = './core/characters.json'

const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat]
      if (!chat.users) chat.users = {}
      if (!chat.characters) chat.characters = {}
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
      }
      const mentionedJid = m.mentionedJid
      const who = mentionedJid.length > 0 ? mentionedJid[0] : (m.quoted ? m.quoted.sender : m.sender)
      const userId = await resolveLid(who, conn);
      const name = global.db.data.users[userId]?.name || userId.split('@')[0]
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const ownedIDs = Object.entries(chat.characters).filter(([, c]) => (c.user || '').replace(/[^0-9]/g, '') === userId.replace(/[^0-9]/g, '')).map(([id]) => id)
      if (ownedIDs.length === 0) {
        const msg = userId === m.sender ? 'ꕥ No tienes personajes reclamados.' : `ꕥ *${name}* no tiene personajes reclamados.`
        return conn.sendMessage(m.chat, { text: msg, mentions: [userId] }, { quoted: m })
      }
      ownedIDs.sort((idA, idB) => {
        const localA = chat.characters[idA] || {}
        const localB = chat.characters[idB] || {}
        const globalA = global.db.data.characters?.[idA] || {}
        const globalB = global.db.data.characters?.[idB] || {}
        const valA = typeof globalA.value === 'number' ? globalA.value : typeof localA.value === 'number' ? localA.value : 0
        const valB = typeof globalB.value === 'number' ? globalB.value : typeof localB.value === 'number' ? localB.value : 0
        return valB - valA
      })
      const page = parseInt(args[1]) || 1
      const perPage = 50
      const totalPages = Math.ceil(ownedIDs.length / perPage)
      if (page < 1 || page > totalPages) {
        return m.reply(`❀ Página no válida. Hay un total de *${totalPages}* páginas.`)
      }
      const start = (page - 1) * perPage
      const end = Math.min(start + perPage, ownedIDs.length)
      let message = `✿ Personajes reclamados ✿\n`
      message += `⌦ Usuario: *${name}*\n`
      message += `♡ Personajes: *(${ownedIDs.length})*\n\n`
      for (let i = start; i < end; i++) {
        const id = ownedIDs[i]
        const local = chat.characters[id] || {}
        const globalRec = global?.db?.data?.characters?.[id] || {}
        const jsonRec = allCharacters.find(c => c.id === id)
        const charName = jsonRec?.name || local.name || globalRec.name || `ID:${id}`
        const value = typeof globalRec.value === 'number' ? globalRec.value : typeof local.value === 'number' ? local.value : Number(jsonRec?.value || 0)
        message += `» *${charName}* (*${value.toLocaleString()}*)\n`
      }
      message += `\n⌦ _Página *${page}* de *${totalPages}*_`
      await conn.sendMessage(m.chat, { text: message.trim(), mentions: [userId] }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['harem', 'waifus', 'claims'];
handler.tags = ['gacha'];
handler.group = true;

export default handler;
