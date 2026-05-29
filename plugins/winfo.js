// winfo.js — Portado de YukiBot-MD → Rikka-TakaradaMD
import { promises as fs } from 'fs';


const FILE_PATH = './core/characters.json'

const handler = async (m, { conn, command, usedPrefix, args }) => {
    try {
      const chat = global.db.data.chats[m.chat]
      const db = global.db.data
      if (chat.adminonly || !chat.gacha) {
        return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`)
      }
      if (!args.length) {
        return m.reply(`❀ Por favor, proporciona el nombre de un personaje.\n> Ejemplo » *${usedPrefix + command} Yuki Suou*`)
      }
      const structure = await loadCharacters()
      const allCharacters = flattenCharacters(structure)
      const nameQuery = args.join(' ').toLowerCase().trim()
      const character = allCharacters.find(c => String(c.name).toLowerCase() === nameQuery) || allCharacters.find(c => String(c.name).toLowerCase().includes(nameQuery) || (Array.isArray(c.tags) && c.tags.some(tag => tag.toLowerCase().includes(nameQuery)))) || allCharacters.find(c => nameQuery.split(' ').some(q => String(c.name).toLowerCase().includes(q) || (Array.isArray(c.tags) && c.tags.some(tag => tag.toLowerCase().includes(q)))))
      if (!character) {
        return m.reply(`ꕥ No se encontró el personaje *${nameQuery}*.`)
      }
      if (!db.characters) db.characters = {}
      if (!chat.users) chat.users = {}
      if (!chat.characters) chat.characters = {}
      const source = getSeriesNameByCharacter(structure, character.id)
      if (!db.characters[character.id]) db.characters[character.id] = {}
      const record = db.characters[character.id]
      if (record.name == null) record.name = character.name
      if (typeof record.value !== 'number') record.value = Number(character.value) || 100
      if (typeof record.votes !== 'number') record.votes = 0
      const userEntry = Object.entries(chat.users).find(([, u]) => Array.isArray(u.characters) && u.characters.includes(character.id))
      let ownerName = userEntry?.[0] ? (global.db.data.users[userEntry[0]]?.name?.trim() || userEntry[0].split('@')[0]) : 'Desconocido'
      const localRec = chat.characters[character.id] || {}
      const claimedDateLine = (localRec.user && localRec.claimedAt) ? `\nⴵ Fecha de reclamo » *${new Date(localRec.claimedAt).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}*` : ''
      const lastVoteAgo = typeof record.lastVotedAt === 'number' ? `hace *${formatElapsed(Date.now() - record.lastVotedAt)}*` : '*Nunca*'
      const sorted = Object.values(db.characters).filter(c => typeof c.value === 'number').sort((a, b) => b.value - a.value)
      const rank = sorted.findIndex(c => c.name === character.name) + 1 || '—'
      const msg = `❀ Nombre » *${record.name}*
⚥ Género » *${character.gender || 'Desconocido'}*
✰ Valor » *${record.value.toLocaleString()}*
♡ Estado » ${userEntry ? `Reclamado por *${ownerName}*` : '*Libre*'}${claimedDateLine}
❖ Fuente » *${source}*
❏ Puesto » *#${rank}*
ⴵ Último voto » ${lastVoteAgo}`.trim()
      await conn.sendMessage(m.chat, { text: msg }, { quoted: m })
    } catch (e) {
      await m.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
};

handler.command = ['charinfo', 'winfo', 'waifuinfo'];
handler.tags = ['gacha'];

export default handler;
