import moment from 'moment-timezone';
import fs from 'fs';
import path from 'path';

const TIMEZONE = 'America/Lima';

function getTime() {
  return moment.tz(TIMEZONE).format('hh:mm A');
}

function getDate() {
  return moment.tz(TIMEZONE).format('DD/MM/YYYY');
}

function getUptime(since) {
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  return [d && `${d}d`, `${h % 24}h`, `${m % 60}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

function buildCategorySections() {
  const categories = {};
  for (const [name, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin || !plugin.command) continue;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const helps = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
    if (!helps.length) {
      const cmds = plugin.command instanceof RegExp
        ? [plugin.command.source.replace(/[^a-z|]/gi, '').split('|')[0]]
        : Array.isArray(plugin.command)
        ? [plugin.command[0]]
        : [plugin.command];
      helps.push(...cmds);
    }
    if (!categories[tag]) categories[tag] = [];
    categories[tag].push(...helps.filter(Boolean));
  }
  return categories;
}

const CATEGORY_ICONS = {
  descargas: '📥',
  downloads: '📥',
  anime: '🌸',
  buscadores: '🔍',
  search: '🔍',
  ia: '🤖',
  tools: '🛠️',
  herramientas: '🛠️',
  nsfw: '🔞',
  grupos: '👥',
  group: '👥',
  owner: '👑',
  stickers: '🎭',
  fun: '🎉',
  info: 'ℹ️',
  otros: '📌',
};

function getCategoryIcon(cat) {
  return CATEGORY_ICONS[cat.toLowerCase()] || '📌';
}

function buildMenuSection(cat, cmds, prefix) {
  const icon = getCategoryIcon(cat);
  const title = cat.charAt(0).toUpperCase() + cat.slice(1);
  const list = cmds.map(c => `${global.cmenub || '┊✦ '}${prefix}${c}`).join('\n');
  return `${global.cmenut || '❖––––––『'}${icon} *${title}*\n${list}\n${global.cmenuf || '╰━═┅═━––––––๑'}`;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const prefix = usedPrefix || '.';
  const sender = m.sender;
  const senderNum = sender.replace(/@.+/, '');
  const pushname = m.pushName || senderNum;

  const ownerNum = (global.owner?.[0]?.[0] || global.nomorown || '');
  const botName = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const time = getTime();
  const date = getDate();
  const uptime = getUptime(global.botUptime);

  const categories = buildCategorySections();
  const catNames = Object.keys(categories);

  const normalize = (str = '') =>
    str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

  const input = normalize(text?.split(/\s+/)[0] || '');
  const matched = catNames.find(k => normalize(k) === input || normalize(k).startsWith(input));

  if (text && !matched) {
    const available = catNames.join(', ');
    return m.reply(
      `*[ ❓ ] Categoría no encontrada*\n\n` +
      `La categoría *${text}* no existe.\n` +
      `Categorías disponibles: *${available}*\n\n` +
      `> Usa *${prefix}menu [categoría]* para filtrar.\n` +
      `> Ejemplo: *${prefix}menu anime*`
    );
  }

  const header = `
┌─────────────────────┐
│  ✨ *${botName}* ✨
├─────────────────────┤
│ 👤 *Usuario:* ${pushname}
│ 🕐 *Hora:* ${time}
│ 📅 *Fecha:* ${date}
│ ⏱️ *Uptime:* ${uptime}
│ 🤖 *Owner:* +${ownerNum}
│ 🔰 *Prefix:* ${prefix}
└─────────────────────┘
`.trim();

  const footer = `\n${global.cmenua || ''}_Usa_ *${prefix}menu [categoría]* _para filtrar_`;

  let body;
  if (matched) {
    const cmds = categories[matched] || [];
    body = buildMenuSection(matched, cmds, prefix);
  } else {
    const sections = catNames
      .map(cat => buildMenuSection(cat, categories[cat], prefix))
      .join('\n\n');
    body = sections;
  }

  const fullMenu = `${header}\n\n${body}${footer}`;

  const menuImage = global.imagen1 || null;

  if (menuImage) {
    await conn.sendMessage(
      m.chat,
      {
        image: menuImage,
        caption: fullMenu,
        mentions: [sender],
      },
      { quoted: m }
    );
  } else {
    await m.reply(fullMenu);
  }
};

handler.help = ['menu', 'menu [categoría]'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
