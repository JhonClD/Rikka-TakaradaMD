import fs from 'fs';
import yts from 'yt-search';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const execAsync  = promisify(exec);
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
    return raw; 
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon    = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    return (
`╭━━━〔 ${icon} 〕━━━⬣
┃ ◈ *Título:* ${meta.title || 'Sin título'}
┃ ✦ *Canal:* ${meta.channel || 'N/A'}
┃ ✧ *Vistas:* ${formatViews(meta.views)}
┃ ◷ *Duración:* ${formatDuration(meta.duration)}
┃ ⊞ *ID:* ${meta.videoId || 'N/A'}
┃ ∞ *Link:* ${meta.url || ''}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

export const ytSearch = async (query) => {
    try {
        const match = query.match(YT_REGEX);
        if (match) {
            const r = await yts({ videoId: match[1] });
            return r ? { ...r, channel: r.author?.name } : null;
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? { ...r, channel: r.author?.name } : null;
    } catch { return null; }
};

export const ytDownload = async (url, type = 'audio') => {
    if (!url || !YT_REGEX.test(url)) throw new Error('URL de YouTube no válida');

    try {
        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(url)}&type=${type}`;
        const response = await fetch(apiUrl);
        const json = await response.json();

        // Según tu screenshot, la data viene en json.data
        if (!json.status || !json.data?.download?.url) {
            throw new Error(json.msg || 'No se pudo obtener el enlace de descarga.');
        }

        const data = json.data;
        const fileRes = await fetch(data.download.url, { signal: AbortSignal.timeout(120_000) });
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // Guardar temporal para obtener duración real
        const stamp = Date.now();
        const tmpFile = path.join(TMP_DIR, `ytdl_${stamp}.${type === 'audio' ? 'mp3' : 'mp4'}`);
        fs.writeFileSync(tmpFile, buffer);

        let realSeconds = 0;
        try {
            realSeconds = await ffprobeDuration(tmpFile);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }

        const meta = {
            title: data.title || 'Sin título',
            channel: data.uploader || 'N/A',
            views: data.views || 0,
            duration: realSeconds || data.duration || 0,
            url: url,
            thumbnail: data.thumbnail || '',
            videoId: data.id || extractVideoId(url)
        };

        return { buffer, seconds: meta.duration, meta, provider: 'apicausas' };

    } catch (error) {
        throw new Error(`[Error API]: ${error.message}`);
    }
};
            
