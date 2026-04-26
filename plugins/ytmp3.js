import fetch from 'node-fetch';

const API_KEY  = "nakano-212-jhon";
const API_BASE = "https://rest.apicausas.xyz/api/v1/descargas/youtube";
const TIMEOUT  = 25000; // 25s

const fetchWithTimeout = (url, ms = TIMEOUT) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
};

// ── Helpers de formato ──────────────────────────────────────────────────────
const formatViews = (n) => {
    if (!n && n !== 0) return 'N/A';
    const num = parseInt(n, 10);
    if (isNaN(num)) return String(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)         return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString('es');
};

const formatDuration = (sec) => {
    if (!sec) return 'N/A';
    const s = parseInt(sec, 10);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
        : `${m}:${String(r).padStart(2,'0')}`;
};

const formatDate = (raw) => {
    if (!raw) return 'N/A';
    // Acepta "YYYYMMDD", "YYYY-MM-DD" o timestamp
    const str = String(raw).replace(/-/g, '');
    if (/^\d{8}$/.test(str)) {
        const [y, mo, d] = [str.slice(0,4), str.slice(4,6), str.slice(6,8)];
        const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        return `${parseInt(d)} ${months[parseInt(mo)-1]} ${y}`;
    }
    return raw;
};

// ── Tarjeta de info ─────────────────────────────────────────────────────────
const buildInfoCard = (data) => {
    const title    = data?.title    || data?.result?.title    || 'Sin título';
    const channel  = data?.channel  || data?.result?.channel  || data?.uploader || 'N/A';
    const views    = data?.views    || data?.result?.views    || data?.viewCount;
    const duration = data?.duration || data?.result?.duration || data?.length_seconds;
    const date     = data?.upload_date || data?.result?.upload_date || data?.publishedAt;
    const link     = data?.url      || data?.result?.url      || data?.webpage_url || '';

    return (
`╭━━━〔 ♪ YOUTUBE AUDIO 〕━━━⬣
┃ ◈ *Título:* ${title}
┃ ✦ *Canal:* ${channel}
┃ ✧ *Vistas:* ${formatViews(views)}
┃ ◷ *Duración:* ${formatDuration(duration)}
┃ ⊞ *Lanzamiento:* ${formatDate(date)}
┃ ∞ *Link:* ${link}
╰━━━━━━━━━━━━━━━━━━━⬣`
    );
};

// ── Handler principal ───────────────────────────────────────────────────────
const handler = async (m, { conn, client, args, text, command }) => {
    const socket = conn || client;
    const url    = text || args[0];

    if (!url)
        return socket.sendMessage(m.chat,
            { text: `《✧》 Por favor, ingresa un enlace de YouTube válido.` },
            { quoted: m });

    if (!url.includes('youtu'))
        return socket.sendMessage(m.chat,
            { text: `❌ El enlace proporcionado no parece ser de YouTube.` },
            { quoted: m });

    try {
        // React + llamada a la API EN PARALELO (ahorra ~300-500ms)
        const apiUrl = `${API_BASE}?apikey=${API_KEY}&url=${encodeURIComponent(url)}&type=audio`;

        const [, res] = await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } }),
            fetchWithTimeout(apiUrl)
        ]);

        const json = await res.json();

        // Normalizar respuesta de la API
        const data = json?.data || json?.result || json || {};

        const downloadUrl = data?.download?.url
            || data?.download
            || data?.url
            || json?.url;

        const title = data?.title || json?.title || 'Audio_YouTube';

        if (!downloadUrl) throw new Error('La API no devolvió un enlace de descarga válido.');

        const fileName   = `${title.replace(/[\\/:*?"<>|]/g, '')}.mp3`;
        const infoCard   = buildInfoCard(data);

        // Enviar tarjeta de info ANTES del audio
        await socket.sendMessage(m.chat, { text: infoCard }, { quoted: m });

        if (command === 'ytmp3doc') {
            await socket.sendMessage(m.chat, {
                document: { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName
            }, { quoted: m });
        } else {
            await socket.sendMessage(m.chat, {
                audio: { url: downloadUrl },
                mimetype: 'audio/mpeg',
                fileName
            }, { quoted: m });
        }

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        const msg = e.name === 'AbortError'
            ? 'Tiempo de espera agotado. Intenta de nuevo.'
            : e.message;

        console.error(`[ytmp3 ERROR] ${e.stack}`);

        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, { text: `❌ *Error:* ${msg}` }, { quoted: m })
        ]);
    }
};

handler.help    = ['ytmp3 <link>', 'ytmp3doc <link>'];
handler.tags    = ['downloader'];
handler.command = /^(ytmp3|ytmp3doc|yta)$/i;

export default handler;
