import moment from 'moment-timezone';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';

const TIMEZONE = 'America/Lima';

function getTime()   { return moment.tz(TIMEZONE).format('hh:mm A'); }
function getDate()   { return moment.tz(TIMEZONE).format('DD/MM/YYYY'); }
function getWeek()   { return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][moment.tz(TIMEZONE).day()]; }
function getUptime(since) {
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  return [d&&`${d}d`,`${h%24}h`,`${m%60}m`,`${s%60}s`].filter(Boolean).join(' ');
}

function buildCategoryMap() {
  const cats = {};
  for (const [, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin?.command) continue;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const helps = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
    if (!helps.length) {
      const cmds = plugin.command instanceof RegExp
        ? [plugin.command.source.replace(/[^a-z|]/gi,'').split('|')[0]]
        : Array.isArray(plugin.command) ? [plugin.command[0]] : [plugin.command];
      helps.push(...cmds);
    }
    if (!cats[tag]) cats[tag] = [];
    cats[tag].push(...helps.filter(Boolean));
  }
  return cats;
}

const CAT_META = {
  anime:      { icon: '🎐', label: 'ANIME',         desc: 'Búsquedas, notificaciones' },
  downloader: { icon: '📥', label: 'DESCARGAS',     desc: 'YouTube, TikTok, IG, FB' },
  search:     { icon: '🔍', label: 'BÚSQUEDAS',     desc: 'Google, imágenes, info' },
  tools:      { icon: '🛠️', label: 'HERRAMIENTAS',  desc: 'Utilidades del bot' },
  ai:         { icon: '🤖', label: 'IA',            desc: 'Inteligencia Artificial' },
  sticker:    { icon: '🎭', label: 'STICKERS',      desc: 'Crear y convertir stickers' },
  game:       { icon: '🎮', label: 'JUEGOS',        desc: 'Trivia, RPS, adivinanzas' },
  group:      { icon: '🏯', label: 'GRUPOS',        desc: 'Administración de grupos' },
  nsfw:       { icon: '🔞', label: 'ADULTOS',       desc: 'Contenido para mayores' },
  owner:      { icon: '💎', label: 'PROPIETARIOS',  desc: 'Comandos del owner' },
  info:       { icon: '💫', label: 'INFORMACIÓN',   desc: 'Ping, info, estado' },
  converter:  { icon: '🪄', label: 'CONVERTIDORES', desc: 'Audio, video, formato' },
  img:        { icon: '🌸', label: 'IMÁGENES',      desc: 'Generar y editar imágenes' },
  xp:         { icon: '🔮', label: 'XP / ECONOMÍA', desc: 'Nivel, coins, economía' },
  random:     { icon: '⭐', label: 'ALEATORIO',     desc: 'Contenido aleatorio' },
  otros:      { icon: '📌', label: 'OTROS',         desc: 'Comandos varios' },
};
function getMeta(cat) {
  return CAT_META[cat.toLowerCase()] || { icon: '📌', label: cat.toUpperCase(), desc: 'Comandos varios' };
}

function normalize(s = '') {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'');
}

function buildCategoryDetail(cat, cmds, prefix) {
  const { icon, label } = getMeta(cat);
  const list = cmds.map(c => `╰┈➤ □ ${prefix}${c}`).join('\n');
  return `✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n⪼ ꒰ ${icon} *${label}* ꒱\n✦•┈๑⋅⋯ ⋯⋅๑┈•✦\n\n${list}\n\n｡ ﾟ ꒰ঌ ✦໒꒱ ༘*.ﾟ`;
}

const handler = async (m, { conn, text, usedPrefix }) => {
  const prefix   = usedPrefix || '.';
  const sender   = m.sender;
  const userNum  = sender.replace(/@.+/,'');
  const pushname = m.pushName || userNum;

  const ownerNum = global.owner?.[0]?.[0] || global.nomorown || '';
  const botName  = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const uptime   = getUptime(global.botUptime);

  const categories = buildCategoryMap();
  const catNames   = Object.keys(categories);

  // ── Modo categoría específica ──────────────────────────────────
  const input   = normalize(text?.split(/\s+/)[0] || '');
  const matched = input
    ? catNames.find(k => normalize(k) === input || normalize(k).startsWith(input))
    : null;

  if (text && !matched) {
    return m.reply(
      `*[ ❓ ] Categoría no encontrada*\n\n` +
      `La categoría *${text}* no existe.\n` +
      `Disponibles: *${catNames.join(', ')}*\n\n` +
      `> Usa *${prefix}menu [categoría]* para filtrar.`
    );
  }

  if (matched) {
    const cmds = categories[matched] || [];
    const { icon, label } = getMeta(matched);
    const bodyText = buildCategoryDetail(matched, cmds, prefix);

    const rows = cmds.slice(0, 8).map(c => ({
      title:       `${prefix}${c}`,
      description: `Ejecutar ${prefix}${c}`,
      id:          `${prefix}${c}`,
    }));
    rows.push({ title: '🔙 Volver al menú', description: 'Ver todas las categorías', id: `${prefix}menu` });

    const buttons = [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: `${icon} ${label}`,
          sections: [{ title: `Comandos de ${label}`, rows }],
        }),
      },
      {
        name: 'cta_copy',
        buttonParamsJson: JSON.stringify({ display_text: 'Copiar categoría', copy_code: `${prefix}menu ${matched}` }),
      },
    ];

    const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
      body:   { text: bodyText },
      footer: { text: `${botName} • ${prefix}menu para volver` },
      header: { title: '', hasMediaAttachment: false },
      nativeFlowMessage: { buttons, messageParamsJson: '' },
    });

    const msgContent = {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage,
        },
      },
    };

    const fullMsg = generateWAMessageFromContent(m.chat, msgContent, {
      userJid: conn.user.jid,
      quoted:  m,
    });
    return conn.relayMessage(m.chat, fullMsg.message, { messageId: fullMsg.key.id });
  }

  // ── Menú principal ─────────────────────────────────────────────
  const bodyText =
    `‹—────୨ৎ────˙ . ꒷🪼 . 𖦹˙—꒷꒦︶꒷꒦︶\n\n` +
    `◉— *${botName}* —◉\n\n` +
    `𖦹˙—˙ . ꒷🪼 . ╰┈➤ *Hola,* @${userNum}!\n` +
    `╰┈➤ *Owner:* +${ownerNum}\n` +
    `╰┈➤ *Fecha:* ${getWeek()}, ${getDate()}\n` +
    `╰┈➤ *⏔ Activo:* ${uptime}\n\n` +
    `˖ ݁𖥔 ݁˖  𐙚  ˖ ݁𖥔 ݁˖  ᯓᡣ𐭩  𖤐⭒๋࣭ ⭑`;

  const footerText = `_Usa_ *${prefix}menu [categoría]* _para filtrar_`;

  // Secciones de la lista desplegable
  const priorityOrder = ['anime','downloader','search','tools','ai','sticker','game','group'];
  const mainCats  = priorityOrder.filter(c => catNames.includes(c));
  const extraCats = catNames.filter(c => !priorityOrder.includes(c));

  const toRow = cat => {
    const { icon, label, desc } = getMeta(cat);
    const count = (categories[cat] || []).length;
    return { header: `${icon} ${label}`, title: label, description: `${desc} • ${count} cmds`, id: `${prefix}menu ${cat}` };
  };

  const sections = [
    { title: 'Categorías Principales', rows: mainCats.map(toRow) },
    ...(extraCats.length ? [{ title: 'Más Categorías', rows: extraCats.map(toRow) }] : []),
    {
      title: 'Atajos',
      rows: [
        { title: '📋 Ver todos los comandos', description: 'Lista completa sin filtros', id: `${prefix}menu` },
        { title: '👑 Soporte / Owner',        description: 'Contactar con el owner',    id: `${prefix}owner` },
      ],
    },
  ];

  const channelUrl = global.channelUrl || 'https://whatsapp.com/channel/0029VaRikka';

  const buttons = [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({ title: '☰ Lista menú 📋', sections }),
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'Canal de WhatsApp',
        url: channelUrl,
        merchant_url: channelUrl,
      }),
    },
    {
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({ display_text: 'Copiar Código', copy_code: `${prefix}menu` }),
    },
  ];

  // Header con imagen si hay
  let header = { title: '', hasMediaAttachment: false };
  const menuImage = global.imagen1 || null;
  if (menuImage) {
    try {
      const media = await prepareWAMessageMedia(
        { image: Buffer.isBuffer(menuImage) ? menuImage : { url: menuImage } },
        { upload: conn.waUploadToServer }
      );
      if (media?.imageMessage) {
        header = { title: '', hasMediaAttachment: true, imageMessage: media.imageMessage };
      }
    } catch { /* continúa sin imagen */ }
  }

  const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
    body:   { text: bodyText },
    footer: { text: footerText },
    header,
    nativeFlowMessage: { buttons, messageParamsJson: '' },
  });

  const msgContent = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage,
      },
    },
  };

  const fullMsg = generateWAMessageFromContent(m.chat, msgContent, {
    userJid:  conn.user.jid,
    quoted:   m,
    mentions: [sender],
  });

  await conn.relayMessage(m.chat, fullMsg.message, { messageId: fullMsg.key.id });
};

handler.help = ['menu', 'menu [categoría]'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
  
