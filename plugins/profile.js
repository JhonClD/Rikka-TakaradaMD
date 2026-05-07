import { xpRange } from '../src/libraries/levelling.js'

const GENEROS = {
  m: '♂️ Masculino',
  f: '♀️ Femenino',
  o: '⚧️ Otro',
}

const numFmt = (n) => Number(n || 0).toLocaleString('es')

const progressBar = (pct, width = 12) => {
  const filled = Math.round(width * pct / 100)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const handler = async (m, { conn, args, usedPrefix, command, text }) => {
  const users = global.db.data.users
  
  // Obtener who EXACTAMENTE como en el ejemplo
  let who
  if (m.quoted) {
    who = m.quoted.sender
  } else if (m.mentionedJid && m.mentionedJid[0]) {
    who = m.mentionedJid[0]
  } else {
    who = m.sender
  }

  // Normalizar JID
  if (!who.includes('@')) who += '@s.whatsapp.net'
  
  const isSelf = who === m.sender
  const name = await conn.getName(who)

  if (!users[who]) users[who] = {}
  const u = users[who]

  if (u.birthday === undefined) u.birthday = null
  if (u.gender === undefined) u.gender = null
  if (u.harem === undefined) u.harem = 0
  if (u.totalCommand === undefined) u.totalCommand = 0
  if (u.exp === undefined) u.exp = 0
  if (u.level === undefined) u.level = 0

  if (command === 'setbirth') {
    if (!isSelf) return m.reply('❌ Solo puedes editar tu propio perfil.')
    const raw = args[0]
    if (!raw || !/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(raw)) return m.reply(`🗓️ Usa: *${usedPrefix + command} DD/MM*`)
    u.birthday = raw
    return m.reply(`✅ Cumpleaños guardado: *${u.birthday}*`)
  }

  if (command === 'setgender') {
    if (!isSelf) return m.reply('❌ Solo puedes editar tu propio perfil.')
    const g = args[0]?.toLowerCase()
    if (!GENEROS[g]) return m.reply(`⚧️ Géneros: *m* (Masc), *f* (Fem), *o* (Otro)`)
    u.gender = g
    return m.reply(`✅ Género guardado: *${GENEROS[g]}*`)
  }

  const { min, xp } = xpRange(u.level, global.multiplier || 1)
  const xpNow = Math.max(0, u.exp - min)
  const xpNeed = xp
  const pct = Math.min(100, Math.floor((xpNow / xpNeed) * 100))

  const sorted = Object.entries(users).sort(([, a], [, b]) => (b.exp || 0) - (a.exp || 0))
  const rank = sorted.findIndex(([jid]) => jid === who) + 1

  const txt = `
「✿」 *Perfil* ◢ ${name} ◤

♛ Cumpleaños » *${u.birthday || `Sin especificar (${usedPrefix}setbirth)`}*
♛ Género » *${u.gender ? GENEROS[u.gender] : 'Sin especificar'}*

☆ Experiencia » *${numFmt(u.exp)}*
❖ Nivel » *${u.level}*
➨ Progreso » *${numFmt(xpNow)} ⟹ ${numFmt(xpNeed)}*
\`[${progressBar(pct)}] ${pct}%\`
# Puesto » *#${rank}*

ꕥ Harem » *${u.harem}*
✧ Valor total » *${numFmt((u.money || 0) + (u.wallet || 0))}*
⛁ Coins totales » *¥${numFmt(u.coin || 0)} vidas*
❒ Comandos totales » *${numFmt(u.totalCommand)}*`.trim()

  // Obtener foto EXACTAMENTE como en el ejemplo
  let pp = 'https://files.catbox.moe/leegee.jpg' // Imagen por defecto
  try {
    pp = await conn.profilePictureUrl(who, 'image')
  } catch {
    try {
      pp = await conn.profilePictureUrl(who, 'preview')
    } catch {}
  }

  await conn.sendMessage(
    m.chat,
    {
      image: { url: pp },
      caption: txt,
      mentions: [who],
    },
    { quoted: m }
  )
}

handler.help = ['profile', 'setbirth', 'setgender']
handler.tags = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i

export default handler
