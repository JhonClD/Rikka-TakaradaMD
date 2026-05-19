export function isValidMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (!m.message) return false;

  const remoteJid = m.key?.remoteJid || '';

  if (remoteJid === 'status@broadcast') return false;
  if (remoteJid.endsWith('@broadcast') && remoteJid !== 'status@broadcast') return false;
  if (remoteJid.endsWith('@newsletter')) return false;
  if (!remoteJid) return false;

  if (m.isBaileys && !m.message?.audioMessage) return false;

  const connectionTime = global.timestamp?.connect?.getTime() || Date.now();
  const msgTimestamp = (typeof m.messageTimestamp === 'number'
    ? m.messageTimestamp
    : m.messageTimestamp?.low || m.messageTimestamp?.high || 0) * 1000;

  if (msgTimestamp > 0 && msgTimestamp < connectionTime - 60000) {
    return false;
  }

  return true;
}

export function isDuplicate(messageId, sender, text, recentMessages, DUPLICATE_TIMEOUT = 3000, MAX_CACHE_SIZE = 150) {
  if (!messageId) return false;

  const senderKey = (sender || '').split('@')[0];
  const uniqueKey = `${messageId}_${senderKey}_${(text || '').substring(0, 50)}`;

  if (recentMessages.has(uniqueKey)) {
    const timestamp = recentMessages.get(uniqueKey);
    if (Date.now() - timestamp < DUPLICATE_TIMEOUT) {
      return true;
    }
  }

  if (recentMessages.size >= MAX_CACHE_SIZE) {
    const firstKey = recentMessages.keys().next().value;
    recentMessages.delete(firstKey);
  }

  recentMessages.set(uniqueKey, Date.now());
  return false;
}

export function extractMessageText(m) {
  if (!m?.message) return '';
  const msg = m.message;
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    (() => {
      // Extraer el rowId del paramsJson en lugar del JSON crudo
      const _pj = msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
      if (_pj) {
        try { const _p = JSON.parse(_pj); if (typeof _p?.id === 'string') return _p.id } catch (_) {}
        return _pj // fallback: devolver el raw si no es JSON parseable
      }
      return ''
    })() ||
    ''
  );
}

export function extractSenderAndChat(m, conn) {
  const remoteJid = m.key?.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');
  const rawSender = m.key?.fromMe
    ? (conn?.user?.id || conn?.user?.jid || '')
    : (m.key?.participant || m.participant || (isGroup ? '' : remoteJid));

  let sender = rawSender || '';

  if (sender.endsWith('@lid')) {
    const resolver = conn?.resolveLid;
    if (resolver) {
      const lidKey = sender.split('@')[0];
      if (resolver.cache instanceof Map) {
        const entry = resolver.cache.get(lidKey);
        if (entry?.jid && !entry.jid.endsWith('@lid')) sender = entry.jid;
      }
    }
  }

  return { sender, chat: remoteJid };
}

export function normalizeMessageText(m) {
  m.text = extractMessageText(m);
  if (typeof m.text !== 'string') m.text = '';
  return m;
}

export function getMessageType(m) {
  if (!m?.message) return null;
  const types = Object.keys(m.message);
  const skip = ['senderKeyDistributionMessage', 'messageContextInfo'];
  return types.find(t => !skip.includes(t)) || types[types.length - 1] || null;
}

export function isMediaMessage(m) {
  const type = getMessageType(m);
  if (!type) return false;
  return ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(type);
}

export function isViewOnceMessage(m) {
  const type = getMessageType(m);
  return type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension';
}

export function isEphemeralMessage(m) {
  return getMessageType(m) === 'ephemeralMessage';
}

export function isEditedMessage(m) {
  return getMessageType(m) === 'editedMessage' || getMessageType(m) === 'protocolMessage';
      }
                                               
