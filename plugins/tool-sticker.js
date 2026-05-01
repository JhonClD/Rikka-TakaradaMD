import { sticker4, sticker6, addExif } from '../src/libraries/sticker.js';
import { Buffer } from 'buffer';

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const quoted = m.quoted ? m.quoted : m;
  const mime = (quoted.msg || quoted)?.mimetype || '';

  if (!mime) return m.reply(`❌ Cita o adjunta una imagen, video o GIF.\n_Uso: *${usedPrefix}${command}* [pack | autor]_`);

  const isImage = /image/.test(mime);
  const isVideo = /video/.test(mime);
  const isGif   = /gif/.test(mime) || quoted?.msg?.gifPlayback;

  if (!isImage && !isVideo && !isGif) return m.reply('❌ Formato no soportado.');

  const duration = quoted?.msg?.seconds || 0;
  if ((isVideo || isGif) && duration > 10) return m.reply('❌ Máximo 10 segundos.');

  // --- METADATOS DINÁMICOS ---
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const locale = 'es';
  const fecha = d.toLocaleDateString(locale, { day: 'numeric', month: 'numeric', year: 'numeric' });
  const hora  = d.toLocaleTimeString(locale, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });

  const user      = m.pushName || 'Usuario';
  const groupName = m.isGroup ? await conn.getName(m.chat) : 'Chat Privado';

  let packname = `––––––✧✧✧✧✧✧✧\n      ｡.ﾟ.  .ﾟ.｡\n❄️ Usuario: ${user} 🍂\n❄️ Bot: –––💎 † 𝚁𝙸𝙺𝙺𝙰 𝚃𝙰𝙺𝙰𝚁𝙰𝙳𝙰 † ◖✨`;
  let author   = `☀️ Fecha: ${fecha}\n☀️ ${hora} • –––✧✧ ᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎ ✧–––\n「 ${groupName} 」`;

  if (text) {
    const parts = text.split('|').map(s => s.trim());
    if (parts[0]) packname = parts[0];
    if (parts[1]) author   = parts[1];
  }

  // --- DESCARGA ---
  let mediaBuffer;
  try {
    mediaBuffer = await quoted.download();
  } catch (e) {
    console.error('Error al descargar:', e);
    return m.reply('❌ Error al descargar el archivo.');
  }

  if (!mediaBuffer) return m.reply('❌ No se pudo descargar el archivo.');

  // --- CONVERSIÓN A STICKER ---
  let webpBuffer;
  try {
    const fn  = (isVideo || isGif) ? sticker6 : sticker4;
    let rawWebp = await fn(mediaBuffer, null);

    // Normalizar el resultado según su tipo
    if (typeof rawWebp === 'string') {
      // Es una ruta de archivo temporal
      const { default: fs } = await import('fs');
      rawWebp = fs.readFileSync(rawWebp);

    } else if (Buffer.isBuffer(rawWebp)) {
      // Ya es un Buffer, no se hace nada

    } else if (rawWebp instanceof Uint8Array || ArrayBuffer.isView(rawWebp)) {
      // Vista tipada (Uint8Array, etc.)
      rawWebp = Buffer.from(rawWebp.buffer, rawWebp.byteOffset, rawWebp.byteLength);

    } else if (rawWebp && typeof rawWebp === 'object') {
      // Objeto con propiedad .data (sharp, jimp, etc.)
      if (rawWebp.data) {
        rawWebp = Buffer.isBuffer(rawWebp.data)
          ? rawWebp.data
          : Buffer.from(rawWebp.data);
      } else {
        throw new Error('La función sticker devolvió un objeto desconocido: ' + JSON.stringify(Object.keys(rawWebp)));
      }
    }

    // Garantizar Buffer final
    webpBuffer = Buffer.isBuffer(rawWebp) ? rawWebp : Buffer.from(rawWebp);

    // Inyectar metadatos EXIF
    webpBuffer = await addExif(webpBuffer, packname, author, [''], {});

  } catch (e) {
    console.error('Error en conversión de sticker:', e);
    return m.reply('❌ Error en la conversión.');
  }

  if (!webpBuffer || !Buffer.isBuffer(webpBuffer)) {
    return m.reply('❌ No se pudo generar el sticker.');
  }

  await conn.sendMessage(m.chat, { sticker: webpBuffer }, { quoted: m });
};

handler.help    = ['s'];
handler.tags    = ['tools'];
handler.command = ['s', 'sticker', 'st'];

export default handler;
      
