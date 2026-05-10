import {
    YT_REGEX,
    ytInfo,
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
    const quality = !isAudio && isDoc ? '1080p' : '720p';

    try {
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const { buffer, meta: dlMeta } = await ytDownload(url, type, { quality });

        // Para video, enriquecer metadata con yts
        let meta = dlMeta || {};
        if (!isAudio) {
            const ytsMeta = await ytInfo(url).catch(() => null);
            meta = {
                title:    ytsMeta?.title    || dlMeta?.title    || 'Video_YouTube',
                channel:  ytsMeta?.channel  || dlMeta?.channel  || 'N/A',
                views:    ytsMeta?.views    ?? dlMeta?.views,
                duration: ytsMeta?.duration || dlMeta?.duration,
                date:     ytsMeta?.date     || dlMeta?.date,
                url:      ytsMeta?.url      || url,
            };
        }

        const title    = meta?.title || (isAudio ? 'Audio_YouTube' : 'Video_YouTube');
        const ext      = isAudio ? 'mp3' : 'mp4';
        const fileName = `${title.replace(/[\\/:*?"<>|]/g, '')}.${ext}`;

        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, type) }, { quoted: m });

        if (isAudio) {
            if (isDoc) {
                await socket.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: 'audio/mpeg',
                    fileName,
                }, { quoted: m });
            } else {
                await socket.sendMessage(m.chat, {
                    audio:    buffer,
                    mimetype: 'audio/mpeg',
                    ptt:      false,
                }, { quoted: m });
            }
        } else {
            if (isDoc) {
                await socket.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: 'video/mp4',
                    fileName,
                }, { quoted: m });
            } else {
                await socket.sendMessage(m.chat, {
                    video:    buffer,
                    mimetype: 'video/mp4',
                    fileName,
                }, { quoted: m });
            }
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        console.error(`[ytdl ERROR] ${e.stack}`);

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m }),
        ]);
    }
};

handler.help    = ['ytmp3 <link>', 'ytmp3doc <link>', 'yta <link>', 'ytmp4 <link>', 'ytmp4doc <link>'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp3|ytmp3doc|yta|ytmp4|ytmp4doc)$/i;

export default handler;
              
