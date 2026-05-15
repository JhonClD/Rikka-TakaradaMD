import fetch from 'node-fetch'; // Asegúrate de tener instalado node-fetch o usar el fetch nativo de Node 18+
import {
    YT_REGEX,
    ytInfo,
    buildInfoCard,
} from '../src/libraries/youtube-scraper.js';

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

    const isAudio = /ytmp3|ytmp3doc|yta/i.test(command);
    const isDoc   = /ytmp3doc|ytmp4doc/i.test(command);
    
    // Ajuste de parámetros para la API de Umifront
    const type    = isAudio ? 'audio' : 'auto';
    const quality = !isAudio && isDoc ? '1080' : '720'; // Sin la 'p', como pide la API

    try {
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        // --- LLAMADA A LA API DE UMIFRONT ---
        const response = await fetch('https://api.umifront.com/youtube', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'umf_yt_4c3923341d604c95bf53493d3f14e96e' // Tu Key
            },
            body: JSON.stringify({
                url: url,
                downloadMode: type,
                audioFormat: 'mp3',
                videoQuality: quality
            })
        });

        const resJson = await response.json();

        if (!resJson.status) {
            throw new Error(resJson.msg || 'Error en la API de Umifront');
        }

        // La API suele devolver un enlace; descargamos el buffer desde ese enlace
        const mediaUrl = resJson.result.url;
        const mediaResponse = await fetch(mediaUrl);
        const buffer = await mediaResponse.buffer();
        const meta = resJson.result; // Metadata que devuelve la API

        // --- FIN DE LA LLAMADA ---

        const title    = meta?.title || (isAudio ? 'Audio_YouTube' : 'Video_YouTube');
        const ext      = isAudio ? 'mp3' : 'mp4';
        const fileName = `${title.replace(/[\\/:*?"<>|]/g, '')}.${ext}`;

        // Enviamos la tarjeta de info
        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, isAudio ? 'audio' : 'video') }, { quoted: m });

        if (isAudio) {
            await socket.sendMessage(m.chat, {
                [isDoc ? 'document' : 'audio']: buffer,
                mimetype: 'audio/mpeg',
                fileName: isDoc ? fileName : undefined,
                ptt: false,
            }, { quoted: m });
        } else {
            await socket.sendMessage(m.chat, {
                [isDoc ? 'document' : 'video']: buffer,
                mimetype: 'video/mp4',
                fileName: fileName,
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        console.error(`[Umifront Error]: ${e}`);
        await socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        await socket.sendMessage(m.chat, { text: `❌ *Error:* ${e.message}` }, { quoted: m });
    }
};

handler.help    = ['ytmp3', 'ytmp3doc', 'yta', 'ytmp4', 'ytmp4doc'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp3|ytmp3doc|yta|ytmp4|ytmp4doc)$/i;

export default handler;
