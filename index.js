import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import cfonts from 'cfonts';
import chalk from 'chalk';
import fs from 'node:fs';
import './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { say } = cfonts;
const instanceLock = join(tmpdir(), 'rikka-takarada-md.lock');
let lockAcquired = false;

function acquireInstanceLock(attempt = 0) {
  if (attempt >= 3) {
    throw new Error('No se pudo adquirir el bloqueo de instancia.');
  }

  try {
    const fd = fs.openSync(instanceLock, 'wx');
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    lockAcquired = true;
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(instanceLock, 'utf8').trim());
    } catch (readError) {
      if (readError.code === 'ENOENT') {
        return acquireInstanceLock(attempt + 1);
      }
      throw readError;
    }

    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Ya existe otra instancia de Rikka (PID ${pid}).`);
      } catch (probeError) {
        if (probeError.code === 'EPERM') {
          throw new Error(`Ya existe otra instancia de Rikka (PID ${pid}).`);
        }
        if (probeError.code !== 'ESRCH') {
          throw probeError;
        }
      }
    }

    try {
      fs.unlinkSync(instanceLock);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }

    return acquireInstanceLock(attempt + 1);
  }
}

function releaseInstanceLock() {
  if (!lockAcquired) return;
  try {
    if (Number(fs.readFileSync(instanceLock, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(instanceLock);
    }
  } catch {}
  lockAcquired = false;
}

process.once('exit', releaseInstanceLock);

const mint = '#b2f7ef';
const celeste = '#8ecae6';
const softViolet = '#dec0f1';
const white = '#f8f9fa';

function printBanner() {
  console.log(chalk.hex(mint).bold('『 ✦ 』Iniciando sistema...'));
  say('RIKKA\nTAKARADA', {
    font: 'block', align: 'center', colors: [mint, softViolet],
    background: 'transparent', letterSpacing: 1, lineHeight: 1,
    space: true, gradient: true,
  });
  say('Bot creado por JhonCID', { font: 'console', align: 'center', colors: [celeste] });
}

function hasCredentials() {
  if (!global.authFile) return false;
  return fs.existsSync(resolve(__dirname, global.authFile, 'creds.json'));
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
}

async function choosePairingMethod() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const choice = (await rl.question(
        chalk.hex(softViolet)('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n') +
        chalk.hex(mint).bold('  ⟬ ✦ ⟭ Seleccione un método de vinculación:\n') +
        chalk.hex(white)('  1. ✧ Escanear código QR\n') +
        chalk.hex(white)('  2. ✧ Código de 8 dígitos\n') +
        chalk.hex(celeste)('  ──> ')
      )).trim();

      if (choice === '1') {
        process.argv.push('--method=qr');
        return;
      }
      if (choice === '2') {
        const rawPhone = await rl.question(
          chalk.hex(mint).bold('\n  ⟬ ✧ ⟭ Ingrese su número de WhatsApp:\n') +
          chalk.hex(softViolet)('  Ej: +51925092348\n') +
          chalk.hex(celeste)('  ──> ')
        );
        const phone = normalizePhone(rawPhone);
        if (!phone) {
          console.log(chalk.bgHex('#e63946').white.bold('\n [ ERROR ] Número inválido; usa el formato internacional, por ejemplo +51925092348.\n'));
          continue;
        }
        process.argv.push(`--phone=${phone}`, '--method=code');
        return;
      }
      console.log(chalk.hex('#e63946')('Opción no válida. Selecciona 1 o 2.\n'));
    }
  } finally {
    rl.close();
  }
}

async function main() {
  acquireInstanceLock();
  printBanner();

  if (!hasCredentials() && !process.argv.some((arg) => arg.startsWith('--method='))) {
    await choosePairingMethod();
  }

  await import('./main.js');
}

main().catch((error) => {
  console.error(chalk.hex('#e63946').bold('❌ [ FATAL ERROR ]:'), error);
  releaseInstanceLock();
  process.exitCode = 1;
});
