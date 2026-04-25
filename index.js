import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getMemoryLimitMB() {
  try {
    const cgroupV2 = '/sys/fs/cgroup/memory.max';
    const cgroupV1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

    if (fs.existsSync(cgroupV2)) {
      const val = fs.readFileSync(cgroupV2, 'utf8').trim();
      if (val !== 'max') return Math.floor(parseInt(val) / 1024 / 1024);
    }
    if (fs.existsSync(cgroupV1)) {
      const val = parseInt(fs.readFileSync(cgroupV1, 'utf8').trim());
      if (val > 0 && val < Number.MAX_SAFE_INTEGER) return Math.floor(val / 1024 / 1024);
    }
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
    if (match) return Math.floor(parseInt(match[1]) / 1024);
  } catch {}
  return 512;
}

const totalMB = await getMemoryLimitMB();
const limitMB = Math.floor(totalMB * 0.85);
const alreadyLaunched = process.env.KANA_LAUNCHED === '1';

if (!alreadyLaunched) {
  console.log(chalk.cyan(`\n[ 📊 ] RAM total: ${totalMB}MB | Límite Node: ${limitMB}MB\n`));
}

const MAIN_SCRIPT = path.join(__dirname, 'index-main.js');
const MAX_RESTARTS = 10;
const RESTART_WINDOW = 120_000;

let child = null;
let restartCount = 0;
let firstRestartAt = null;
let restarting = false;

function startChild() {
  if (restarting) return;

  child = spawn(
    'node',
    [
      `--max-old-space-size=${limitMB}`,
      '--expose-gc',
      MAIN_SCRIPT,
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        KANA_LAUNCHED: '1',
        NODE_ENV: process.env.NODE_ENV || 'production',
      },
    }
  );

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || code === 0) {
      process.exit(code || 0);
    }

    const now = Date.now();
    if (!firstRestartAt || now - firstRestartAt > RESTART_WINDOW) {
      firstRestartAt = now;
      restartCount = 0;
    }
    restartCount++;

    if (restartCount >= MAX_RESTARTS) {
      console.error(
        chalk.red(`\n[ ❌ ] ${MAX_RESTARTS} reinicios en 2 min. Deteniendo para evitar loop.\n`)
      );
      process.exit(1);
    }

    console.log(
      chalk.yellow(`\n[ 🔄 ] Reiniciando... (${restartCount}/${MAX_RESTARTS})\n`)
    );

    setTimeout(() => {
      restarting = false;
      startChild();
    }, 3000);
  });

  child.on('error', err => {
    console.error(chalk.red('[ ❌ ] Error en proceso:'), err.message);
    setTimeout(() => startChild(), 5000);
  });
}

process.on('SIGINT', () => {
  if (child) child.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

process.on('uncaughtException', e => {
  console.error(chalk.red('[ ❌ ] UncaughtException:'), e.message);
});

process.on('unhandledRejection', r => {
  console.error(chalk.red('[ ❌ ] UnhandledRejection:'), r);
});

startChild();
