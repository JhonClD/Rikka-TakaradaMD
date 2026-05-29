// anime-waifu.js — Imagen de waifu/neko (SFW)
// Portado de YukiBot-MD → Rikka-TakaradaMD

import axios from 'axios';

const UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const react = (conn, m, emoji) =>
  conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });

const handler = async (m, { conn, command, usedPrefix }) => {
  try {
    await react(conn, m, '🕒');
    const chat = global.db.data.chats[m.chat] || {};
    const mode = chat.nsfw ? 'nsfw' : 'sfw';
    const type = ['neko', 'waifu'].includes(command) ? command : 'waifu';

    const { data: json } = await axios.get(`https://api.waifu.pics/${mode}/${type}`, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    if (!json?.url) throw new Error('No URL en respuesta');

    const { data: imgBuf } = await axios.get(json.url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA },
      timeout: 20000,
    });

    await conn.sendMessage(m.chat, {
      image: Buffer.from(imgBuf),
      caption: `✩ *${type.toUpperCase()}* para ti ˑ ❁ཻུ۪۪`,
    }, { quoted: m });
    await react(conn, m, '✔️');
  } catch (e) {
    await react(conn, m, '✖️');
    await m.reply(`↳ ✗ Error en *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = ['waifu', 'neko'];
handler.tags    = ['anime'];
handler.help    = ['waifu — Imagen de waifu aleatoria', 'neko — Imagen de neko aleatoria'];

export default handler;
