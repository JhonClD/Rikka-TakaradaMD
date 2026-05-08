import fs            from 'fs';
import { exec }      from 'child_process';
import { promisify } from 'util';
import { pipeline }  from 'stream';
import { createWriteStream } from 'fs';

import {
    ytSearch,
    ytDownload,
    buildInfoCard,
} from '../src/libraries/youtube-scraper.js';

const execPromise   = promisify(exec);
const pipelineAsync = promisify(pipeline);

const FLAT_WAVEFORM = new Uint8Array(64).fill(0);

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

        const [, { downloadUrl }] = await Promise.all([
            socket.sendMessage(m.chat, {
                image:   { url: video.thumbnail },
                caption: captionInfo,
            }, { quoted: m }),
            ytDownload(video.url, type),
        ]);

        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        if (isVideo) {
            await socket.sendMessage(m.chat, {
                video:    { url: downloadUrl },
                caption:  `🎬 *${video.title}*`,
                mimetype: 'video/mp4',
                fileName: `${video.title}.mp4`,
            }, { quoted: m });

        } else if (isVoiceNote) {
            const stamp  = Date.now();
            const tmpMp3 = `./tmp_${stamp}.mp3`;
            const tmpOgg = `./tmp_${stamp}.ogg`;

            try {
                const { default: fetch } = await import('node-fetch');
                const dlRes = await fetch(downloadUrl);
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

        } else {
            await socket.sendMessage(m.chat, {
                audio:    { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName: `${video.title}.mp3`,
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
                
