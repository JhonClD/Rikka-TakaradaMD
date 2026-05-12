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

const getIcon = cat => CAT_ICONS[cat?.toLowerCase()] || '📌';

const handler = async (m, { conn, usedPrefix }) => {
  // --- OBTENCIÓN DE DATOS DE LA DB (ARCHIVOS SET...) ---
  const settings = global.db.data.settings[conn.user.jid] || {};
  
  // Datos configurados via comandos
  const botNameLong = settings.botname || 'ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ'; 
  const botNameShort = settings.namebot || 'Rikka';
  const botLink = settings.link || 'https://api.alyacore.xyz';
  const bannerUrl = settings.banner || global.imagen1 || null;
  const ownerExtra = settings.ownerExtra ? `@${settings.ownerExtra.split('@')[0]}` : 'Oculto por privacidad';

  // Variables de sistema y usuario
  const pushname = m.pushName || 'Usuario';
  const date = moment.tz(CONFIG.timezone).format('DD MMMM YYYY, hh:mm A');
  const uptime = clockString(process.uptime() * 1000);
  const isPremium = global.db?.data?.users[m.sender]?.premium ? '✅' : '❌';
  const totalUsers = Object.keys(global.db.data.users).length;

  // --- LÓGICA DE CATEGORÍAS ---
  const categories = {};
  Object.values(global.plugins || {}).forEach(plugin => {
    if (!plugin?.command) return;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const help = Array.isArray(plugin.help) ? plugin.help : [plugin.help];
    if (!categories[tag]) categories[tag] = [];
    categories[tag].push(...help.filter(Boolean));
  });

  const totalCmds = Object.values(categories).flat().length;

  // --- CONSTRUCCIÓN DEL CUERPO DEL TEXTO ---
  let menuTexto = `¡Hola, buenas tardes i'm — ${botNameShort}! ⸜(｡˃ ᵕ ˂ )⸝♡ Soy ${botNameLong}, un gusto conocerte. Estoy aquí para lo que necesites ♡\n\n`;
  
  menuTexto += `❁ ⑇ ⑈ ⑉ **DEVELOPER** :: ${ownerExtra}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **TIPO** :: Public\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **SISTEMA** :: ${os.platform()}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **TIME** :: ${date}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **USERS** :: ${totalUsers}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **CMDS EJEC** :: ${totalCmds}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **UPTIME** :: ${uptime}\n`;
  menuTexto += `❁ ⑇ ⑈ ⑉ **URL** :: ${botLink}\n\n`;
  
  menuTexto += `${readMore}\n`;

  const sortedCats = Object.keys(categories).sort();
  sortedCats.forEach(cat => {
    const icon = getIcon(cat);
    const title = cat.toUpperCase();
    const cmds = [...new Set(categories[cat])]
      .map(c => `${CONFIG.catBox.cmdPrefix}${usedPrefix}${c}`)
      .join('\n');

    menuTexto += `${CONFIG.catBox.top.replace('{title}', title).replace('{icon}', icon)}\n`;
    menuTexto += `${CONFIG.catBox.mid}\n\n${cmds}\n`;
    menuTexto += `${CONFIG.catBox.bottom}\n\n`;
  });

  menuTexto += `\n${CONFIG.footerText}`;

  // --- ENVÍO CON ADREPLY (DISEÑO DE LA FOTO) ---
  const messageOptions = {
    image: bannerUrl ? { url: bannerUrl } : { url: 'https://via.placeholder.com/1280x720' },
    caption: menuTexto,
    mentions: [m.sender],
    contextInfo: {
      mentionedJid: [m.sender],
      externalAdReply: {
        title: `╰─► ✰ ${botNameLong} ♡`, // Título sobre la imagen
        body: `Alya, ˚₊· ͟͟͞͞➳❥ POWERED BY | — ${botNameShort}`, // Subtítulo
        thumbnailUrl: bannerUrl,
        sourceUrl: botLink, // Enlace dinámico
        mediaType: 1,
        renderLargerThumbnail: true, // Imagen grande como la captura
        showAdAttribution: false
      }
    }
  };

  return await conn.sendMessage(m.chat, messageOptions, { quoted: m });
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
                             
