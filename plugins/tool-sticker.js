import { sticker4, sticker6, addExif } from '../src/libraries/sticker.js';

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const quoted = m.quoted ? m.quoted : m;
  const mime = (quoted.msg || quoted)?.mimetype || '';

  if (!mime) return m.reply(`❌ Cita o adjunta una imagen, video o GIF.\n_Uso: *${usedPrefix}${command}* [pack | autor]_`);

  const isImage = /image/.test(mime);
  const isVideo = /video/.test(mime);
  const isGif   = /gif/.test(mime) || quoted?.msg?.gifPlayback;

  if (!isImage && !isVideo && !isGif) return m.reply('❌ Formato no soportado. Usa una *imagen*, *video* o *GIF*.');

  const duration = quoted?.msg?.seconds || 0;
  if ((isVideo || isGif) && duration > 10) return m.reply('❌ El video/GIF no puede durar más de *10 segundos*.');

  let packname = global.packname || 'Rikka';
  let author   = global.author   || 'Bot';

  if (text) {
    const parts = text.split('|').map(s => s.trim());
    if (parts[0]) packname = parts[0];
    if (parts[1]) author   = parts[1];
  }

  let buffer;
  try {
    buffer = await quoted.download();
  } catch {
    return m.reply('❌ No se pudo descargar el archivo.');
  }

  let webpBuffer;
  try {
    const fn = (isVideo || isGif) ? sticker6 : sticker4;
    webpBuffer = await fn(buffer, null);
    webpBuffer = await addExif(webpBuffer, packname, author, [''], {});
  } catch (e) {
    console.error('[sticker]', e);
    return m.reply('❌ Error al convertir. Asegúrate de tener *ffmpeg* instalado.');
  }

  if (!webpBuffer || !Buffer.isBuffer(webpBuffer)) return m.reply('❌ No se pudo generar el sticker.');

  await conn.sendMessage(m.chat, { sticker: webpBuffer }, { quoted: m });
};

handler.help    = ['s [pack | autor]'];
handler.tags    = ['tools'];
handler.command = ['s', 'sticker', 'st'];

export default handler;
