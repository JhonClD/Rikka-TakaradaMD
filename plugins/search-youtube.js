import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys';
import { ytSearch } from '../src/libraries/youtube-scraper.js';

const { proto } = await import('@whiskeysockets/baileys');

const formatViews = (n) => {
    if (!n && n !== 0) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)         return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

const handler = async (m, { conn, text, usedPrefix: px }) => {
    if (!text) return conn.reply(m.chat,
        `⚠️ *Escribe el nombre del video a buscar.*\n*Ejemplo:* ${px}yts Naruto opening`, m);

    await conn.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });

    const { default: yts } = await import('yt-search');
    const results = await yts(text);
    const videos = results?.videos?.slice(0, 12);

    if (!videos?.length) {
        await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        return conn.reply(m.chat, '❌ *No se encontraron videos.*', m);
    }

    const device = getDevice(m.key.id);
    const isMobile = device !== 'desktop' && device !== 'web';

    if (isMobile) {
        const cards = [];

        for (const v of videos) {
            let imageMessage;
            try {
                imageMessage = await prepareWAMessageMedia(
                    { image: { url: v.thumbnail } },
                    { upload: conn.waUploadToServer }
                ).then(r => r.imageMessage);
            } catch {
                continue;
            }

            cards.push({
                body: proto.Message.InteractiveMessage.Body.fromObject({
                    text: `*${v.title}*\n✦ ${v.author.name}\n⏱ ${v.timestamp}  •  👁 ${formatViews(v.views)}\n📅 ${v.ago}`
                }),
                footer: proto.Message.InteractiveMessage.Footer.fromObject({
                    text: global.wm
                }),
                header: proto.Message.InteractiveMessage.Header.fromObject({
                    title: '< YouTube Search />',
                    hasMediaAttachment: true,
                    imageMessage
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                    buttons: [
                        {
                            name: 'quick_reply',
                            buttonParamsJson: JSON.stringify({
                                display_text: '🎵 Descargar MP3',
                                id: `${px}ytmp3 ${v.url}`
                            })
                        },
                        {
                            name: 'quick_reply',
                            buttonParamsJson: JSON.stringify({
                                display_text: '🎬 Descargar MP4',
                                id: `${px}ytmp4 ${v.url}`
                            })
                        },
                        {
                            name: 'cta_url',
                            buttonParamsJson: JSON.stringify({
                                display_text: '▶ Ver en YouTube',
                                url: v.url,
                                merchant_url: v.url
                            })
                        }
                    ]
                })
            });
        }

        if (cards.length) {
            const msg = generateWAMessageFromContent(
                m.chat,
                {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                            interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                body: proto.Message.InteractiveMessage.Body.create({
                                    text: `🔎 *Búsqueda:* ${text}\n📊 *Resultados:* ${videos.length}`
                                }),
                                footer: proto.Message.InteractiveMessage.Footer.create({
                                    text: `_Selecciona un video y elige cómo descargarlo_`
                                }),
                                header: proto.Message.InteractiveMessage.Header.create({
                                    hasMediaAttachment: false
                                }),
                                carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
                                    cards,
                                    messageVersion: 1
                                })
                            })
                        }
                    }
                },
                { quoted: m }
            );

            await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });

        } else {
            await conn.sendMessage(m.chat, {
                image: { url: videos[0].thumbnail },
                caption: buildDesktopCaption(text, videos, px)
            }, { quoted: m });
        }

    } else {
        await conn.sendMessage(m.chat, {
            image: { url: videos[0].thumbnail },
            caption: buildDesktopCaption(text, videos, px)
        }, { quoted: m });
    }

    await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
};

const buildDesktopCaption = (text, videos, px) => {
    const lines = videos.map((v, i) =>
`*${i + 1}.* _${v.title}_
  ↳ 🔗 ${v.url}
  ↳ ⏱ ${v.timestamp}  •  👁 ${formatViews(v.views)}  •  📅 ${v.ago}`
    ).join('\n\n');

    return (
`╭━━━〔 🔎 YOUTUBE SEARCH 〕━━━⬣
┃ ◈ *Búsqueda:* ${text}
┃ ✦ *Resultados:* ${videos.length}
╰━━━━━━━━━━━━━━━━━━━⬣

${lines}

_Usa_ *${px}ytmp3 <url>* _o_ *${px}ytmp4 <url>* _para descargar._`
    ).trim();
};

handler.help    = ['yts <texto>'];
handler.tags    = ['search'];
handler.command = /^(ytsearch|yts|searchyt|buscaryt|videosearch|audiosearch)$/i;

export default handler;
                            
