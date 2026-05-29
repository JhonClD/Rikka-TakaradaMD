
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
// casino.js — Portado de YukiBot-MD → Rikka-TakaradaMD



let buatall = 1

const handler = async (m, { conn, command, usedPrefix, args }) => {
    const db = global.db.data
    const chatData = db.chats[m.chat]
    if (chatData.adminonly || !chatData.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
    const bot = db.settings[botId]
    const currency = bot?.currency || 'Yenes'
    const botname = bot.botname
    const user = db.chats[m.chat].users[m.sender]
    user.lastApuesta ||= 0
    let Aku = Math.floor(Math.random() * 101)
    let Kamu = Math.floor(Math.random() * 55)
    let count = args[0]
    const userName = db.users[m.sender]?.name || m.sender.split('@')[0]
    const tiempoEspera = 30 * 1000
    const ahora = Date.now()
    if (user.lastApuesta && ahora - user.lastApuesta < tiempoEspera) {
      const restante = user.lastApuesta + tiempoEspera - ahora
      const tiempoRestante = formatTime(restante)
      return conn.sendMessage(m.chat, { text: `ꕥ Debes esperar *${tiempoRestante}* para usar *${usedPrefix + command}* nuevamente.` }, { quoted: m })
    }
    user.lastApuesta = ahora
    count = count ? /all/i.test(count) ? Math.floor(db.users[m.sender].limit / buatall) : parseInt(count) : args[0] ? parseInt(args[0]) : 1
    count = Math.max(1, count)
    if (args.length < 1) {
      return conn.sendMessage(m.chat, { text: `❀ Ingresa la cantidad de *${currency}* que deseas aportar contra *${botname}*\n> Ejemplo: *${usedPrefix + command} 100*` }, { quoted: m })
    }
    if (user.coins >= count) {
      user.coins -= count
      let resultado = ''
      let ganancia = 0
      if (Aku > Kamu) {
        resultado = `> ${userName}, *Perdiste ¥${formatNumber(count)} ${currency}*.`
      } else if (Aku < Kamu) {
        ganancia = count * 2
        user.coins += ganancia
        resultado = `> ${userName}, *Ganaste ¥${formatNumber(ganancia)} ${currency}*.`
      } else {
        ganancia = count
        user.coins += ganancia
        resultado = `> ${userName}, *Ganaste ¥${formatNumber(ganancia)} ${currency}*.`
      }
      let { key } = await conn.sendMessage(m.chat, { text: "🎲 El crupier lanza los dados... ¡Las apuestas están cerradas!" }, { quoted: m })
      await delay(2000)
      await conn.sendMessage(m.chat, { text: "❀ Los números están girando... ¡Prepárate para el resultado!", edit: key }, { quoted: m })
      await delay(2000)
      const replyMsg = `❀ \`Veamos qué números tienen!\`\n\n➠ *${botname}* : ${Aku}\n➠ *${userName}* : ${Kamu}\n\n${resultado}`
      await conn.sendMessage(m.chat, { text: replyMsg.trim(), edit: key }, { quoted: m })
    } else {
      conn.sendMessage(m.chat, { text: `ꕥ No tienes *¥${formatNumber(count)} ${currency}* para apostar!` }, { quoted: m })
    }
};

handler.command = ['apostar', 'casino'];
handler.tags = ['economy'];

export default handler;
