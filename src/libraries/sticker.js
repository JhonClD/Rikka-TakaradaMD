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

const MAX_ANIMATED_WEBP_BYTES = 1020 * 1024; // ~1 MB límite en WhatsApp/Baileys dejando margen para EXIF
const MAX_STATIC_WEBP_BYTES = 1020 * 1024;
const MAX_VIDEO_SECONDS = 60;
const MAX_STATIC_AUDIO_SECONDS = 60;
const MAX_ANIMATED_AUDIO_SECONDS = 60;
const STICKER_AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';
const FFMPEG_TIMEOUT_MS = 180_000;
const SCALE_FLAGS = 'lanczos+accurate_rnd+full_chroma_int+full_chroma_inp';

let resolvedFfmpegBin = null;
let resolvedAnimWebpCodec = null;
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

async function getAnimatedWebpCodec() {
  if (resolvedAnimWebpCodec) return resolvedAnimWebpCodec;
  try {
    const bin = await getFfmpegBin();
    const { stdout = '' } = await execFileAsync(bin, ['-hide_banner', '-encoders'], {
      timeout: 5_000,
    });
    resolvedAnimWebpCodec = /\blibwebp_anim\b/.test(stdout) ? 'libwebp_anim' : 'libwebp';
  } catch {
    resolvedAnimWebpCodec = 'libwebp';
  }
  return resolvedAnimWebpCodec;
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

function buildVideoFilter(
  size,
  mode,
  { fps = null, pixelFormat = 'yuva420p', sharpen = 0.35, denoise = false } = {},
) {
  const filters = [];
  if (fps) filters.push(`fps=${fps}`);
  if (denoise) filters.push('hqdn3d=1.2:0.9:2.5:1.8');

  const sharpenFilter =
    sharpen > 0 ? `unsharp=3:3:${sharpen.toFixed(2)}:3:3:0.0` : null;

  if (mode === 'crop') {
    filters.push(
      `scale=${size}:${size}:flags=${SCALE_FLAGS}:force_original_aspect_ratio=increase`,
      `crop=${size}:${size}`,
    );
    if (sharpenFilter) filters.push(sharpenFilter);
    filters.push(`format=${pixelFormat}`);
  } else if (mode === 'circle') {
    filters.push(
      `scale=${size}:${size}:flags=${SCALE_FLAGS}:force_original_aspect_ratio=increase`,
      `crop=${size}:${size}`,
    );
    if (sharpenFilter) filters.push(sharpenFilter);
    filters.push(
      'format=rgba',
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(min(W,H)/2-hypot(X-W/2,Y-H/2),0,1)'`,
      `format=${pixelFormat}`,
    );
  } else {
    filters.push(
      `scale=${size}:${size}:flags=${SCALE_FLAGS}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    );
    if (sharpenFilter) filters.push(sharpenFilter);
    if (pixelFormat === 'yuva420p') {
      filters.push(
        'format=yuva420p',
        `pad=${size}:${size}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=black@0`,
      );
    } else {
      filters.push(
        `format=${pixelFormat}`,
        `pad=${size}:${size}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=#00000000`,
      );
    }
  }

  filters.push('setsar=1');
  return filters.join(',');
}

async function runFfmpegConvert(inputPath, outputPath, args, inputArgs = []) {
  const bin = await getFfmpegBin();
  await execFileAsync(bin, ['-y', ...inputArgs, '-i', inputPath, ...args, outputPath], {
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

function parseFpsFraction(rateText) {
  const parts = String(rateText || '').trim().split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
      return num / den;
    }
  }
  const direct = Number(rateText);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function parseFpsFromStderr(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*fps\b/i);
  if (!match) return null;
  const fps = Number(match[1]);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

async function getMediaVideoMeta(inputPath) {
  try {
    const res = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate,r_frame_rate:format=duration',
        '-of', 'json',
        inputPath,
      ],
      { timeout: 10_000 },
    );
    const parsed = JSON.parse(String(res?.stdout || '{}'));
    const durationSec = Number(parsed?.format?.duration);
    const stream = parsed?.streams?.[0] || {};
    const fps =
      parseFpsFraction(stream.avg_frame_rate) || parseFpsFraction(stream.r_frame_rate);
    if ((Number.isFinite(durationSec) && durationSec > 0) || fps) {
      return {
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
        fps: fps || null,
      };
    }
  } catch {}

  try {
    const bin = await getFfmpegBin();
    await execFileAsync(bin, ['-i', inputPath], { timeout: 10_000 });
  } catch (err) {
    const info = `${err?.stderr || ''}\n${err?.stdout || ''}`;
    return {
      durationSec: parseDurationText(info),
      fps: parseFpsFromStderr(info),
    };
  }
  return { durationSec: null, fps: null };
}

function resolveSmoothFps(targetFps, sourceFps) {
  if (!Number.isFinite(sourceFps) || sourceFps <= 1) return targetFps;
  if (sourceFps <= targetFps + 0.5) {
    return Math.max(6, Math.round(sourceFps));
  }
  // Fuentes ~24 fps (anime/cine): divisores exactos 24 o 12 fps evitan saltos de cadencia
  if (sourceFps >= 23.5 && sourceFps <= 24.5) {
    return targetFps >= 18 ? 24 : 12;
  }
  // Fuentes ~30 fps: 30, 15 (/2), 12 o 10 (/3) evitan tirones por descarte desigual de cuadros
  if (sourceFps >= 29 && sourceFps <= 31) {
    if (targetFps >= 24) return 30;
    if (targetFps >= 14) return 15;
    if (targetFps >= 12) return 12;
    return 10;
  }
  // Fuentes ~60 fps: 20 (/3), 15 (/4), 12 (/5) y 10 (/6) son divisores exactos
  if (sourceFps >= 58 && sourceFps <= 62) {
    if (targetFps >= 18) return 20;
    if (targetFps >= 14) return 15;
    if (targetFps >= 12) return 12;
    return 10;
  }
  return targetFps;
}

async function demuxWebpFrames(webpBuffer) {
  const frameDir = path.join(
    os.tmpdir(),
    `stk_frames_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.promises.mkdir(frameDir, { recursive: true });
  const img = new webp.Image();
  await img.load(webpBuffer);
  await img.demux({ path: frameDir, prefix: 'f_' });

  const files = (await fs.promises.readdir(frameDir))
    .filter((f) => f.endsWith('.webp'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!files.length) {
    await fs.promises.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('No se pudieron extraer frames del sticker animado');
  }

  const frameMeta = Array.isArray(img.frames) ? img.frames : [];
  const concatLines = [];
  let totalDurationSec = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(frameDir, files[i]).replace(/'/g, "'\\''");
    const delayMs = Number(frameMeta[i]?.delay);
    const durationSec = (Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 67) / 1000;
    totalDurationSec += durationSec;
    concatLines.push(`file '${filePath}'`);
    concatLines.push(`duration ${durationSec.toFixed(4)}`);
  }
  // El demuxer concat requiere repetir la última entrada para respetar su duración
  const lastFilePath = path.join(frameDir, files[files.length - 1]).replace(/'/g, "'\\''");
  concatLines.push(`file '${lastFilePath}'`);

  const listPath = path.join(frameDir, 'list.txt');
  await fs.promises.writeFile(listPath, concatLines.join('\n'), 'utf8');

  return {
    frameDir,
    listPath,
    width: img.width || 512,
    height: img.height || 512,
    durationSec: totalDurationSec > 0 ? totalDurationSec : null,
    fps: totalDurationSec > 0 ? files.length / totalDurationSec : null,
  };
}

// Escalera progresiva equilibrando fluidez (12-24 fps reales sin saltos) y nitidez,
// sin usar `cr_threshold` (que corrompe bloques estáticos con transparencia en libwebp_anim).
const ANIMATED_QUALITY_LADDER = [
  { size: 512, fps: 24, q: 80, sharpen: 0.32, denoise: false, weight: 1.15 },
  { size: 512, fps: 20, q: 76, sharpen: 0.34, denoise: false, weight: 0.90 },
  { size: 512, fps: 15, q: 72, sharpen: 0.35, denoise: false, weight: 0.65 },
  { size: 448, fps: 15, q: 66, sharpen: 0.36, denoise: false, weight: 0.48 },
  { size: 384, fps: 15, q: 60, sharpen: 0.36, denoise: true,  weight: 0.35 },
  { size: 384, fps: 15, q: 50, sharpen: 0.38, denoise: true,  weight: 0.27 },
  { size: 352, fps: 15, q: 44, sharpen: 0.38, denoise: true,  weight: 0.21 },
  { size: 320, fps: 15, q: 40, sharpen: 0.40, denoise: true,  weight: 0.165 },
  { size: 288, fps: 12, q: 36, sharpen: 0.40, denoise: true,  weight: 0.120 },
  { size: 256, fps: 12, q: 32, sharpen: 0.40, denoise: true,  weight: 0.090 },
  { size: 240, fps: 12, q: 28, sharpen: 0.40, denoise: true,  weight: 0.070 },
  { size: 224, fps: 10, q: 24, sharpen: 0.40, denoise: true,  weight: 0.050 },
];

function pickInitialAnimatedIndex(durationSec) {
  if (durationSec <= 4) return 0;
  if (durationSec <= 8) return 1;
  if (durationSec <= 14) return 2;
  if (durationSec <= 22) return 3;
  if (durationSec <= 35) return 5;
  return 6;
}

/**
 * Convierte imagen, GIF o video a WebP fluido y de alta nitidez optimizado para WhatsApp.
 * - Estático: 512x512 WebP sin pérdida (VP8L RGB 4:4:4) primero, con respaldo lossy de alta calidad
 *   manteniendo siempre 512x512 (soporta modos: default, crop, circle).
 * - Animado: hasta 60s máx usando `libwebp_anim` + preset `picture` con cadencia fluida (12-24 fps)
 *   alineada al FPS original y salto adaptativo guiado por peso bajo ~1 MB.
 */
async function createSticker(
  mediaBuffer,
  { isAnimated = false, mode = 'default', maxSeconds = MAX_VIDEO_SECONDS } = {},
) {
  const input = toBuffer(mediaBuffer);
  if (!input.length) throw new Error('Buffer de entrada vacío');

  const tmpIn = uniqueTmpPath('stk_in', 'bin');
  const tmpOut = uniqueTmpPath('stk_out', 'webp');
  let demuxed = null;

  try {
    if (!isAnimated) {
      await fs.promises.writeFile(tmpIn, input);
      const staticPresets = [
        { size: 512, lossless: true, q: 100, sharpen: 0.30, pixelFormat: 'bgra' },
        { size: 512, lossless: false, q: 95, sharpen: 0.35, pixelFormat: 'yuva420p' },
        { size: 512, lossless: false, q: 86, sharpen: 0.35, pixelFormat: 'yuva420p' },
        { size: 512, lossless: false, q: 76, sharpen: 0.35, pixelFormat: 'yuva420p' },
      ];

      let best = null;
      for (const preset of staticPresets) {
        const vf = buildVideoFilter(preset.size, mode, {
          fps: null,
          pixelFormat: preset.pixelFormat,
          sharpen: preset.sharpen,
          denoise: false,
        });
        const args = preset.lossless
          ? [
              '-frames:v', '1',
              '-c:v', 'libwebp',
              '-lossless', '1',
              '-compression_level', '6',
              '-quality', String(preset.q),
              '-vf', vf,
            ]
          : [
              '-frames:v', '1',
              '-c:v', 'libwebp',
              '-lossless', '0',
              '-preset', 'picture',
              '-compression_level', '6',
              '-quality', String(preset.q),
              '-vf', vf,
            ];
        const out = await runFfmpegConvert(tmpIn, tmpOut, args);
        if (!isValidWebp(out)) continue;
        best = out;
        if (out.length <= MAX_STATIC_WEBP_BYTES) return out;
      }
      if (best) return best;
      throw new Error('FFmpeg no produjo un WebP estático válido');
    }

    let ffmpegInput = tmpIn;
    let inputArgs = [];
    let detectedSeconds = null;
    let sourceFps = null;

    if (isAnimatedWebp(input)) {
      demuxed = await demuxWebpFrames(input);
      ffmpegInput = demuxed.listPath;
      inputArgs = ['-f', 'concat', '-safe', '0'];
      detectedSeconds = demuxed.durationSec;
      sourceFps = demuxed.fps;
    } else {
      await fs.promises.writeFile(tmpIn, input);
      const meta = await getMediaVideoMeta(tmpIn).catch(() => ({
        durationSec: null,
        fps: null,
      }));
      detectedSeconds = meta.durationSec;
      sourceFps = meta.fps;
    }

    const effectiveSeconds = Math.min(
      maxSeconds,
      Math.max(0.5, detectedSeconds || maxSeconds),
    );
    const animCodec = await getAnimatedWebpCodec();

    let idx = pickInitialAnimatedIndex(effectiveSeconds);
    let smallest = null;

    while (idx < ANIMATED_QUALITY_LADDER.length) {
      const preset = ANIMATED_QUALITY_LADDER[idx];
      const effectiveFps = resolveSmoothFps(preset.fps, sourceFps);
      const vf = buildVideoFilter(preset.size, mode, {
        fps: effectiveFps,
        pixelFormat: 'yuva420p',
        sharpen: preset.sharpen,
        denoise: preset.denoise,
      });
      const out = await runFfmpegConvert(
        ffmpegInput,
        tmpOut,
        [
          '-t', String(effectiveSeconds),
          '-an',
          '-c:v', animCodec,
          '-loop', '0',
          '-preset', 'picture',
          '-compression_level', '4',
          '-quality', String(preset.q),
          '-vf', vf,
        ],
        inputArgs,
      );

      if (isValidWebp(out)) {
        if (!smallest || out.length < smallest.length) smallest = out;
        if (out.length <= MAX_ANIMATED_WEBP_BYTES) return out;

        const overshoot = out.length / MAX_ANIMATED_WEBP_BYTES;
        const targetWeight = preset.weight / (overshoot * 1.06);
        let nextIdx = idx + 1;
        while (
          nextIdx < ANIMATED_QUALITY_LADDER.length - 1 &&
          ANIMATED_QUALITY_LADDER[nextIdx].weight > targetWeight
        ) {
          nextIdx++;
        }
        idx = nextIdx;
      } else {
        idx++;
      }
    }

    if (smallest) return smallest;
    throw new Error('FFmpeg no produjo un WebP animado válido');
  } finally {
    await cleanUp(tmpIn, tmpOut);
    if (demuxed?.frameDir) {
      await fs.promises.rm(demuxed.frameDir, { recursive: true, force: true }).catch(() => {});
    }
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
            '-t', String(MAX_STATIC_AUDIO_SECONDS + 5),
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=${SCALE_FLAGS}`,
            '-c:v', 'libx264',
            '-tune', 'stillimage',
            '-preset', 'fast',
            '-crf', '18',
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
            '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=${SCALE_FLAGS}`,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
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
  const tmpAudio = hasAudio ? uniqueTmpPath('stk_rev_aud', 'ogg') : null;
  const tmpOut = uniqueTmpPath('stk_rev_out', 'mp4');
  let demuxed = null;

  try {
    demuxed = await demuxWebpFrames(input);
    const canvasW = Math.max(2, Math.floor(demuxed.width / 2) * 2);
    const canvasH = Math.max(2, Math.floor(demuxed.height / 2) * 2);

    const scalePad = `scale=${canvasW}:${canvasH}:flags=${SCALE_FLAGS}:force_original_aspect_ratio=decrease,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:color=black`;
    if (tmpAudio) {
      await fs.promises.writeFile(tmpAudio, audioBuffer);
      await execFileAsync(
        bin,
        [
          '-y',
          '-stream_loop', '-1',
          '-f', 'concat',
          '-safe', '0',
          '-i', demuxed.listPath,
          '-i', tmpAudio,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest',
          '-t', String(MAX_ANIMATED_AUDIO_SECONDS + 5),
          '-vsync', 'vfr',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', scalePad,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',
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
          '-i', demuxed.listPath,
          '-vsync', 'vfr',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', scalePad,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',
          tmpOut,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    }

    const mp4 = await fs.promises.readFile(tmpOut);
    return { kind: 'video', buffer: mp4, mimetype: 'video/mp4' };
  } finally {
    await cleanUp(tmpAudio, tmpOut);
    if (demuxed?.frameDir) {
      await fs.promises.rm(demuxed.frameDir, { recursive: true, force: true }).catch(() => {});
    }
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
  const metadata = { quality: 100, type: 'default', pack: packname, author, categories, ...extra };
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
  MAX_VIDEO_SECONDS,
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
