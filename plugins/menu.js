import os from 'os';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

// Formato detallado: 00d 00h 00m
function clockString(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  return `${d}d ${h}h ${m}m`.replace(/\b(\d)\b/g, '0$1'); 
}

function getOSName() {
  const p = os.platform();
  const release = os.release().split('-')[0];
  if (p === 'android' || process.env.PREFIX?.includes('com.termux')) return 'Android 🤖';
  if (p === 'linux')  return 'Linux 🐧';
  if (p === 'win32')  return 'Windows 🪟';
  if (p === 'darwin') return 'macOS 🍎';
  if (p === 'freebsd') return `FreeBSD ${release} 😈`;
  return p;
}

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', search: '🔍', tools: '🛠️', 
  ai: '🤖', sticker: '🎭', game: '🎮', group: '🏯', 
  nsfw: '🔞', owner: '💎', info: '💫', xp: '🔮'
};

const getIcon = cat => CAT_ICONS[cat?.toLowerCase()] || '📌';

const handler = async (m, { conn, usedPrefix }) => {
  const prefix    = usedPrefix || '.';
  const sender    = m.sender;
  const pushname  = m.pushName || 'Usuario';
  const ownerNum  = global.owner?.[0]?.[0] || 'Sin definir';
  const date      = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  
  // Datos del sistema
  const uptime    = clockString(process.uptime() * 1000);
  const osName    = getOSName();
  const isPremium = global.db.data.users[m.sender]?.premium ? '✅' : '❌';

  // Construcción de categorías
  const cats = {};
  Object.values(global.plugins).forEach(p => {
    if (!p?.command) return;
    const tag = (Array.isArray(p.tags) ? p.tags[0] : p.tags) || 'otros';
    let cmds = Array.isArray(p.help) ? p.help : [p.help];
    if (!cats[tag]) cats[tag] = [];
    cats[tag].push(...cmds.filter(Boolean));
  });

  const totalCmds = Object.values(cats).flat().length;

  // Header con estilo solicitado
  let header = `━━━━━❒「 \`ᖇɩƙƙᥲ Ʈᥲɾᥲƙᥲɾᥲᑯᥲ°ᙖOƮ\` 」⋆｡ﾟ🎐\n\n`;
  header += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  header += ` ୨୧     ꒰ \`Premium\`   :  ${isPremium}\n`;
  header += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  header += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  header += ` ୨୧     ꒰ \`Sistema\`   :  ${osName}\n`;
  header += ` ୨୧     ꒰ \`Owner\`     :  @${ownerNum}\n`;
  header += ` ୨୧     ꒰ \`Prefix\`    :  ${prefix}\n`;
  header += ` ୨୧     ꒰ \`Comandos\`  :  ${totalCmds}\n\n`;
  header += `❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼\n\n`;

  const body = Object.entries(cats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, cmds]) => {
      const icon  = getIcon(cat);
      const title = cat.toUpperCase();
      const list  = [...new Set(cmds)].map(c => `  ┊✦ ${prefix}${c}`).join('\n');
      return `❖──『 ${icon} *${title}* 』\n${list}\n╰━═┅═━––––––๑`;
    })
    .join('\n\n');

  const fullMenu = header + body;

  if (global.imagen1) {
    await conn.sendMessage(m.chat, { image: global.imagen1, caption: fullMenu }, { quoted: m });
  } else {
    await m.reply(fullMenu);
  }
};

handler.help    = ['menu'];
handler.tags    = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
