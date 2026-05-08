import fetch    from 'node-fetch';
import axios    from 'axios';
import yts      from 'yt-search';
import crypto   from 'crypto';
import { JSDOM } from 'jsdom';
import { exec }  from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);
const TIMEOUT_MS  = 25_000;
const YTDLP_QUAL  = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best';

export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

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
    if (isNaN(s)) return 'N/A';
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
        const [y, mo, d] = [str.slice(0,4), str.slice(4,6), str.slice(6,8)];
        return `${parseInt(d)} ${months[parseInt(mo) - 1]} ${y}`;
    }
    return raw;
};

export const buildInfoCard = (meta = {}, type = 'audio') => {
    const icon    = type === 'video' ? '🎬 YOUTUBE VIDEO' : '♪ YOUTUBE AUDIO';
    const title   = meta.title    || 'Sin título';
    const channel = meta.channel  || 'N/A';
    const views   = formatViews(meta.views);
    const dur     = formatDuration(meta.duration || meta.timestamp);
    const date    = formatDate(meta.date || meta.upload_date || meta.publishedAt || meta.ago);
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

const fetchWithTimeout = (url, ms = TIMEOUT_MS, opts = {}) => {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, ...opts }).finally(() => clearTimeout(t));
};

const normalizeYts = (r) => ({
    title:     r.title,
    channel:   r.author?.name  || r.channel || 'N/A',
    views:     r.views,
    duration:  r.timestamp,
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
            if (r) return normalizeYts(r);
        }
        const search = await yts(query);
        const r = search.videos?.[0];
        return r ? normalizeYts(r) : null;
    } catch {
        return null;
    }
};

export const ytInfo = (url) => ytSearch(url);

const _mapAudioQuality = (b) => ({ 320: 0, 256: 1, 128: 4, 96: 5 }[b] ?? 4);

const _cnvRequest = (url, data) =>
    axios.post(url, data, {
        headers: {
            'User-Agent':   'Mozilla/5.0 (Linux; Android 10)',
            'Content-Type': 'application/json',
            origin:   'https://cnvmp3.com',
            referer:  'https://cnvmp3.com/v54',
        },
        timeout: 60_000,
    });

const _cnvVideoId = (url) => {
    const m = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|embed|watch|shorts)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
    return m ? m[1] : null;
};

const dlCnvmp3 = async (url, type = 'audio', quality) => {
    const id = _cnvVideoId(url);
    if (!id) return null;
    const isVideo   = type === 'video';
    const fmt       = isVideo ? 0 : 1;
    const qual      = quality ? String(quality).replace('p', '') : (isVideo ? '360' : '128');
    const qualFinal = isVideo ? parseInt(qual) : _mapAudioQuality(parseInt(qual));
    try {
        const cache = await _cnvRequest('https://cnvmp3.com/check_database.php', { youtube_id: id, quality: qualFinal, formatValue: fmt });
        if (cache.data?.success) return cache.data.data.server_path;
        const ytUrl  = `https://www.youtube.com/watch?v=${id}`;
        const info   = await _cnvRequest('https://cnvmp3.com/get_video_data.php', { url: ytUrl, token: '1234' });
        if (info.data.error) return null;
        const dl = await _cnvRequest('https://cnvmp3.com/download_video_ucep.php', { url: ytUrl, quality: qualFinal, title: info.data.title, formatValue: fmt });
        if (dl.data.error) return null;
        const link = dl.data.download_link;
        _cnvRequest('https://cnvmp3.com/insert_to_database.php', { youtube_id: id, server_path: link, quality: qualFinal, title: info.data.title, formatValue: fmt }).catch(() => {});
        return link || null;
    } catch {
        return null;
    }
};

const _ogmp3 = (() => {
    const ENDPOINTS = ['https://api5.apiapi.lat', 'https://api.apiapi.lat', 'https://api3.apiapi.lat'];
    const BASE    = 'https://api3.apiapi.lat';
    const HEADERS = { 'content-type': 'application/json', 'origin': 'https://ogmp3.lat', 'referer': 'https://ogmp3.lat/', 'user-agent': 'Postify/1.0.0' };
    const hash = () => {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    };
    const xor    = (str) => [...str].map(c => String.fromCharCode(c.charCodeAt(0) ^ 1)).join('');
    const encUrl = (url, sep = ',') => [...url].map(c => c.charCodeAt(0)).join(sep).split(sep).reverse().join(sep);
    const videoId = (url) => {
        const pats = [/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/, /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/, /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/];
        for (const p of pats) { const m = url.match(p); if (m) return m[1]; }
        return null;
    };
    const request = async (endpoint, data = {}) => {
        try {
            const ep  = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
            const url = endpoint.startsWith('http') ? endpoint : `${ep}${endpoint}`;
            const { data: res } = await axios({ method: 'post', url, data, headers: HEADERS });
            return { ok: true, data: res };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    };
    const waitReady = async (id, maxAttempts = 120) => {
        for (let i = 0; i < maxAttempts; i++) {
            const r = await request(`/${hash()}/status/${xor(id)}/${hash()}/`, { data: id });
            if (!r.ok) { await new Promise(s => setTimeout(s, 2000)); continue; }
            if (r.data.s === 'C') return r.data;
            if (r.data.s === 'P') { await new Promise(s => setTimeout(s, 2000)); continue; }
            return null;
        }
        return null;
    };
    return async (url, type = 'audio', fmt) => {
        const id = videoId(url);
        if (!id) return null;
        const quality  = fmt || (type === 'audio' ? '320' : '720');
        const fmtValid = type === 'audio' ? ['64','96','128','192','256','320'] : ['240','360','480','720','1080'];
        if (!fmtValid.includes(String(quality))) return null;
        for (let retries = 0; retries < 10; retries++) {
            const r = await request(`/${hash()}/init/${encUrl(url)}/${hash()}/`, {
                data: xor(url),
                format: type === 'audio' ? '0' : '1',
                referer: 'https://ogmp3.cc',
                mp3Quality: type === 'audio' ? quality : null,
                mp4Quality: type === 'video' ? quality : null,
                userTimeZone: new Date().getTimezoneOffset().toString(),
            });
            if (!r.ok) continue;
            const d = r.data;
            if (d.le || d.e || d.i === 'invalid' || d.i === 'blacklisted') return null;
            const ready = d.s === 'C' ? d : await waitReady(d.i);
            if (!ready) continue;
            return `${BASE}/${hash()}/download/${xor(ready.i)}/${hash()}/`;
        }
        return null;
    };
})();

const _y2mate = (() => {
    const SERVERS = ['en68', 'en60', 'en61', 'id4'];
    const post = (url, form) =>
        fetchWithTimeout(url, TIMEOUT_MS, {
            method:  'POST',
            headers: { 'accept': '*/*', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: new URLSearchParams(Object.entries(form)).toString(),
        });
    return async (url, type = 'mp3', bitrate = '128') => {
        const match = url.match(YT_REGEX);
        if (!match) return null;
        const vtId  = match[1];
        const clean = `https://youtu.be/${vtId}`;
        const srv   = SERVERS[Math.floor(Math.random() * SERVERS.length)];
        try {
            const r1  = await post(`https://www.y2mate.com/mates/${srv}/analyze/ajax`, { url: clean, q_auto: 0, ajax: 1 });
            const j1  = await r1.json();
            const dom = new JSDOM(j1.result).window.document;
            const kid = /var k__id = "(.*?)"/.exec(dom.body.innerHTML)?.[1] || '';
            const r2  = await post(`https://www.y2mate.com/mates/${srv}/convert`, { type: 'youtube', _id: kid, v_id: vtId, ajax: '1', token: '', ftype: type, fquality: bitrate });
            const j2  = await r2.json();
            return /<a.+?href="(.+?)"/.exec(j2.result)?.[1] || null;
        } catch {
            return null;
        }
    };
})();

export const dlYtdlp = async (url, outFile) => {
    try {
        await execPromise(`yt-dlp -f "${YTDLP_QUAL}" --merge-output-format mp4 -o "${outFile}" "${url}"`);
        return true;
    } catch {
        return false;
    }
};

export const ytdlpDate = async (url) => {
    try {
        const { stdout } = await execPromise(`yt-dlp --print "%(upload_date)s" "${url}"`);
        return stdout.trim() || null;
    } catch {
        return null;
    }
};

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality, skipCnvmp3 = false, skipOgmp3 = false, skipY2mate = false } = opts;
    const meta = await ytInfo(url);
    if (!skipCnvmp3) {
        const cnvUrl = await dlCnvmp3(url, type, quality);
        if (cnvUrl) return { downloadUrl: cnvUrl, meta: meta || {}, provider: 'cnvmp3' };
    }
    if (!skipOgmp3) {
        const fmt   = type === 'audio' ? '320' : (quality?.replace('p','') || '720');
        const ogUrl = await _ogmp3(url, type, fmt);
        if (ogUrl) return { downloadUrl: ogUrl, meta: meta || {}, provider: 'ogmp3' };
    }
    if (!skipY2mate) {
        const ytType = type === 'audio' ? 'mp3' : 'mp4';
        const ytBit  = type === 'audio' ? '128' : (quality?.replace('p','') || '360');
        const y2mUrl = await _y2mate(url, ytType, ytBit);
        if (y2mUrl) return { downloadUrl: y2mUrl, meta: meta || {}, provider: 'y2mate' };
    }
    throw new Error('No se pudo obtener el enlace de descarga con ningún proveedor disponible.');
};

export const providers = { cnvmp3: dlCnvmp3, ogmp3: _ogmp3, y2mate: _y2mate, ytdlp: dlYtdlp };
                                                                                  
