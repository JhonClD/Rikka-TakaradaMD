import { xpRange } from '../src/libraries/levelling.js'
import { areJidsSameUser, jidNormalizedUser } from '@whiskeysockets/baileys'

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

const normalizeJid = (jid) => {
  if (!jid) return jid
  return jidNormalizedUser(jid)
}

const getTargetJid = (m) => {
  const mentioned = m.mentionedJid?.[0] || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
  const quoted = m.quoted?.sender || m.message?.extendedTextMessage?.contextInfo?.participant
  return normalizeJid(quoted || mentioned || m.sender)
}

const getUserJidCandidates = (m, who) => {
  const candidates = [
    who,
    m.sender,
    m.senderPn,
    m.senderJid,
    m.participant,
    m.key?.participant,
    m.key?.participantAlt,
    m.key?.remoteJid?.endsWith('@s.whatsapp.net') ? m.key.remoteJid : null,
    m.quoted?.sender,
    m.quoted?.participant,
    m.message?.extendedTextMessage?.contextInfo?.participant,
  ].filter(Boolean).map(normalizeJid)

  return [...new Set(candidates)]
}

const getProfilePic = async (conn, candidates) => {
  for (const jid of candidates) {
    try {
      const pp = await conn.profilePictureUrl(jid, 'image')
      if (pp) return pp
    } catch {}
  }

  for (const jid of candidates) {
    try {
      const pp = await conn.profilePictureUrl(jid, 'preview')
      if (pp) return pp
    } catch {}
  }

  return 'https://files.catbox.moe/leegee.jpg'
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users = global.db.data.users
  const who = getTargetJid(m)
  const selfJid = normalizeJid(m.sender)
  const isSelf = areJidsSameUser(who, selfJid)
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
    if (!GENEROS[g]) return m.reply('⚧️ Géneros: *m* (Masc), *f* (Fem), *o* (Otro)')
    u.gender = g
    return m.reply(`✅ Género guardado: *${GENEROS[g]}*`)
  }

  const { min, xp } = xpRange(u.level, global.multiplier || 1)
  const xpNow = Math.max(0, u.exp - min)
  const xpNeed = xp || 1
  const pct = Math.min(100, Math.floor((xpNow / xpNeed) * 100))

  const sorted = Object.entries(users).sort(([, a], [, b]) => (b.exp || 0) - (a.exp || 0))
  const rank = sorted.findIndex(([jid]) => areJidsSameUser(normalizeJid(jid), who)) + 1

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

  const candidates = getUserJidCandidates(m, who)
  const pp = await getProfilePic(conn, candidates)

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
