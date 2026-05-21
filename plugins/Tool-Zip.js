// © Ado | 2026
// plugins/tools-unzip.js

import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";

// Límites de seguridad
const MAX_FILES = 15;       // máx archivos a enviar
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB por archivo
const MAX_ZIP_SIZE  = 100 * 1024 * 1024; // 100 MB total del ZIP

const MIME_MAP = {
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf",
};

function getMime(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

// ─── Handler ────────────────────────────────────────────────────────────────

let handler = async (m, { conn }) => {
  const quoted = m.quoted || m;
  const mime = quoted.mimetype || "";

  if (!mime.includes("zip") && !quoted.fileName?.endsWith(".zip"))
    return m.reply("❌ Debes enviar o citar un archivo *.zip*");

  // Verificar tamaño antes de descargar
  if (quoted.fileSize > MAX_ZIP_SIZE)
    return m.reply(`❌ El ZIP excede el límite permitido (${formatSize(MAX_ZIP_SIZE)})`);

  await m.reply("📂 Descomprimiendo...");

  // Descargar el ZIP como buffer
  let buffer;
  try {
    buffer = await quoted.download();
  } catch {
    return m.reply("❌ No se pudo descargar el archivo.");
  }

  // Directorio temporal único
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unzip-"));

  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);

    if (entries.length === 0)
      return m.reply("⚠️ El ZIP está vacío o solo contiene carpetas.");

    // ── Resumen del contenido ──────────────────────────────────────────
    const totalSize = entries.reduce((acc, e) => acc + e.header.size, 0);
    const lista = entries
      .slice(0, 20)
      .map((e, i) => `  ${i + 1}. ${path.basename(e.entryName)} _(${formatSize(e.header.size)})_`)
      .join("\n");

    const resumen =
      `╭━━━━━━━━━━━━━━━╮\n` +
      `┃  📦 *Unzip*\n` +
      `╰━━━━━━━━━━━━━━━╯\n\n` +
      `📁 *Archivos:* ${entries.length}\n` +
      `💾 *Tamaño total:* ${formatSize(totalSize)}\n\n` +
      `*Contenido:*\n${lista}` +
      (entries.length > 20 ? `\n  _...y ${entries.length - 20} más_` : "") +
      (entries.length > MAX_FILES
        ? `\n\n⚠️ Solo se enviarán los primeros *${MAX_FILES}* archivos.`
        : "");

    await m.reply(resumen);

    // ── Enviar archivos ────────────────────────────────────────────────
    const toSend = entries.slice(0, MAX_FILES);
    let sent = 0, skipped = 0;

    for (const entry of toSend) {
      const fileSize = entry.header.size;
      const fileName = path.basename(entry.entryName);

      if (fileSize > MAX_FILE_SIZE) {
        await m.reply(`⏭️ _Se omitió_ *${fileName}* _(${formatSize(fileSize)} — muy grande)_`);
        skipped++;
        continue;
      }

      try {
        const fileBuffer = entry.getData();
        const mimetype = getMime(fileName);

        // Clasificar por tipo y enviar con el método apropiado
        if (mimetype.startsWith("image/")) {
          await conn.sendMessage(m.chat, { image: fileBuffer, caption: `🖼️ ${fileName}` }, { quoted: m });
        } else if (mimetype.startsWith("video/")) {
          await conn.sendMessage(m.chat, { video: fileBuffer, caption: `🎬 ${fileName}`, mimetype }, { quoted: m });
        } else if (mimetype.startsWith("audio/")) {
          await conn.sendMessage(m.chat, { audio: fileBuffer, mimetype, fileName }, { quoted: m });
        } else {
          await conn.sendMessage(m.chat, { document: fileBuffer, mimetype, fileName }, { quoted: m });
        }

        sent++;
      } catch {
        skipped++;
        await m.reply(`⚠️ No se pudo enviar: *${fileName}*`);
      }
    }

    // ── Resultado final ────────────────────────────────────────────────
    await m.reply(
      `✅ *Listo!*\n` +
      `📤 Enviados: *${sent}*\n` +
      (skipped ? `⏭️ Omitidos: *${skipped}*\n` : "") +
      (entries.length > MAX_FILES ? `📦 En total había *${entries.length}* archivos.` : "")
    );

  } catch (e) {
    await m.reply(`❌ Error al procesar el ZIP: ${e.message}`);
  } finally {
    // Limpiar directorio temporal
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

handler.help = ["unzip"];
handler.tags = ["tools"];
handler.command = /^unzip$/i;

export default handler;
