import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 60_000;


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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Provider: YTDown (video MP4) ──────────────────────────────────────────────
const providerYTDown = async (ytUrl, type) => {
    if (type === 'audio') throw new Error('ytdown: solo soporta video');
    const BASE   = 'https://app.ytdown.to';
    const PAGE   = `${BASE}/es29/`;

    const pageRes = await fetch(PAGE, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!pageRes.ok) throw new Error(`ytdown page HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    // Extraer CSRF token del formulario
    const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1] || '';

    // Buscar endpoint de conversión en el action del form o en scripts
    const actionRaw = html.match(/action="([^"]*\/(?:convert|download|process)[^"]*)"/i)?.[1]
        || html.match(/url\s*:\s*["']([^"']*\/(?:convert|download|process)[^"']*)["']/i)?.[1]
        || '/convert';
    const action = actionRaw.startsWith('http') ? actionRaw : `${BASE}${actionRaw}`;

    const body = new URLSearchParams({ url: ytUrl });
    if (token) body.append('_token', token);

    const convRes = await fetch(action, {
        method: 'POST',
        headers: {
            'Content-Type':      'application/x-www-form-urlencoded',
            'User-Agent':        UA,
            'Referer':           PAGE,
            'X-Requested-With':  'XMLHttpRequest',
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

// ── Provider: MP3Now (audio MP3) ──────────────────────────────────────────────
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
        || html.match(/url\s*:\s*["']([^"']*\/(?:convert|download|process)[^"']*)["']/i)?.[1]
        || '/convert';
    const action = actionRaw.startsWith('http') ? actionRaw : `${BASE}${actionRaw}`;

    const body = new URLSearchParams({ url: ytUrl, format: 'mp3', quality: '128' });
    if (token) body.append('_token', token);

    const convRes = await fetch(action, {
        method: 'POST',
        headers: {
            'Content-Type':      'application/x-www-form-urlencoded',
            'User-Agent':        UA,
            'Referer':           PAGE,
            'X-Requested-With':  'XMLHttpRequest',
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

// ── Provider: SSYouTube / SaveFrom (video + audio) ───────────────────────────
const providerSSYouTube = async (ytUrl, type) => {
    const SF_API  = 'https://worker.sf-tools.com/savefrom.php';
    const ORIGIN  = 'https://ssyoutube.com';
    const REFERER = 'https://ssyoutube.com/';

    const body = new URLSearchParams({
        sf_url:            ytUrl,
        sf_submit:         '',
        new:               '2',
        lang:              'es',
        app:               '',
        tool:              'pc',
        channel:           'main',
        id_ru_fast_show:   '0',
    });

    const res = await fetch(SF_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   UA,
            'Origin':       ORIGIN,
            'Referer':      REFERER,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`ssyoutube HTTP ${res.status}`);

    const raw = await res.text();

    // La respuesta puede ser JSON puro o JSONP con callback
    let json;
    try {
        json = JSON.parse(raw);
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`ssyoutube: respuesta no parseable — ${raw.slice(0, 120)}`);
        json = JSON.parse(match[0]);
    }

    const links = json?.url;
    if (!Array.isArray(links) || links.length === 0)
        throw new Error(`ssyoutube: sin enlaces — ${JSON.stringify(json).slice(0, 150)}`);

    let chosen;

    if (type === 'audio') {
        chosen = links.find(l => l.ext === 'mp3')
            || links.find(l => /m4a|aac|ogg|opus/.test(l.ext || ''))
            || links.find(l => l.audio === true && l.ext !== 'mp4');
    } else {
        const mp4s = links.filter(l => l.ext === 'mp4' && l.audio !== false);
        chosen = mp4s.find(l => /720/.test(l.quality || ''))
            || mp4s.find(l => /480/.test(l.quality || ''))
            || mp4s[0]
            || links[0];
    }

    if (!chosen) throw new Error('ssyoutube: no se encontró formato adecuado');

    const dlUrl = chosen.url;
    if (!dlUrl || !dlUrl.startsWith('http'))
        throw new Error(`ssyoutube: URL inválida — ${JSON.stringify(chosen).slice(0, 100)}`);

    return await fetchBuffer(dlUrl, { 'Referer': REFERER });
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


// ── Provider: yt1s (video + audio) ───────────────────────────────────────────
// Flujo: POST ajaxSearch → obtener vid+k → POST ajaxConvert → dlink
const providerYt1s = async (ytUrl, type) => {
    const BASE    = 'https://www.yt1s.com';
    const REFERER = `${BASE}/`;
    const H = {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':       UA,
        'Referer':          REFERER,
    };

    // Paso 1: buscar video y obtener formatos
    const searchRes = await fetch(`${BASE}/api/ajaxSearch/index`, {
        method:  'POST',
        headers: H,
        body:    `q=${encodeURIComponent(ytUrl)}&vt=home`,
        signal:  AbortSignal.timeout(20_000),
    });
    if (!searchRes.ok) throw new Error(`yt1s search HTTP ${searchRes.status}`);
    const search = await searchRes.json();
    if (search.status !== 'Ok') throw new Error(`yt1s search: ${search.mess || JSON.stringify(search).slice(0, 80)}`);

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
    if (!k) throw new Error('yt1s: no se encontró k para el formato solicitado');

    // Paso 2: convertir y obtener dlink
    const convRes = await fetch(`${BASE}/api/ajaxConvert/convert`, {
        method:  'POST',
        headers: H,
        body:    `vid=${vid}&k=${encodeURIComponent(k)}`,
        signal:  AbortSignal.timeout(40_000),
    });
    if (!convRes.ok) throw new Error(`yt1s convert HTTP ${convRes.status}`);
    const conv = await convRes.json();
    if (!conv.dlink) throw new Error(`yt1s: sin dlink — ${JSON.stringify(conv).slice(0, 100)}`);

    return await fetchBuffer(conv.dlink, { Referer: REFERER });
};

// ── Provider: loader.to (video + audio) ──────────────────────────────────────
// API pública con polling de progreso
const providerLoaderTo = async (ytUrl, type) => {
    const BASE    = 'https://loader.to';
    const REFERER = `${BASE}/`;
    const fmt     = type === 'audio' ? 'mp3' : '720';

    // Iniciar descarga
    const startRes = await fetch(
        `${BASE}/ajax/download.php?format=${fmt}&url=${encodeURIComponent(ytUrl)}&api=dfcb6d76f2f2a12c83a82a4de3bc75e8`,
        {
            headers: { 'User-Agent': UA, 'Referer': REFERER },
            signal:  AbortSignal.timeout(15_000),
        }
    );
    if (!startRes.ok) throw new Error(`loader.to start HTTP ${startRes.status}`);
    const start = await startRes.json();
    if (!start.id) throw new Error(`loader.to: sin id — ${JSON.stringify(start).slice(0, 100)}`);

    // Polling hasta que progreso sea 100
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3_000));
        const progRes = await fetch(
            `${BASE}/ajax/progress.php?id=${start.id}`,
            { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(10_000) }
        );
        if (!progRes.ok) continue;
        const prog = await progRes.json();
        if (prog.download_url) {
            return await fetchBuffer(prog.download_url, { Referer: REFERER });
        }
        if (prog.success === false) throw new Error(`loader.to: falló la conversión`);
    }
    throw new Error('loader.to: timeout esperando conversión');
};

// ── Provider: 9xbuddy (video + audio) ────────────────────────────────────────
const provider9xBuddy = async (ytUrl, type) => {
    const BASE    = 'https://9xbuddy.in';
    const REFERER = `${BASE}/`;

    const res = await fetch(
        `${BASE}/process?url=${encodeURIComponent(ytUrl)}`,
        {
            headers: { 'User-Agent': UA, 'Referer': REFERER, 'Accept': 'application/json' },
            signal:  AbortSignal.timeout(25_000),
        }
    );
    if (!res.ok) throw new Error(`9xbuddy HTTP ${res.status}`);
    const json = await res.json();

    const items = json?.data || json?.links || json?.result || [];
    if (!Array.isArray(items) || items.length === 0)
        throw new Error(`9xbuddy: sin resultados — ${JSON.stringify(json).slice(0, 120)}`);

    let chosen;
    if (type === 'audio') {
        chosen = items.find(i => /mp3/i.test(i.ext || i.format || i.type || ''))
            || items.find(i => /audio/i.test(i.type || ''));
    } else {
        const vids = items.filter(i => /mp4/i.test(i.ext || i.format || i.type || ''));
        chosen = vids.find(i => /720/.test(i.quality || i.size || ''))
            || vids.find(i => /480/.test(i.quality || i.size || ''))
            || vids[0] || items[0];
    }
    if (!chosen) throw new Error('9xbuddy: sin formato adecuado');

    const dlUrl = chosen.url || chosen.link || chosen.download;
    if (!dlUrl || !dlUrl.startsWith('http'))
        throw new Error(`9xbuddy: URL inválida — ${JSON.stringify(chosen).slice(0, 80)}`);

    return await fetchBuffer(dlUrl, { Referer: REFERER });
};

// ── Provider: tomp3.cc (audio) ────────────────────────────────────────────────
// Mismo motor que yt1s con endpoints propios
const providerToMp3 = async (ytUrl, type) => {
    if (type === 'video') throw new Error('tomp3: solo soporta audio');
    const BASE    = 'https://tomp3.cc';
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
    if (!searchRes.ok) throw new Error(`tomp3 search HTTP ${searchRes.status}`);
    const search = await searchRes.json();
    if (search.status !== 'Ok') throw new Error(`tomp3 search: ${search.mess || ''}`);

    const mp3 = search.links?.mp3?.mp3128 || Object.values(search.links?.mp3 || {})[0];
    if (!mp3?.k) throw new Error('tomp3: sin k de audio');

    const convRes = await fetch(`${BASE}/api/ajaxConvert/convert`, {
        method: 'POST', headers: H,
        body:   `vid=${search.vid}&k=${encodeURIComponent(mp3.k)}`,
        signal: AbortSignal.timeout(40_000),
    });
    if (!convRes.ok) throw new Error(`tomp3 convert HTTP ${convRes.status}`);
    const conv = await convRes.json();
    if (!conv.dlink) throw new Error(`tomp3: sin dlink`);

    return await fetchBuffer(conv.dlink, { Referer: REFERER });
};

// ── Cadena de providers ───────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality = '720p') => {
    const errors  = [];
    const entries = [
        { name: 'ytdown',           fn: () => providerYTDown(ytUrl, type) },
        { name: 'mp3now',           fn: () => providerMP3Now(ytUrl, type) },
        { name: 'ssyoutube',        fn: () => providerSSYouTube(ytUrl, type) },
        { name: 'yt1s',             fn: () => providerYt1s(ytUrl, type) },
        { name: 'loader.to',        fn: () => providerLoaderTo(ytUrl, type) },
        { name: '9xbuddy',          fn: () => provider9xBuddy(ytUrl, type) },
        { name: 'tomp3',            fn: () => providerToMp3(ytUrl, type) },
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
