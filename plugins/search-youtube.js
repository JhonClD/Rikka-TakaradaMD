import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys';
import { ytSearch } from '../src/libraries/youtube-scraper.js';

const handler = async (m, { conn, text, usedPrefix: px }) => {
    if (!text) return conn.reply(m.chat,
        `⚠️ *Escribe el nombre del video a buscar.*\n*Ejemplo:* ${px}yts Naruto opening`, m);

    await conn.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });

    const { default: yts } = await import('yt-search');
    const results = await yts(text);
    const videos = results?.videos?.slice(0, 20);

    if (!videos?.length) return conn.reply(m.chat, '❌ *No se encontraron videos.*', m);

    const device = getDevice(m.key.id);
    const isMobile = device !== 'desktop' && device !== 'web';

    if (isMobile) {
        const top = videos[0];

        const messa = await prepareWAMessageMedia(
            { image: { url: top.thumbnail } },
            { upload: conn.waUploadToServer }
        );

        const sections = videos.map((v) => ({
            title: v.title.substring(0, 24),
            highlight_label: '',
            rows: [
                {
                    header: v.title.substring(0, 60),
                    title: `🎵 ${v.author.name}`.substring(0, 60),
                    description: `⏱ ${v.timestamp}  👁 ${formatViews(v.views)}  •  Descargar MP3`,
                    id: `${px}ytmp3 ${v.url}`
                },
                {
                    header: v.title.substring(0, 60),
                    title: `🎬 ${v.author.name}`.substring(0, 60),
                    description: `⏱ ${v.timestamp}  👁 ${formatViews(v.views)}  •  Descargar MP4`,
                    id: `${px}ytmp4 ${v.url}`
                }
            ]
        }));

        const body =
`╭━━━〔 🔎 YOUTUBE SEARCH 〕━━━⬣
┃ ◈ *Búsqueda:* ${text}
┃ ✦ *Resultados:* ${videos.length}
┃ ✧ *Primer resultado:*
┃   › ${top.title}
┃   › ${top.author.name}
┃   › ⏱ ${top.timestamp}  👁 ${formatViews(top.views)}
╰━━━━━━━━━━━━━━━━━━━⬣
_Selecciona un video para descargar:_`;

        const interactiveMessage = {
            body:   { text: body.trim() },
            footer: { text: global.wm },
            header: {
                title: '< YouTube Search />',
                hasMediaAttachment: true,
                imageMessage: messa.imageMessage
            },
            nativeFlowMessage: {
                buttons: [
                    {
                        name: 'single_select',
                        buttonParamsJson: JSON.stringify({
                            title: 'RESULTADOS DISPONIBLES',
                            sections
                        })
                    }
                ],
                messageParamsJson: ''
            }
        };

        const msg = generateWAMessageFromContent(
            m.chat,
            { viewOnceMessage: { message: { interactiveMessage } } },
            { userJid: conn.user.jid, quoted: m }
        );

        await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });

    } else {
        const lines = videos.map((v, i) =>
`*${i + 1}.* _${v.title}_
  ↳ 🔗 ${v.url}
  ↳ ⏱ ${v.timestamp}  •  👁 ${formatViews(v.views)}  •  📅 ${v.ago}`
        ).join('\n\n');

        const caption =
`╭━━━〔 🔎 YOUTUBE SEARCH 〕━━━⬣
┃ ◈ *Búsqueda:* ${text}
┃ ✦ *Resultados:* ${videos.length}
╰━━━━━━━━━━━━━━━━━━━⬣

${lines}

_Usa_ *${px}ytmp3 <url>* _o_ *${px}ytmp4 <url>* _para descargar._`;

        await conn.sendMessage(m.chat, {
            image: { url: videos[0].thumbnail },
            caption: caption.trim()
        }, { quoted: m });
    }

    await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
};

const formatViews = (n) => {
    if (!n && n !== 0) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)         return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

handler.help    = ['yts <texto>'];
handler.tags    = ['search'];
handler.command = /^(ytsearch|yts|searchyt|buscaryt|videosearch|audiosearch)$/i;

export default handler;
