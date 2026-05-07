import { xpRange } from '../src/libraries/levelling.js'

const GENEROS = { m: '♂️ Masculino', f: '♀️ Femenino', o: '⚧️ Otro' }
const numFmt = (n) => Number(n || 0).toLocaleString('es')
const progressBar = (pct, width = 12) => {
  const filled = Math.round(width * pct / 100)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users  = global.db.data.users
  const target = m.mentionedJid?.[0] || m.quoted?.sender || m.sender
  const isSelf = target === m.sender
  const name   = await conn.getName(target)

  if (!users[target]) users[target] = {}
  const u = users[target]
  if (u.birthday  === undefined) u.birthday  = null
  if (u.gender    === undefined) u.gender    = null
  if (u.harem     === undefined) u.harem     = 0
  if (u.totalCommand === undefined) u.totalCommand = 0
  if (u.exp       === undefined) u.exp       = 0
  if (u.level     === undefined) u.level     = 0

  if (command === 'setbirth') {
    if (!isSelf) return m.reply('╰─► Solo puedes editar tu propio perfil.')
    const raw = args[0]
    if (!raw || !/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(raw))
      return m.reply(`⸙͎ Usa: *${usedPrefix + command} DD/MM*`)
    u.birthday = raw
    return m.reply(`╰─► Cumpleaños guardado ✧ *${u.birthday}*`)
  }

  if (command === 'setgender') {
    if (!isSelf) return m.reply('╰─► Solo puedes editar tu propio perfil.')
    const g = args[0]?.toLowerCase()
    if (!GENEROS[g]) return m.reply(`⸙͎ Géneros: *m* ♂️  *f* ♀️  *o* ⚧️`)
    u.gender = g
    return m.reply(`╰─► Género guardado ✧ *${GENEROS[g]}*`)
  }

  const { min, xp } = xpRange(u.level, global.multiplier || 1)
  const xpNow  = Math.max(0, u.exp - min)
  const pct    = Math.min(100, Math.floor((xpNow / xp) * 100))
  const sorted = Object.entries(users).sort(([, a], [, b]) => (b.exp || 0) - (a.exp || 0))
  const rank   = sorted.findIndex(([jid]) => jid === target) + 1

  const txt = `
꒰ ✦ *Perfil* ✦ ꒱
⌜ ${name} ⌝

┊⇢ 🗓️ *Cumpleaños* ꒱ ${u.birthday || `Sin especificar`}
┊⇢ ⚧️ *Género* ꒱ ${u.gender ? GENEROS[u.gender] : 'Sin especificar'}

┊⇢ ✰ *Experiencia* ꒱ ${numFmt(u.exp)}
┊⇢ ❖ *Nivel* ꒱ ${u.level}
┊⇢ ➤ *Progreso* ꒱ ${numFmt(xpNow)} ⟹ ${numFmt(xp)}
\`[${progressBar(pct)}] ${pct}%\`
┊⇢ 🏆 *Puesto* ꒱ #${rank}

┊⇢ ♡ *Harem* ꒱ ${u.harem}
┊⇢ ✧ *Valor total* ꒱ ${numFmt((u.money || 0) + (u.wallet || 0))}
┊⇢ ⛁ *Coins* ꒱ ¥${numFmt(u.coin || 0)}
┊⇢ ❒ *Comandos* ꒱ ${numFmt(u.totalCommand)}

_↳ ${usedPrefix}setbirth DD/MM · ${usedPrefix}setgender m/f/o_`.trim()

  await conn.sendMessage(m.chat, { text: txt, mentions: [target] }, { quoted: m })
}

handler.help    = ['profile', 'setbirth', 'setgender']
handler.tags    = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i
export default handler
