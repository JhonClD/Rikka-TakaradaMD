/**
 * gc-setwelcome.js
 * Plugin para configurar el mensaje de bienvenida de un grupo
 * Compatible con KanaArima-MD / Rikka-TakaradaMD (Baileys + ES Modules)
 *
 * Uso:
 *   .setwelcome <texto>   → Establece un mensaje de bienvenida personalizado
 *   .setwelcome reset     → Restaura el mensaje por defecto
 *   .setwelcome ver       → Muestra el mensaje actual
 *
 * Variables disponibles en el texto:
 *   @user    → mención al nuevo miembro
 *   @subject → nombre del grupo
 *   @desc    → descripción del grupo
 */

const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutos

const handler = async (m, { isOwner, isAdmin, conn, text, args, usedPrefix }) => {
  // Ignorar si el prefijo es 'a' / 'A' (modo automatización)
  if (usedPrefix === 'a' || usedPrefix === 'A') return;

  // Solo grupos
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona en grupos.');

  // Solo admins o owner del bot
  if (!isAdmin && !isOwner)
    return m.reply('⚠️ Solo los *administradores del grupo* pueden usar este comando.');

  // Cooldown por grupo
  const now = Date.now();
  const chatId = m.chat;
  if (cooldowns.has(chatId)) {
    const expiration = cooldowns.get(chatId) + COOLDOWN_MS;
    if (now < expiration) {
      const secsLeft = Math.ceil((expiration - now) / 1000);
      const mins = Math.floor(secsLeft / 60);
      const secs = secsLeft % 60;
      return m.reply(`⏰ Espera *${mins}m ${secs}s* antes de usar este comando nuevamente.`);
    }
  }

  // Asegurar que el chat exista en la DB
  if (!global.db.data.chats[chatId]) global.db.data.chats[chatId] = {};
  const chat = global.db.data.chats[chatId];

  const subcommand = args[0]?.toLowerCase();

  // ── Ver mensaje actual ──────────────────────────────────────────────────────
  if (subcommand === 'ver') {
    const current = chat.sWelcome || conn.welcome || '👋 ¡Bienvenido/a!\n@user';
    return m.reply(
      `📋 *Mensaje de bienvenida actual:*\n\n${current}\n\n` +
      `_Variables: @user, @subject, @desc_`
    );
  }

  // ── Reset al mensaje por defecto ────────────────────────────────────────────
  if (subcommand === 'reset') {
    chat.sWelcome = '';
    global.db.data.chats[chatId].sWelcome = '';
    cooldowns.set(chatId, now);
    return m.reply('🔄 El mensaje de bienvenida ha sido *restablecido* al predeterminado.');
  }

  // ── Establecer mensaje personalizado ────────────────────────────────────────
  if (text) {
    chat.sWelcome = text;
    global.db.data.chats[chatId].sWelcome = text;
    cooldowns.set(chatId, now);
    return m.reply(
      `✅ *Mensaje de bienvenida actualizado.*\n\n` +
      `📝 *Nuevo mensaje:*\n${text}\n\n` +
      `_Variables disponibles:_\n` +
      `• *@user* → mención al nuevo miembro\n` +
      `• *@subject* → nombre del grupo\n` +
      `• *@desc* → descripción del grupo`
    );
  }

  // ── Sin argumentos: mostrar ayuda ───────────────────────────────────────────
  throw (
    `📖 *Uso del comando:*\n\n` +
    `• *${usedPrefix}setwelcome <texto>* → Establece bienvenida personalizada\n` +
    `• *${usedPrefix}setwelcome reset* → Restaura la bienvenida por defecto\n` +
    `• *${usedPrefix}setwelcome ver* → Muestra la bienvenida actual\n\n` +
    `_Variables disponibles en el texto:_\n` +
    `*- @user* (mención al nuevo miembro)\n` +
    `*- @subject* (nombre del grupo)\n` +
    `*- @desc* (descripción del grupo)`
  );
};

handler.help  = ['setwelcome <texto|reset|ver>'];
handler.tags  = ['group'];
handler.command = ['setwelcome'];

// El handler nativo del bot ya valida plugin.group → solo grupos
handler.group = true;
// El handler nativo ya valida plugin.admin → solo admins
handler.admin = true;

export default handler;
