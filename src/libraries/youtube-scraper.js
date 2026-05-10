/**
 * youtube-scraper.js — Rikka-TakaradaMD
 *
 * Compatible con:
 *   • Termux / Android  →  pip install yt-dlp
 *   • VPS / Linux       →  pip3 install yt-dlp  o  npm install yt-dlp-exec
 *
 * El binario se auto-detecta al primer uso (se cachea para el resto de la sesión).
 * ffmpeg y ffprobe deben estar instalados en el sistema.
 */

import fs           from 'fs';
import path         from 'path';
import yts          from 'yt-search';
import { exec }     from 'child_process';
import { promisify } from 'util';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 60_000;   // 1 min
const YTDLP_TIMEOUT  = 120_000;  // 2 min

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

// ── Cookies de YouTube (evita el bot-check) ───────────────────────────────────
// Coloca cookies.txt en src/ o en la raíz del bot.
const COOKIE_CANDIDATES = [
    path.join(process.cwd(), 'src', 'cookies.txt'),
    path.join(process.cwd(), 'cookies.txt'),
];
const COOKIES_FILE = COOKIE_CANDIDATES.find(f => fs.existsSync(f)) || null;

if (COOKIES_FILE) {
    console.log(`[yt-dlp] Usando cookies: ${COOKIES_FILE}`);
} else {
    console.warn('[yt-dlp] ⚠️  No se encontró cookies.txt — algunas descargas pueden fallar.');
}

// Flags globales que se agregan a TODOS los llamados de yt-dlp
const YTDLP_GLOBAL_FLAGS = [
    '--force-ipv4',                                           // evita problemas de IPv6 en VPS
    COOKIES_FILE ? `--cookies "${COOKIES_FILE}"` : '',        // autenticación anti-bot
    '--no-check-certificate',                                 // algunos VPS tienen cert issues
].filter(Boolean).join(' ');

// ── Auto-detección de yt-dlp (Termux + VPS) ──────────────────────────────────
let _ytdlpBin = null;

const findYtDlp = async () => {
    if (_ytdlpBin) return _ytdlpBin;

    const home = process.env.HOME || '';
    const candidates = [
        // PATH estándar (funciona si está bien instalado en cualquier entorno)
        'yt-dlp',
        // Termux / Android
        '/data/data/com.termux/files/usr/bin/yt-dlp',
        `${home}/.local/bin/yt-dlp`,
        // VPS / Linux
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        '/snap/bin/yt-dlp',
        // macOS (Homebrew)
        '/opt/homebrew/bin/yt-dlp',
    ];

    // Si está instalado el paquete npm yt-dlp-exec, usar su binario (VPS x86_64)
    try {
        const mod = await import('yt-dlp-exec');
        const bin = mod?.raw || mod?.default?.raw;
        if (bin) candidates.unshift(bin);
    } catch { /* no instalado, ignorar */ }

    for (const bin of candidates) {
        try {
            await execPromise(`"${bin}" --version`, { timeout: 5_000 });
            _ytdlpBin = bin;
            console.log(`[yt-dlp] Binario encontrado: ${bin}`);
            return bin;
        } catch { /* probar siguiente */ }
    }

    throw new Error(
        'yt-dlp no encontrado. Instálalo:\n' +
        '  • Termux : pip install yt-dlp\n' +
        '  • VPS    : pip3 install yt-dlp  o  npm install yt-dlp-exec'
    );
};

// Wrapper: ejecuta yt-dlp con los argumentos dados + flags globales
const ytdlpExec = async (args) => {
    const bin = await findYtDlp();
    return execPromise(`"${bin}" ${YTDLP_GLOBAL_FLAGS} ${args}`, { timeout: YTDLP_TIMEOUT });
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

// ── Metadata: yt-dlp --dump-json ──────────────────────────────────────────────
const ytdlpInfo = async (url) => {
    try {
        const { stdout } = await ytdlpExec(
            `--dump-json --skip-download --no-playlist --no-warnings "${url}"`
        );
        const d = JSON.parse(stdout.trim());
        return {
            title:     d.title,
            channel:   d.uploader || d.channel || 'N/A',
            views:     d.view_count,
            duration:  d.duration,       // segundos
            date:      d.upload_date,    // YYYYMMDD
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
            // Paso 1: yt-dlp descarga el audio en el formato nativo más eficiente
            await ytdlpExec(
                `--no-playlist --no-warnings -x -o "${tmpBase}_raw.%(ext)s" "${url}"`
            );

            const rawFile = ['m4a','webm','opus','ogg','mp3','wav','aac','flac']
                .map(ext => `${tmpBase}_raw.${ext}`)
                .find(f => fs.existsSync(f));

            if (!rawFile) throw new Error('yt-dlp no descargó el archivo de audio.');
            tmpFiles.push(rawFile);

            // Paso 2: ffmpeg → MP3 con Xing header (fija el 0:00 en WhatsApp)
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

            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp+ffmpeg' };

        // ── VIDEO ─────────────────────────────────────────────────────────────
        } else {
            const rawFile = `${tmpBase}_raw.mp4`;
            tmpFiles.push(rawFile);

            await ytdlpExec(
                `-f "bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]` +
                `/best[height<=${height}][ext=mp4]/best[height<=${height}]/best" ` +
                `--merge-output-format mp4 --no-playlist --no-warnings -o "${rawFile}" "${url}"`
            );

            if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size === 0)
                throw new Error('yt-dlp no descargó el video.');

            // Paso 2: ffmpeg remux → moov al inicio, duración embebida
            const outFile = `${tmpBase}.mp4`;
            tmpFiles.push(outFile);

            await execPromise(
                `ffmpeg -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
                { timeout: FFMPEG_TIMEOUT }
            );

            const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0
                ? outFile
                : rawFile;

            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(finalFile)),
                ffprobeDuration(finalFile),
                ytInfo(url),
            ]);

            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp+ffmpeg' };
        }

    } finally {
        cleanup();
    }
};

        
