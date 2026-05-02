import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const SCRIPT = join(process.cwd(), 'src', 'libraries', 'ookla-speedtest.py');
const TIMEOUT = 180000;

function formatMbps(bitsPerSecond = 0) {
  return `${(Number(bitsPerSecond) / 1_000_000).toFixed(2)} Mbps`;
}

function formatMb(bytes = 0) {
  return `${((Number(bytes) * 8) / 1_000_000).toFixed(2)} Mb`;
}

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function parseSpeedtestJson(stdout) {
  const raw = String(stdout || '').trim();
  const match = raw.match(/\{[\s\S]*\}$/);
  if (!match) throw new Error('Speedtest no devolvió JSON válido.');
  return JSON.parse(match[0]);
}

async function runSpeedtest() {
  const commands = [
    process.env.PYTHON ? { bin: process.env.PYTHON, prefix: [] } : null,
    { bin: 'python', prefix: [] },
    { bin: 'py', prefix: ['-3'] },
    { bin: 'python3', prefix: [] },
  ].filter(Boolean);

  let lastError;
  for (const cmd of commands) {
    try {
      const args = [...cmd.prefix, SCRIPT, '--json', '--share', '--secure'];
      const { stdout } = await execFileAsync(cmd.bin, args, {
        timeout: TIMEOUT,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return parseSpeedtestJson(stdout);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(lastError?.killed
    ? 'El speedtest tardó demasiado y fue cancelado.'
    : `No pude ejecutar Python para el speedtest: ${lastError?.message || 'error desconocido'}`);
}

function buildCaption(result) {
  const server = result.server || {};
  const client = result.client || {};

  return [
    '📡 *Speedtest completado*',
    '',
    `⬇️ *Descarga:* ${formatMbps(result.download)}`,
    `⬆️ *Subida:* ${formatMbps(result.upload)}`,
    `📶 *Ping:* ${Number(result.ping || 0).toFixed(2)} ms`,
    '',
    `🏢 *Servidor:* ${server.sponsor || 'N/A'}`,
    `📍 *Ubicación:* ${[server.name, server.country].filter(Boolean).join(', ') || 'N/A'}`,
    `🆔 *ID:* ${server.id || 'N/A'}`,
    '',
    `🌐 *ISP:* ${client.isp || 'N/A'}`,
    `📦 *Recibido:* ${formatMb(result.bytes_received)}`,
    `📤 *Enviado:* ${formatMb(result.bytes_sent)}`,
    `🕒 *Fecha:* ${formatDate(result.timestamp)}`,
  ].join('\n');
}

const handler = async (m, { conn }) => {
  await conn.sendMessage(m.chat, {
    text: '📡 _Ejecutando speedtest... puede tardar 1 o 2 minutos._',
  }, { quoted: m });

  const result = await runSpeedtest();
  const caption = buildCaption(result);

  if (result.share) {
    return conn.sendMessage(m.chat, {
      image: { url: result.share },
      caption,
    }, { quoted: m });
  }

  return conn.sendMessage(m.chat, { text: caption }, { quoted: m });
};

handler.help = ['speedtest'];
handler.tags = ['herramientas'];
handler.command = /^(speedtest|speed|stest)$/i;

export default handler;
