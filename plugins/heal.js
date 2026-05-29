// heal.js — Portado de YukiBot-MD → Rikka-TakaradaMD



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
    const mentioned = m.mentionedJid || []
    const who2 = mentioned[0] || (m.quoted ? m.quoted.sender : null)
    const who = await resolveLid(who2, conn)
    const healer = chatData.users[m.sender]
    const target = who ? chatData.users[who] : healer
    if (!target) return m.reply(`ꕥ El usuario no se encuentra en la base de Datos.`)
    if (target.health >= 100) {
      const maximo = who ? `ꕥ La salud de *${db.users[who]?.name || who.split('@')[0]}* ya está al máximo, Salud actual: ${target.health}` : `ꕥ Tu salud ya está al máximo, Salud actual: ${target.health}`
      return m.reply(maximo)
    }
    const faltante = 100 - target.health
    const bloques = Math.ceil(faltante / 10)
    const costo = bloques * 500
    const totalFondos = healer.coins + (healer.bank || 0)
    if (totalFondos < costo) {
      const fondos = who ? `ꕥ No tienes suficientes ${currency} para curar a *${db.users[who]?.name || who.split('@')[0]}*.\n> Necesitas *¥${costo.toLocaleString()} ${currency}* para curar ${faltante} puntos de salud.` : `ꕥ No tienes suficientes ${currency} para curarte.\n> Necesitas *¥${costo.toLocaleString()} ${currency}* para curar ${faltante} puntos de salud.`
      return m.reply(fondos)
    }
    if (healer.coins >= costo) {
      healer.coins -= costo
    } else {
      const restante = costo - healer.coins
      healer.coins = 0
      healer.bank = Math.max(0, (healer.bank || 0) - restante)
    }
    target.health = 100
    const info = who ? `ꕥ Has curado a *${db.users[who]?.name || who.split('@')[0]}* hasta el máximo nivel de salud.` : `ꕥ Te has curado hasta el máximo nivel de salud.`
    m.reply(info)
};

handler.command = ['heal', 'curar'];
handler.tags = ['economy'];

export default handler;
