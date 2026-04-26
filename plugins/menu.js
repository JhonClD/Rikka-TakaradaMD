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

function getWeekday() {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return days[moment.tz(TIMEZONE).day()];
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

function buildCategoryMap() {
  const categories = {};
  for (const [, plugin] of Object.entries(global.plugins || {})) {
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

// Iconos y nombres bonitos de categorías (del es.json del bot)
const CAT_DISPLAY = {
  info:       { icon: '𓍢ִ໋☕️✧', label: 'INFORMACIÓN' },
  tools:      { icon: '🛠️',       label: 'HERRAMIENTAS' },
  search:     { icon: '🔍',       label: 'BÚSQUEDAS' },
  downloader: { icon: '📥',       label: 'DESCARGAS' },
  converter:  { icon: '🪄',       label: 'CONVERTIDORES' },
  effects:    { icon: '🎧',       label: 'EFECTOS DE AUDIO' },
  game:       { icon: '🧩',       label: 'JUEGOS' },
  group:      { icon: '🏯',       label: 'GRUPOS' },
  nsfw:       { icon: '🔞',       label: 'ADULTOS' },
  owner:      { icon: '💎',       label: 'PROPIETARIOS' },
  sticker:    { icon: '🎭',       label: 'STICKERS' },
  img:        { icon: '🌸',       label: 'IMÁGENES' },
  ai:         { icon: '🤖',       label: 'IA' },
  internet:   { icon: '☁️',       label: 'INTERNET' },
  maker:      { icon: '👑',       label: 'CREADOR' },
  anime:      { icon: '🎐',       label: 'ANIME' },
  xp:         { icon: '🔮',       label: 'XP / ECONOMÍA' },
  random:     { icon: '⭐',       label: 'ALEATORIO' },
  otros:      { icon: '📌',       label: 'OTROS' },
};

function getCatDisplay(cat) {
  return CAT_DISPLAY[cat.toLowerCase()] || { icon: '📌', label: cat.toUpperCase() };
}

function normalize(str = '') {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
}

// Construye el texto de una categoría para mandar como detalle
function buildCategoryDetail(cat, cmds, prefix) {
  const { icon, label } = getCatDisplay(cat);
  const list = cmds.map(c => `╰┈➤ □ ${prefix}${c}`).join('\n');
  return (
    `✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n` +
    `⪼ ꒰ ${icon} *${label}* ꒱\n` +
    `✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n\n` +
    `${list}\n\n` +
    `｡ ﾟ ꒰ঌ ✦໒꒱ ༘*.ﾟ`
  );
}

// Construye el resumen de todas las categorías (texto sin botones)
function buildFullMenuText(categories, prefix) {
  return Object.entries(categories)
    .map(([cat, cmds]) => {
      const { icon, label } = getCatDisplay(cat);
      return (
        `✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n` +
        `⪼ ꒰ ${icon} *${label}* ꒱\n` +
        `✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n` +
        cmds.map(c => `╰┈➤ □ ${prefix}${c}`).join('\n') +
        `\n｡ ﾟ ꒰ঌ ✦໒꒱ ༘*.ﾟ`
      );
    })
    .join('\n\n');
}

const handler = async (m, { conn, text, usedPrefix }) => {
  const prefix = usedPrefix || '.';
  const sender = m.sender;
  const senderNum = sender.replace(/@.+/, '');
  const pushname = m.pushName || senderNum;

  const ownerNum = global.owner?.[0]?.[0] || global.nomorown || '';
  const botName = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const time = getTime();
  const date = getDate();
  const week = getWeekday();
  const uptime = getUptime(global.botUptime);

  const categories = buildCategoryMap();
  const catNames = Object.keys(categories);

  // --- Modo: categoría específica solicitada ---
  const input = normalize(text?.split(/\s+/)[0] || '');
  const matched = input
    ? catNames.find(k => normalize(k) === input || normalize(k).startsWith(input))
    : null;

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

  // Header decorado (mismo estilo del es.json)
  const headerText =
    `\n‹—────୨ৎ────˙ . ꒷🪼 . 𖦹˙—꒷꒦︶꒷꒦︶\n\n` +
    `◉— *${botName}* —◉\n\n` +
    `୨ৎ ‧₊˚ 🍓 ⋅ ☆｡𖦹°‧⋆\n\n` +
    `𖦹˙—˙ . ꒷🪼 . ╰┈➤ *Hola,* ${pushname}\n` +
    `╰┈➤ *Owner:* +${ownerNum}\n` +
    `╰┈➤ *Fecha:* ${week}, ${date}\n` +
    `╰┈➤ *⏔ Activo:* ${uptime}\n\n` +
    `˖ ݁𖥔 ݁˖  𐙚  ˖ ݁𖥔 ݁˖  ᯓᡣ𐭩  𖤐⭒๋࣭ ⭑`;

  const footerText = `_Usa_ *${prefix}menu [categoría]* _para filtrar_`;

  const menuImage = global.imagen1 || null;

  // --- Modo categoría específica ---
  if (matched) {
    const cmds = categories[matched] || [];
    const { icon, label } = getCatDisplay(matched);
    const bodyText = buildCategoryDetail(matched, cmds, prefix);

    // Botones: hasta 3 comandos de ejemplo de esa categoría
    const sampleCmds = cmds.slice(0, 3);
    const buttons = sampleCmds.map(c => [`${prefix}${c}`, `${prefix}${c}`]);
    // Si no hay suficientes, agrega botón de menú principal
    if (buttons.length < 1) buttons.push([`${prefix}menu`, `${prefix}menu`]);

    return await conn.sendButton(
      m.chat,
      `${headerText}\n\n${bodyText}`,
      footerText,
      menuImage || null,
      buttons,
      null,   // copy
      null,   // urls
      m
    );
  }

  // --- Modo menú principal con botones de categorías ---
  // Construimos hasta 3 botones con las categorías más importantes
  const priorityOrder = ['anime', 'downloader', 'search', 'tools', 'ai', 'info', 'sticker', 'game'];
  const topCats = [
    ...priorityOrder.filter(c => catNames.includes(c)),
    ...catNames.filter(c => !priorityOrder.includes(c)),
  ].slice(0, 3);

  const catButtons = topCats.map(cat => {
    const { icon, label } = getCatDisplay(cat);
    return [`${icon} ${label}`, `${prefix}menu ${cat}`];
  });

  // Body: resumen compacto de todas las categorías
  const allCatList = catNames
    .map(cat => {
      const { icon, label } = getCatDisplay(cat);
      const count = (categories[cat] || []).length;
      return `╰┈➤ ${icon} *${label}* — ${count} cmds`;
    })
    .join('\n');

  const bodyText =
    `${headerText}\n\n` +
    `‹—────୨ৎ────˙ . ꒷🪼 . 𖦹˙—꒷꒦︶꒷꒦︶\n\n` +
    `*📋 Categorías disponibles:*\n\n` +
    `${allCatList}\n\n` +
    `˖ ݁𖥔 ݁˖  𐙚  ˖ ݁𖥔 ݁˖`;

  await conn.sendButton(
    m.chat,
    bodyText,
    footerText,
    menuImage || null,
    catButtons,
    null,   // copy
    null,   // urls
    m
  );
};

handler.help = ['menu', 'menu [categoría]'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
      
