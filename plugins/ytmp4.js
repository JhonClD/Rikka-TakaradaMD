import fetch from 'node-fetch';
import yts from 'yt-search';
import { exec } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { createWriteStream } from 'fs';

const execPromise    = promisify(exec);
const pipelineAsync  = promisify(pipeline);

const API_KEY  = "nakano-212-jhon";
const API_BASE = "https://rest.apicausas.xyz/api/v1/descargas/youtube";
const TIMEOUT  = 25000;

const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

// ── Helpers de formato ──────────────────────────────────────────────────────
const formatViews = (n) => {
    if (!n && n !== 0) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)         return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

const formatDuration = (sec) => {
    if (!sec) return 'N/A';
    // Si ya viene como "m:ss" o "h:mm:ss" (de yts), devolverlo directo
    if (typeof sec === 'string' && /^\d+:\d+/.test(sec)) return sec;
    const s = parseInt(sec, 10);
    if (isNaN(s)) return 'N/A';
    const h = Math.floor(s / 3600);
    const mnt = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
        ? `${h}:${String(mnt).padStart(2,'0')}:${String(r).padStart(2,'0')}`
        : `${mnt}:${String(r).padStart(2,'0')}`;
};

const formatDate = (raw) => {
    if (!raw) return 'N/A';
    const str = String(raw).replace(/-/g, '');
    if (/^\d{8}$/.test(str)) {
        const [y, mo, d] = [str.slice(0,4), str.slice(4,6), str.slice(6,8)];
        const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        return `${parseInt(d)} ${months[parseInt(mo)-1]} ${y}`;
    }
    return raw;
};

// ── Tarjeta de info ─────────────────────────────────────────────────────────
const buildInfoCard = (meta) => {
    const title    = meta.title    || 'Sin título';
    const channel  = meta.channel  || 'N/A';
    const views    = meta.views;
    const duration = meta.duration || meta.timestamp;
    const date     = meta.date;
    const link     = meta.url      || '';

    return (
`╭━━━〔 🎬 YOUTUBE VIDEO 〕━━━⬣
┃ ◈ *Título:* ${title}
┃ ✦ *Canal:* ${channel}
┃ ✧ *Vistas:* ${formatViews(views)}
┃ ◷ *Duración:* ${formatDuration(duration)}
┃ ⊞ *Lanzamiento:* ${formatDate(date)}
┃ ∞ *Link:* ${link}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

// ── Obtener metadata completa con yts ───────────────────────────────────────
const getYtsMeta = async (url) => {
    try {
        const match = url.match(YT_REGEX);
        const result = match
            ? await yts({ videoId: match[1] })
            : (await yts(url))?.videos?.[0];
        if (!result) return null;
        return {
            title:    result.title,
            channel:  result.author?.name,
            views:    result.views,
            duration: result.timestamp,   // ya viene como "1:40"
            date:     result.ago,         // "1 year ago"
            url:      result.url,
            thumbnail: result.thumbnail,
        };
    } catch {
        return null;
    }
};

const fetchWithTimeout = (url, ms = TIMEOUT) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
};

// ── Handler principal ───────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command }) => {
    const socket = conn || client;
    const url    = text || args[0];

    if (!url)
        return socket.sendMessage(m.chat,
            { text: `《✧》 Por favor, ingresa un enlace de YouTube válido.` },
            { quoted: m });

    if (!url.includes('youtu'))
        return socket.sendMessage(m.chat,
            { text: `❌ El enlace proporcionado no parece ser de YouTube.` },
            { quoted: m });

    try {
        // ── Metadata: yts primero (completa), fallback campos de API ────
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const ytsMeta = await getYtsMeta(url);

        // ── PLAN A: yt-dlp (solo ytmp4doc) ──────────────────────────────
        if (command === 'ytmp4doc') {
            const tmpFile = `./tmp_${Date.now()}.mp4`;
            let ytdlpOk = false;

            try {
                await execPromise(
                    `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best" ` +
                    `--merge-output-format mp4 -o "${tmpFile}" "${url}"`
                );
                ytdlpOk = true;
            } catch (err) {
                console.warn('[ytmp4doc] yt-dlp falló, usando API de respaldo:', err.message);
            }

            if (ytdlpOk) {
                // Metadata extra de yt-dlp (upload_date precisa)
                let ytdlpDate = ytsMeta?.date;
                try {
                    const { stdout } = await execPromise(
                        `yt-dlp --print "%(upload_date)s" "${url}"`
                    );
                    ytdlpDate = stdout.trim() || ytdlpDate;
                } catch {}

                const meta = {
                    ...(ytsMeta || {}),
                    date: ytdlpDate,
                    url,
                };
                const fileName = `${(meta.title || 'Video').replace(/[\\/:*?"<>|]/g, '')}.mp4`;

                // Tarjeta + archivo (UNA SOLA VEZ)
                await socket.sendMessage(m.chat, { text: buildInfoCard(meta) }, { quoted: m });
                await socket.sendMessage(m.chat, {
                    document: fs.readFileSync(tmpFile),
                    mimetype: 'video/mp4',
                    fileName
                }, { quoted: m });
                await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

                try { fs.unlinkSync(tmpFile); } catch {}
                return;
            }

            try { fs.unlinkSync(tmpFile); } catch {}
            // yt-dlp falló → caer a Plan B (sin enviar tarjeta aquí)
        }

        // ── PLAN B: API de respaldo ──────────────────────────────────────
        const isDoc  = command === 'ytmp4doc';
        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(url)}&type=video${isDoc ? '&quality=720p' : ''}`;

        const res  = await fetchWithTimeout(apiUrl);
        const json = await res.json();
        const data = json?.data || json?.result || json || {};

        const downloadUrl = data?.download?.url
            || data?.download
            || data?.url
            || json?.url;

        if (!downloadUrl) throw new Error('La API no devolvió un enlace de descarga válido.');

        // Combinar: yts (vistas/duración completas) + API (título/canal si yts falló)
        const meta = {
            title:    ytsMeta?.title    || data?.title    || json?.title    || 'Video_YouTube',
            channel:  ytsMeta?.channel  || data?.channel  || data?.uploader || 'N/A',
            views:    ytsMeta?.views    ?? data?.views    ?? data?.viewCount,
            duration: ytsMeta?.duration || data?.duration || data?.length_seconds,
            date:     ytsMeta?.date     || data?.upload_date || data?.publishedAt,
            url:      ytsMeta?.url      || data?.url      || url,
        };

        const fileName = `${meta.title.replace(/[\\/:*?"<>|]/g, '')}.mp4`;

        // Tarjeta ÚNICA (Plan B)
        await socket.sendMessage(m.chat, { text: buildInfoCard(meta) }, { quoted: m });

        if (isDoc) {
            await socket.sendMessage(m.chat, {
                document: { url: downloadUrl },
                mimetype: 'video/mp4',
                fileName
            }, { quoted: m });
        } else {
            await socket.sendMessage(m.chat, {
                video: { url: downloadUrl },
                mimetype: 'video/mp4',
                fileName
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        console.error(`[ytmp4 ERROR] ${e.stack}`);

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m })
        ]);
    }
};

handler.help    = ['ytmp4 <link>', 'ytmp4doc <link>'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp4|ytmp4doc)$/i;

export default handler;
