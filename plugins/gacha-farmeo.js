// gacha-farmeo.js — Farmeo de monedas (daily, work, balance)
// USA los campos reales del handler de Rikka-TakaradaMD:
//   monedas → user.coin   banco → user.atm
//   cooldowns → user.lastclaim / user.lastweekly / user.lastmonthly / user.lastwork

const COOLDOWNS = {
  daily:   24 * 60 * 60 * 1000,
  weekly:  7  * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  work:    4  * 60 * 60 * 1000,
};

function formatTime(ms) {
  if (ms <= 0) return 'Disponible';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m2 = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = [];
  if (h)      p.push(h + 'h');
  if (m2 || h) p.push(m2 + 'm');
  p.push(sec + 's');
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
  // Campos exactos del schema del handler de Rikka
  if (typeof user.coin !== 'number') user.coin = 0;
  if (typeof user.atm  !== 'number') user.atm  = 0;
  const name = user.name || m.sender.split('@')[0];
  const now  = Date.now();

  if (['balance', 'bal', 'monedas', 'coins'].includes(command)) {
    return m.reply(
      '˗ˏˋ *Balance — ' + name + '* ˎˊ-\n\n' +
      '⇢ Cartera ➤ *¥' + user.coin.toLocaleString() + '*\n' +
      '⇢ Banco   ➤ *¥' + user.atm.toLocaleString()  + '*\n' +
      '⇢ Total   ➤ *¥' + (user.coin + user.atm).toLocaleString() + '*'
    );
  }

  if (['deposit', 'depositar'].includes(command)) {
    const amount = args[0] === 'all' ? user.coin : parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return m.reply('⸙͎ Uso: *' + usedPrefix + 'deposit <cantidad|all>*');
    if (amount > user.coin) return m.reply('↳ ✗ Monedas insuficientes. Tienes *¥' + user.coin.toLocaleString() + '*');
    user.coin -= amount;
    user.atm  += amount;
    return m.reply('✩ Depositaste *¥' + amount.toLocaleString() + '* al banco ❁\n↳ Banco: *¥' + user.atm.toLocaleString() + '*');
  }

  if (['withdraw', 'retirar'].includes(command)) {
    const amount = args[0] === 'all' ? user.atm : parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return m.reply('⸙͎ Uso: *' + usedPrefix + 'withdraw <cantidad|all>*');
    if (amount > user.atm) return m.reply('↳ ✗ Solo tienes *¥' + user.atm.toLocaleString() + '* en el banco.');
    user.atm  -= amount;
    user.coin += amount;
    return m.reply('✩ Retiraste *¥' + amount.toLocaleString() + '* del banco ❁\n↳ Cartera: *¥' + user.coin.toLocaleString() + '*');
  }

  if (['daily', 'diario'].includes(command)) {
    const last = user.lastclaim || 0;
    if (last && now < last + COOLDOWNS.daily) {
      return m.reply('⇢ ʚ Próximo daily en *' + formatTime((last + COOLDOWNS.daily) - now) + '* ɞ');
    }
    const reward = Math.floor(Math.random() * 1500) + 500;
    user.coin     += reward;
    user.lastclaim = now;
    return m.reply('✩ *Daily reclamado* ❁\n⇢ +¥' + reward.toLocaleString() + ' monedas\n↳ Total: *¥' + user.coin.toLocaleString() + '*');
  }

  if (['weekly', 'semanal'].includes(command)) {
    const last = user.lastweekly || 0;
    if (last && now < last + COOLDOWNS.weekly) {
      return m.reply('⇢ ʚ Próximo weekly en *' + formatTime((last + COOLDOWNS.weekly) - now) + '* ɞ');
    }
    const reward    = Math.floor(Math.random() * 8000) + 5000;
    user.coin       += reward;
    user.lastweekly  = now;
    return m.reply('✩ *Weekly reclamado* ❁\n⇢ +¥' + reward.toLocaleString() + ' monedas\n↳ Total: *¥' + user.coin.toLocaleString() + '*');
  }

  if (['monthly', 'mensual'].includes(command)) {
    const last = user.lastmonthly || 0;
    if (last && now < last + COOLDOWNS.monthly) {
      return m.reply('⇢ ʚ Próximo monthly en *' + formatTime((last + COOLDOWNS.monthly) - now) + '* ɞ');
    }
    const reward     = Math.floor(Math.random() * 30000) + 20000;
    user.coin        += reward;
    user.lastmonthly  = now;
    return m.reply('✩ *Monthly reclamado* ❁\n⇢ +¥' + reward.toLocaleString() + ' monedas\n↳ Total: *¥' + user.coin.toLocaleString() + '*');
  }

  if (['work', 'trabajar', 'farm'].includes(command)) {
    const last = user.lastwork || 0;
    if (last && now < last + COOLDOWNS.work) {
      return m.reply('⇢ ʚ Próximo trabajo en *' + formatTime((last + COOLDOWNS.work) - now) + '* ɞ');
    }
    const reward  = Math.floor(Math.random() * 800) + 200;
    const phrase  = workPhrases[Math.floor(Math.random() * workPhrases.length)];
    user.coin    += reward;
    user.lastwork = now;
    return m.reply('✩ *' + name + '* ' + phrase + ' *¥' + reward.toLocaleString() + '* ❁\n↳ Cartera: *¥' + user.coin.toLocaleString() + '*');
  }

  if (['givecoins', 'darmonedas'].includes(command)) {
    const target = (m.mentionedJid && m.mentionedJid[0]) ? m.mentionedJid[0] : (m.quoted ? m.quoted.sender : null);
    const amount = parseInt(args[args.length - 1]);
    if (!target || isNaN(amount) || amount <= 0) {
      return m.reply('⸙͎ Uso: *' + usedPrefix + 'givecoins @usuario <cantidad>*');
    }
    if (!global.db.data.users[target]) global.db.data.users[target] = { coin: 0 };
    if (typeof global.db.data.users[target].coin !== 'number') global.db.data.users[target].coin = 0;
    global.db.data.users[target].coin += amount;
    const tName = global.db.data.users[target].name || target.split('@')[0];
    return m.reply('✩ Se dieron *¥' + amount.toLocaleString() + '* a *' + tName + '* ❁\n↳ Total: *¥' + global.db.data.users[target].coin.toLocaleString() + '*');
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
