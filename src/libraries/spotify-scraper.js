import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TMP_DIR    = os.tmpdir();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const SPOTIFY_REGEX = /https?:\/\/(?:open\.)?spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/;

const isSpotifyUrl = (url) => SPOTIFY_REGEX.test(url);

const extractSpotifyId = (url) => {
    const m = url.match(SPOTIFY_REGEX);
    return m ? { type: m[1], id: m[2] } : null;
};

export const formatDuration = (ms) => {
    if (!ms) return 'N/A';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
};

const fetchJson = async (url, opts = {}, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, ...opts.headers },
                signal: AbortSignal.timeout(opts.timeout || 20_000),
                ...opts,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        }
    }
};

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

const normalizeTrack = (raw) => ({
    id:        raw.id         || raw.spotifyId || '',
    title:     raw.title      || raw.name      || 'Sin título',
    artist:    raw.artist     || (Array.isArray(raw.artists) ? raw.artists.map(a => a.name || a).join(', ') : raw.artists) || 'N/A',
    album:     raw.album      || raw.albumName || 'N/A',
    cover:     raw.cover      || raw.image     || raw.artwork   || raw.thumbnail || '',
    duration:  raw.duration   || raw.duration_ms || 0,
    releaseDate: raw.releaseDate || raw.release_date || raw.year || 'N/A',
    popularity: raw.popularity ?? null,
    preview:   raw.preview_url || raw.preview   || '',
    url:       raw.url        || raw.spotifyUrl || raw.external_urls?.spotify || '',
    isrc:      raw.isrc       || '',
});

const searchProviderSpotifyDown = async (query) => {
    const res = await fetchJson(
        `https://api.spotifydown.com/search/track?q=${encodeURIComponent(query)}`,
        { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
    );
    if (!res.success || !res.trackList?.length) throw new Error('SpotifyDown search: sin resultados');
    return res.trackList.map(t => normalizeTrack({
        id:     t.id,
        title:  t.title,
        artist: t.artists,
        album:  t.album,
        cover:  t.cover,
    }));
};

const searchProviderAkuari = async (query) => {
    const res = await fetchJson(
        `https://api.akuari.my.id/api/spotify/search?q=${encodeURIComponent(query)}`
    );
    const list = res.data?.tracks?.items || res.result || [];
    if (!list.length) throw new Error('Akuari search: sin resultados');
    return list.map(t => normalizeTrack({
        id:      t.id,
        title:   t.name || t.title,
        artists: t.artists,
        album:   t.album?.name || t.album,
        cover:   t.album?.images?.[0]?.url || t.cover,
        duration_ms: t.duration_ms,
        release_date: t.album?.release_date,
        popularity:   t.popularity,
        preview_url:  t.preview_url,
        external_urls: t.external_urls,
    }));
};

const searchProviderLolhuman = async (query) => {
    const keys = ['beta', 'ErlanBot'];
    for (const k of keys) {
        try {
            const res = await fetchJson(`https://api.lolhuman.xyz/api/spotify/search?apikey=${k}&q=${encodeURIComponent(query)}`);
            const list = res.result?.items || [];
            if (!list.length) continue;
            return list.map(t => normalizeTrack({
                id:      t.id,
                title:   t.name,
                artists: t.artists,
                album:   t.album?.name,
                cover:   t.album?.images?.[0]?.url,
                duration_ms:  t.duration_ms,
                release_date: t.album?.release_date,
                popularity:   t.popularity,
                preview_url:  t.preview_url,
                external_urls: t.external_urls,
            }));
        } catch {}
    }
    throw new Error('Lolhuman search: falló');
};

export const spotifySearch = async (query, limit = 5) => {
    const providers = [
        () => searchProviderSpotifyDown(query),
        () => searchProviderAkuari(query),
        () => searchProviderLolhuman(query),
    ];
    const errors = [];
    for (const fn of providers) {
        try {
            const results = await fn();
            return results.slice(0, limit);
        } catch (e) { errors.push(e.message); }
    }
    throw new Error(`spotifySearch falló: ${errors.join(' | ')}`);
};

const infoProviderSpotifyDown = async (trackId) => {
    const res = await fetchJson(
        `https://api.spotifydown.com/metadata/track/${trackId}`,
        { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
    );
    if (!res.success) throw new Error('SpotifyDown info: sin datos');
    return normalizeTrack({ ...res, id: trackId });
};

const infoProviderAkuari = async (trackUrl) => {
    const res = await fetchJson(
        `https://api.akuari.my.id/api/spotify/info?url=${encodeURIComponent(trackUrl)}`
    );
    const t = res.data || res.result;
    if (!t) throw new Error('Akuari info: sin datos');
    return normalizeTrack({
        id:      t.id,
        title:   t.name || t.title,
        artists: t.artists,
        album:   t.album?.name || t.album,
        cover:   t.album?.images?.[0]?.url || t.cover,
        duration_ms:  t.duration_ms,
        release_date: t.album?.release_date,
        popularity:   t.popularity,
        preview_url:  t.preview_url,
        external_urls: t.external_urls,
    });
};

export const spotifyTrackInfo = async (input) => {
    const parsed = extractSpotifyId(input);
    const trackId  = parsed?.id  || (isSpotifyUrl(input) ? null : input);
    const trackUrl = isSpotifyUrl(input) ? input : `https://open.spotify.com/track/${trackId}`;

    const providers = [
        () => infoProviderSpotifyDown(trackId),
        () => infoProviderAkuari(trackUrl),
    ];
    const errors = [];
    for (const fn of providers) {
        try { return await fn(); } catch (e) { errors.push(e.message); }
    }
    throw new Error(`spotifyTrackInfo falló: ${errors.join(' | ')}`);
};

const dlProviderSpotifyDown = async (trackId) => {
    const res = await fetchJson(
        `https://api.spotifydown.com/download/${trackId}`,
        { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
    );
    if (!res.success || !res.link) throw new Error('SpotifyDown dl: sin link');
    const buf = await fetchBuffer(res.link);
    if (!buf || buf.length < 10_000) throw new Error('SpotifyDown dl: archivo muy pequeño');
    return buf;
};

const dlProviderAkuari = async (trackUrl) => {
    const res = await fetchJson(
        `https://api.akuari.my.id/api/spotify/download?url=${encodeURIComponent(trackUrl)}`
    );
    const link = res.data?.download_url || res.result?.download || res.result;
    if (!link) throw new Error('Akuari dl: sin link');
    const buf = await fetchBuffer(link);
    if (!buf || buf.length < 10_000) throw new Error('Akuari dl: archivo muy pequeño');
    return buf;
};

const dlProviderLolhuman = async (trackUrl) => {
    const keys = ['beta', 'ErlanBot'];
    for (const k of keys) {
        try {
            const res = await fetchJson(
                `https://api.lolhuman.xyz/api/spotify/dl?apikey=${k}&url=${encodeURIComponent(trackUrl)}`
            );
            const link = res.result?.download_url || res.result?.url || res.result;
            if (!link || typeof link !== 'string') continue;
            const buf = await fetchBuffer(link);
            if (buf && buf.length > 10_000) return buf;
        } catch {}
    }
    throw new Error('Lolhuman dl: falló');
};

const dlProviderBetaBotz = async (trackUrl) => {
    const keys = ['beta', 'ErlanBot'];
    for (const k of keys) {
        try {
            const res = await fetchJson(
                `https://api.betabotz.eu.org/api/download/spotify?url=${encodeURIComponent(trackUrl)}&apikey=${k}`
            );
            const link = res.result?.download || res.result?.url || res.result;
            if (!link || typeof link !== 'string') continue;
            const buf = await fetchBuffer(link);
            if (buf && buf.length > 10_000) return buf;
        } catch {}
    }
    throw new Error('BetaBotz dl: falló');
};

const dlProviderDelirius = async (trackUrl) => {
    const base = global.BASE_API_DELIRIUS || 'https://delirius-apiofc.vercel.app';
    const res  = await fetchJson(`${base}/download/spotify?url=${encodeURIComponent(trackUrl)}`);
    const link = res.data?.download || res.data?.audio || res.result;
    if (!link) throw new Error('Delirius dl: sin link');
    const buf = await fetchBuffer(link);
    if (!buf || buf.length < 10_000) throw new Error('Delirius dl: archivo muy pequeño');
    return buf;
};

export const spotifyDownload = async (input) => {
    const parsed   = extractSpotifyId(input);
    const trackId  = parsed?.id || (isSpotifyUrl(input) ? null : input);
    const trackUrl = isSpotifyUrl(input) ? input : `https://open.spotify.com/track/${trackId}`;

    if (!trackId) throw new Error('spotifyDownload: ID de track inválido');

    const infoPromise = spotifyTrackInfo(trackUrl).catch(() => ({}));

    const providers = [
        { name: 'spotifydown', fn: () => dlProviderSpotifyDown(trackId)    },
        { name: 'akuari',      fn: () => dlProviderAkuari(trackUrl)        },
        { name: 'lolhuman',    fn: () => dlProviderLolhuman(trackUrl)      },
        { name: 'betabotz',    fn: () => dlProviderBetaBotz(trackUrl)      },
        { name: 'delirius',    fn: () => dlProviderDelirius(trackUrl)      },
    ];

    const errors = [];
    let buffer, provider;

    for (const p of providers) {
        try {
            buffer   = await p.fn();
            provider = p.name;
            break;
        } catch (e) { errors.push(`${p.name}: ${e.message}`); }
    }

    if (!buffer) throw new Error(`spotifyDownload falló:\n${errors.join('\n')}`);

    const meta = await infoPromise;
    return { buffer, provider, meta };
};

const collectionProviderSpotifyDown = async (type, id) => {
    const endpoint = type === 'album' ? 'album' : 'playlist';
    const res = await fetchJson(
        `https://api.spotifydown.com/metadata/${endpoint}/${id}`,
        { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
    );
    if (!res.success) throw new Error('SpotifyDown collection: sin datos');
    const tracks = (res.trackList || []).map(t => normalizeTrack({ ...t, url: `https://open.spotify.com/track/${t.id}` }));
    return {
        id,
        type,
        name:   res.metadata?.title || res.title || 'Sin nombre',
        artist: res.metadata?.artists || res.artist || 'N/A',
        cover:  res.metadata?.cover   || res.cover  || '',
        total:  tracks.length,
        tracks,
    };
};

const collectionProviderAkuari = async (type, url) => {
    const endpoint = type === 'album' ? 'album' : 'playlist';
    const res = await fetchJson(
        `https://api.akuari.my.id/api/spotify/${endpoint}?url=${encodeURIComponent(url)}`
    );
    const data = res.data || res.result;
    if (!data) throw new Error('Akuari collection: sin datos');
    const rawTracks = data.tracks?.items || data.tracks || [];
    const tracks = rawTracks.map(t => {
        const track = t.track || t;
        return normalizeTrack({
            id:      track.id,
            title:   track.name,
            artists: track.artists,
            album:   track.album?.name || data.name,
            cover:   track.album?.images?.[0]?.url || data.images?.[0]?.url,
            duration_ms:  track.duration_ms,
            external_urls: track.external_urls,
        });
    });
    return {
        id:     data.id,
        type,
        name:   data.name,
        artist: data.artists ? data.artists.map(a => a.name).join(', ') : data.owner?.display_name || 'N/A',
        cover:  data.images?.[0]?.url || '',
        total:  data.tracks?.total || tracks.length,
        tracks,
    };
};

export const spotifyCollectionInfo = async (input) => {
    const parsed = extractSpotifyId(input);
    if (!parsed || !['album', 'playlist'].includes(parsed.type))
        throw new Error('spotifyCollectionInfo: URL no es de album ni playlist');

    const url = isSpotifyUrl(input) ? input : `https://open.spotify.com/${parsed.type}/${parsed.id}`;

    const providers = [
        () => collectionProviderSpotifyDown(parsed.type, parsed.id),
        () => collectionProviderAkuari(parsed.type, url),
    ];
    const errors = [];
    for (const fn of providers) {
        try { return await fn(); } catch (e) { errors.push(e.message); }
    }
    throw new Error(`spotifyCollectionInfo falló: ${errors.join(' | ')}`);
};

export const spotifyDownloadCollection = async (input, onTrack = null) => {
    const collection = await spotifyCollectionInfo(input);
    const results    = [];

    for (let i = 0; i < collection.tracks.length; i++) {
        const track = collection.tracks[i];
        try {
            const dl = await spotifyDownload(track.url || `https://open.spotify.com/track/${track.id}`);
            const result = { ...dl, meta: { ...dl.meta, ...track }, index: i + 1, total: collection.total };
            results.push(result);
            if (typeof onTrack === 'function') await onTrack(result, null);
        } catch (e) {
            const errResult = { error: e.message, meta: track, index: i + 1, total: collection.total };
            results.push(errResult);
            if (typeof onTrack === 'function') await onTrack(null, errResult);
        }
    }

    return { collection, results };
};

export const buildSpotifyCard = (meta = {}) => {
    const dur = typeof meta.duration === 'number' && meta.duration > 1000
        ? formatDuration(meta.duration)
        : meta.duration || 'N/A';
    return (
`╭━━━〔 🎵 SPOTIFY TRACK 〕━━━⬣
┃ ◈ *Título:*  ${meta.title || 'N/A'}
┃ ✦ *Artista:* ${meta.artist || 'N/A'}
┃ ◷ *Álbum:*   ${meta.album || 'N/A'}
┃ ⊞ *Duración:* ${dur}
┃ 📅 *Lanzamiento:* ${meta.releaseDate || 'N/A'}
┃ 🔗 *URL:* ${meta.url || 'N/A'}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};
                           
