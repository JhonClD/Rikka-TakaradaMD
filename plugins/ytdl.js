import axios from 'axios';
import { ytDownload, buildInfoCard } from '../lib/youtube-scraper.js';

// Calidades disponibles
const QUAL_AUDIO = ['96', '128', '256', '320'];
const QUAL_VIDEO = ['144', '240', '360', '480', '720'];

// 720p siempre va como documento, el resto inline
const DOC_THRESHOLD = '720';

const handler = async (m, { conn, args, usedPrefix, command }) => {
    const isVideo = /ytmp4|ytvideo/i.test(command);
    const type    = isVideo ? 'video' : 'audio';

    const url        = args[0];
    const qualityArg = args[1] || (isVideo ? '480' : '128');

    // ── ayuda ────────────────────────────────────────────────────────────────
    if (!url) {
        return conn.reply(m.chat,
            `╭─❒「 ${isVideo ? '🎬' : '🎵'} yᴛ ᴅᴏᴡɴʟᴏᴀᴅᴇʀ 」\n` +
            `│\n` +
            `│ *Uso:*\n` +
            `│ ${usedPrefix}ytmp3 <url> [calidad]\n` +
            `│ ${usedPrefix}ytmp4 <url> [calidad]\n` +
            `│\n` +
            `│ 🎵 *MP3:* ${QUAL_AUDIO.join(' • ')} kbps\n` +
            `│ 🎬 *MP4:* ${QUAL_VIDEO.join(' • ')}p\n` +
            `│\n` +
            `│ 📌 480p → video inline\n` +
            `│ 📌 720p → documento\n` +
            `╰─⬣`, m);
    }

    // ── calidad válida ───────────────────────────────────────────────────────
    const validList = isVideo ? QUAL_VIDEO : QUAL_AUDIO;
    const quality   = validList.includes(String(qualityArg))
        ? String(qualityArg)
        : (isVideo ? '480' : '128');

    await m.react('⏳');

    try {
        const { downloadUrl, meta, provider } = await ytDownload(url, type, { quality });

        if (!downloadUrl) throw new Error('No se obtuvo enlace de descarga.');

        const titulo = meta?.title || 'Sin título';
        const card   = buildInfoCard(meta, type);

        // ── audio ────────────────────────────────────────────────────────────
        if (type === 'audio') {
            await conn.reply(m.chat, card, m);
            await conn.sendMessage(m.chat, {
                audio:    { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName: `${titulo}.mp3`,
                ptt:      false,
            }, { quoted: m });

            await m.react('✅');
            return;
        }

        // ── video ────────────────────────────────────────────────────────────
        const asDocument = quality === DOC_THRESHOLD;

        // Descargamos el buffer para garantizar mp4 real
        const fileRes = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout:      120_000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10)',
                'Referer':    'https://cnvmp3.com/',
            },
        });

        const buffer = Buffer.from(fileRes.data);
        const sizeMB = (buffer.byteLength / (1024 * 1024)).toFixed(2);

        const caption =
            `╭─❒「 🎬 yᴛ ᴠɪᴅᴇᴏ 」\n` +
            `│ 📌 *Título:* ${titulo}\n` +
            `│ 📊 *Calidad:* ${quality}p\n` +
            `│ 💾 *Tamaño:* ${sizeMB} MB\n` +
            `│ ⚡ *Proveedor:* ${provider}\n` +
            `╰─⬣`;

        if (asDocument) {
            // 720p → documento (evita límite de reproducción inline)
            await conn.sendMessage(m.chat, {
                document: buffer,
                mimetype: 'video/mp4',
                fileName: `${titulo}_720p.mp4`,
                caption,
            }, { quoted: m });
        } else {
            // ≤480p → video inline reproducible
            await conn.sendMessage(m.chat, {
                video:    buffer,
                mimetype: 'video/mp4',
                fileName: `${titulo}_${quality}p.mp4`,
                caption,
            }, { quoted: m });
        }

        await m.react('✅');

    } catch (e) {
        await m.react('🔴');
        console.error('[YTPlugin]', e.message);
        return conn.reply(m.chat,
            `╭─❒「 ᴇʀʀᴏʀ 」\n` +
            `│ ❌ ${e.message}\n` +
            `╰─⬣`, m);
    }
};

handler.help    = ['ytmp3 <url> [calidad]', 'ytmp4 <url> [calidad]'];
handler.tags    = ['descargas'];
handler.command = /^(ytmp3|ytmp4|ytaudio|ytvideo)$/i;

export default handler;
