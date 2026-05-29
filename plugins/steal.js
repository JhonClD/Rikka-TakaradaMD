// steal.js — Portado de YukiBot-MD → Rikka-TakaradaMD

async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`);
  if (minutes) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);
  parts.push(`${seconds} segundo${seconds !== 1 ? 's' : ''}`);
  return parts.join(' ');
}

const handler = async (m, { conn, command, usedPrefix, args }) => {
  const db = global.db.data;
  const chatData = db.chats[m.chat];
  if (chatData.adminonly || !chatData.economy)
    return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`);
  const botId = (conn.user?.id?.split(':')[0] || 'bot') + '@s.whatsapp.net';
  const bot = db.settings[botId];
  const currency = bot?.currency || 'Yenes';
  const user = db.chats[m.chat].users[m.sender];
  user.coins ||= 0;
  user.laststeal ||= 0;
  if (Date.now() < user.laststeal) {
    const restante = user.laststeal - Date.now();
    return m.reply(`ꕥ Debes esperar *${formatTime(restante)}* para usar *${usedPrefix + command}* de nuevo.`);
  }
  const mentioned = m.mentionedJid || [];
  const who2 = mentioned[0] || (m.quoted ? m.quoted.sender : null);
  const who = await resolveLid(who2, conn);
  if (!who) return m.reply(`❀ Debes mencionar a alguien para intentar robarle.`);
  if (!(who in db.chats[m.chat].users)) return m.reply(`ꕥ El usuario no se encuentra en mi base de datos.`);
  const name = db.users[who]?.name || who.split('@')[0];
  const target = db.chats[m.chat].users[who];
  const tiempoInactivo = Date.now() - (db.chats[m.chat].users[who]?.lastCmd || 0);
  if (tiempoInactivo < 3600000)
    return m.reply(`ꕥ Solo puedes robarle *${currency}* a un usuario si estuvo más de 1 hora inactivo.`);
  const chance = Math.random();
  if (chance < 0.3) {
    let loss = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
    const total = user.coins + (user.bank || 0);
    if (total >= loss) {
      if (user.coins >= loss) { user.coins -= loss; }
      else { const r = loss - user.coins; user.coins = 0; user.bank = Math.max(0, (user.bank || 0) - r); }
    } else { loss = total; user.coins = 0; user.bank = 0; }
    user.laststeal = Date.now() + 3600000;
    return m.reply(`ꕥ El robo salió mal y perdiste *¥${loss.toLocaleString()} ${currency}*.`);
  }
  const rob = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000;
  if (target.coins < rob)
    return conn.sendMessage(m.chat, { text: `ꕥ *${name}* no tiene suficientes *${currency}* fuera del banco como para que valga la pena intentar robar.`, mentions: [who] }, { quoted: m });
  user.coins += rob;
  target.coins -= rob;
  user.laststeal = Date.now() + 3600000;
  await conn.sendMessage(m.chat, { text: `❀ Le robaste *¥${rob.toLocaleString()} ${currency}* a *${name}*`, mentions: [who] }, { quoted: m });
};

handler.command = ['robar', 'steal', 'rob'];
handler.tags = ['economy'];

export default handler;
