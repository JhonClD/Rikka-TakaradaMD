/**
 * ytmp3.js  —  Rikka-TakaradaMD
 * Comandos: ytmp3 · ytmp3doc · yta
 *
 * Lógica de scraping delegada a → src/libraries/youtube-scraper.js
 */

import {
    YT_REGEX,
    ytDownload,
    buildInfoCard,
} from '../src/libraries/youtube-scraper.js';

// ─────────────────────────────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command }) => {
    const socket = conn || client;
    const url    = text || args[0];

    if (!url)
        return socket.sendMessage(m.chat,
            { text: `《✧》 Por favor, ingresa un enlace de YouTube válido.` },
            { quoted: m });

    if (!YT_REGEX.test(url))
        return socket.sendMessage(m.chat,
            { text: `❌ El enlace proporcionado no parece ser de YouTube.` },
            { quoted: m });

    try {
        // React + descarga en paralelo (ahorra ~300-500 ms)
        const [, { downloadUrl, meta }] = await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } }),
            ytDownload(url, 'audio'),
        ]);

        const title    = meta?.title || 'Audio_YouTube';
        const fileName = `${title.replace(/[\\/:*?"<>|]/g, '')}.mp3`;

        // Tarjeta de info
        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, 'audio') }, { quoted: m });

        // Envío: documento o audio reproducible
        if (command === 'ytmp3doc') {
            await socket.sendMessage(m.chat, {
                document: { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName,
            }, { quoted: m });
        } else {
            await socket.sendMessage(m.chat, {
                audio:    { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName,
                ptt:      false,
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        console.error(`[ytmp3 ERROR] ${e.stack}`);

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m }),
        ]);
    }
};

handler.help    = ['ytmp3 <link>', 'ytmp3doc <link>', 'yta <link>'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp3|ytmp3doc|yta)$/i;

export default handler;
