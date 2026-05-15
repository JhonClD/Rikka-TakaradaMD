import fs from 'fs';
import yts from 'yt-search';
import { exec, execFile, execSync } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const execAsync  = promisify(exec);
const TMP_DIR    = os.tmpdir();

const FFMPEG_TIMEOUT   = 120_000;
const PROVIDER_TIMEOUT = 90_000;
const MIN_BUFFER_SIZE  = 10_000;
const MAX_FILE_SIZE    = 200 * 1024 * 1024;
const COOKIES_FILE     = path.resolve(__dirname, '../../src/cookies.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let FFMPEG_BIN  = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';

(async () => {
    try { await execAsync('ffmpeg -version', { timeout: 5_000 }); }
    catch {
        try {
            const { default: p } = await import('ffmpeg-static');
            if (p && fs.existsSync(p)) FFMPEG_BIN = p;
        } catch {}
    }
    try { await execAsync('ffprobe -version', { timeout: 5_000 }); }
    catch {
        if (FFMPEG_BIN !== 'ffmpeg') {
            const sidecar = FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
            if (fs.existsSync(sidecar)) FFPROBE_BIN = sidecar;
        }
    }
})();

const YTDLP_BIN = (() => {
    const candidates = [
        '/home/container/.local/bin/yt-dlp',
        '/home/container/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        '/data/data/com.termux/files/usr/bin/yt-dlp',
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    try {
        const r = execSync('which yt-dlp', { timeout: 3_000 }).toString().trim();
        if (r) return r;
    } catch {}
    return 'yt-dlp';
})();

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

const extractVideoId = (url) => url.match(YT_REGEX)?.[1] ?? null;

const withTimeout = (ms, promise, msg = 'timeout') =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
    ]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const ytdlpMeta = async (url) => {
    const cookiesArg = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];
    return new Promise((resolve) => {
        execFile(
            YTDLP_BIN,
            [...cookiesArg, '--no-playlist', '--skip-download', '--print-json', url],
            { timeout: 20_000 },
            (err, stdout) => {
                if (err || !stdout) return resolve(null);
                try {
                    const j = JSON.parse(stdout.trim().split('\n').at(-1));
                    resolve({
                        title:    j.title,
                        channel:  j.uploader || j.channel,
                        views:    j.view_count,
                        duration: j.duration,
                        date:     j.upload_date,
                        url,
                        thumbnail: j.thumbnail,
                        videoId:  j.id,
                    });
                } catch { resolve(null); }
            }
        );
    });
};

const fetchBuffer = async (url, headers = {}, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, ...headers },
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_FILE_SIZE)
                throw new Error(`Archivo muy grande (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
            return buf;
        } catch (e) {
            if (i === retries) throw e;
            await sleep(1_500 * (i + 1));
        }
    }
};

const safeJson = async (res) => {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json') && !ct.includes('text/json')) {
        const text = await res.text();
        if (text.trim().startsWith('<'))
            throw new Error('Respuesta HTML (endpoint caído o redirigido)');
        return JSON.parse(text);
    }
    return res.json();
};

const ffmpegAudio = async (rawFile, outFile) => {
    try {
        await execAsync(
            `"${FFMPEG_BIN}" -y -i "${rawFile}" -vn -c:a libmp3lame -q:a 2 -write_xing 1 "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch { fs.copyFileSync(rawFile, outFile); }
};

const ffmpegVideo = async (rawFile, outFile) => {
    try {
        await execAsync(
            `"${FFMPEG_BIN}" -y -i "${rawFile}" -c copy -movflags +faststart "${outFile}"`,
            { timeout: FFMPEG_TIMEOUT }
        );
    } catch { fs.copyFileSync(rawFile, outFile); }
};

const runYtdlp = async (args, stamp) => {
    await new Promise((resolve, reject) => {
        execFile(YTDLP_BIN, args, { timeout: 180_000 }, (err, _out, stderr) => {
            if (err) return reject(new Error(stderr?.trim() || err.message));
            resolve();
        });
    });
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(`tmp_ytdl_${stamp}_`));
    const found = files.map(f => path.join(TMP_DIR, f)).find(f => fs.existsSync(f));
    if (!found) throw new Error('archivo no encontrado');
    const stat = fs.statSync(found);
    if (stat.size > MAX_FILE_SIZE) {
        try { fs.unlinkSync(found); } catch {}
        throw new Error(`Archivo muy grande (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    }
    const buf = fs.readFileSync(found);
    try { fs.unlinkSync(found); } catch {}
    if (!buf || buf.length < MIN_BUFFER_SIZE) throw new Error('archivo muy pequeño');
    return buf;
};

const providerYtdlp = async (ytUrl, type) => {
    const cookiesArg = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];
    const base = [
        ...cookiesArg,
        '--no-playlist', '--no-warnings', '--no-check-certificate',
        '--socket-timeout', '30', '--retries', '3',
        '--fragment-retries', '5', '--retry-sleep', 'fragment:2',
        '--user-agent', UA,
    ];
    const audioFmt = [
        '-f', 'ba[ext=m4a]/ba[ext=webm]/ba/b',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
    ];
    const videoFmt = [
        '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
        '--merge-output-format', 'mp4',
    ];
    const strategies = [
        ['--extractor-args', 'youtube:player_client=android_vr,ios'],
        ['--extractor-args', 'youtube:player_client=tv_embedded,android'],
        ['--extractor-args', 'youtube:player_client=web_creator,android_vr'],
        ['--extractor-args', 'youtube:player_client=ios,mweb'],
        ['--extractor-args', 'youtube:player_client=android_testsuite,ios'],
        ['--extractor-args', 'youtube:player_client=mediaconnect,android'],
        ['--extractor-args', 'youtube:player_client=tv,web'],
        [],
    ];
    const errors = [];
    for (let i = 0; i < strategies.length; i++) {
        const stamp = `${Date.now()}${i}`;
        const out   = path.join(TMP_DIR, `tmp_ytdl_${stamp}_raw.%(ext)s`);
        const args  = [...base, ...strategies[i], ...(type === 'audio' ? audioFmt : videoFmt), '-o', out, ytUrl];
        try { return await runYtdlp(args, `${stamp}_raw`); }
        catch (e) { errors.push(e.message.split('\n')[0]); }
    }
    throw new Error(`yt-dlp: ${errors.at(-1)}`);
};


const providerCobalt = async (ytUrl, type) => {
    const instances = [
        { base: 'https://cobalt.api.timelessnesses.me', v: 7 },
        { base: 'https://api.cobalt.tools',             v: 7 },
        { base: 'https://cobalt.drgns.space',           v: 7 },
        { base: 'https://co.wuk.sh',                    v: 7 },
        { base: 'https://cobalt.aloha.gay',             v: 7 },
        { base: 'https://cobaltapi.squair.xyz',         v: 7 },
        { base: 'https://api.cobalt.liubquanti.click',  v: 7 },
        { base: 'https://cobalt.serv00.net',            v: 7 },
        { base: 'https://cobalt.nadeko.net',            v: 7 },
        { base: 'https://cobalt.lunar.icu',             v: 7 },
        { base: 'https://sunny.imput.net',              v: 6 },
        { base: 'https://nuko-c.meowing.de',            v: 6 },
        { base: 'https://melon.clxxped.lol',            v: 6 },
        { base: 'https://lime.clxxped.lol',             v: 6 },
    ];
    const errors = [];
    for (const { base, v } of instances) {
        try {
            const endpoint = v === 7 ? `${base}/` : `${base}/api/json`;
            const body = {
                url: ytUrl,
                downloadMode: type === 'audio' ? 'audio' : 'auto',
                videoQuality: '720', audioFormat: 'mp3', filenameStyle: 'basic',
                ...(v === 7 ? { youtubeHLS: false } : {}),
            };
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body:   JSON.stringify(body),
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
            const json  = await safeJson(res);
            const dlUrl = json.url || json?.picker?.[0]?.url;
            if (dlUrl) return await fetchBuffer(dlUrl);
            errors.push(`${base}: sin URL`);
        } catch (e) { errors.push(`${base}: ${e.message}`); }
    }
    throw new Error(`cobalt: ${errors.at(-1) ?? 'sin instancias'}`);
};










const providerVidsSave = async (ytUrl, type) => {
    const res = await fetch('https://api.vidssave.com/api/contentsite_api/media/parse', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
            'Referer': 'https://vidssave.com/',
            'Origin': 'https://vidssave.com'
        },
        body: new URLSearchParams({
            auth: '20250901majwlqo',
            domain: 'api-ak.vidssave.com',
            origin: 'cache',
            link: ytUrl
        }),
        signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`vidssave: HTTP ${res.status}`);
    const json = await safeJson(res);
    const resources = json.data?.resources || [];
    if (!resources.length) throw new Error('vidssave: sin recursos');
    
    let best;
    if (type === 'audio') {
        best = resources.find(r => r.type === 'audio' && r.format === 'MP3') || resources.find(r => r.type === 'audio');
    } else {
        const sorted = resources
            .filter(r => r.type === 'video' && r.format === 'MP4')
            .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
        best = sorted.find(r => parseInt(r.quality) <= 720) || sorted[0];
    }
    
    if (!best?.download_url) throw new Error('vidssave: sin link de descarga');
    return await fetchBuffer(best.download_url, { Referer: 'https://vidssave.com/' });
};

const runProvider = (name, fn, ytUrl, type) =>
    withTimeout(PROVIDER_TIMEOUT, fn(ytUrl, type), `${name}: timeout (${PROVIDER_TIMEOUT / 1000}s)`);

const downloadViaProviders = async (ytUrl, type) => {
    const errors = {};
    try {
        const result = await Promise.any([
            runProvider('vidssave', providerVidsSave, ytUrl, type).then(b => ({ buf: b, provider: 'vidssave' })),
            runProvider('cobalt',   providerCobalt,   ytUrl, type).then(b => ({ buf: b, provider: 'cobalt'   })),
            runProvider('ytdlp',    providerYtdlp,    ytUrl, type).then(b => ({ buf: b, provider: 'ytdlp'    })),
        ]);
        if (result.buf?.length > MIN_BUFFER_SIZE) return { buffer: result.buf, provider: result.provider };
    } catch (agg) {
        if (agg.errors) {
            for (const e of agg.errors) {
                errors[e.message?.split(':')[0] ?? 'unknown'] = e.message;
            }
        }
    }
    const sequential = [];
    for (const { name, fn } of sequential) {
        try {
            const buf = await runProvider(name, fn, ytUrl, type);
            if (buf?.length > MIN_BUFFER_SIZE) return { buffer: buf, provider: name };
        } catch (e) {
            errors[name] = e.message;
        }
    }
    throw new Error(
        Object.entries(errors).map(([k, v]) => `${k}: ${v.split('\n')[0]}`).join('\n')
    );
};

export const ytDownload = async (url, type = 'audio') => {
    if (!url || typeof url !== 'string') throw new Error('URL invÃ¡lida');
    if (type !== 'audio' && type !== 'video') throw new Error('type debe ser "audio" o "video"');
    if (!YT_REGEX.test(url) && !extractVideoId(url)) throw new Error('No es una URL de YouTube vÃ¡lida');

    const stamp    = Date.now();
    const tmpBase  = path.join(TMP_DIR, `ytdl_${stamp}`);
    const tmpFiles = [];
    const cleanup  = () => tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

    const ytsMetaPromise = ytInfo(url).catch(() => null);

    try {
        const { buffer: rawBuf, provider } = await downloadViaProviders(url, type);
        const ext     = type === 'audio' ? 'mp3' : 'mp4';
        const rawFile = `${tmpBase}.raw`;
        const outFile = `${tmpBase}.${ext}`;
        tmpFiles.push(rawFile, outFile);
        fs.writeFileSync(rawFile, rawBuf);
        const [, seconds, ytsMeta, dlpMeta] = await Promise.all([
            type === 'audio' ? ffmpegAudio(rawFile, outFile) : ffmpegVideo(rawFile, outFile),
            ffprobeDuration(rawFile),
            ytsMetaPromise,
            provider === 'ytdlp' ? ytdlpMeta(url) : Promise.resolve(null),
        ]);
        const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : rawFile;
        const buffer    = fs.readFileSync(finalFile);
        const meta      = dlpMeta || ytsMeta || {};
        return { buffer, seconds, meta, provider };
    } finally {
        cleanup();
    }
};

