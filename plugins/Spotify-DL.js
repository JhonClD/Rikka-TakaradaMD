import {
  spotifySearch,
  spotifyDownload,
  spotifyCollectionInfo,
  spotifyDownloadCollection,
  spotifyTrackInfo,
  buildSpotifyCard,
  formatDuration,
  SPOTIFY_REGEX,
} from '../src/libraries/spotify-scraper.js';

const isSpotifyUrl = (t) => SPOTIFY_REGEX.test(t);

const getType = (url) => {
  const m = url.match(SPOTIFY_REGEX);
  return m ? m[1] : null;
};

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text)
    return m.reply(
      `ꕥ *Proporciona el nombre de una canción, artista o URL de Spotify.*\n` +
      `_Uso: *${usedPrefix}${command}* <nombre | URL track/album/playlist>_`
    );

  await m.react('🕒');

  try {
    let type = null;

    if (isSpotifyUrl(text)) {
      type = getType(text);

      if (type === 'album' || type === 'playlist') {
        const label = type === 'album' ? 'álbum' : 'playlist';
        const collection = await spotifyCollectionInfo(text);

        const header =
          `🎵 *${collection.name}*\n` +
          `> • Artista » *${collection.artist}*\n` +
          `> • Total » *${collection.total} canciones*\n\n` +
          `_Descargando en orden..._`;

        await conn.sendMessage(m.chat, {
          text: header,
          contextInfo: collection.cover ? {
            externalAdReply: {
              title: `✧ Spotify • ${type === 'album' ? 'Album' : 'Playlist'} ✧`,
              body: collection.artist,
              thumbnailUrl: collection.cover,
              sourceUrl: text,
              mediaType: 1,
              renderLargerThumbnail: true,
            },
          } : undefined,
        }, { quoted: m });

        let sent = 0, failed = 0;

        await spotifyDownloadCollection(text, async (result, err) => {
          if (err) {
            failed++;
            return;
          }
          const { buffer, meta, index, total } = result;
          const title  = meta.title  || `Track ${index}`;
          const artist = meta.artist || 'N/A';
          const dur    = typeof meta.duration === 'number' && meta.duration > 1000
            ? formatDuration(meta.duration) : meta.duration || '';

          const caption =
            `[${index}/${total}] 🎵 *${title}*\n` +
            `> • Artista » *${artist}*\n` +
            (dur ? `> • Duración » *${dur}*\n` : '');

          await conn.sendMessage(m.chat, {
            audio: buffer,
            mimetype: 'audio/mpeg',
            fileName: `${title} - ${artist}.mp3`,
            contextInfo: meta.cover ? {
              externalAdReply: {
                title: title,
                body: artist,
                thumbnailUrl: meta.cover,
                sourceUrl: meta.url || text,
                mediaType: 1,
                renderLargerThumbnail: false,
              },
            } : undefined,
          }, { quoted: m });

          sent++;
        });

        await m.react(sent > 0 ? '✔️' : '✖️');
        return m.reply(
          `✅ *${label.charAt(0).toUpperCase() + label.slice(1)} completo.*\n` +
          `> • Enviados » *${sent}*\n` +
          (failed > 0 ? `> • Fallidos » *${failed}*` : '')
        );
      }

      if (type === 'track') {
        const meta = await spotifyTrackInfo(text);

        const dur = typeof meta.duration === 'number' && meta.duration > 1000
          ? formatDuration(meta.duration) : meta.duration || '';

        const caption =
          `✰ Descargando *${meta.title}*\n\n` +
          `> • Artista » *${meta.artist}*\n` +
          (meta.album      ? `> • Álbum » *${meta.album}*\n`           : '') +
          (dur             ? `> • Duración » *${dur}*\n`               : '') +
          (meta.popularity != null ? `> • Popularidad » *${meta.popularity}*\n` : '') +
          (meta.releaseDate && meta.releaseDate !== 'N/A' ? `> • Publicado » *${meta.releaseDate}*\n` : '') +
          `> • Enlace » ${meta.url || text}`;

        await conn.sendMessage(m.chat, {
          text: caption,
          contextInfo: meta.cover ? {
            externalAdReply: {
              title: '✧ Spotify • Music ✧',
              body: meta.artist,
              thumbnailUrl: meta.cover,
              sourceUrl: meta.url || text,
              mediaType: 1,
              renderLargerThumbnail: true,
            },
          } : undefined,
        }, { quoted: m });

        const { buffer, provider } = await spotifyDownload(text);

        await conn.sendMessage(m.chat, {
          audio: buffer,
          mimetype: 'audio/mpeg',
          fileName: `${meta.title} - ${meta.artist}.mp3`,
        }, { quoted: m });

        return await m.react('✔️');
      }

      return m.reply('❌ URL de Spotify no soportada. Solo track, album y playlist.');
    }

    const results = await spotifySearch(text, 1);
    if (!results.length) throw new Error('No se encontró la canción.');

    const meta = results[0];
    const trackUrl = meta.url || `https://open.spotify.com/track/${meta.id}`;

    const dur = typeof meta.duration === 'number' && meta.duration > 1000
      ? formatDuration(meta.duration) : meta.duration || '';

    const caption =
      `✰ Descargando *${meta.title}*\n\n` +
      `> • Artista » *${meta.artist}*\n` +
      (meta.album      ? `> • Álbum » *${meta.album}*\n`           : '') +
      (dur             ? `> • Duración » *${dur}*\n`               : '') +
      (meta.popularity != null ? `> • Popularidad » *${meta.popularity}*\n` : '') +
      (meta.releaseDate && meta.releaseDate !== 'N/A' ? `> • Publicado » *${meta.releaseDate}*\n` : '') +
      `> • Enlace » ${trackUrl}`;

    await conn.sendMessage(m.chat, {
      text: caption,
      contextInfo: meta.cover ? {
        externalAdReply: {
          title: '✧ Spotify • Music ✧',
          body: meta.artist,
          thumbnailUrl: meta.cover,
          sourceUrl: trackUrl,
          mediaType: 1,
          renderLargerThumbnail: true,
        },
      } : undefined,
    }, { quoted: m });

    const { buffer } = await spotifyDownload(trackUrl);

    await conn.sendMessage(m.chat, {
      audio: buffer,
      mimetype: 'audio/mpeg',
      fileName: `${meta.title} - ${meta.artist}.mp3`,
    }, { quoted: m });

    await m.react('✔️');

  } catch (e) {
    console.error('[Spotify]', e);
    await m.react('✖️');
    m.reply(`> 🍜 *Error:* ${e.message || e}`);
  }
};

handler.help    = ['spotify *« query/url »*'];
handler.tags    = ['download'];
handler.command = /^(spotify|splay|spdl)$/i;

export default handler;
            
