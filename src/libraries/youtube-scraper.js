import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';
import os            from 'os';
import path          from 'path';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 60_000;
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Provider 1: yt-dlp (el más fiable) ───────────────────────────────────────
// Requiere yt-dlp instalado: pip install yt-dlp  /  pkg install yt-dlp (Termux)
const providerYtDlp = async (ytUrl, type) => {
    const stamp   = Date.now();
    const outFile = path.join(TMP_DIR, `ytdlp_${stamp}.%(ext)s`);

    let cmd;
    if (type === 'audio') {
        cmd = `yt-dlp -x --audio-format mp3 --audio-quality 128K ` +
              `--no-playlist -o "${outFile}" "${ytUrl}"`;
    } else {
        cmd = `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/` +
              `best[height<=720][ext=mp4]/best[height<=720]" ` +
              `--merge-output-format mp4 --no-playlist -o "${outFile}" "${ytUrl}"`;
    }

    await execPromise(cmd, { timeout: 120_000 });

    const ext      = type === 'audio' ? 'mp3' : 'mp4';
    const realFile = outFile.replace('%(ext)s', ext);

    if (!fs.existsSync(realFile) || fs.statSync(realFile).size === 0)
        throw new Error('yt-dlp: archivo de salida vacío o no encontrado');

    const buf = fs.readFileSync(realFile);
    fs.unlinkSync(realFile);
    return buf;
};

// ── Provider 2: Cobalt (instancias sin JWT) ───────────────────────────────────
// Estas instancias comunitarias aún no requieren autenticación
const providerCobaltAlt = async (ytUrl, type) => {
    const instances = [
        'https://cobalt.api.timelessnesses.me',
        'https://cobalt.tools.nadeko.net',
        'https://capi.oak.icu',
        'https://cobalt.uku.lol',
        'https://cobalt.fyoal.com',
    ];

    for (const base of instances) {
        try {
            const res = await fetch(`${base}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept':       'application/json',
                    'User-Agent':   UA,
                },
                body: JSON.stringify({
                    url:          ytUrl,
                    downloadMode: type === 'audio' ? 'audio' : 'auto',
                    audioFormat:  'mp3',
                    audioBitrate: '128',
                    videoQuality: '720',
                }),
                signal: AbortSignal.timeout(25_000),
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (!['tunnel', 'redirect', 'stream'].includes(json.status)) continue;
            const buf = await fetchBuffer(json.url);
            if (buf && buf.length > 10_000) return buf;
        } catch { /* siguiente instancia */ }
    }
    throw new Error('cobalt-alt: todas las instancias fallaron');
};

// ── Provider 3: YTDown (video MP4) ───────────────────────────────────────────
const providerYTDown = async (ytUrl, type) => {
    if (type === 'audio') throw new Error('ytdown: solo soporta video');
    const BASE = 'https://app.ytdown.to';
    const PAGE = `${BASE}/es29/`;

    const pageRes = await fetch(PAGE, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!pageRes.ok) throw new Error(`ytdown page HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1] || '';
    const actionRaw = html.match(/action="([^"]*\/(?:convert|download|process)[^"]*)"/i)?.[1]
        || html.match(/url\s*:\s*["']([^"']*\/(?:convert|download|process)[^"']*)['"]/i)?.[1]
        || '/convert';
    const action = actionRaw.startsWith('http') ? actionRaw : `${BASE}${actionRaw}`;

    const body = new URLSearchParams({ url: ytUrl });
    if (token) body.append('_token', token);

    const convRes = await fetch(action, {
        method: 'POST',
        headers: {
            'Content-Type':     'application/x-www-form-urlencoded',
            'User-Agent':       UA,
            'Referer':          PAGE,
            'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        signal: AbortSignal.timeout(40_000),
    });
    if (!convRes.ok) throw new Error(`ytdown convert HTTP ${convRes.status}`);

    const ct = convRes.headers.get('content-type') || '';
    let dlUrl;

    if (ct.includes('json')) {
        const j = await convRes.json();
        dlUrl = j.url || j.download || j.link || j.file || j.mp4;
    } else {
        const resHtml = await convRes.text();
        dlUrl = resHtml.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/)?.[1]
            || resHtml.match(/href="(https?:\/\/[^"]+(?:download|dl)[^"]*)"/i)?.[1];
    }

    if (!dlUrl) throw new Error('ytdown: no se encontró URL de descarga');
    return await fetchBuffer(dlUrl, { 'Referer': PAGE });
};

// ── Provider 4: loader.to (video + audio) ────────────────────────────────────
const providerLoaderTo = async (ytUrl, type) => {
    const BASE    = 'https://loader.to';
    const REFERER = `${BASE}/`;
    const fmt     = type === 'audio' ? 'mp3' : '720';

    const startRes = await fetch(
        `${BASE}/ajax/download.php?format=${fmt}&url=${encodeURIComponent(ytUrl)}&api=dfcb6d76f2f2a12c83a82a4de3bc75e8`,
        { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(15_000) }
    );
    if (!startRes.ok) throw new Error(`loader.to start HTTP ${startRes.status}`);
    const start = await startRes.json();
    if (!start.id) throw new Error(`loader.to: sin id — ${JSON.stringify(start).slice(0, 100)}`);

    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3_000));
        const progRes = await fetch(
            `${BASE}/ajax/progress.php?id=${start.id}`,
            { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(10_000) }
        );
        if (!progRes.ok) continue;
        const prog = await progRes.json();
        if (prog.download_url) return await fetchBuffer(prog.download_url, { Referer: REFERER });
        if (prog.success === false) throw new Error('loader.to: falló la conversión');
    }
    throw new Error('loader.to: timeout esperando conversión');
};

// ── Provider 5: yt5s.com (video + audio) ─────────────────────────────────────
const providerYt5s = async (ytUrl, type) => {
    const BASE    = 'https://yt5s.io';
    const REFERER = `${BASE}/`;
    const H = {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':       UA,
        'Referer':          REFERER,
    };

    const searchRes = await fetch(`${BASE}/api/ajaxSearch/index`, {
        method: 'POST', headers: H,
        body:   `q=${encodeURIComponent(ytUrl)}&vt=home`,
        signal: AbortSignal.timeout(20_000),
    });
    if (!searchRes.ok) throw new Error(`yt5s search HTTP ${searchRes.status}`);
    const search = await searchRes.json();
    if (search.status !== 'Ok') throw new Error(`yt5s search: ${search.mess || JSON.stringify(search).slice(0, 80)}`);

    const vid = search.vid;
    let k;

    if (type === 'audio') {
        const mp3 = search.links?.mp3?.mp3128 || Object.values(search.links?.mp3 || {})[0];
        k = mp3?.k;
    } else {
        const mp4 = search.links?.mp4;
        k = mp4?.['720']?.k || mp4?.['480']?.k || mp4?.['360']?.k
            || Object.values(mp4 || {})[0]?.k;
    }
    if (!k) throw new Error('yt5s: no se encontró k para el formato solicitado');

    const convRes = await fetch(`${BASE}/api/ajaxConvert/convert`, {
        method: 'POST', headers: H,
        body:   `vid=${vid}&k=${encodeURIComponent(k)}`,
        signal: AbortSignal.timeout(40_000),
    });
    if (!convRes.ok) throw new Error(`yt5s convert HTTP ${convRes.status}`);
    const conv = await convRes.json();
    if (!conv.dlink) throw new Error(`yt5s: sin dlink — ${JSON.stringify(conv).slice(0, 100)}`);

    return await fetchBuffer(conv.dlink, { Referer: REFERER });
};

// ── Provider 6: y2down.cc (video + audio) ────────────────────────────────────
const providerY2down = async (ytUrl, type) => {
    const BASE    = 'https://y2down.cc';
    const REFERER = `${BASE}/`;

    const res = await fetch(`${BASE}/api/single/v3`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent':   UA,
            'Referer':      REFERER,
            'Origin':       BASE,
        },
        body: JSON.stringify({ url: ytUrl }),
        signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`y2down HTTP ${res.status}`);

    const json = await res.json();
    const links = json?.links || json?.data || [];

    if (!Array.isArray(links) || links.length === 0)
        throw new Error(`y2down: sin resultados — ${JSON.stringify(json).slice(0, 120)}`);

    let chosen;
    if (type === 'audio') {
        chosen = links.find(l => /mp3/i.test(l.type || l.ext || ''))
            || links.find(l => /audio/i.test(l.type || ''));
    } else {
        const vids = links.filter(l => /mp4/i.test(l.type || l.ext || ''));
        chosen = vids.find(l => /720/.test(l.quality || ''))
            || vids.find(l => /480/.test(l.quality || ''))
            || vids[0] || links[0];
    }
    if (!chosen) throw new Error('y2down: sin formato adecuado');

    const dlUrl = chosen.url || chosen.link || chosen.download;
    if (!dlUrl || !dlUrl.startsWith('http'))
        throw new Error(`y2down: URL inválida — ${JSON.stringify(chosen).slice(0, 80)}`);

    return await fetchBuffer(dlUrl, { Referer: REFERER });
};

// ── Provider 7: MP3Now (audio) ────────────────────────────────────────────────
const providerMP3Now = async (ytUrl, type) => {
    if (type === 'video') throw new Error('mp3now: solo soporta audio');
    const BASE = 'https://mp3now.com';
    const PAGE = `${BASE}/en2/`;

    const pageRes = await fetch(PAGE, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!pageRes.ok) throw new Error(`mp3now page HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1] || '';
    const actionRaw = html.match(/action="([^"]*\/(?:convert|download|process|mp3)[^"]*)"/i)?.[1]
        || '/convert';
    const action = actionRaw.startsWith('http') ? actionRaw : `${BASE}${actionRaw}`;

    const body = new URLSearchParams({ url: ytUrl, format: 'mp3', quality: '128' });
    if (token) body.append('_token', token);

    const convRes = await fetch(action, {
        method: 'POST',
        headers: {
            'Content-Type':     'application/x-www-form-urlencoded',
            'User-Agent':       UA,
            'Referer':          PAGE,
            'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        signal: AbortSignal.timeout(40_000),
    });
    if (!convRes.ok) throw new Error(`mp3now convert HTTP ${convRes.status}`);

    const ct = convRes.headers.get('content-type') || '';
    let dlUrl;

    if (ct.includes('json')) {
        const j = await convRes.json();
        dlUrl = j.url || j.download || j.link || j.file || j.mp3;
    } else {
        const resHtml = await convRes.text();
        dlUrl = resHtml.match(/href="(https?:\/\/[^"]+\.mp3[^"]*)"/)?.[1]
            || resHtml.match(/id="download-result"[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/)?.[1];
    }

    if (!dlUrl) throw new Error('mp3now: no se encontró URL de descarga');
    return await fetchBuffer(dlUrl, { 'Referer': PAGE });
};

// ── Cadena de providers ───────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality = '720p') => {
    const errors  = [];
    const entries = [
        { name: 'yt-dlp',          fn: () => providerYtDlp(ytUrl, type) },
        { name: 'cobalt-instances', fn: () => providerCobaltAlt(ytUrl, type) },
        { name: 'ytdown',          fn: () => providerYTDown(ytUrl, type) },
        { name: 'yt5s',            fn: () => providerYt5s(ytUrl, type) },
        { name: 'y2down',          fn: () => providerY2down(ytUrl, type) },
        { name: 'loader.to',       fn: () => providerLoaderTo(ytUrl, type) },
        { name: 'mp3now',          fn: () => providerMP3Now(ytUrl, type) },
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
    const tmpBase  = path.join(TMP_DIR, `ytdl_${stamp}`);
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
