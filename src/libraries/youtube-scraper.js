
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

/* ─── Constants ──────────────────────────────────────────────────────────── */
const FFMPEG_TIMEOUT   = 120_000;
const PROVIDER_TIMEOUT = 90_000;
const MIN_BUFFER_SIZE  = 10_000;
const MAX_FILE_SIZE    = 200 * 1024 * 1024; // 200 MB
const COOKIES_FILE     = path.resolve(__dirname, '../../src/cookies.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ─── Binary detection ───────────────────────────────────────────────────── */
let FFMPEG_BIN  = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';

(async () => {
    try {
        await execAsync('ffmpeg -version', { timeout: 5_000 });
    } catch {
        try {
            const { default: p } = await import('ffmpeg-static');
            if (p && fs.existsSync(p)) FFMPEG_BIN = p;
        } catch {}
    }
    try {
        await execAsync('ffprobe -version', { timeout: 5_000 });
    } catch {
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
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    try {
        const resolved = execSync('which yt-dlp', { timeout: 3_000 }).toString().trim();
        if (resolved) return resolved;
    } catch {}
    return 'yt-dlp';
})();

/* ─── Helpers ────────────────────────────────────────────────────────────── */
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
            `"${FFPROBE_BIN}" -v error -show_entries format=duration ` +
            `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
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

/* ─── Metadata ───────────────────────────────────────────────────────────── */
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

/* ─── Fetch helper ───────────────────────────────────────────────────────── */
const fetchBuffer = async (url, headers = {}, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, ...headers },
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_FILE_SIZE) throw new Error(`Archivo muy grande (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
            return buf;
        } catch (e) {
            if (i === retries) throw e;
            await sleep(1_500 * (i + 1));
        }
    }
};

/* ─── FFmpeg wrappers ────────────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════════
   ─── PROVIDERS ────────────────────────────────────────────────────────────
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 1. yt-dlp (binario local) ────────────────────────────────────────────── */
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
        '--socket-timeout', '30',
        '--retries', '3',
        '--fragment-retries', '5',
        '--retry-sleep', 'fragment:2',
        '--user-agent', UA,
    ];

    const audioFormat = [
        '-f', 'ba[ext=m4a]/ba[ext=webm]/ba/b',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
    ];

    const videoFormat = [
        '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
        '--merge-output-format', 'mp4',
    ];

    // 7 estrategias de player_client — 2025
    const strategies = [
        ['--extractor-args', 'youtube:player_client=android_vr,ios'],
        ['--extractor-args', 'youtube:player_client=tv_embedded,android'],
        ['--extractor-args', 'youtube:player_client=ios,mweb'],
        ['--extractor-args', 'youtube:player_client=web_creator,android_vr'],
        ['--extractor-args', 'youtube:player_client=android_testsuite,ios'],
        ['--extractor-args', 'youtube:player_client=mediaconnect,android'],
        [],
    ];

    const errors = [];
    for (let i = 0; i < strategies.length; i++) {
        const stamp = `${Date.now()}${i}`;
        const out   = path.join(TMP_DIR, `tmp_ytdl_${stamp}_raw.%(ext)s`);
        const args  = [
            ...base, ...strategies[i],
            ...(type === 'audio' ? audioFormat : videoFormat),
            '-o', out, ytUrl,
        ];
        try {
            return await runYtdlp(args, `${stamp}_raw`);
        } catch (e) {
            errors.push(e.message.split('\n')[0]);
        }
    }
    throw new Error(`yt-dlp: ${errors.at(-1)}`);
};

/* ── 2. Cobalt (v7 API + 15 instancias) ───────────────────────────────────── */
const providerCobalt = async (ytUrl, type) => {
    const instances = [
        // v7: POST / con Accept: application/json
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
        // v6 fallback: POST /api/json
        { base: 'https://sunny.imput.net',              v: 6 },
        { base: 'https://nuko-c.meowing.de',            v: 6 },
        { base: 'https://melon.clxxped.lol',            v: 6 },
        { base: 'https://lime.clxxped.lol',             v: 6 },
        { base: 'https://grapefruit.clxxped.lol',       v: 6 },
    ];

    const errors = [];

    for (const { base, v } of instances) {
        try {
            const endpoint = v === 7 ? `${base}/` : `${base}/api/json`;
            const body = v === 7
                ? {
                    url: ytUrl,
                    downloadMode: type === 'audio' ? 'audio' : 'auto',
                    videoQuality: '720',
                    audioFormat: 'mp3',
                    filenameStyle: 'basic',
                    youtubeHLS: false,
                  }
                : {
                    url: ytUrl,
                    downloadMode: type === 'audio' ? 'audio' : 'auto',
                    videoQuality: '720',
                    audioFormat: 'mp3',
                    filenameStyle: 'basic',
                  };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': UA,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(20_000),
            });

            if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
            const json  = await res.json();
            const dlUrl = json.url || json?.picker?.[0]?.url;
            if (dlUrl) return await fetchBuffer(dlUrl);
            errors.push(`${base}: sin URL (status=${json.status})`);
        } catch (e) { errors.push(`${base}: ${e.message}`); }
    }
    throw new Error(`cobalt: ${errors.at(-1) ?? 'sin instancias'}`);
};

/* ── 3. SaveFrom.net ──────────────────────────────────────────────────────── */
const providerSaveFrom = async (ytUrl, type) => {
    const videoId = extractVideoId(ytUrl);
    if (!videoId) throw new Error('savefrom: ID inválido');

    const sfUrl = `https://sfrom.net/api/button/?app=videodownloader&lang=es&url=${encodeURIComponent(ytUrl)}`;
    const res = await fetch(sfUrl, {
        headers: {
            'User-Agent': UA,
            'Referer': 'https://en.savefrom.net/',
            'Origin': 'https://en.savefrom.net',
        },
        signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) throw new Error(`savefrom: HTTP ${res.status}`);
    const json = await res.json();
    const links = json?.links ?? [];
    if (!links.length) throw new Error('savefrom: sin links');

    if (type === 'audio') {
        const audio = links.find(l => /\.mp3|mp3|audio/i.test(l.url || l.type));
        if (audio?.url) return await fetchBuffer(audio.url, { Referer: 'https://en.savefrom.net/' });
    }

    const sorted = links
        .filter(l => l.url && /mp4/i.test(l.type || l.url))
        .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

    const best720 = sorted.find(l => parseInt(l.quality) <= 720) || sorted[0];
    if (best720?.url) return await fetchBuffer(best720.url, { Referer: 'https://en.savefrom.net/' });
    throw new Error('savefrom: sin link válido');
};

/* ── 4. loader.to ─────────────────────────────────────────────────────────── */
const providerLoaderTo = async (ytUrl, type) => {
    const format = type === 'audio' ? 'mp3' : 'mp4';

    const initRes = await fetch(
        `https://loader.to/api/button/?url=${encodeURIComponent(ytUrl)}&f=${format}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) }
    );

    if (!initRes.ok) throw new Error(`loader.to init: HTTP ${initRes.status}`);
    const initJson = await initRes.json();
    const id = initJson?.id;
    if (!id) throw new Error('loader.to: sin ID de tarea');

    for (let i = 0; i < 30; i++) {
        await sleep(3_000);
        const statusRes = await fetch(
            `https://loader.to/api/info/?format=${format}&url=${encodeURIComponent(ytUrl)}&id=${id}`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) }
        );
        if (!statusRes.ok) continue;
        const statusJson = await statusRes.json();
        if (statusJson?.success && statusJson?.download_url) {
            return await fetchBuffer(statusJson.download_url);
        }
    }
    throw new Error('loader.to: timeout esperando descarga');
};

/* ── 5. SnapSave ──────────────────────────────────────────────────────────── */
const providerSnapSave = async (ytUrl, type) => {
    const res = await fetch('https://snap-save.app/api/download', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': UA,
            'Referer': 'https://snap-save.app/',
        },
        body: JSON.stringify({ url: ytUrl }),
        signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) throw new Error(`snapsave: HTTP ${res.status}`);
    const json = await res.json();

    if (type === 'audio') {
        const audio = json?.data?.audios?.[0] || json?.data?.audio;
        if (audio?.url) return await fetchBuffer(audio.url, { Referer: 'https://snap-save.app/' });
        throw new Error('snapsave: sin link de audio');
    }

    const videos = json?.data?.videos ?? json?.data ?? [];
    const arr    = Array.isArray(videos) ? videos : [];
    const v720   = arr.find(v => String(v.quality).includes('720')) || arr[0];
    if (v720?.url) return await fetchBuffer(v720.url, { Referer: 'https://snap-save.app/' });
    throw new Error('snapsave: sin link de video');
};

/* ── 6. yt1s.com ──────────────────────────────────────────────────────────── */
const providerYt1s = async (ytUrl, type) => {
    const videoId = extractVideoId(ytUrl);
    if (!videoId) throw new Error('yt1s: ID inválido');

    const format = type === 'audio' ? 'mp3' : 'mp4';
    const BASE   = 'https://yt1s.com';

    const aRes = await fetch(`${BASE}/api/ajaxSearch/index`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
            'Referer': `${BASE}/`,
        },
        body: new URLSearchParams({ q: ytUrl, vt: format }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!aRes.ok) throw new Error(`yt1s analyze: HTTP ${aRes.status}`);
    const aJson = await aRes.json();

    const kLink = type === 'audio'
        ? (aJson.links?.mp3?.mp3128 || Object.values(aJson.links?.mp3 || {})[0])
        : (aJson.links?.mp4?.['720p'] || aJson.links?.mp4?.['360p'] || Object.values(aJson.links?.mp4 || {})[0]);

    if (!kLink?.k) throw new Error('yt1s: sin clave de conversión');

    const cRes = await fetch(`${BASE}/api/ajaxConvert/convert`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
            'Referer': `${BASE}/`,
        },
        body: new URLSearchParams({ vid: aJson.vid || videoId, k: kLink.k }),
        signal: AbortSignal.timeout(30_000),
    });
    const cJson = await cRes.json();
    if (cJson.dlink) return await fetchBuffer(cJson.dlink, { Referer: BASE });
    throw new Error('yt1s: sin dlink');
};

/* ── 7. Vreden (@vreden/youtube_scraper) ──────────────────────────────────── */
const providerVreden = async (ytUrl, type) => {
    const { ytmp3, ytmp4 } = await import('@vreden/youtube_scraper');
    const res = type === 'audio' ? await ytmp3(ytUrl) : await ytmp4(ytUrl);
    if (res.status && res.download?.url) return await fetchBuffer(res.download.url);
    throw new Error('vreden: sin link');
};

/* ── 8. LolHuman ──────────────────────────────────────────────────────────── */
const providerLolHuman = async (ytUrl, type) => {
    const keys = ['beta', '85faf717d0545d14074659ad', '0ca09158e244030623e44991'];
    for (const key of keys) {
        try {
            const endpoint = type === 'audio' ? 'ytaudio' : 'ytvideo';
            const res  = await fetch(
                `https://api.lolhuman.xyz/api/${endpoint}?apikey=${key}&url=${ytUrl}`,
                { signal: AbortSignal.timeout(20_000) }
            );
            const json = await res.json();
            if (json.status === 200) {
                const dlUrl = json.result?.link || json.result;
                if (typeof dlUrl === 'string') return await fetchBuffer(dlUrl);
            }
        } catch {}
    }
    throw new Error('lolhuman: falló');
};

/* ── 9. BetaBotz ──────────────────────────────────────────────────────────── */
const providerBetaBotz = async (ytUrl, type) => {
    const keys = ['beta', 'ErlanBot'];
    for (const key of keys) {
        try {
            const endpoint = type === 'audio' ? 'ytmp3' : 'ytmp4';
            const res  = await fetch(
                `https://api.betabotz.eu.org/api/download/${endpoint}?url=${ytUrl}&apikey=${key}`,
                { signal: AbortSignal.timeout(20_000) }
            );
            const json = await res.json();
            if (json.status) {
                const dlUrl = json.result?.mp3 || json.result?.mp4 || json.result?.url;
                if (dlUrl) return await fetchBuffer(dlUrl);
            }
        } catch {}
    }
    throw new Error('betabotz: falló');
};

/* ── 10. Y2Mate ────────────────────────────────────────────────────────────── */
const providerY2Mate = async (ytUrl, type) => {
    const BASE = 'https://www.y2mate.com';
    if (!extractVideoId(ytUrl)) throw new Error('y2mate: ID inválido');

    const aRes = await fetch(`${BASE}/mates/analyzeV2/ajax`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ k_query: ytUrl, k_page: 'home', hl: 'es', q_auto: '0' }),
        signal: AbortSignal.timeout(20_000),
    });
    const analyze = await aRes.json();
    const k = type === 'audio'
        ? (analyze.links?.mp3?.mp3128 || Object.values(analyze.links?.mp3 || {})[0])?.k
        : (analyze.links?.mp4?.['720'] || analyze.links?.mp4?.['360'] || Object.values(analyze.links?.mp4 || {})[0])?.k;
    if (!k) throw new Error('y2mate: sin k');

    const cRes = await fetch(`${BASE}/mates/convertV2/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ vid: analyze.vid, k }),
        signal: AbortSignal.timeout(30_000),
    });
    const conv = await cRes.json();
    if (conv.dlink) return await fetchBuffer(conv.dlink, { Referer: BASE });
    throw new Error('y2mate: falló');
};

/* ── 11. Ndown.io ─────────────────────────────────────────────────────────── */
const providerNdown = async (ytUrl, type) => {
    const videoId = extractVideoId(ytUrl);
    if (!videoId) throw new Error('ndown: ID inválido');

    const res = await fetch(
        `https://ndown.io/api/download?url=${encodeURIComponent(ytUrl)}&type=${type === 'audio' ? 'mp3' : 'mp4'}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) }
    );
    if (!res.ok) throw new Error(`ndown: HTTP ${res.status}`);
    const json = await res.json();
    const dlUrl = json?.data?.downloadUrl || json?.url;
    if (!dlUrl) throw new Error('ndown: sin URL');
    return await fetchBuffer(dlUrl, { Referer: 'https://ndown.io/' });
};

/* ── 12. YtDl API (hemn.me) ───────────────────────────────────────────────── */
const providerYtDlAPI = async (ytUrl, type) => {
    const videoId = extractVideoId(ytUrl);
    if (!videoId) throw new Error('ytdlapi: ID inválido');

    const fmt = type === 'audio' ? 'mp3' : 'mp4';
    const res = await fetch(
        `https://ytdl.hemn.me/api/convert?url=${encodeURIComponent(ytUrl)}&format=${fmt}&quality=720`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) throw new Error(`ytdlapi: HTTP ${res.status}`);
    const json = await res.json();
    const dlUrl = json?.download_url || json?.url;
    if (!dlUrl) throw new Error('ytdlapi: sin URL');
    return await fetchBuffer(dlUrl);
};

/* ═══════════════════════════════════════════════════════════════════════════
   ─── Provider orchestration ───────────────────────────────────────────────
   ═══════════════════════════════════════════════════════════════════════════ */

const runProvider = (name, fn, ytUrl, type) =>
    withTimeout(
        PROVIDER_TIMEOUT,
        fn(ytUrl, type),
        `${name}: timeout (${PROVIDER_TIMEOUT / 1000}s)`
    );

/**
 * Estrategia multi-proveedor:
 *
 *  Fase 1 (paralelo):  yt-dlp  +  Cobalt v7  +  SaveFrom
 *                      → gana el primero que entregue buffer válido
 *
 *  Fase 2 (secuencial): loader.to → SnapSave → yt1s → Vreden
 *                        → LolHuman → BetaBotz → Y2Mate → NDown → YtDlAPI
 *
 *  Total de providers disponibles: 12
 */
const downloadViaProviders = async (ytUrl, type) => {
    const errors = {};

    // ── Fase 1: carrera entre los 3 más rápidos ────────────────────────────
    try {
        const result = await Promise.any([
            runProvider('ytdlp',    providerYtdlp,    ytUrl, type).then(b => ({ buf: b, provider: 'ytdlp'    })),
            runProvider('cobalt',   providerCobalt,   ytUrl, type).then(b => ({ buf: b, provider: 'cobalt'   })),
            runProvider('savefrom', providerSaveFrom, ytUrl, type).then(b => ({ buf: b, provider: 'savefrom' })),
        ]);
        if (result.buf?.length > MIN_BUFFER_SIZE) return { buffer: result.buf, provider: result.provider };
    } catch (agg) {
        for (const e of (agg.errors ?? [])) {
            const key = e.message?.split(':')[0] ?? 'unknown';
            errors[key] = e.message;
        }
    }

    // ── Fase 2: proveedores secundarios secuenciales ───────────────────────
    const sequential = [
        { name: 'loaderto',  fn: providerLoaderTo  },
        { name: 'snapsave',  fn: providerSnapSave  },
        { name: 'yt1s',      fn: providerYt1s      },
        { name: 'vreden',    fn: providerVreden    },
        { name: 'lolhuman',  fn: providerLolHuman  },
        { name: 'betabotz',  fn: providerBetaBotz  },
        { name: 'y2mate',    fn: providerY2Mate    },
        { name: 'ndown',     fn: providerNdown     },
        { name: 'ytdlapi',   fn: providerYtDlAPI   },
    ];

    for (const { name, fn } of sequential) {
        try {
            const buf = await runProvider(name, fn, ytUrl, type);
            if (buf?.length > MIN_BUFFER_SIZE) return { buffer: buf, provider: name };
        } catch (e) {
            errors[name] = e.message;
        }
    }

    throw new Error(Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('\n'));
};

/* ─── Public API ─────────────────────────────────────────────────────────── */

/**
 * Descarga audio o video de YouTube.
 * @param {string} url   - URL o ID de YouTube
 * @param {'audio'|'video'} type
 * @returns {{ buffer: Buffer, seconds: number, meta: object, provider: string }}
 */
export const ytDownload = async (url, type = 'audio') => {
    if (!url || typeof url !== 'string') throw new Error('URL inválida');
    if (type !== 'audio' && type !== 'video') throw new Error('type debe ser "audio" o "video"');
    if (!YT_REGEX.test(url) && !extractVideoId(url)) throw new Error('No es una URL de YouTube válida');

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
