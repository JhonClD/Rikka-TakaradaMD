// charimage.js — Portado de YukiBot-MD → Rikka-TakaradaMD
import axios from 'axios';
import { promises as fs } from 'fs';


const FILE_PATH = './core/characters.json';
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
