// Comando `speedtest`.
// La lógica de medición vive en src/libraries/speedtest.js (JavaScript nativo,
// sin Python). Este archivo solo se encarga del handler de WhatsApp.
import { runSpeedtest, speedtestReport } from '../src/libraries/speedtest.js';

const handler = async (m, { conn }) => {
  const status = await conn.sendMessage(m.chat, {
    text: '📡 _Midiendo la conexión con servidores de Ookla... puede tardar unos 30–60 segundos._',
  }, { quoted: m });

  try {
    const result = await runSpeedtest();
    const report = speedtestReport(result);

    if (report.image) {
      return await conn.sendMessage(m.chat, {
        image: { url: report.image },
        caption: report.text,
      }, { quoted: m });
    }

    return await conn.sendMessage(m.chat, { text: report.text }, { quoted: m });
  } catch (error) {
    const reason = error?.message || 'Error desconocido';
    return await conn.sendMessage(m.chat, {
      text: `❌ *No se pudo completar el speedtest.*\n${reason}`,
    }, { quoted: m });
  } finally {
    if (status?.key) {
      await conn.sendMessage(m.chat, { delete: status.key }).catch(() => {});
    }
  }
};

handler.help = ['speedtest'];
handler.tags = ['herramientas'];
handler.command = /^(speedtest|speed|stest)$/i;

export default handler;

// edición simulada del plugin
