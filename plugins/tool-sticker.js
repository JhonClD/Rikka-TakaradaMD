import { sticker4, sticker6, addExif } from '../src/libraries/sticker.js';

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

  // --- OBTENCIÓN DE DATOS DINÁMICOS ---
  const d = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Madrid"})); 
  const locale = 'es';
  const fecha = d.toLocaleDateString(locale, { day: 'numeric', month: 'numeric', year: 'numeric' });
  const hora = d.toLocaleTimeString(locale, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });

  // Detectar el nombre del usuario y del grupo
  const user = m.pushName || 'Usuario';
  const groupName = m.isGroup ? await conn.getName(m.chat) : 'Chat Privado';

  // --- DISEÑO DE METADATOS ---
  // Packname: Con el nombre del usuario y el nombre del bot
  let packname = `––––––✧✧✧✧✧✧✧\n      ｡.ﾟ.  .ﾟ.｡\n❄️ Usuario: ${user} 🍂\n❄️ Bot: –––💎 † 𝚁𝙸𝙺𝙺𝙰 𝚃𝙰𝙺𝙰𝚁𝙰𝙳𝙰 † ◖✨`;
  
  // Autor: Con fecha, hora, tu nombre estético y el grupo
  let author = `☀️ Fecha: ${fecha}\n☀️ ${hora} • –––✧✧ ᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎ ✧–––\n「 ${groupName} 」`;

  if (text) {
    const parts = text.split('|').map(s => s.trim());
    if (parts[0]) packname = parts[0];
    if (parts[1]) author = parts[1];
  }

  let buffer;
  try {
    buffer = await quoted.download();
  } catch {
    return m.reply('❌ Error al descargar el archivo.');
  }

  let webpBuffer;
  try {
    const fn = (isVideo || isGif) ? sticker6 : sticker4;
    let rawWebp = await fn(buffer, null);

    // Corrección para evitar el error de .slice() en node-webpmux
    if (typeof rawWebp === 'string') {
      const fs = (await import('fs')).default;
      rawWebp = fs.readFileSync(rawWebp);
    }
    webpBuffer = Buffer.isBuffer(rawWebp) ? rawWebp : Buffer.from(rawWebp);

    // Inyectar los metadatos finales
    webpBuffer = await addExif(webpBuffer, packname, author, [''], {});
    
  } catch (e) {
    console.error(e);
    return m.reply('❌ Error en la conversión.');
  }

  if (!webpBuffer || !Buffer.isBuffer(webpBuffer)) return m.reply('❌ No se pudo generar el sticker.');

  await conn.sendMessage(m.chat, { sticker: webpBuffer }, { quoted: m });
};

handler.help    = ['s'];
handler.tags    = ['tools'];
handler.command = ['s', 'sticker', 'st'];

export default handler;
    
