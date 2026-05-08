import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys';

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
    const videos = results?.videos?.slice(0, 20);

    if (!videos?.length) {
        await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        return conn.reply(m.chat, '❌ *No se encontraron videos.*', m);
    }

    const device = getDevice(m.key.id);
    const isMobile = device !== 'desktop' && device !== 'web';

    if (isMobile) {
        const top = videos[0];

        const messa = await prepareWAMessageMedia(
            { image: { url: top.thumbnail } },
            { upload: conn.waUploadToServer }
        );

        const interactiveMessage = {
            body: {
                text: `*—◉ Resultados obtenidos:* ${videos.length}\n*—◉ Video destacado:*\n*-› Title:* ${top.title}\n*-› Author:* ${top.author.name}\n*-› Views:* ${formatViews(top.views)}\n*-› Duration:* ${top.timestamp}\n*-› Link:* ${top.url}`.trim()
            },
            footer: { text: `${global.wm}` },
            header: {
                title: `*< YouTube Search />*`,
                hasMediaAttachment: true,
                imageMessage: messa.imageMessage
            },
            nativeFlowMessage: {
                buttons: [
                    {
                        name: 'single_select',
                        buttonParamsJson: JSON.stringify({
                            title: 'OPCIONES DISPONIBLES',
                            sections: videos.map((v) => ({
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
                            }))
                        })
                    }
                ],
                messageParamsJson: ''
            }
        };

        const msg = generateWAMessageFromContent(
            m.chat,
            {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2
                        },
                        interactiveMessage
                    }
                }
            },
            { userJid: conn.user.jid, quoted: m }
        );

        await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });

    } else {
        const lines = videos.map((v, i) =>
`*${i + 1}.* _${v.title}_
  ↳ 🔗 ${v.url}
  ↳ ⏱ ${v.timestamp}  •  👁 ${formatViews(v.views)}  •  📅 ${v.ago}`
        ).join('\n\n');

        await conn.sendMessage(m.chat, {
            image: { url: videos[0].thumbnail },
            caption: `╭━━━〔 🔎 YOUTUBE SEARCH 〕━━━⬣\n┃ ◈ *Búsqueda:* ${text}\n┃ ✦ *Resultados:* ${videos.length}\n╰━━━━━━━━━━━━━━━━━━━⬣\n\n${lines}\n\n_Usa_ *${px}ytmp3 <url>* _o_ *${px}ytmp4 <url>* _para descargar._`.trim()
        }, { quoted: m });
    }

    await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
};

handler.before = async function (m, { conn }) {
    // ── Respuesta de nativeFlowMessage / interactiveMessage (WhatsApp nuevo) ──
    const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (nativeFlow) {
        try {
            const params     = JSON.parse(nativeFlow.paramsJson || '{}');
            const selectedId = params?.id || null;
            if (!selectedId) return false;

            // Solo manejamos IDs que empiezan con ytmp3/ytmp4
            const cleanId = selectedId.trim();
            if (!/^[.!#/]?(ytmp3|ytmp4)\s+https?:\/\//i.test(cleanId)) return false;

            const usedPrefix = cleanId[0];
            const [command, ...argParts] = cleanId.slice(1).split(' ');
            const text = argParts.join(' ');

            try {
                await handler.call(conn, m, { conn, text, usedPrefix, command });
            } catch (e) {
                console.error('[ytsearch nativeFlow] Error:', e.message);
            }
            return true;
        } catch (_) {}
        return false;
    }

    // ── Respuesta de listResponseMessage / single_select (WhatsApp viejo) ──
    const listResp = m.message?.listResponseMessage;
    if (listResp) {
        const rawInput = listResp.singleSelectReply?.selectedRowId || null;
        if (!rawInput) return false;

        const cleanId = rawInput.trim();
        if (!/^[.!#/]?(ytmp3|ytmp4)\s+https?:\/\//i.test(cleanId)) return false;

        const usedPrefix = cleanId[0];
        const [command, ...argParts] = cleanId.slice(1).split(' ');
        const text = argParts.join(' ');

        try {
            await handler.call(conn, m, { conn, text, usedPrefix, command });
        } catch (e) {
            console.error('[ytsearch listResp] Error:', e.message);
        }
        return true;
    }

    return false;
};

handler.help    = ['yts <texto>'];
handler.tags    = ['search'];
handler.command = /^(ytsearch|yts|searchyt|buscaryt|videosearch|audiosearch)$/i;

export default handler;
