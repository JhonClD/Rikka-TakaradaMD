// © Ado | 2026
// plugins/downloader-terabox.js

import path from "path";

const CONFIG = {
  base: "https://flowvideoplayer.com",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

const MAX_SIZE = 100 * 1024 * 1024; // 100 MB

// ─── Caché de sesión (TTL 5 min) ────────────────────────────────────────────
const sessionCache = { token: null, cookie: null, ts: 0 };
const TTL = 5 * 60 * 1000;

async function getSession(forceRefresh = false) {
  if (!forceRefresh && sessionCache.token && Date.now() - sessionCache.ts < TTL)
    return sessionCache;

  const res = await fetch(CONFIG.base, {
    method: "GET",
    headers: { "User-Agent": CONFIG.ua },
  });

  if (!res.ok) throw new Error(`Error obteniendo sesión: ${res.status}`);

  let cookieStr = "";
  if (typeof res.headers.getSetCookie === "function") {
    cookieStr = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  } else {
    const raw = res.headers.get("set-cookie");
    if (raw) cookieStr = raw.split(",").map((c) => c.split(";")[0]).join("; ");
  }

  const html = await res.text();
  const match = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  if (!match) throw new Error("CSRF Token no encontrado");

  sessionCache.token  = match[1];
  sessionCache.cookie = cookieStr;
  sessionCache.ts     = Date.now();

  return sessionCache;
}

// ─── Llamada a la API con reintento ─────────────────────────────────────────
async function fetchTeraBox(videoUrl, retry = true) {
  const { token, cookie } = await getSession();

  const res = await fetch(`${CONFIG.base}/telegram/bot/search/video`, {
    method: "POST",
    headers: {
      "User-Agent": CONFIG.ua,
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": token,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: cookie,
      Origin: CONFIG.base,
      Referer: `${CONFIG.base}/`,
    },
    body: JSON.stringify({ url: videoUrl }),
  });

  if (!res.ok) {
    if (retry) {
      await getSession(true);
      return fetchTeraBox(videoUrl, false);
    }
    throw new Error(`Error en la API: ${res.status}`);
  }

  const result = await res.json();
  if (result.error === false && result.data?.length > 0) return result.data;
  throw new Error("No se encontraron datos para esa URL");
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const MIME_MAP = {
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime",
  avi: "video/x-msvideo", webm: "video/webm",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf",
};

function getMime(filename) {
  const ext = filename?.split(".").pop().toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function getType(ext) {
  ext = ext?.toLowerCase();
  if (["mp4", "mkv", "mov", "avi", "webm"].includes(ext)) return "video";
  if (["mp3", "ogg", "wav", "m4a"].includes(ext))          return "audio";
  if (["jpg", "jpeg", "png", "webp"].includes(ext))         return "image";
  return "document";
}

// ─── Enviar un item ──────────────────────────────────────────────────────────
async function sendItem(conn, chat, m, item, statusKey, index, total) {
  const fileName  = item.file_name || "archivo";
  const ext       = item.extension;
  const sizeBytes = item.file_size_bytes;
  const sizeLabel = item.file_size || "N/A"; // ← string ya formateado por la API
  const mime      = getMime(fileName);
  const type      = getType(ext);

  const edit = (text) =>
    conn.sendMessage(chat, { text }, { edit: statusKey });

  // Advertencia si supera el límite
  if (sizeBytes && sizeBytes > MAX_SIZE) {
    return edit(
      `⚠️ *${fileName}* pesa *${sizeLabel}* y supera el límite (100 MB).\n` +
      `🔗 Descárgalo manualmente:\n${item.download_url}`
    );
  }

  // ── Elegir URL correcta según tipo ──────────────────────────────────────
  // Para video: preferir stream_url (optimizado para streaming)
  // Para todo lo demás: usar download_url (archivo completo real)
  const downloadUrl =
    type === "video"
      ? (item.stream_final_url || item.stream_url || item.download_url)
      : item.download_url;

  await edit(`⏳ Descargando ${index}/${total}: *${fileName}*...`);

  let buffer;
  try {
    const res = await fetch(downloadUrl, { headers: { "User-Agent": CONFIG.ua } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return edit(
      `❌ No se pudo descargar *${fileName}*: ${e.message}\n🔗 ${item.download_url}`
    );
  }

  await edit(`📤 Enviando ${index}/${total}: *${fileName}*...`);

  const caption = `📦 *${fileName}*\n💾 ${sizeLabel}`;

  try {
    if (type === "video") {
      await conn.sendMessage(chat, { video: buffer, caption, mimetype: mime }, { quoted: m });
    } else if (type === "audio") {
      await conn.sendMessage(chat, { audio: buffer, mimetype: mime, fileName }, { quoted: m });
    } else if (type === "image") {
      await conn.sendMessage(chat, { image: buffer, caption }, { quoted: m });
    } else {
      await conn.sendMessage(chat, { document: buffer, mimetype: mime, fileName, caption }, { quoted: m });
    }
  } catch (e) {
    await edit(`❌ Error al enviar *${fileName}*: ${e.message}`);
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────
let handler = async (m, { conn, args, usedPrefix, command }) => {
  const url = args[0];
  if (!url)
    return m.reply(`❌ Proporciona una URL de TeraBox.\n\n*Uso:* ${usedPrefix}${command} <url>`);

  // UN solo mensaje que se va editando durante todo el proceso
  const statusMsg = await conn.sendMessage(m.chat, { text: "⏳ Obteniendo información..." }, { quoted: m });
  const statusKey = statusMsg?.key;

  const edit = (text) => conn.sendMessage(m.chat, { text }, { edit: statusKey });

  let items;
  try {
    items = await fetchTeraBox(url);
  } catch (e) {
    return edit(`❌ Error: ${e.message}`);
  }

  // Resumen
  const lista = items
    .map((i, n) => `  ${n + 1}. *${i.file_name}* — ${i.file_size || "N/A"}`)
    .join("\n");

  await edit(
    `╭━━━━━━━━━━━━━━━╮\n` +
    `┃  📦 *TeraBox Downloader*\n` +
    `╰━━━━━━━━━━━━━━━╯\n\n` +
    `🗂️ *Archivos:* ${items.length}\n\n` +
    `*Contenido:*\n${lista}`
  );

  // Thumbnail del primer item (solo si existe, sin mensaje extra)
  if (items[0]?.thumbnail) {
    await conn.sendMessage(
      m.chat,
      { image: { url: items[0].thumbnail }, caption: "🖼️ _Preview_" },
      { quoted: m }
    );
  }

  // Enviar archivos editando el mismo mensaje de estado
  for (let i = 0; i < items.length; i++) {
    await sendItem(conn, m.chat, m, items[i], statusKey, i + 1, items.length);
  }

  await edit(`✅ *Listo!* ${items.length} archivo(s) procesado(s).`);
};

handler.help = ["terabox <url>"];
handler.tags = ["downloader"];
handler.command = /^terabox$/i;

export default handler;
