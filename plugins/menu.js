import moment from 'moment-timezone';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';

const TIMEZONE = 'America/Lima';

function getUptime(since) {
  if (!since) return 'Recién iniciado';
  const ms = Date.now() - since;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return [d && `${d}d`, `${h % 24}h`, `${m % 60}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', descargas: '📥', search: '🔍', buscadores: '🔍',
  tools: '🛠️', herramientas: '🛠️', ai: '🤖', ia: '🤖', sticker: '🎭', stickers: '🎭',
  game: '🎮', games: '🎮', group: '🏯', grupos: '👥', nsfw: '🔞',
  owner: '💎', info: '💫', converter: '🪄', img: '🌸', xp: '🔮',
  random: '⭐', otros: '📌',
};
const getIcon = cat => CAT_ICONS[cat.toLowerCase()] || '📌';

// Lee todos los plugins de global.plugins y agrupa por tag automáticamente
function buildCategories() {
  const cats = {};
  for (const [, plugin] of Object.entries(global.plugins || {})) {
    if (!plugin?.command) continue;
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    // Obtener nombres de comandos
    let cmds = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
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
  const prefix   = usedPrefix || '.';
  const sender   = m.sender;
  const userNum  = sender.replace(/@.+/, '');
  const pushname = m.pushName || userNum;
  const botName  = global.kanaarima || global.titulowm || 'Kana Arima-MD';
  const ownerNum = global.owner?.[0]?.[0] || global.nomorown || '';
  const uptime   = getUptime(global.botUptime);
  const time     = moment.tz(TIMEZONE).format('hh:mm A');
  const date     = moment.tz(TIMEZONE).format('DD/MM/YYYY');

  const categories = buildCategories();
  const totalCmds  = Object.values(categories).flat().length;

  // ── Texto del cuerpo ──────────────────────────────────────────
  const bodyText =
    `‹—────୨ৎ────˙ . ꒷🪼 . 𖦹˙—꒷꒦︶꒷꒦︶\n\n` +
    `◉— *${botName}* —◉\n\n` +
    `╰┈➤ 👤 *Usuario:* @${userNum}\n` +
    `╰┈➤ 🤖 *Owner:* +${ownerNum}\n` +
    `╰┈➤ 🕐 *Hora:* ${time}\n` +
    `╰┈➤ 📅 *Fecha:* ${date}\n` +
    `╰┈➤ ⏔ *Uptime:* ${uptime}\n` +
    `╰┈➤ 🔰 *Prefix:* ${prefix}\n` +
    `╰┈➤ 📋 *Comandos:* ${totalCmds} disponibles\n\n` +
    `˖ ݁𖥔 ݁˖  𐙚  ˖ ݁𖥔 ݁˖  ᯓᡣ𐭩  𖤐⭒๋࣭ ⭑\n\n` +
    `_Toca_ *☰ Lista menú* _para ver todos los comandos_`;

  const footerText = `${botName} • ${totalCmds} comandos`;

  // ── Secciones de la lista (una por categoría, filas = comandos) ─
  const sections = Object.entries(categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, cmds]) => ({
      title: `${getIcon(cat)} ${cat.toUpperCase()}`,
      rows: cmds.slice(0, 10).map(c => ({    // WA limita ~10 rows por sección
        title:       `${prefix}${c}`,
        description: `Comando ${prefix}${c}`,
        id:          `${prefix}${c}`,
      })),
    }))
    .filter(s => s.rows.length > 0);

  // ── Botones ───────────────────────────────────────────────────
  const channelUrl = global.channelUrl || 'https://whatsapp.com/channel/0029VaRikka';

  const buttons = [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: '☰ Lista menú 📋',
        sections,
      }),
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
      buttonParamsJson: JSON.stringify({
        display_text: 'Copiar Código',
        copy_code: `${prefix}menu`,
      }),
    },
  ];

  // ── Header con imagen si hay ──────────────────────────────────
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
    } catch { /* sin imagen si falla */ }
  }

  // ── Armar y enviar ────────────────────────────────────────────
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

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
