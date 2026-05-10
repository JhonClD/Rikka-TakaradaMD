import { proto } from '@whiskeysockets/baileys';

const WHATSAPP_LINK_RE = /chat\.whatsapp\.com\/[A-Za-z0-9]{15,}/i;
const SOCIAL_LINK_RE = /(?:https?:\/\/)?(?:www\.)?(t\.me|telegram\.me|tiktok\.com|instagram\.com|facebook\.com|fb\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|discord\.gg|discord\.com\/invite)[\S]*/i;

const handler = async (m, { conn, args, usedPrefix, isAdmin, isBotAdmin, isOwner }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');
  if (!isAdmin && !isOwner) return m.reply('❌ Solo administradores pueden usar este comando.');

  const chat = global.db.data.chats[m.chat];
  const sub = args[0]?.toLowerCase();

  if (!sub) {
    const e1 = chat.antiLink ? '✅' : '❌';
    const e2 = chat.antiLink2 ? '✅' : '❌';
    return m.reply(
      `🔗 *Anti-Link*\n\n` +
      `${e1} *antilink* — Links de grupos WhatsApp\n` +
      `${e2} *antilink2* — Links de redes sociales (TikTok, Telegram, etc.)\n\n` +
      `• *${usedPrefix}antilink on/off*\n` +
      `• *${usedPrefix}antilink2 on/off*`
    );
  }

  throw `❓ Uso: *${usedPrefix}antilink <on|off>*`;
};

handler.before = async function (m, { conn, participants, isBotAdmin, isAdmin, isOwner }) {
  if (!m.isGroup) return;
  const chat = global.db.data.chats[m.chat];
  if (!chat) return;

  const text = m.text || m.caption || '';
  if (!text) return;

  const _ownerList = [...(global.owner || [])].map(([number]) =>
    String(number).replace(/[^0-9]/g, '') + '@s.whatsapp.net'
  );
  const isROwner = _ownerList.includes(m.sender) || m.fromMe;
  if (isROwner) return;

  const bot = participants.find(u => conn.decodeJid(u.id || u.jid) === conn.user?.jid) || {};
  const botIsAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin';
  const user = participants.find(u => conn.decodeJid(u.id || u.jid) === m.sender) || {};
  const userIsAdmin = user?.admin === 'admin' || user?.admin === 'superadmin';

  if (userIsAdmin) return;

  if (chat.antiLink && WHATSAPP_LINK_RE.test(text)) {
    try { await conn.sendMessage(m.chat, { delete: m.key }); } catch (_) {}
    await m.reply(`⚠️ @${m.sender.split('@')[0]}, *no está permitido enviar links de grupos de WhatsApp.*`, null, { mentions: [m.sender] });
    if (botIsAdmin) {
      try { await conn.groupParticipantsUpdate(m.chat, [m.sender], 'remove'); } catch (_) {}
    }
    return false;
  }

  if (chat.antiLink2 && SOCIAL_LINK_RE.test(text)) {
    try { await conn.sendMessage(m.chat, { delete: m.key }); } catch (_) {}
    await m.reply(`⚠️ @${m.sender.split('@')[0]}, *no está permitido enviar links de redes sociales.*`, null, { mentions: [m.sender] });
    return false;
  }
};

handler.help = ['antilink <on|off>', 'antilink2 <on|off>'];
handler.tags = ['group'];
handler.command = ['antilink', 'antilink2'];
handler.group = true;

const _cmd = handler.command;

const _realHandler = Object.assign(async (m, opts) => {
  const { args, usedPrefix, isAdmin, isOwner } = opts;
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');
  if (!isAdmin && !isOwner) return m.reply('❌ Solo administradores pueden usar este comando.');

  const chat = global.db.data.chats[m.chat];
  const cmd = m.text?.trim().slice(1).split(/\s/)[0]?.toLowerCase();
  const sub = args[0]?.toLowerCase();
  const isAntiLink2 = cmd === 'antilink2';

  if (!sub) {
    const key = isAntiLink2 ? 'antiLink2' : 'antiLink';
    const label = isAntiLink2 ? 'Anti-Link Redes Sociales' : 'Anti-Link WhatsApp';
    const estado = chat[key] ? '✅ Activado' : '❌ Desactivado';
    return m.reply(`🔗 *${label}*\n\nEstado: ${estado}\n\n• *${usedPrefix}${cmd} on* / *${usedPrefix}${cmd} off*`);
  }

  const key = isAntiLink2 ? 'antiLink2' : 'antiLink';
  if (sub === 'on') {
    chat[key] = true;
    return m.reply(`✅ *${isAntiLink2 ? 'Anti-Link Redes Sociales' : 'Anti-Link WhatsApp'} activado.*`);
  }
  if (sub === 'off') {
    chat[key] = false;
    return m.reply(`❌ *${isAntiLink2 ? 'Anti-Link Redes Sociales' : 'Anti-Link WhatsApp'} desactivado.*`);
  }
  throw `❓ Uso: *${usedPrefix}${cmd} <on|off>*`;
}, handler);

export default _realHandler;
