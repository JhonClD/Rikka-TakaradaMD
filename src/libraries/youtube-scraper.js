/**
 * youtube-scraper.js — Rikka-TakaradaMD
 * Backend único: y2mate (rotación de servidores) + yt-dlp como fallback para video
 * ✘ cnvmp3  ✘ ogmp3  →  eliminados
 */

import yts          from 'yt-search';
import { exec }     from 'child_process';
import { promisify } from 'util';
import y2mate       from './y2mate.js';

const execPromise = promisify(exec);
const YTDLP_QUAL  = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best';

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

// ── Helpers de formato ────────────────────────────────────────────────────────
export const formatViews = (n) => {
    if (n == null) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)         return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

export const formatDuration = (sec) => {
    if (!sec) return 'N/A';
    if (typeof sec === 'string' && /^\d+:\d+/.test(sec)) return sec;
    const s = parseInt(sec, 10);
    if (isNaN(s)) return 'N/A';
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
        const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const [y, mo, d] = [str.slice(0,4), str.slice(4,6), str.slice(6,8)];
        return `${parseInt(d)} ${months[parseInt(mo) - 1]} ${y}`;
    }
    return raw;
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon    = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    const title   = meta.title    || 'Sin título';
    const channel = meta.channel  || 'N/A';
    const views   = formatViews(meta.views);
    const dur     = formatDuration(meta.duration || meta.timestamp);
    const date    = formatDate(meta.date || meta.upload_date || meta.publishedAt || meta.ago);
    const link    = meta.url      || '';

    return (
`╭━━━〔 ${icon} 〕━━━⬣
┃ ◈ *Título:* ${title}
┃ ✦ *Canal:* ${channel}
┃ ✧ *Vistas:* ${views}
┃ ◷ *Duración:* ${dur}
┃ ⊞ *Lanzamiento:* ${date}
┃ ∞ *Link:* ${link}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

// ── Metadatos vía yt-search ───────────────────────────────────────────────────
const normalizeYts = (r) => ({
    title:     r.title,
    channel:   r.author?.name || r.channel || 'N/A',
    views:     r.views,
    duration:  r.timestamp,
    date:      r.ago,
    url:       r.url,
    thumbnail: r.thumbnail,
    videoId:   r.videoId,
});

export const ytSearch = async (query) => {
    try {
        const match = query.match(YT_REGEX);
        if (match) {
            const r = await yts({ videoId: match[1] });
            if (r) return normalizeYts(r);
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? normalizeYts(r) : null;
    } catch {
        return null;
    }
};

export const ytInfo = (url) => ytSearch(url);

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
export const dlYtdlp = async (url, outFile) => {
    try {
        await execPromise(
            `yt-dlp -f "${YTDLP_QUAL}" --merge-output-format mp4 -o "${outFile}" "${url}"`
        );
        return true;
    } catch {
        return false;
    }
};

export const ytdlpDate = async (url) => {
    try {
        const { stdout } = await execPromise(`yt-dlp --print "%(upload_date)s" "${url}"`);
        return stdout.trim() || null;
    } catch {
        return null;
    }
};

// ── Descarga principal (solo y2mate) ──────────────────────────────────────────
/**
 * @param {string} url   - URL de YouTube
 * @param {string} type  - 'audio' | 'video'
 * @param {object} opts  - { quality: '360p'|'720p' }
 * @returns {{ downloadUrl, meta, provider }}
 */
export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality } = opts;
    const meta = await ytInfo(url);

    try {
        let result;
        if (type === 'audio') {
            result = await y2mate.yta(url);          // MP3 128 kbps, rota servidores
        } else {
            const q = quality || '360p';
            result = await y2mate.ytv(url, q);       // MP4 calidad pedida
        }

        if (result?.dl_link) {
            return {
                downloadUrl: result.dl_link,
                meta:        meta || {},
                provider:    `y2mate/${result.server}`,
            };
        }
    } catch (e) {
        throw new Error(`y2mate falló: ${e.message}`);
    }

    throw new Error('No se pudo obtener el enlace de descarga. Intenta más tarde.');
};

export const providers = { y2mate, ytdlp: dlYtdlp };
