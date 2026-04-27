import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

function getUptime(since) {
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return [d && `${d}d`, `${h % 24}h`, `${m % 60}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', descargas: '📥', search: '🔍', buscadores: '🔍',
  tools: '🛠️', herramientas: '🛠️', ai: '🤖', ia: '🤖', sticker: '🎭', stickers: '🎭',
  game: '🎮', games: '🎮', group: '🏯', grupos: '👥', nsfw: '🔞',
  owner: '💎', info: '💫', converter: '🪄', img: '🌸', xp: '🔮',
  random: '⭐', otros: '📌',
};
const getIcon = cat => CAT_ICONS[cat.toLowerCase()] || '📌';

function buildCategories() {
  const cats = {};
  for (const [, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin?.command) continue;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    let cmds = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
    if (!cmds.length) {
      cmds = plugin.command instanceof RegExp
        ? [plugin.command.source.replace(/[^a-z|]/gi, '').split('|')[0]]
        : Array.isArray(plugin.command) ? [plugin.command[0]] : [plugin.command];
    }
    if (!cats[tag]) cats[tag] = [];
    cats[tag].push(...cmds.filter(Boolean));
  }
  return cats;
}

const handler = async (m, { conn, usedPrefix }) => {
  const prefix   = usedPrefix || '.';
  const sender   = m.sender;
  const userNum  = sender.replace(/@.+/, '');
  const pushname = m.pushName || userNum;
  const botName  = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const ownerNum = global.owner?.[0]?.[0] || global.nomorown || '';
  const uptime   = getUptime(global.botUptime);
  const time     = moment.tz(TIMEZONE).format('hh:mm A');
  const date     = moment.tz(TIMEZONE).format('DD/MM/YYYY');

  const categories = buildCategories();
  const totalCmds  = Object.values(categories).flat().length;

  const header =
    `✨ *${botName}* ✨\n` +
    
    `👤 *Usuario:* ${pushname}\n` +
    `🕐 *Hora:* ${time}\n` +
    `📅 *Fecha:* ${date}\n` +
    `⏱️ *Uptime:* ${uptime}\n` +
    `🤖 *Owner:* +${ownerNum}\n` +
    `🔰 *Prefix:* ${prefix}\n` +
    `📋 *Comandos:* ${totalCmds}\n` +
    `𝐑𝐢𝐤𝐤𝐚 𝐓𝐚𝐫𝐚𝐤𝐚𝐫𝐚𝐝𝐚`;

  const body = Object.entries(categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, cmds]) => {
      const icon  = getIcon(cat);
      const title = cat.charAt(0).toUpperCase() + cat.slice(1);
      const list  = cmds.map(c => `┊✦ ${prefix}${c}`).join('\n');
      return `❖––––––『${icon} *${title}*\n${list}\n╰━═┅═━––––––๑`;
    })
    .join('\n\n');

  const footer = `\n_Usa_ *${prefix}menu* _para ver esta lista_`;
  const fullMenu = `${header}\n\n${body}${footer}`;

  const menuImage = global.imagen1 || null;

  if (menuImage) {
    await conn.sendMessage(m.chat, {
      image: menuImage,
      caption: fullMenu,
      mentions: [sender],
    }, { quoted: m });
  } else {
    await m.reply(fullMenu);
  }
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
                 
