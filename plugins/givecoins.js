// givecoins.js — Portado de YukiBot-MD → Rikka-TakaradaMD



async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}



const handler = async (m, { conn, command, usedPrefix, args }) => {
    const db = global.db.data
    const chatId = m.chat
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const botSettings = db.settings[botId]
    const monedas = botSettings?.currency || 'Yenes' || 'coins'
    const chatData = db.chats[chatId]
    if (chatData.adminonly || !chatData.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const mentioned = m.mentionedJid || []
    const who2 = m.quoted ? m.quoted.sender : mentioned[0] || (args[1] ? (args[1].replace(/[@ .+-]/g, '') + '@s.whatsapp.net') : '')
    if (!who2) return m.reply(`❀ Debes mencionar a quien quieras transferir *${monedas}*.\n> Ejemplo » *${usedPrefix + command} 25000 @mencion*`)
    const who = await resolveLid(who2, conn)
    const senderData = chatData.users[m.sender]
    const targetData = chatData.users[who]
    if (!targetData) return m.reply(`ꕥ El usuario mencionado no está registrado en el bot.`)
    const cantidadInput = args[0]?.toLowerCase()
    let cantidad = cantidadInput === 'all' ? senderData.bank : parseInt(cantidadInput)
    if (!cantidadInput || isNaN(cantidad) || cantidad <= 0) {
      return m.reply(`ꕥ Ingresa una cantidad válida de *${monedas}* para transferir.`)
    }
    if (typeof senderData.bank !== 'number') senderData.bank = 0
    if (senderData.bank < cantidad) {
      return m.reply(`ꕥ No tienes suficientes *${monedas}* en el banco para transferir.\n> Tu saldo actual: *¥${senderData.bank.toLocaleString()} ${monedas}*`)
    }
    senderData.bank -= cantidad
    if (typeof targetData.bank !== 'number') targetData.bank = 0
    targetData.bank += cantidad
    if (isNaN(senderData.bank)) senderData.bank = 0
    let name = global.db.data.users[who]?.name || who.split('@')[0]
    await conn.sendMessage(chatId, { text: `❀ Transferiste *¥${cantidad.toLocaleString()} ${monedas}* a *${name}*\n> Ahora tienes *¥${senderData.bank.toLocaleString()} ${monedas}* en tu banco.`, mentions: [who], }, { quoted: m })
};

handler.command = ['givecoins', 'pay', 'coinsgive'];
handler.tags = ['economy'];

export default handler;
