import os from 'os';
import moment from 'moment-timezone';

// ==========================================
//      CONFIGURACIÓN VISUAL (TUS SÍMBOLOS)
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
  anime: '🎐', downloader: '📥', descargas: '📥', search: '🔍', buscadores: '🔍',
  tools: '🛠️', herramientas: '🛠️', ai: '🤖', ia: '🤖', sticker: '🎭', stickers: '🎭',
  game: '🎮', games: '🎮', group: '🏯', grupos: '👥', nsfw: '🔞',
  owner: '💎', info: '💫', converter: '🪄', img: '🌸', xp: '🔮',
  random: '⭐', otros: '📌',
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
  // --- DATOS DINÁMICOS DESDE TU BASE DE DATOS ---
  const settings = global.db.data.settings[conn.user.jid] || {};
  
  const botNameLong = settings.botname || 'ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ'; 
  const botNameShort = settings.namebot || 'Rikka';
  const botLink = settings.link || 'https://github.com/JhonCID';
  const bannerUrl = settings.banner || global.imagen1 || null;

  const pushname = m.pushName || 'Usuario';
  const date = moment.tz(CONFIG.timezone).format('YYYY-MM-DD');
  const uptime = clockString(process.uptime() * 1000);
  const isPremium = global.db?.data?.users[m.sender]?.premium ? '✅' : '❌';

  // Lógica de categorías
  const categories = {};
  Object.values(global.plugins || {}).forEach(plugin => {
    if (!plugin?.command) return;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const help = Array.isArray(plugin.help) ? plugin.help : [plugin.help];
    if (!categories[tag]) categories[tag] = [];
    categories[tag].push(...help.filter(Boolean));
  });

  const totalCmds = Object.values(categories).flat().length;

  // --- CABECERA (TU ESTILO ORIGINAL) ---
  let menuTexto = `━━━━━❒「 \`${botNameLong}\` 」⋆｡ﾟ${CONFIG.headerEmoji}\n\n`;
  menuTexto += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  menuTexto += ` ୨୧     ꒰ \`Premium\`   :  ${isPremium}\n`;
  menuTexto += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  menuTexto += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  menuTexto += ` ୨୧     ꒰ \`Prefix\`    :  ${usedPrefix}\n`;
  menuTexto += ` ୨୧     ꒰ \`Comandos\`  :  ${totalCmds}\n\n`;
  menuTexto += `${CONFIG.lineSeparator}\n`;
  
  menuTexto += `${readMore}\n`;

  // --- CUERPO ---
  const sortedCats = Object.keys(categories).sort();
  sortedCats.forEach(cat => {
    const icon = CAT_ICONS[cat.toLowerCase()] || '📌';
    const title = cat.toUpperCase();
    const cmds = [...new Set(categories[cat])]
      .map(c => `${CONFIG.catBox.cmdPrefix}${usedPrefix}${c} ̟`)
      .join('\n');

    menuTexto += `${CONFIG.catBox.top.replace('{title}', title).replace('{icon}', icon)}\n`;
    menuTexto += `${CONFIG.catBox.mid}\n\n${cmds}\n`;
    menuTexto += `${CONFIG.catBox.bottom}\n\n`;
  });

  menuTexto += `\n${CONFIG.footerText}`;

  // --- MENSAJE CON BANNER Y ADREPLY ---
  const messageOptions = {
    image: bannerUrl ? { url: bannerUrl } : { url: 'https://uguu.se/default.jpg' },
    caption: menuTexto,
    mentions: [m.sender],
    contextInfo: {
      mentionedJid: [m.sender],
      externalAdReply: {
        title: `╰─► ✰ ${botNameLong} ♡`,
        body: `Alya, ˚₊· ͟͟͞͞➳❥ POWERED BY | — ${botNameShort}`,
        thumbnailUrl: bannerUrl,
        sourceUrl: botLink,
        mediaType: 1,
        renderLargerThumbnail: true,
        showAdAttribution: false
      }
    }
  };

  await conn.sendMessage(m.chat, messageOptions, { quoted: m });
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
    
