import fs from 'fs';
import path from 'path';
import { exec, spawn, execSync, spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';

// ─── Config global ───────────────────────────────────────────────────────────
const TEMP_DIR          = './temp';
const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000; // ✅ mata procesos colgados a los 20 min
const RES_MIN           = 144;
const RES_MAX           = 2160;
const activeChats       = new Set(); // ✅ evita que un mismo chat sature con varios jobs a la vez

// ✅ Parámetros de codificación centralizados (antes: números mágicos sueltos)
const PRESET = {
    // ✅ dw4 vuelve a usar CRF (el peso final varía según la complejidad del
    // video, como antes), pero con un techo de bitrate (safetyTargetMB) que
    // solo actúa como límite de seguridad en videos largos/pesados.
    dw4:     { crf: 26, safetyTargetMB: 58, audioKbps: 64, preset: 'faster' },
    dw3:     { crf: 25, audioKbps: 80, preset: 'faster' },
    dw2:     { crf: 24, preset: 'faster' }, // audio copy, sin bitrate propio
    mi:      { audioKbps: 96, preset: 'fast' }
};

let handler = async (m, { conn, text, command, args }) => {
    const reply = (texto) => conn.sendMessage(m.chat, { text: texto }, { quoted: m });

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const flags = {
        'spa': '🇲🇽', 'es': '🇲🇽', 'lat': '🌎', 'es-419': '🌎', 'eng': '🇺🇸', 'en': '🇺🇸', 'jpn': '🇯🇵', 'ja': '🇯🇵',
        'por': '🇧🇷', 'pt': '🇧🇷', 'ara': '🇸🇦', 'ar': '🇸🇦', 'fre': '🇫🇷', 'fra': '🇫🇷', 'fr': '🇫🇷',
        'ger': '🇩🇪', 'deu': '🇩🇪', 'de': '🇩🇪', 'ita': '🇮🇹', 'it': '🇮🇹', 'rus': '🇷🇺', 'ru': '🇷🇺',
        'chi': '🇨🇳', 'zho': '🇨🇳', 'cmn': '🇨🇳', 'zh': '🇨🇳', 'kor': '🇰🇷', 'ko': '🇰🇷',
        'dut': '🇳🇱', 'nld': '🇳🇱', 'nl': '🇳🇱', 'pol': '🇵🇱', 'pl': '🇵🇱', 'tur': '🇹🇷', 'tr': '🇹🇷',
        'cze': '🇨🇿', 'ces': '🇨🇿', 'cs': '🇨🇿', 'hun': '🇭🇺', 'hu': '🇭🇺', 'rum': '🇷🇴', 'ron': '🇷🇴', 'ro': '🇷🇴',
        'swe': '🇸🇪', 'sv': '🇸🇪', 'nor': '🇳🇴', 'nob': '🇳🇴', 'nb': '🇳🇴', 'no': '🇳🇴', 'dan': '🇩🇰', 'da': '🇩🇰',
        'fin': '🇫🇮', 'fi': '🇫🇮', 'gre': '🇬🇷', 'ell': '🇬🇷', 'el': '🇬🇷', 'tha': '🇹🇭', 'th': '🇹🇭',
        'vie': '🇻🇳', 'vi': '🇻🇳', 'ind': '🇮🇩', 'id': '🇮🇩', 'may': '🇲🇾', 'msa': '🇲🇾', 'ms': '🇲🇾',
        'hin': '🇮🇳', 'hi': '🇮🇳', 'ukr': '🇺🇦', 'uk': '🇺🇦', 'heb': '🇮🇱', 'he': '🇮🇱',
        'bul': '🇧🇬', 'bg': '🇧🇬', 'srp': '🇷🇸', 'sr': '🇷🇸', 'hrv': '🇭🇷', 'hr': '🇭🇷',
        'slk': '🇸🇰', 'sk': '🇸🇰', 'slv': '🇸🇮', 'sl': '🇸🇮', 'und': '🏳️'
    };

    const downloadMediaStream = async (quoted, outputPath) => {
        try {
            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const message = quoted.fakeObj ? quoted.fakeObj.message : (quoted.vM ? quoted.vM.message : quoted);
            const type = Object.keys(message)[0];
            const media = message[type];
            if (!media || !media.mediaKey) return false;
            const stream = await downloadContentFromMessage(media, type.replace('Message', ''));
            await pipeline(stream, fs.createWriteStream(outputPath));
            return true;
        } catch (e) { return false; }
    };

    // ✅ Aviso honesto: Baileys no ofrece descarga por stream vía quoted.download(),
    // así que este fallback SIGUE cargando el buffer completo en RAM. Solo se usa
    // cuando downloadMediaStream (100% streaming) falla.
    const downloadFallback = async (quoted, outputPath) => {
        const buf = await quoted.download();
        await fs.promises.writeFile(outputPath, buf);
    };

    // Colores ANSI
    const colors = {
        reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
        yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', red: '\x1b[31m'
    };

    const logFFmpegProgress = (label, data, totalFrames = 0) => {
        const line = data.toString();
        if (!line.includes('frame=')) return;
        const frameMatch = line.match(/frame=\s*(\d+)/);
        const fpsMatch   = line.match(/fps=\s*([\d.]+)/);
        const timeMatch  = line.match(/time=\s*([\d:.]+)/);
        const speedMatch = line.match(/speed=\s*([\d.x]+)/);
        if (!frameMatch) return;
        const frame = parseInt(frameMatch[1]);
        const fps   = fpsMatch  ? parseFloat(fpsMatch[1]) : 0;
        const time  = timeMatch ? timeMatch[1]             : '00:00:00';
        const speed = speedMatch ? speedMatch[1]           : '0x';
        let percentage = '000';
        if (totalFrames > 0) percentage = ((frame / totalFrames) * 100).toFixed(0).padStart(3, '0');
        const output = `\r${colors.cyan}[[${label}]]${colors.reset} Progreso ${colors.green}${percentage}%${colors.reset} | Frame: ${colors.yellow}${frame}${colors.reset} | FPS: ${colors.blue}${Math.round(fps)}${colors.reset} | Time: ${colors.magenta}${time}${colors.reset} | Speed: ${colors.red}${speed}${colors.reset}`;
        process.stdout.write(output);
    };

    const calcVideoBitrate = (durationSec, targetMB, audioBitrateK = 128) => {
        if (!durationSec || durationSec <= 0) return 1000;
        const videoBits = targetMB * 8 * 1024 * 1024 - audioBitrateK * 1000 * durationSec;
        return Math.max(100, Math.floor(videoBits / durationSec / 1000));
    };

    // ✅ Frames + duración real del vídeo con ffprobe — ahora vía spawnSync con array
    // de argumentos (sin pasar por el shell) en vez de execSync con template string.
    const getVideoMeta = (filePath) => {
        try {
            const proc = spawnSync('ffprobe', [
                '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=nb_frames,r_frame_rate',
                '-show_entries', 'format=duration',
                '-of', 'json', filePath
            ], { encoding: 'utf8' });
            const data = JSON.parse(proc.stdout);
            const stream = data.streams?.[0] || {};
            const durationSec = parseFloat(data.format?.duration || 0);
            let totalFrames = parseInt(stream.nb_frames) || 0;
            if (!totalFrames && durationSec && stream.r_frame_rate) {
                const [num, den] = stream.r_frame_rate.split('/').map(Number);
                const fps = den ? num / den : 0;
                totalFrames = Math.round(durationSec * fps);
            }
            return { totalFrames, durationSec };
        } catch { return { totalFrames: 0, durationSec: 0 }; }
    };

    // ✅ Bitrate real del stream de vídeo. Antes esta misma llamada a ffprobe estaba
    // duplicada 3 veces con execSync + template string; ahora es un solo helper
    // vía spawnSync (sin shell).
    const getBitrateKbps = (filePath) => {
        try {
            const proc = spawnSync('ffprobe', [
                '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=bit_rate',
                '-of', 'default=noprint_wrappers=1:nokey=1', filePath
            ], { encoding: 'utf8' });
            const br = parseInt(proc.stdout.trim());
            return Number.isFinite(br) ? Math.round(br / 1000) : 0;
        } catch { return 0; }
    };

    // ✅ Convierte un argumento 1-based del usuario (pista 1, 2, 3...) a índice
    // 0-based seguro. Antes: `parseInt(args[1]) - 1 || 0`, que devolvía -1 cuando
    // el usuario pasaba "0" explícitamente (porque -1 es truthy y gana el ||).
    const safeIndex = (raw) => {
        const n = parseInt(raw) - 1;
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };

    // ✅ Valida resolución dentro de un rango razonable (antes sin límites: se podía
    // pedir `.mi -50 200mb` o `.dw2 99999`).
    const validRes = (raw) => {
        const n = parseInt(raw);
        return Number.isFinite(n) && n >= RES_MIN && n <= RES_MAX ? n : null;
    };

    // ✅ Escapa una ruta para usarla dentro del filtro `subtitles=` de ffmpeg
    // (los ':' y comillas simples rompen el parser de filtros si no se escapan).
    const escapeForFilter = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

    // ✅ Mensaje de error genérico hacia el usuario (sin rutas/stack internos);
    // el detalle completo se sigue logueando en consola para debug.
    const userError = (e, context) => {
        console.error(`[${context}]`, e);
        return `❌ Error al procesar (${context}). Probá de nuevo o con otra resolución/valores.`;
    };

    // ✅ Envío unificado de resultado (video o documento) — antes duplicado en
    // 3 lugares distintos con la misma estructura de mediaOptions.
    const sendResult = async ({ file, asDocument, caption, fileName }) => {
        const mediaOptions = asDocument
            ? { document: { url: file }, fileName, mimetype: 'video/mp4' }
            : { video: { url: file }, ...(caption ? { caption } : {}), mimetype: 'video/mp4' };
        await conn.sendMessage(m.chat, mediaOptions, { quoted: m });
    };

    // ✅ Corre ffmpeg con timeout (mata el proceso si se cuelga más de
    // FFMPEG_TIMEOUT_MS) y centraliza el manejo de código de salida.
    const runFFmpeg = (ffmpegArgs, label, totalFrames = 0) => new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs);
        let errBuf = '';
        const killTimer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Tiempo límite de proceso excedido (20 min)'));
        }, FFMPEG_TIMEOUT_MS);
        proc.stderr.on('data', (data) => { errBuf += data; logFFmpegProgress(label, data, totalFrames); });
        proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(killTimer);
            process.stdout.write('\n\n');
            if (code !== 0) {
                const lastLines = errBuf.split('\n').filter(Boolean).slice(-5).join('\n');
                return reject(new Error(`FFmpeg código ${code}\n${lastLines}`));
            }
            resolve();
        });
    });

    // ─── Watermark ───────────────────────────────────────────────────────────────
    // ✅ Ruta de fuente configurable por variable de entorno antes que las rutas
    // hardcodeadas de Termux, para portabilidad a otros entornos/Docker.
    const FONT_PATHS = [
        process.env.WM_FONT_PATH,
        '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf',
        '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/data/data/com.termux/files/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    ].filter(Boolean);
    const FONT_FILE = FONT_PATHS.find(p => fs.existsSync(p)) || '';
    const WM = FONT_FILE
        ? `drawtext=fontfile='${FONT_FILE}':text='By\\:CID':fontcolor=white:fontsize=w*0.04:x=20:y=20:borderw=2:bordercolor=black:alpha='if(lt(t,4),1,if(lt(t,5),5-t,0))'`
        : null;
    const withWM = (vf) => WM ? `${vf},${WM}` : vf;

    // Padding par (de compressO): elimina errores "not divisible by 2" con
    // vídeos de dimensiones impares. Va siempre después del scale.
    const PAD = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';

    // Helpers de scale con pad incorporado:
    //   - fast_bilinear → dw3/dw4/mi (velocidad en Termux)
    //   - lanczos       → dw2 (sin hardsub: podemos subir calidad)
    const scaleFast    = (res) => `scale=-2:${res}:flags=fast_bilinear,${PAD}`;
    const scaleLanczos = (res) => `scale=-2:${res}:flags=lanczos,${PAD}`;

    // ✅ Control de concurrencia: un chat no puede tener dos jobs pesados a la vez.
    const isHeavyCommand = /^(dw2|dw3|dw4|mi)$/i.test(command);
    if (isHeavyCommand) {
        if (activeChats.has(m.chat)) {
            return reply('⏳ Ya hay un video procesándose en este chat. Esperá a que termine antes de pedir otro.');
        }
        activeChats.add(m.chat);
    }

    try {
        // ─────────────────────────────────────────────
        //  DW — Analizar info del vídeo
        // ─────────────────────────────────────────────
        if (command === 'dw') {
            if (!m.quoted) return reply('Responde a un video o documento.');
            try {
                const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
                const quoted  = m.quoted;
                const message = quoted.fakeObj ? quoted.fakeObj.message : (quoted.vM ? quoted.vM.message : quoted);
                const type    = Object.keys(message)[0];
                const media   = message[type];
                if (!media || !media.mediaKey) return reply('Error: No se encontró el medio.');
                const stream  = await downloadContentFromMessage(media, type.replace('Message', ''));

                // -v error: suprime advertencias innecesarias
                // probesize/analyzeduration bajos → lectura de metadata instantánea
                const ffprobe = spawn('ffprobe', [
                    '-v', 'error', '-probesize', '100K', '-analyzeduration', '100K',
                    '-show_streams', '-show_format', '-print_format', 'json', '-i', 'pipe:0'
                ]);
                let stdoutData = '';
                let stdinClosed = false;
                ffprobe.stdin.on('error', (err) => { if (err.code !== 'EPIPE') console.error('[FFPROBE ERROR]', err); });
                stream.pipe(ffprobe.stdin);
                // Cerrar stdin en cuanto ffprobe emita el primer JSON → corta la descarga temprano
                ffprobe.stdout.on('data', (chunk) => {
                    stdoutData += chunk;
                    if (!stdinClosed && stdoutData.includes('"format"')) {
                        stdinClosed = true;
                        try { stream.destroy(); ffprobe.stdin.end(); } catch (_) {}
                    }
                });
                ffprobe.on('close', async (code) => {
                    if (!stdinClosed && stream) stream.destroy();
                    if (code !== 0 || !stdoutData) return reply('Error al analizar en tiempo real.');
                    const data        = JSON.parse(stdoutData);
                    const vStream     = data.streams.find(s => s.codec_type === 'video');
                    const resolution  = vStream ? `${vStream.width}x${vStream.height}` : 'Desconocida';
                    const durationSec = parseFloat(data.format.duration || 0);
                    const duration    = new Date(durationSec * 1000).toISOString().substr(11, 8);
                    const formatName  = data.format.format_long_name ? data.format.format_long_name.split(' / ')[0] : 'Desconocido';

                    let r = '> *Información del video*\n\n';
                    r += `> Formato: \`${formatName}\`\n`;
                    r += `> Resolución: \`${resolution}\`\n`;
                    r += `> Duración: \`${duration}\`\n`;
                    r += `> Peso: \`${(data.format.size / 1024 / 1024).toFixed(2)} MB\`\n\n`;
                    const audios = data.streams.filter(s => s.codec_type === 'audio');
                    r += '> *Audios disponibles*\n';
                    const audiosSinBandera = [];
                    audios.forEach((a, i) => {
                        const lang = (a.tags?.language || 'und').toLowerCase();
                        if (flags[lang]) {
                            r += `- Pista ${i + 1}: \`${a.codec_name}\` ${flags[lang]} (\`${lang}\`)\n`;
                        } else {
                            audiosSinBandera.push(`- Pista ${i + 1}: \`${a.codec_name}\` (\`${lang}\`)`);
                        }
                    });
                    if (audiosSinBandera.length) r += audiosSinBandera.join('\n') + '\n';

                    const subs = data.streams.filter(s => s.codec_type === 'subtitle');
                    r += '\n> *Subtítulos disponibles*\n';
                    if (subs.length === 0) r += '- `Ninguno`\n';
                    else {
                        const subsSinBandera = [];
                        subs.forEach((s, i) => {
                            const lang = (s.tags?.language || 'und').toLowerCase();
                            if (flags[lang]) {
                                r += `- Pista ${i + 1}: \`${s.codec_name}\` ${flags[lang]} (\`${lang}\`)\n`;
                            } else {
                                subsSinBandera.push(`- Pista ${i + 1}: \`${s.codec_name}\` (\`${lang}\`)`);
                            }
                        });
                        if (subsSinBandera.length) r += subsSinBandera.join('\n') + '\n';
                    }
                    r += '\n_*.dw2 [res] (doc)*_\n_*.dw3 [res] [audio] [sub] (doc)*_\n_*.dw4 (doc)*_\n_*.mi [res] [pesoMB] (doc)*_';
                    reply(r);
                });
            } catch (e) {
                console.error('[DW] Error crítico:', e);
                reply('Error crítico en el análisis de flujo.');
            }
        }

        // ─────────────────────────────────────────────
        //  MI — Comprimir a tamaño objetivo (2-pass)
        // ─────────────────────────────────────────────
        if (command === 'mi') {
            if (!m.quoted) return reply('Responde a un video.\nUso: *.mi [resolución] [pesoMB]*\nEjemplo: `.mi 720 200mb`');
            const asDocument = args[args.length - 1]?.toLowerCase() === 'doc';
            const res        = validRes(args[0]);
            const targetMB   = args[1] ? parseFloat(args[1].replace(/mb/i, '')) : NaN;
            if (!res)                         return reply(`❌ Especifica una resolución válida (${RES_MIN}-${RES_MAX}). Ej: \`.mi 720 200mb\``);
            if (!targetMB || isNaN(targetMB)) return reply('❌ Especifica el peso objetivo. Ej: `.mi 720 200mb`');

            const timestamp = Date.now();
            const input     = path.resolve(`./temp/mi_in_${timestamp}`);
            const output    = path.resolve(`./temp/mi_out_${timestamp}.mp4`);
            const label     = `MI ${res}p → ${targetMB}MB`;

            try {
                reply(`⚙️ *Comprimiendo video*\n> Resolución: \`${res}p\`\n> Peso objetivo: \`${targetMB} MB\`\n> Modo: \`${asDocument ? 'Documento' : 'Video'}\`\n\nProcesando...`);
                let success = await downloadMediaStream(m.quoted, input);
                if (!success) await downloadFallback(m.quoted, input);

                // Duración real desde ffprobe (no asumir 30fps)
                const { totalFrames, durationSec } = getVideoMeta(input);

                const videoBitrateK = calcVideoBitrate(durationSec, targetMB, PRESET.mi.audioKbps);
                const maxrateK      = Math.floor(videoBitrateK * 1.2);
                const bufsizeK      = Math.floor(videoBitrateK * 2);
                const sf            = scaleFast(res);

                // Single-pass CBR — two-pass falla en builds Android de FFmpeg (EINVAL -22)
                const miArgs = [
                    '-i', input, '-vf', withWM(sf),
                    '-c:v', 'libx264', '-b:v', `${videoBitrateK}k`, '-maxrate', `${maxrateK}k`, '-bufsize', `${bufsizeK}k`,
                    '-pix_fmt', 'yuv420p',
                    '-preset', PRESET.mi.preset, '-tune', 'fastdecode',
                    '-threads', '0',
                    '-c:a', 'aac', '-b:a', `${PRESET.mi.audioKbps}k`, '-ac', '2',
                    '-movflags', '+faststart', '-y', output
                ];
                await runFFmpeg(miArgs, label, totalFrames);

                const finalSizeMB = fs.statSync(output).size / 1024 / 1024;
                await sendResult({
                    file: output, asDocument,
                    caption: `✅ *${res}p* | ${finalSizeMB.toFixed(1)} MB`,
                    fileName: `video_${res}p_${targetMB}mb.mp4`
                });
            } catch (e) {
                reply(userError(e, 'mi'));
            } finally {
                [input, output].forEach(f => {
                    if (f && fs.existsSync(f)) fs.unlinkSync(f);
                });
            }
        }

        // ─────────────────────────────────────────────
        //  DW2 / DW3 / DW4 — Reescalar / hardsub / 360p
        // ─────────────────────────────────────────────
        if (/^(dw2|dw3|dw4)$/i.test(command)) {
            if (!m.quoted) return reply('Responde a un video.');
            const isDw4      = command === 'dw4';
            const isDw3      = command === 'dw3';
            const asDocument = args[args.length - 1]?.toLowerCase() === 'doc';
            let res          = isDw4 ? 360 : validRes(args[0]);
            if (!res) return reply(`❌ Especifica una resolución válida (${RES_MIN}-${RES_MAX}). Ej: \`.dw2 720\``);
            const timestamp  = Date.now();
            const input      = `./temp/in_${timestamp}${isDw3 ? '.mkv' : ''}`;
            const output     = `./temp/out_${timestamp}.mp4`;
            const label      = `${command.toUpperCase()} ${res}p`;

            try {
                reply(`⚙️ Procesando \`${command}\` a \`${res}p\`...\nModo: \`${asDocument ? 'Documento' : 'Video'}\``);
                let success = await downloadMediaStream(m.quoted, input);
                if (!success) await downloadFallback(m.quoted, input);

                const { totalFrames, durationSec } = getVideoMeta(input);
                let ffmpegArgs = ['-i', input];

                if (isDw4) {
                    // ✅ DW4: CRF controla la calidad (el peso final varía según
                    // la complejidad visual del video, igual que antes). El
                    // -maxrate/-bufsize calculado desde la duración solo actúa
                    // como techo de seguridad para que un video largo/complejo
                    // no se dispare de tamaño — no fuerza un peso exacto.
                    const ceilingK = calcVideoBitrate(durationSec, PRESET.dw4.safetyTargetMB, PRESET.dw4.audioKbps);
                    const maxrateK = Math.floor(ceilingK * 1.4); // margen: es techo, no objetivo
                    const bufsizeK = Math.floor(ceilingK * 2);
                    ffmpegArgs.push(
                        '-vf', withWM(scaleFast('360')),
                        '-c:v', 'libx264', '-crf', String(PRESET.dw4.crf), '-maxrate', `${maxrateK}k`, '-bufsize', `${bufsizeK}k`,
                        '-pix_fmt', 'yuv420p',
                        '-preset', PRESET.dw4.preset, '-tune', 'fastdecode',
                        '-profile:v', 'baseline', '-level', '3.0',
                        '-c:a', 'aac', '-b:a', `${PRESET.dw4.audioKbps}k`, '-ac', '2', '-movflags', '+faststart'
                    );
                } else if (isDw3) {
                    // DW3: hardsub. Filtro 'subtitles' (compatible con SRT/ASS/PGS)
                    // vs el antiguo 'ass'. fast_bilinear + pad, pix_fmt yuv420p.
                    // ✅ Ruta escapada para el filtro (evita romperse con ':' u otros
                    // caracteres especiales en el path).
                    const aIdx = safeIndex(args[1]);
                    const sIdx = safeIndex(args[2]);
                    ffmpegArgs.push(
                        '-map', '0:v:0', '-map', `0:a:${aIdx}`,
                        '-vf', withWM(`${scaleFast(res)},subtitles='${escapeForFilter(input)}':si=${sIdx}`),
                        '-c:a', 'aac', '-b:a', `${PRESET.dw3.audioKbps}k`,
                        '-c:v', 'libx264', '-crf', String(PRESET.dw3.crf),
                        '-pix_fmt', 'yuv420p',
                        '-preset', PRESET.dw3.preset, '-tune', 'fastdecode',
                        '-profile:v', 'baseline', '-movflags', '+faststart'
                    );
                } else {
                    // DW2: sin subtítulos, audio copy. lanczos (mejor calidad, sin
                    // costo significativo sin hardsub). pix_fmt yuv420p + pad.
                    ffmpegArgs.push(
                        '-vf', withWM(scaleLanczos(res)),
                        '-c:a', 'copy',
                        '-c:v', 'libx264', '-crf', String(PRESET.dw2.crf),
                        '-pix_fmt', 'yuv420p',
                        '-preset', PRESET.dw2.preset, '-tune', 'fastdecode',
                        '-profile:v', 'baseline', '-movflags', '+faststart'
                    );
                }

                ffmpegArgs.push('-threads', '0', '-y', output);
                await runFFmpeg(ffmpegArgs, label, totalFrames);

                // ✅ Ya no hace falta un segundo paso: el bitrate de dw4 fue
                // calculado de antemano para apuntar a PRESET.dw4.targetMB.
                const finalSizeMB = fs.statSync(output).size / 1024 / 1024;
                const bitrateKbps = getBitrateKbps(output);
                const caption = isDw4
                    ? `✅ *360p* | ${finalSizeMB.toFixed(1)} MB${bitrateKbps ? ` | ~${bitrateKbps}k` : ''}\n⚡ _El bitrate real puede variar levemente según la complejidad visual del video_`
                    : undefined;
                await sendResult({
                    file: output, asDocument, caption,
                    fileName: isDw4 ? 'Video_360p_HD.mp4' : `Video_${res}p.mp4`
                });
            } catch (e) {
                reply(userError(e, command));
            } finally {
                if (fs.existsSync(input))  fs.unlinkSync(input);
                if (fs.existsSync(output)) fs.unlinkSync(output);
            }
        }
    } finally {
        if (isHeavyCommand) activeChats.delete(m.chat);
    }
};

handler.command = /^(dw|dw2|dw3|dw4|mi)$/i;
export default handler;
