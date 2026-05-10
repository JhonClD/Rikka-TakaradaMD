// info-SYS.js
// Copyright (C) 2025 Weskerty — AGPLv3
// Adaptado para Rikka-TakaradaMD por KanaArima-MD

import os from 'os';
import { exec } from 'child_process';
import fs from 'fs/promises';
import util from 'util';
import path from 'path';

const execAsync = util.promisify(exec);

// ── FastFetch Downloader ──────────────────────────────────────────────────────

class FastFetchDownloader {
  constructor() {
    this.config = { binPath: path.join(process.cwd(), 'src/tmp') };
    this.fastfetchBinaries = new Map([
      ['linux-x64',   { fileName: 'fastfetch-linux-amd64.tar.gz',   relativePath: 'fastfetch-linux-amd64/usr/bin/fastfetch'   }],
      ['linux-arm64', { fileName: 'fastfetch-linux-aarch64.tar.gz', relativePath: 'fastfetch-linux-aarch64/usr/bin/fastfetch' }],
      ['win32-x64',   { fileName: 'fastfetch-windows-amd64.zip',    relativePath: 'fastfetch-windows-amd64/fastfetch.exe'     }],
    ]);
  }

  getPlatformInfo() {
    let platform = os.platform();
    let arch = os.arch();
    if (platform === 'android') { platform = 'android'; arch = arch === 'arm64' ? 'arm64' : 'x64'; }
    else if (platform === 'linux') arch = (arch === 'arm64' || arch === 'aarch64') ? 'arm64' : 'x64';
    else if (platform === 'win32') arch = 'x64';
    return { platform, arch };
  }

  async tryInstallFromPackageManager() {
    const { platform } = this.getPlatformInfo();
    try {
      if (platform === 'android')    await execAsync('pkg update -y && pkg install fastfetch -y');
      else if (platform === 'linux') await execAsync('sudo apt update && sudo apt install fastfetch -y');
      else return false;
      return true;
    } catch { return false; }
  }

  async downloadAndExtractFastFetch() {
    const { platform, arch } = this.getPlatformInfo();
    const key = `${platform === 'android' ? 'linux' : platform}-${arch}`;
    const binary = this.fastfetchBinaries.get(key);
    if (!binary) throw new Error(`Sistema no soportado: ${key}`);

    await fs.mkdir(this.config.binPath, { recursive: true });
    const downloadUrl  = `https://github.com/fastfetch-cli/fastfetch/releases/latest/download/${binary.fileName}`;
    const downloadPath = path.join(this.config.binPath, binary.fileName);
    const binaryPath   = path.join(this.config.binPath, binary.relativePath);

    await execAsync(`curl -fsSL -o "${downloadPath}" "${downloadUrl}"`);
    if (platform === 'win32') await execAsync(`powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${this.config.binPath}' -Force"`);
    else                      await execAsync(`tar xf "${downloadPath}" -C "${this.config.binPath}"`);
    if (platform !== 'win32') await fs.chmod(binaryPath, '755');
    await fs.unlink(downloadPath);
    return binaryPath;
  }

  async getFastFetchPath() {
    try { const { stdout } = await execAsync('which fastfetch'); if (stdout.trim()) return 'fastfetch'; } catch {}
    if (await this.tryInstallFromPackageManager()) return 'fastfetch';

    const { platform, arch } = this.getPlatformInfo();
    const key = `${platform === 'android' ? 'linux' : platform}-${arch}`;
    const binary = this.fastfetchBinaries.get(key);
    const localPath = path.join(this.config.binPath, binary.relativePath);
    try { await fs.access(localPath); return localPath; } catch {}
    return await this.downloadAndExtractFastFetch();
  }
}

// ── Utilidades ────────────────────────────────────────────────────────────────

async function safeExec(cmd, fallback = null) {
  try   { return (await execAsync(cmd)).stdout.trim(); }
  catch { if (fallback) { try { return (await execAsync(fallback)).stdout.trim(); } catch {} } return null; }
}

// Parsea la salida de fastfetch (clave: valor) en un Map
function parseFastFetch(raw) {
  const map = new Map();
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) map.set(key.toLowerCase(), val);
  }
  return map;
}

// Barra de progreso visual tipo ████░░░░
function bar(pct, len = 10) {
  const filled = Math.round((pct / 100) * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

// Extrae porcentaje de strings como "5.32 GiB / 7.46 GiB (71%)"
function extractPct(str) {
  const m = str.match(/\((\d+)%\)/);
  return m ? parseInt(m[1]) : 0;
}

// ── Versiones de software ─────────────────────────────────────────────────────

async function getSoftwareVersions() {
  const lines = [];

  // sudo
  const hasSudo = await safeExec('which sudo');
  lines.push(`┣ 🔐 *Sudo:* ${hasSudo ? '✅' : '✖'}`);

  // pip
  const pipOut = await safeExec('pip3 --version', 'pip --version');
  const pipVer = pipOut ? (pipOut.match(/pip\s+(\S+)/)?.[1] ?? pipOut) : '✖';
  lines.push(`┣ 📊 *PIP:* ${pipVer}`);

  // node, npm, python, ffmpeg
  const tools = [
    { name: 'Node.js',  emoji: '🟢', cmd: 'node -v' },
    { name: 'NPM',      emoji: '📦', cmd: 'npm -v' },
    { name: 'Python',   emoji: '🐍', cmd: 'python3 --version', fb: 'python --version' },
    { name: 'Chocolatey', emoji: '🍫', cmd: 'choco --version' },
    { name: 'FFmpeg',   emoji: '🎬', cmd: 'ffmpeg -version',
      proc: (o) => o.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0] },
  ];

  for (const t of tools) {
    const out = await safeExec(t.cmd, t.fb);
    const val = out ? (t.proc ? t.proc(out) : out.split('\n')[0]) : '✖';
    lines.push(`┣ ${t.emoji} *${t.name}:* ${val}`);
  }

  return lines;
}

// ── Speedtest ─────────────────────────────────────────────────────────────────

async function runSpeedtest() {
  try {
    const { stdout, stderr } = await execAsync('python3 ./src/libraries/ookla-speedtest.py --secure --share');
    const raw    = (stdout + stderr).trim();
    const imgUrl = raw.match(/https?:\/\/\S+\.png/)?.[0] ?? null;
    return { text: raw, imgUrl };
  } catch (e) {
    return { text: `❌ *Speedtest falló:* ${e.message}`, imgUrl: null };
  }
}

// ── Plugin principal ──────────────────────────────────────────────────────────

const handler = async (m, { conn }) => {
  const wait = await conn.sendMessage(m.chat, { text: '⏳ _Obteniendo información del sistema..._' }, { quoted: m });

  try {
    // ── Fastfetch ─────────────────────────────────────────────────────────────
    const ffPath  = await new FastFetchDownloader().getFastFetchPath();
    const rawInfo = await safeExec(`"${ffPath}" -l none -c all`);
    const info    = rawInfo ? parseFastFetch(rawInfo) : new Map();

    const get = (...keys) => { for (const k of keys) { const v = info.get(k); if (v) return v; } return null; };

    // ── Sección sistema ───────────────────────────────────────────────────────
    const osStr     = get('os', 'operating system') ?? `${os.type()} ${os.release()}`;
    const hostStr   = get('host', 'model') ?? os.hostname();
    const kernelStr = get('kernel') ?? os.release();
    const uptimeStr = get('uptime') ?? `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`;
    const cpuStr    = get('cpu', 'processor') ?? os.cpus()[0]?.model ?? 'N/A';
    const gpuStr    = get('gpu') ?? 'N/A';
    const shellStr  = get('shell') ?? 'N/A';
    const deStr     = get('de', 'desktop environment') ?? 'N/A';
    const loadStr   = get('loadavg', 'load avg') ?? os.loadavg().map(v => v.toFixed(2)).join(', ');

    // RAM
    const memStr = get('memory') ?? `${(os.totalmem() - os.freemem()) / 1073741824 | 0} / ${(os.totalmem() / 1073741824).toFixed(2)} GiB`;
    const memPct = extractPct(memStr) || Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

    // Disco
    const diskStr = get('disk (/storage/emulated)') ?? get('disk (/)') ?? get('disk') ?? 'N/A';
    const diskPct = extractPct(diskStr);

    const sysBlock = [
      `┏━━━━━━━━━━━━━━━━━━┓`,
      `┃  *< SISTEMA />*`,
      `┃≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡┃`,
      `┣ 🖥️  *OS:* ${osStr}`,
      `┣ 📱 *Host:* ${hostStr}`,
      `┣ 🔧 *Kernel:* ${kernelStr}`,
      `┣ ⏱️  *Uptime:* ${uptimeStr}`,
      `┣ ⚡ *CPU:* ${cpuStr}`,
      `┣ 🎮 *GPU:* ${gpuStr}`,
      `┣ 🐚 *Shell:* ${shellStr}`,
      `┣ 🖼️  *DE:* ${deStr}`,
      `┣ 📶 *LoadAvg:* ${loadStr}`,
      `┃`,
      `┃  *< RECURSOS />*`,
      `┃≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡┃`,
      `┣ 🧠 *RAM:* ${memStr}`,
      `┣    ${bar(memPct)} ${memPct}%`,
      ...(diskStr !== 'N/A' ? [
        `┣ 💾 *Disco:* ${diskStr}`,
        `┣    ${bar(diskPct)} ${diskPct}%`,
      ] : []),
      `┗━━━━━━━━━━━━━━━━━━┛`,
    ].join('\n');

    // ── Sección software ──────────────────────────────────────────────────────
    const swLines = await getSoftwareVersions();
    const swBlock = [
      `┏━━━━━━━━━━━━━━━━━━┓`,
      `┃  *< SOFTWARE />*`,
      `┃≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡┃`,
      ...swLines,
      `┗━━━━━━━━━━━━━━━━━━┛`,
    ].join('\n');

    // ── Speedtest ─────────────────────────────────────────────────────────────
    const st = await runSpeedtest();
    const stBlock = [
      `┏━━━━━━━━━━━━━━━━━━┓`,
      `┃  *< SPEEDTEST />*`,
      `┃≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡≡┃`,
      st.text,
      `┗━━━━━━━━━━━━━━━━━━┛`,
    ].join('\n');

    const fullText = `${sysBlock}\n\n${swBlock}\n\n${stBlock}`;

    // Borrar mensaje de espera
    await conn.sendMessage(m.chat, { delete: wait.key }).catch(() => {});

    // Enviar resultado
    if (st.imgUrl) {
      await conn.sendMessage(m.chat, { image: { url: st.imgUrl }, caption: fullText }, { quoted: m });
    } else {
      await conn.sendMessage(m.chat, { text: fullText }, { quoted: m });
    }

  } catch (e) {
    console.error('Falla Plugin sysinfo:', e);
    await conn.sendMessage(m.chat, { delete: wait.key }).catch(() => {});
    await conn.sendMessage(m.chat, { text: `❌ *Error:* ${e.message}` }, { quoted: m });
  }
};

handler.help    = ['sysinfo', 'host'];
handler.tags    = ['info'];
handler.command = /^(sysinfo|host)$/i;
handler.owner   = true;

export default handler;
      
