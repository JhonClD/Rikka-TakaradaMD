const { default: WAMessageStubType } = await import('@whiskeysockets/baileys');

const DEFAULT_PP = 'https://i.ibb.co/7JWfJBQ/avatar.jpg';

const fkontak = {
  key: {
    participants: '0@s.whatsapp.net',
    remoteJid: 'status@broadcast',
    fromMe: false,
    id: 'Halo'
  },
  message: {
    contactMessage: {
      vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:Rikka Takarada\nitem1.TEL;waid=0:0\nitem1.X-ABLabel:Ponsel\nEND:VCARD`
    }
  },
  participant: '0@s.whatsapp.net'
};

const _buildText = (template, userName, subject, desc) =>
  template
    .replace(/@user/g, `@${userName}`)
    .replace(/@subject/g, subject)
    .replace(/@desc/g, desc);

const DEFAULT_WELCOME = (userName, subject, desc) =>
  `╭━━━『 ⸙͎ 𝗕𝗶𝗲𝗻𝘃𝗲𝗻𝗶𝗱𝗼/𝗮 ✦ 』━━━╮\n` +
  `┃ ꒰ 👤 ꒱ @${userName}\n` +
  `┃ ꒰ 🏘️ ꒱ *${subject}*\n` +
  `┃\n` +
  `┃ ₊˚⋆ *Lee la descripción del grupo* ⋆˚₊\n` +
  `┃\n` +
  `┃ ${desc}\n` +
  `╰━━━━━━━━━━━━━━━━━━╯`;

const DEFAULT_BYE = (userName, subject) =>
  `╭━━━『 ↳ 𝗛𝗮𝘀𝘁𝗮 𝗹𝘂𝗲𝗴𝗼 ✦ 』━━━╮\n` +
  `┃ ꒰ 👤 ꒱ @${userName}\n` +
  `┃ ꒰ 🏘️ ꒱ *${subject}*\n` +
  `┃\n` +
  `┃ ₊˚ Se fue del grupo ˚₊\n` +
  `╰━━━━━━━━━━━━━━━━━━╯`;

const handler = async (m, { conn, args, usedPrefix, isAdmin, isOwner }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');
  if (!isAdmin && !isOwner) return m.reply('❌ Solo administradores pueden usar este comando.');

  const chat = global.db.data.chats[m.chat];
  const sub = args[0]?.toLowerCase();

  if (!sub) {
    const estado = chat.welcome ? '✅ *Activado*' : '❌ *Desactivado*';
    return m.reply(
      `╭━━━『 👋 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 』━━━╮\n` +
      `┃ Estado: ${estado}\n` +
      `┃\n` +
      `┃ ꒰ 𝗖𝗼𝗺𝗮𝗻𝗱𝗼𝘀 ꒱\n` +
      `┃ ▸ *${usedPrefix}welcome on/off*\n` +
      `┃ ▸ *${usedPrefix}welcome msg* <texto>\n` +
      `┃ ▸ *${usedPrefix}welcome bye* <texto>\n` +
      `┃ ▸ *${usedPrefix}welcome reset*\n` +
      `┃ ▸ *${usedPrefix}welcome ver*\n` +
      `┃\n` +
      `┃ ꒰ 𝗩𝗮𝗿𝗶𝗮𝗯𝗹𝗲𝘀 ꒱\n` +
      `┃ @user → menciona al usuario\n` +
      `┃ @subject → nombre del grupo\n` +
      `┃ @desc → descripción del grupo\n` +
      `╰━━━━━━━━━━━━━━━━━━╯`
    );
  }

  if (sub === 'on') {
    chat.welcome = true;
    return m.reply('╭━━━『 ✅ 』━━━╮\n┃ *Bienvenida/Despedida activada.*\n╰━━━━━━━━━━━╯');
  }

  if (sub === 'off') {
    chat.welcome = false;
    return m.reply('╭━━━『 ❌ 』━━━╮\n┃ *Bienvenida/Despedida desactivada.*\n╰━━━━━━━━━━━╯');
  }

  if (sub === 'msg') {
    if (!args[1]) return m.reply(`❓ Uso: *${usedPrefix}welcome msg* <texto>\nVariables: @user @subject @desc`);
    chat.sWelcome = args.slice(1).join(' ');
    return m.reply(`╭━━━『 ✅ 𝗕𝗶𝗲𝗻𝘃𝗲𝗻𝗶𝗱𝗮 』━━━╮\n┃ Mensaje guardado:\n┃\n┃ ${chat.sWelcome}\n╰━━━━━━━━━━━━━━━━━╯`);
  }

  if (sub === 'bye') {
    if (!args[1]) return m.reply(`❓ Uso: *${usedPrefix}welcome bye* <texto>\nVariables: @user @subject`);
    chat.sBye = args.slice(1).join(' ');
    return m.reply(`╭━━━『 ✅ 𝗗𝗲𝘀𝗽𝗲𝗱𝗶𝗱𝗮 』━━━╮\n┃ Mensaje guardado:\n┃\n┃ ${chat.sBye}\n╰━━━━━━━━━━━━━━━━━╯`);
  }

  if (sub === 'reset') {
    chat.sWelcome = '';
    chat.sBye = '';
    return m.reply('🔄 *Mensajes restablecidos al valor por defecto.*');
  }

  if (sub === 'ver') {
    const estado = chat.welcome ? '✅ Activado' : '❌ Desactivado';
    return m.reply(
      `╭━━━『 👁️ 𝗩𝗲𝗿 𝗖𝗼𝗻𝗳𝗶𝗴 』━━━╮\n` +
      `┃ Estado: ${estado}\n┃\n` +
      `┃ 𝗕𝗶𝗲𝗻𝘃𝗲𝗻𝗶𝗱𝗮:\n┃ ${chat.sWelcome || '_(por defecto)_'}\n┃\n` +
      `┃ 𝗗𝗲𝘀𝗽𝗲𝗱𝗶𝗱𝗮:\n┃ ${chat.sBye || '_(por defecto)_'}\n` +
      `╰━━━━━━━━━━━━━━━━━╯`
    );
  }

  throw `❓ Uso: *${usedPrefix}welcome <on|off|msg|bye|reset|ver>*`;
};

handler.before = async function (m, { conn, participants, groupMetadata }) {
  if (!m.isGroup) return;
  if (!m.messageStubType) return;

  const chat = global.db.data.chats?.[m.chat];
  if (!chat?.welcome) return;

  const stubType = m.messageStubType;

  const GROUP_PARTICIPANT_ADD    = WAMessageStubType?.GROUP_PARTICIPANT_ADD    ?? 27;
  const GROUP_PARTICIPANT_REMOVE = WAMessageStubType?.GROUP_PARTICIPANT_REMOVE ?? 28;
  const GROUP_PARTICIPANT_LEAVE  = WAMessageStubType?.GROUP_PARTICIPANT_LEAVE  ?? 32;

  const isAdd    = stubType === GROUP_PARTICIPANT_ADD;
  const isRemove = stubType === GROUP_PARTICIPANT_REMOVE || stubType === GROUP_PARTICIPANT_LEAVE;

  if (!isAdd && !isRemove) return;

  const subject = groupMetadata?.subject || m.chat.split('@')[0];
  const desc    = groupMetadata?.desc?.toString() || '⸙͎ 𝗥𝗶𝗸𝗸𝗮 𝗧𝗮𝗸𝗮𝗿𝗮𝗱𝗮 𝗠𝗗 ⸙͎';

  const rawUsers = m.messageStubParameters || [];

  for (const userRaw of rawUsers) {
    const userJid = userRaw.includes('@') ? userRaw : `${userRaw}@s.whatsapp.net`;
    if (userJid === this.user?.jid) continue;

    const userName = userJid.split('@')[0];

    let pp = DEFAULT_PP;
    try {
      pp = await this.profilePictureUrl(userJid, 'image');
    } catch (_) {}

    let text;
    if (isAdd) {
      text = chat.sWelcome
        ? _buildText(chat.sWelcome, userName, subject, desc)
        : DEFAULT_WELCOME(userName, subject, desc);
    } else {
      text = chat.sBye
        ? _buildText(chat.sBye, userName, subject, '')
        : DEFAULT_BYE(userName, subject);
    }

    try {
      await this.sendMessage(
        m.chat,
        {
          text,
          contextInfo: {
            forwardingScore: 9999999,
            isForwarded: true,
            mentionedJid: [userJid],
            externalAdReply: {
              showAdAttribution: true,
              renderLargerThumbnail: true,
              thumbnailUrl: pp,
              title: global.wm || 'Rikka Takarada MD',
              containsAutoReply: true,
              mediaType: 1,
              sourceUrl: 'https://github.com'
            }
          }
        },
        { quoted: fkontak }
      );
    } catch (e) {
      console.error('welcome.js before error:', e?.message || e);
      try {
        await this.sendMessage(m.chat, { text, mentions: [userJid] });
      } catch (_) {}
    }
  }
};

handler.help = ['welcome <on|off|msg|bye|reset|ver>'];
handler.tags = ['group'];
handler.command = ['welcome', 'bienvenida', 'setwelcome'];
handler.group = true;

export default handler;
  
