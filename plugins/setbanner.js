import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, '../src/banner.jpg');

if (!existsSync(join(__dirname, '../src'))) {
  mkdirSync(join(__dirname, '../src'), { recursive: true });
}

const handler = async (m, { conn, isOwner, args }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  let buffer, url;
  if (args[0] && /^https?:\/\/.+\.(jpe?g|png|gif)$/i.test(args[0])) {
    url = args[0];
    try {
      const res = await fetch(url);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen desde la URL.');
    }
  } else {
    const q = m.quoted ? m.quoted : m;
    const mime = (q.msg || q).mimetype || q.mediaType || '';
    if (!q || !/image\/(png|jpe?g|gif)/.test(mime)) {
      return m.reply('꒰ ✗ ꒱ Responde a una *imagen* (jpg/png/gif) o pasa una URL válida.');
    }
    try {
      buffer = await q.download();
    } catch {
      return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');
    }
    url = 'local';
  }

  if (!buffer) return m.reply('꒰ ✗ ꒱ No se pudo obtener la imagen.');

  try {
    writeFileSync(BANNER_PATH, buffer);
    global.bannerBuffer = buffer;
    global.banner = url; // 🔥 esta línea actualiza el banner activo
    const settings = global.db.data.settings[conn.user.jid] || {};
    settings.banner = url;
    global.db.data.settings[conn.user.jid] = settings;

    await m.reply(
      `⭑ ₊ ⭒ \`BANNER ACTUALIZADO\` ꩜\n\n` +
      `🔗 URL:\n${url}`
    );
  } catch (e) {
    console.error('[setbanner]', e);
    return m.reply(`꒰ ✗ ꒱ Error al guardar el banner:\n\`${e.message}\``);
  }
};

handler.help  = ['setbanner'];
handler.tags  = ['owner'];
handler.command = ['setbanner', 'setbotbanner'];
handler.owner = true;

export default handler;
