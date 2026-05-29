
function formatTime(ms) {
  if (ms <= 0) return 'Ahora';
  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);
  parts.push(`${seconds} segundo${seconds !== 1 ? 's' : ''}`);
  return parts.join(' ');
}
// monthly.js — Portado de YukiBot-MD → Rikka-TakaradaMD





const handler = async (m, { conn, command, usedPrefix, args }) => {
    const chat = global.db.data.chats[m.chat]
    if (chat.adminonly || !chat.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const bot = global.db.data.settings[botId]
    const currency = bot?.currency || 'Yenes'
    let user = global.db.data.chats[m.chat].users[m.sender]
    let users = global.db.data.users[m.sender]
    const gap = 2592000000
    const now = Date.now()
    users.monthlyStreak = users.monthlyStreak || 0
    users.lastMonthlyGlobal = users.lastMonthlyGlobal || 0
    user.coins = user.coins || 0
    user.lastmonthly = user.lastmonthly || 0
    if (now < user.lastmonthly) {
      const wait = formatTime(Math.floor((user.lastmonthly - now) / 1000))
      return conn.sendMessage(m.chat, { text: `ꕥ Ya has reclamado tu recompensa mensual.\n> Puedes reclamarlo de nuevo en *${wait}*` }, { quoted: m })
    }
    const lost = users.monthlyStreak >= 1 && now - users.lastMonthlyGlobal > gap * 1.5
    if (lost) users.monthlyStreak = 0
    const canClaimGlobal = now - users.lastMonthlyGlobal >= gap
    if (canClaimGlobal) {
      users.monthlyStreak = Math.min(users.monthlyStreak + 1, 8)
      users.lastMonthlyGlobal = now
    }
    const coins = Math.min(60000 + (users.monthlyStreak - 1) * 5000, 95000)
    user.coins += coins
    user.lastmonthly = now + gap
    let next = Math.min(60000 + users.monthlyStreak * 5000, 95000).toLocaleString()
    let msg = `> Mes *${users.monthlyStreak + 1}* » *+${next}*`
    if (lost) msg += `\n> ☆ ¡Has perdido tu racha de meses!`
    await conn.sendMessage(m.chat, { text: `「❁」 Has reclamado tu recompensa mensual de *+${coins.toLocaleString()} ${currency}* (Mes *${users.monthlyStreak}*)\n${msg}` }, { quoted: m })
};

handler.command = ['monthly', 'mensual'];
handler.tags = ['economy'];

export default handler;
