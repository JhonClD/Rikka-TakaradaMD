import fs from 'fs';
import yts from 'yt-search';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const execAsync  = promisify(exec);jdjdjd
const TMP_DIR    = os.tmpdir();

const API_KEY    = 'nakano-212-jhon';
const API_BASE   = 'https://rest.apicausas.xyz/api/v1/descargas/youtube';

let FFPROBE_BIN = 'ffprobe';
(async () => {
    try { await execAsync('ffprobe -version', { timeout: 5_000 }); }
    catch {
        try {
            const { default: p } = await import('ffmpeg-static');
            if (p && fs.existsSync(p)) {
                const sidecar = p.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
                if (fs.existsSync(sidecar)) FFPROBE_BIN = sidecar;
            }
        } catch {}
    }
})();

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

const extractVideoId = (url) => url.match(YT_REGEX)?.[1] ?? null;

export const ffprobeDuration = async (filePath) => {
    try {
        const { stdout } = await execAsync(
            `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            { timeout: 10_000 }
        );
        const d = parseFloat(stdout.trim());
        return isNaN(d) || d <= 0 ? 0 : Math.round(d);
    } catch { return 0; }
};

export const formatViews = (n) => {
    if (n == null) return 'N/A';
    const v = parseInt(n, 10);
    if (isNaN(v)) return String(n);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000)     return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)         return `${(v / 1_000).toFixed(1)}K`;
    return v.toLocaleString('es');
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
    const title   = meta.title   || 'Sin título';
    const channel = meta.channel || 'N/A';
    const views   = formatViews(meta.views);
    const dur     = formatDuration(meta.duration || meta.timestamp);
    const date    = formatDate(meta.date || meta.upload_date || meta.ago);
    const link    = meta.url || '';
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

const normalizeYts = (r) => ({
    title:    r.title,
    channel:  r.author?.name || r.channel || 'N/A',
    views:    r.views,
    duration: r.seconds || r.timestamp,
    date:     r.ago,
    url:      r.url,
    thumbnail: r.thumbnail,
    videoId:  r.videoId,
});

export const ytSearch = async (query) => {
    try {
        const match = query.match(YT_REGEX);
        if (match) {
            const r = await yts({ videoId: match[1] });
            return r ? normalizeYts(r) : null;
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? normalizeYts(r) : null;
    } catch { return null; }
};

export const ytInfo = (url) => ytSearch(url);

export const ytDownload = async (url, type = 'audio') => {
    if (!url || typeof url !== 'string') throw new Error('URL inválida');
    if (type !== 'audio' && type !== 'video') throw new Error('type debe ser "audio" o "video"');
    if (!YT_REGEX.test(url) && !extractVideoId(url)) throw new Error('No es una URL de YouTube válida');

    const ytsMetaPromise = ytInfo(url).catch(() => null);

    try {
        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(url)}&type=${type}`;
        
        const res = await fetch(apiUrl, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(60_000)
        });

        if (!res.ok) throw new Error(`API de descarga respondió HTTP ${res.status}`);
        
        const json = await res.json();
        if (!json.status || !json.result?.url) {
            throw new Error(json.message || 'La API externa no retornó un enlace de descarga válido.');
        }

        const fileRes = await fetch(json.result.url, {
            signal: AbortSignal.timeout(90_000)
        });
        if (!fileRes.ok) throw new Error(`Error al descargar el archivo desde el servidor secundario (HTTP ${fileRes.status})`);
        
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        const stamp = Date.now();
        const tmpFile = path.join(TMP_DIR, `ytdl_api_${stamp}.${type === 'audio' ? 'mp3' : 'mp4'}`);
        fs.writeFileSync(tmpFile, buffer);

        let seconds = 0;
        try {
            seconds = await ffprobeDuration(tmpFile);
        } finally {
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
        }

        const ytsMeta = await ytsMetaPromise;
        const meta = {
            title:     json.result.title || ytsMeta?.title || 'Sin título',
            channel:   ytsMeta?.channel || 'N/A',
            views:     ytsMeta?.views || 0,
            duration:  seconds || ytsMeta?.duration || 0,
            date:      ytsMeta?.date || 'N/A',
            url:       url,
            thumbnail: ytsMeta?.thumbnail || '',
            videoId:   extractVideoId(url)
        };

        return { 
            buffer, 
            seconds: meta.duration, 
            meta, 
            provider: 'apicausas' 
        };

    } catch (error) {
        throw new Error(`[Error API Causas]: ${error.message}`);
    }
};
                                   
