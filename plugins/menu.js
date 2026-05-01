// menu.js — KanaArima-MD / Rikka-TakaradaMD
import os from 'os';
import moment from 'moment-timezone';
import { xpRange, findLevel } from '../src/libraries/levelling.js';

const TIMEZONE = 'America/Lima';

// ── Uptime del bot (conn.uptime lo guarda handler.js como this.uptime) ────────
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

// ── Sistema operativo y RAM ───────────────────────────────────────────────────
function getSystemInfo() {
  const platform = os.platform();
  const release  = os.release();

  let osName;
  if (platform === 'android' || process.env.PREFIX?.includes('com.termux')) osName = `Android ${release}`;
  else if (platform === 'linux')  osName = `Linux ${release}`;
  else if (platform === 'win32')  osName = `Windows ${release}`;
  else if (platform === 'darwin') osName = `macOS ${release}`;
  else osName = `${platform} ${release}`;

  const ramTotal = os.totalmem();
  const ramUsed  = ramTotal - os.freemem();
  const ramPct   = Math.round((ramUsed / ramTotal) * 100);
  const ramStr   = `${(ramUsed / 1_073_741_824).toFixed(1)}/${(ramTotal / 1_073_741_824).toFixed(1)} GiB`;
  const ramBar   = buildBar(ramPct, 8);

  return { osName, ramStr, ramPct, ramBar };
}

// ── Nivel / XP / Rol del usuario ──────────────────────────────────────────────
function getUserStats(sender, { isOwner, isROwner, isMods, isPrems }) {
  const userData = global.db?.data?.users?.[sender] || {};
  const xp       = userData.exp || 0;
  const level    = findLevel(xp);
  const range    = xpRange(level);
  const nextXP   = range.max;
  const currXP   = xp - xpRange(level > 0 ? level - 1 : 0).max;
  const neededXP = nextXP - (xpRange(level > 0 ? level - 1 : 0).max);
  const pct      = neededXP > 0 ? Math.min(100, Math.round((currXP / neededXP) * 100)) : 100;
  const xpBar    = buildBar(pct, 10);

  // Rol con jerarquía
  let rol, rolEmoji;
  if (isROwner || isOwner) { rol = 'Owner';   rolEmoji = '👑'; }
  else if (isMods)          { rol = 'Mod';     rolEmoji = '🛡️'; }
  else if (isPrems)         { rol = 'Premium'; rolEmoji = '💎'; }
  else                      { rol = 'Usuario'; rolEmoji = '👤'; }

  // Título según nivel
  let titulo;
  if      (level >= 100) titulo = '🌌 Leyenda';
  else if (level >= 75)  titulo = '🔥 Maestro';
  else if (level >= 50)  titulo = '⚡ Experto';
  else if (level >= 30)  titulo = '🌟 Avanzado';
  else if (level >= 15)  titulo = '📗 Intermedio';
  else if (level >= 5)   titulo = '🌱 Aprendiz';
  else                   titulo = '🐣 Novato';

  return { level, xp, pct, xpBar, nextXP, rol, rolEmoji, titulo };
}

// ── Barra visual ──────────────────────────────────────────────────────────────
function buildBar(pct, len = 10) {
  const filled = Math.round((pct / 100) * len);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}

// ── Categorías de comandos ────────────────────────────────────────────────────
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

// ── Handler ───────────────────────────────────────────────────────────────────
const handler = async (m, { conn, usedPrefix, isOwner, isROwner, isMods, isPrems }) => {
  const prefix   = usedPrefix || '.';
  const sender   = m.sender;
  const pushname = m.pushName || sender.replace(/@.+/, '');
  const botName  = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const ownerNum = global.owner?.[0]?.[0] || '';
  const time     = moment.tz(TIMEZONE).format('hh:mm A');
  const date     = moment.tz(TIMEZONE).format('DD/MM/YYYY');

  // Datos
  const uptime        = getBotUptime(conn);
  const sys           = getSystemInfo();
  const user          = getUserStats(sender, { isOwner, isROwner, isMods, isPrems });
  const categories    = buildCategories();
  const totalCmds     = Object.values(categories).flat().length;

  // ── Bloque header ──────────────────────────────────────────────────────────
  const header = [
    `✨ *${botName}* ✨`,
    ``,
    `┌─── 👤 *USUARIO* ───`,
    `│ ${user.rolEmoji} *Rol:* ${user.rol}`,
    `│ 🏷️  *Nombre:* ${pushname}`,
    `│ 🎖️  *Rango:* ${user.titulo}`,
    `│ 🔮 *Nivel:* ${user.level}`,
    `│ ✨ *XP:* ${user.xp} / ${user.nextXP}`,
    `│ ${user.xpBar} ${user.pct}%`,
    `│`,
    `├─── 🤖 *BOT* ───`,
    `│ ⏱️  *Uptime:* ${uptime}`,
    `│ 🖥️  *Sistema:* ${sys.osName}`,
    `│ 🧠 *RAM:* ${sys.ramStr} (${sys.ramPct}%)`,
    `│ ${sys.ramBar}`,
    `│`,
    `├─── ℹ️  *INFO* ───`,
    `│ 🕐 *Hora:* ${time}`,
    `│ 📅 *Fecha:* ${date}`,
    `│ 👑 *Owner:* +${ownerNum}`,
    `│ 🔰 *Prefix:* ${prefix}`,
    `│ 📋 *Comandos:* ${totalCmds}`,
    `└──────────────────`,
  ].join('\n');

  // ── Bloque categorías ──────────────────────────────────────────────────────
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

handler.help    = ['menu'];
handler.tags    = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
    
