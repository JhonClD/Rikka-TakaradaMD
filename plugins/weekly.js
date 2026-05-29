
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
// weekly.js — Portado de YukiBot-MD → Rikka-TakaradaMD





const handler = async (m, { conn, command, usedPrefix, args }) => {
    const db = global.db.data
    const chat = db.chats[m.chat]
    if (chat.adminonly || !chat.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const bot = db.settings[botId]
    const currency = bot?.currency || 'Yenes'
    const user = db.chats[m.chat].users[m.sender]
    const users = db.users[m.sender]
    const gap = 604800000
    const now = Date.now()
    users.weeklyStreak = users.weeklyStreak || 0
    users.lastWeeklyGlobal = users.lastWeeklyGlobal || 0
    user.coins = user.coins || 0
    user.lastweekly = user.lastweekly || 0
    if (now < user.lastweekly) {
      const wait = formatTime(Math.floor((user.lastweekly - now) / 1000))
      return conn.sendMessage(m.chat, { text: `ꕥ Ya has reclamado tu recompensa semanal.\n> Puedes reclamarlo de nuevo en *${wait}*` }, { quoted: m })
    }
    const lost = users.weeklyStreak >= 1 && now - users.lastWeeklyGlobal > gap * 1.5
    if (lost) users.weeklyStreak = 0
    const canClaimWeeklyGlobal = now - users.lastWeeklyGlobal >= gap
    if (canClaimWeeklyGlobal) {
      users.weeklyStreak = Math.min(users.weeklyStreak + 1, 30)
      users.lastWeeklyGlobal = now
    }
    const coins = Math.min(40000 + (users.weeklyStreak - 1) * 5000, 185000)
    user.coins += coins
    user.lastweekly = now + gap
    let nextReward = Math.min(40000 + users.weeklyStreak * 5000, 185000).toLocaleString()
    let msg = `> Semana *${users.weeklyStreak + 1}* » *+¥${nextReward}*`
    if (lost) msg += `\n> ☆ ¡Has perdido tu racha de semanas!`
    conn.sendMessage(m.chat, { text: `「❁」 Has reclamado tu recompensa semanal de *¥${coins.toLocaleString()} ${currency}* (Semana *${users.weeklyStreak}*)\n${msg}` }, { quoted: m })
};

handler.command = ['weekly', 'semanal'];
handler.tags = ['economy'];

export default handler;
