import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';
import os            from 'os';
import path          from 'path';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 120_000;
const TMP_DIR        = os.tmpdir();

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

// ── Mapeo de calidad → formato loader.to ─────────────────────────────────────
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

// ── Provider: loader.to ───────────────────────────────────────────────────────

const providerLoaderTo = async (ytUrl, fmt) => {
    const BASE    = 'https://loader.to';
    const REFERER = `${BASE}/`;

    const startRes = await fetch(
        `${BASE}/ajax/download.php?format=${fmt}&url=${encodeURIComponent(ytUrl)}&api=dfcb6d76f2f2a12c83a82a4de3bc75e8`,
        { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(30_000) }
    );
    if (!startRes.ok) throw new Error(`loader.to start HTTP ${startRes.status}`);
    const start = await startRes.json();
    if (!start.id) throw new Error(`loader.to: sin id — ${JSON.stringify(start).slice(0, 100)}`);

    console.log(`[loader.to] id=${start.id} fmt=${fmt}`);

    // Polling adaptativo: 1s×5 → 2s×5 → 3s×5 → 5s×∞  (tope 3 min)
    const intervals = [
        ...Array(5).fill(1_000),
        ...Array(5).fill(2_000),
        ...Array(5).fill(3_000),
    ];
    const getDelay = (i) => intervals[i] ?? 5_000;
    const MAX_MS   = 3 * 60 * 1_000;
    const t0       = Date.now();
    let   lastPct  = -1;

    for (let i = 0; Date.now() - t0 < MAX_MS; i++) {
        await new Promise(r => setTimeout(r, getDelay(i)));

        const progRes = await fetch(
            `${BASE}/ajax/progress.php?id=${start.id}`,
            { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(20_000) }
        );
        if (!progRes.ok) continue;

        const prog = await progRes.json();

        // Loguear progreso solo cuando cambia
        const pct = prog.progress ?? prog.percent ?? null;
        if (pct !== null && pct !== lastPct) {
            console.log(`[loader.to] progreso: ${pct}%`);
            lastPct = pct;
        }

        if (prog.download_url) {
            console.log(`[loader.to] ✅ listo en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            return await fetchBuffer(prog.download_url, { Referer: REFERER });
        }
        if (prog.success === false) throw new Error('loader.to: falló la conversión');
    }
    throw new Error('loader.to: timeout esperando conversión (3 min)');
};

// ── Descarga ──────────────────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality) => {
    const fmt = resolveFormat(type, quality);
    console.log(`[yt-providers] loader.to — fmt=${fmt}`);
    try {
        const buf = await providerLoaderTo(ytUrl, fmt);
        if (buf && buf.length > 10_000) {
            console.log(`[yt-providers] ✅ ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
            return { buffer: buf, provider: 'loader.to' };
        }
        throw new Error(`Buffer muy pequeño (${buf?.length ?? 0} bytes)`);
    } catch (e) {
        console.warn(`[yt-providers] ❌ loader.to: ${e.message}`);
        throw new Error(`loader.to falló: ${e.message}`);
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
        
