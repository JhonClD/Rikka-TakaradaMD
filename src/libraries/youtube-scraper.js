/**
 * youtube-scraper.js — Rikka-TakaradaMD (Mejorado 2026)
 * ─────────────────────────────────────
 * Providers actualizados para 2026. Orden de prioridad:
 *
 *  1. yt-dlp local         (más confiable, sin límites)
 *  2. @distube/ytdl-core   (librería Node, sin binario externo)
 *  3. cobalt-2026          (API pública, instancias actualizadas)
 *  4. y2mate               (scraper web actualizado)
 *  5. snapsave             (scraper web)
 *  6. tomp3.cc             (scraper web)
 *  7. loader.to            (conversión cloud)
 *
 * SOLUCIÓN AL ERROR "yt-dlp: not found":
 *   En Termux:  pkg install yt-dlp
 *   En Linux:   pip install yt-dlp  ó  sudo apt install yt-dlp
 *   Opción npm: npm install @distube/ytdl-core  (no requiere binario)
 */

import fs            from 'fs';
import yts           from 'yt-search';
import { exec }      from 'child_process';
import { promisify } from 'util';
import os            from 'os';
import path          from 'path';

const execPromise    = promisify(exec);
const FFMPEG_TIMEOUT = 90_000;
const TMP_DIR        = os.tmpdir();

// ── Detectar ffmpeg (sistema o ffmpeg-static) ─────────────────────────────────
let FFMPEG_BIN  = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';

(async () => {
    try {
        await execPromise('ffmpeg -version', { timeout: 4000 });
    } catch {
        try {
            const { default: ffmpegPath } = await import('ffmpeg-static');
            if (ffmpegPath && fs.existsSync(ffmpegPath)) {
                FFMPEG_BIN = ffmpegPath;
                console.log(`[yt-scraper] ✅ ffmpeg-static: ${ffmpegPath}`);
            }
        } catch {
            console.warn('[yt-scraper] ⚠️  ffmpeg no encontrado. Instala: pkg install ffmpeg');
        }
    }
})();

// ── Regex ─────────────────────────────────────────────────────────────────────
export const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/;

const extractVideoId = (url) => url.match(YT_REGEX)?.[1] ?? null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ═════════════════════════════════════════════════════════════════════════════
//  HELPERS EXPORTADOS
// ═════════════════════════════════════════════════════════════════════════════

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
    } catch { return null; }
};

export const ytInfo = (url) => ytSearch(url);

// ── fetchBuffer con reintentos ─────────────────────────────────────────────────
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

// ── ffmpeg wrappers ────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════════
//  PROVIDERS
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. yt-dlp local (busca en múltiples rutas) ────────────────────────────────
const findYtDlp = async () => {
    const paths = [
        'yt-dlp',
        '/usr/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        `${process.env.HOME || '/root'}/.local/bin/yt-dlp`,
        '/data/data/com.termux/files/usr/bin/yt-dlp',
    ];
    for (const p of paths) {
        try { await execPromise(`"${p}" --version`, { timeout: 5000 }); return p; }
        catch { /* siguiente */ }
    }
    return null;
};

const providerYtDlp = async (ytUrl, type) => {
    const bin = await findYtDlp();
    if (!bin) throw new Error('yt-dlp no instalado → pkg install yt-dlp');

    const stamp   = Date.now();
    const outTpl  = path.join(TMP_DIR, `ytdlp_${stamp}.%(ext)s`);
    const cmd = type === 'audio'
        ? `"${bin}" -x --audio-format mp3 --audio-quality 128K --no-playlist -o "${outTpl}" "${ytUrl}"`
        : `"${bin}" -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 --no-playlist -o "${outTpl}" "${ytUrl}"`;

    await execPromise(cmd, { timeout: 180_000 });

    const ext      = type === 'audio' ? 'mp3' : 'mp4';
    const realFile = outTpl.replace('%(ext)s', ext);
    if (!fs.existsSync(realFile) || fs.statSync(realFile).size === 0)
        throw new Error('yt-dlp: archivo vacío o no encontrado');

    const buf = fs.readFileSync(realFile);
    try { fs.unlinkSync(realFile); } catch {}
    return buf;
};

// ── 2. @distube/ytdl-core (Node puro, sin binario) ───────────────────────────
const providerYtdlCore = async (ytUrl, type) => {
    let ytdl;
    try { ytdl = (await import('@distube/ytdl-core')).default; }
    catch { throw new Error('@distube/ytdl-core no instalado → npm install @distube/ytdl-core'); }

    if (!ytdl.validateURL(ytUrl)) throw new Error('URL inválida');
    const info = await ytdl.getInfo(ytUrl);

    return new Promise((resolve, reject) => {
        let format;
        if (type === 'audio') {
            format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        } else {
            format = ytdl.chooseFormat(info.formats, {
                quality: 'highest',
                filter: (f) => f.container === 'mp4' && f.hasVideo && f.hasAudio,
            }) || ytdl.chooseFormat(info.formats, { quality: '18' });
        }
        const chunks = [];
        const stream = ytdl.downloadFromInfo(info, { format });
        stream.on('data', c => chunks.push(c));
        stream.on('end',  () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
        setTimeout(() => reject(new Error('ytdl-core: timeout 3min')), 180_000);
    });
};

// ── 3. Cobalt 2026 (Instancias actualizadas de cobalt.directory) ──────────────
const providerCobalt2026 = async (ytUrl, type) => {
    // Instancias extraídas de cobalt.directory (Mayo 2026)
    const instances = [
        'https://grapefruit.clxxped.lol',
        'https://nuko-c.meowing.de',
        'https://melon.clxxped.lol',
        'https://cobaltapi.kittycat.boo',
        'https://lime.clxxped.lol',
        'https://dog.kittycat.boo',
        'https://fox.kittycat.boo',
        'https://subito-c.meowing.de',
        'https://cobaltapi.squair.xyz',
        'https://cobalt.omega.wolfy.love',
        'https://api.dl.woof.monster',
        'https://api.cobalt.liubquanti.click',
        'https://apicobalt.mgytr.top',
        'https://api.cobalt.blackcat.sweeux.org',
        'https://api.qwkuns.me',
        'https://cobalt.alpha.wolfy.love',
        'https://cobaltapi.cjs.nz',
        'https://nachos.imput.net',
        'https://kityune.imput.net',
        'https://sunny.imput.net',
        'https://blossom.imput.net'
    ];
    
    for (const base of instances) {
        for (const route of ['/api', '/']) {
            try {
                const res = await fetch(`${base}${route}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                    body: JSON.stringify({
                        url: ytUrl,
                        downloadMode: type === 'audio' ? 'audio' : 'auto',
                        videoQuality: '720',
                        youtubeVideoCodec: 'h264',
                        audioFormat: 'mp3',
                        isAudioOnly: type === 'audio'
                    }),
                    signal: AbortSignal.timeout(20_000),
                });
                if (!res.ok) continue;
                const json = await res.json();
                if (!['tunnel','redirect','stream','picker'].includes(json.status)) continue;
                const dlUrl = json.url || json?.picker?.[0]?.url;
                if (!dlUrl) continue;
                const buf = await fetchBuffer(dlUrl);
                if (buf?.length > 10_000) return buf;
            } catch { /* siguiente */ }
        }
    }
    throw new Error('cobalt: todas las instancias fallaron');
};

// ── 4. Y2Mate (2026) ──────────────────────────────────────────────────────────
const providerY2Mate = async (ytUrl, type) => {
    const BASE = 'https://www.y2mate.com';
    const H = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        'Referer': `${BASE}/`,
    };
    const vid = extractVideoId(ytUrl);
    if (!vid) throw new Error('y2mate: videoId inválido');

    const aRes = await fetch(`${BASE}/mates/analyzeV2/ajax`, {
        method: 'POST', headers: H,
        body: new URLSearchParams({ k_query: `https://www.youtube.com/watch?v=${vid}`, k_page: 'home', hl: 'es', q_auto: '0' }).toString(),
        signal: AbortSignal.timeout(25_000),
    });
    if (!aRes.ok) throw new Error(`y2mate analyze HTTP ${aRes.status}`);
    const analyze = await aRes.json();
    if (!analyze.vid) throw new Error(`y2mate: ${analyze.mess || 'sin vid'}`);

    let k;
    if (type === 'audio') {
        const mp3 = analyze.links?.mp3;
        k = (mp3?.mp3128 || Object.values(mp3 || {})[0])?.k;
    } else {
        const mp4 = analyze.links?.mp4;
        k = (mp4?.['720'] || mp4?.['480'] || mp4?.['360'] || Object.values(mp4 || {})[0])?.k;
    }
    if (!k) throw new Error('y2mate: formato no encontrado');

    const cRes = await fetch(`${BASE}/mates/convertV2/index`, {
        method: 'POST', headers: H,
        body: new URLSearchParams({ vid: analyze.vid, k }).toString(),
        signal: AbortSignal.timeout(40_000),
    });
    if (!cRes.ok) throw new Error(`y2mate convert HTTP ${cRes.status}`);
    const conv = await cRes.json();
    if (!conv.dlink) throw new Error('y2mate: sin dlink');
    return await fetchBuffer(conv.dlink, { Referer: `${BASE}/` });
};

// ── 5. SnapSave ───────────────────────────────────────────────────────────────
const providerSnapSave = async (ytUrl, type) => {
    const BASE = 'https://snapsave.app';
    const pageRes = await fetch(`${BASE}/en`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!pageRes.ok) throw new Error(`snapsave page HTTP ${pageRes.status}`);
    const html  = await pageRes.text();
    const token = html.match(/name="token"\s+value="([^"]+)"/)?.[1];
    if (!token) throw new Error('snapsave: no token');

    const convRes = await fetch(`${BASE}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Referer': `${BASE}/` },
        body: new URLSearchParams({ url: ytUrl, token }).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    if (!convRes.ok) throw new Error(`snapsave action HTTP ${convRes.status}`);
    const resHtml = await convRes.text();
    const links = [...resHtml.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1])
        .filter(u => u.includes('.mp4') || u.includes('.mp3') || u.includes('download') || u.includes('googlevideo'));
    if (!links.length) throw new Error('snapsave: sin links');
    const chosen = type === 'video'
        ? (links.find(l => /720/.test(l)) || links.find(l => /480/.test(l)) || links[0])
        : links[0];
    return await fetchBuffer(chosen, { Referer: `${BASE}/` });
};

// ── 6. tomp3.cc ───────────────────────────────────────────────────────────────
const providerToMp3cc = async (ytUrl, type) => {
    const BASE = 'https://tomp3.cc';
    const H = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        'Referer': `${BASE}/`,
    };
    const sRes = await fetch(`${BASE}/api/ajaxSearch`, {
        method: 'POST', headers: H,
        body: new URLSearchParams({ q: ytUrl, vt: 'home' }).toString(),
        signal: AbortSignal.timeout(20_000),
    });
    if (!sRes.ok) throw new Error(`tomp3.cc search HTTP ${sRes.status}`);
    const search = await sRes.json();
    if (search.status !== 'Ok') throw new Error(`tomp3.cc: ${search.mess || 'error'}`);

    let k;
    if (type === 'audio') {
        k = (search.links?.mp3?.mp3128 || Object.values(search.links?.mp3 || {})[0])?.k;
    } else {
        const mp4 = search.links?.mp4;
        k = (mp4?.['720'] || mp4?.['480'] || mp4?.['360'] || Object.values(mp4 || {})[0])?.k;
    }
    if (!k) throw new Error('tomp3.cc: sin k');

    const cRes = await fetch(`${BASE}/api/ajaxConvert`, {
        method: 'POST', headers: H,
        body: new URLSearchParams({ vid: search.vid, k }).toString(),
        signal: AbortSignal.timeout(40_000),
    });
    if (!cRes.ok) throw new Error(`tomp3.cc convert HTTP ${cRes.status}`);
    const conv = await cRes.json();
    if (!conv.dlink) throw new Error('tomp3.cc: sin dlink');
    return await fetchBuffer(conv.dlink, { Referer: `${BASE}/` });
};

// ── 7. loader.to ──────────────────────────────────────────────────────────────
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
    if (!start.id) throw new Error('loader.to: sin id');

    for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 3_000));
        try {
            const pRes = await fetch(`${BASE}/ajax/progress.php?id=${start.id}`,
                { headers: { 'User-Agent': UA, 'Referer': REFERER }, signal: AbortSignal.timeout(10_000) });
            if (!pRes.ok) continue;
            const prog = await pRes.json();
            if (prog.download_url) return await fetchBuffer(prog.download_url, { Referer: REFERER });
            if (prog.success === false) throw new Error('loader.to: conversión fallida');
        } catch (e) { if (e.message.includes('fallida')) throw e; }
    }
    throw new Error('loader.to: timeout');
};

// ─────────────────────────────────────────────────────────────────────────────
//  CADENA DE PROVIDERS
// ─────────────────────────────────────────────────────────────────────────────

const downloadViaProviders = async (ytUrl, type, quality = '720p') => {
    const errors  = [];
    const entries = [
        { name: 'yt-dlp',       fn: () => providerYtDlp(ytUrl, type) },
        { name: 'ytdl-core',    fn: () => providerYtdlCore(ytUrl, type) },
        { name: 'cobalt-2026',  fn: () => providerCobalt2026(ytUrl, type) },
        { name: 'y2mate',       fn: () => providerY2Mate(ytUrl, type) },
        { name: 'snapsave',     fn: () => providerSnapSave(ytUrl, type) },
        { name: 'tomp3.cc',     fn: () => providerToMp3cc(ytUrl, type) },
        { name: 'loader.to',    fn: () => providerLoaderTo(ytUrl, type) },
    ];

    for (const { name, fn } of entries) {
        try {
            console.log(`[yt-providers] ⏳ ${name}…`);
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
//  EXPORT PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

export const ytDownload = async (url, type = 'audio', opts = {}) => {
    const { quality = '720p' } = opts;
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
