/**
 * ytmp4.js  —  Rikka-TakaradaMD
 * Comandos: ytmp4 · ytmp4doc
 *
 * Lógica de scraping delegada a → src/libraries/youtube-scraper.js
 */

import fs            from 'fs';
import { promisify } from 'util';
import { exec }      from 'child_process';

import {
    YT_REGEX,
    ytInfo,
    ytDownload,
    buildInfoCard,
    dlYtdlp,
    ytdlpDate,
} from '../src/libraries/youtube-scraper.js';

const execPromise = promisify(exec);

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
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const isDoc    = command === 'ytmp4doc';
        const tmpFile  = `./tmp_${Date.now()}.mp4`;

        // ── PLAN A: yt-dlp  (solo ytmp4doc) ────────────────────────────────
        if (isDoc) {
            const ok = await dlYtdlp(url, tmpFile);

            if (ok) {
                const [ytsMeta, preciseDate] = await Promise.all([
                    ytInfo(url),
                    ytdlpDate(url),
                ]);

                const meta     = { ...(ytsMeta || {}), date: preciseDate || ytsMeta?.date, url };
                const fileName = `${(meta.title || 'Video').replace(/[\\/:*?"<>|]/g, '')}.mp4`;

                await socket.sendMessage(m.chat,
                    { text: buildInfoCard(meta, 'video') }, { quoted: m });

                await socket.sendMessage(m.chat, {
                    document: fs.readFileSync(tmpFile),
                    mimetype: 'video/mp4',
                    fileName,
                }, { quoted: m });

                await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
                try { fs.unlinkSync(tmpFile); } catch {}
                return;
            }

            try { fs.unlinkSync(tmpFile); } catch {}
            // yt-dlp falló → caer a Plan B
        }

        // ── PLAN B: cadena de proveedores (apicausas → ogmp3 → y2mate) ────
        const quality = isDoc ? '720p' : undefined;
        const { downloadUrl, meta: apiMeta } = await ytDownload(url, 'video', { quality });

        // Complementar metadata con yts si la API devolvió poco
        const ytsMeta  = await ytInfo(url);
        const meta     = {
            title:    ytsMeta?.title    || apiMeta?.title    || 'Video_YouTube',
            channel:  ytsMeta?.channel  || apiMeta?.channel  || 'N/A',
            views:    ytsMeta?.views    ?? apiMeta?.views,
            duration: ytsMeta?.duration || apiMeta?.duration,
            date:     ytsMeta?.date     || apiMeta?.date,
            url:      ytsMeta?.url      || url,
        };

        const fileName = `${meta.title.replace(/[\\/:*?"<>|]/g, '')}.mp4`;

        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, 'video') }, { quoted: m });

        if (isDoc) {
            await socket.sendMessage(m.chat, {
                document: { url: downloadUrl },
                mimetype: 'video/mp4',
                fileName,
            }, { quoted: m });
        } else {
            await socket.sendMessage(m.chat, {
                video:    { url: downloadUrl },
                mimetype: 'video/mp4',
                fileName,
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        console.error(`[ytmp4 ERROR] ${e.stack}`);

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m }),
        ]);
    }
};

handler.help    = ['ytmp4 <link>', 'ytmp4doc <link>'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp4|ytmp4doc)$/i;

export default handler;
