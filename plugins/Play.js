/**
 * Play.js  —  Rikka-TakaradaMD
 * Comandos: play · play2 · mp3 · mp4 · video · playaudio
 *
 * Backend: yt-dlp (descarga) + ffprobe (duración exacta)
 */

import fs                  from 'fs';
import { exec }            from 'child_process';
import { promisify }       from 'util';

import {
    ytSearch,
    ytDownload,
    buildInfoCard,
    ffprobeDuration,
} from '../src/libraries/youtube-scraper.js';

const execPromise = promisify(exec);

const FLAT_WAVEFORM = new Uint8Array(64).fill(0);

// ─────────────────────────────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command }) => {
    const socket = conn || client;
    const query  = text || args.join(' ');

    if (!query)
        return socket.sendMessage(m.chat,
            { text: `《✧》 Escribe el nombre o URL del video.\n\n*Ejemplo:* .play Linkin Park` },
            { quoted: m });

    const isVideo     = /play2|mp4|video/i.test(command);
    const isVoiceNote = /playaudio/i.test(command);
    const type        = isVideo ? 'video' : 'audio';

    try {
        // 1. Buscar el video
        const [video] = await Promise.all([
            ytSearch(query),
            socket.sendMessage(m.chat, { react: { text: '🔍', key: m.key } }),
        ]);

        if (!video) throw new Error('No se encontró ningún video.');

        // 2. Mostrar tarjeta + reaccionar descargando
        await socket.sendMessage(m.chat, {
            image:   { url: video.thumbnail },
            caption: buildInfoCard(video, type),
        }, { quoted: m });

        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        // ── VIDEO (play2 / mp4 / video) ───────────────────────────────────────
        if (isVideo) {
            const { buffer, seconds, meta } = await ytDownload(video.url, 'video', { quality: '360p' });

            await socket.sendMessage(m.chat, {
                video:    buffer,
                caption:  `🎬 *${(meta?.title || video.title)}*`,
                mimetype: 'video/mp4',
                fileName: `${(meta?.title || video.title).replace(/[\\/:*?"<>|]/g, '')}.mp4`,
                seconds,
            }, { quoted: m });

        // ── VOICE NOTE (playaudio) ────────────────────────────────────────────
        } else if (isVoiceNote) {
            const stamp  = Date.now();
            const tmpMp3 = `./tmp_play_${stamp}.mp3`;
            const tmpOgg = `./tmp_play_${stamp}.ogg`;

            try {
                const { buffer } = await ytDownload(video.url, 'audio');
                fs.writeFileSync(tmpMp3, buffer);

                await execPromise(
                    `ffmpeg -y -i "${tmpMp3}" -ar 16000 -ac 1 -c:a libopus -b:a 32k ` +
                    `-application voip "${tmpOgg}"`
                );

                const oggBuffer = fs.readFileSync(tmpOgg);
                const seconds   = await ffprobeDuration(tmpOgg);

                await socket.sendMessage(m.chat, {
                    audio:    oggBuffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt:      true,
                    seconds,
                    waveform: FLAT_WAVEFORM,
                }, { quoted: m });

            } finally {
                [tmpMp3, tmpOgg].forEach(f => { try { fs.unlinkSync(f); } catch {} });
            }

        // ── AUDIO MP3 (play / mp3) ────────────────────────────────────────────
        } else {
            const { buffer, seconds, meta } = await ytDownload(video.url, 'audio');

            await socket.sendMessage(m.chat, {
                audio:    buffer,
                mimetype: 'audio/mpeg',
                fileName: `${(meta?.title || video.title).replace(/[\\/:*?"<>|]/g, '')}.mp3`,
                seconds,
                ptt:      false,
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        console.error('\n━━━━━━━━━━ [PLAY ERROR] ━━━━━━━━━━');
        console.error(`📌 Comando : ${command}`);
        console.error(`🔎 Query   : ${query}`);
        console.error(`❌ Mensaje : ${e.message}`);
        console.error(`📄 Stack   :\n${e.stack}`);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m }),
        ]);
    }
};

handler.help    = ['play', 'play2', 'playaudio', 'mp4', 'mp3', 'video'];
handler.tags    = ['downloader'];
handler.command = /^(play|play2|mp3|video|mp4|playaudio)$/i;

export default handler;
