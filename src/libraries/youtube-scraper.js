/**
 * youtube-scraper.js — Rikka-TakaradaMD
 *
 * Backend  : yt-dlp-exec (npm) → no requiere yt-dlp instalado en el sistema
 *            El paquete descarga el binario automáticamente la primera vez.
 * Encode   : ffmpeg (re-encode MP3 con Xing header / MP4 con faststart)
 * Duración : ffprobe -show_entries format=duration  (lectura directa, sin JSON)
 *
 * Instalar : npm install yt-dlp-exec
 */

import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';
import ytDlp         from 'yt-dlp-exec';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 60_000;   // 1 min para re-encode con ffmpeg

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
        const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const mo = parseInt(str.slice(4, 6)) - 1;
        return `${parseInt(str.slice(6, 8))} ${months[mo] ?? '?'} ${str.slice(0, 4)}`;
    }
    return raw;
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon    = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    const title   = meta.title    || 'Sin título';
    const channel = meta.channel  || 'N/A';
    const views   = formatViews(meta.views);
    const dur     = formatDuration(meta.duration || meta.timestamp);
    const date    = formatDate(meta.date || meta.upload_date || meta.ago);
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

// ── ffprobe: duración directa del contenedor ──────────────────────────────────
export const ffprobeDuration = async (filePath) => {
    try {
        const { stdout } = await execPromise(
            `ffprobe -v error -show_entries format=duration ` +
            `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`
        );
        const dur = parseFloat(stdout.trim());
        return isNaN(dur) || dur <= 0 ? 0 : Math.round(dur);
    } catch {
        return 0;
    }
};

// ── Metadata: yt-dlp-exec --dump-json ────────────────────────────────────────
const ytdlpInfo = async (url) => {
    try {
        // ytDlp con dumpSingleJson devuelve el objeto JSON parseado directamente
        const d = await ytDlp(url, {
            dumpSingleJson:  true,
            skipDownload:    true,
            noPlaylist:      true,
            noWarnings:      true,
        });
        return {
            title:     d.title,
            channel:   d.uploader || d.channel || 'N/A',
            views:     d.view_count,
            duration:  d.duration,        // segundos (número)
            date:      d.upload_date,     // YYYYMMDD
            url:       d.webpage_url || url,
            thumbnail: d.thumbnail,
            videoId:   d.id,
        };
    } catch {
        return null;
    }
};

// ── ytSearch / ytInfo ─────────────────────────────────────────────────────────
const normalizeYts = (r) => ({
    title:     r.title,
    channel:   r.author?.name || r.channel || 'N/A',
    views:     r.views,
    duration:  r.seconds || r.timestamp,
    date:      r.ago,
    url:       r.url,
    thumbnail: r.thumbnail,
    videoId:   r.videoId,
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

// ── Descarga principal ────────────────────────────────────────────────────────
/**
 * @param {string} url   - URL de YouTube
 * @param {string} type  - 'audio' | 'video'
 * @param {object} opts  - { quality: '360p'|'720p'|'1080p' }
 * @returns {{ buffer: Buffer, seconds: number, meta: object, provider: string }}
 */
export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality = '360p' } = opts;
    const height   = quality.replace('p', '');
    const stamp    = Date.now();
    const tmpBase  = `./tmp_ytdl_${stamp}`;
    const tmpFiles = [];

    const cleanup = () =>
        tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

    try {
        // ── AUDIO ─────────────────────────────────────────────────────────────
        if (type === 'audio') {

            // Paso 1: yt-dlp-exec descarga el audio en formato nativo
            await ytDlp(url, {
                x:            true,
                noPlaylist:   true,
                noWarnings:   true,
                output:       `${tmpBase}_raw.%(ext)s`,
            });

            // Buscar el archivo descargado (extensión varía según la fuente)
            const rawFile = ['mp3','m4a','webm','opus','ogg','wav','aac','flac']
                .map(ext => `${tmpBase}_raw.${ext}`)
                .find(f => fs.existsSync(f));

            if (!rawFile) throw new Error('yt-dlp no descargó el archivo de audio.');
            tmpFiles.push(rawFile);

            // Paso 2: ffmpeg → MP3 con Xing header  →  duración legible por WhatsApp
            const outFile = `${tmpBase}.mp3`;
            tmpFiles.push(outFile);

            await execPromise(
                `ffmpeg -y -i "${rawFile}" -vn -c:a libmp3lame -q:a 2 -write_xing 1 "${outFile}"`,
                { timeout: FFMPEG_TIMEOUT }
            );

            if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0)
                throw new Error('ffmpeg no pudo convertir el audio a MP3.');

            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(outFile)),
                ffprobeDuration(outFile),
                ytInfo(url),
            ]);

            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp-exec+ffmpeg' };

        // ── VIDEO ─────────────────────────────────────────────────────────────
        } else {

            // Paso 1: yt-dlp-exec descarga el video
            const rawFile = `${tmpBase}_raw.mp4`;
            tmpFiles.push(rawFile);

            await ytDlp(url, {
                format:            `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]/best`,
                mergeOutputFormat: 'mp4',
                noPlaylist:        true,
                noWarnings:        true,
                output:            rawFile,
            });

            if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size === 0)
                throw new Error('yt-dlp no descargó el video.');

            // Paso 2: ffmpeg → remux con moov al inicio (faststart) + duración correcta
            const outFile = `${tmpBase}.mp4`;
            tmpFiles.push(outFile);

            await execPromise(
                `ffmpeg -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
                { timeout: FFMPEG_TIMEOUT }
            );

            // Si el remux falla, usar el raw directamente
            const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0
                ? outFile
                : rawFile;

            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(finalFile)),
                ffprobeDuration(finalFile),
                ytInfo(url),
            ]);

            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp-exec+ffmpeg' };
        }

    } finally {
        cleanup();
    }
};
    
