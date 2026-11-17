import { downloadKey, listDownloads, cancelDownloads } from '../src/funcion/download-registry.js';

// Único punto de entrada para cancelar descargas. Los descargadores ya no
// declaran `cancelar|stop` en su handler.command, así que el comando responde
// una vez en lugar de una por cada plugin que lo reclamaba.
const NONE = '❌ *No tienes ninguna descarga activa* en este chat.';

const handler = async (m, { args, usedPrefix, command }) => {
  const key = downloadKey(m);
  const service = String(args[0] || '').toLowerCase().trim();

  if (!listDownloads(key).length) return m.reply(NONE);

  if (service && !listDownloads(key).some((job) => job.service === service)) {
    const disponibles = listDownloads(key).map((job) => `\`${job.service}\``).join(', ');
    return m.reply(`⚠️ No tienes ninguna descarga de *${service}* activa.\nActivas: ${disponibles}`);
  }

  const cancelled = cancelDownloads(key, service || undefined);
  if (!cancelled.length) return m.reply(NONE);

  const detalle = cancelled.map(({ label }) => `• ${label}`).join('\n');
  return m.reply(`⏹️ *Descarga cancelada:*\n${detalle}`);
};

handler.help = ['cancelar', 'stop <servicio?>'];
handler.tags = ['downloader'];
handler.command = /^(cancelar|stop)$/i;

export default handler;
