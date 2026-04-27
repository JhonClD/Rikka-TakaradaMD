import os from "os";
import { execSync } from "child_process";
import { performance } from "perf_hooks";

function formatBytes(bytes) {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + " GB";
  if (bytes >= 1_048_576)     return (bytes / 1_048_576).toFixed(2) + " MB";
  return (bytes / 1_024).toFixed(2) + " KB";
}

function getDiskInfo() {
  const targets = ["/sdcard", "/data", "/storage/emulated/0", "/"];
  for (const target of targets) {
    try {
      const out = execSync(`df -k "${target}" 2>/dev/null`).toString().trim().split("\n");
      if (out.length < 2) continue;
      const parts = out[1].trim().split(/\s+/);
      const total = parseInt(parts[1]) * 1024;
      const used  = parseInt(parts[2]) * 1024;
      const free  = parseInt(parts[3]) * 1024;
      if (total < 10_485_760) continue;
      return { total, used, free };
    } catch { continue; }
  }
  return { total: 0, used: 0, free: 0 };
}

function getCpuUsage() {
  const sample = () => {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      for (const t of Object.values(cpu.times)) total += t;
      idle += cpu.times.idle;
    }
    return { idle, total };
  };
  const s1 = sample();
  execSync("sleep 0.1 2>/dev/null || timeout /t 0 2>nul", { stdio: "ignore" });
  const s2 = sample();
  const idleDelta  = s2.idle  - s1.idle;
  const totalDelta = s2.total - s1.total;
  return totalDelta > 0 ? (100 - (idleDelta / totalDelta) * 100).toFixed(1) : "N/A";
}

function getCpuModel() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return "Desconocido";
  return `${cpus[0].model.replace(/\s+/g, " ").trim()} (${cpus.length} núcleos)`;
}

function getServerName() {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME) return "🚆 Railway";
  if (process.env.RENDER)           return "🟣 Render";
  if (process.env.HEROKU_APP_NAME || process.env.DYNO) return "🟤 Heroku";
  if (process.env.KOYEB_SERVICE_NAME) return "🔵 Koyeb";
  if (process.env.FLY_APP_NAME)     return "🪂 Fly.io";
  if (process.env.CODESPACE_NAME)   return "💻 GitHub Codespaces";
  if (process.env.REPL_ID || process.env.REPL_SLUG) return "🔵 Replit";
  if (process.env.VERCEL)           return "▲ Vercel";
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "☁️ AWS Lambda";
  if (process.env.GOOGLE_CLOUD_PROJECT)     return "☁️ Google Cloud";
  if (process.env.WEBSITE_SITE_NAME)        return "☁️ Azure";
  if (os.platform() === "android" || process.env.PREFIX?.includes("com.termux")) return "📱 Termux (Android)";
  const hostname = os.hostname() || "desconocido";
  const platMap  = { linux: "🐧 Linux", win32: "🪟 Windows", darwin: "🍎 macOS" };
  return `${platMap[os.platform()] || "🖥️ " + os.platform()} (${hostname})`;
}

function clockString(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1_000) % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

const handler = async (m, { conn, usedPrefix, command }) => {
  const pingStart = performance.now();
  await conn.sendPresenceUpdate("composing", m.chat).catch(() => {});
  const rtime = (performance.now() - pingStart).toFixed(2);

  if (/^p$/i.test(command)) return m.reply(`✨ *Pong:* > ${rtime} ms`);

  const uptime   = clockString(process.uptime() * 1000);
  const ramTotal = os.totalmem();
  const ramFree  = os.freemem();
  const ramUsed  = ramTotal - ramFree;
  const ramPct   = ((ramUsed / ramTotal) * 100).toFixed(1);
  const cpuModel = getCpuModel();
  const cpuPct   = getCpuUsage();
  const disk     = getDiskInfo();
  const diskPct  = disk.total > 0 ? ((disk.used / disk.total) * 100).toFixed(1) : "N/A";
  const servidor = getServerName();

  const users       = Object.values(global.db?.data?.users ?? {});
  const totalusrReg = users.filter((u) => u.registered === true).length;
  const totalusr    = users.length;

  const allChats = Object.entries(conn.chats ?? {}).filter(([id, data]) => id && data?.isChats);
  const groups   = allChats.filter(([id]) => id.endsWith("@g.us"));
  const privados = allChats.length - groups.length;

  const settings = global.db?.data?.settings?.[conn.user?.jid] ?? {};
  const { restrict, antiCall, antiprivado, modejadibot } = settings;
  const { autoread, gconly, pconly, self } = global.opts ?? {};

  const isSubBot = conn.user?.jid && global.conn?.user?.jid && conn.user.jid !== global.conn.user.jid;
  const subBotLine = isSubBot ? `Sub-bot de:\n ▢ +${global.conn.user.jid.split("@")[0]}` : "No es sub-bot";

  const on  = (v) => (v ? "✅ activo"   : "❌ desactivado");
  const onP = (v) => (v ? "✅ activado" : "❌ desactivado");

  const info = `*< INFO - ESTADO />*

  ▢ *Prop.:* Jhon Cid
  ▢ *WA:* +51925092348

  ▢ *Ping:* ${rtime} ms
  ▢ *Uptime:* ${uptime}
  ▢ *Servidor:* ${servidor}

  ▢ *Procesador:* ${cpuModel}
  ▢ *CPU:* ${cpuPct}%
  ▢ *RAM:* ${formatBytes(ramUsed)} / ${formatBytes(ramTotal)} (${ramPct}%)
  ▢ *Disco:* ${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${diskPct}%) — libre: ${formatBytes(disk.free)}

  ▢ *Prefijo:* ${usedPrefix}
  ▢ *Modo:* ${self ? "privado" : "público"}
  ▢ *Usuarios reg.:* ${totalusrReg}
  ▢ *Total usuarios:* ${totalusr}
  ▢ *Sub-bot:* ${subBotLine}

  ▢ *Chats privados:* ${privados}
  ▢ *Grupos:* ${groups.length}
  ▢ *Total chats:* ${allChats.length}

  ▢ *Autoread:* ${on(autoread)}
  ▢ *Restrict:* ${on(restrict)}
  ▢ *Solo PC:* ${onP(pconly)}
  ▢ *Solo GC:* ${onP(gconly)}
  ▢ *Anti privado:* ${onP(antiprivado)}
  ▢ *Anti llamadas:* ${onP(antiCall)}
  ▢ *Modo bot:* ${onP(modejadibot)}`.trim();

  const thumbnail = global.imagen1 ?? Buffer.alloc(0);
  const mimeTypes = [
    "pdf",
    "zip",
    "vnd.openxmlformats-officedocument.presentationml.presentation",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  const randomMime = mimeTypes[Math.floor(Math.random() * mimeTypes.length)];
  const repoUrl = "https://github.com/JhonClD/KanaArima-MD";

  await conn.sendMessage(m.chat, {
    document: { url: repoUrl },
    mimetype: `application/${randomMime}`,
    fileName: "Documento",
    fileLength: 99999999999999,
    pageCount: 200,
    contextInfo: {
      forwardingScore: 200,
      isForwarded: true,
      externalAdReply: {
        mediaUrl: repoUrl,
        mediaType: 2,
        previewType: "pdf",
        title: "Rikka Takarada - MD",
        body: "Repositorio - GitHub",
        thumbnail,
        sourceUrl: repoUrl,
      },
    },
    caption: info,
    footer: "Rikka Takarada-MD",
    headerType: 6,
  }, { quoted: m });
};

handler.command = /^(p|ping|info|status|estado|infobot)$/i;
export default handler;
    
