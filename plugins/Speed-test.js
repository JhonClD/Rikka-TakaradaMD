import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const handler = async (m, { conn }) => {
  const { key: statusKey } = await conn.sendMessage(m.chat, {
    text: '🌐 *Analizando velocidad del servidor...*\n_Esto puede tardar ~30 segundos_'
  }, { quoted: m });

  const edit = async (txt) => {
    try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }); } catch (_) {}
  };

  try {
    // Intentar con speedtest-cli (Python) o fast-cli o npx speed-cloudflare-cli
    let result = null;

    // ── Método 1: speedtest-cli (más común en VPS Linux) ──────────────────────
    try {
      const { stdout } = await execAsync('speedtest-cli --json', { timeout: 60000 });
      const data = JSON.parse(stdout);
      result = {
        download : (data.download / 1_000_000).toFixed(2),   // bps → Mbps
        upload   : (data.upload   / 1_000_000).toFixed(2),
        ping     : data.ping.toFixed(1),
        isp      : data.client?.isp || '—',
        ip       : data.client?.ip  || '—',
        server   : `${data.server?.name || '—'}, ${data.server?.country || ''}`.trim(),
        url      : data.share || 'https://www.speedtest.net/es',
      };
    } catch (_) {}

    // ── Método 2: speedtest (CLI oficial Ookla) ───────────────────────────────
    if (!result) {
      try {
        const { stdout } = await execAsync('speedtest --format=json --accept-license --accept-gdpr', { timeout: 60000 });
        const data = JSON.parse(stdout);
        result = {
          download : (data.download?.bandwidth * 8 / 1_000_000).toFixed(2),
          upload   : (data.upload?.bandwidth   * 8 / 1_000_000).toFixed(2),
          ping     : data.ping?.latency?.toFixed(1) || '—',
          isp      : data.isp || '—',
          ip       : data.interface?.externalIp || '—',
          server   : `${data.server?.name || '—'}, ${data.server?.country || ''}`.trim(),
          url      : data.result?.url || 'https://www.speedtest.net/es',
        };
      } catch (_) {}
    }

    // ── Método 3: curl a fast.com API (Fallback sin instalación) ─────────────
    if (!result) {
      try {
        // Medir descarga con curl durante 10 seg contra un CDN
        const dlCmd = `curl -o /dev/null -s -w "%{speed_download}" --max-time 10 https://speed.cloudflare.com/__down?bytes=100000000`;
        const ulCmd = `curl -o /dev/null -s -w "%{speed_upload}" --max-time 10 -X POST --data-binary @/dev/urandom https://speed.cloudflare.com/__up`;
        const pingCmd = `ping -c 4 -q 1.1.1.1 | tail -1 | awk -F '/' '{print $5}'`;

        const [dlRes, pingRes] = await Promise.all([
          execAsync(dlCmd,  { timeout: 15000 }),
          execAsync(pingCmd,{ timeout: 10000 }),
        ]);

        const dlMbps = (parseFloat(dlRes.stdout) * 8 / 1_000_000).toFixed(2);
        const ping   = parseFloat(pingRes.stdout).toFixed(1);

        result = {
          download : dlMbps,
          upload   : 'N/A',
          ping,
          isp      : '—',
          ip       : '—',
          server   : 'Cloudflare CDN',
          url      : 'https://www.speedtest.net/es',
        };
      } catch (_) {}
    }

    if (!result) throw new Error('No se pudo medir la velocidad. Instala speedtest-cli:\n`pip install speedtest-cli`');

    await edit(
      `╭─── 🌐 *SPEED TEST · VPS* ───╮\n` +
      `│\n` +
      `│  ⬇️  *Descarga* ꩜  \`${result.download} Mbps\`\n` +
      `│  ⬆️  *Subida*   ꩜  \`${result.upload} Mbps\`\n` +
      `│  📡  *Ping*     ꩜  \`${result.ping} ms\`\n` +
      `│\n` +
      `│  🖥️  *Servidor* ꩜  ${result.server}\n` +
      `│  🏢  *ISP*      ꩜  ${result.isp}\n` +
      `│  🌍  *IP*       ꩜  \`${result.ip}\`\n` +
      `│\n` +
      `│  🔗  ${result.url}\n` +
      `╰──────────────────────────────╯`
    );

  } catch (e) {
    console.error('[speedtest]', e.message);
    await edit(`❌ *Error:* ${e.message}`);
  }
};

handler.help    = ['speedtest', 'speed'];
handler.tags    = ['tools'];
handler.command = /^(speedtest|speed|velocidad|netspeed)$/i;

export default handler;
