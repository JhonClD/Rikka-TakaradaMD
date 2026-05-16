import fetch from 'node-fetch';
import FormData from 'form-data';

// ✅ Catbox.moe = imágenes PERMANENTES (no expiran)
async function uploadToCatbox(buffer, mime) {
  const ext = mime.split('/')[1] || 'jpg';
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', buffer, { filename: `banner.${ext}`, contentType: mime });
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, headers: form.getHeaders() });
  if (!res.ok) throw new Error(`Catbox HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (url.startsWith('http')) return url;
  throw new Error('Catbox no devolvió URL válida');
}

// ✅ Fallback: Graph.org (también permanente)
async function uploadToGraph(buffer, mime) {
  const ext = mime.split('/')[1] || 'jpg';
  const form = new FormData();
  form.append('file', buffer, { filename: `banner.${ext}`, contentType: mime });
  const res = await fetch('https://graph.org/upload', { method: 'POST', body: form, headers: form.getHeaders() });
  const json = await res.json();
  const path = json?.[0]?.src;
  if (path) return `https://graph.org${path}`;
  throw new Error('Graph.org no devolvió URL');
}

// ✅ Fallback 2: uguu.se (temporal pero sirve de emergencia)
async function uploadToUguu(buffer, mime) {
  const ext = mime.split('/')[1] || 'jpg';
  const form = new FormData();
  form.append('files[]', buffer, { filename: `banner.${ext}`, contentType: mime });
  const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form, headers: form.getHeaders() });
  const json = await res.json();
  const url = json?.files?.[0]?.url;
  if (url) return url;
  throw new Error('Uguu falló');
}

async function uploadImage(buffer, mime) {
  // Intenta en orden: Catbox (permanente) → Graph.org → Uguu (temporal)
  for (const [name, fn] of [
    ['Catbox', uploadToCatbox],
    ['Graph.org', uploadToGraph],
    ['Uguu.se', uploadToUguu],
  ]) {
    try {
      const url = await fn(buffer, mime);
      console.log(`✅ [setbanner] Subido en ${name}: ${url}`);
      return { url, service: name };
    } catch (e) {
      console.log(`⚠️ [setbanner] ${name} falló: ${e.message}`);
    }
  }
  throw new Error('Todos los servidores fallaron al subir el banner');
}

const handler = async (m, { conn, args, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const settings = global.db.data.settings[conn.user.jid] || {};
  const value = args.join(' ').trim();

  // Si se pasa una URL directamente
  if (value.startsWith('http')) {
    settings.banner = value;
    global.db.data.settings[conn.user.jid] = settings;
    await m.reply(`╰─► ✰ Banner actualizado con URL directa ♡ ༉‧₊˚✧\n🔗 ${value}`);
    return;
  }

  // Si no hay imagen ni URL
  if (!m.quoted && !m.message?.imageMessage && !m.message?.videoMessage) {
    return m.reply(
      '꒰ ✗ ꒱ Cómo usar `.setbanner`:\n\n' +
      '1️⃣ Responde a una imagen con `.setbanner`\n' +
      '2️⃣ O envía `.setbanner https://tu-url.com/imagen.jpg`\n\n' +
      `📌 Banner actual: ${settings.banner || 'No configurado'}`
    );
  }

  await m.reply('⏳ Subiendo banner a la nube, espera...');

  const q = m.quoted ? m.quoted : m;
  const mime = (q.msg || q).mimetype || q.mediaType || 'image/jpeg';

  if (!/image\/(png|jpe?g|gif)|video\/mp4/.test(mime)) {
    return m.reply('꒰ ✗ ꒱ Responde a una imagen (JPG, PNG, GIF) o video MP4.');
  }

  const buffer = await q.download();
  if (!buffer) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');

  try {
    const { url, service } = await uploadImage(buffer, mime);
    settings.banner = url;
    global.db.data.settings[conn.user.jid] = settings;
    await m.reply(
      `╰─► ✰ Banner actualizado ♡ ༉‧₊˚✧\n` +
      `📤 Servidor: *${service}*\n` +
      `🔗 URL: ${url}`
    );
  } catch (e) {
    await m.reply(`꒰ ✗ ꒱ Error al subir: ${e.message}`);
  }
};

handler.help = ['setbanner'];
handler.tags = ['owner'];
handler.command = ['setbanner', 'setbotbanner'];
handler.owner = true;

export default handler;
