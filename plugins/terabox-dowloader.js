import path from "path";

const CONFIG = {
  base: "https://flowvideoplayer.com",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

const MAX_SIZE = 100 * 1024 * 1024;

const sessionCache = { token: null, cookie: null, ts: 0 };
const TTL = 5 * 60 * 1000;

const log = {
  info:  (msg) => console.log(`\x1b[36m[TeraBox]\x1b[0m \x1b[32mINFO\x1b[0m  ${msg}`),
  warn:  (msg) => console.log(`\x1b[36m[TeraBox]\x1b[0m \x1b[33mWARN\x1b[0m  ${msg}`),
  error: (msg) => console.log(`\x1b[36m[TeraBox]\x1b[0m \x1b[31mERROR\x1b[0m ${msg}`),
  step:  (msg) => console.log(`\x1b[36m[TeraBox]\x1b[0m \x1b[35mSTEP\x1b[0m  ${msg}`),
  done:  (msg) => console.log(`\x1b[36m[TeraBox]\x1b[0m \x1b[32m DONE\x1b[0m ${msg}`),
};

async function getSession(forceRefresh = false) {
  if (!forceRefresh && sessionCache.token && Date.now() - sessionCache.ts < TTL) {
    log.info("Sesión cacheada reutilizada");
    return sessionCache;
  }

  log.step("Obteniendo nueva sesión...");

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

  log.done(`Sesión obtenida | Token: ${match[1].slice(0, 20)}...`);
  return sessionCache;
}

async function fetchTeraBox(videoUrl, retry = true) {
  log.step(`Consultando API | URL: ${videoUrl}`);
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
      log.warn(`API respondió ${res.status} — refrescando sesión y reintentando...`);
      await getSession(true);
      return fetchTeraBox(videoUrl, false);
    }
    log.error(`API falló definitivamente: ${res.status}`);
    throw new Error(`Error en la API: ${res.status}`);
  }

  const result = await res.json();
  if (result.error === false && result.data?.length > 0) {
    log.done(`API respondió | ${result.data.length} archivo(s) encontrado(s)`);
    return result.data;
  }

  throw new Error("No se encontraron datos para esa URL");
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

async function sendItem(conn, chat, m, item, statusKey, index, total) {
  const fileName  = item.file_name || "archivo";
  const ext       = item.extension;
  const sizeBytes = item.file_size_bytes;
  const sizeLabel = item.file_size || "N/A";
  const mime      = getMime(fileName);
  const type      = getType(ext);

  log.step(`[${index}/${total}] Iniciando | ${fileName} (${sizeLabel})`);

  const edit = (text) => conn.sendMessage(chat, { text }, { edit: statusKey });

  if (sizeBytes && sizeBytes > MAX_SIZE) {
    log.warn(`[${index}/${total}] Archivo muy grande, se omite descarga`);
    return edit(
      `⚠️ *${fileName}* pesa *${sizeLabel}* y supera el límite (100 MB).\n` +
      `🔗 Descárgalo manualmente:\n${item.download_url}`
    );
  }

  const downloadUrl =
    type === "video"
      ? (item.stream_final_url || item.stream_url || item.download_url)
      : item.download_url;

  log.info(`[${index}/${total}] Descargando desde: ${downloadUrl}`);
  await edit(`⏳ Descargando ${index}/${total}: *${fileName}*...`);

  let buffer;
  try {
    const res = await fetch(downloadUrl, { headers: { "User-Agent": CONFIG.ua } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    log.done(`[${index}/${total}] Descargado | ${buffer.length} bytes`);
  } catch (e) {
    log.error(`[${index}/${total}] Error al descargar: ${e.message}`);
    return edit(
      `❌ No se pudo descargar *${fileName}*: ${e.message}\n🔗 ${item.download_url}`
    );
  }

  await edit(`📤 Enviando ${index}/${total}: *${fileName}*...`);
  log.info(`[${index}/${total}] Enviando como tipo: ${type}`);

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
    log.done(`[${index}/${total}] Enviado correctamente`);
  } catch (e) {
    log.error(`[${index}/${total}] Error al enviar: ${e.message}`);
    await edit(`❌ Error al enviar *${fileName}*: ${e.message}`);
  }
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
  const url = args[0];

  if (!url) {
    log.warn("No se proporcionó URL");
    return m.reply(`❌ Proporciona una URL de TeraBox.\n\n*Uso:* ${usedPrefix}${command} <url>`);
  }

  log.step(`Comando recibido | Chat: ${m.chat} | URL: ${url}`);

  const statusMsg = await conn.sendMessage(m.chat, { text: "⏳ Obteniendo información..." }, { quoted: m });
  const statusKey = statusMsg?.key;

  const edit = (text) => conn.sendMessage(m.chat, { text }, { edit: statusKey });

  let items;
  try {
    items = await fetchTeraBox(url);
  } catch (e) {
    log.error(`fetchTeraBox falló: ${e.message}`);
    return edit(`❌ Error: ${e.message}`);
  }

  log.info(`Archivos encontrados: ${items.map((i) => i.file_name).join(", ")}`);

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

  if (items[0]?.thumbnail) {
    await conn.sendMessage(
      m.chat,
      { image: { url: items[0].thumbnail }, caption: "🖼️ _Preview_" },
      { quoted: m }
    );
  }

  for (let i = 0; i < items.length; i++) {
    await sendItem(conn, m.chat, m, items[i], statusKey, i + 1, items.length);
  }

  log.done(`Proceso finalizado | ${items.length} archivo(s)`);
  await edit(`✅ *Listo!* ${items.length} archivo(s) procesado(s).`);
};

handler.help = ["terabox <url>"];
handler.tags = ["downloader"];
handler.command = /^terabox$/i;

export default handler;
