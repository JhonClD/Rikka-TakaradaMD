// menu.js — Rikka-TakaradaMD
import os from 'os';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

function getBotUptime(conn) {
  const since = conn?.uptime || global.botUptime;
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  return [d && `${d}d`, h % 24 && `${h % 24}h`, `${m % 60}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

function getOSName() {
  const p = os.platform();
  if (p === 'android' || process.env.PREFIX?.includes('com.termux')) return 'Android 🤖';
  if (p === 'linux')  return 'Linux 🐧';
  if (p === 'win32')  return 'Windows 🪟';
  if (p === 'darwin') return 'macOS 🍎';
  return p;
}

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', descargas: '📥', search: '🔍', buscadores: '🔍',
  tools: '🛠️', herramientas: '🛠️', ai: '🤖', ia: '🤖', sticker: '🎭', stickers: '🎭',
  game: '🎮', games: '🎮', group: '🏯', grupos: '👥', nsfw: '🔞',
  owner: '💎', info: '💫', converter: '🪄', img: '🌸', xp: '🔮',
  random: '⭐', otros: '📌',
};
const getIcon = cat => CAT_ICONS[cat?.toLowerCase()] || '📌';

function buildCategories() {
  const cats = {};
  for (const [, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin?.command) continue;
    const tag  = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    let cmds   = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
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
  const prefix    = usedPrefix || '.';
  const sender    = m.sender;
  const pushname  = m.pushName || sender.replace(/@.+/, '');
  const ownerNum  = global.owner?.[0]?.[0] || '';
  const date      = moment.tz(TIMEZONE).format('DD/MM/YYYY');
  const uptime    = getBotUptime(conn);
  const osName    = getOSName();
  const categories = buildCategories();
  const totalCmds = Object.values(categories).flat().length;

  // Integrantes solo en grupo
  let membersLine = '';
  if (m.isGroup) {
    const meta    = await conn.groupMetadata(m.chat).catch(() => null);
    const count   = meta?.participants?.length || '?';
    membersLine = `│ 👥 *Integrantes:* ${count}\n`;
  }

  const header = [
    `🌸✨ *𝙍𝙞𝙠𝙠𝙖 𝙏𝙖𝙧𝙖𝙠𝙖𝙧𝙖𝙙𝙖* ✨🌸`,
    ``,
    `┌──────────────────`,
    `│ 🏷️  *Nombre:* ${pushname}`,
    `│ ⏱️  *Uptime:* ${uptime}`,
    `│ 📅 *Fecha:* ${date}`,
    membersLine.trimEnd(),
    `│ 🖥️  *Sistema:* ${osName}`,
    `│ 👑 *Owner:* +${ownerNum}`,
    `│ 🔰 *Prefix:* ${prefix}`,
    `│ 📋 *Comandos:* ${totalCmds}`,
    `└──────────────────`,
  ].filter(l => l !== '').join('\n');

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
    await conn.sendMessage(m.chat, { image: menuImage, caption: fullMenu, mentions: [sender] }, { quoted: m });
  } else {
    await m.reply(fullMenu);
  }
};

handler.help    = ['menu'];
handler.tags    = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
