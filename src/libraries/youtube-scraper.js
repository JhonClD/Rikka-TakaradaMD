import fs            from 'fs';
import yts           from 'yt-search';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os             from 'os';
import path           from 'path';
import { fileURLToPath } from 'url';

const execPromise    = promisify(exec);
const execFilePromise = promisify(execFile);
const FFMPEG_TIMEOUT = 120_000;
const TMP_DIR        = os.tmpdir();

// Este proyecto no depende de dotenv. Cargar solo las variables ausentes
// permite que /play funcione igual con PM2, npm start o una ejecución directa.
const loadProjectEnv = () => {
    const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'),
    ];
    const envFile = candidates.find(file => fs.existsSync(file));
    if (!envFile) return;

    try {
        const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!match || match[1] in process.env) continue;
            const value = match[2].replace(/^(["'])(.*)\1$/, '$2').trim();
            process.env[match[1]] = value;
        }
    } catch (error) {
        console.warn(`[env] no se pudo leer ${envFile}: ${error.message}`);
    }
};

loadProjectEnv();

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Mapeo de calidad → formato yt-dlp ─────────────────────────────────────────
// Video soportado: 144 240 360 480 720 1080 1440 4k
// Audio soportado: mp3 m4a webm aac flac opus ogg wav

const AUDIO_FORMATS = new Set(['mp3','m4a','webm','aac','flac','opus','ogg','wav']);

const resolveFormat = (type, quality = '720p') => {
    if (type === 'audio') {
        const q = quality.toLowerCase();
        return AUDIO_FORMATS.has(q) ? q : 'mp3';
    }
    // video: extraer número o '4k'
    const q = quality.toString().toLowerCase().replace('p', '');
    const valid = ['144','240','360','480','720','1080','1440','4k'];
    return valid.includes(q) ? q : '720';
};

// ── Fetch con reintentos ──────────────────────────────────────────────────────

const fetchBuffer = async (url, headers = {}, retries = 3) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
                    ...headers,
                },
                signal: AbortSignal.timeout(120_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
};

// ── FFmpeg ────────────────────────────────────────────────────────────────────

const ffmpegAudio = async (rawFile, outFile) => {
    try {
        await execPromise(
            `ffmpeg -y -i "${rawFile}" -vn -c:a libmp3lame -q:a 2 -write_xing 1 "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch (e) {
        console.warn(`[ffmpeg] audio falló, copiando raw: ${e.message}`);
        fs.copyFileSync(rawFile, outFile);
    }
};

const ffmpegVideo = async (rawFile, outFile) => {
    try {
        await execPromise(
            `ffmpeg -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch (e) {
        console.warn(`[ffmpeg] video falló, copiando raw: ${e.message}`);
        fs.copyFileSync(rawFile, outFile);
    }
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Provider: yt-dlp local ───────────────────────────────────────────────────

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

const providerYtDlp = async (ytUrl, type, quality) => {
    const stamp = `${process.pid}_${Date.now()}`;
    const base = path.join(TMP_DIR, `ytdlp_${stamp}`);
    const output = `${base}.%(ext)s`;
    const args = [
        '--no-playlist',
        '--no-part',
        '--no-mtime',
        '--no-warnings',
        '--newline',
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github',
        '--output', output,
    ];

    if (type === 'audio') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '192K',
            '-f', 'bestaudio/best');
    } else {
        const height = String(quality || '360p').replace(/p$/i, '');
        args.push('-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
            '--merge-output-format', 'mp4');
    }
    args.push('--', ytUrl);

    console.log(`[yt-dlp] iniciando ${type} (${quality || '192K'})`);
    try {
        await execFilePromise(YTDLP_BIN, args, {
            timeout: 4 * 60_000,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (error) {
        const detail = String(error.stderr || error.message || '').trim().split('\n').slice(-4).join(' ');
        if (/ENOENT/.test(String(error.code)) || /not found/i.test(detail)) {
            throw new Error('yt-dlp no está instalado. Instala yt-dlp y ffmpeg en la VPS.');
        }
        throw new Error(`yt-dlp falló${detail ? `: ${detail}` : ''}`);
    }

    const files = fs.readdirSync(TMP_DIR)
        .filter(name => name.startsWith(`ytdlp_${stamp}.`))
        .map(name => path.join(TMP_DIR, name))
        .filter(file => fs.statSync(file).size > 0);
    if (!files.length) throw new Error('yt-dlp terminó sin producir un archivo');
    const file = files[0];
    try {
        return { buffer: fs.readFileSync(file), provider: 'yt-dlp' };
    } finally {
        for (const candidate of files) {
            try { fs.unlinkSync(candidate); } catch {}
        }
    }
};

// ── Descarga ──────────────────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality) => {
    const fmt = resolveFormat(type, quality);
    console.log(`[yt-providers] yt-dlp — fmt=${fmt}`);
    try {
        const result = await providerYtDlp(ytUrl, type, quality);
        const buf = result?.buffer;
        if (buf && buf.length > 10_000) {
            console.log(`[yt-providers] ✅ ${(buf.length / 1024 / 1024).toFixed(2)} MB vía yt-dlp`);
            return result;
        }
        throw new Error(`Buffer muy pequeño (${buf?.length ?? 0} bytes)`);
    } catch (e) {
        console.warn(`[yt-providers] ❌ yt-dlp: ${e.message}`);
        throw new Error(`yt-dlp falló: ${e.message}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality = type === 'audio' ? 'mp3' : '720p' } = opts;
    const stamp    = Date.now();
    const tmpBase  = path.join(TMP_DIR, `ytdl_${stamp}`);
    const tmpFiles = [];
    const cleanup  = () =>
        tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

    // Lanzar búsqueda de metadata en paralelo con la descarga
    const metaPromise = ytInfo(url).catch(() => ({}));

    try {
        const { buffer: rawBuf, provider } = await downloadViaProviders(url, type, quality);

        if (type === 'audio') {
            const rawFile = `${tmpBase}.ext_raw`;
            const outFile = `${tmpBase}.mp3`;
            tmpFiles.push(rawFile, outFile);
            fs.writeFileSync(rawFile, rawBuf);
            await ffmpegAudio(rawFile, outFile);
            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(outFile)),
                ffprobeDuration(outFile),
                metaPromise,
            ]);
            return { buffer, seconds, meta: meta || {}, provider };
        } else {
            const rawFile = `${tmpBase}.ext_raw`;
            const outFile = `${tmpBase}.mp4`;
            tmpFiles.push(rawFile, outFile);
            fs.writeFileSync(rawFile, rawBuf);
            await ffmpegVideo(rawFile, outFile);
            const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0
                ? outFile : rawFile;
            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(finalFile)),
                ffprobeDuration(finalFile),
                metaPromise,
            ]);
            return { buffer, seconds, meta: meta || {}, provider };
        }
    } finally {
        cleanup();
    }
};
        
