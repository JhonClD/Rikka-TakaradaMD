// © Ado | 2026
// plugins/downloader-terabox.js

const CONFIG = {
  base: "https://flowvideoplayer.com",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

async function descargarTeraBox(videoUrl) {
  if (!videoUrl) throw new Error("Debes proporcionar una URL");

  const sessionRes = await fetch(CONFIG.base, {
    method: "GET",
    headers: { "User-Agent": CONFIG.ua },
  });

  if (!sessionRes.ok)
    throw new Error(`Error obteniendo sesión: ${sessionRes.status}`);

  let cookieStr = "";
  if (typeof sessionRes.headers.getSetCookie === "function") {
    cookieStr = sessionRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  } else {
    const setCookie = sessionRes.headers.get("set-cookie");
    if (setCookie)
      cookieStr = setCookie
        .split(",")
        .map((c) => c.split(";")[0])
        .join("; ");
  }

  const html = await sessionRes.text();
  const tokenMatch = html.match(
    /name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );
  const token = tokenMatch?.[1];
  if (!token) throw new Error("CSRF Token no encontrado");

  const response = await fetch(`${CONFIG.base}/telegram/bot/search/video`, {
    method: "POST",
    headers: {
      "User-Agent": CONFIG.ua,
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": token,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: cookieStr,
      Origin: CONFIG.base,
      Referer: `${CONFIG.base}/`,
    },
    body: JSON.stringify({ url: videoUrl }),
  });

  if (!response.ok)
    throw new Error(`Error en la API: ${response.status}`);

  const result = await response.json();

  if (result.error === false && result.data?.length > 0) {
    const item = result.data[0];
    return {
      file_name: item.file_name,
      thumbnail: item.thumbnail,
      download_url: item.download_url,
      stream_url: item.stream_final_url || item.stream_url,
      file_size: item.file_size,
      file_size_bytes: item.file_size_bytes,
      duration: item.duration,
      extension: item.extension,
    };
  }

  throw new Error("No se encontraron datos para esa URL");
}

// ─── Handler ────────────────────────────────────────────────────────────────

let handler = async (m, { conn, args, usedPrefix, command }) => {
  const url = args[0];
  if (!url)
    return m.reply(
      `❌ Proporciona una URL de TeraBox.\n\n*Uso:* ${usedPrefix}${command} <url>`
    );

  await m.reply("⏳ Obteniendo información...");

  let data;
  try {
    data = await descargarTeraBox(url);
  } catch (e) {
    return m.reply(`❌ Error: ${e.message}`);
  }

  const caption =
    `╭━━━━━━━━━━━━━━━╮\n` +
    `┃  📦 *TeraBox Downloader*\n` +
    `╰━━━━━━━━━━━━━━━╯\n\n` +
    `📄 *Archivo:* ${data.file_name}\n` +
    `📦 *Tamaño:* ${data.file_size}\n` +
    `⏱️ *Duración:* ${data.duration || "N/A"}\n` +
    `🎞️ *Extensión:* .${data.extension}\n\n` +
    `🔗 *Enlace directo:*\n${data.download_url}`;

  // Enviar thumbnail + caption si existe
  if (data.thumbnail) {
    await conn.sendMessage(
      m.chat,
      {
        image: { url: data.thumbnail },
        caption,
      },
      { quoted: m }
    );
  } else {
    await m.reply(caption);
  }

  // Intentar enviar el video directamente si es un archivo de video
  const videoExts = ["mp4", "mkv", "mov", "avi", "webm"];
  if (data.stream_url && videoExts.includes(data.extension?.toLowerCase())) {
    await m.reply("📥 Enviando video...");
    await conn.sendMessage(
      m.chat,
      {
        video: { url: data.stream_url },
        caption: `📦 ${data.file_name}`,
        mimetype: "video/mp4",
      },
      { quoted: m }
    );
  }
};

handler.help = ["terabox <url>"];
handler.tags = ["downloader"];
handler.command = /^terabox$/i;

export default handler;
