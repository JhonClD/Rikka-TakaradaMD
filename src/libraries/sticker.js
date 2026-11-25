import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  downloadContentFromMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
} from 'baileys';
import webp from 'node-webpmux';

const execFileAsync = promisify(execFile);

const MAX_ANIMATED_WEBP_BYTES = 1024 * 1024; // Límite final con Baileys: 1 MB (1.8 y 2 MB no pasaron; WhatsApp oficial pide ~500 KB)
const MAX_STATIC_WEBP_BYTES = 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const MAX_STATIC_AUDIO_SECONDS = 60;
const MAX_ANIMATED_AUDIO_SECONDS = 60;
const STICKER_AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';
const FFMPEG_TIMEOUT_MS = 90_000;

let resolvedFfmpegBin = null;
async function getFfmpegBin() {
  if (resolvedFfmpegBin) return resolvedFfmpegBin;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
    resolvedFfmpegBin = 'ffmpeg';
    return resolvedFfmpegBin;
  } catch {}

  try {
    const mod = await import('ffmpeg-static');
    if (mod?.default) {
      resolvedFfmpegBin = mod.default;
      return resolvedFfmpegBin;
    }
  } catch {}

  resolvedFfmpegBin = 'ffmpeg';
  return resolvedFfmpegBin;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === 'string') {
    if (fs.existsSync(input)) return fs.readFileSync(input);
    return Buffer.from(input);
  }
  if (input && typeof input === 'object' && input.data) return toBuffer(input.data);
  throw new TypeError(`No se puede convertir a Buffer: ${typeof input}`);
}

function isValidWebp(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function isAnimatedWebp(buffer) {
  if (!isValidWebp(buffer)) return false;
  // Los WebP animados contienen chunks 'ANIM' o 'ANMF'
  return buffer.includes(Buffer.from('ANIM')) || buffer.includes(Buffer.from('ANMF'));
}

function uniqueTmpPath(prefix, ext) {
  const id = `${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  return path.join(os.tmpdir(), `${prefix}_${id}.${ext}`);
}

async function cleanUp(...files) {
  for (const file of files) {
    if (!file) continue;
    await fs.promises.unlink(file).catch(() => {});
  }
}

function buildVideoFilter(size, mode, fps = null) {
  const filters = [];
  if (fps) filters.push(`fps=${fps}`);

  if (mode === 'crop') {
    filters.push(
      `scale=${size}:${size}:flags=lanczos:force_original_aspect_ratio=increase`,
      `crop=${size}:${size}`,
      'format=rgba',
    );
  } else if (mode === 'circle') {
    filters.push(
      `scale=${size}:${size}:flags=lanczos:force_original_aspect_ratio=increase`,
      `crop=${size}:${size}`,
      'format=rgba',
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-W/2,2)+pow(Y-H/2,2),pow(min(W,H)/2-1,2)),alpha(X,Y),0)'`,
    );
  } else {
    filters.push(
      `scale=${size}:${size}:flags=lanczos:force_original_aspect_ratio=decrease`,
      'format=rgba',
      `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
    );
  }

  filters.push('setsar=1');
  if (fps) filters.push('format=yuva420p');
  return filters.join(',');
}

async function runFfmpegConvert(inputPath, outputPath, args) {
  const bin = await getFfmpegBin();
  await execFileAsync(bin, ['-y', '-i', inputPath, ...args, outputPath], {
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return fs.promises.readFile(outputPath);
}

function parseDurationText(text) {
  const match = String(text || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Detecta la duración real del video/GIF en segundos.
 * Usa ffprobe si está disponible, si no, lee la línea `Duration:` de ffmpeg.
 * Devuelve null si no se puede detectar.
 */
async function getMediaDurationSeconds(inputPath) {
  try {
    const res = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath],
      { timeout: 10_000 },
    );
    const seconds = Number(String(res?.stdout || '').trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  } catch {}

  try {
    const bin = await getFfmpegBin();
    await execFileAsync(bin, ['-i', inputPath], { timeout: 10_000 });
  } catch (err) {
    return parseDurationText(err?.stderr || err?.stdout || '');
  }
  return null;
}

/**
 * Elige los presets según la duración detectada, un nivel por cada 10s:
 * cada 10 segundos extra baja un escalón de calidad, para no bajarle la
 * calidad a los videos cortos por culpa de los largos:
 * - 0-10s: 320px, 15 fps, q70
 * - 10-20s: 320px, 12 fps, q52
 * - 20-30s: 256px, 10 fps, q40
 * - 30-40s: 224px, 8 fps, q30
 * - 40-50s: 192px, 7 fps, q24
 * - 50-60s: 160px, 6 fps, q20
 * Dentro de cada nivel se sigue probando de mayor a menor calidad hasta
 * entrar en 1 MB (límite con Baileys).
 */
function pickAnimatedPresets(durationSec) {
  const levels = [
    { size: 320, fps: 15, q: 70 },
    { size: 320, fps: 12, q: 52 },
    { size: 256, fps: 10, q: 40 },
    { size: 224, fps: 8, q: 30 },
    { size: 192, fps: 7, q: 24 },
    { size: 160, fps: 6, q: 20 },
    { size: 128, fps: 5, q: 18 },
  ];
  // Un escalón por cada 10s: 0-10s empieza en el nivel 0, 10-20s en el 1, etc.
  const start = Math.min(levels.length - 2, Math.max(0, Math.ceil(durationSec / 10) - 1));
  return levels.slice(start).map((level) => ({ ...level, dur: durationSec }));
}

/**
 * Convierte imagen, GIF o video a WebP optimizado para WhatsApp.
 * - Estático: 512x512 WebP de alta nitidez (soporta modos: default, crop, circle).
 * - Animado: detecta la duración (máx 60s) y varía calidad/fps un nivel
 *   por cada 10s, para no superar 1 MB sin castigar
 *   a los videos cortos.
 */
async function createSticker(mediaBuffer, { isAnimated = false, mode = 'default', maxSeconds = MAX_VIDEO_SECONDS } = {}) {
  const input = toBuffer(mediaBuffer);
  if (!input.length) throw new Error('Buffer de entrada vacío');

  const tmpIn = uniqueTmpPath('stk_in', 'bin');
  const tmpOut = uniqueTmpPath('stk_out', 'webp');

  try {
    await fs.promises.writeFile(tmpIn, input);

    if (!isAnimated) {
      const presets = [
        { size: 512, q: 88 },
        { size: 512, q: 70 },
        { size: 384, q: 55 },
      ];

      let best = null;
      for (const preset of presets) {
        const vf = buildVideoFilter(preset.size, mode, null);
        const out = await runFfmpegConvert(tmpIn, tmpOut, [
          '-vframes', '1',
          '-vcodec', 'libwebp',
          '-lossless', '0',
          '-compression_level', '6',
          '-q:v', String(preset.q),
          '-vf', vf,
        ]);
        if (!isValidWebp(out)) continue;
        best = out;
        if (out.length <= MAX_STATIC_WEBP_BYTES) return out;
      }
      if (best) return best;
      throw new Error('FFmpeg no produjo un WebP estático válido');
    }

    // Stickers animados: se detecta la duración y la calidad varía según dure,
    // manteniendo la duración completa bajo 1 MB
    const detectedSeconds = await getMediaDurationSeconds(tmpIn).catch(() => null);
    const effectiveSeconds = Math.min(maxSeconds, detectedSeconds || maxSeconds);
    const animatedPresets = pickAnimatedPresets(effectiveSeconds);

    let smallest = null;
    for (const preset of animatedPresets) {
      const vf = buildVideoFilter(preset.size, mode, preset.fps);
      const out = await runFfmpegConvert(tmpIn, tmpOut, [
        '-t', String(preset.dur),
        '-an',
        '-vcodec', 'libwebp',
        '-loop', '0',
        '-preset', 'default',
        '-compression_level', '4',
        '-q:v', String(preset.q),
        '-vf', vf,
      ]);
      if (!isValidWebp(out)) continue;
      if (!smallest || out.length < smallest.length) smallest = out;
      if (out.length <= MAX_ANIMATED_WEBP_BYTES) return out;
    }

    if (smallest) return smallest;
    throw new Error('FFmpeg no produjo un WebP animado válido');
  } finally {
    await cleanUp(tmpIn, tmpOut);
  }
}

function isValidOgg(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === 'OggS'
  );
}

function parseFfmpegDurationSeconds(stderrText) {
  const matches = [...String(stderrText || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const hours = Number(last[1]);
  const minutes = Number(last[2]);
  const seconds = Number(last[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function isNoAudioStreamError(err) {
  const text = `${err?.stderr || ''} ${err?.message || ''}`;
  return /does not contain any stream|matches no streams|Audio:\s*none/i.test(text);
}

/**
 * Extrae y codifica audio en contenedor OGG Opus (`audio/ogg; codecs=opus`)
 * compatible con la validación Kaleidoscope de WhatsApp para stickers con sonido.
 */
async function prepareStickerAudio(
  mediaBuffer,
  { isAnimated = false, maxSeconds = null } = {},
) {
  const input = toBuffer(mediaBuffer);
  if (!input.length) throw new Error('Buffer de audio vacío');

  const limitSeconds =
    Number.isFinite(maxSeconds) && maxSeconds > 0
      ? maxSeconds
      : isAnimated
        ? MAX_ANIMATED_AUDIO_SECONDS
        : MAX_STATIC_AUDIO_SECONDS;

  const tmpIn = uniqueTmpPath('stk_aud_in', 'bin');
  const tmpOut = uniqueTmpPath('stk_aud_out', 'ogg');

  try {
    await fs.promises.writeFile(tmpIn, input);
    const bin = await getFfmpegBin();
    let stderr = '';
    try {
      const res = await execFileAsync(
        bin,
        [
          '-y',
          '-i', tmpIn,
          '-vn',
          '-t', String(limitSeconds),
          '-f', 'ogg',
          '-c:a', 'libopus',
          '-b:a', '48k',
          '-vbr', 'on',
          '-ar', '48000',
          '-ac', '1',
          '-compression_level', '10',
          '-application', 'audio',
          tmpOut,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      stderr = res?.stderr || '';
    } catch (err) {
      if (isNoAudioStreamError(err)) {
        const noAudioErr = new Error('El archivo no contiene pista de audio');
        noAudioErr.code = 'NO_AUDIO_STREAM';
        throw noAudioErr;
      }
      throw err;
    }

    const out = await fs.promises.readFile(tmpOut);
    if (!isValidOgg(out)) {
      throw new Error('FFmpeg no produjo un audio OGG Opus válido');
    }

    const parsedSec = parseFfmpegDurationSeconds(stderr);
    const seconds = Math.max(1, Math.min(limitSeconds, Math.ceil(parsedSec || 1)));
    return {
      buffer: out,
      mimetype: STICKER_AUDIO_MIMETYPE,
      seconds,
    };
  } finally {
    await cleanUp(tmpIn, tmpOut);
  }
}

/**
 * Convierte el audio de un sticker con sonido o video a MP3 (`audio/mpeg`).
 */
async function extractAudioToMp3(mediaBuffer, { maxSeconds = 60 } = {}) {
  const input = toBuffer(mediaBuffer);
  if (!input.length) throw new Error('Buffer de entrada vacío');

  const tmpIn = uniqueTmpPath('stk_mp3_in', 'bin');
  const tmpOut = uniqueTmpPath('stk_mp3_out', 'mp3');

  try {
    await fs.promises.writeFile(tmpIn, input);
    const bin = await getFfmpegBin();
    try {
      await execFileAsync(
        bin,
        [
          '-y',
          '-i', tmpIn,
          '-vn',
          '-t', String(maxSeconds),
          '-c:a', 'libmp3lame',
          '-b:a', '128k',
          '-ar', '44100',
          tmpOut,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (err) {
      if (isNoAudioStreamError(err)) {
        const noAudioErr = new Error('El archivo no contiene pista de audio');
        noAudioErr.code = 'NO_AUDIO_STREAM';
        throw noAudioErr;
      }
      throw err;
    }

    const mp3 = await fs.promises.readFile(tmpOut);
    if (!mp3.length) throw new Error('FFmpeg no produjo un MP3 válido');
    return { buffer: mp3, mimetype: 'audio/mpeg' };
  } finally {
    await cleanUp(tmpIn, tmpOut);
  }
}

function normalizeBytesField(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return Buffer.from(keys.sort((a, b) => Number(a) - Number(b)).map((k) => value[k]));
    }
  }
  return null;
}

/**
 * Obtiene y normaliza el descriptor `AudioMessage` incrustado en un sticker con audio.
 */
function getStickerAudioDescriptor(target) {
  const raw =
    target?.mediaMessage?.stickerMessage?.audioMessage ||
    target?.msg?.audioMessage ||
    (target?.mtype === 'stickerMessage' ? target?.audioMessage : null) ||
    null;

  if (!raw || typeof raw !== 'object') return null;

  const mediaKey = normalizeBytesField(raw.mediaKey);
  const fileSha256 = normalizeBytesField(raw.fileSha256);
  const fileEncSha256 = normalizeBytesField(raw.fileEncSha256);
  const directPath = typeof raw.directPath === 'string' && raw.directPath ? raw.directPath : undefined;
  const url = typeof raw.url === 'string' && raw.url ? raw.url : undefined;

  if (!mediaKey || mediaKey.length !== 32 || (!directPath && !url)) {
    return null;
  }

  return proto.Message.AudioMessage.fromObject({
    ...raw,
    url,
    directPath,
    mediaKey,
    ...(fileSha256 ? { fileSha256 } : {}),
    ...(fileEncSha256 ? { fileEncSha256 } : {}),
    mimetype: raw.mimetype || STICKER_AUDIO_MIMETYPE,
  });
}

/**
 * Descarga el audio incrustado de un sticker con sonido, o devuelve `null` si no tiene.
 */
async function downloadStickerAudio(target) {
  const audioMessage = getStickerAudioDescriptor(target);
  if (!audioMessage) return null;

  const stream = await downloadContentFromMessage(audioMessage, 'audio');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return null;

  return {
    buffer,
    audioMessage,
    mimetype: audioMessage.mimetype || STICKER_AUDIO_MIMETYPE,
  };
}

/**
 * Envía un sticker con sonido usando el sobre oficial `audioStickerMessage` de WhatsApp.
 */
async function sendAudioSticker(
  conn,
  jid,
  webpBuffer,
  audioSource,
  { quoted = null, isAnimated = null } = {},
) {
  const stickerBuf = toBuffer(webpBuffer);
  if (!isValidWebp(stickerBuf)) {
    throw new Error('sendAudioSticker: webpBuffer no es un WebP válido');
  }

  const animated = isAnimated ?? isAnimatedWebp(stickerBuf);

  let audioMessage = audioSource?.audioMessage
    ? getStickerAudioDescriptor({ audioMessage: audioSource.audioMessage, mtype: 'stickerMessage' })
    : null;

  const [stickerMedia, uploadedAudio] = await Promise.all([
    prepareWAMessageMedia(
      { sticker: stickerBuf, isAnimated: animated },
      { upload: conn.waUploadToServer },
    ),
    audioMessage
      ? Promise.resolve(null)
      : prepareWAMessageMedia(
          {
            audio: toBuffer(audioSource?.buffer ?? audioSource),
            mimetype: audioSource?.mimetype || STICKER_AUDIO_MIMETYPE,
            ptt: false,
            ...(audioSource?.seconds ? { seconds: audioSource.seconds } : {}),
          },
          { upload: conn.waUploadToServer },
        ),
  ]);

  if (!stickerMedia?.stickerMessage) {
    throw new Error('No se pudo subir el sticker a WhatsApp');
  }

  if (!audioMessage) {
    audioMessage = uploadedAudio?.audioMessage;
  }
  if (!audioMessage) {
    throw new Error('No se pudo preparar el audio del sticker en WhatsApp');
  }

  const stickerMessage = proto.Message.StickerMessage.fromObject({
    ...stickerMedia.stickerMessage,
    isAnimated: animated,
    stickerSentTs: Date.now(),
    emojis: stickerMedia.stickerMessage.emojis || '🔊',
    contextInfo: {
      ...(stickerMedia.stickerMessage.contextInfo || {}),
      experienceIds: [13007],
    },
    audioMessage,
  });

  const validQuoted = quoted?.key?.id && quoted?.message ? quoted : null;
  const prep = generateWAMessageFromContent(
    jid,
    { stickerMessage },
    {
      userJid: conn.user?.jid || conn.user?.id,
      ...(validQuoted ? { quoted: validQuoted } : {}),
    },
  );

  if (prep.message?.stickerMessage) {
    prep.message.stickerMessage.audioMessage = audioMessage;
    prep.message.stickerMessage.contextInfo = {
      ...(prep.message.stickerMessage.contextInfo || {}),
      experienceIds: [13007],
    };
  }
  prep.message.messageContextInfo = {
    ...(prep.message.messageContextInfo || {}),
    messageSecret: prep.message.messageContextInfo?.messageSecret || crypto.randomBytes(32),
  };

  const msgId = await conn.relayMessage(jid, prep.message, {
    messageId: prep.key.id,
  });

  try {
    const storedMsg = proto.WebMessageInfo.fromObject({
      ...prep,
      message: {
        audioStickerMessage: {
          message: {
            stickerMessage: prep.message.stickerMessage,
          },
        },
      },
    });
    conn.ev?.emit?.('messages.upsert', {
      messages: [storedMsg],
      type: 'append',
    });
  } catch {}

  return msgId;
}

/**
 * Convierte un sticker WebP a PNG (si es estático) o MP4 (si es animado o tiene `audioBuffer`).
 * FFmpeg no decodifica WebP animados (chunks ANIM/ANMF) de forma nativa, así que
 * para stickers animados primero extraemos los frames con `node-webpmux`.
 */
async function stickerToMedia(webpBuffer, { forceVideo = false, audioBuffer = null } = {}) {
  const input = toBuffer(webpBuffer);
  if (!isValidWebp(input)) throw new Error('El archivo no es un sticker WebP válido');

  const hasAudio = Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0;
  const animated = isAnimatedWebp(input);
  const bin = await getFfmpegBin();

  if (!animated) {
    const tmpIn = uniqueTmpPath('stk_rev_in', 'webp');
    const tmpAudio = hasAudio ? uniqueTmpPath('stk_rev_aud', 'ogg') : null;
    const outExt = forceVideo ? 'mp4' : 'png';
    const tmpOut = uniqueTmpPath('stk_rev_out', outExt);
    try {
      await fs.promises.writeFile(tmpIn, input);
      if (!forceVideo) {
        const png = await runFfmpegConvert(tmpIn, tmpOut, ['-vframes', '1']);
        return { kind: 'image', buffer: png, mimetype: 'image/png' };
      }

      if (tmpAudio) {
        await fs.promises.writeFile(tmpAudio, audioBuffer);
        await execFileAsync(
          bin,
          [
            '-y',
            '-loop', '1',
            '-i', tmpIn,
            '-i', tmpAudio,
            '-shortest',
            '-t', '15',
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-tune', 'stillimage',
            '-preset', 'fast',
            '-crf', '22',
            '-c:a', 'aac',
            '-b:a', '128k',
            tmpOut,
          ],
          { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        );
      } else {
        await execFileAsync(
          bin,
          [
            '-y',
            '-loop', '1',
            '-i', tmpIn,
            '-t', '2',
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '22',
            tmpOut,
          ],
          { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        );
      }
      const mp4 = await fs.promises.readFile(tmpOut);
      return { kind: 'video', buffer: mp4, mimetype: 'video/mp4' };
    } finally {
      await cleanUp(tmpIn, tmpAudio, tmpOut);
    }
  }

  // Sticker animado: demux de frames con node-webpmux → concat en FFmpeg → MP4
  const frameDir = path.join(
    os.tmpdir(),
    `stk_frames_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
  );
  const tmpAudio = hasAudio ? uniqueTmpPath('stk_rev_aud', 'ogg') : null;
  const tmpOut = uniqueTmpPath('stk_rev_out', 'mp4');

  try {
    await fs.promises.mkdir(frameDir, { recursive: true });
    const img = new webp.Image();
    await img.load(input);
    await img.demux({ path: frameDir, prefix: 'f_' });

    const files = (await fs.promises.readdir(frameDir))
      .filter((f) => f.endsWith('.webp'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!files.length) throw new Error('No se pudieron extraer frames del sticker animado');

    const canvasW = Math.max(2, Math.floor((img.width || 512) / 2) * 2);
    const canvasH = Math.max(2, Math.floor((img.height || 512) / 2) * 2);
    const frameMeta = Array.isArray(img.frames) ? img.frames : [];

    const concatLines = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(frameDir, files[i]).replace(/'/g, "'\\''");
      const delayMs = Number(frameMeta[i]?.delay);
      const durationSec = (Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 67) / 1000;
      concatLines.push(`file '${filePath}'`);
      concatLines.push(`duration ${durationSec.toFixed(4)}`);
    }
    // El demuxer concat requiere repetir la última entrada para respetar su duración
    const lastFilePath = path.join(frameDir, files[files.length - 1]).replace(/'/g, "'\\''");
    concatLines.push(`file '${lastFilePath}'`);

    const listPath = path.join(frameDir, 'list.txt');
    await fs.promises.writeFile(listPath, concatLines.join('\n'), 'utf8');

    const scalePad = `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:color=black`;
    if (tmpAudio) {
      await fs.promises.writeFile(tmpAudio, audioBuffer);
      await execFileAsync(
        bin,
        [
          '-y',
          '-stream_loop', '-1',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-i', tmpAudio,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest',
          '-t', '15',
          '-vsync', 'vfr',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', scalePad,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '22',
          '-c:a', 'aac',
          '-b:a', '128k',
          tmpOut,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    } else {
      await execFileAsync(
        bin,
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-vsync', 'vfr',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', scalePad,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '22',
          tmpOut,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    }

    const mp4 = await fs.promises.readFile(tmpOut);
    return { kind: 'video', buffer: mp4, mimetype: 'video/mp4' };
  } finally {
    await cleanUp(tmpAudio, tmpOut);
    await fs.promises.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function addExif(webpSticker, packname, author, categories = ['✨'], metadata = {}) {
  if (!webpSticker || !Buffer.isBuffer(webpSticker)) {
    throw new TypeError('addExif: webpSticker debe ser un Buffer');
  }

  const img = new webp.Image();
  const stickerPackId = `RIKKA${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  const jsonData = Object.fromEntries(
    Object.entries({
      'sticker-pack-id': metadata.packId ?? stickerPackId,
      'sticker-pack-name': packname || undefined,
      'sticker-pack-publisher': author || undefined,
      'android-app-store-link': metadata.androidAppStoreLink ?? undefined,
      'ios-app-store-link': metadata.iosAppStoreLink ?? undefined,
      'is-ai-sticker': metadata.isAiSticker ? 1 : undefined,
      'is-first-party-sticker': metadata.isFirstPartySticker ? 1 : undefined,
      'accessibility-text': metadata.accessibilityText ?? undefined,
      'avatar-sticker-template-id': metadata.templateId ?? undefined,
      'is-avatar-sticker': metadata.isAvatarSticker ? 1 : undefined,
      'sticker-maker-source-type': metadata.stickerMakerSourceType ?? undefined,
      emojis: categories?.length ? categories : undefined,
    }).filter(([, v]) => v !== undefined),
  );

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(jsonData), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);

  await img.load(webpSticker);
  img.exif = exif;
  return img.save(null);
}

// ─── Wrappers de compatibilidad ───────────────────────────────

async function fetchUrlBuffer(url) {
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sticker4(img, url) {
  const buf = url ? await fetchUrlBuffer(url) : toBuffer(img);
  return createSticker(buf, { isAnimated: false });
}

async function sticker5(img, url, packname, author, categories = ['✨'], extra = {}) {
  const { Sticker } = await import('wa-sticker-formatter');
  const metadata = { type: 'default', pack: packname, author, categories, ...extra };
  const buf = await new Sticker(img ?? url, metadata).toBuffer();
  return toBuffer(buf);
}

async function sticker6(img, url) {
  const buf = url ? await fetchUrlBuffer(url) : toBuffer(img);
  return createSticker(buf, { isAnimated: true });
}

async function sticker(img, url, packname = '', author = '', categories = ['✨'], extra = {}) {
  const buf = url ? await fetchUrlBuffer(url) : toBuffer(img);
  const raw = await createSticker(buf, { isAnimated: false });
  try {
    return await addExif(raw, packname, author, categories, extra);
  } catch {
    return raw;
  }
}

const support = {
  ffmpeg: true,
  ffprobe: true,
  ffmpegWebp: true,
};

global.support = support;

export {
  MAX_ANIMATED_AUDIO_SECONDS,
  MAX_STATIC_AUDIO_SECONDS,
  STICKER_AUDIO_MIMETYPE,
  addExif,
  createSticker,
  downloadStickerAudio,
  extractAudioToMp3,
  getStickerAudioDescriptor,
  isAnimatedWebp,
  isValidOgg,
  isValidWebp,
  prepareStickerAudio,
  sendAudioSticker,
  sticker,
  sticker4,
  sticker5,
  sticker6,
  stickerToMedia,
  support,
  toBuffer,
};
