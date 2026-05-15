import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const execAsync  = promisify(exec);
const TMP_DIR    = os.tmpdir();

// --- CONFIGURACIÓN ---
const API_KEY    = 'nakano-212-jhon';
const API_BASE   = 'https://rest.apicausas.xyz/api/v1/descargas/youtube';

let FFPROBE_BIN = 'ffprobe';

// Inicialización de binarios
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

// --- UTILIDADES ---
export const formatViews = (n) => {
    if (n == null) return '0';
    const v = parseInt(n, 10);
    if (isNaN(v)) return String(n);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000)     return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)         return `${(v / 1_000).toFixed(1)}K`;
    return v.toLocaleString('es');
};

export const formatDuration = (sec) => {
    if (!sec) return '00:00';
    const s = parseInt(sec, 10);
    if (isNaN(s) || s <= 0) return '00:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
        : `${m}:${String(r).padStart(2, '0')}`;
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    return (
`╭━━━〔 ${icon} 〕━━━⬣
┃ ◈ *Título:* ${meta.title || 'N/A'}
┃ ✦ *Canal:* ${meta.channel || 'N/A'}
┃ ✧ *Vistas:* ${formatViews(meta.views)}
┃ ◷ *Duración:* ${formatDuration(meta.duration)}
┃ ⊞ *ID:* ${meta.videoId || 'N/A'}
┃ ∞ *Link:* ${meta.url || ''}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

// --- FUNCIÓN DE DESCARGA ---
export const ytDownload = async (url, type = 'audio') => {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('URL de YouTube no válida o ID no encontrado');
    
    // Forzamos URL limpia para evitar errores de caché en la API
    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(cleanUrl)}&type=${type}`;
        
        const response = await fetch(apiUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(45_000) 
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        
        const json = await response.json();

        // Validación basada en el JSON de tu captura
        if (!json.status || !json.data || !json.data.download || !json.data.download.url) {
            throw new Error(json.msg || json.message || 'No se recibió un enlace de descarga válido.');
        }

        const { data } = json;
        const downloadUrl = data.download.url;

        // Descarga del archivo
        const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(180_000) });
        if (!fileRes.ok) throw new Error(`Fallo al descargar archivo: ${fileRes.status}`);
        
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // Verificación de duración con ffprobe (Opcional, para precisión extra)
        let finalSeconds = data.duration || 0;
        const tmpFile = path.join(TMP_DIR, `ytdl_${Date.now()}.${type === 'audio' ? 'mp3' : 'mp4'}`);
        
        try {
            fs.writeFileSync(tmpFile, buffer);
            const { stdout } = await execAsync(
                `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tmpFile}"`,
                { timeout: 10_000 }
            );
            const d = parseFloat(stdout.trim());
            if (!isNaN(d) && d > 0) finalSeconds = Math.round(d);
        } catch (e) {
            // Si falla ffprobe, usamos la duración que dio la API
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }

        return {
            buffer,
            seconds: finalSeconds,
            meta: {
                title: data.title || 'Sin título',
                channel: data.uploader || 'N/A',
                views: data.views || 0,
                duration: finalSeconds,
                url: cleanUrl,
                thumbnail: data.thumbnail || '',
                videoId: videoId
            },
            provider: 'apicausas'
        };

    } catch (error) {
        throw new Error(`[Error API Causas]: ${error.message}`);
    }
};
