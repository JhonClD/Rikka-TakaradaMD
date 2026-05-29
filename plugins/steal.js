// steal.js — Portado de YukiBot-MD → Rikka-TakaradaMD



async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}



const handler = async (m, { conn, command, usedPrefix, args }) => {
    const db = global.db.data
    const chatData = db.chats[m.chat]
    if (chatData.adminonly || !chatData.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)   
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const bot = db.settings[botId]
    const currency = bot?.currency || 'Yenes'
    const user = db.chats[m.chat].users[m.sender]
    user.coins ||= 0
    user.laststeal ||= 0
    if (Date.now() < user.laststeal) {
      const restante = user.laststeal - Date.now()
      return conn.sendMessage(m.chat, { text: m.chat, `ꕥ Debes esperar *${formatTime(restante)}* para usar *${usedPrefix + command}* de nuevo.` }, { quoted: m })
    }
    const mentioned = m.mentionedJid || []
    const who2 = mentioned[0] || (m.quoted ? m.quoted.sender : null)
    const who = await resolveLid(who2, conn)
    if (!who) return conn.sendMessage(m.chat, { text: m.chat, `❀ Debes mencionar a alguien para intentar robarle.` }, { quoted: m })
    if (!(who in db.chats[m.chat].users)) {
      return conn.sendMessage(m.chat, { text: m.chat, `ꕥ El usuario no se encuentra en mi base de datos.` }, { quoted: m })
    }
    const name = db.users[who]?.name || who.split('@')[0]
    const target = db.chats[m.chat].users[who]
    const lastCmd = db.chats[m.chat].users[who]?.lastCmd || 0
    const tiempoInactivo = Date.now() - lastCmd
    if (tiempoInactivo < 3600000) {
      return conn.sendMessage(m.chat, { text: m.chat, `ꕥ Solo puedes robarle *${currency}* a un usuario si estuvo más de 1 hora inactivo.` }, { quoted: m })
    }
    const chance = Math.random()
    if (chance < 0.3) {
      let loss = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000
      const total = user.coins + (user.bank || 0)
      if (total >= loss) {
        if (user.coins >= loss) {
          user.coins -= loss
        } else {
          const restante = loss - user.coins
          user.coins = 0
          user.bank = Math.max(0, (user.bank || 0) - restante)
        }
      } else {
        loss = total
        user.coins = 0
        user.bank = 0
      }
      user.laststeal = Date.now() + 3600000
      return conn.sendMessage(m.chat, { text: m.chat, `ꕥ El robo salió mal y perdiste *¥${loss.toLocaleString()} ${currency}*.` }, { quoted: m })
    }
    const rob = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000
    if (target.coins < rob) {
      return conn.sendMessage(m.chat, { text: m.chat, `ꕥ *${name}* no tiene suficientes *${currency}* fuera del banco como para que valga la pena intentar robar.`, m, { mentions: [who] })
    }
    user.coins += rob
    target.coins -= rob
    user.laststeal = Date.now() + 3600000
    conn.sendMessage(m.chat, { text: m.chat, `❀ Le robaste *¥${rob.toLocaleString()} ${currency}* a *${name}*`, m, { mentions: [who] })
  }
}

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const parts = []
  if (hours) parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`)
  if (minutes) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`)
  parts.push(`${seconds} segundo${seconds !== 1 ? 's' : ''}`)
  return parts.join(' ')
}
};

handler.command = ['robar', 'steal', 'rob'];
handler.tags = ['economy'];

export default handler;
