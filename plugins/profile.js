import { xpRange } from '../src/libraries/levelling.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const GENEROS = {
  m: '♂️ Masculino',
  f: '♀️ Femenino',
  o: '⚧️ Otro',
}

function numFmt(n) {
  return Number(n || 0).toLocaleString('es')
}

function progressBar(pct, width = 12) {
  const filled = Math.round(width * pct / 100)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const db    = global.db.data
  const users = db.users

  // ── Target: puede ser mención o el propio remitente ────────────────────────
  const target  = m.mentionedJid?.[0] || m.sender
  const isSelf  = target === m.sender
  const name    = await conn.getName(target) || target.split('@')[0]

  // Inicializar usuario si no existe
  if (!users[target]) users[target] = {}
  const u = users[target]

  // Campos extra que este plugin agrega al perfil
  u.birthday     ??= null
  u.gender       ??= null
  u.harem        ??= 0
  u.totalCommand ??= 0

  // ── Subcomandos de configuración ───────────────────────────────────────────

  if (/^setbirth$/i.test(command)) {
    if (!isSelf) return m.reply('❌ Solo puedes editar tu propio perfil.')
    const raw = args[0]?.trim()
    if (!raw) {
      return m.reply(
        `🗓️ *Establece tu cumpleaños:*\n` +
        `_Ej: ${usedPrefix}setbirth 14/02_  (DD/MM)\n` +
        `_Ej: ${usedPrefix}setbirth 14/02/2000_  (DD/MM/YYYY)`
      )
    }
    const match = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/)
    if (!match) return m.reply('❌ Formato inválido. Usa DD/MM o DD/MM/YYYY')
    const [, d, mo, y] = match
    const day   = parseInt(d),  month = parseInt(mo)
    if (day < 1 || day > 31 || month < 1 || month > 12)
      return m.reply('❌ Fecha inválida.')
    u.birthday = y ? `${d.padStart(2,'0')}/${mo.padStart(2,'0')}/${y}` : `${d.padStart(2,'0')}/${mo.padStart(2,'0')}`
    return m.reply(`✅ Cumpleaños guardado: *${u.birthday}*`)
  }

  if (/^setgender$/i.test(command)) {
    if (!isSelf) return m.reply('❌ Solo puedes editar tu propio perfil.')
    const g = args[0]?.toLowerCase()
    if (!g || !GENEROS[g]) {
      return m.reply(
        `⚧️ *Establece tu género:*\n\n` +
        `• ${usedPrefix}setgender m  → ♂️ Masculino\n` +
        `• ${usedPrefix}setgender f  → ♀️ Femenino\n` +
        `• ${usedPrefix}setgender o  → ⚧️ Otro`
      )
    }
    u.gender = g
    return m.reply(`✅ Género guardado: *${GENEROS[g]}*`)
  }

  // ── Calcular XP y nivel ────────────────────────────────────────────────────

  const exp   = u.exp   || 0
  const level = u.level || 0

  const range   = xpRange(level, global.multiplier || 1)
  const xpMin   = range.min
  const xpMax   = range.max
  const xpNow   = Math.max(0, exp - xpMin)
  const xpNeed  = Math.max(1, xpMax - xpMin)
  const pct     = Math.min(100, Math.floor((xpNow / xpNeed) * 100))

  // ── Ranking global por XP ──────────────────────────────────────────────────

  const sorted = Object.entries(users)
    .filter(([, v]) => typeof v?.exp === 'number')
    .sort(([, a], [, b]) => (b.exp || 0) - (a.exp || 0))

  const rank = sorted.findIndex(([jid]) => jid === target) + 1

  // ── Datos del perfil ───────────────────────────────────────────────────────

  const birthday    = u.birthday || `Sin especificar :< (${usedPrefix}setbirth)`
  const gender      = u.gender ? GENEROS[u.gender] : 'Sin especificar'
  const harem       = u.harem || 0
  const valorTotal  = (u.money || 0) + (u.wallet || 0)
  const coins       = u.coin || 0
  const totalCmd    = u.totalCommand || 0
  const premium     = (u.premiumTime || 0) > Date.now()

  // ── Texto del perfil ───────────────────────────────────────────────────────

  const mention   = '@' + target.split('@')[0]
  const premBadge = premium ? ' 👑' : ''

  const txt =
    `「✿」 *Perfil* ◢ ${name}${premBadge} ◤\n` +
    `\n` +
    `♛ Cumpleaños » *${birthday}*\n` +
    `♛ Género » *${gender}*\n` +
    `\n` +
    `☆ Experiencia » *${numFmt(exp)}*\n` +
    `❖ Nivel » *${level}*\n` +
    `➨ Progreso » *${numFmt(xpNow)} ⟹ ${numFmt(xpNeed)}*\n` +
    `\`[${progressBar(pct)}] ${pct}%\`\n` +
    `# Puesto » *#${rank > 0 ? numFmt(rank) : '?'}*\n` +
    `\n` +
    `ꕥ Harem » *${harem}*\n` +
    `✧ Valor total » *${numFmt(valorTotal)}*\n` +
    `⛁ Coins totales » *¥${numFmt(coins)} vidas*\n` +
    `❒ Comandos totales » *${numFmt(totalCmd)}*`

  await conn.sendMessage(m.chat, {
    text      : txt,
    mentions  : [target],
  }, { quoted: m })
}

handler.help    = ['perfil', 'profile', 'setbirth <DD/MM>', 'setgender <m/f/o>']
handler.tags    = ['user']
handler.command = /^(perfil|profile|pf|setbirth|setgender)$/i

export default handler
