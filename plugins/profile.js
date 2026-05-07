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
  const target = m.mentionedJid?.[0] || m.quoted?.sender || m.sender
  const isSelf = target === m.sender
  const name = await conn.getName(target)

  if (!users[target]) users[target] = {}
  const u = users[target]

  // Fix: reemplazado ??= por if checks (compatibilidad con parsers viejos)
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

  // SOLUCIÓN: Intentar obtener la imagen de TODAS las formas posibles
  let ppUrl = null

  // Método 1: profilePictureUrl normal
  try {
    ppUrl = await conn.profilePictureUrl(target, 'image')
  } catch {}

  // Método 2: Si falla, intentar obtener la foto desde el mensaje mismo
  if (!ppUrl && m.quoted) {
    try {
      ppUrl = await conn.profilePictureUrl(m.quoted.sender, 'image')
    } catch {}
  }

  // Método 3: Intentar con el número limpio (sin @s.whatsapp.net)
  if (!ppUrl) {
    try {
      const cleanJid = target.split('@')[0]
      ppUrl = await conn.profilePictureUrl(`${cleanJid}@s.whatsapp.net`, 'image')
    } catch {}
  }

  // Método 4: Preview (menor calidad pero más rápido)
  if (!ppUrl) {
    try {
      ppUrl = await conn.profilePictureUrl(target, 'preview')
    } catch {}
  }

  // Método 5: Forzar actualización del perfil
  if (!ppUrl) {
    try {
      // Esto fuerza a WhatsApp a recargar la info del contacto
      await conn.updateProfilePicture(target)
      ppUrl = await conn.profilePictureUrl(target, 'image')
    } catch {}
  }

  let imgBuf = null

  // Si tenemos URL, descargar la imagen
  if (ppUrl) {
    try {
      const res = await fetch(ppUrl)
      if (res.ok) {
        imgBuf = Buffer.from(await res.arrayBuffer())
      }
    } catch {}
  }

  // Enviar mensaje
  if (imgBuf) {
    // ¡TENEMOS IMAGEN REAL! Enviar con imagen
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
    // NO hay imagen - enviar SOLO TEXTO (sin imagen de respaldo)
    // Así es honesto y no muestra una foto que no es la tuya
    await conn.sendMessage(
      m.chat,
      {
        text: `⚠️ *No se pudo obtener tu foto de perfil*\n\n${txt}\n\n💡 *Solución:* Asegúrate de que el bot tenga tu número guardado en sus contactos.`,
        mentions: [target],
      },
      { quoted: m }
    )
  }
}

handler.help = ['profile', 'setbirth', 'setgender']
handler.tags = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i

export default handler
