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

// Cache simple en memoria
const profilePicCache = new Map()

const getProfilePicture = async (conn, jid) => {
  // Verificar cache primero (respuesta instantánea)
  const cached = profilePicCache.get(jid)
  if (cached && (Date.now() - cached.time) < 300000) { // 5 minutos cache
    return cached.buffer
  }

  try {
    // Obtener la URL de la foto de perfil
    let ppUrl = null
    
    // Intentar obtener la URL (esto es lo que fallaba)
    try {
      ppUrl = await conn.profilePictureUrl(jid, 'image')
      console.log('✅ URL de imagen obtenida:', ppUrl?.substring(0, 50) + '...')
    } catch (err) {
      console.log('❌ Error al obtener URL de imagen:', err.message)
    }

    // Si falla, intentar con 'preview' (más rápido, menor calidad)
    if (!ppUrl) {
      try {
        ppUrl = await conn.profilePictureUrl(jid, 'preview')
        console.log('✅ URL de preview obtenida:', ppUrl?.substring(0, 50) + '...')
      } catch (err) {
        console.log('❌ Error al obtener URL de preview:', err.message)
      }
    }

    // Si tenemos URL, descargar la imagen
    if (ppUrl && ppUrl.startsWith('http')) {
      const response = await fetch(ppUrl)
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer())
        // Guardar en cache
        profilePicCache.set(jid, { buffer, time: Date.now() })
        console.log('✅ Imagen descargada correctamente')
        return buffer
      }
    }

    // Si no se pudo obtener, usar imagen por defecto
    console.log('⚠️ Usando imagen por defecto')
    const defaultUrl = 'https://files.catbox.moe/leegee.jpg'
    const response = await fetch(defaultUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    profilePicCache.set(jid, { buffer, time: Date.now() })
    return buffer

  } catch (error) {
    console.error('Error final:', error)
    // Último recurso
    const response = await fetch('https://files.catbox.moe/leegee.jpg')
    return Buffer.from(await response.arrayBuffer())
  }
}

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const users = global.db.data.users
  const target = m.mentionedJid?.[0] || m.quoted?.sender || m.sender
  
  console.log('🎯 Target JID:', target) // Debug: ver qué JID se está usando
  
  const isSelf = target === m.sender
  const name = await conn.getName(target)
  
  console.log('👤 Nombre:', name) // Debug: ver nombre

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

  // Mensaje de "cargando..." mientras se obtiene la imagen
  await conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })

  try {
    // Obtener imagen de perfil
    const imgBuf = await getProfilePicture(conn, target)

    await conn.sendMessage(
      m.chat,
      {
        image: imgBuf,
        caption: txt,
        mentions: [target],
      },
      { quoted: m }
    )
  } catch (error) {
    console.error('Error enviando imagen:', error)
    // Si falla el envío con imagen, enviar solo texto
    await conn.sendMessage(
      m.chat,
      {
        text: txt,
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
