/*
 ☆ Plugin: Stickers Full — Creación, Recorte, Círculo, WM y Conversión inversa
 ☆ Comandos:
 ☆   .s / .sticker / .st [pack | autor]     → sticker (imagen, video, GIF, sticker o URL)
 ☆   .s -crop / .scrop / .sfull             → sticker cuadrado 1:1 sin bordes
 ☆   .s -circle / .scircle / .sredondo      → sticker circular
 ☆   .wm / .take / .robar [pack | autor]    → cambia pack/autor de un sticker sin perder calidad
 ☆   .toimg / .tovid                        → convierte un sticker a imagen PNG o video MP4
*/

import { Buffer } from 'node:buffer';
import {
  addExif,
  createSticker,
  isAnimatedWebp,
  isValidWebp,
  sticker5,
  stickerToMedia,
  toBuffer,
} from '../src/libraries/sticker.js';

const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 10;
const MAX_METADATA_LENGTH = 180;

const STICKER_COMMANDS = [
  's',
  'sticker',
  'st',
  'scrop',
  'sfull',
  'scircle',
  'sredondo',
  'wm',
  'take',
  'robar',
  'toimg',
  'tovid',
];

const URL_REGEX = /https?:\/\/[^\s<>]+/i;

const cleanMetadata = (value, fallback) => {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_LENGTH);
  return cleaned || fallback;
};

const getMediaMessage = (message) => message?.msg || message || {};

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return;
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
  } catch {}
}

function parseModeAndText(command, rawText) {
  const cmd = String(command || '').toLowerCase();
  let mode = 'default';
  if (cmd === 'scrop' || cmd === 'sfull') mode = 'crop';
  else if (cmd === 'scircle' || cmd === 'sredondo') mode = 'circle';

  let remaining = String(rawText || '').trim();

  // Soporta flags opcionales como `.s -crop Pack | Autor` o `.s -circle`
  const flagMatch = remaining.match(/^(?:--?(crop|full|c|circle|redondo|r))\b\s*/i);
  if (flagMatch) {
    const flag = flagMatch[1].toLowerCase();
    if (flag === 'crop' || flag === 'full' || flag === 'c') mode = 'crop';
    else mode = 'circle';
    remaining = remaining.slice(flagMatch[0].length).trim();
  }

  return { mode, remaining };
}

async function buildMetadata(m, conn, rawMeta) {
  const parts = String(rawMeta || '')
    .split('|', 2)
    .map((p) => p.trim());
  const user = cleanMetadata(m.pushName, 'Usuario');
  const groupName = m.isGroup
    ? cleanMetadata(await conn.getName(m.chat).catch(() => 'Grupo'), 'Grupo')
    : 'Chat privado';
  const now = new Date();
  const date = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  const packname = cleanMetadata(parts[0], `Rikka Takarada • ${user}`);
  const author = cleanMetadata(parts[1], `${date} ${time} • ${groupName}`);
  return { packname, author };
}

async function downloadFromUrl(url) {
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_INPUT_BYTES) {
    throw new Error('El archivo en la URL supera los 30 MB.');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('La URL devolvió un archivo vacío.');
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error('El archivo en la URL supera los 30 MB.');
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error('La URL apunta a una página web, no a una imagen/video directo.');
  }

  return { buffer, mime: contentType.split(';')[0].trim() };
}

async function convertToWebp(mediaBuffer, { isAnimated, mode, packname, author }) {
  try {
    return await createSticker(mediaBuffer, {
      isAnimated,
      mode,
      maxSeconds: MAX_VIDEO_SECONDS,
    });
  } catch (err) {
    console.warn('[sticker] Falló ffmpeg directo, probando wa-sticker-formatter:', err?.message || err);
    return toBuffer(
      await sticker5(mediaBuffer, null, packname, author, ['✨'], {
        type: mode === 'crop' ? 'crop' : mode === 'circle' ? 'circle' : 'default',
      }),
    );
  }
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const cmd = String(command || '').toLowerCase();
  const quoted = m?.quoted || m;
  const media = getMediaMessage(quoted);
  const mime = String(media.mimetype || '').toLowerCase();

  // ── Modo .toimg / .tovid (sticker → PNG o MP4) ──────────────
  if (cmd === 'toimg' || cmd === 'tovid') {
    if (!mime.includes('webp')) {
      return m.reply(`✖ Responde a un *sticker* con *${usedPrefix + cmd}* para convertirlo.`);
    }

    await safeReact(conn, m, '⏳');
    try {
      const webpBuf = toBuffer(await quoted.download());
      const out = await stickerToMedia(webpBuf, { forceVideo: cmd === 'tovid' });

      if (out.kind === 'video') {
        await conn.sendMessage(
          m.chat,
          { video: out.buffer, mimetype: 'video/mp4' },
          { quoted: m },
        );
      } else {
        await conn.sendMessage(
          m.chat,
          { image: out.buffer, mimetype: 'image/png' },
          { quoted: m },
        );
      }
      await safeReact(conn, m, '✅');
    } catch (error) {
      console.error(`[${cmd}] Error:`, error?.message || error);
      await safeReact(conn, m, '❌');
      return m.reply('❌ No se pudo convertir el sticker.');
    }
    return;
  }

  // ── Modo .wm / .take / .robar (cambiar pack/autor sin recomprimir) ─
  if (cmd === 'wm' || cmd === 'take' || cmd === 'robar') {
    if (!mime.includes('webp')) {
      return m.reply(
        `✖ Responde a un *sticker* con *${usedPrefix + cmd} [pack | autor]* para cambiar su marca de agua.`,
      );
    }

    await safeReact(conn, m, '⏳');
    try {
      const webpBuf = toBuffer(await quoted.download());
      if (!isValidWebp(webpBuf)) {
        await safeReact(conn, m, '❌');
        return m.reply('❌ El mensaje citado no es un sticker WebP válido.');
      }

      const { packname, author } = await buildMetadata(m, conn, text);
      const stamped = await addExif(webpBuf, packname, author, ['✨']);
      await conn.sendMessage(m.chat, { sticker: stamped }, { quoted: m });
      await safeReact(conn, m, '✅');
    } catch (error) {
      console.error(`[${cmd}] Error:`, error?.message || error);
      await safeReact(conn, m, '❌');
      return m.reply('❌ No se pudo actualizar el pack/autor del sticker.');
    }
    return;
  }

  // ── Modo creación de sticker (.s, .scrop, .scircle, etc.) ───
  const { mode, remaining } = parseModeAndText(cmd, text);
  const urlMatch = !mime ? remaining.match(URL_REGEX) : null;
  const mediaUrl = urlMatch ? urlMatch[0].replace(/[),.!?;:'"\]}>]+$/g, '') : null;
  const metaText = mediaUrl ? remaining.replace(urlMatch[0], '').trim() : remaining;

  if (!mime && !mediaUrl) {
    return m.reply(
      `✦ *Stickers* ✦\n\n` +
        `▸ *Normal:* ${usedPrefix}s [pack | autor]\n` +
        `▸ *Cuadrado (1:1):* ${usedPrefix}scrop [pack | autor]\n` +
        `▸ *Circular:* ${usedPrefix}scircle [pack | autor]\n` +
        `▸ *Cambiar WM:* ${usedPrefix}wm [pack | autor]\n` +
        `▸ *A imagen/video:* ${usedPrefix}toimg / ${usedPrefix}tovid\n\n` +
        `_Adjunta o responde a una imagen, video, GIF, sticker o pega un enlace directo._`,
    );
  }

  await safeReact(conn, m, '⏳');

  let mediaBuffer;
  let effectiveMime = mime;

  try {
    if (mediaUrl) {
      const downloaded = await downloadFromUrl(mediaUrl);
      mediaBuffer = downloaded.buffer;
      effectiveMime = downloaded.mime;
    } else {
      mediaBuffer = toBuffer(await quoted.download());
    }
  } catch (error) {
    console.error('[sticker] Error al descargar:', error?.message || error);
    await safeReact(conn, m, '❌');
    return m.reply(`❌ No se pudo descargar el archivo.\n\`${error?.message || error}\``);
  }

  if (!mediaBuffer?.length) {
    await safeReact(conn, m, '❌');
    return m.reply('❌ El archivo está vacío.');
  }
  if (mediaBuffer.length > MAX_INPUT_BYTES) {
    await safeReact(conn, m, '❌');
    return m.reply('❌ El archivo supera el límite máximo de 30 MB.');
  }

  const isWebpInput = effectiveMime.includes('webp') || isValidWebp(mediaBuffer);
  const isImage = effectiveMime.startsWith('image/') || isWebpInput;
  const isVideo = effectiveMime.startsWith('video/');
  const isGif = effectiveMime === 'image/gif' || Boolean(media.gifPlayback);
  const isAnimated = isVideo || isGif || (isWebpInput && isAnimatedWebp(mediaBuffer));

  if (!isImage && !isVideo && !isGif) {
    await safeReact(conn, m, '❌');
    return m.reply('❌ Formato no soportado. Usa una imagen, video, GIF o sticker.');
  }

  const { packname, author } = await buildMetadata(m, conn, metaText);

  let webpBuffer;
  try {
    // Si ya es un sticker WebP en modo default, solo re-estampamos el EXIF sin perder calidad
    if (isWebpInput && mode === 'default') {
      webpBuffer = await addExif(mediaBuffer, packname, author, ['✨']);
    } else {
      const rawWebp = await convertToWebp(mediaBuffer, {
        isAnimated,
        mode,
        packname,
        author,
      });
      webpBuffer = await addExif(rawWebp, packname, author, ['✨']);
    }
  } catch (error) {
    console.error('[sticker] Error en conversión:', error?.stack || error);
    await safeReact(conn, m, '❌');
    return m.reply('❌ No se pudo convertir el archivo a sticker. Verifica que FFmpeg esté disponible.');
  }

  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
    await safeReact(conn, m, '❌');
    return m.reply('❌ La conversión no produjo un sticker válido.');
  }

  try {
    await conn.sendMessage(m.chat, { sticker: webpBuffer }, { quoted: m });
    await safeReact(conn, m, '✅');
  } catch (error) {
    console.error('[sticker] Error al enviar:', error?.message || error);
    await safeReact(conn, m, '❌');
    return m.reply('❌ El sticker se generó, pero no se pudo enviar.');
  }
};

handler.help = [
  's [pack | autor]',
  'scrop [pack | autor]',
  'scircle [pack | autor]',
  'wm [pack | autor]',
  'toimg',
  'tovid',
];
handler.tags = ['tools'];
handler.command = STICKER_COMMANDS;

export default handler;
