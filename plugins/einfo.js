
// einfo.js — Portado de YukiBot-MD → Rikka-TakaradaMD





const handler = async (m, { conn, command, usedPrefix, args }) => {
    const db = global.db.data
    const chatId = m.chat
    const botId = conn.user?.id.split(':')[0] + "@s.whatsapp.net"
    const chatData = db.chats[chatId]
    if (chatData.adminonly || !chatData.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const user = chatData.users[m.sender]
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000
    const cooldowns = {
      work: Math.max(0, (user.lastwork || 0) - now),
      daily: Math.max(0, (user.lastdaily || 0) + oneDay - now),
      weekly: Math.max(0, (user.lastweekly || 0) + 7 * oneDay - now),
      monthly: Math.max(0, (user.lastmonthly || 0) + 30 * oneDay - now)
    }
    const formatTime = (ms) => {
      const totalSeconds = Math.floor(ms / 1000)
      const days = Math.floor(totalSeconds / 86400)
      const hours = Math.floor((totalSeconds % 86400) / 3600)
      const minutes = Math.floor((totalSeconds % 3600) / 60)
      const seconds = totalSeconds % 60
      const parts = []
      if (days > 0) parts.push(`${days} d`)
      if (hours > 0) parts.push(`${hours} h`)
      if (minutes > 0) parts.push(`${minutes} m`)
      if (seconds > 0) parts.push(`${seconds} s`)
      return parts.length ? parts.join(', ') : 'Ahora.'
    }
    const coins = user.coins || 0
    const name = db.users[m.sender]?.name || m.sender.split('@')[0]
    const mensaje = `✿ Usuario \`<${name}>\`

ⴵ Work » *${formatTime(cooldowns.work)}*
ⴵ Daily » *${formatTime(cooldowns.daily)}*
ⴵ Weekly » *${formatTime(cooldowns.weekly)}*
ⴵ Monthly » *${formatTime(cooldowns.monthly)}*

⛁ Coins totales » ¥${coins.toLocaleString()} ${global.db?.data?.settings?.[botId]?.currency || 'Yenes'}`
    await conn.sendMessage(chatId, { text: mensaje }, { quoted: m })
};

handler.command = ['infoeconomy', 'cooldowns', 'economyinfo', 'einfo'];
handler.tags = ['economy'];

export default handler;
