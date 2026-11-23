export function isValidMessage(m, { isLive = false } = {}) {
  if (!m || typeof m !== 'object') return false;
  if (!m.message) return false;
  if (m.message?.protocolMessage) return false;

  const remoteJid = m.key?.remoteJid || '';

  if (remoteJid === 'status@broadcast') return false;
  if (remoteJid.endsWith('@broadcast') && remoteJid !== 'status@broadcast') return false;
  if (remoteJid.endsWith('@newsletter')) return false;
  if (!remoteJid) return false;

  if (m.isBaileys && !m.message?.audioMessage) return false;

  if (!isLive) {
    const connectionTime = global.timestamp?.connect?.getTime() || Date.now();
    const rawTs = m.messageTimestamp;
    const seconds = typeof rawTs === 'number'
      ? rawTs
      : (typeof rawTs?.toNumber === 'function' ? rawTs.toNumber() : Number(rawTs?.low ?? rawTs?.high ?? 0));
    const msgTimestamp = Number.isFinite(seconds) ? seconds * 1000 : 0;

    if (msgTimestamp > 0 && msgTimestamp < connectionTime - 60000) {
      return false;
    }
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

// ─── Tests embebidos (solo al ejecutar `node --test src/funcion/messageValidation.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { default: test } = await import('node:test');
    const { default: assert } = await import('node:assert/strict');

    const now = () => Math.floor(Date.now() / 1000);

    test('isValidMessage descarta protocolMessage, emisiones y newsletters', () => {
      global.timestamp = { connect: new Date() };

      const text = { message: { conversation: 'hola' }, key: { remoteJid: '51999@s.whatsapp.net' } };
      assert.equal(isValidMessage(text), true);

      assert.equal(isValidMessage(null), false);
      assert.equal(isValidMessage({ key: { remoteJid: 'x@s.whatsapp.net' } }), false);
      assert.equal(isValidMessage({ ...text, message: { protocolMessage: {} } }), false);
      assert.equal(isValidMessage({ message: { conversation: 'x' }, key: { remoteJid: 'status@broadcast' } }), false);
      assert.equal(isValidMessage({ message: { conversation: 'x' }, key: { remoteJid: '123@newsletter' } }), false);
      assert.equal(isValidMessage({ ...text, isBaileys: true }), false);
      assert.equal(isValidMessage({ message: { audioMessage: {} }, key: { remoteJid: 'x@s.whatsapp.net' }, isBaileys: true }), true);
    });

    test('isValidMessage ignora mensajes anteriores a la conexión salvo mensajes en vivo (notify)', () => {
      global.timestamp = { connect: new Date() };
      const viejo = {
        message: { conversation: 'hola' },
        messageTimestamp: now() - 3600,
        key: { remoteJid: '51999@s.whatsapp.net' },
      };
      assert.equal(isValidMessage(viejo), false);
      assert.equal(isValidMessage(viejo, { isLive: true }), true);

      const viejoLong = {
        ...viejo,
        messageTimestamp: { toNumber: () => now() - 3600 },
      };
      assert.equal(isValidMessage(viejoLong), false);
      assert.equal(isValidMessage(viejoLong, { isLive: true }), true);

      delete global.timestamp;
      assert.equal(isValidMessage({ message: { conversation: 'hola' }, key: { remoteJid: '51999@s.whatsapp.net' } }), true);
    });

    test('extractMessageText prioriza el texto y cubre respuestas interactivas', () => {
      assert.equal(extractMessageText({ message: { conversation: '.ping' } }), '.ping');
      assert.equal(extractMessageText({ message: { extendedTextMessage: { text: '.menu' } } }), '.menu');
      assert.equal(extractMessageText({ message: { imageMessage: { caption: '.sticker' } } }), '.sticker');
      assert.equal(extractMessageText({ message: { buttonsResponseMessage: { selectedButtonId: '.si' } } }), '.si');
      assert.equal(
        extractMessageText({ message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":".testbtn ok"}' } } } }),
        '.testbtn ok',
      );
      assert.equal(extractMessageText({}), '');
    });

    test('isDuplicate frena reentregas y caduca a los DUPLICATE_TIMEOUT ms', () => {
      const cache = new Map();
      const args = ['ID1', '51999@s.whatsapp.net', '.ping', cache, 3000, 150];
      assert.equal(isDuplicate(...args), false);
      assert.equal(isDuplicate(...args), true);
      assert.equal(isDuplicate('ID1', '51888@s.whatsapp.net', '.ping', cache, 3000, 150), false);
      assert.equal(isDuplicate('ID1', '51999@s.whatsapp.net', '.ping', cache, -1, 150), false);
    });

    test('isDuplicate no crece sin límite', () => {
      const cache = new Map();
      for (let i = 0; i < 400; i += 1) isDuplicate(`ID${i}`, 'a@s.whatsapp.net', 'x', cache, 3000, 5);
      assert.ok(cache.size <= 5, `cache.size=${cache.size}`);
    });

    test('extractSenderAndChat usa el participante en grupos y el remoteJid en privados', () => {
      const grupo = extractSenderAndChat(
        { key: { remoteJid: 'grupo-1@g.us', participant: '51999@s.whatsapp.net' } },
        { user: { id: 'bot@s.whatsapp.net' } },
      );
      assert.deepEqual(grupo, { sender: '51999@s.whatsapp.net', chat: 'grupo-1@g.us' });

      const privado = extractSenderAndChat({ key: { remoteJid: '51777@s.whatsapp.net' } }, {});
      assert.equal(privado.sender, '51777@s.whatsapp.net');

      const propio = extractSenderAndChat({ key: { remoteJid: 'grupo-1@g.us', fromMe: true } }, { user: { id: 'bot@s.whatsapp.net' } });
      assert.equal(propio.sender, 'bot@s.whatsapp.net');
    });

    test('getMessageType saltea metadatos y reconoce multimedia y view-once', () => {
      const m = {
        message: {
          senderKeyDistributionMessage: {},
          messageContextInfo: {},
          imageMessage: {},
        },
      };
      assert.equal(getMessageType(m), 'imageMessage');
      assert.equal(isMediaMessage(m), true);
      assert.equal(isViewOnceMessage(m), false);
      assert.equal(getMessageType({}), null);
      assert.equal(
        isViewOnceMessage({ message: { viewOnceMessageV2: {}, messageContextInfo: {} } }),
        true,
      );
    });
  }
}


