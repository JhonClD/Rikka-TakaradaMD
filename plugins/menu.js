import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

function getUptime(since) {
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  return [
    d && `${d}d`,
    `${h % 24}h`,
    `${m % 60}m`,
    `${s % 60}s`
  ].filter(Boolean).join(' ');
}

const CAT_ICONS = {
  anime: '🎐',
  downloader: '📥',
  descargas: '📥',
  search: '🔍',
  buscadores: '🔎',
  tools: '🛠️',
  herramientas: '🧰',
  ai: '🤖',
  ia: '🧠',
  sticker: '🎭',
  stickers: '🪄',
  game: '🎮',
  games: '🕹️',
  group: '🏯',
  grupos: '👥',
  nsfw: '🔞',
  owner: '👑',
  info: '💫',
  converter: '⚗️',
  img: '🖼️',
  xp: '🔮',
  random: '🌟',
  music: '🎵',
  audio: '🎧',
  fun: '🎉',
  otros: '📌',
};

const getIcon = cat => CAT_ICONS[cat.toLowerCase()] || '📌';

function buildCategories() {
  const cats = {};

  for (const [, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin?.command) continue;

    const tag = (
      Array.isArray(plugin.tags)
        ? plugin.tags[0]
        : plugin.tags
    ) || 'otros';

    let cmds = Array.isArray(plugin.help)
      ? plugin.help
      : (plugin.help ? [plugin.help] : []);

    if (!cmds.length) {
      cmds = plugin.command instanceof RegExp
        ? [plugin.command.source.replace(/[^a-z|]/gi, '').split('|')[0]]
        : Array.isArray(plugin.command)
          ? [plugin.command[0]]
          : [plugin.command];
    }

    if (!cats[tag]) cats[tag] = [];

    cats[tag].push(...cmds.filter(Boolean));
  }

  return cats;
}

const handler = async (m, { conn, usedPrefix }) => {

  const prefix = usedPrefix || '.';

  const sender = m.sender;
  const userNum = sender.replace(/@.+/, '');
  const pushname = m.pushName || 'Usuario';

  const botName = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const ownerNum = global.owner?.[0]?.[0] || global.nomorown || 'Desconocido';

  const uptime = getUptime(global.botUptime);

  const time = moment.tz(TIMEZONE).format('hh:mm:ss A');
  const date = moment.tz(TIMEZONE).format('DD/MM/YYYY');

  const categories = buildCategories();
  const totalCmds = Object.values(categories).flat().length;

  const header = `
╭━━━〔 🌸 ${botName} 🌸 〕━━━⬣
┃ ✦ Hola, @${userNum}
┃
┃ 👤 Usuario: ${pushname}
┃ ⏰ Hora: ${time}
┃ 📅 Fecha: ${date}
┃ ⚡ Uptime: ${uptime}
┃ 👑 Owner: +${ownerNum}
┃ 🔰 Prefix: ${prefix}
┃ 📚 Comandos: ${totalCmds}
╰━━━━━━━━━━━━━━━━⬣`;

  const body = Object.entries(categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, cmds]) => {

      const icon = getIcon(cat);

      const title =
        cat.charAt(0).toUpperCase() +
        cat.slice(1);

      const list = cmds
        .map(cmd => `┃ ✧ ${prefix}${cmd}`)
        .join('\n');

      return `
╭─❖「 ${icon} ${title} 」
${list}
╰────────────⬣`;

    }).join('\n');

  const footer = `
╭━━━━━━━━━━━━━━━━⬣
┃ 🌺 Kana Arima - MD
┃ 💫 Multi Device WhatsApp Bot
┃ 🚀 Usa ${prefix}menu para ver el menú
╰━━━━━━━━━━━━━━━━⬣`;

  const fullMenu = `${header}\n${body}\n${footer}`;

  const menuImage = global.imagen1 || null;

  if (menuImage) {
    await conn.sendMessage(
      m.chat,
      {
        image: menuImage,
        caption: fullMenu,
        mentions: [sender]
      },
      { quoted: m }
    );
  } else {
    await m.reply(fullMenu);
  }
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|help|ayuda|start|comandos)$/i;

export default handler;
