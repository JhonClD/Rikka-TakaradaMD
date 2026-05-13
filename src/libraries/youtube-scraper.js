import fs from 'fs';
import yts from 'yt-search';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIES_FILE = path.resolve(__dirname, '../../src/cookies.txt');

const execPromise = promisify(exec);
const FFMPEG_TIMEOUT = 90_000;
const TMP_DIR = os.tmpdir();

let FFMPEG_BIN = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';

(async () => {
    try {
        await execPromise('ffmpeg -version', { timeout: 4000 });
    } catch {
        try {
            const { default: ffmpegPath } = await import('ffmpeg-static');
            if (ffmpegPath && fs.existsSync(ffmpegPath)) {
                FFMPEG_BIN = ffmpegPath;
            }
        } catch {}
    }
})();

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

const extractVideoId = (url) => url.match(YT_REGEX)?.[1] ?? null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const ffprobeDuration = async (filePath) => {
    try {
        const { stdout } = await execPromise(
            `"${FFPROBE_BIN}" -v error -show_entries format=duration ` +
            `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`
        );
        const dur = parseFloat(stdout.trim());
        return isNaN(dur) || dur <= 0 ? 0 : Math.round(dur);
    } catch { return 0; }
};

export const formatViews = (n) => {
    if (n == null) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
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
    const icon = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    const title = meta.title || 'Sin título';
    const channel = meta.channel || 'N/A';
    const views = formatViews(meta.views);
    const dur = formatDuration(meta.duration || meta.timestamp);
    const date = formatDate(meta.date || meta.upload_date || meta.ago);
    const link = meta.url || '';
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
            const r = await yts({ videoId: match[1] });
            return r ? normalizeYts(r) : null;
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? normalizeYts(r) : null;
    } catch { return null; }
};

export const ytInfo = (url) => ytSearch(url);

const fetchBuffer = async (url, headers = {}, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, ...headers },
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        }
    }
};

const ffmpegAudio = async (rawFile, outFile) => {
    try {
        await execPromise(
            `"${FFMPEG_BIN}" -y -i "${rawFile}" -vn -c:a libmp3lame -q:a 2 -write_xing 1 "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch { fs.copyFileSync(rawFile, outFile); }
};

const ffmpegVideo = async (rawFile, outFile) => {
    try {
        await execPromise(
            `"${FFMPEG_BIN}" -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch { fs.copyFileSync(rawFile, outFile); }
};

const providerVreden = async (ytUrl, type) => {
    try {
        const { ytmp3, ytmp4 } = await import('@vreden/youtube_scraper');
        const res = type === 'audio' ? await ytmp3(ytUrl) : await ytmp4(ytUrl);
        if (res.status && res.download?.url) {
            return await fetchBuffer(res.download.url);
        }
        throw new Error('Vreden: sin link');
    } catch (e) { throw e; }
};

const providerCobalt = async (ytUrl, type) => {
    const instances = [
        'https://grapefruit.clxxped.lol',
        'https://nuko-c.meowing.de',
        'https://melon.clxxped.lol',
        'https://cobaltapi.kittycat.boo',
        'https://subito-c.meowing.de',
        'https://sunny.imput.net'
    ];
    for (const base of instances) {
        try {
            const res = await fetch(`${base}/api/json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({
                    url: ytUrl,
                    downloadMode: type === 'audio' ? 'audio' : 'auto',
                    videoQuality: '720',
                    audioFormat: 'mp3'
                }),
                signal: AbortSignal.timeout(15_000),
            });
            const json = await res.json();
            const dlUrl = json.url || json?.picker?.[0]?.url;
            if (dlUrl) return await fetchBuffer(dlUrl);
        } catch {}
    }
    throw new Error('Cobalt: falló');
};

const providerY2Mate = async (ytUrl, type) => {
    const BASE = 'https://www.y2mate.com';
    const vid = extractVideoId(ytUrl);
    if (!vid) throw new Error('Y2Mate: ID inválido');
    try {
        const aRes = await fetch(`${BASE}/mates/analyzeV2/ajax`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
            body: new URLSearchParams({ k_query: ytUrl, k_page: 'home', hl: 'es', q_auto: '0' }),
            signal: AbortSignal.timeout(20_000)
        });
        const analyze = await aRes.json();
        let k;
        if (type === 'audio') {
            k = (analyze.links?.mp3?.mp3128 || Object.values(analyze.links?.mp3 || {})[0])?.k;
        } else {
            k = (analyze.links?.mp4?.['720'] || analyze.links?.mp4?.['360'] || Object.values(analyze.links?.mp4 || {})[0])?.k;
        }
        if (!k) throw new Error('Y2Mate: sin k');
        const cRes = await fetch(`${BASE}/mates/convertV2/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
            body: new URLSearchParams({ vid: analyze.vid, k }),
            signal: AbortSignal.timeout(30_000)
        });
        const conv = await cRes.json();
        if (conv.dlink) return await fetchBuffer(conv.dlink, { Referer: BASE });
    } catch {}
    throw new Error('Y2Mate: falló');
};

const YTDLP_BIN = (() => {
    const candidates = [
        '/home/container/.local/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return 'yt-dlp';
})();

const providerYtdlp = async (ytUrl, type) => {
    const stamp = Date.now();
    const outTemplate = path.join(TMP_DIR, `tmp_ytdl_${stamp}_raw.%(ext)s`);
    const cookiesArg = (fs.existsSync(COOKIES_FILE))
        ? ['--cookies', COOKIES_FILE]
        : [];
    const args = [
        ...cookiesArg,
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        ...(type === 'audio'
            ? ['-x', '--audio-format', 'mp3', '--audio-quality', '128K']
            : ['-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4']),
        '-o', outTemplate,
        ytUrl,
    ];
    await new Promise((resolve, reject) => {
        execFile(YTDLP_BIN, args, { timeout: 120_000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`yt-dlp: ${stderr || err.message}`));
            resolve();
        });
    });
    const ext = type === 'audio' ? 'mp3' : 'mp4';
    const outFile = path.join(TMP_DIR, `tmp_ytdl_${stamp}_raw.${ext}`);
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(`tmp_ytdl_${stamp}_raw`));
    const found = files.map(f => path.join(TMP_DIR, f)).find(f => fs.existsSync(f));
    if (!found) throw new Error('yt-dlp: archivo no encontrado');
    const buf = fs.readFileSync(found);
    try { fs.unlinkSync(found); } catch {}
    if (!buf || buf.length < 10_000) throw new Error('yt-dlp: archivo muy pequeño');
    return buf;
};

const downloadViaProviders = async (ytUrl, type) => {
    const providers = [
        { name: 'ytdlp',  fn: () => providerYtdlp(ytUrl, type)  },
        { name: 'vreden', fn: () => providerVreden(ytUrl, type) },
        { name: 'cobalt', fn: () => providerCobalt(ytUrl, type) },
        { name: 'y2mate', fn: () => providerY2Mate(ytUrl, type) }
    ];
    const errors = [];
    for (const { name, fn } of providers) {
        try {
            const buf = await fn();
            if (buf && buf.length > 10_000) return { buffer: buf, provider: name };
        } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    throw new Error(errors.join('\n'));
};

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const stamp = Date.now();
    const tmpBase = path.join(TMP_DIR, `ytdl_${stamp}`);
    const tmpFiles = [];
    const cleanup = () => tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    const metaPromise = ytInfo(url).catch(() => ({}));
    try {
        const { buffer: rawBuf, provider } = await downloadViaProviders(url, type);
        const ext = type === 'audio' ? 'mp3' : 'mp4';
        const rawFile = `${tmpBase}.raw`;
        const outFile = `${tmpBase}.${ext}`;
        tmpFiles.push(rawFile, outFile);
        fs.writeFileSync(rawFile, rawBuf);
        if (type === 'audio') await ffmpegAudio(rawFile, outFile);
        else await ffmpegVideo(rawFile, outFile);
        const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : rawFile;
        const [buffer, seconds, meta] = await Promise.all([
            Promise.resolve(fs.readFileSync(finalFile)),
            ffprobeDuration(finalFile),
            metaPromise
        ]);
        return { buffer, seconds, meta: meta || {}, provider };
    } finally {
        cleanup();
    }
};
