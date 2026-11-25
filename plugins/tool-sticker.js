/*
 ☆ Plugin: Stickers Full — Creación, Recorte, Círculo, Audio Stickers, WM y Conversión inversa
 ☆ Comandos:
 ☆   .s / .sticker / .st [pack | autor]        → sticker (imagen, video, GIF, sticker o URL)
 ☆   .saudio / .sa / .s -audio [pack | autor]  → sticker con audio nativo de WhatsApp
 ☆   .s -crop / .scrop / .sfull                → sticker cuadrado 1:1 sin bordes
 ☆   .s -circle / .scircle / .sredondo         → sticker circular
 ☆   .wm / .take / .robar [pack | autor]       → cambia pack/autor conservando calidad (y audio)
 ☆   .toimg / .tovid / .toaud                  → convierte un sticker a PNG, MP4 (con sonido) o MP3
*/

import { Buffer } from 'node:buffer';
import {
  MAX_ANIMATED_AUDIO_SECONDS,
  MAX_STATIC_AUDIO_SECONDS,
  MAX_VIDEO_SECONDS,
  addExif,
  createSticker,
  downloadStickerAudio,
  extractAudioToMp3,
  getStickerAudioDescriptor,
  isAnimatedWebp,
  isValidWebp,
  prepareStickerAudio,
  sendAudioSticker,
  sticker5,
  stickerToMedia,
  toBuffer,
} from '../src/libraries/sticker.js';

const MAX_INPUT_BYTES = 60 * 1024 * 1024;
const MAX_METADATA_LENGTH = 180;
const SESSION_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 100;

const STICKER_COMMANDS = [
  's',
  'sticker',
  'st',
  'scrop',
  'sfull',
  'scircle',
  'sredondo',
  'saudio',
  'sa',
  'ssound',
  'stickeraudio',
  'wm',
  'take',
  'robar',
  'toimg',
  'tovid',
  'toaud',
  'tomp3',
];

const AUDIO_COMMANDS = new Set(['saudio', 'sa', 'ssound', 'stickeraudio']);
const URL_REGEX = /https?:\/\/[^\s<>]+/i;
const audioStickerSessions = new Map();

function pruneAudioSessions() {
  const now = Date.now();
  for (const [key, session] of audioStickerSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      audioStickerSessions.delete(key);
    }
  }
  while (audioStickerSessions.size > MAX_ACTIVE_SESSIONS) {
    const oldest = audioStickerSessions.keys().next().value;
    if (!oldest) break;
    audioStickerSessions.delete(oldest);
  }
}

const cleanMetadata = (value, fallback) => {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_LENGTH);
  return cleaned || fallback;
};

const getMediaMessage = (message) => message?.msg || message || {};

function inferMimeFromFileName(fileName = '') {
  const ext = String(fileName).toLowerCase().split('.').pop();
  switch (ext) {
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
    case 'bmp':
    case 'avif':
      return 'image/jpeg';
    case 'mp4':
    case 'mov':
    case 'mkv':
    case 'webm':
    case 'avi':
    case 'm4v':
      return 'video/mp4';
    case 'mp3':
    case 'ogg':
    case 'opus':
    case 'm4a':
    case 'wav':
    case 'aac':
    case 'flac':
      return 'audio/mpeg';
    default:
      return '';
  }
}

function inferMimeFromMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (isValidWebp(buffer)) return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm';
  }
  return '';
}

function inspectTarget(target) {
  if (!target || typeof target.download !== 'function') {
    return {
      hasMedia: false,
      mime: '',
      isSticker: false,
      isImage: false,
      isVideo: false,
      isGif: false,
      isAudio: false,
      isVisual: false,
    };
  }
  const media = getMediaMessage(target);
  const rawMime = String(media.mimetype || '').toLowerCase();
  const mime =
    !rawMime || rawMime === 'application/octet-stream'
      ? inferMimeFromFileName(media.fileName) || rawMime
      : rawMime;
  const mtype = String(target.mtype || target.mediaType || '');
  const isSticker = mtype === 'stickerMessage' || mime.includes('webp');
  const isGif = mime === 'image/gif' || Boolean(media.gifPlayback);
  const isVideo = mtype === 'videoMessage' || mime.startsWith('video/');
  const isImage = !isSticker && (mtype === 'imageMessage' || mime.startsWith('image/'));
  const isAudio =
    mtype === 'audioMessage' || mime.startsWith('audio/') || mime.includes('ogg');
  const isVisual = isSticker || isImage || isVideo || isGif;
  return {
    hasMedia: Boolean(mime || isVisual || isAudio),
    media,
    mime,
    isSticker,
    isImage,
    isVideo,
    isGif,
    isAudio,
    isVisual,
  };
}

function parseModeAndText(command, rawText) {
  const cmd = String(command || '').toLowerCase();
  let mode = 'default';
  let withAudio = AUDIO_COMMANDS.has(cmd);
  let muteAudio = false;

  if (cmd === 'scrop' || cmd === 'sfull') mode = 'crop';
  else if (cmd === 'scircle' || cmd === 'sredondo') mode = 'circle';

  let remaining = String(rawText || '').trim();

  // Soporta múltiples flags como `.s -audio -crop Pack | Autor` o `.saudio -circle`
  while (remaining) {
    const flagMatch = remaining.match(
      /^(?:--?(crop|full|c|circle|redondo|r|audio|sound|sonido|a|mute|sinaudio|noaudio|m))\b\s*/i,
    );
    if (!flagMatch) break;
    const flag = flagMatch[1].toLowerCase();
    if (flag === 'crop' || flag === 'full' || flag === 'c') mode = 'crop';
    else if (flag === 'circle' || flag === 'redondo' || flag === 'r') mode = 'circle';
    else if (flag === 'audio' || flag === 'sound' || flag === 'sonido' || flag === 'a') {
      withAudio = true;
      muteAudio = false;
    } else if (flag === 'mute' || flag === 'sinaudio' || flag === 'noaudio' || flag === 'm') {
      muteAudio = true;
      withAudio = false;
    }
    remaining = remaining.slice(flagMatch[0].length).trim();
  }

  return { mode, withAudio, muteAudio, remaining };
}

async function buildMetadata(m, conn, rawMeta) {
  const parts = String(rawMeta || '')
    .split('|', 2)
    .map((p) => p.trim());
  const user = cleanMetadata(m.pushName, 'Usuario');
  const groupName = m.isGroup
    ? cleanMetadata(await conn.getName(m.chat).catch(() => 'Grupo'), 'Grupo')
    : 'Chat privado';
  const now = new Date();
  const date = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  const packname = cleanMetadata(parts[0], `Rikka Takarada • ${user}`);
  const author = cleanMetadata(parts[1], `${date} ${time} • ${groupName}`);
  return { packname, author };
}

async function downloadFromUrl(url) {
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_INPUT_BYTES) {
    throw new Error('El archivo en la URL supera los 60 MB.');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('La URL devolvió un archivo vacío.');
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error('El archivo en la URL supera los 60 MB.');
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error('La URL apunta a una página web, no a un archivo multimedia directo.');
  }

  const headerMime = contentType.split(';')[0].trim();
  const mime =
    !headerMime || headerMime === 'application/octet-stream'
      ? inferMimeFromMagicBytes(buffer) || inferMimeFromFileName(url.split('?')[0]) || headerMime
      : headerMime;

  return { buffer, mime };
}

async function convertToWebp(mediaBuffer, { isAnimated, mode, packname, author }) {
  try {
    return await createSticker(mediaBuffer, {
      isAnimated,
      mode,
      maxSeconds: MAX_VIDEO_SECONDS,
    });
  } catch (err) {
    console.warn('[sticker] Falló ffmpeg directo, probando wa-sticker-formatter:', err?.message || err);
    return toBuffer(
      await sticker5(mediaBuffer, null, packname, author, ['✨'], {
        type: mode === 'crop' ? 'crop' : mode === 'circle' ? 'circle' : 'default',
        quality: isAnimated ? 80 : 100,
      }),
    );
  }
}

async function buildStampedWebp(mediaBuffer, effectiveMime, mediaObj, { mode, packname, author, emojis = ['✨'] }) {
  const resolvedMime =
    !effectiveMime || effectiveMime === 'application/octet-stream'
      ? inferMimeFromMagicBytes(mediaBuffer) || effectiveMime
      : effectiveMime;
  const isWebpInput = resolvedMime.includes('webp') || isValidWebp(mediaBuffer);
  const isImage = resolvedMime.startsWith('image/') || isWebpInput;
  const isVideo = resolvedMime.startsWith('video/');
  const isGif = resolvedMime === 'image/gif' || Boolean(mediaObj?.gifPlayback);
  const isAnimated = isVideo || isGif || (isWebpInput && isAnimatedWebp(mediaBuffer));

  if (!isImage && !isVideo && !isGif) {
    const unsupportedErr = new Error('UNSUPPORTED_VISUAL_FORMAT');
    unsupportedErr.code = 'UNSUPPORTED_VISUAL_FORMAT';
    throw unsupportedErr;
  }

  let webpBuffer;
  if (isWebpInput && mode === 'default') {
    webpBuffer = await addExif(mediaBuffer, packname, author, emojis);
  } else {
    const rawWebp = await convertToWebp(mediaBuffer, {
      isAnimated,
      mode,
      packname,
      author,
    });
    webpBuffer = await addExif(rawWebp, packname, author, emojis);
  }

  return {
    webpBuffer,
    isAnimated: isAnimatedWebp(webpBuffer),
    isWebpInput,
    isVideo,
    isGif,
  };
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  pruneAudioSessions();

  const cmd = String(command || '').toLowerCase();
  const quoted = m?.quoted || m;
  const media = getMediaMessage(quoted);
  const mime = String(media.mimetype || '').toLowerCase();

  // ── Modo .toaud / .tomp3 (sticker con audio o video → MP3) ──
  if (cmd === 'toaud' || cmd === 'tomp3') {
    const targetInfo = inspectTarget(quoted);
    if (!targetInfo.hasMedia) {
      return m.reply(
        `✖ Responde a un *sticker con audio* o *video* con *${usedPrefix + cmd}* para extraer su sonido.`,
      );
    }

    try {
      let sourceBuffer = null;
      if (targetInfo.isSticker) {
        const stickerAudio = await downloadStickerAudio(quoted);
        if (!stickerAudio?.buffer?.length) {
          return m.reply('✖ Ese sticker no contiene audio integrado.');
        }
        sourceBuffer = stickerAudio.buffer;
      } else if (targetInfo.isVideo || targetInfo.isAudio) {
        sourceBuffer = toBuffer(await quoted.download());
      } else {
        return m.reply(
          `✖ Responde a un *sticker con audio* o *video* con *${usedPrefix + cmd}*.`,
        );
      }

      const mp3 = await extractAudioToMp3(sourceBuffer);
      await conn.sendMessage(
        m.chat,
        { audio: mp3.buffer, mimetype: mp3.mimetype, ptt: false },
        { quoted: m },
      );
    } catch (error) {
      if (error?.code === 'NO_AUDIO_STREAM') {
        return m.reply('❌ El archivo citado no contiene pista de audio.');
      }
      console.error(`[${cmd}] Error:`, error?.message || error);
      return m.reply('❌ No se pudo extraer el audio.');
    }
    return;
  }

  // ── Modo .toimg / .tovid (sticker → PNG o MP4 con sonido si aplica) ──
  if (cmd === 'toimg' || cmd === 'tovid') {
    if (!mime.includes('webp') && quoted?.mtype !== 'stickerMessage') {
      return m.reply(`✖ Responde a un *sticker* con *${usedPrefix + cmd}* para convertirlo.`);
    }

    try {
      const webpBuf = toBuffer(await quoted.download());
      const stickerAudio =
        cmd === 'tovid' ? await downloadStickerAudio(quoted).catch(() => null) : null;
      const out = await stickerToMedia(webpBuf, {
        forceVideo: cmd === 'tovid',
        audioBuffer: stickerAudio?.buffer || null,
      });

      if (out.kind === 'video') {
        await conn.sendMessage(
          m.chat,
          { video: out.buffer, mimetype: 'video/mp4' },
          { quoted: m },
        );
      } else {
        await conn.sendMessage(
          m.chat,
          { image: out.buffer, mimetype: 'image/png' },
          { quoted: m },
        );
      }
    } catch (error) {
      console.error(`[${cmd}] Error:`, error?.message || error);
      return m.reply('❌ No se pudo convertir el sticker.');
    }
    return;
  }

  // ── Modo .wm / .take / .robar (cambiar pack/autor conservando audio si existe) ─
  if (cmd === 'wm' || cmd === 'take' || cmd === 'robar') {
    if (!mime.includes('webp') && quoted?.mtype !== 'stickerMessage') {
      return m.reply(
        `✖ Responde a un *sticker* con *${usedPrefix + cmd} [pack | autor]* para cambiar su marca de agua.`,
      );
    }

    try {
      const { muteAudio, remaining: wmText } = parseModeAndText(cmd, text);
      const webpBuf = toBuffer(await quoted.download());
      if (!isValidWebp(webpBuf)) {
        return m.reply('❌ El mensaje citado no es un sticker WebP válido.');
      }

      const existingAudio = muteAudio ? null : getStickerAudioDescriptor(quoted);
      const { packname, author } = await buildMetadata(m, conn, wmText);
      const stamped = await addExif(
        webpBuf,
        packname,
        author,
        existingAudio ? ['🔊'] : ['✨'],
      );

      if (existingAudio) {
        try {
          await sendAudioSticker(
            conn,
            m.chat,
            stamped,
            { audioMessage: existingAudio },
            { quoted: m, isAnimated: isAnimatedWebp(stamped) },
          );
          return;
        } catch {
          const downloadedAudio = await downloadStickerAudio(quoted).catch(() => null);
          if (downloadedAudio?.buffer?.length) {
            await sendAudioSticker(
              conn,
              m.chat,
              stamped,
              { buffer: downloadedAudio.buffer, mimetype: downloadedAudio.mimetype },
              { quoted: m, isAnimated: isAnimatedWebp(stamped) },
            );
            return;
          }
        }
      }

      await conn.sendMessage(
        m.chat,
        { sticker: stamped, isAnimated: isAnimatedWebp(stamped) },
        { quoted: m },
      );
    } catch (error) {
      console.error(`[${cmd}] Error:`, error?.message || error);
      return m.reply('❌ No se pudo actualizar el pack/autor del sticker.');
    }
    return;
  }

  // ── Modo creación de sticker (.s, .saudio, .scrop, .scircle, etc.) ───
  const { mode, withAudio, muteAudio, remaining } = parseModeAndText(cmd, text);
  const sessionKey = `${m.chat}_${m.sender}`;

  if (/^(cancel|cancelar|stop|salir)$/i.test(remaining)) {
    if (audioStickerSessions.delete(sessionKey)) {
      return m.reply('✅ Sesión pendiente de sticker con audio cancelada.');
    }
    return m.reply('ℹ️ No tienes ninguna sesión pendiente de sticker con audio.');
  }

  if (/^(list|lista|help|ayuda)$/i.test(remaining)) {
    return m.reply(
      `✦ *Stickers & Stickers con Audio* ✦\n\n` +
        `▸ *Sticker (con o sin audio):* ${usedPrefix}s [pack | autor]\n` +
        `▸ *Solo modo audio 2 pasos:* ${usedPrefix}saudio [pack | autor]\n` +
        `▸ *Silenciar video:* ${usedPrefix}s -mute [pack | autor]\n` +
        `▸ *Cuadrado (1:1):* ${usedPrefix}scrop [pack | autor]\n` +
        `▸ *Circular:* ${usedPrefix}scircle [pack | autor]\n` +
        `▸ *Cambiar WM:* ${usedPrefix}wm [pack | autor]\n` +
        `▸ *Convertir:* ${usedPrefix}toimg • ${usedPrefix}tovid • ${usedPrefix}toaud\n\n` +
        `*Stickers con audio usando ${usedPrefix}s:*\n` +
        `1️⃣ *Desde video:* Envía o responde a un video con *${usedPrefix}s* (incluye hasta ${MAX_ANIMATED_AUDIO_SECONDS}s de su audio automáticamente).\n` +
        `2️⃣ *Imagen + audio en 1 paso:* Cita un audio/nota de voz adjuntando una imagen o video con *${usedPrefix}s*.\n` +
        `3️⃣ *Audio + sticker en 2 pasos:* Responde primero al audio/nota de voz con *${usedPrefix}s* y luego al sticker/imagen con *${usedPrefix}s*.`,
    );
  }

  const selfInfo = inspectTarget(m);
  const quotedInfo = m?.quoted ? inspectTarget(m.quoted) : { hasMedia: false };
  const pendingSession = audioStickerSessions.get(sessionKey) || null;

  // Caso 1 paso: el usuario adjunta imagen/video en `m` mientras cita un audio/nota de voz en `m.quoted`
  // o adjunta imagen estática mientras cita un video con sonido.
  const dualVisualWithQuotedAudio =
    selfInfo.isVisual &&
    (quotedInfo.isAudio || (!selfInfo.isVideo && quotedInfo.isVideo));

  let visualTarget = null;
  let visualInfo = null;
  let audioTarget = null;
  let wantsAudio = (withAudio || Boolean(pendingSession?.audioBuffer)) && !muteAudio;

  if (dualVisualWithQuotedAudio && !muteAudio) {
    visualTarget = m;
    visualInfo = selfInfo;
    audioTarget = m.quoted;
    wantsAudio = true;
  } else {
    const activeTarget = selfInfo.hasMedia ? m : m?.quoted || null;
    const activeInfo = selfInfo.hasMedia ? selfInfo : quotedInfo;

    if (activeInfo.isVisual) {
      // Si ya había un sticker esperando audio y el usuario responde a un video con .s o .saudio,
      // usamos el audio de ese video sobre el sticker guardado.
      if (!muteAudio && pendingSession?.webpBuffer && !pendingSession.audioBuffer && activeInfo.isVideo) {
        audioTarget = activeTarget;
        wantsAudio = true;
      } else {
        visualTarget = activeTarget;
        visualInfo = activeInfo;
      }
    } else if (activeInfo.isAudio) {
      audioTarget = activeTarget;
      if (!muteAudio) wantsAudio = true;
    }
  }

  const urlMatch = remaining.match(URL_REGEX);
  const rawUrl = urlMatch ? urlMatch[0].replace(/[),.!?;:'"\]}>]+$/g, '') : null;
  const metaText = rawUrl ? remaining.replace(urlMatch[0], '').trim() : remaining;

  let downloadedUrlMedia = null;
  if (rawUrl && (!visualTarget || (!muteAudio && !audioTarget))) {
    try {
      downloadedUrlMedia = await downloadFromUrl(rawUrl);
    } catch (error) {
      console.error('[sticker] Error al descargar URL:', error?.message || error);
      return m.reply(`❌ No se pudo descargar el enlace.\n\`${error?.message || error}\``);
    }
  }

  const urlIsAudio =
    Boolean(downloadedUrlMedia) &&
    (downloadedUrlMedia.mime.startsWith('audio/') || downloadedUrlMedia.mime.includes('ogg'));
  if (!muteAudio && urlIsAudio) {
    wantsAudio = true;
  }

  // ── Emparejamiento en 2 pasos (funciona tanto con .s como con .saudio) ──
  if (wantsAudio) {
    const hasIncomingAudioOnly =
      !visualTarget &&
      (!downloadedUrlMedia || urlIsAudio) &&
      (Boolean(audioTarget) || urlIsAudio);

    if (hasIncomingAudioOnly && !pendingSession?.webpBuffer) {
      let rawAudioBuf;
      try {
        rawAudioBuf = audioTarget
          ? toBuffer(await audioTarget.download())
          : downloadedUrlMedia.buffer;
      } catch (error) {
        return m.reply(`❌ No se pudo descargar el audio.\n\`${error?.message || error}\``);
      }
      if (!rawAudioBuf?.length) return m.reply('❌ El audio está vacío.');
      if (rawAudioBuf.length > MAX_INPUT_BYTES) {
        return m.reply('❌ El audio supera el límite máximo de 60 MB.');
      }

      audioStickerSessions.set(sessionKey, {
        webpBuffer: null,
        isAnimated: false,
        audioBuffer: rawAudioBuf,
        rawMeta: metaText,
        mode,
        createdAt: Date.now(),
      });

      return m.reply(
        `🎵 *Paso 1/2 listo:* Audio guardado.\n` +
          `👉 Responde o envía ahora un *sticker, imagen o video* con *${usedPrefix + cmd}* para crear el sticker con sonido.\n` +
          `_(Expira en 2 min • *${usedPrefix + cmd} cancelar* para anular)_`,
      );
    }

    // Si había un sticker guardado en sesión y ahora llega el audio/video:
    if (pendingSession?.webpBuffer && (audioTarget || urlIsAudio)) {
      audioStickerSessions.delete(sessionKey);
      let rawAudioBuf;
      try {
        rawAudioBuf = audioTarget
          ? toBuffer(await audioTarget.download())
          : downloadedUrlMedia.buffer;
      } catch (error) {
        return m.reply(`❌ No se pudo descargar el audio.\n\`${error?.message || error}\``);
      }

      try {
        const effectiveMeta = metaText || pendingSession.rawMeta;
        const { packname, author } = await buildMetadata(m, conn, effectiveMeta);
        const finalWebp = await addExif(pendingSession.webpBuffer, packname, author, ['🔊']);
        const encodedAudio = await prepareStickerAudio(rawAudioBuf, {
          isAnimated: pendingSession.isAnimated,
        });
        await sendAudioSticker(conn, m.chat, finalWebp, encodedAudio, {
          quoted: m,
          isAnimated: pendingSession.isAnimated,
        });
      } catch (error) {
        if (error?.code === 'NO_AUDIO_STREAM') {
          return m.reply('❌ El archivo citado no contiene pista de audio.');
        }
        console.error('[saudio] Error al completar sesión:', error?.stack || error);
        return m.reply('❌ No se pudo generar el sticker con audio.');
      }
      return;
    }
  }

  if (!visualTarget && !downloadedUrlMedia) {
    if (audioTarget) {
      return m.reply(
        `✖ El audio está silenciado con *-mute*. Quita *-mute* y usa *${usedPrefix + cmd}* para crear un sticker con ese audio.`,
      );
    }
    return m.reply(
      wantsAudio
        ? `✖ Adjunta o responde a un *video*, *sticker/imagen* o *audio* con *${usedPrefix + cmd}*.\nUsa *${usedPrefix + cmd} help* para ver ejemplos.`
        : `✖ *Error:* Adjunta o cita una imagen, video, GIF o audio con *${usedPrefix + cmd}*.`,
    );
  }

  // ── Descargar recurso visual ──────────────────────────────────
  let mediaBuffer;
  let effectiveMime = '';
  let effectiveMediaObj = {};

  try {
    if (visualTarget) {
      mediaBuffer = toBuffer(await visualTarget.download());
      effectiveMime = visualInfo.mime;
      effectiveMediaObj = visualInfo.media || {};
    } else if (downloadedUrlMedia) {
      mediaBuffer = downloadedUrlMedia.buffer;
      effectiveMime = downloadedUrlMedia.mime;
    }
  } catch (error) {
    console.error('[sticker] Error al descargar:', error?.message || error);
    return m.reply(`❌ No se pudo descargar el archivo.\n\`${error?.message || error}\``);
  }

  if (!mediaBuffer?.length) return m.reply('❌ El archivo está vacío.');
  if (mediaBuffer.length > MAX_INPUT_BYTES) {
    return m.reply('❌ El archivo supera el límite máximo de 60 MB.');
  }

  const effectiveMode = mode !== 'default' ? mode : pendingSession?.mode || 'default';
  const effectiveMeta = metaText || pendingSession?.rawMeta || '';
  const { packname, author } = await buildMetadata(m, conn, effectiveMeta);

  const autoVideoAudio =
    !muteAudio &&
    !wantsAudio &&
    effectiveMime.startsWith('video/') &&
    !effectiveMediaObj?.gifPlayback &&
    typeof conn?.waUploadToServer === 'function' &&
    typeof conn?.relayMessage === 'function';

  let built;
  try {
    built = await buildStampedWebp(mediaBuffer, effectiveMime, effectiveMediaObj, {
      mode: effectiveMode,
      packname,
      author,
      emojis: wantsAudio || autoVideoAudio ? ['🔊'] : ['✨'],
    });
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_VISUAL_FORMAT') {
      return m.reply('❌ Formato no soportado. Usa una imagen, video, GIF o sticker.');
    }
    console.error('[sticker] Error en conversión:', error?.stack || error);
    return m.reply('❌ No se pudo convertir el archivo a sticker. Verifica que FFmpeg esté disponible.');
  }

  const { webpBuffer, isAnimated, isWebpInput, isVideo, isGif } = built;
  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
    return m.reply('❌ La conversión no produjo un sticker válido.');
  }

  // ── Envío de Sticker CON Audio explícito o emparejado ─────────
  if (wantsAudio) {
    let rawAudioBuffer = null;

    if (audioTarget) {
      try {
        rawAudioBuffer = toBuffer(await audioTarget.download());
      } catch (error) {
        return m.reply(`❌ No se pudo descargar el audio citado.\n\`${error?.message || error}\``);
      }
    } else if (visualTarget && urlIsAudio) {
      rawAudioBuffer = downloadedUrlMedia.buffer;
    } else if (pendingSession?.audioBuffer) {
      rawAudioBuffer = pendingSession.audioBuffer;
      audioStickerSessions.delete(sessionKey);
    } else if (isVideo) {
      rawAudioBuffer = mediaBuffer;
    } else if (visualTarget && getStickerAudioDescriptor(visualTarget)) {
      const preserved = getStickerAudioDescriptor(visualTarget);
      try {
        await sendAudioSticker(
          conn,
          m.chat,
          webpBuffer,
          { audioMessage: preserved },
          { quoted: m, isAnimated },
        );
        return;
      } catch {
        const dl = await downloadStickerAudio(visualTarget).catch(() => null);
        if (dl?.buffer?.length) rawAudioBuffer = dl.buffer;
      }
    }

    // Si se usó .saudio / -audio sobre imagen/sticker estático sin fuente de audio todavía → guardar Paso 1/2
    if (!rawAudioBuffer) {
      audioStickerSessions.set(sessionKey, {
        webpBuffer,
        isAnimated,
        audioBuffer: null,
        rawMeta: effectiveMeta,
        mode: effectiveMode,
        createdAt: Date.now(),
      });

      const maxSec = isAnimated ? MAX_ANIMATED_AUDIO_SECONDS : MAX_STATIC_AUDIO_SECONDS;
      return m.reply(
        `🔊 *Paso 1/2 listo:* Sticker preparado.\n` +
          `👉 Responde ahora a un *audio, nota de voz o video* (máx. ${maxSec}s) con *${usedPrefix + cmd}* para añadirle el sonido.\n` +
          `_(Expira en 2 min • *${usedPrefix + cmd} cancelar* para anular)_`,
      );
    }

    try {
      const encodedAudio = await prepareStickerAudio(rawAudioBuffer, { isAnimated });
      await sendAudioSticker(conn, m.chat, webpBuffer, encodedAudio, {
        quoted: m,
        isAnimated,
      });
    } catch (error) {
      if (error?.code === 'NO_AUDIO_STREAM') {
        return m.reply(
          `❌ El video no tiene pista de audio. Cita un audio/nota de voz o usa otro video con sonido.`,
        );
      }
      console.error('[saudio] Error al enviar sticker con audio:', error?.stack || error);
      return m.reply('❌ No se pudo crear o enviar el sticker con audio.');
    }
    return;
  }

  // ── Sticker con .s normal sobre un video: incluye su audio automáticamente (y cae a mudo si no tiene pista) ─
  if (!muteAudio && isVideo && !isGif && typeof conn?.waUploadToServer === 'function' && typeof conn?.relayMessage === 'function') {
    try {
      const encodedAudio = await prepareStickerAudio(mediaBuffer, { isAnimated: true });
      await sendAudioSticker(conn, m.chat, webpBuffer, encodedAudio, {
        quoted: m,
        isAnimated: true,
      });
      return;
    } catch (error) {
      if (error?.code !== 'NO_AUDIO_STREAM') {
        console.warn('[sticker] Falló envío con audio en video (.s), enviando sticker animado normal:', error?.message || error);
      }
    }
  }

  // ── Sticker con .s / .scrop / .scircle sobre un sticker que YA tenía audio: conservarlo salvo `-mute` ─
  if (!muteAudio && isWebpInput && visualTarget) {
    const existingAudio = getStickerAudioDescriptor(visualTarget);
    if (existingAudio) {
      try {
        await sendAudioSticker(
          conn,
          m.chat,
          webpBuffer,
          { audioMessage: existingAudio },
          { quoted: m, isAnimated },
        );
        return;
      } catch {}
    }
  }

  try {
    await conn.sendMessage(m.chat, { sticker: webpBuffer, isAnimated }, { quoted: m });
  } catch (error) {
    console.error('[sticker] Error al enviar:', error?.message || error);
    return m.reply('❌ El sticker se generó, pero no se pudo enviar.');
  }
};

handler.help = [
  's [pack | autor]',
  'saudio [pack | autor]',
  'scrop [pack | autor]',
  'scircle [pack | autor]',
  'wm [pack | autor]',
  'toimg',
  'tovid',
  'toaud',
];
handler.tags = ['tools'];
handler.command = STICKER_COMMANDS;

export default handler;
