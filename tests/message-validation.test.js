import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidMessage,
  isDuplicate,
  extractMessageText,
  extractSenderAndChat,
  getMessageType,
  isMediaMessage,
  isViewOnceMessage,
} from '../src/funcion/messageValidation.js'

const now = () => Math.floor(Date.now() / 1000)

test('isValidMessage descarta protocolMessage, emisiones y newsletters', () => {
  global.timestamp = { connect: new Date() };

  const text = { message: { conversation: 'hola' }, key: { remoteJid: '51999@s.whatsapp.net' } };
  assert.equal(isValidMessage(text), true);

  assert.equal(isValidMessage(null), false);
  assert.equal(isValidMessage({ key: { remoteJid: 'x@s.whatsapp.net' } }), false);
  assert.equal(isValidMessage({ ...text, message: { protocolMessage: {} } }), false);
  assert.equal(isValidMessage({ message: { conversation: 'x' }, key: { remoteJid: 'status@broadcast' } }), false);
  assert.equal(isValidMessage({ message: { conversation: 'x' }, key: { remoteJid: '123@newsletter' } }), false);
  // mensajes propios (eco del bot) se ignoran salvo audios, que sí se procesan
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
  // Mensajes en tiempo real (`type === 'notify'`) no se descartan por desfase de reloj del VPS
  assert.equal(isValidMessage(viejo, { isLive: true }), true);

  // Protobuf Long con .toNumber() también se respeta para mensajes no-live
  const viejoLong = {
    ...viejo,
    messageTimestamp: { toNumber: () => now() - 3600 },
  };
  assert.equal(isValidMessage(viejoLong), false);
  assert.equal(isValidMessage(viejoLong, { isLive: true }), true);

  // sin timestamp de conexión no se puede filtrar: se deja pasar
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
  // mismo id en otro chat/remite distinto no es duplicado
  assert.equal(isDuplicate('ID1', '51888@s.whatsapp.net', '.ping', cache, 3000, 150), false);
  // expirado
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

  const audioSticker = {
    message: {
      messageContextInfo: {},
      audioStickerMessage: {
        message: {
          stickerMessage: {
            mimetype: 'image/webp',
            audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
          },
        },
      },
    },
  };
  assert.equal(getMessageType(audioSticker), 'stickerMessage');
  assert.equal(isMediaMessage(audioSticker), true);
});
