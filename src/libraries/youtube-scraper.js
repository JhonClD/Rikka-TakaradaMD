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
    // tv_embedded: no requiere n-challenge Y acepta cookies (a diferencia de ios/android)
    '--extractor-args "youtube:player_client=tv_embedded,mweb"',
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

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDERS EXTERNOS — se usan antes de yt-dlp para evitar el bloqueo de IP
// Se prueban en orden; si uno falla se pasa al siguiente.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descarga un archivo desde una URL y lo devuelve como Buffer.
 * Reintenta hasta 2 veces ante errores de red.
 */
const fetchBuffer = async (url, headers = {}, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
                    ...headers,
                },
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        }
    }
};

// ── Provider 1: cobalt.tools ─────────────────────────────────────────────────
// API pública, sin key. Soporta audio MP3 directo.
const providerCobalt = async (ytUrl, type) => {
    const res = await fetch('https://api.cobalt.tools/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            url:           ytUrl,
            downloadMode:  type === 'audio' ? 'audio' : 'auto',
            audioFormat:   'mp3',
            audioBitrate:  '128',
            videoQuality:  '720',
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`cobalt HTTP ${res.status}`);
    const json = await res.json();
    if (!['tunnel', 'redirect', 'stream'].includes(json.status))
        throw new Error(`cobalt status: ${json.status} — ${json.error?.code || ''}`);
    return await fetchBuffer(json.url);
};

// ── Provider 2: apio16dlp.cnvmp3.online ──────────────────────────────────────
// Convierte, espera el job y descarga el archivo resultante.
const providerCnvMp3 = async (ytUrl, type) => {
    const BASE = 'https://apio16dlp.cnvmp3.online';
    // Paso 1: enviar la URL al convertidor
    const convertRes = await fetch(`${BASE}/convert`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ytUrl, format: type === 'audio' ? 'mp3' : 'mp4', quality: type === 'audio' ? '128' : '720' }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!convertRes.ok) throw new Error(`cnvmp3 convert HTTP ${convertRes.status}`);
    const conv = await convertRes.json();

    // El campo puede ser 'file', 'filename', 'id', 'result', 'path', etc.
    const fileId = conv.file || conv.filename || conv.id || conv.result || conv.path;
    if (!fileId) throw new Error(`cnvmp3: sin file ID en respuesta: ${JSON.stringify(conv)}`);

    // Paso 2: descargar el archivo
    const downloadUrl = fileId.startsWith('http')
        ? fileId
        : `${BASE}/downloads/download.php?file=/${fileId}`;

    return await fetchBuffer(downloadUrl);
};

// ── Provider 3: loader.to ────────────────────────────────────────────────────
const providerLoaderTo = async (ytUrl, type) => {
    const fmt = type === 'audio' ? 'mp3' : 'mp4';
    // Paso 1: iniciar conversión
    const initRes = await fetch(
        `https://loader.to/ajax/download.php?format=${fmt}&url=${encodeURIComponent(ytUrl)}`,
        { headers: { 'Referer': 'https://loader.to/' }, signal: AbortSignal.timeout(15_000) }
    );
    if (!initRes.ok) throw new Error(`loader.to init HTTP ${initRes.status}`);
    const init = await initRes.json();
    if (!init.id) throw new Error('loader.to: sin ID de job');

    // Paso 2: polling hasta que esté listo (máx 60s)
    let downloadUrl = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2_000));
        const pollRes = await fetch(
            `https://loader.to/ajax/progress.php?id=${init.id}`,
            { signal: AbortSignal.timeout(10_000) }
        );
        const poll = await pollRes.json();
        if (poll.download_url) { downloadUrl = poll.download_url; break; }
        if (poll.success === 0) throw new Error('loader.to: conversión fallida');
    }
    if (!downloadUrl) throw new Error('loader.to: timeout esperando conversión');
    return await fetchBuffer(downloadUrl, { 'Referer': 'https://loader.to/' });
};

// ── Provider 4: yt1s.com ─────────────────────────────────────────────────────
const providerYt1s = async (ytUrl, type) => {
    const fmt = type === 'audio' ? 'mp3' : 'mp4';
    const vid = ytUrl.match(/[?&]v=([^&]+)/)?.[1] || ytUrl.split('/').pop();
    if (!vid) throw new Error('yt1s: no se pudo extraer video ID');

    const analyzeRes = await fetch('https://yt1s.com/api/ajaxSearch/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://yt1s.com/' },
        body: `q=${encodeURIComponent(ytUrl)}&vt=${fmt}`,
        signal: AbortSignal.timeout(15_000),
    });
    if (!analyzeRes.ok) throw new Error(`yt1s analyze HTTP ${analyzeRes.status}`);
    const analyze = await analyzeRes.json();
    if (analyze.status !== 'ok') throw new Error('yt1s: analyze falló');

    // Elegir calidad: 128kbps para audio, 720p para video
    const links = type === 'audio'
        ? analyze.links?.mp3?.mp3128
        : analyze.links?.mp4?.p720;
    if (!links?.k) throw new Error('yt1s: sin formato disponible');

    const convertRes = await fetch('https://yt1s.com/api/ajaxConvert/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://yt1s.com/' },
        body: `vid=${analyze.vid}&k=${links.k}`,
        signal: AbortSignal.timeout(30_000),
    });
    if (!convertRes.ok) throw new Error(`yt1s convert HTTP ${convertRes.status}`);
    const convert = await convertRes.json();
    if (!convert.dlink) throw new Error('yt1s: sin download link');

    return await fetchBuffer(convert.dlink, { 'Referer': 'https://yt1s.com/' });
};

// ── Cadena de providers ───────────────────────────────────────────────────────
// Se intenta cada uno en orden; si falla se loguea y pasa al siguiente.
const PROVIDERS = [
    { name: 'cobalt.tools',             fn: providerCobalt   },
    { name: 'apio16dlp.cnvmp3.online',  fn: providerCnvMp3   },
    { name: 'loader.to',                fn: providerLoaderTo },
    { name: 'yt1s.com',                 fn: providerYt1s     },
];

const downloadViaProviders = async (ytUrl, type) => {
    const errors = [];
    for (const { name, fn } of PROVIDERS) {
        try {
            console.log(`[yt-providers] Intentando ${name}…`);
            const buf = await fn(ytUrl, type);
            if (buf && buf.length > 10_000) {
                console.log(`[yt-providers] ✅ ${name} — ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
                return { buffer: buf, provider: name };
            }
            throw new Error(`Buffer muy pequeño (${buf?.length ?? 0} bytes)`);
        } catch (e) {
            console.warn(`[yt-providers] ❌ ${name}: ${e.message}`);
            errors.push(`${name}: ${e.message}`);
        }
    }
    throw new Error(`Todos los providers fallaron:\n${errors.join('\n')}`);
};

// ─────────────────────────────────────────────────────────────────────────────
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

    // Meta se obtiene en paralelo (no bloquea si falla)
    const metaPromise = ytInfo(url).catch(() => ({}));

    const ffmpegAudio = async (rawFile, outFile) => {
        try {
            await execPromise(
                `ffmpeg -y -i "${rawFile}" -vn -c:a libmp3lame -q:a 2 -write_xing 1 "${outFile}"`,
                { timeout: FFMPEG_TIMEOUT }
            );
        } catch { fs.copyFileSync(rawFile, outFile); }
    };

    const ffmpegVideo = async (rawFile, outFile) => {
        try {
            await execPromise(
                `ffmpeg -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
                { timeout: FFMPEG_TIMEOUT }
            );
        } catch { fs.copyFileSync(rawFile, outFile); }
    };

    try {
        // ── PASO 1: providers externos (evita el bloqueo de IP de yt-dlp) ────
        let extBuffer   = null;
        let extProvider = null;
        try {
            const res = await downloadViaProviders(url, type);
            extBuffer   = res.buffer;
            extProvider = res.provider;
        } catch (err) {
            console.warn(`[ytDownload] Providers externos: ${err.message}`);
        }

        if (extBuffer) {
            const rawFile = `${tmpBase}.ext_raw`;
            fs.writeFileSync(rawFile, extBuffer);
            tmpFiles.push(rawFile);

            if (type === 'audio') {
                const outFile = `${tmpBase}.mp3`;
                tmpFiles.push(outFile);
                await ffmpegAudio(rawFile, outFile);
                const [buffer, seconds, meta] = await Promise.all([
                    Promise.resolve(fs.readFileSync(outFile)),
                    ffprobeDuration(outFile),
                    metaPromise,
                ]);
                return { buffer, seconds, meta: meta || {}, provider: extProvider };
            } else {
                const outFile = `${tmpBase}.mp4`;
                tmpFiles.push(outFile);
                await ffmpegVideo(rawFile, outFile);
                const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : rawFile;
                const [buffer, seconds, meta] = await Promise.all([
                    Promise.resolve(fs.readFileSync(finalFile)),
                    ffprobeDuration(finalFile),
                    metaPromise,
                ]);
                return { buffer, seconds, meta: meta || {}, provider: extProvider };
            }
        }

        // ── PASO 2: fallback yt-dlp local ────────────────────────────────────
        console.warn('[ytDownload] Todos los providers fallaron — usando yt-dlp local…');

        if (type === 'audio') {
            await ytdlpExec(
                `--no-playlist --no-warnings -x -o "${tmpBase}_raw.%(ext)s" "${url}"`
            );
            const rawFile = ['m4a','webm','opus','ogg','mp3','wav','aac','flac']
                .map(ext => `${tmpBase}_raw.${ext}`)
                .find(f => fs.existsSync(f));
            if (!rawFile) throw new Error('yt-dlp no descargó el archivo de audio.');
            tmpFiles.push(rawFile);
            const outFile = `${tmpBase}.mp3`;
            tmpFiles.push(outFile);
            await ffmpegAudio(rawFile, outFile);
            if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0)
                throw new Error('ffmpeg no pudo convertir el audio a MP3.');
            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(outFile)),
                ffprobeDuration(outFile),
                metaPromise,
            ]);
            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp+ffmpeg' };

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
            const outFile = `${tmpBase}.mp4`;
            tmpFiles.push(outFile);
            await ffmpegVideo(rawFile, outFile);
            const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : rawFile;
            const [buffer, seconds, meta] = await Promise.all([
                Promise.resolve(fs.readFileSync(finalFile)),
                ffprobeDuration(finalFile),
                metaPromise,
            ]);
            return { buffer, seconds, meta: meta || {}, provider: 'yt-dlp+ffmpeg' };
        }

    } finally {
        cleanup();
    }
};
                
