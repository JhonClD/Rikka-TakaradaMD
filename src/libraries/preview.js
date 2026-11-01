import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { prepareWAMessageMedia } from 'baileys';

const PREVIEW_SIZE = 96;
const PREVIEW_TIMEOUT = 5000;

export function createJpegPreview(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const binary = ffmpegPath || 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale=${PREVIEW_SIZE}:${PREVIEW_SIZE}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${PREVIEW_SIZE}:${PREVIEW_SIZE}:(ow-iw)/2:(oh-ih)/2:color=white`,
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ];

    const output = [];
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value || null);
    };

    let process;
    try {
      process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      process.kill('SIGKILL');
      finish(null);
    }, PREVIEW_TIMEOUT);

    process.stdout.on('data', (chunk) => output.push(chunk));
    process.on('error', () => finish(null));
    process.on('close', (code) => {
      if (code !== 0) return finish(null);
      finish(Buffer.concat(output));
    });

    process.stdin.on('error', () => finish(null));
    process.stdin.end(input);
  });
}

/**
 * Prepara la imagen con el flujo thumbnail-link de Baileys.
 * Es más fiable que externalAdReply.thumbnail en forks recientes.
 */
export async function createLinkPreview(conn, input, metadata = {}) {
  if (!conn?.waUploadToServer || !Buffer.isBuffer(input) || input.length === 0) return null;

  try {
    const { imageMessage } = await prepareWAMessageMedia(
      { image: input },
      {
        upload: conn.waUploadToServer,
        mediaTypeOverride: 'thumbnail-link',
      },
    );

    if (!imageMessage) return null;

    return {
      'canonical-url': metadata.url,
      'matched-text': metadata.url,
      title: metadata.title || '',
      description: metadata.description || '',
      jpegThumbnail: imageMessage.jpegThumbnail
        ? Buffer.from(imageMessage.jpegThumbnail)
        : undefined,
      highQualityThumbnail: imageMessage,
    };
  } catch (error) {
    console.warn('[preview] no se pudo preparar thumbnail-link:', error?.message || error);
    return null;
  }
}
