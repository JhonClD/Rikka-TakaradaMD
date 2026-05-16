import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Ruta donde se guarda el banner (dentro del proyecto)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, '../src/banner.jpg');

// Asegura que la carpeta src/ exista
if (!existsSync(join(__dirname, '../src'))) {
  mkdirSync(join(__dirname, '../src'), { recursive: true });
}

const handler = async (m, { conn, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  // Verificar que haya una imagen
  const q = m.quoted ? m.quoted : m;
  const mime = (q.msg || q).mimetype || q.mediaType || '';
  if (!q || !/image\/(png|jpe?g|gif)/.test(mime)) {
    return m.reply('꒰ ✗ ꒱ Responde a una *imagen* (jpg/png/gif) para cambiar el banner.');
  }

  await m.reply(global.wait || '_[ ⏳ ] Guardando banner..._');

  let buffer;
  try {
    buffer = await q.download();
  } catch {
    return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');
  }
  if (!buffer) return m.reply('꒰ ✗ ꒱ No se pudo descargar la imagen.');

  try {
    // Guardar imagen en disco
    writeFileSync(BANNER_PATH, buffer);

    // Guardar en la base de datos como flag para que el menú sepa que existe
    const settings = global.db.data.settings[conn.user.jid] || {};
    settings.banner = 'local'; // el menú leerá el archivo del disco
    global.db.data.settings[conn.user.jid] = settings;

    // Actualizar global.imagen1 en caliente (sin reiniciar el bot)
    global.bannerBuffer = buffer;

    await m.reply('╰─► ✰ *Banner actualizado permanentemente* ♡ ༉‧₊˚✧\n\n_La imagen está guardada en el servidor y no expirará._');
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
