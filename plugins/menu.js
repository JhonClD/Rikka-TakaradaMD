import os from 'os';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

// Carácter especial para el "Leer más"
const more = String.fromCharCode(8206);
const readMore = more.repeat(4001);

function clockString(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${d}d ${h}h ${m}m ${s}s`.replace(/\b(\d)\b/g, '0$1');
}

function getOSName() {
  const p = os.platform();
  if (p === 'android' || process.env.PREFIX?.includes('com.termux')) return 'Android 🤖';
  if (p === 'linux')  return 'Linux 🐧';
  if (p === 'win32')  return 'Windows 🪟';
  if (p === 'darwin') return 'macOS 🍎';
  if (p === 'freebsd') return 'FreeBSD 😈';
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
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    let cmds = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
    if (!cats[tag]) cats[tag] = [];
    cats[tag].push(...cmds.filter(Boolean));
  }
  return cats;
}

const handler = async (m, { conn, usedPrefix }) => {
  const prefix    = usedPrefix || '.';
  const sender    = m.sender;
  const pushname  = m.pushName || 'Usuario';
  const ownerNum  = global.owner?.[0]?.[0] || 'Sin definir';
  const date      = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  const uptime    = clockString(process.uptime() * 1000);
  const osName    = getOSName();
  const isPremium = global.db?.data?.users[m.sender]?.premium ? '✅' : '❌';
  
  const categories = buildCategories();
  const totalCmds  = Object.values(categories).flat().length;

  // --- CABECERA ---
  let header = `━━━━━❒「 \`ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ\` 」⋆｡ﾟ🎐\n\n`;
  header += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  header += ` ୨୧     ꒰ \`Premium\`   :  ${isPremium}\n`;
  header += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  header += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  header += ` ୨୧     ꒰ \`Sistema\`   :  ${osName}\n`;
  header += ` ୨୧     ꒰ \`Owner\`     :  @${ownerNum}\n`;
  header += ` ୨୧     ꒰ \`Prefix\`    :  ${prefix}\n`;
  header += ` ୨୧     ꒰ \`Comandos\`  :  ${totalCmds}\n\n`;
  header += `❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼\n`;
  
  // AQUÍ SE INSERTA EL "LEER MÁS"
  header += `${readMore}\n`;

  // --- CUERPO ---
  const body = Object.entries(categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, cmds]) => {
      const icon  = getIcon(cat);
      const title = cat.toUpperCase();
      const list  = [...new Set(cmds)]
        .map(c => `── ⟡ ˙ ${prefix}${c} ̟`)
        .join('\n');

      return `┌─────── “ *${title}* ${icon} „ ━━━━━━━┓ \n└➤ ✎~\n\n${list}\n┗━━━━━━━━━━━━━━━━━━━━━━━┛`;
    })
    .join('\n\n');

  const footer = `\n\n𝘉𝘺 𝘑𝘩𝘰𝘯𝘊𝘐𝘋`;
  const fullMenu = header + body + footer;

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
