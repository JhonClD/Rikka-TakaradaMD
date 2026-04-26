import yts from 'yt-search';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { createWriteStream } from 'fs';

const execPromise   = promisify(exec);
const pipelineAsync = promisify(pipeline);

const API_KEY  = "nakano-212-jhon";
const API_BASE = "https://rest.apicausas.xyz/api/v1/descargas/youtube";
const TIMEOUT  = 25000;

const fetchWithTimeout = (url, ms = TIMEOUT) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
};

// Waveform plano → líneas rectas en el PTT
// Uint8Array con ceros → WhatsApp renderiza líneas completamente planas
const FLAT_WAVEFORM = new Uint8Array(64).fill(0);

// ==========================================
// DETECTAR SI ES URL DE YOUTUBE
// ==========================================
const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

const resolveVideo = async (query) => {
    const match = query.match(YT_REGEX);
    if (match) {
        const result = await yts({ videoId: match[1] });
        if (result) return result;
    }
    const search = await yts(query);
    return search.videos[0] || null;
};

// ==========================================
// HANDLER PRINCIPAL
// ==========================================
const handler = async (m, { conn, client, args, text, command }) => {
    const socket = conn || client;
    const query  = text || args.join(' ');

    if (!query) return socket.sendMessage(m.chat,
        { text: `《✧》 Escribe el nombre o URL del video.\n\n*Ejemplo:* .play Linkin Park` },
        { quoted: m });

    const isVideo     = /play2|mp4|video/i.test(command);
    const isVoiceNote = /playaudio/i.test(command);
    const type        = isVideo ? 'video' : 'audio';

    try {
        // ── 1. Búsqueda + react en PARALELO ──────────────────────────────
        const [video] = await Promise.all([
            resolveVideo(query),
            socket.sendMessage(m.chat, { react: { text: '🔍', key: m.key } })
        ]);

        if (!video) throw new Error('No se encontró ningún video.');

        // ── 2. Miniatura + API en PARALELO ────────────────────────────────
        const header     = isVideo ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
        const captionInfo = `╭━━━〔 ${header} 〕━━━⬣
┃ ◈ *Título:* ${video.title}
┃ ✦ *Canal:* ${video.author.name}
┃ ✧ *Vistas:* ${video.views.toLocaleString('es')}
┃ ◷ *Duración:* ${video.timestamp}
┃ ⊞ *Lanzamiento:* ${video.ago || 'N/A'}
┃ ∞ *Link:* ${video.url}
╰━━━━━━━━━━━━━━━━━━━⬣`.trim();

        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(video.url)}&type=${type}`;

        const [, apiRes] = await Promise.all([
            socket.sendMessage(m.chat, { image: { url: video.thumbnail }, caption: captionInfo }, { quoted: m }),
            fetchWithTimeout(apiUrl)
        ]);

        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        // ── 3. Parsear respuesta ──────────────────────────────────────────
        const json = await apiRes.json();
        const downloadUrl =
            json?.data?.download?.url ||
            json?.result?.download    ||
            json?.data?.url           ||
            json?.url;

        if (!downloadUrl) throw new Error('No se pudo obtener el enlace de descarga.');

        // ── 4. Envío ──────────────────────────────────────────────────────
        if (isVideo) {
            await socket.sendMessage(m.chat, {
                video: { url: downloadUrl },
                caption: `🎬 *${video.title}*`,
                mimetype: 'video/mp4',
                fileName: `${video.title}.mp4`
            }, { quoted: m });

        } else if (isVoiceNote) {
            // PTT con líneas rectas (waveform plano)
            const stamp  = Date.now();
            const tmpMp3 = `./tmp_${stamp}.mp3`;
            const tmpOgg = `./tmp_${stamp}.ogg`;

            try {
                // Descargar al disco como stream
                const dlRes = await fetchWithTimeout(downloadUrl, 60000);
                if (!dlRes.ok) throw new Error(`Error al descargar audio: ${dlRes.status}`);
                await pipelineAsync(dlRes.body, createWriteStream(tmpMp3));

                // Convertir a OGG OPUS (formato PTT de WhatsApp)
                await execPromise(
                    `ffmpeg -y -i "${tmpMp3}" -ar 16000 -ac 1 -c:a libopus -b:a 32k ` +
                    `-application voip "${tmpOgg}"`
                );

                const audioBuffer = fs.readFileSync(tmpOgg);

                // Enviar como PTT con waveform plano → líneas rectas
                await socket.sendMessage(m.chat, {
                    audio: audioBuffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                    waveform: FLAT_WAVEFORM
                }, { quoted: m });

            } finally {
                [tmpMp3, tmpOgg].forEach(f => { try { fs.unlinkSync(f); } catch {} });
            }

        } else {
            // Audio normal con reproductor
            await socket.sendMessage(m.chat, {
                audio: { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName: `${video.title}.mp3`,
                ptt: false
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
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m })
        ]);
    }
};

handler.help    = ['play', 'play2', 'playaudio', 'mp4', 'mp3', 'video'];
handler.tags    = ['downloader'];
handler.command = /^(play|play2|mp3|video|mp4|playaudio)$/i;

export default handler;

