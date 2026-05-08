import axios  from 'axios';
import crypto from 'crypto';

const ENDPOINTS = [
    'https://api5.apiapi.lat',
    'https://api.apiapi.lat',
    'https://api3.apiapi.lat',
];
const BASE_URL = 'https://api3.apiapi.lat';

const HEADERS = {
    'content-type': 'application/json',
    'origin':       'https://ogmp3.lat',
    'referer':      'https://ogmp3.lat/',
    'user-agent':   'Postify/1.0.0',
};

const FORMATS = {
    audio: ['64', '96', '128', '192', '256', '320'],
    video: ['240', '360', '480', '720', '1080'],
};

const DEFAULT_FMT = { audio: '320', video: '720' };

// ── utilidades ──────────────────────────────────────────────────────────────

const hash = () => {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
};

const xor = (str) => {
    let r = '';
    for (let i = 0; i < str.length; i++) r += String.fromCharCode(str.charCodeAt(i) ^ 1);
    return r;
};

const encUrl = (url, sep = ',') =>
    [...url].map(c => c.charCodeAt(0)).join(sep).split(sep).reverse().join(sep);

const videoId = (url) => {
    const pats = [
        /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of pats) { const m = url.match(p); if (m) return m[1]; }
    return null;
};

// ── petición base ────────────────────────────────────────────────────────────

const request = async (endpoint, data = {}) => {
    try {
        const base = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
        const url  = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;
        const { data: res } = await axios({ method: 'post', url, data, headers: HEADERS });
        return { ok: true, data: res };
    } catch (e) {
        return { ok: false, error: e.message };
    }
};

// ── polling de estado ────────────────────────────────────────────────────────

const waitReady = async (id, maxAttempts = 120) => {
    for (let i = 0; i < maxAttempts; i++) {
        const r = await request(`/${hash()}/status/${xor(id)}/${hash()}/`, { data: id });
        if (!r.ok)            { await new Promise(s => setTimeout(s, 2000)); continue; }
        if (r.data.s === 'C') return r.data;
        if (r.data.s === 'P') { await new Promise(s => setTimeout(s, 2000)); continue; }
        return null;
    }
    return null;
};

// ── descarga principal ───────────────────────────────────────────────────────

/**
 * Descarga un video/audio de YouTube via ogmp3.
 * @param {string} url     - URL de YouTube
 * @param {'audio'|'video'} type
 * @param {string} [fmt]   - Calidad: '320' para audio, '720' para video (por defecto)
 * @returns {Promise<{status:boolean, result?:{download,title,type,format,thumbnail,id}, error?:string}>}
 */
const download = async (url, type = 'audio', fmt) => {
    const id = videoId(url);
    if (!id) return { status: false, error: 'No se pudo extraer el ID del video.' };

    const format = fmt || DEFAULT_FMT[type];
    if (!FORMATS[type]?.includes(String(format))) {
        return { status: false, error: `Formato "${format}" inválido. Opciones: ${FORMATS[type].join(', ')}` };
    }

    const tz = new Date().getTimezoneOffset().toString();

    for (let attempt = 0; attempt < 10; attempt++) {
        const r = await request(
            `/${hash()}/init/${encUrl(url)}/${hash()}/`,
            {
                data:       xor(url),
                format:     type === 'audio' ? '0' : '1',
                referer:    'https://ogmp3.cc',
                mp3Quality: type === 'audio' ? format : null,
                mp4Quality: type === 'video' ? format : null,
                userTimeZone: tz,
            }
        );

        if (!r.ok) continue;

        const d = r.data;
        if (d.le)                   return { status: false, error: 'El video supera la duración máxima permitida (3h).' };
        if (d.i === 'blacklisted')  return { status: false, error: 'Límite diario de descargas alcanzado.' };
        if (d.e || d.i === 'invalid') return { status: false, error: 'Video inválido o no disponible.' };

        const ready = d.s === 'C' ? d : await waitReady(d.i);
        if (!ready) continue;

        return {
            status: true,
            result: {
                title:     ready.t || 'Sin título',
                type,
                format,
                thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
                download:  `${BASE_URL}/${hash()}/download/${xor(ready.i)}/${hash()}/`,
                id,
            },
        };
    }

    return { status: false, error: 'Todos los intentos fallaron. Intenta más tarde.' };
};

// ── helpers de conveniencia ───────────────────────────────────────────────────

/**
 * Descarga solo el audio (MP3 320kbps por defecto).
 * Compatible con el uso de `providers.ogmp3` en youtube-scraper.js
 */
const audio = (url, fmt = '320') => download(url, 'audio', fmt);

/**
 * Descarga el video (MP4 720p por defecto).
 */
const video = (url, fmt = '720') => download(url, 'video', fmt);

export const ogmp3 = { download, audio, video, formats: FORMATS };
export default ogmp3;
