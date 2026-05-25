import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, '../src/banner.jpg');
const IMGBB_KEY = 'cc54a2ff43201cff8ecca0f3336e850d';

if (!existsSync(join(__dirname, '../src'))) {
  mkdirSync(join(__dirname, '../src'), { recursive: true });
}

async function uploadToImgBB(buffer) {
  const form = new FormData();
  form.append('image', buffer.toString('base64'));
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json));
  return json.data.url;
}

const handler = async (m, { conn, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const q = m.quoted ? m.quoted : m;
  const mime = (q.msg || q).mimetype || q.mediaType || '';
  if (!q || !/image\/(png|jpe?g|gif)/.test(mime)) {
    return m.reply('꒰ ✗ ꒱ Responde a una *imagen* (jpg/png/gif) para cambiar el banner.');
  }

  let buffer;
  try {
    buffer = await q.download();
  } catch {
    return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');
  }
  if (!buffer) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');

  try {
    const url = await uploadToImgBB(buffer);
    writeFileSync(BANNER_PATH, buffer);
    global.bannerBuffer = buffer;
    const settings = global.db.data.settings[conn.user.jid] || {};
    settings.banner = url;
    global.db.data.settings[conn.user.jid] = settings;

    await m.reply(
      `⭑ ₊ ⭒ \`BANNER ACTUALIZADO\` ꩜\n\n` +
      `🔗 URL:\n${url}`
    );
  } catch (e) {
    console.error('[setbanner]', e);
    return m.reply(`꒰ ✗ ꒱ Error al subir a ImgBB:\n\`${e.message}\``);
  }
};

handler.help  = ['setbanner'];
handler.tags  = ['owner'];
handler.command = ['setbanner', 'setbotbanner'];
handler.owner = true;

export default handler;
