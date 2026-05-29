// daily.js — Portado de YukiBot-MD → Rikka-TakaradaMD





const handler = async (m, { conn, command, usedPrefix, args }) => {
    const chat = global.db.data.chats[m.chat]
    if (chat.adminonly || !chat.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const bot = global.db.data.settings[botId]
    const monedas = bot?.currency || 'Yenes'
    let user = global.db.data.chats[m.chat].users[m.sender]
    let users = global.db.data.users[m.sender]
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000
    const maxStreak = 200
    users.streak ??= 0
    users.lastDailyGlobal ??= 0
    user.coins ??= 0
    user.lastdaily ??= 0
    if (now < user.lastdaily) {
      const restante = formatRemainingTime(user.lastdaily - now)
      return m.reply(`ꕥ Ya has reclamado tu *Daily* de hoy.\n> Puedes reclamarlo de nuevo en *${restante}*`)
    }
    const lost = users.streak >= 1 && now - users.lastDailyGlobal > oneDay * 1.5
    if (lost) users.streak = 0
    const canClaimGlobal = now - users.lastDailyGlobal >= oneDay
    if (canClaimGlobal) {
      users.streak = Math.min(users.streak + 1, maxStreak)
      users.lastDailyGlobal = now
    }
    const recompensa = Math.min(20000 + (users.streak - 1) * 5000, 1015000)
    user.coins += recompensa
    user.lastdaily = now + oneDay
    const siguiente = Math.min(20000 + users.streak * 5000, 1015000).toLocaleString()
    let msg = `> Día *${users.streak + 1}* » *+¥${siguiente}*`
    if (lost) msg += `\n> ☆ ¡Has perdido tu racha de días!`
    await m.reply(`「✿」Has reclamado tu recompensa diaria de *¥${recompensa.toLocaleString()} ${monedas}*! (Día *${users.streak}*)\n${msg}`)
};

handler.command = ['daily', 'diario'];
handler.tags = ['economy'];

export default handler;
