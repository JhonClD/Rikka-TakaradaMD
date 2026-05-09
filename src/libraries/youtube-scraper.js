import fs from 'fs';
import yts from 'yt-search';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

const YTDLP_TIMEOUT = 120000;

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

export const formatViews = (n) => {
    if (n == null) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`;
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

export const formatDuration = (sec) => {
    if (!sec) return 'N/A';
    if (typeof sec === 'string' && /^\d+:\d+/.test(sec)) return sec;
    const s = parseInt(sec, 10);
    if (isNaN(s) || s <= 0) return 'N/A';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
        : `${m}:${String(r).padStart(2, '0')}`;
};

export const formatDate = (raw) => {
    if (!raw) return 'N/A';
    const str = String(raw).replace(/-/g, '');
    if (/^\d{8}$/.test(str)) {
        const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const mo = parseInt(str.slice(4, 6)) - 1;
        return `${parseInt(str.slice(6, 8))} ${months[mo] ?? '?'} ${str.slice(0, 4)}`;
    }
    return raw;
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    const title = meta.title || 'Sin título';
    const channel = meta.channel || 'N/A';
    const views = formatViews(meta.views);
    const dur = formatDuration(meta.duration || meta.timestamp);
    const date = formatDate(meta.date || meta.upload_date || meta.publishedAt || meta.ago);
    const link = meta.url || '';

    return (
        `╭━━━〔 ${icon} 〕━━━⬣\n` +
        `┃ ◈ *Título:* ${title}\n` +
        `┃ ✦ *Canal:* ${channel}\n` +
        `┃ ✧ *Vistas:* ${views}\n` +
        `┃ ◷ *Duración:* ${dur}\n` +
        `┃ ⊞ *Lanzamiento:* ${date}\n` +
        `┃ ∞ *Link:* ${link}\n` +
        `╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

const ytdlpInfo = async (url) => {
    try {
        const { stdout } = await execPromise(
            `yt-dlp --dump-json --skip-download --no-playlist "${url}"`,
            { timeout: 20000 }
        );
        const d = JSON.parse(stdout.trim());
        return {
            title: d.title,
            channel: d.uploader || d.channel || 'N/A',
            views: d.view_count,
            duration: d.duration,
            date: d.upload_date,
            url: d.webpage_url || url,
            thumbnail: d.thumbnail,
            videoId: d.id,
        };
    } catch {
        return null;
    }
};

const normalizeYts = (r) => ({
    title: r.title,
    channel: r.author?.name || r.channel || 'N/A',
    views: r.views,
    duration: r.seconds || r.timestamp,
    date: r.ago,
    url: r.url,
    thumbnail: r.thumbnail,
    videoId: r.videoId,
});

export const ytSearch = async (query) => {
    try {
        const match = query.match(YT_REGEX);
        if (match) {
            const info = await ytdlpInfo(query);
            if (info) return info;
            const r = await yts({ videoId: match[1] });
            return r ? normalizeYts(r) : null;
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? normalizeYts(r) : null;
    } catch {
        return null;
    }
};

export const ytInfo = (url) => ytSearch(url);

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality = '360p' } = opts;
    const height = quality.replace('p', '');
    const stamp = Date.now();
    const tmpBase = `./tmp_ytdl_${stamp}`;
    let outFile;

    try {
        if (type === 'audio') {
            outFile = `${tmpBase}.mp3`;
            await execPromise(
                `yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${outFile}" "${url}"`,
                { timeout: YTDLP_TIMEOUT }
            );
        } else {
            outFile = `${tmpBase}.mp4`;
            await execPromise(
                `yt-dlp -f "bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]/best" --merge-output-format mp4 --no-playlist -o "${outFile}" "${url}"`,
                { timeout: YTDLP_TIMEOUT }
            );
        }

        if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
            throw new Error('yt-dlp no generó el archivo de salida.');
        }

        const buffer = fs.readFileSync(outFile);
        const meta = await ytInfo(url);
        const seconds = meta?.duration || 0;

        return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp' };
    } finally {
        [outFile, `${tmpBase}.webm`, `${tmpBase}.m4a`].forEach(f => {
            if (f) {
                try { fs.unlinkSync(f); } catch {}
            }
        });
    }
};
