// ═══════════════════════════════════════════════════════════════
//  rpg-farm.js  ·  Plugin de Farmeo RPG  ·  Rikka-TakaradaMD
//  Adaptado desde YukiBot-MD
//  Comandos: daily, weekly, work, mine, fish, hunt, adventure,
//            dungeon, crime, steal, heal, balance
// ═══════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('es')
}

function msToTime(ms) {
  const s = Math.ceil(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m ${sec}s`
  if (m) return `${m} minuto${m !== 1 ? 's' : ''} ${sec}s`
  return `${sec} segundo${sec !== 1 ? 's' : ''}`
}

/** Inicializa campos RPG si no existen en el objeto usuario */
function initUser(u) {
  u.coin            ??= 0
  u.bank            ??= 0
  u.health          ??= 100
  u.streak          ??= 0
  u.lastDailyGlobal ??= 0
  u.weeklyStreak    ??= 0
  u.lastWeeklyGlobal??= 0
  u.lastdaily       ??= 0
  u.lastweekly      ??= 0
  u.lastwork        ??= 0
  u.lastmine        ??= 0
  u.lastfish        ??= 0
  u.lasthunt        ??= 0
  u.lastadventure   ??= 0
  u.lastdungeon     ??= 0
  u.lastcrime       ??= 0
  u.laststeal       ??= 0
  u.lastheal        ??= 0
}

/** Descuenta `amount` priorizando coin antes de bank */
function deductFunds(u, amount) {
  const total = (u.coin || 0) + (u.bank || 0)
  const real  = Math.min(amount, total)
  if (u.coin >= real) {
    u.coin -= real
  } else {
    const rest = real - u.coin
    u.coin = 0
    u.bank = Math.max(0, (u.bank || 0) - rest)
  }
  return real
}

// ─── Handler principal ────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command }) => {
  const db   = global.db.data
  const user = db.users[m.sender]
  if (!user) return m.reply('❌ No estás registrado en la base de datos.')
  initUser(user)

  const cmd = command.toLowerCase()

  // ────────────────────────────────────────────────────────────────────────────
  //  💰 BALANCE
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(balance|bal|billetera)$/.test(cmd)) {
    const who    = m.mentionedJid?.[0] || (m.quoted?.sender) || m.sender
    const target = db.users[who]
    if (!target) return m.reply('❌ Ese usuario no está en la base de datos.')
    initUser(target)
    const name  = await conn.getName(who) || who.split('@')[0]
    const total = (target.coin || 0) + (target.bank || 0)
    return m.reply(
      `✿ *${name}*\n\n` +
      `⛀ Cartera » *¥${fmtNum(target.coin)}*\n` +
      `⚿ Banco   » *¥${fmtNum(target.bank)}*\n` +
      `⛁ Total   » *¥${fmtNum(total)}*\n\n` +
      `_Protege tu dinero con_ *${usedPrefix}deposit <cantidad>*`
    )
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  💊 CURAR  (heal)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(heal|curar|curarme)$/.test(cmd)) {
    const who    = m.mentionedJid?.[0] || (m.quoted?.sender) || m.sender
    const target = db.users[who]
    if (!target) return m.reply('❌ Ese usuario no está en la base de datos.')
    initUser(target)
    const name = await conn.getName(who) || who.split('@')[0]
    if (target.health >= 100)
      return m.reply(`❤️ ${who === m.sender ? 'Tu' : `La de *${name}*`} salud ya está al máximo (${target.health}/100).`)
    const faltante = 100 - target.health
    const bloques  = Math.ceil(faltante / 10)
    const costo    = bloques * 500
    const fondos   = (user.coin || 0) + (user.bank || 0)
    if (fondos < costo)
      return m.reply(
        `❌ No tienes suficientes coins para curar${who !== m.sender ? ` a *${name}*` : 'te'}.\n` +
        `> Necesitas *¥${fmtNum(costo)}* para recuperar *${faltante}* puntos de salud.`
      )
    deductFunds(user, costo)
    target.health = 100
    return m.reply(
      `💊 ${who === m.sender ? '¡Te has curado!' : `¡Has curado a *${name}*!`}\n` +
      `> Salud: *100/100* ❤️\n` +
      `> Costo: *¥${fmtNum(costo)}*`
    )
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  📦 DEPOSIT / WITHDRAW
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(deposit|depositar)$/.test(cmd)) {
    const amt = args[0] === 'all' ? user.coin : parseInt(args[0])
    if (!amt || amt <= 0 || isNaN(amt)) return m.reply(`❌ Uso: *${usedPrefix}deposit <cantidad|all>*`)
    if (user.coin < amt) return m.reply(`❌ No tienes *¥${fmtNum(amt)}* en cartera. Tienes *¥${fmtNum(user.coin)}*.`)
    user.coin -= amt
    user.bank  = (user.bank || 0) + amt
    return m.reply(`⚿ Depositaste *¥${fmtNum(amt)}* al banco.\n> Banco: *¥${fmtNum(user.bank)}*`)
  }

  if (/^(withdraw|retirar)$/.test(cmd)) {
    const amt = args[0] === 'all' ? user.bank : parseInt(args[0])
    if (!amt || amt <= 0 || isNaN(amt)) return m.reply(`❌ Uso: *${usedPrefix}withdraw <cantidad|all>*`)
    if ((user.bank || 0) < amt) return m.reply(`❌ No tienes *¥${fmtNum(amt)}* en el banco. Tienes *¥${fmtNum(user.bank)}*.`)
    user.bank -= amt
    user.coin  = (user.coin || 0) + amt
    return m.reply(`⛀ Retiraste *¥${fmtNum(amt)}* del banco.\n> Cartera: *¥${fmtNum(user.coin)}*`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  📅 DAILY
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(daily|diario)$/.test(cmd)) {
    const now    = Date.now()
    const oneDay = 86400000
    if (now < user.lastdaily) {
      return m.reply(`ꕥ Ya reclamaste tu *Daily* de hoy.\n> Puedes reclamarlo en *${msToTime(user.lastdaily - now)}*`)
    }
    const lost = user.streak >= 1 && now - user.lastDailyGlobal > oneDay * 1.5
    if (lost) user.streak = 0
    if (now - user.lastDailyGlobal >= oneDay) {
      user.streak = Math.min((user.streak || 0) + 1, 200)
      user.lastDailyGlobal = now
    }
    const reward   = Math.min(20000 + (user.streak - 1) * 5000, 1015000)
    user.coin     += reward
    user.lastdaily = now + oneDay
    const next     = Math.min(20000 + user.streak * 5000, 1015000)
    let msg = `> Día *${user.streak + 1}* » *+¥${fmtNum(next)}*`
    if (lost) msg += `\n> ☆ ¡Perdiste tu racha de días!`
    return m.reply(
      `「✿」 Has reclamado tu recompensa diaria de *¥${fmtNum(reward)}*! (Día *${user.streak}*)\n${msg}`
    )
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  📅 WEEKLY
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(weekly|semanal)$/.test(cmd)) {
    const now = Date.now()
    const gap = 604800000
    if (now < user.lastweekly) {
      return m.reply(`ꕥ Ya reclamaste tu recompensa semanal.\n> Puedes reclamarla en *${msToTime(user.lastweekly - now)}*`)
    }
    const lost = user.weeklyStreak >= 1 && now - user.lastWeeklyGlobal > gap * 1.5
    if (lost) user.weeklyStreak = 0
    if (now - user.lastWeeklyGlobal >= gap) {
      user.weeklyStreak = Math.min((user.weeklyStreak || 0) + 1, 30)
      user.lastWeeklyGlobal = now
    }
    const reward    = Math.min(40000 + (user.weeklyStreak - 1) * 5000, 185000)
    user.coin      += reward
    user.lastweekly = now + gap
    const next      = Math.min(40000 + user.weeklyStreak * 5000, 185000)
    let msg = `> Semana *${user.weeklyStreak + 1}* » *+¥${fmtNum(next)}*`
    if (lost) msg += `\n> ☆ ¡Perdiste tu racha semanal!`
    return m.reply(
      `「❁」 Has reclamado tu recompensa semanal de *¥${fmtNum(reward)}*! (Semana *${user.weeklyStreak}*)\n${msg}`
    )
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  💼 WORK  (cd: 3 min)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(work|trabajar|chamba|chambear)$/.test(cmd)) {
    const cd = 3 * 60 * 1000
    if (Date.now() < user.lastwork)
      return m.reply(`ꕥ Espera *${msToTime(user.lastwork - Date.now())}* para volver a trabajar.`)
    user.lastwork = Date.now() + cd
    const rsl     = Math.floor(Math.random() * 2001) + 2000
    user.coin    += rsl
    return m.reply(`❀ ${pickRandom(TRABAJOS)} *¥${fmtNum(rsl)}*.`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  ⛏️ MINE  (cd: 10 min, consume salud)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(mine|minar)$/.test(cmd)) {
    if (user.health < 5) return m.reply(`ꕥ No tienes salud suficiente para minar.\n> Usa *${usedPrefix}heal* para curarte.`)
    if (Date.now() < user.lastmine)
      return m.reply(`ꕥ Espera *${msToTime(user.lastmine - Date.now())}* para volver a minar.`)
    user.lastmine = Date.now() + 10 * 60 * 1000
    const legendary = Math.random() < 0.02
    let reward, msg, bonus = ''
    if (legendary) {
      reward = Math.floor(Math.random() * 2001) + 11000
      msg    = '¡DESCUBRISTE UN TESORO LEGENDARIO!\n\n'
      bonus  = '\nꕥ ¡Recompensa ÉPICA obtenida!'
    } else {
      reward = Math.floor(Math.random() * 2501) + 7000
      msg    = `En ${pickRandom(ESCENARIOS_MINA)}, ${pickRandom(MINERIA)}`
      if (Math.random() < 0.1) {
        const b = Math.floor(Math.random() * 2001) + 2500
        reward += b
        bonus   = `\n「✿」 ¡Bonus! Ganaste *¥${fmtNum(b)}* extra.`
      }
    }
    user.coin   += reward
    user.health  = Math.max(0, (user.health || 100) - (Math.floor(Math.random() * 11) + 5))
    return m.reply(`「✿」 ${msg} *¥${fmtNum(reward)}*${bonus}\n> ❤️ Salud restante: *${user.health}/100*`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  🎣 FISH  (cd: 8 min)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(fish|pescar)$/.test(cmd)) {
    if (Date.now() < user.lastfish)
      return m.reply(`ꕥ Espera *${msToTime(user.lastfish - Date.now())}* para volver a pescar.`)
    user.lastfish = Date.now() + 8 * 60 * 1000
    const rand = Math.random()
    let msg
    if (rand < 0.4) {
      const cantidad = Math.floor(Math.random() * 2001) + 6000
      user.coin += cantidad
      msg = pickRandom(FISH_WIN).replace('{{n}}', fmtNum(cantidad))
    } else if (rand < 0.7) {
      const cantidad = Math.floor(Math.random() * 1501) + 5000
      const real     = deductFunds(user, cantidad)
      msg = pickRandom(FISH_FAIL).replace('{{n}}', fmtNum(real))
    } else {
      msg = pickRandom(FISH_NEUTRAL)
    }
    return m.reply(`「✿」 ${msg}`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  🏹 HUNT  (cd: 15 min, consume salud)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(hunt|cazar)$/.test(cmd)) {
    if (user.health < 5) return m.reply(`ꕥ No tienes salud para cazar.\n> Usa *${usedPrefix}heal* para curarte.`)
    if (Date.now() < user.lasthunt)
      return m.reply(`ꕥ Espera *${msToTime(user.lasthunt - Date.now())}* para volver a cazar.`)
    user.lasthunt = Date.now() + 15 * 60 * 1000
    const rand  = Math.random()
    const salud = Math.floor(Math.random() * 6) + 10
    let msg
    if (rand < 0.4) {
      const cantidad = Math.floor(Math.random() * 3001) + 10000
      user.coin     += cantidad
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(HUNT_WIN).replace('{{n}}', fmtNum(cantidad))
    } else if (rand < 0.7) {
      const cantidad = Math.floor(Math.random() * 2001) + 6000
      const real     = deductFunds(user, cantidad)
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(HUNT_FAIL).replace('{{n}}', fmtNum(real))
    } else {
      msg = pickRandom(HUNT_NEUTRAL)
    }
    return m.reply(`「✿」 ${msg}\n> ❤️ Salud: *${user.health}/100*`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  ⚔️ ADVENTURE  (cd: 20 min, consume salud)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(adventure|aventura)$/.test(cmd)) {
    if (user.health < 5) return m.reply(`ꕥ No tienes salud para aventurarte.\n> Usa *${usedPrefix}heal* para curarte.`)
    if (Date.now() < user.lastadventure)
      return m.reply(`ꕥ Espera *${msToTime(user.lastadventure - Date.now())}* para aventurarte de nuevo.`)
    user.lastadventure = Date.now() + 20 * 60 * 1000
    const rand  = Math.random()
    const salud = Math.floor(Math.random() * 11) + 10
    let msg
    if (rand < 0.4) {
      const cantidad = Math.floor(Math.random() * 4001) + 14000
      user.coin     += cantidad
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(ADV_WIN).replace('{{n}}', fmtNum(cantidad))
    } else if (rand < 0.7) {
      const cantidad = Math.floor(Math.random() * 2001) + 9000
      const real     = deductFunds(user, cantidad)
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(ADV_FAIL).replace('{{n}}', fmtNum(real))
    } else {
      msg = pickRandom(ADV_NEUTRAL)
    }
    return m.reply(`「✿」 ${msg}\n> ❤️ Salud: *${user.health}/100*`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  🏰 DUNGEON  (cd: 17 min, consume salud)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(dungeon|mazmorra)$/.test(cmd)) {
    if (user.health < 5) return m.reply(`ꕥ No tienes salud para entrar a la mazmorra.\n> Usa *${usedPrefix}heal* para curarte.`)
    if (Date.now() < user.lastdungeon)
      return m.reply(`ꕥ Espera *${msToTime(user.lastdungeon - Date.now())}* para volver a la mazmorra.`)
    user.lastdungeon = Date.now() + 17 * 60 * 1000
    const rand  = Math.random()
    const salud = Math.floor(Math.random() * 9) + 10
    let msg
    if (rand < 0.4) {
      const cantidad = Math.floor(Math.random() * 3001) + 12000
      user.coin     += cantidad
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(DUN_WIN).replace('{{n}}', fmtNum(cantidad))
    } else if (rand < 0.7) {
      const cantidad = Math.floor(Math.random() * 1501) + 7500
      const real     = deductFunds(user, cantidad)
      user.health    = Math.max(0, (user.health || 100) - salud)
      msg = pickRandom(DUN_FAIL).replace('{{n}}', fmtNum(real))
    } else {
      msg = pickRandom(DUN_NEUTRAL)
    }
    return m.reply(`「✿」 ${msg}\n> ❤️ Salud: *${user.health}/100*`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  🦹 CRIME  (cd: 7 min)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(crime|crimen)$/.test(cmd)) {
    if (Date.now() < user.lastcrime)
      return m.reply(`ꕥ Espera *${msToTime(user.lastcrime - Date.now())}* antes de intentar otro crimen.`)
    user.lastcrime = Date.now() + 7 * 60 * 1000
    const exito = Math.random() < 0.4
    if (exito) {
      const cantidad = Math.floor(Math.random() * 2001) + 5500
      user.coin     += cantidad
      return m.reply(`「✿」 ${pickRandom(CRIME_WIN).replace('{{n}}', fmtNum(cantidad))}`)
    } else {
      const cantidad = Math.floor(Math.random() * 2001) + 4000
      const real     = deductFunds(user, cantidad)
      return m.reply(`「✿」 ${pickRandom(CRIME_FAIL).replace('{{n}}', fmtNum(real))}`)
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  🗡️ STEAL  (cd: 1 hora)
  // ────────────────────────────────────────────────────────────────────────────
  if (/^(steal|robar|rob)$/.test(cmd)) {
    if (Date.now() < user.laststeal)
      return m.reply(`ꕥ Espera *${msToTime(user.laststeal - Date.now())}* para volver a robar.`)
    const who = m.mentionedJid?.[0] || (m.quoted?.sender) || null
    if (!who) return m.reply(`❀ Menciona a alguien para intentar robarle.\n_Ej: ${usedPrefix}steal @usuario_`)
    if (who === m.sender) return m.reply('❌ No puedes robarte a ti mismo.')
    const target = db.users[who]
    if (!target) return m.reply('❌ Ese usuario no está en la base de datos.')
    initUser(target)
    const name = await conn.getName(who) || who.split('@')[0]
    const chance = Math.random()
    if (chance < 0.3) {
      const loss = Math.floor(Math.random() * 3001) + 2000
      const real = deductFunds(user, loss)
      user.laststeal = Date.now() + 3600000
      return m.reply(`ꕥ El robo salió mal y perdiste *¥${fmtNum(real)}*.`)
    }
    const rob = Math.floor(Math.random() * 4001) + 4000
    if ((target.coin || 0) < rob)
      return m.reply(`ꕥ *${name}* no tiene suficientes coins en cartera para que valga la pena.`)
    user.coin     += rob
    target.coin   -= rob
    user.laststeal = Date.now() + 3600000
    return conn.sendMessage(m.chat, {
      text    : `❀ Le robaste *¥${fmtNum(rob)}* a *${name}* 🗡️`,
      mentions: [who],
    }, { quoted: m })
  }
}

handler.help    = [
  'daily', 'weekly', 'work', 'mine', 'fish', 'hunt',
  'adventure', 'dungeon', 'crime', 'steal @usuario',
  'heal [@usuario]', 'balance [@usuario]',
  'deposit <cantidad|all>', 'withdraw <cantidad|all>',
]
handler.tags    = ['rpg', 'economia']
handler.command = /^(daily|diario|weekly|semanal|work|trabajar|chamba|chambear|mine|minar|fish|pescar|hunt|cazar|adventure|aventura|dungeon|mazmorra|crime|crimen|steal|robar|rob|heal|curar|curarme|balance|bal|billetera|deposit|depositar|withdraw|retirar)$/i

export default handler

// ═══════════════════════════════════════════════════════════════
//  DATOS DE TEXTO
// ═══════════════════════════════════════════════════════════════

const TRABAJOS = [
  'Trabajas como recolector de fresas y ganas',
  'Diseñas páginas web y ganas',
  'Eres fotógrafo de bodas y recibes',
  'Trabajas en una tienda de mascotas y ganas',
  'Eres narrador de audiolibros y obtienes',
  'Trabajas como jardinero en un parque y recibes',
  'Eres un DJ en fiestas y ganas',
  'Hiciste un mural en una cafetería y te dieron',
  'Preparas sushi en un restaurante y ganas',
  'Eres un escritor freelance y ganas',
  'Trabajas como mecánico de automóviles y ganas',
  'Eres un instructor de surf y recibes',
  'Limpias casas y ganas',
  'Eres un técnico de sonido en conciertos y obtienes',
  'Trabajas como desarrollador de aplicaciones y ganas',
  'Trabajas como estilista de cabello y ganas',
  'Trabajas como barista en una cafetería y recibes',
  'Eres un entrenador de mascotas y ganas',
  'Eres un operador de drones y ganas',
  'Trabajas como repartidor de comida y recibes',
  'Eres un creador de contenido en redes sociales y ganas',
]

const ESCENARIOS_MINA = [
  'una cueva oscura y húmeda', 'la cima de una montaña nevada',
  'un bosque misterioso lleno de raíces', 'una mina abandonada de carbón',
  'las ruinas de un antiguo castillo', 'un valle escondido entre colinas',
]

const MINERIA = [
  'encontraste un antiguo cofre con', 'hallaste una bolsa llena de',
  'desenterraste monedas antiguas que contienen', 'rompiste una roca y adentro estaba',
  'cavando profundo, hallaste', 'entre las raíces, encontraste',
  'dentro de una caja olvidada, hallaste', 'bajo unas piedras, descubriste',
]

const FISH_WIN = [
  '¡Pescaste un Salmón! Ganaste *¥{{n}}*!',
  '¡Capturaste un Tiburón! Ganaste *¥{{n}}*!',
  '¡Pescaste una Ballena! Ganaste *¥{{n}}*!',
  '¡Atrapaste una Anguila Dorada! Ganaste *¥{{n}}*!',
  '¡Sacaste un Pez Dragón! Ganaste *¥{{n}}*!',
]

const FISH_FAIL = [
  'El anzuelo se enredó y perdiste parte de tu equipo, perdiste *¥{{n}}*.',
  'Una corriente fuerte arrastró tu caña, perdiste *¥{{n}}*.',
  'Un pez grande rompió tu línea, perdiste *¥{{n}}*.',
  'Tu bote se golpeó contra las rocas, perdiste *¥{{n}}*.',
]

const FISH_NEUTRAL = [
  'Pasaste la tarde pescando sin mucha suerte... los peces no pic
