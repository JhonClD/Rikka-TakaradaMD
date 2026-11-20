import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import webp from 'node-webpmux';

const execFileAsync = promisify(execFile);

const MAX_ANIMATED_WEBP_BYTES = 500 * 1024; // Límite de WhatsApp para stickers animados (~500 KB)
const MAX_STATIC_WEBP_BYTES = 500 * 1024;
const MAX_VIDEO_SECONDS = 10;
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

/**
 * Convierte imagen, GIF o video a WebP optimizado para WhatsApp.
 * - Estático: 512x512 WebP de alta nitidez (soporta modos: default, crop, circle).
 * - Animado: recorta a 10s máx y ajusta automáticamente calidad/fps para no superar 500 KB.
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

    // Stickers animados: adaptación progresiva para cumplir el límite de 500 KB de WhatsApp
    const animatedPresets = [
      { size: 320, fps: 15, q: 70, dur: maxSeconds },
      { size: 320, fps: 12, q: 52, dur: maxSeconds },
      { size: 256, fps: 10, q: 38, dur: Math.min(maxSeconds, 8) },
      { size: 200, fps: 8, q: 28, dur: Math.min(maxSeconds, 6) },
    ];

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

/**
 * Convierte un sticker WebP a PNG (si es estático) o MP4 (si es animado).
 * FFmpeg no decodifica WebP animados (chunks ANIM/ANMF) de forma nativa, así que
 * para stickers animados primero extraemos los frames con `node-webpmux`.
 */
async function stickerToMedia(webpBuffer, { forceVideo = false } = {}) {
  const input = toBuffer(webpBuffer);
  if (!isValidWebp(input)) throw new Error('El archivo no es un sticker WebP válido');

  const animated = isAnimatedWebp(input);
  const bin = await getFfmpegBin();

  if (!animated) {
    const tmpIn = uniqueTmpPath('stk_rev_in', 'webp');
    const outExt = forceVideo ? 'mp4' : 'png';
    const tmpOut = uniqueTmpPath('stk_rev_out', outExt);
    try {
      await fs.promises.writeFile(tmpIn, input);
      if (!forceVideo) {
        const png = await runFfmpegConvert(tmpIn, tmpOut, ['-vframes', '1']);
        return { kind: 'image', buffer: png, mimetype: 'image/png' };
      }
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
      const mp4 = await fs.promises.readFile(tmpOut);
      return { kind: 'video', buffer: mp4, mimetype: 'video/mp4' };
    } finally {
      await cleanUp(tmpIn, tmpOut);
    }
  }

  // Sticker animado: demux de frames con node-webpmux → concat en FFmpeg → MP4
  const frameDir = path.join(
    os.tmpdir(),
    `stk_frames_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
  );
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
        '-vf', `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:color=black`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        tmpOut,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );

    const mp4 = await fs.promises.readFile(tmpOut);
    return { kind: 'video', buffer: mp4, mimetype: 'video/mp4' };
  } finally {
    await cleanUp(tmpOut);
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
  addExif,
  createSticker,
  isAnimatedWebp,
  isValidWebp,
  sticker,
  sticker4,
  sticker5,
  sticker6,
  stickerToMedia,
  support,
  toBuffer,
};
