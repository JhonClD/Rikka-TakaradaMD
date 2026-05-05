// anime-waifu.js — Imagen de waifu/neko (SFW)
// Portado de YukiBot-MD → Rikka-TakaradaMD

const handler = async (m, { conn, command, usedPrefix }) => {
  try {
    await m.react('🕒');
    const chat = global.db.data.chats[m.chat] || {};
    const mode = chat.nsfw ? 'nsfw' : 'sfw';
    const type = ['neko', 'waifu'].includes(command) ? command : 'waifu';
    const res  = await fetch(`https://api.waifu.pics/${mode}/${type}`);
    if (!res.ok) throw new Error(`API status ${res.status}`);
    const json = await res.json();
    if (!json.url) throw new Error('No URL en respuesta');
    const buf = Buffer.from(await (await fetch(json.url)).arrayBuffer());
    await conn.sendMessage(m.chat, {
      image: buf,
      caption: `✩ *${type.toUpperCase()}* para ti ˑ ❁ཻུ۪۪`,
    }, { quoted: m });
    await m.react('✔️');
  } catch (e) {
    await m.react('✖️');
    await m.reply(`↳ ✗ Error en *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = ['waifu', 'neko'];
handler.tags    = ['anime'];
handler.help    = ['waifu — Imagen de waifu aleatoria', 'neko — Imagen de neko aleatoria'];

export default handler;
