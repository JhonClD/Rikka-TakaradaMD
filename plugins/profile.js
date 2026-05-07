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

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users = global.db.data.users
  
  // Obtener el JID REAL sin modificaciones del LidResolver
  let target
  if (m.mentionedJid?.[0]) {
    target = m.mentionedJid[0]
  } else if (m.quoted?.sender) {
    target = m.quoted.sender
  } else {
    // Usar el sender original del mensaje, no el modificado
    target = m.key.participant || m.key.remoteJid || m.sender
  }
  
  // Normalizar JID (quitar @lid si existe)
  if (target?.endsWith?.('@lid')) {
    const cached = conn.lid?.getUserInfo?.(target.split('@')[0])
    target = cached?.jid || target
  }
  
  const isSelf = target === m.sender || target === (m.key.participant || m.key.remoteJid)
  const name = await conn.getName(target)

  if (!users[target]) users[target] = {}
  const u = users[target]

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
  const rank = sorted.findIndex(([jid]) => jid === target) + 1

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

  // Intentar obtener foto de perfil con timeout
  let ppUrl = null
  
  try {
    // Timeout de 3 segundos para no bloquear
    ppUrl = await Promise.race([
      conn.profilePictureUrl(target, 'image').catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 3000))
    ])
  } catch {}

  if (!ppUrl) {
    try {
      ppUrl = await Promise.race([
        conn.profilePictureUrl(target, 'preview').catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 2000))
      ])
    } catch {}
  }

  let imgBuf = null
  
  if (ppUrl) {
    try {
      const res = await fetch(ppUrl)
      if (res.ok) imgBuf = Buffer.from(await res.arrayBuffer())
    } catch {}
  }

  // Si no hay foto, usar fallback
  if (!imgBuf) {
    try {
      const res = await fetch('https://files.catbox.moe/leegee.jpg')
      imgBuf = Buffer.from(await res.arrayBuffer())
    } catch {}
  }

  if (imgBuf) {
    await conn.sendMessage(
      m.chat,
      {
        image: imgBuf,
        caption: txt,
        mentions: [target],
      },
      { quoted: m }
    )
  } else {
    await conn.sendMessage(
      m.chat,
      { text: txt, mentions: [target] },
      { quoted: m }
    )
  }
}

handler.help = ['profile', 'setbirth', 'setgender']
handler.tags = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i

export default handler
