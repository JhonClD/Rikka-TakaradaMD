/**
 * install.js — Rikka-TakaradaMD
 * Comandos: .npm · .pkg · .pip
 *
 * Solo el owner puede usarlo.
 * Auto-detecta Termux vs VPS para adaptar los comandos.
 */

import { exec }     from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// ── Detección de entorno ──────────────────────────────────────────────────────
const isTermux = () =>
    process.env.PREFIX?.includes('com.termux') ||
    process.env.HOME?.includes('com.termux') ||
    !!process.env.TERMUX_VERSION;

const ENV = isTermux() ? 'Termux' : 'VPS/Linux';

// ── Ejecutar con timeout y capturar stdout + stderr ───────────────────────────
const run = async (cmd, timeout = 120_000) => {
    try {
        const { stdout, stderr } = await execPromise(cmd, { timeout });
        return { ok: true, out: (stdout + stderr).trim() };
    } catch (e) {
        return { ok: false, out: (e.stdout + e.stderr + e.message).trim() };
    }
};

// ── Truncar output largo ──────────────────────────────────────────────────────
const truncate = (str, max = 1800) =>
    str.length > max ? str.slice(0, max) + '\n…(output truncado)' : str;

// ─────────────────────────────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command, isOwner }) => {
    const socket = conn || client;

    if (!isOwner)
        return socket.sendMessage(m.chat,
            { text: '❌ Solo el *owner* puede instalar dependencias.' },
            { quoted: m });

    const pkg = text?.trim() || args.join(' ').trim();

    if (!pkg)
        return socket.sendMessage(m.chat, {
            text:
`╭━━━〔 📦 INSTALADOR 〕━━━⬣
┃ *Entorno detectado:* ${ENV}
┃
┃ *Comandos disponibles:*
┃  ◈ *.npm* <paquete>   → npm install
┃  ◈ *.pip* <paquete>   → pip install
┃  ◈ *.pkg* <paquete>   → pkg install (Termux)
┃                          apt install (VPS)
╰━━━━━━━━━━━━━━━━━━━⬣

*Ejemplos:*
.npm yt-dlp-exec
.pip yt-dlp
.pkg ffmpeg`,
        }, { quoted: m });

    await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

    let cmd;

    // ── npm ───────────────────────────────────────────────────────────────────
    if (command === 'npm') {
        cmd = `npm install ${pkg}`;

    // ── pip ───────────────────────────────────────────────────────────────────
    } else if (command === 'pip') {
        // En Termux usamos pip directamente; en VPS pip3
        const pipBin = isTermux() ? 'pip' : 'pip3';
        cmd = `${pipBin} install ${pkg}`;

    // ── pkg / apt ─────────────────────────────────────────────────────────────
    } else if (command === 'pkg') {
        if (isTermux()) {
            cmd = `pkg install -y ${pkg}`;
        } else {
            // En VPS intentar apt-get, luego apt
            cmd = `apt-get install -y ${pkg} 2>/dev/null || apt install -y ${pkg}`;
        }
    }

    await socket.sendMessage(m.chat, {
        text: `⏳ Instalando *${pkg}* vía *${command}* en ${ENV}…`,
    }, { quoted: m });

    const result = await run(cmd);

    const icon   = result.ok ? '✅' : '❌';
    const status = result.ok ? 'Instalado correctamente' : 'Error al instalar';
    const output = truncate(result.out || '(sin output)');

    await socket.sendMessage(m.chat, {
        text:
`${icon} *${status}*
━━━━━━━━━━━━━━━━━━━━
📦 *Paquete:* ${pkg}
🖥️ *Entorno:* ${ENV}
⚙️ *Comando:* \`${cmd}\`
━━━━━━━━━━━━━━━━━━━━
\`\`\`${output}\`\`\``,
    }, { quoted: m });

    await socket.sendMessage(m.chat, {
        react: { text: result.ok ? '✅' : '❌', key: m.key },
    });
};

handler.help    = ['npm <paquete>', 'pip <paquete>', 'pkg <paquete>'];
handler.tags    = ['owner'];
handler.command = /^(npm|pip|pkg)$/i;
handler.owner   = true;

export default handler;
                                    
