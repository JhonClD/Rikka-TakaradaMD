import moment from 'moment-timezone';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, '../src/banner.jpg');

const CONFIG = {
  timezone: 'America/Lima',
  headerEmoji: '🎐',
  lineSeparator: '❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼',
  catBox: {
    top: '┌─────── " *{title}* {icon} „ ━━━━━━━┓',
    mid: '└➤ ✎~',
    bottom: '┗━━━━━━━━━━━━━━━━━━━━━━━┛',
    cmdPrefix: '── ⟡ ˙ '
  }
};

const CAT_ICONS = {
  anime: '🎐', downloader: '📥', search: '🔍', tools: '🛠️', ai: '🤖',
  sticker: '🎭', game: '🎮', group: '🏯', owner: '💎', info: '💫', otros: '📌'
};

const more = String.fromCharCode(8206);
const readMore = more.repeat(4001);

function clockString(ms) {
  const d  = Math.floor(ms / 86400000);
  const h  = Math.floor(ms / 3600000) % 24;
  const mm = Math.floor(ms / 60000) % 60;
  const s  = Math.floor(ms / 1000) % 60;
  return `${d}d ${h}h ${mm}m ${s}s`.replace(/\b(\d)\b/g, '0$1');
}

const handler = async (m, { conn, usedPrefix }) => {
  const settings = global.db.data.settings[conn.user.jid] || {};

  const botNameLong  = settings.botname || 'ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ';
  const botNameShort = settings.namebot || '܁ᴍ፝֟ıηͨσ‍ͥяͩυ';
  const botLink      = settings.link    || 'https://github.com/JhonCID';
  // URL de ImgBB guardada por .setbanner (o vacío si no hay)
  const bannerUrl    = (settings.banner && settings.banner.startsWith('http'))
    ? settings.banner : null;

  // WhatsApp normal necesita el buffer del thumbnail, no solo la URL.
  // Si hay banner personalizado (URL) lo descargamos; si no, usamos el banner local.
  let thumbBuffer;
  try {
    if (bannerUrl) {
      const res = await fetch(bannerUrl);
      thumbBuffer = Buffer.from(await res.arrayBuffer());
    } else if (existsSync(BANNER_PATH)) {
      thumbBuffer = readFileSync(BANNER_PATH);
    }
  } catch {
    if (existsSync(BANNER_PATH)) thumbBuffer = readFileSync(BANNER_PATH);
  }

  const pushname  = m.pushName || 'Usuario';
  const date      = moment.tz(CONFIG.timezone).format('YYYY-MM-DD');
  const uptime    = clockString(process.uptime() * 1000);
  // Detectar nivel del usuario — con resolución de LID igual que handler.js
  const _phoneOnly = (jid) => (jid || '').replace(/[^0-9]/g, '');
  const _resolveLid = (jid) => {
    if (!jid?.endsWith('@lid')) return jid;
    const lidKey = jid.split('@')[0];
    const pnUser = conn?.signalRepository?.lidMapping?.mappingCache?.get(`lid:${lidKey}`);
    if (pnUser && typeof pnUser === 'string') return `${pnUser}@s.whatsapp.net`;
    return jid;
  };
  const _senderJid   = _resolveLid(m.sender);
  const _senderPhone = _phoneOnly(_senderJid);
  const _ownerList   = (global.owner || []).map(([n]) => n.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
  const _modsList    = (global.mods  || []).map(v  => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');

  const _isROwner = m.fromMe || _ownerList.some(o => o === _senderJid || _phoneOnly(o) === _senderPhone);
  const _isMod    = !_isROwner && _modsList.some(o => o === _senderJid || _phoneOnly(o) === _senderPhone);

  const _userData   = global.db?.data?.users?.[m.sender] || global.db?.data?.users?.[_senderJid] || {};
  const _premActive = typeof _userData.premiumTime === 'number' && _userData.premiumTime > Date.now();

  let isPremium;
  if (_isROwner) {
    isPremium = '👑 Owner';
  } else if (_isMod) {
    isPremium = '🛡️ Mod';
  } else if (_premActive) {
    const _msLeft = _userData.premiumTime - Date.now();
    const _dLeft  = Math.floor(_msLeft / 86400000);
    const _hLeft  = Math.floor((_msLeft % 86400000) / 3600000);
    isPremium = _dLeft > 0 ? `✅ (${_dLeft}d ${_hLeft}h)` : `✅ (<1d)`;
  } else {
    isPremium = '❌';
  }

  const categories = {};
  Object.values(global.plugins || {}).forEach(plugin => {
    if (!plugin?.command) return;
    const tag  = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
    const help = Array.isArray(plugin.help) ? plugin.help : [plugin.help];
    if (!categories[tag]) categories[tag] = [];
    categories[tag].push(...help.filter(Boolean));
  });

  const totalCmds = Object.values(categories).flat().length;

  let menuTexto = `━━━━━❒「 \`${botNameLong}\` 」⋆｡ﾟ${CONFIG.headerEmoji}\n\n`;
  menuTexto += ` ୨୧     ꒰ \`Usuario\`   :  ${pushname}\n`;
  menuTexto += ` ୨୧     ꒰ \`Premium\`   :  ${isPremium}\n`;
  menuTexto += ` ୨୧     ꒰ \`Uptime\`    :  ${uptime}\n`;
  menuTexto += ` ୨୧     ꒰ \`Fecha\`     :  ${date}\n`;
  menuTexto += ` ୨୧     ꒰ \`Prefix\`    :  ${usedPrefix}\n`;
  menuTexto += ` ୨୧     ꒰ \`Comandos\`  :  ${totalCmds}\n\n`;
  menuTexto += `${CONFIG.lineSeparator}\n${readMore}\n`;

  const sortedCats = Object.keys(categories).sort();
  sortedCats.forEach(cat => {
    const icon = CAT_ICONS[cat.toLowerCase()] || '📌';
    const cmds = [...new Set(categories[cat])]
      .map(c => `${CONFIG.catBox.cmdPrefix}${usedPrefix}${c}`)
      .join('\n');
    menuTexto += `${CONFIG.catBox.top.replace('{title}', cat.toUpperCase()).replace('{icon}', icon)}\n`;
    menuTexto += `${CONFIG.catBox.mid}\n\n${cmds}\n`;
    menuTexto += `${CONFIG.catBox.bottom}\n\n`;
  });

  await conn.sendMessage(m.chat, {
    text: menuTexto,
    contextInfo: {
      externalAdReply: {
        title: botNameLong,
        body: `𝘙𝘪𝘬𝘬𝘢, 🅟ᴏᴡᴇʀᴇᴅ 𝘉𝘺 | — ${botNameShort}`,
        sourceUrl: botLink,
        mediaType: 1,
        renderLargerThumbnail: true,
        showAdAttribution: false,
        ...(thumbBuffer ? { thumbnail: thumbBuffer } : bannerUrl ? { thumbnailUrl: bannerUrl } : {})
      }
    }
  }, { quoted: m });
};

handler.help    = ['menu'];
handler.tags    = ['info'];
handler.command = /^(menu|ayuda|help)$/i;

export default handler;
