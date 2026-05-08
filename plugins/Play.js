/**
 * Play.js  —  Rikka-TakaradaMD
 * Comandos: play · play2 · mp3 · mp4 · video · playaudio
 *
 * Backend: y2mate.js  (cnvmp3 / ogmp3 eliminados)
 * Fix: video descargado como buffer → arregla "Este video no está disponible"
 */

import fs                  from 'fs';
import fetch               from 'node-fetch';
import { exec }            from 'child_process';
import { promisify }       from 'util';
import { pipeline }        from 'stream';
import { createWriteStream } from 'fs';

import {
    ytSearch,
    ytDownload,
    buildInfoCard,
} from '../src/libraries/youtube-scraper.js';

const execPromise   = promisify(exec);
const pipelineAsync = promisify(pipeline);

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
        const [video] = await Promise.all([
            ytSearch(query),
            socket.sendMessage(m.chat, { react: { text: '🔍', key: m.key } }),
        ]);

        if (!video) throw new Error('No se encontró ningún video.');

        const captionInfo = buildInfoCard(video, type);

        // Mostrar tarjeta de info + iniciar descarga en paralelo
        const [, { downloadUrl }] = await Promise.all([
            socket.sendMessage(m.chat, {
                image:   { url: video.thumbnail },
                caption: captionInfo,
            }, { quoted: m }),
            ytDownload(video.url, type),
        ]);

        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        // ── VIDEO ─────────────────────────────────────────────────────────────
        if (isVideo) {
            // Buffer obligatorio → evita "Este video no está disponible" en WhatsApp
            const resp = await fetch(downloadUrl, {
                headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar el video`);
            const buffer = Buffer.from(await resp.arrayBuffer());

            await socket.sendMessage(m.chat, {
                video:    buffer,
                caption:  `🎬 *${video.title}*`,
                mimetype: 'video/mp4',
                fileName: `${video.title.replace(/[\\/:*?"<>|]/g, '')}.mp4`,
            }, { quoted: m });

        // ── VOICE NOTE ────────────────────────────────────────────────────────
        } else if (isVoiceNote) {
            const stamp  = Date.now();
            const tmpMp3 = `./tmp_${stamp}.mp3`;
            const tmpOgg = `./tmp_${stamp}.ogg`;

            try {
                const dlRes = await fetch(downloadUrl, {
                    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                });
                if (!dlRes.ok) throw new Error(`Error al descargar audio: ${dlRes.status}`);
                await pipelineAsync(dlRes.body, createWriteStream(tmpMp3));

                await execPromise(
                    `ffmpeg -y -i "${tmpMp3}" -ar 16000 -ac 1 -c:a libopus -b:a 32k ` +
                    `-application voip "${tmpOgg}"`
                );

                await socket.sendMessage(m.chat, {
                    audio:    fs.readFileSync(tmpOgg),
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt:      true,
                    waveform: FLAT_WAVEFORM,
                }, { quoted: m });

            } finally {
                [tmpMp3, tmpOgg].forEach(f => { try { fs.unlinkSync(f); } catch {} });
            }

        // ── AUDIO MP3 ─────────────────────────────────────────────────────────
        } else {
            const resp = await fetch(downloadUrl, {
                headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar el audio`);
            const buffer = Buffer.from(await resp.arrayBuffer());

            await socket.sendMessage(m.chat, {
                audio:    buffer,
                mimetype: 'audio/mpeg',
                fileName: `${video.title.replace(/[\\/:*?"<>|]/g, '')}.mp3`,
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
