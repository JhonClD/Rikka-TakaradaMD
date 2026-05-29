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
// giveallharem.js — Portado de YukiBot-MD → Rikka-TakaradaMD


async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}

const file = './core/characters.json'

const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat] ||= {}
      chat.users ||= {}
      chat.characters ||= {}
      chat.sales ||= {}
      chat.regalosPendientes ||= []
      const realSender = await resolveLid(m.sender, conn)
      const user = chat.users[realSender] ||= {}
      if (!Array.isArray(user.characters)) user.characters = []
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
      }
      const mentionedJid = m.mentionedJid
      const who2 = mentionedJid[0] || (m.quoted ? m.quoted.sender : null)
      const target = await resolveLid(who2, conn)
      if (!target) return m.reply('❀ Debes mencionar a quien quieras regalarle tus personajes.')
      if (!chat.users[target]) return m.reply('ꕥ El usuario mencionado no está registrado.')
      const json = await loadCharacters()
      const all = flattenCharacters(json)
      const ids = user.characters
      const list = ids.map(id => {
        const local = chat.characters[id] || {}
        const ref = all.find(c => c.id === id)
        const value = local.value ?? ref?.value ?? 0
        return { id, name: local.name || ref?.name || `ID:${id}`, value }
      })
      if (!list.length) return m.reply('ꕥ No tienes personajes para regalar.')
      const total = list.reduce((s, c) => s + c.value, 0)
      const nameTarget = getDisplayName(target)
      const nameSender = getDisplayName(realSender)
      const sent = await conn.sendMessage(m.chat, { text: `「✿」 *${nameSender}*, ¿confirmas regalar todo tu harem a *${nameTarget}*?\n\n❏ Personajes a transferir: ${list.length}\n❏ Valor total: ${total.toLocaleString()}\n\n✐ Para confirmar responde a este mensaje con "${usedPrefix}aceptar".\n> Esta acción no se puede deshacer, revisa bien los datos antes de confirmar.`, mentions: [target] }, { quoted: m })
      agregarRegalo(chat, realSender, target, list.map(c => c.id), total, list.length, sent.key.id, m.chat)
    } catch (e) {
      return m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['giveallharem'];
handler.tags = ['gacha'];
handler.group = true;

export default handler;
