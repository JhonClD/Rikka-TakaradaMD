// gacha-farmeo.js — Farmeo de monedas (daily, work, balance)
// Portado de YukiBot-MD → Rikka-TakaradaMD

const COOLDOWNS = {
  daily:   24 * 60 * 60 * 1000,
  weekly:  7  * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  work:    4  * 60 * 60 * 1000,
};

function formatTime(ms) {
  if (ms <= 0) return 'Disponible';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = [];
  if (h)   p.push(`${h}h`);
  if (m || h) p.push(`${m}m`);
  p.push(`${sec}s`);
  return p.join(' ');
}

const workPhrases = [
  'trabajaste como programador y ganaste',
  'vendiste stickers y ganaste',
  'hiciste entregas y recibiste',
  'ganaste en un torneo de anime',
  'escribiste un fanfic y recibiste',
  'hiciste cosplay y ganaste',
  'arbitraste un partido y ganaste',
  'reparaste un celular y ganaste',
];

const handler = async (m, { conn, command, args, usedPrefix }) => {
  if (!global.db.data.users[m.sender]) global.db.data.users[m.sender] = {};
  const user = global.db.data.users[m.sender];
  user.coins  = typeof user.coins  === 'number' ? user.coins  : 0;
  user.bank   = typeof user.bank   === 'number' ? user.bank   : 0;
  const name = user.name || m.sender.split('@')[0];
  const now  = Date.now();

  // ─── BALANCE ────────────────────────────────────────────────
  if (['balance', 'bal', 'monedas', 'coins'].includes(command)) {
    return m.reply(
      `💰 *Balance de ${name}*\n\n` +
      `ꕥ Cartera » *¥${user.coins.toLocaleString()}*\n` +
      `ꕥ Banco   » *¥${user.bank.toLocaleString()}*\n` +
      `ꕥ Total   » *¥${(user.coins + user.bank).toLocaleString()}*`
    );
  }

  // ─── DEPOSIT ────────────────────────────────────────────────
  if (['deposit', 'depositar'].includes(command)) {
    const amount = args[0] === 'all' ? user.coins : parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return m.reply(`❀ Uso: *${usedPrefix}deposit <cantidad|all>*`);
    if (amount > user.coins) return m.reply(`ꕥ No tienes suficientes monedas. Tienes *¥${user.coins.toLocaleString()}*.`);
    user.coins -= amount;
    user.bank  += amount;
    return m.reply(`✅ Depositaste *¥${amount.toLocaleString()}* al banco.\n> Banco: *¥${user.bank.toLocaleString()}*`);
  }

  // ─── WITHDRAW ───────────────────────────────────────────────
  if (['withdraw', 'retirar'].includes(command)) {
    const amount = args[0] === 'all' ? user.bank : parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return m.reply(`❀ Uso: *${usedPrefix}withdraw <cantidad|all>*`);
    if (amount > user.bank) return m.reply(`ꕥ Solo tienes *¥${user.bank.toLocaleString()}* en el banco.`);
    user.bank  -= amount;
    user.coins += amount;
    return m.reply(`✅ Retiraste *¥${amount.toLocaleString()}* del banco.\n> Cartera: *¥${user.coins.toLocaleString()}*`);
  }

  // ─── DAILY ──────────────────────────────────────────────────
  if (['daily', 'diario'].includes(command)) {
    if (user.lastDaily && now < user.lastDaily) {
      return m.reply(`ꕥ Próximo daily en *${formatTime(user.lastDaily - now)}*.`);
    }
    const reward = Math.floor(Math.random() * 1500) + 500;
    user.coins    += reward;
    user.lastDaily = now + COOLDOWNS.daily;
    return m.reply(`🎁 *Daily reclamado!*\n+¥${reward.toLocaleString()} monedas\n> Total: *¥${user.coins.toLocaleString()}*`);
  }

  // ─── WEEKLY ─────────────────────────────────────────────────
  if (['weekly', 'semanal'].includes(command)) {
    if (user.lastWeekly && now < user.lastWeekly) {
      return m.reply(`ꕥ Próximo weekly en *${formatTime(user.lastWeekly - now)}*.`);
    }
    const reward  = Math.floor(Math.random() * 8000) + 5000;
    user.coins     += reward;
    user.lastWeekly = now + COOLDOWNS.weekly;
    return m.reply(`📦 *Weekly reclamado!*\n+¥${reward.toLocaleString()} monedas\n> Total: *¥${user.coins.toLocaleString()}*`);
  }

  // ─── MONTHLY ────────────────────────────────────────────────
  if (['monthly', 'mensual'].includes(command)) {
    if (user.lastMonthly && now < user.lastMonthly) {
      return m.reply(`ꕥ Próximo monthly en *${formatTime(user.lastMonthly - now)}*.`);
    }
    const reward   = Math.floor(Math.random() * 30000) + 20000;
    user.coins      += reward;
    user.lastMonthly = now + COOLDOWNS.monthly;
    return m.reply(`🏆 *Monthly reclamado!*\n+¥${reward.toLocaleString()} monedas\n> Total: *¥${user.coins.toLocaleString()}*`);
  }

  // ─── WORK ───────────────────────────────────────────────────
  if (['work', 'trabajar', 'farm'].includes(command)) {
    if (user.lastWork && now < user.lastWork) {
      return m.reply(`ꕥ Próximo trabajo en *${formatTime(user.lastWork - now)}*.`);
    }
    const reward  = Math.floor(Math.random() * 800) + 200;
    const phrase  = workPhrases[Math.floor(Math.random() * workPhrases.length)];
    user.coins    += reward;
    user.lastWork  = now + COOLDOWNS.work;
    return m.reply(`💼 *${name}* ${phrase} *¥${reward.toLocaleString()}*!\n> Total en cartera: *¥${user.coins.toLocaleString()}*`);
  }

  // ─── GIVECOINS (owner) ──────────────────────────────────────
  if (['givecoins', 'darmonedas'].includes(command)) {
    const target  = m.mentionedJid?.[0] || m.quoted?.sender;
    const amount  = parseInt(args[args.length - 1]);
    if (!target || isNaN(amount) || amount <= 0) {
      return m.reply(`❀ Uso: *${usedPrefix}givecoins @usuario <cantidad>*`);
    }
    if (!global.db.data.users[target]) global.db.data.users[target] = { coins: 0 };
    global.db.data.users[target].coins = (global.db.data.users[target].coins || 0) + amount;
    const tName = global.db.data.users[target]?.name || target.split('@')[0];
    return m.reply(`✅ Se dieron *¥${amount.toLocaleString()}* a *${tName}*.\n> Total: *¥${global.db.data.users[target].coins.toLocaleString()}*`);
  }
};

handler.command = [
  'balance', 'bal', 'monedas', 'coins',
  'deposit', 'depositar',
  'withdraw', 'retirar',
  'daily', 'diario',
  'weekly', 'semanal',
  'monthly', 'mensual',
  'work', 'trabajar', 'farm',
  'givecoins', 'darmonedas',
];
handler.tags = ['gacha', 'farmeo'];
handler.help = [
  'balance — Ver tus monedas',
  'daily — Reclamar recompensa diaria',
  'weekly — Recompensa semanal',
  'monthly — Recompensa mensual',
  'work — Trabajar (cada 4h)',
  'deposit/withdraw <cantidad|all> — Banco',
  'givecoins @user <cantidad> — Dar monedas (owner)',
];

export default handler;
