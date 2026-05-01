const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

const handler = async (m, { isOwner, isAdmin, conn, args, text, usedPrefix, command }) => {
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');

  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];

  // ── .testwelcome ───────────────────────────────────────────────────────────
  if (command === 'testwelcome') {
    const groupMetadata = await conn.groupMetadata(m.chat).catch(() => ({}));
    const welcomeMsg = (chat.sWelcome || conn.welcome || '👋 ¡Bienvenido/a!\n@user')
      .replace('@user',    '@' + m.sender.split('@')[0])
      .replace('@subject', groupMetadata?.subject || 'Grupo')
      .replace('@desc',    groupMetadata?.desc?.toString() || '*SIN DESCRIPCIÓN*');

    let pp;
    try {
      pp = await conn.profilePictureUrl(m.sender, 'image');
    } catch {
      pp = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png?q=60';
    }

    const file = await conn.getFile(pp).catch(() => null);
    if (file?.data) {
      await conn.sendFile(m.chat, file.data, 'pp.jpg', `🧪 *[TEST WELCOME]*\n\n${welcomeMsg}`, null, false, { mentions: [m.sender] });
    } else {
      await conn.sendMessage(m.chat, { text: `🧪 *[TEST WELCOME]*\n\n${welcomeMsg}`, mentions: [m.sender] });
    }
    return;
  }

  // ── .setwelcome ────────────────────────────────────────────────────────────
  if (command === 'setwelcome') {
    if (!isAdmin && !isOwner)
      return m.reply('⚠️ Solo los *administradores* pueden usar este comando.');

    // Cooldown
    const now = Date.now();
    if (cooldowns.has(m.chat)) {
      const expiration = cooldowns.get(m.chat) + COOLDOWN_MS;
      if (now < expiration) {
        const secsLeft = Math.ceil((expiration - now) / 1000);
        const mins = Math.floor(secsLeft / 60);
        const secs = secsLeft % 60;
        return m.reply(`⏰ Espera *${mins}m ${secs}s* antes de usar este comando nuevamente.`);
      }
    }

    const sub = args[0]?.toLowerCase();

    if (sub === 'reset') {
      chat.sWelcome = '';
      global.db.data.chats[m.chat].sWelcome = '';
      cooldowns.set(m.chat, now);
      return m.reply('🔄 Mensaje de bienvenida *restablecido* al predeterminado.');
    }

    if (text) {
      chat.sWelcome = text;
      global.db.data.chats[m.chat].sWelcome = text;
      cooldowns.set(m.chat, now);
      return m.reply(
        `✅ *Mensaje de bienvenida actualizado.*\n\n` +
        `📝 *Nuevo mensaje:*\n${text}\n\n` +
        `_Variables: @user · @subject · @desc_\n` +
        `_Usa *${usedPrefix}testwelcome* para previsualizarlo_`
      );
    }

    throw (
      `📖 *Uso de ${usedPrefix}setwelcome:*\n\n` +
      `• *${usedPrefix}setwelcome <texto>* → Personalizar mensaje\n` +
      `• *${usedPrefix}setwelcome reset* → Restaurar por defecto\n\n` +
      `_Variables disponibles:_\n` +
      `*@user* · *@subject* · *@desc*`
    );
  }

  // ── .welcome ───────────────────────────────────────────────────────────────
  if (command === 'welcome') {
    const sub = args[0]?.toLowerCase();

    if (!sub) {
      const estado = chat.welcome ? '✅ *Activada*' : '❌ *Desactivada*';
      const msg = chat.sWelcome || conn.welcome || '👋 ¡Bienvenido/a!\n@user';
      return m.reply(
        `👥 *Bienvenida del grupo*\n\n` +
        `Estado: ${estado}\n\n` +
        `📝 *Mensaje actual:*\n${msg}\n\n` +
        `_Usa *${usedPrefix}setwelcome <texto>* para personalizar_\n` +
        `_Usa *${usedPrefix}testwelcome* para previsualizar_`
      );
    }

    if (!isAdmin && !isOwner)
      return m.reply('⚠️ Solo los *administradores* pueden cambiar este ajuste.');

    if (sub === 'on') {
      chat.welcome = true;
      global.db.data.chats[m.chat].welcome = true;
      return m.reply('✅ Bienvenida *activada*.');
    }

    if (sub === 'off') {
      chat.welcome = false;
      global.db.data.chats[m.chat].welcome = false;
      return m.reply('❌ Bienvenida *desactivada*.');
    }

    throw `❓ *Uso:*\n• *${usedPrefix}welcome on*\n• *${usedPrefix}welcome off*\n• *${usedPrefix}welcome* → Ver estado`;
  }
};

handler.help    = ['welcome <on|off>', 'setwelcome <texto|reset>', 'testwelcome'];
handler.tags    = ['group'];
handler.command = ['welcome', 'setwelcome', 'testwelcome'];
handler.group   = true;

export default handler;
