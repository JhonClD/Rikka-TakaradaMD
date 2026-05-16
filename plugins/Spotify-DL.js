import { fileTypeFromBuffer } from 'file-type';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SPOTIFY_REGEX = /https?:\/\/(?:open\.)?spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchJson = async (url, opts = {}, retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...opts.headers },
        signal: AbortSignal.timeout(opts.timeout || 20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
};

const fetchBuffer = async (url, retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 10_000) throw new Error('Archivo muy pequeño');
      return buf;
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
};

const formatDuration = (ms) => {
  if (!ms || ms < 1000) return ms ? String(ms) : 'N/A';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

const normalizeTrack = (t) => ({
  id:          t.id          || '',
  title:       t.title       || t.name        || 'Sin título',
  artist:      t.artist      || (Array.isArray(t.artists) ? t.artists.map(a => a.name || a).join(', ') : (t.artists || '')) || 'N/A',
  album:       t.album       || t.albumName   || '',
  cover:       t.cover       || t.image       || t.artwork    || '',
  duration:    t.duration    || t.duration_ms || 0,
  releaseDate: t.releaseDate || t.release_date|| t.year       || '',
  popularity:  t.popularity  ?? null,
  url:         t.url         || (t.id ? `https://open.spotify.com/track/${t.id}` : ''),
});

// ── SEARCH ───────────────────────────────────────────────────────────────────

const searchSpotifyDown = async (q) => {
  const j = await fetchJson(
    `https://api.spotifydown.com/search/track?q=${encodeURIComponent(q)}`,
    { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
  );
  if (!j.success || !j.trackList?.length) throw new Error('SpotifyDown: sin resultados');
  return j.trackList.map(normalizeTrack);
};

const searchAkuari = async (q) => {
  const base = global.APIs?.akuari || 'https://api.akuari.my.id';
  const j = await fetchJson(`${base}/api/spotify/search?q=${encodeURIComponent(q)}`);
  const list = j.data?.tracks?.items || j.result || [];
  if (!list.length) throw new Error('Akuari: sin resultados');
  return list.map(t => normalizeTrack({
    id:          t.id,
    title:       t.name,
    artists:     Array.isArray(t.artists) ? t.artists.map(a => a.name || a).join(', ') : '',
    album:       t.album?.name,
    cover:       t.album?.images?.[0]?.url,
    duration_ms: t.duration_ms,
    release_date: t.album?.release_date,
    popularity:  t.popularity,
    url:         t.external_urls?.spotify,
  }));
};

const searchLol = async (q) => {
  const base = global.APIs?.lol || 'https://api.lolhuman.xyz';
  const key  = global.APIKeys?.[base] || 'GataDios';
  const j = await fetchJson(`${base}/api/spotify/search?apikey=${key}&q=${encodeURIComponent(q)}`);
  const list = j.result?.items || [];
  if (!list.length) throw new Error('Lolhuman: sin resultados');
  return list.map(t => normalizeTrack({
    id:         t.id,
    title:      t.name,
    artists:    Array.isArray(t.artists) ? t.artists.map(a => a.name || a).join(', ') : '',
    album:      t.album?.name,
    cover:      t.album?.images?.[0]?.url,
    duration_ms: t.duration_ms,
    popularity: t.popularity,
    url:        t.external_urls?.spotify,
  }));
};

const doSearch = async (query) => {
  const errors = [];
  for (const fn of [searchSpotifyDown, searchAkuari, searchLol]) {
    try {
      const r = await fn(query);
      if (r?.length) return r;
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`Búsqueda falló: ${errors.join(' | ')}`);
};

// ── TRACK INFO ───────────────────────────────────────────────────────────────

const infoSpotifyDown = async (id) => {
  const j = await fetchJson(
    `https://api.spotifydown.com/metadata/track/${id}`,
    { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
  );
  if (!j.success) throw new Error('SpotifyDown info: sin datos');
  return normalizeTrack({ ...j, id });
};

const infoAkuari = async (url) => {
  const base = global.APIs?.akuari || 'https://api.akuari.my.id';
  const j = await fetchJson(`${base}/api/spotify/info?url=${encodeURIComponent(url)}`);
  const t = j.data || j.result;
  if (!t) throw new Error('Akuari info: sin datos');
  return normalizeTrack({
    id:          t.id,
    title:       t.name,
    artists:     Array.isArray(t.artists) ? t.artists.map(a => a.name || a).join(', ') : '',
    album:       t.album?.name,
    cover:       t.album?.images?.[0]?.url,
    duration_ms: t.duration_ms,
    release_date: t.album?.release_date,
    popularity:  t.popularity,
    url:         t.external_urls?.spotify || url,
  });
};

const getTrackInfo = async (input) => {
  const mt = input.match(SPOTIFY_REGEX);
  const id  = mt?.[2] || input;
  const url = SPOTIFY_REGEX.test(input) ? input : `https://open.spotify.com/track/${id}`;
  const errors = [];
  for (const fn of [() => infoSpotifyDown(id), () => infoAkuari(url)]) {
    try { return await fn(); } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
};

// ── DOWNLOAD ─────────────────────────────────────────────────────────────────

const dlSpotifyDown = async (id) => {
  const j = await fetchJson(
    `https://api.spotifydown.com/download/${id}`,
    { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
  );
  if (!j.success || !j.link) throw new Error('SpotifyDown dl: sin link');
  return fetchBuffer(j.link);
};

const dlAkuari = async (url) => {
  const base = global.APIs?.akuari || 'https://api.akuari.my.id';
  const j = await fetchJson(`${base}/api/spotify/download?url=${encodeURIComponent(url)}`);
  const link = j.data?.download_url || j.result?.download || (typeof j.result === 'string' ? j.result : null);
  if (!link) throw new Error('Akuari dl: sin link');
  return fetchBuffer(link);
};

const dlLol = async (url) => {
  const base = global.APIs?.lol || 'https://api.lolhuman.xyz';
  const key  = global.APIKeys?.[base] || 'GataDios';
  const j = await fetchJson(`${base}/api/spotify/dl?apikey=${key}&url=${encodeURIComponent(url)}`);
  const link = j.result?.download_url || j.result?.url || (typeof j.result === 'string' ? j.result : null);
  if (!link) throw new Error('Lolhuman dl: sin link');
  return fetchBuffer(link);
};

const dlBetaBotz = async (url) => {
  const j = await fetchJson(
    `https://api.betabotz.eu.org/api/download/spotify?url=${encodeURIComponent(url)}&apikey=beta`
  );
  const link = j.result?.download || j.result?.url || (typeof j.result === 'string' ? j.result : null);
  if (!link) throw new Error('BetaBotz dl: sin link');
  return fetchBuffer(link);
};

const dlDelirius = async (url) => {
  const base = global.BASE_API_DELIRIUS || 'https://delirius-apiofc.vercel.app';
  const j = await fetchJson(`${base}/download/spotify?url=${encodeURIComponent(url)}`);
  const link = j.data?.download || j.data?.audio || (typeof j.result === 'string' ? j.result : null);
  if (!link) throw new Error('Delirius dl: sin link');
  return fetchBuffer(link);
};

const dlXteam = async (url) => {
  const base = global.APIs?.xteam || 'https://api.xteam.xyz';
  const key  = global.APIKeys?.[base] || '';
  const j = await fetchJson(`${base}/spotify/dl?apikey=${key}&url=${encodeURIComponent(url)}`);
  const link = j.result?.download_url || j.result?.url || j.result?.audio;
  if (!link) throw new Error('Xteam dl: sin link');
  return fetchBuffer(link);
};

const doDownload = async (input) => {
  const mt  = input.match(SPOTIFY_REGEX);
  const id  = mt?.[2] || input;
  const url = SPOTIFY_REGEX.test(input) ? input : `https://open.spotify.com/track/${id}`;

  const providers = [
    { name: 'spotifydown', fn: () => dlSpotifyDown(id)  },
    { name: 'akuari',      fn: () => dlAkuari(url)      },
    { name: 'lolhuman',    fn: () => dlLol(url)         },
    { name: 'betabotz',    fn: () => dlBetaBotz(url)    },
    { name: 'xteam',       fn: () => dlXteam(url)       },
    { name: 'delirius',    fn: () => dlDelirius(url)    },
  ];

  const errors = [];
  for (const p of providers) {
    try {
      const buf = await p.fn();
      if (buf?.length > 10_000) return { buffer: buf, provider: p.name };
    } catch (e) { errors.push(`${p.name}: ${e.message}`); }
  }
  throw new Error(`Descarga falló:\n${errors.join('\n')}`);
};

// ── COLLECTION ───────────────────────────────────────────────────────────────

const getCollectionInfo = async (input) => {
  const match = input.match(SPOTIFY_REGEX);
  if (!match || !['album', 'playlist'].includes(match[1]))
    throw new Error('URL no es de album ni playlist');

  const type = match[1];
  const id   = match[2];

  const trySpotifyDown = async () => {
    const j = await fetchJson(
      `https://api.spotifydown.com/metadata/${type}/${id}`,
      { headers: { origin: 'https://spotifydown.com', referer: 'https://spotifydown.com/' } }
    );
    if (!j.success) throw new Error('SpotifyDown collection: sin datos');
    return {
      name:   j.metadata?.title || j.title || 'Sin nombre',
      artist: j.metadata?.artists || j.artist || 'N/A',
      cover:  j.metadata?.cover  || j.cover  || '',
      total:  j.trackList?.length || 0,
      tracks: (j.trackList || []).map(t => normalizeTrack({ ...t, url: `https://open.spotify.com/track/${t.id}` })),
    };
  };

  const tryAkuari = async () => {
    const base = global.APIs?.akuari || 'https://api.akuari.my.id';
    const j = await fetchJson(`${base}/api/spotify/${type}?url=${encodeURIComponent(input)}`);
    const d = j.data || j.result;
    if (!d) throw new Error('Akuari collection: sin datos');
    const rawTracks = d.tracks?.items || d.tracks || [];
    return {
      name:   d.name || 'Sin nombre',
      artist: Array.isArray(d.artists) ? d.artists.map(a => a.name).join(', ') : d.owner?.display_name || 'N/A',
      cover:  d.images?.[0]?.url || '',
      total:  d.tracks?.total || rawTracks.length,
      tracks: rawTracks.map(t => {
        const tr = t.track || t;
        return normalizeTrack({
          id:          tr.id,
          title:       tr.name,
          artists:     Array.isArray(tr.artists) ? tr.artists.map(a => a.name).join(', ') : '',
          album:       tr.album?.name || d.name,
          cover:       tr.album?.images?.[0]?.url || d.images?.[0]?.url,
          duration_ms: tr.duration_ms,
          url:         tr.external_urls?.spotify,
        });
      }),
    };
  };

  const errors = [];
  for (const fn of [trySpotifyDown, tryAkuari]) {
    try { return await fn(); } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
};

// ── HANDLER ──────────────────────────────────────────────────────────────────

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text)
    return m.reply(
      `ꕥ *Proporciona el nombre de una canción, artista o URL de Spotify.*\n` +
      `_Uso: *${usedPrefix}${command}* <nombre | URL track/album/playlist>_`
    );

  await m.react('🕒');

  try {
    const isUrl = SPOTIFY_REGEX.test(text);
    const uType = isUrl ? text.match(SPOTIFY_REGEX)?.[1] : null;

    // ── ALBUM / PLAYLIST ────────────────────────────────────────────────────
    if (uType === 'album' || uType === 'playlist') {
      const label = uType === 'album' ? 'Album' : 'Playlist';
      const col   = await getCollectionInfo(text);

      await conn.sendMessage(m.chat, {
        text:
          `🎵 *${col.name}*\n` +
          `> • Artista » *${col.artist}*\n` +
          `> • Total » *${col.total} canciones*\n\n` +
          `_Descargando en orden..._`,
        contextInfo: col.cover ? {
          externalAdReply: {
            title: `✧ Spotify • ${label} ✧`,
            body: col.artist,
            thumbnailUrl: col.cover,
            sourceUrl: text,
            mediaType: 1,
            renderLargerThumbnail: true,
          },
        } : undefined,
      }, { quoted: m });

      let sent = 0, failed = 0;

      for (let i = 0; i < col.tracks.length; i++) {
        const track    = col.tracks[i];
        const trackUrl = track.url || `https://open.spotify.com/track/${track.id}`;
        try {
          const { buffer } = await doDownload(trackUrl);
          const dur = track.duration > 1000 ? formatDuration(track.duration) : '';
          await conn.sendMessage(m.chat, {
            audio: buffer,
            mimetype: 'audio/mpeg',
            fileName: `${track.title} - ${track.artist}.mp3`,
            contextInfo: track.cover ? {
              externalAdReply: {
                title: `[${i + 1}/${col.total}] ${track.title}`,
                body: track.artist + (dur ? ` • ${dur}` : ''),
                thumbnailUrl: track.cover,
                sourceUrl: trackUrl,
                mediaType: 1,
              },
            } : undefined,
          }, { quoted: m });
          sent++;
        } catch { failed++; }
      }

      await m.react(sent > 0 ? '✔️' : '✖️');
      return m.reply(
        `✅ *${label} completo.*\n` +
        `> • Enviados » *${sent}/${col.total}*` +
        (failed > 0 ? `\n> • Fallidos » *${failed}*` : '')
      );
    }

    // ── TRACK URL ───────────────────────────────────────────────────────────
    if (uType === 'track') {
      const [meta, { buffer }] = await Promise.all([
        getTrackInfo(text),
        doDownload(text),
      ]);
      const dur = meta.duration > 1000 ? formatDuration(meta.duration) : '';

      await conn.sendMessage(m.chat, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        fileName: `${meta.title} - ${meta.artist}.mp3`,
        contextInfo: meta.cover ? {
          externalAdReply: {
            title: meta.title,
            body: `${meta.artist}` + (meta.album ? ` • ${meta.album}` : '') + (dur ? ` • ${dur}` : ''),
            thumbnailUrl: meta.cover,
            sourceUrl: meta.url || text,
            mediaType: 1,
            renderLargerThumbnail: true,
          },
        } : undefined,
      }, { quoted: m });

      return await m.react('✔️');
    }

    if (uType) return m.reply('❌ Solo se soportan links de track, album y playlist.');

    // ── BÚSQUEDA POR NOMBRE ─────────────────────────────────────────────────
    const results = await doSearch(text);
    if (!results.length) throw new Error('No se encontró la canción.');

    const meta     = results[0];
    const trackUrl = meta.url || `https://open.spotify.com/track/${meta.id}`;
    const dur      = meta.duration > 1000 ? formatDuration(meta.duration) : '';

    const { buffer } = await doDownload(trackUrl);

    await conn.sendMessage(m.chat, {
      audio: buffer,
      mimetype: 'audio/mpeg',
      fileName: `${meta.title} - ${meta.artist}.mp3`,
      contextInfo: meta.cover ? {
        externalAdReply: {
          title: meta.title,
          body: `${meta.artist}` + (meta.album ? ` • ${meta.album}` : '') + (dur ? ` • ${dur}` : ''),
          thumbnailUrl: meta.cover,
          sourceUrl: trackUrl,
          mediaType: 1,
          renderLargerThumbnail: true,
        },
      } : undefined,
    }, { quoted: m });

    await m.react('✔️');

  } catch (e) {
    console.error('[Spotify]', e?.message || e);
    await m.react('✖️');
    m.reply(`> 🍜 *Error:* ${e?.message || e}`);
  }
};

handler.help    = ['spotify *« query/url »*'];
handler.tags    = ['download'];
handler.command = /^(spotify|splay|spdl)$/i;

export default handler;
                                                                                                          
