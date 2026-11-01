import { sticker4, sticker5, sticker6, addExif } from '../src/libraries/sticker.js';
import { Buffer } from 'buffer';

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 10;
const MAX_METADATA_LENGTH = 180;
const STICKER_COMMANDS = ['s', 'sticker', 'st'];

const cleanMetadata = (value, fallback) => {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_LENGTH);
  return cleaned || fallback;
};

const getMediaMessage = (message) => message?.msg || message || {};

const normalizeBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value && typeof value === 'object' && value.data) {
    return normalizeBuffer(value.data);
  }
  throw new TypeError('La conversión no devolvió un Buffer válido.');
};

const convertLocally = async (mediaBuffer, isAnimated, packname, author) => {
  const methods = isAnimated
    ? [
        ['ffmpeg', () => sticker6(mediaBuffer, null)],
        ['wa-sticker-formatter', () => sticker5(mediaBuffer, null, packname, author, [''], {})],
      ]
    : [
        ['ffmpeg', () => sticker4(mediaBuffer, null)],
        ['wa-sticker-formatter', () => sticker5(mediaBuffer, null, packname, author, [''], {})],
      ];

  let lastError;
  for (const [name, convert] of methods) {
    try {
      return normalizeBuffer(await convert());
    } catch (error) {
      lastError = error;
      console.error(`[sticker] Falló ${name}:`, error?.message || error);
    }
  }
  throw lastError || new Error('No hay un conversor local disponible.');
};

const handler = async (m, { conn, text }) => {
  const quoted = m?.quoted || m;
  const media = getMediaMessage(quoted);
  const mime = String(media.mimetype || '').toLowerCase();

  if (!mime) {
    return m.reply(
      '✖ *Error:* Adjunta o cita una imagen/video/GIF.\n▸ *Sintaxis:* `/s [pack | autor]`',
    );
  }

  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isGif = mime === 'image/gif' || Boolean(media.gifPlayback);
  const isAnimated = isVideo || isGif;

  if (!isImage && !isVideo && !isGif) {
    return m.reply('❌ Formato no soportado. Usa una imagen, video o GIF.');
  }

  const duration = Number(media.seconds || media.duration || 0);
  if (isAnimated && Number.isFinite(duration) && duration > MAX_VIDEO_SECONDS) {
    return m.reply(`❌ El video o GIF no puede durar más de ${MAX_VIDEO_SECONDS} segundos.`);
  }

  let mediaBuffer;
  try {
    mediaBuffer = normalizeBuffer(await quoted.download());
  } catch (error) {
    console.error('[sticker] Error al descargar:', error?.message || error);
    return m.reply('❌ No se pudo descargar el archivo.');
  }

  if (!mediaBuffer.length) return m.reply('❌ El archivo está vacío.');
  if (mediaBuffer.length > MAX_INPUT_BYTES) {
    return m.reply('❌ El archivo es demasiado grande. El límite es de 25 MB.');
  }

  const parts = String(text || '').split('|', 2).map((part) => part.trim());
  const user = cleanMetadata(m.pushName, 'Usuario');
  const groupName = m.isGroup
    ? cleanMetadata(await conn.getName(m.chat).catch(() => 'Grupo'), 'Grupo')
    : 'Chat privado';
  const now = new Date();
  const date = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(now);

  const packname = cleanMetadata(parts[0], `Rikka Takarada • ${user}`);
  const author = cleanMetadata(
    parts[1],
    `Rikka Takarada • ${date} ${time} • ${groupName}`,
  );

  let webpBuffer;
  try {
    const rawWebp = await convertLocally(mediaBuffer, isAnimated, packname, author);
    webpBuffer = await addExif(rawWebp, packname, author, [''], {});
  } catch (error) {
    console.error('[sticker] Error en conversión:', error?.stack || error);
    return m.reply(
      '❌ No se pudo convertir el archivo. Comprueba que FFmpeg esté instalado y vuelve a intentarlo.',
    );
  }

  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
    return m.reply('❌ La conversión no produjo un sticker válido.');
  }

  try {
    await conn.sendMessage(m.chat, { sticker: webpBuffer }, { quoted: m });
  } catch (error) {
    console.error('[sticker] Error al enviar:', error?.message || error);
    return m.reply('❌ El sticker se generó, pero no se pudo enviar.');
  }
};

handler.help = STICKER_COMMANDS;
handler.tags = ['tools'];
handler.command = STICKER_COMMANDS;

export default handler;
