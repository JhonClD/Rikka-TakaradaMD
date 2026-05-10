import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 60_000;

const APICAUSAS_KEY  = 'nakano-212-jhon';
const APICAUSAS_BASE = 'https://rest.apicausas.xyz';

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

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

// ── Providers ─────────────────────────────────────────────────────────────────

const extractApicAusasUrl = (json) => {
    const d = json?.data || json;
    const isUrl = (v) => typeof v === 'string' && v.startsWith('http');

    for (const key of ['url','download','link','file','downloadUrl','video','audio','stream','mp4','mp3']) {
        if (isUrl(d[key])) return d[key];
    }

    const scanObj = (obj, depth = 0) => {
        if (depth > 3) return null;
        for (const val of Object.values(obj || {})) {
            if (isUrl(val)) return val;
            if (val && typeof val === 'object') {
                const found = scanObj(val, depth + 1);
                if (found) return found;
            }
        }
        return null;
    };

    return scanObj(d);
};

const providerApicAusasV2 = async (ytUrl, type, quality) => {
    const q = String(quality).replace('p', '') || '720';
    const endpoint = `${APICAUSAS_BASE}/api/v1/descargas/youtubev2?apikey=${APICAUSAS_KEY}&url=${encodeURIComponent(ytUrl)}&type=${type}&quality=${q}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const dlUrl = extractApicAusasUrl(json);
    if (!dlUrl) throw new Error(`apicausas-v2: sin URL — ${JSON.stringify(json).slice(0, 200)}`);
    return await fetchBuffer(dlUrl);
};

const providerApicAusasV1 = async (ytUrl, type) => {
    const endpoint = `${APICAUSAS_BASE}/api/v1/descargas/youtube?apikey=${APICAUSAS_KEY}&url=${encodeURIComponent(ytUrl)}&type=${type}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const dlUrl = extractApicAusasUrl(json);
    if (!dlUrl) throw new Error(`apicausas-v1: sin URL — ${JSON.stringify(json).slice(0, 200)}`);
    return await fetchBuffer(dlUrl);
};

const providerCobalt = async (ytUrl, type) => {
    const res = await fetch('https://api.cobalt.tools/', {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Accept':        'application/json',
            'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin':        'https://cobalt.tools',
            'Referer':       'https://cobalt.tools/',
        },
        body: JSON.stringify({
            url:           ytUrl,
            downloadMode:  type === 'audio' ? 'audio' : 'auto',
            audioFormat:   'mp3',
            audioBitrate:  '128',
            videoQuality:  '720',
            filenameStyle: 'pretty',
        }),
        signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`cobalt HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const json = await res.json();
    if (!['tunnel', 'redirect', 'stream'].includes(json.status))
        throw new Error(`cobalt status "${json.status}": ${json.error?.code || JSON.stringify(json).slice(0, 80)}`);
    return await fetchBuffer(json.url, { 'Referer': 'https://cobalt.tools/' });
};

const providerCobaltAlt = async (ytUrl, type) => {
    const instances = [
        'https://cobalt.api.timelessnesses.me',
        'https://cobalt.tools.nadeko.net',
        'https://api.cobalt.tools',
    ];
    for (const base of instances) {
        try {
            const res = await fetch(`${base}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept':       'application/json',
                    'Origin':       base.replace('api.', ''),
                },
                body: JSON.stringify({
                    url:          ytUrl,
                    downloadMode: type === 'audio' ? 'audio' : 'auto',
                    audioFormat:  'mp3',
                    audioBitrate: '128',
                }),
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (!['tunnel', 'redirect', 'stream'].includes(json.status)) continue;
            return await fetchBuffer(json.url);
        } catch {}
    }
    throw new Error('cobalt-alt: todas las instancias fallaron');
};

const providerY2mate = async (ytUrl, type) => {
    const vid = ytUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
    if (!vid) throw new Error('y2mate: no se pudo extraer video ID');

    const HEADERS = {
        'Content-Type':      'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With':  'XMLHttpRequest',
        'Referer':           'https://www.y2mate.com/',
        'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const analyzeRes = await fetch('https://www.y2mate.com/mates/analyzeV2/ajax', {
        method: 'POST',
        headers: HEADERS,
        body: `k_query=https://www.youtube.com/watch?v=${vid}&k_page=home&hl=en&q_auto=0`,
        signal: AbortSignal.timeout(20_000),
    });
    if (!analyzeRes.ok) throw new Error(`y2mate analyze HTTP ${analyzeRes.status}`);
    const analyze = await analyzeRes.json();
    if (!analyze.vid) throw new Error('y2mate: analyze sin vid');

    const fmtMap = type === 'audio' ? (analyze.links?.mp3 || {}) : (analyze.links?.mp4 || {});
    const fmtKey = type === 'audio' ? '128' : '720';
    const fmt    = fmtMap[fmtKey] || Object.values(fmtMap)[0];
    if (!fmt?.k) throw new Error('y2mate: sin formato disponible');

    const convertRes = await fetch('https://www.y2mate.com/mates/convertV2/index', {
        method: 'POST',
        headers: HEADERS,
        body: `vid=${analyze.vid}&k=${fmt.k}`,
        signal: AbortSignal.timeout(40_000),
    });
    if (!convertRes.ok) throw new Error(`y2mate convert HTTP ${convertRes.status}`);
    const convert = await convertRes.json();
    if (!convert.dlink) throw new Error(`y2mate: sin dlink — ${JSON.stringify(convert).slice(0, 80)}`);

    return await fetchBuffer(convert.dlink, { 'Referer': 'https://www.y2mate.com/' });
};

const providerCnvMp3 = async (ytUrl, type) => {
    const BASE = 'https://cnvmp3.com';
    const fmt  = type === 'audio' ? 'mp3' : 'mp4';

    const pushRes = await fetch(`${BASE}/api/convert`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Referer':      `${BASE}/`,
            'User-Agent':   'Mozilla/5.0',
        },
        body: JSON.stringify({ url: ytUrl, format: fmt, quality: type === 'audio' ? '128' : '720' }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!pushRes.ok) throw new Error(`cnvmp3 HTTP ${pushRes.status}`);
    const push = await pushRes.json();

    const fileUrl = push.url || push.download || push.link || push.file;
    if (!fileUrl) throw new Error(`cnvmp3: respuesta inesperada: ${JSON.stringify(push).slice(0, 100)}`);

    return await fetchBuffer(fileUrl.startsWith('http') ? fileUrl : `${BASE}${fileUrl}`, {
        'Referer': `${BASE}/`,
    });
};

// ── Cadena de providers ───────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality = '720p') => {
    const errors  = [];
    const entries = [
        { name: 'apicausas-v2',     fn: () => providerApicAusasV2(ytUrl, type, quality) },
        { name: 'apicausas-v1',     fn: () => providerApicAusasV1(ytUrl, type) },
        { name: 'cobalt.tools',     fn: () => providerCobalt(ytUrl, type) },
        { name: 'cobalt-instances', fn: () => providerCobaltAlt(ytUrl, type) },
        { name: 'y2mate',           fn: () => providerY2mate(ytUrl, type) },
        { name: 'cnvmp3',           fn: () => providerCnvMp3(ytUrl, type) },
    ];

    for (const { name, fn } of entries) {
        try {
            console.log(`[yt-providers] Intentando ${name}…`);
            const buf = await fn();
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

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality = '360p' } = opts;
    const stamp    = Date.now();
    const tmpBase  = `./tmp_ytdl_${stamp}`;
    const tmpFiles = [];
    const cleanup  = () =>
        tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

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
            const finalFile = fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : rawFile;
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
    
