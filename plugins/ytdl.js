import {
    YT_REGEX,
    ytDownload,
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
    const type    = isAudio ? 'audio' : 'video';
    const quality = isDoc ? '1080p' : '720p';

    try {
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const { buffer, meta, provider } = await ytDownload(url, type, { quality });

        const title    = meta?.title || (isAudio ? 'Audio_YouTube' : 'Video_YouTube');
        const ext      = isAudio ? 'mp3' : 'mp4';
        const fileName = `${title.replace(/[\\/:*?"<>|]/g, '')}.${ext}`;

        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, type) }, { quoted: m });

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
        console.error(`[ytdl Error]: ${e}`);
        await socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        await socket.sendMessage(m.chat, { text: `❌ *Error:* ${e.message}` }, { quoted: m });
    }
};

handler.help    = ['ytmp3', 'ytmp3doc', 'yta', 'ytmp4', 'ytmp4doc'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp3|ytmp3doc|yta|ytmp4|ytmp4doc)$/i;

export default handler;
