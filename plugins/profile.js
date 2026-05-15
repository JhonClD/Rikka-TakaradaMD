import { xpRange } from '../src/libraries/levelling.js'
import {
  resolveAnyJid,
  getLidForJidAsync,
  isPhoneJid,
  cleanJid,
} from '../src/funcion/lid-resolver.js'

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

const getRawTarget = (m) => {
  return m.quoted?.sender
    || m.quoted?.participant
    || m.message?.extendedTextMessage?.contextInfo?.participant
    || m.mentionedJid?.[0]
    || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    || m.sender
}

const sameUser = (a, b) => {
  a = cleanJid(a)
  b = cleanJid(b)

  if (!a || !b) return false
  if (a === b) return true

  const ax = a.split('@')[0]
  const bx = b.split('@')[0]

  return ax === bx
}

const getProfilePic = async (conn, realJid, lid) => {
  const fallback = 'https://files.catbox.moe/leegee.jpg'
  const candidates = [...new Set([realJid, lid].filter(Boolean).map(cleanJid))]

  for (const jid of candidates) {
    if (!jid || !isPhoneJid(jid)) continue

    try {
      const pp = await conn.profilePictureUrl(jid, 'image')
      if (pp) return pp
    } catch {}
  }

  for (const jid of candidates) {
    if (!jid || !isPhoneJid(jid)) continue

    try {
      const pp = await conn.profilePictureUrl(jid, 'preview')
      if (pp) return pp
    } catch {}
  }

  return fallback
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users = global.db.data.users

  const rawTarget = getRawTarget(m)
  const who = await resolveAnyJid(rawTarget, conn, m.chat)
  const sender = await resolveAnyJid(m.sender, conn, m.chat)
  const lid = isPhoneJid(who) ? await getLidForJidAsync(who, conn) : null

  const isSelf = sameUser(who, sender)
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

    if (!raw || !/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(raw)) {
      return m.reply(`🗓️ Usa: *${usedPrefix + command} DD/MM*`)
    }

    u.birthday = raw
    return m.reply(`✅ Cumpleaños guardado: *${u.birthday}*`)
  }

  if (command === 'setgender') {
    if (!isSelf) return m.reply('❌ Solo puedes editar tu propio perfil.')

    const g = args[0]?.toLowerCase()

    if (!GENEROS[g]) {
      return m.reply('⚧️ Géneros: *m* (Masc), *f* (Fem), *o* (Otro)')
    }

    u.gender = g
    return m.reply(`✅ Género guardado: *${GENEROS[g]}*`)
  }

  const { min, xp } = xpRange(u.level, global.multiplier || 1)
  const xpNow = Math.max(0, u.exp - min)
  const xpNeed = xp || 1
  const pct = Math.min(100, Math.floor((xpNow / xpNeed) * 100))

  const sorted = Object.entries(users).sort(([, a], [, b]) => {
    return (b.exp || 0) - (a.exp || 0)
  })

  const rank = sorted.findIndex(([jid]) => sameUser(jid, who)) + 1

  const txt = `
「✿」 *Perfil* ◢ ${name} ◤

♛ Cumpleaños » *${u.birthday || `Sin especificar (${usedPrefix}setbirth)`}*
♛ Género » *${u.gender ? GENEROS[u.gender] : 'Sin especificar'}*

☆ Experiencia » *${numFmt(u.exp)}*
❖ Nivel » *${u.level}*
➨ Progreso » *${numFmt(xpNow)} ⟹ ${numFmt(xpNeed)}*
\`[${progressBar(pct)}] ${pct}%\`
# Puesto » *#${rank || 0}*

ꕥ Harem » *${u.harem}*
✧ Valor total » *${numFmt((u.money || 0) + (u.wallet || 0))}*
⛁ Coins totales » *¥${numFmt(u.coin || 0)} vidas*
❒ Comandos totales » *${numFmt(u.totalCommand)}*`.trim()

  const pp = await getProfilePic(conn, who, lid)

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
