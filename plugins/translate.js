import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const OCR_ENDPOINT = 'https://api.ocr.space/parse/image';
const OCR_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_RENDER_MAX_TEXT = 1400;

const OCR_LANGUAGES = {
  en: 'eng', es: 'spa', pt: 'por', fr: 'fre', de: 'ger', it: 'ita',
  ja: 'jpn', ko: 'kor', ru: 'rus', ar: 'ara', tr: 'tur',
  nl: 'dut', pl: 'pol', uk: 'ukr', vi: 'vnm', id: 'ind',
  zh: 'chs', 'zh-tw': 'cht',
};

function isImageMessage(message) {
  const mime = String(message?.mimetype || message?.msg?.mimetype || '').toLowerCase();
  return mime.startsWith('image/');
}

function getImageTarget(message) {
  if (isImageMessage(message)) return message;
  if (isImageMessage(message?.quoted)) return message.quoted;
  return null;
}

function normalizeLanguage(value, fallback = 'es') {
  const lang = String(value || '').trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(lang) ? lang : fallback;
}

function ocrLanguage(value) {
  const lang = String(value || '').trim().toLowerCase();
  if (OCR_LANGUAGES[lang]) return OCR_LANGUAGES[lang];
  if (/^[a-z]{3}$/.test(lang)) return lang;
  return 'eng';
}

async function translateText(text, lang) {
  const chunks = String(text).match(/[\s\S]{1,3500}/g) || [];
  const translated = [];

  for (const chunk of chunks) {
    let result = null;

    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(chunk)}`;
      const response = await fetch(url);
      const json = await response.json();
      result = json?.[0]?.map((item) => item?.[0]).filter(Boolean).join('');
    } catch (error) {
      console.log('[Translate Google Error]', error?.message || error);
    }

    if (!result) {
      try {
        const response = await fetch(
          `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=auto|${encodeURIComponent(lang)}`,
        );
        const json = await response.json();
        if (json?.responseStatus === 200) result = json.responseData?.translatedText;
      } catch (error) {
        console.log('[Translate MyMemory Error]', error?.message || error);
      }
    }

    if (!result && globalThis.lolkeysapi) {
      try {
        const response = await fetch(
          `https://api.lolhuman.xyz/api/translate/auto/${encodeURIComponent(lang)}?apikey=${encodeURIComponent(globalThis.lolkeysapi)}&text=${encodeURIComponent(chunk)}`,
        );
        const json = await response.json();
        result = json?.result?.translated;
      } catch (error) {
        console.log('[Translate LolHuman Error]', error?.message || error);
      }
    }

    if (result) translated.push(result);
  }

  return translated.join('\n').trim();
}

async function extractTextFromImage(buffer, mime, sourceLanguage) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('La imagen está vacía.');
  if (buffer.length > OCR_MAX_BYTES) throw new Error('La imagen supera el límite de 10 MB para OCR.');

  const form = new FormData();
  form.append('base64Image', `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`);
  form.append('language', ocrLanguage(sourceLanguage));
  form.append('isOverlayRequired', 'false');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');
  form.append('OCREngine', '2');

  const response = await fetch(OCR_ENDPOINT, {
    method: 'POST',
    headers: { apikey: process.env.OCR_SPACE_API_KEY || 'helloworld' },
    body: form,
  });

  if (!response.ok) throw new Error(`OCR respondió HTTP ${response.status}.`);
  const data = await response.json();
  if (data?.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : data.ErrorMessage;
    throw new Error(message || 'No se pudo leer la imagen.');
  }

  const text = (data?.ParsedResults || [])
    .map((result) => result?.ParsedText || '')
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!text) throw new Error('No encontré texto legible en la imagen.');
  return text;
}

function wrapText(text, maxChars = 52) {
  const lines = [];
  for (const originalLine of String(text).replace(/\r/g, '').split('\n')) {
    let line = originalLine.trim();
    if (!line) {
      lines.push('');
      continue;
    }
    while (line.length > maxChars) {
      let cut = line.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
      lines.push(line.slice(0, cut).trim());
      line = line.slice(cut).trim();
    }
    if (line) lines.push(line);
  }
  return lines;
}

function escapeFfmpegValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function selectFont(lang) {
  if (/^(ar|fa|ur)(?:-|$)/i.test(lang)) return '/usr/share/fonts/opentype/noto/NotoSansArabic-Regular.ttf';
  if (/^(ja|ko|zh)(?:-|$)/i.test(lang)) return '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
  return '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf';
}

function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    const timer = setTimeout(() => process.kill('SIGKILL'), 30_000);
    process.stdout.on('data', (chunk) => output.push(chunk));
    process.stderr.on('data', (chunk) => errors.push(chunk));
    process.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(Buffer.concat(errors).toString().slice(-500) || `ffmpeg terminó con código ${code}`));
    });
    process.stdin.end(input);
  });
}

async function renderTranslatedImage(buffer, translated, lang) {
  const text = String(translated).slice(0, IMAGE_RENDER_MAX_TEXT);
  const lines = wrapText(text);
  const fontSize = 32;
  const panelHeight = Math.min(720, Math.max(150, 58 + lines.length * 42));
  const workDir = join(tmpdir(), `rikka-translate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workDir, { recursive: true });
  const textPath = join(workDir, 'translation.txt');

  try {
    await writeFile(textPath, lines.join('\n'), 'utf8');
    const filter = [
      `pad=iw:ih+${panelHeight}:0:0:color=black@0.82`,
      `drawtext=fontfile='${escapeFfmpegValue(selectFont(lang))}':textfile='${escapeFfmpegValue(textPath)}':fontcolor=white:fontsize=${fontSize}:line_spacing=8:x=32:y=h-${panelHeight}+24`,
    ].join(',');
    return await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vf', filter,
      '-frames:v', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      '-q:v', '3',
      'pipe:1',
    ], buffer);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const handler = async (m, { args, usedPrefix, command, conn }) => {
  const usage = `📖 Uso: _${usedPrefix + command} (idioma) (texto)_\n` +
    `También responde a una imagen: _${usedPrefix + command} es_\n` +
    `Para OCR japonés, por ejemplo: _${usedPrefix + command} es ja_`;

  const image = getImageTarget(m);
  let lang = normalizeLanguage(args?.[0], 'es');
  let text = '';
  let sourceLanguage = '';
  let imageBuffer = null;
  let imageMime = 'image/jpeg';

  if (image) {
    if (args?.[0] && !/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(args[0])) return m.reply(usage);
    if (args?.[1] && /^[a-z]{2,3}$/i.test(args[1])) sourceLanguage = args[1];

    try {
      await m.reply('🔎 Leyendo el texto de la imagen...');
      imageMime = String(image.mimetype || image.msg?.mimetype || 'image/jpeg').split(';')[0];
      imageBuffer = await image.download();
      text = await extractTextFromImage(imageBuffer, imageMime, sourceLanguage);
    } catch (error) {
      console.error('[Translate OCR Error]', error);
      return m.reply(`❌ No pude leer la imagen.\n_${error?.message || 'Error de OCR'}_`);
    }
  } else {
    if (args?.[0] && /^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(args[0])) {
      lang = normalizeLanguage(args.shift(), 'es');
      text = args.join(' ');
    } else {
      text = args?.join(' ') || '';
    }
    if (!text && m.quoted?.text) text = m.quoted.text;
    if (!text) return m.reply(usage);
  }

  const translated = await translateText(text, lang);
  if (!translated) return m.reply('❌ No se pudo traducir el texto. Inténtalo de nuevo.');

  if (image && imageBuffer) {
    try {
      const editedImage = await renderTranslatedImage(imageBuffer, translated, lang);
      return await conn.sendMessage(m.chat, {
        image: editedImage,
        caption: `✅ Traducción integrada en la imagen (${lang})`,
        mimetype: 'image/jpeg',
      }, { quoted: m });
    } catch (error) {
      console.error('[Translate Render Error]', error);
      return m.reply(`📝 *Traducción (${lang}):*\n${translated}\n\n⚠️ No pude integrarla en la imagen, así que te envío el texto.`);
    }
  }

  const header = image ? `🖼️ *Texto traducido (${lang}):*` : `🌐 *Traducción (${lang}):*`;
  await m.reply(`${header}\n${translated}`);
};

handler.help = ['translate <idioma> <texto>', 'translate <idioma> [imagen citada]', 'translate <idioma> <idioma OCR> [imagen]'];
handler.tags = ['herramientas'];
handler.command = /^(translate|traducir|trad)$/i;
export default handler;
