/**
 * npm-install.js — Rikka-TakaradaMD
 * Comandos: .npm · .pip · .pip3 · .pkg · .apt · .dep · .sudo · .bash · .sh
 *
 * Solo el owner puede usarlo.
 * Auto-detecta Termux vs VPS para adaptar comandos.
 */

import { exec }     from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// ── Entorno ───────────────────────────────────────────────────────────────────
const isTermux = () =>
    process.env.PREFIX?.includes('com.termux') ||
    process.env.HOME?.includes('com.termux') ||
    !!process.env.TERMUX_VERSION;

const ENV = isTermux() ? 'Termux' : 'VPS/Linux';

// ── Ejecutar con timeout ──────────────────────────────────────────────────────
const run = async (cmd, timeout = 120_000) => {
    try {
        const { stdout, stderr } = await execPromise(cmd, { timeout, shell: '/bin/sh' });
        return { ok: true, out: (stdout + stderr).trim() };
    } catch (e) {
        return { ok: false, out: ((e.stdout || '') + (e.stderr || '') + (e.message || '')).trim() };
    }
};

const truncate = (str, max = 1800) =>
    str.length > max ? str.slice(0, max) + '\n…(output truncado)' : str;

// ── Menú de ayuda ─────────────────────────────────────────────────────────────
const HELP =
`╭━━━〔 🖥️ TERMINAL 〕━━━⬣
┃ *Entorno:* ${ENV}
┃
┃ 📦 *Paquetes:*
┃  ◈ *.npm* <pkg>       → npm install
┃  ◈ *.pip* / *.pip3* <pkg> → pip install
┃  ◈ *.pkg* <pkg>       → pkg/apt install
┃  ◈ *.apt* <pkg>       → apt install -y
┃  ◈ *.dep* <cmd>       → comando completo
┃                          (ej: sudo apt install python3 -y)
┃
┃ 💻 *Terminal:*
┃  ◈ *.sudo* <cmd>      → sudo <cmd>
┃  ◈ *.bash* / *.sh* <cmd> → bash -c "<cmd>"
╰━━━━━━━━━━━━━━━━━━━⬣

*Ejemplos:*
\`.npm yt-dlp-exec\`
\`.pip3 requests\`
\`.apt curl -y\`
\`.dep sudo apt install python3 -y\`
\`.dep sudo apt update\`
\`.sudo systemctl restart nginx\`
\`.bash echo $HOME\``;

// ─────────────────────────────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command, isOwner }) => {
    const socket = conn || client;

    if (!isOwner)
        return socket.sendMessage(m.chat,
            { text: '❌ Solo el *owner* puede usar comandos de terminal.' },
            { quoted: m });

    const input = text?.trim() || args.join(' ').trim();

    if (!input)
        return socket.sendMessage(m.chat, { text: HELP }, { quoted: m });

    await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

    let cmd;
    let label = input; // lo que se muestra como "paquete/comando"

    switch (command.toLowerCase()) {

        // ── Gestores de paquetes ──────────────────────────────────────────────
        case 'npm':
            cmd = `npm install ${input}`;
            break;

        case 'pip':
        case 'pip3': {
            const pipBin = isTermux() ? 'pip' : 'pip3';
            cmd = `${pipBin} install ${input}`;
            break;
        }

        case 'pkg':
            cmd = isTermux()
                ? `pkg install -y ${input}`
                : `apt-get install -y ${input} 2>/dev/null || apt install -y ${input}`;
            break;

        case 'apt':
            // Si el usuario ya incluyó flags como -y no los duplicamos
            cmd = input.includes('-y')
                ? `apt-get ${input} 2>/dev/null || apt ${input}`
                : `apt-get install -y ${input} 2>/dev/null || apt install -y ${input}`;
            break;

        // ── Comando libre (dep) — pasa el texto tal cual ──────────────────────
        case 'dep':
            cmd   = input;
            label = input;
            break;

        // ── sudo explícito ────────────────────────────────────────────────────
        case 'sudo':
            cmd   = `sudo ${input}`;
            label = `sudo ${input}`;
            break;

        // ── bash / sh ─────────────────────────────────────────────────────────
        case 'bash':
        case 'sh':
            cmd   = `bash -c ${JSON.stringify(input)}`;
            label = input;
            break;

        default:
            return socket.sendMessage(m.chat, { text: '❓ Comando no reconocido.' }, { quoted: m });
    }

    await socket.sendMessage(m.chat, {
        text: `⏳ Ejecutando en *${ENV}*…\n\`\`\`${cmd}\`\`\``,
    }, { quoted: m });

    const result = await run(cmd);

    const icon   = result.ok ? '✅' : '❌';
    const status = result.ok ? 'Completado' : 'Error';
    const output = truncate(result.out || '(sin output)');

    await socket.sendMessage(m.chat, {
        text:
`${icon} *${status}*
━━━━━━━━━━━━━━━━━━━━
💬 *Input:* ${label}
🖥️ *Entorno:* ${ENV}
⚙️ *Comando:* \`${cmd}\`
━━━━━━━━━━━━━━━━━━━━
\`\`\`${output}\`\`\``,
    }, { quoted: m });

    await socket.sendMessage(m.chat, {
        react: { text: result.ok ? '✅' : '❌', key: m.key },
    });
};

handler.help    = ['npm <pkg>', 'pip <pkg>', 'pip3 <pkg>', 'pkg <pkg>', 'apt <pkg>', 'dep <cmd>', 'sudo <cmd>', 'bash <cmd>', 'sh <cmd>'];
handler.tags    = ['owner'];
handler.command = /^(npm|pip|pip3|pkg|apt|dep|sudo|bash|sh)$/i;
handler.owner   = true;

export default handler;
