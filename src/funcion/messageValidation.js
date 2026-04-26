/**
 * messageValidation.js - KanaArima-MD
 * Fix para doble mensaje, filtro de timestamps y deduplicación robusta
 */

export function isValidMessage(m) {
  if (!m?.message || typeof m !== 'object') return false;
  if (m.key?.remoteJid?.endsWith('broadcast')) return false;
  // Ignorar mensajes generados por el propio bot
  if (m.isBaileys && !m.message?.audioMessage) return false;

  const connectionTime = global.timestamp?.connect?.getTime() || Date.now();
  const msgTimestamp = (m.messageTimestamp || 0) * 1000;

  // Rechazar mensajes más viejos que 60s antes de la conexión
  if (msgTimestamp < connectionTime - 60000) {
    return false;
  }

  return true;
}

/**
 * Deduplicación por messageId + sender + texto parcial
 * Evita que el bot procese el mismo mensaje dos veces (doble handler)
 */
export function isDuplicate(messageId, sender, text, recentMessages, DUPLICATE_TIMEOUT = 3000, MAX_CACHE_SIZE = 150) {
  if (!messageId) return false;

  const uniqueKey = `${messageId}_${sender}_${(text || '').substring(0, 50)}`;

  if (recentMessages.has(uniqueKey)) {
    const timestamp = recentMessages.get(uniqueKey);
    if (Date.now() - timestamp < DUPLICATE_TIMEOUT) {
      return true; // duplicado
    }
  }

  // Limpiar si excede tamaño máximo
  if (recentMessages.size >= MAX_CACHE_SIZE) {
    const firstKey = recentMessages.keys().next().value;
    recentMessages.delete(firstKey);
  }

  recentMessages.set(uniqueKey, Date.now());
  return false;
}

export function extractMessageText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.buttonsResponseMessage?.selectedButtonId ||
    m.message?.templateButtonReplyMessage?.selectedId ||
    m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

export function extractSenderAndChat(m, conn) {
  const sender = m.key?.fromMe
    ? conn?.user?.jid || conn?.user?.id
    : (m.key?.participant || m.participant || m.key?.remoteJid || '');
  const chat = m.key?.remoteJid || '';
  return { sender, chat };
}

export function normalizeMessageText(m) {
  m.text = extractMessageText(m);
  if (typeof m.text !== 'string') m.text = '';
  return m;
}
