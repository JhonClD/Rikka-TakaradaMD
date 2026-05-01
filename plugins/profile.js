import { xpRange } from '../src/libraries/levelling.js'

const GENEROS = {
  m: 'ᴍᴀꜱᴄᴜʟɪɴᴏ',
  f: 'ꜰᴇᴍᴇɴɪɴᴏ',
  o: 'ɴᴏ ʙɪɴᴀʀɪᴏ',
}

function numFmt(n) {
  return Number(n || 0).toLocaleString('en-US').replace(/,/g, '.')
}

function progressBar(pct, width = 12) {
  const filled = Math.round(width * pct / 100)
  return '▬'.repeat(filled) + '─'.repeat(width - filled)
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const db    = global.db.data
  const users = db.users
  const target  = m.mentionedJid?.[0] || m.sender
  const name    = (await conn.getName(target) || target.split('@')[0]).toUpperCase()
  const u = users[target] || {}

  // ── Cálculos de progresión ──
  const exp = u.exp || 0
  const level = u.level || 0
  const range = xpRange(level, global.multiplier || 1)
  const xpNow = Math.max(0, exp - range.min)
  const xpNeed = Math.max(1, range.max - range.min)
  const pct = Math.min(100, Math.floor((xpNow / xpNeed) * 100))

  const sorted = Object.entries(users)
    .filter(([, v]) => typeof v?.exp === 'number')
    .sort(([, a], [, b]) => (b.exp || 0) - (a.exp || 0))
  const rank = sorted.findIndex(([jid]) => jid === target) + 1

  // ── Renderizado "Ghost" (Sin cuadros) ──
  
  let pf = `  ·  ꜱʏꜱᴛᴇᴍ  ·  [ ᴘʀᴏꜰɪʟᴇ_ᴅᴀᴛᴀ ]  ·\n\n`

  pf += `  ${name}  //  ɪᴅᴇɴᴛɪᴛʏ\n`
  pf += `  · ꜱᴛᴀᴛᴜꜱ : ${u.premiumTime > Date.now() ? 'ᴘʀᴇᴍɪᴜᴍ' : 'ꜱᴛᴀɴᴅᴀʀᴅ'}\n`
  pf += `  · ɢᴇɴᴅᴇʀ : ${u.gender ? GENEROS[u.gender] : 'ᴜɴᴅᴇꜰɪɴᴇᴅ'}\n`
  pf += `  · ʙ-ᴅᴀʏ  : ${u.birthday || 'ᴜɴᴅᴇꜰɪɴᴇᴅ'}\n\n`

  pf += `  ${name}  //  ᴘʀᴏɢʀᴇꜱꜱ\n`
  pf += `  · ʟᴇᴠᴇʟ  : ${level}\n`
  pf += `  · ʀᴀɴᴋ   : # ${numFmt(rank)}\n`
  pf += `  · ᴇxᴘ    : ${numFmt(exp)}\n`
  pf += `    ${progressBar(pct)} ${pct}%\n\n`

  pf += `  ${name}  //  ᴇᴄᴏɴᴏᴍʏ\n`
  pf += `  · ʜᴀʀᴇᴍ  : ${numFmt(u.harem)}\n`
  pf += `  · ᴠᴀʟᴜᴇ  : $ ${numFmt((u.money || 0) + (u.wallet || 0))}\n`
  pf += `  · ᴄᴏɪɴꜱ  : ${numFmt(u.coin)} ʟɪᴠᴇꜱ\n`
  pf += `  · ᴜꜱᴀɢᴇ  : ${numFmt(u.totalCommand)} ᴄᴍᴅꜱ\n\n`

  pf += `  ·  ᴅᴇᴠ_ɪᴅ  ·  ᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎`

  await conn.sendMessage(m.chat, {
    text: pf,
    mentions: [target],
  }, { quoted: m })
}

handler.help    = ['perfil']
handler.tags    = ['user']
handler.command = /^(perfil|profile|pf)$/i

export default handler
    
