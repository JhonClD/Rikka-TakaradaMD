// Comando `speedtest`.
// La lógica de medición vive en src/libraries/speedtest.js (JavaScript nativo,
// sin Python). Este archivo solo se encarga del handler de WhatsApp.
import { runSpeedtest, speedtestReport } from '../src/libraries/speedtest.js';

const PHASE_TEXT = {
  servers: '🔎 _Buscando servidores de Ookla..._',
  ping: '📶 _Midiendo latencia y eligiendo el mejor servidor..._',
  download: '⬇️ _Midiendo velocidad de descarga (~10 s)..._',
  upload: '⬆️ _Midiendo velocidad de subida (~10 s)..._',
  share: '🧾 _Generando el resultado..._',
};

// Un speedtest satura la conexión: una sola medición a la vez evita
// resultados falsos y abusos del comando.
let running = false;

const handler = async (m, { conn }) => {
  if (running) {
    return await conn.sendMessage(m.chat, {
      text: '⏳ Ya hay un speedtest en curso. Espera a que termine para pedir otro.',
    }, { quoted: m });
  }
  running = true;

  const status = await conn.sendMessage(m.chat, {
    text: '📡 _Iniciando speedtest con servidores de Ookla... puede tardar unos 30–60 segundos._',
  }, { quoted: m });

  const setPhase = (phase, server) => {
    if (!status?.key || !PHASE_TEXT[phase]) return;
    const where = server?.sponsor && server.sponsor !== 'N/A' ? `\n🖥️ _${server.sponsor}_` : '';
    conn.sendMessage(m.chat, { text: PHASE_TEXT[phase] + where, edit: status.key }).catch(() => {});
  };

  try {
    const result = await runSpeedtest({ onProgress: setPhase });
    const report = speedtestReport(result);

    if (report.image) {
      try {
        return await conn.sendMessage(m.chat, {
          image: { url: report.image },
          caption: report.text,
        }, { quoted: m });
      } catch {
        // Si la imagen del resultado no se puede descargar, se envía solo el texto.
      }
    }

    return await conn.sendMessage(m.chat, { text: report.text }, { quoted: m });
  } catch (error) {
    const reason = error?.message || 'Error desconocido';
    console.error('[speedtest]', error);
    return await conn.sendMessage(m.chat, {
      text: `❌ *No se pudo completar el speedtest.*\n${reason}`,
    }, { quoted: m });
  } finally {
    running = false;
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
