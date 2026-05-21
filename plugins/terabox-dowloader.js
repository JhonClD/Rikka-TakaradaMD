// © Ado | 2026
// plugins/downloader-terabox.js

import fs from "fs";
import path from "path";
import os from "os";

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

  // Si falla por sesión expirada, refrescar y reintentar una vez
  if (!res.ok) {
    if (retry) {
      await getSession(true);
      return fetchTeraBox(videoUrl, false);
    }
    throw new Error(`Error en la API: ${res.status}`);
  }

  const result = await res.json();

  if (result.error === false && result.data?.length > 0)
    return result.data; // devuelve el array completo

  throw new Error("No se encontraron datos para esa URL");
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

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

// Edita el mensaje de progreso simulado
async function editProgress(conn, chat, key, steps, current) {
  const bar = steps.map((s, i) => (i <= current ? "▰" : "▱")).join("");
  await conn.sendMessage(chat, { text: `📥 Descargando... ${bar}` }, { edit: key });
}

// ─── Enviar un item ──────────────────────────────────────────────────────────
async function sendItem(conn, chat, m, item, progressKey) {
  const fileName  = item.file_name || "archivo";
  const ext       = item.extension;
  const sizeBytes = item.file_size_bytes;
  const mime      = getMime(fileName);
  const type      = getType(ext);

  // Advertencia si supera el límite
  if (sizeBytes && sizeBytes > MAX_SIZE) {
    return conn.sendMessage(
      chat,
      {
        text:
          `⚠️ *${fileName}* pesa *${formatSize(sizeBytes)}* y supera el límite de envío (100 MB).\n` +
          `🔗 Descárgalo manualmente:\n${item.download_url}`,
      },
      { quoted: m }
    );
  }

  const downloadUrl = item.stream_url || item.stream_final_url || item.download_url;

  // Barra de progreso simulada (3 pasos)
  const steps = ["Inicio", "Descarga", "Envío"];
  if (progressKey) await editProgress(conn, chat, progressKey, steps, 0);

  let buffer;
  try {
    const res = await fetch(downloadUrl, { headers: { "User-Agent": CONFIG.ua } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (e) {
    return conn.sendMessage(
      chat,
      { text: `❌ No se pudo descargar *${fileName}*: ${e.message}\n🔗 ${item.download_url}` },
      { quoted: m }
    );
  }

  if (progressKey) await editProgress(conn, chat, progressKey, steps, 1);

  const caption = `📦 *${fileName}* (${formatSize(sizeBytes)})`;

  if (type === "video") {
    await conn.sendMessage(chat, { video: buffer, caption, mimetype: mime }, { quoted: m });
  } else if (type === "audio") {
    await conn.sendMessage(chat, { audio: buffer, mimetype: mime, fileName }, { quoted: m });
  } else if (type === "image") {
    await conn.sendMessage(chat, { image: buffer, caption }, { quoted: m });
  } else {
    await conn.sendMessage(chat, { document: buffer, mimetype: mime, fileName, caption }, { quoted: m });
  }

  if (progressKey) await editProgress(conn, chat, progressKey, steps, 2);
}

// ─── Handler ────────────────────────────────────────────────────────────────
let handler = async (m, { conn, args, usedPrefix, command }) => {
  const url = args[0];
  if (!url)
    return m.reply(`❌ Proporciona una URL de TeraBox.\n\n*Uso:* ${usedPrefix}${command} <url>`);

  const progressMsg = await conn.sendMessage(m.chat, { text: "⏳ Obteniendo información..." }, { quoted: m });
  const progressKey = progressMsg?.key;

  let items;
  try {
    items = await fetchTeraBox(url);
  } catch (e) {
    return conn.sendMessage(m.chat, { text: `❌ Error: ${e.message}` }, { edit: progressKey });
  }

  // Resumen general
  const totalSize = items.reduce((acc, i) => acc + (i.file_size_bytes || 0), 0);
  const lista = items
    .map((i, n) => `  ${n + 1}. *${i.file_name}* — ${formatSize(i.file_size_bytes)}`)
    .join("\n");

  const resumen =
    `╭━━━━━━━━━━━━━━━╮\n` +
    `┃  📦 *TeraBox Downloader*\n` +
    `╰━━━━━━━━━━━━━━━╯\n\n` +
    `🗂️ *Archivos encontrados:* ${items.length}\n` +
    `💾 *Tamaño total:* ${formatSize(totalSize)}\n\n` +
    `*Contenido:*\n${lista}`;

  await conn.sendMessage(m.chat, { text: resumen }, { edit: progressKey });

  // Enviar thumbnail del primer item si existe
  if (items[0]?.thumbnail) {
    await conn.sendMessage(m.chat, { image: { url: items[0].thumbnail }, caption: "🖼️ _Preview_" }, { quoted: m });
  }

  // Enviar cada archivo
  for (let i = 0; i < items.length; i++) {
    const statusMsg = await conn.sendMessage(
      m.chat,
      { text: `📥 Enviando archivo ${i + 1}/${items.length}...` },
      { quoted: m }
    );
    await sendItem(conn, m.chat, m, items[i], statusMsg?.key);
  }

  await m.reply(`✅ *Listo!* Se procesaron *${items.length}* archivo(s).`);
};

handler.help = ["terabox <url>"];
handler.tags = ["downloader"];
handler.command = /^terabox$/i;

export default handler;
