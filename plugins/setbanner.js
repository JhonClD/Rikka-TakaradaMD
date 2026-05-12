import fetch from 'node-fetch';
import FormData from 'form-data';

async function uploadImage(buffer, mime) {
  const body = new FormData();
  body.append('files[]', buffer, `file.${mime.split('/')[1]}`);
  const res = await fetch('https://uguu.se/upload.php', { method: 'POST', body, headers: body.getHeaders() });
  const json = await res.json();
  return json.files?.[0]?.url;
}

const handler = async (m, { conn, args, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const settings = global.db.data.settings[conn.user.jid] || {};
  const value = args.join(' ').trim();

  if (!value && !m.quoted && !m.message?.imageMessage && !m.message?.videoMessage) {
    return m.reply('꒰ ✗ ꒱ Debes enviar o citar una imagen/video para cambiar el banner.');
  }

  if (value.startsWith('http')) {
    settings.banner = value;
    global.db.data.settings[conn.user.jid] = settings;
    return m.reply('╰─► ✰ Banner del bot actualizado ♡ ༉‧₊˚✧');
  }

  const q = m.quoted ? m.quoted : m;
  const mime = (q.msg || q).mimetype || q.mediaType || '';
  if (!/image\/(png|jpe?g|gif)|video\/mp4/.test(mime)) return m.reply('꒰ ✗ ꒱ Responde a una imagen o video válido.');

  const buffer = await q.download();
  if (!buffer) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');

  const url = await uploadImage(buffer, mime);
  settings.banner = url;
  global.db.data.settings[conn.user.jid] = settings;
  return m.reply('╰─► ✰ Banner del bot actualizado ♡ ༉‧₊˚✧');
};

handler.help = ['setbanner'];
handler.tags = ['owner'];
handler.command = ['setbanner', 'setbotbanner'];
handler.owner = true;

export default handler;
