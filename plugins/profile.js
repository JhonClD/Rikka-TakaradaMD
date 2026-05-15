import { xpRange } from '../src/libraries/levelling.js'

const DEFAULT_PP = 'https://files.catbox.moe/leegee.jpg'

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

const cleanJid = (jid) => {
  if (!jid || typeof jid !== 'string') return jid
  jid = jid.trim()
  if (/:\d+@/.test(jid)) {
    const [user, server] = jid.split('@')
    return `${user.split(':')[0]}@${server}`
  }
  return jid
}

const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid')
const isPhone = (jid) => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'))

const toUserJid = (userRaw) => {
  userRaw = cleanJid(userRaw)
  if (!userRaw) return userRaw
  return userRaw.includes('@') ? userRaw : `${userRaw}@s.whatsapp.net`
}

const getRawTarget = (m) => {
  return m.quoted?.sender
    || m.quoted?.participant
    || m.message?.extendedTextMessage?.contextInfo?.participant
    || m.mentionedJid?.[0]
    || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    || m.sender
}

const getPhoneFromLidMapping = async (jid, conn) => {
  jid = cleanJid(jid)
  if (!isLid(jid)) return null

  try {
    const pn = await conn?.signalRepository?.lidMapping?.getPNForLID?.(jid)
    if (pn && typeof pn === 'string' && !pn.endsWith('@lid')) {
      return cleanJid(pn.includes('@') ? pn : `${pn}@s.whatsapp.net`)
    }
  } catch {}

  try {
    const lidKey = jid.split('@')[0]
    const pnUser = conn?.signalRepository?.lidMapping?.mappingCache?.get?.(`lid:${lidKey}`)
    if (pnUser && typeof pnUser === 'string') {
      return cleanJid(pnUser.includes('@') ? pnUser : `${pnUser}@s.whatsapp.net`)
    }
  } catch {}

  try {
    const lidKey = jid.split('@')[0]
    const pnUser = global?.conn?.signalRepository?.lidMapping?.mappingCache?.get?.(`lid:${lidKey}`)
    if (pnUser && typeof pnUser === 'string') {
      return cleanJid(pnUser.includes('@') ? pnUser : `${pnUser}@s.whatsapp.net`)
    }
  } catch {}

  return null
}

const getLidFromPhoneMapping = async (jid, conn) => {
  jid = cleanJid(jid)
  if (!isPhone(jid)) return null

  try {
    const lid = await conn?.signalRepository?.lidMapping?.getLIDForPN?.(jid)
    if (lid && typeof lid === 'string') {
      return cleanJid(lid.includes('@') ? lid : `${lid}@lid`)
    }
  } catch {}

  try {
    const pn = jid.split('@')[0]
    const lid = conn?.signalRepository?.lidMapping?.mappingCache?.get?.(`pn:${pn}`)
    if (lid && typeof lid === 'string') {
      return cleanJid(lid.includes('@') ? lid : `${lid}@lid`)
    }
  } catch {}

  try {
    const pn = jid.split('@')[0]
    const lid = global?.conn?.signalRepository?.lidMapping?.mappingCache?.get?.(`pn:${pn}`)
    if (lid && typeof lid === 'string') {
      return cleanJid(lid.includes('@') ? lid : `${lid}@lid`)
    }
  } catch {}

  return null
}

const resolveFromParticipants = async (jid, conn, chat) => {
  jid = cleanJid(jid)
  if (!jid || !chat?.endsWith?.('@g.us')) return null

  let metadata = null

  try {
    metadata = conn.chats?.[chat]?.metadata || await conn.groupMetadata(chat)
  } catch {}

  const participants = metadata?.participants || []
  if (!participants.length) return null

  const raw = jid.split('@')[0]

  for (const p of participants) {
    const id = cleanJid(p.id || p.jid || '')
    const lid = cleanJid(p.lid || '')
    const phoneNumber = p.phoneNumber
      ? cleanJid(p.phoneNumber.includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`)
      : ''

    if (id === jid && isPhone(id)) return id
    if (phoneNumber === jid && isPhone(phoneNumber)) return phoneNumber
    if (lid === jid && phoneNumber) return phoneNumber
    if (lid === jid && id && isPhone(id)) return id
    if (id === jid && phoneNumber) return phoneNumber
    if (lid?.split('@')[0] === raw && phoneNumber) return phoneNumber
    if (id?.split('@')[0] === raw && isPhone(id)) return id
    if (phoneNumber?.split('@')[0] === raw) return phoneNumber
  }

  return null
}

const resolveUserJid = async (userRaw, conn, chat) => {
  let jid = toUserJid(userRaw)

  if (isPhone(jid)) {
    return jid.endsWith('@c.us') ? `${jid.split('@')[0]}@s.whatsapp.net` : jid
  }

  const fromParticipants = await resolveFromParticipants(jid, conn, chat)
  if (fromParticipants && isPhone(fromParticipants)) return fromParticipants

  const fromMapping = await getPhoneFromLidMapping(jid, conn)
  if (fromMapping && isPhone(fromMapping)) return fromMapping

  return jid
}

const sameUser = (a, b) => {
  a = cleanJid(a)
  b = cleanJid(b)

  if (!a || !b) return false
  if (a === b) return true

  return a.split('@')[0] === b.split('@')[0]
}

const getProfilePic = async (conn, userJid, lid) => {
  const candidates = [...new Set([userJid, lid].filter(Boolean).map(cleanJid))]

  for (const jid of candidates) {
    if (!jid || !isPhone(jid)) continue
    try {
      const pp = await conn.profilePictureUrl(jid, 'image')
      if (pp) return pp
    } catch {}
  }

  for (const jid of candidates) {
    if (!jid || !isPhone(jid)) continue
    try {
      const pp = await conn.profilePictureUrl(jid, 'preview')
      if (pp) return pp
    } catch {}
  }

  return DEFAULT_PP
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users = global.db.data.users

  const rawTarget = getRawTarget(m)
  const who = await resolveUserJid(rawTarget, conn, m.chat)
  const sender = await resolveUserJid(m.sender, conn, m.chat)
  const lid = await getLidFromPhoneMapping(who, conn)

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
