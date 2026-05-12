import os from 'os';
import moment from 'moment-timezone';

// ==========================================
//      CONFIGURACIÓN VISUAL (EDITABLE)
// ==========================================
const CONFIG = {
  timezone: 'America/Lima',
  headerEmoji: '🎐',
  lineSeparator: '❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼',
  footerText: '𝘉𝘺 𝘑𝘩𝘰𝘯𝘊𝘐𝘋',
  catBox: {
    top: '┌─────── “ *{title}* {icon} „ ━━━━━━━┓',
    mid: '└➤ ✎~',
    bottom: '┗━━━━━━━━━━━━━━━━━━━━━━━┛',
    cmdPrefix: '── ⟡ ˙ '
  }
};

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', search: '🔍', tools: '🛠️', ai: '🤖', 
  sticker: '🎭', game: '🎮', group: '🏯', nsfw: '🔞', owner: '💎', 
  info: '💫', converter: '🪄', img: '🌸', xp: '🔮', otros: '📌'
};

const more = String.fromCharCode(8206);
const readMore = more.repeat(4001);

function clockString(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${d}d ${h}h ${m}m ${s}s`.replace(/\b(\d)\b/g, '0$1');
}

const handler = async (m, { conn, usedPrefix }) => {
  // --- OBTENCIÓN DE DATOS DINÁMICOS (DATABASE) ---
  const settings = global.db.data.settings[conn.user.jid] || {};
  
  // 1. Nombre dinámico (configurado con setname.js)
  const botName = settings.botname || 'ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ';
  
  // 2. Prefijos dinámicos (configurados con setprefix.js)
  let displayPrefix = usedPrefix;
  if (Array.isArray(settings.prefix)) displayPrefix = settings.prefix.join(' ');
  if (settings.prefix === true) displayPrefix = 'Sin prefijo';

  // 3. Banner dinámico (configurado con setbanner.js)
  const menuImage = settings.banner || global.imagen1 || null;

  // 4. Link dinámico (configurado con setlink.js)
  const botLink = settings.link || 'https://github.com/JhonCID';

  const pushname = m.pushName || 'Usuario';
  const date = moment.tz(CONFIG.timezone).format('YYYY-MM-DD');
  const uptime = clockString(process.uptime() * 1000);
  const isPremium = global.db?.data?.users[m.sender]?.premium ? '✅' : '❌';

  // Construcción de categorías
  const categories = {};
  Object.values(global.plugins || {}).forEach(plugin => {
    if (!plugin?.command) return;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const help = Array.isArray(plugin.help) ? plugin.help : [plugin.help];
    if (!categories[tag]) categories[tag] = [];
    categories[tag].push(...help.filter(Boolean));
  });

  const totalCmds = Object.values(categories).flat().length;

  // --- CONSTRUCCIÓN DEL TEXTO ---
  let menu = `━━━━━❒「 \`${botName}\` 」⋆｡ﾟ${CONFIG.headerEmoji}\n\n`;
  menu += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  menu += ` ୨୧     ꒰ \`Premium\`   :  ${isPremium}\n`;
  menu += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  menu += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  menu += ` ୨୧     ꒰ \`Prefix\`    :  ${displayPrefix}\n`;
  menu += ` ୨୧     ꒰ \`Comandos\`  :  ${totalCmds}\n`;
  menu += ` ୨୧     ꒰ \`Enlace\`    :  ${botLink}\n\n`;
  menu += `${CONFIG.lineSeparator}\n${readMore}\n`;

  const sortedCats = Object.keys(categories).sort();
  sortedCats.forEach(cat => {
    const icon = CAT_ICONS[cat.toLowerCase()] || '📌';
    const title = cat.toUpperCase();
    const cmds = [...new Set(categories[cat])]
      .map(c => `${CONFIG.catBox.cmdPrefix}${usedPrefix}${c}`)
      .join('\n');

    menu += `${CONFIG.catBox.top.replace('{title}', title).replace('{icon}', icon)}\n`;
    menu += `${CONFIG.catBox.mid}\n\n${cmds}\n`;
    menu += `${CONFIG.catBox.bottom}\n\n`;
  });

  menu += CONFIG.footerText;

  // --- ENVÍO CON BANNER DINÁMICO ---
  if (menuImage) {
    await conn.sendMessage(m.chat, { 
      image: { url: menuImage }, 
      caption: menu, 
      mentions: [m.sender] 
    }, { quoted: m });
  } else {
    await m.reply(menu);
  }
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
                  
