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

// Función mejorada para obtener la foto de perfil
const getProfilePicture = async (conn, jid, options = {}) => {
  const { fallback = 'https://files.catbox.moe/leegee.jpg', maxAttempts = 3, delay = 1000 } = options
  
  const isValidUrl = (url) => {
    try {
      return url && typeof url === 'string' && new URL(url)
    } catch {
      return false
    }
  }

  const toBuffer = async (url) => {
    if (!isValidUrl(url)) throw new Error('URL inválida')
    
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000) // 10 segundos timeout
    
    try {
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)' }
      })
      
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      
      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } finally {
      clearTimeout(timeout)
    }
  }

  // Estrategias para obtener la foto de perfil (en orden)
  const strategies = [
    // 1. Intento directo con 'image' (mejor calidad)
    async () => {
      try {
        const url = await conn.profilePictureUrl(jid, 'image')
        if (isValidUrl(url)) return await toBuffer(url)
      } catch (e) {
        console.log(`[Profile] Intento 1 (image) falló:`, e.message)
      }
      return null
    },
    
    // 2. Intento con 'preview' (calidad reducida)
    async () => {
      try {
        const url = await conn.profilePictureUrl(jid, 'preview')
        if (isValidUrl(url)) return await toBuffer(url)
      } catch (e) {
        console.log(`[Profile] Intento 2 (preview) falló:`, e.message)
      }
      return null
    },
    
    // 3. Reintentos con delay
    async () => {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const url = await conn.profilePictureUrl(jid, 'image')
          if (isValidUrl(url)) return await toBuffer(url)
        } catch (e) {
          if (i < maxAttempts - 1) {
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }
      return null
    }
  ]

  // Probar cada estrategia en orden
  for (const strategy of strategies) {
    const result = await strategy()
    if (result) return result
  }

  // Si todo falla, usar imagen por defecto
  console.log(`[Profile] Usando imagen por defecto para ${jid}`)
  return await toBuffer(fallback)
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

  // Obtener imagen de perfil con el nuevo sistema mejorado
  const imgBuf = await getProfilePicture(conn, target, {
    fallback: 'https://files.catbox.moe/leegee.jpg',
    maxAttempts: 2,
    delay: 500
  })

  await conn.sendMessage(
    m.chat,
    {
      image: imgBuf,
      caption: txt,
      mentions: [target],
    },
    { quoted: m }
  )
}

handler.help = ['profile', 'setbirth', 'setgender']
handler.tags = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i

export default handler
