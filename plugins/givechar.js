// givechar.js — Portado de YukiBot-MD → Rikka-TakaradaMD

async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}

const handler = async (m, { conn, command, usedPrefix, args }) => {
  try {
    const chat = global.db.data.chats[m.chat];
    if (!chat.users) chat.users = {};
    if (!chat.characters) chat.characters = {};
    if (!chat.users[m.sender]) chat.users[m.sender] = {};
    const me = chat.users[m.sender];
    if (!Array.isArray(me.characters)) me.characters = [];
    if (chat.adminonly || !chat.gacha) {
      return m.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
    }
    if (!args.length) {
      return m.reply(`❀ Debes escribir el nombre del personaje y citar o mencionar al usuario que lo recibirá`);
    }
    const mentioned = m.mentionedJid || [];
    const who2 = mentioned.length > 0 ? mentioned[0] : m.quoted ? m.quoted.sender : false;
    const targetId = await resolveLid(who2, conn);
    if (!targetId) return m.reply(`❀ Debes mencionar o citar el mensaje del destinatario.`);
    if (!chat.users[targetId]) return m.reply('ꕥ El usuario mencionado no está registrado.');
    const characterName = m.quoted ? args.join(' ').toLowerCase().trim() : args.slice(0, -1).join(' ').toLowerCase().trim();
    const charId = Object.keys(chat.characters).find(id => {
      const c = chat.characters[id];
      return typeof c.name === 'string' && c.name.toLowerCase() === characterName;
    });
    if (!charId) return m.reply(`ꕥ No se encontró el personaje *${characterName}*.`);
    const record = chat.characters[charId];
    if (!me.characters.includes(charId) || record.user !== m.sender) {
      return m.reply(`ꕥ *${record.name}* no está reclamado por ti.`);
    }
    if (!chat.users[targetId]) chat.users[targetId] = {};
    const target = chat.users[targetId];
    if (!Array.isArray(target.characters)) target.characters = [];
    if (!target.characters.includes(charId)) target.characters.push(charId);
    me.characters = me.characters.filter(id => id !== charId);
    record.user = targetId;
    if (chat.sales?.[charId] && chat.sales[charId].user === m.sender) delete chat.sales[charId];
    if (chat.users[m.sender].favorite === charId) delete chat.users[m.sender].favorite;
    if (global.db.data.users?.[m.sender]?.favorite === charId) delete global.db.data.users[m.sender].favorite;
    let senderName = global.db.data.users[m.sender]?.name?.trim() || m.sender.split('@')[0];
    let receiverName = global.db.data.users[targetId]?.name?.trim() || targetId.split('@')[0];
    await conn.sendMessage(m.chat, { text: `❀ *${record.name}* ha sido regalado a *${receiverName}* por *${senderName}*.`, mentions: [targetId] }, { quoted: m });
  } catch (e) {
    await m.reply(`↳ ✗ Error en *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = ['givechar', 'givewaifu', 'regalar'];
handler.tags = ['gacha'];
handler.group = true;

export default handler;
