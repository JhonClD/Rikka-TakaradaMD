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
  return `${d}d ${h}h ${m}m`.replace(/\b(\d)\b/g, '0$1');
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

const handler = async (m, { conn, usedPrefix, args }) => {
  const prefix    = usedPrefix || '.';
  const input     = args[0]?.toLowerCase();
  const pushname  = m.pushName || 'Usuario';
  const date      = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  const uptime    = clockString(process.uptime() * 1000);
  
  const categories = buildCategories();
  const availableTags = Object.keys(categories).sort();

  // --- CABECERA COMÚN ---
  let header = `━━━━━❒「 \`ᖇɩƙƙᥲ Ʈᥲɾᥲƙᥲɾᥲᑯᥲ°ᙖOƮ\` 」⋆｡ﾟ🎐\n\n`;
  header += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  header += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  header += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  header += ` ୨୧     ꒰ \`Prefix\`    :  ${prefix}\n\n`;
  header += `❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼\n\n`;

  let content = '';

  // 1. SI NO HAY ARGUMENTOS: MOSTRAR SOLO LISTA DE CATEGORÍAS
  if (!input) {
    content = `✨ *LISTA DE CATEGORÍAS* ✨\n\n`;
    availableTags.forEach(tag => {
      const icon = getIcon(tag);
      content += `── ⟡ ˙ ${icon} *${prefix}menu ${tag}* ̟\n`;
    });
    content += `\n── ⟡ ˙ 📂 *${prefix}menu all* (Ver todo) ̟\n`;
    content += `\n_Escribe un comando de la lista para ver sus funciones._`;
  } 
  
  // 2. SI PIDE "ALL": MOSTRAR TODO EL CUERPO
  else if (input === 'all') {
    content = readMore + Object.entries(categories)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, cmds]) => {
        const icon = getIcon(cat);
        const list = [...new Set(cmds)].map(c => `── ⟡ ˙ ${prefix}${c} ̟`).join('\n');
        return `┌─────── “ *${cat.toUpperCase()}* ${icon} „ ━━━━━━━┓\n\n${list}\n┗━━━━━━━━━━━━━━━━━━━━━━━┛`;
      }).join('\n\n');
  }

  // 3. SI PIDE UNA CATEGORÍA ESPECÍFICA
  else if (availableTags.includes(input)) {
    const icon = getIcon(input);
    const list = [...new Set(categories[input])].map(c => `── ⟡ ˙ ${prefix}${c} ̟`).join('\n');
    content = `┌─────── “ *${input.toUpperCase()}* ${icon} „ ━━━━━━━┓\n\n${list}\n┗━━━━━━━━━━━━━━━━━━━━━━━┛`;
  }

  // 4. CATEGORÍA NO ENCONTRADA
  else {
    return m.reply(`❌ La categoría *"${input}"* no existe.\nUsa *${prefix}menu* para ver las disponibles.`);
  }

  const fullMenu = header + content;
  const menuImage = global.imagen1 || null;

  if (menuImage) {
    await conn.sendMessage(m.chat, { image: menuImage, caption: fullMenu }, { quoted: m });
  } else {
    await m.reply(fullMenu);
  }
};

handler.help    = ['menu'];
handler.tags    = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
