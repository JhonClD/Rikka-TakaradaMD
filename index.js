import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import cfonts from 'cfonts';
import chalk from 'chalk';
import fs from 'node:fs';
import './config.js';

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
  if (!global.authFilePath) return false;
  return fs.existsSync(join(global.authFilePath, 'creds.json'));
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

/**
 * Convierte los alias posicionales (`npm run qr` → `qr`, `npm run code` → `code`)
 * a `--method=...` y los retira de `process.argv` para que `yargs` en `main.js`
 * no los tome como prefijo de base de datos (`qr_database.json`).
 */
function normalizeCliArgs() {
  const args = process.argv.slice(2);
  const cleaned = [];
  let positionalMethod = null;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === 'qr' || lower === 'code') {
      positionalMethod ||= lower;
      continue;
    }
    cleaned.push(arg);
  }

  const hasMethodFlag = cleaned.some((arg) => arg.startsWith('--method='));
  const hasPhoneFlag = cleaned.some((arg) => arg === '--phone' || arg.startsWith('--phone='));
  if (!hasMethodFlag) {
    if (positionalMethod) cleaned.push(`--method=${positionalMethod}`);
    else if (hasPhoneFlag || global.botnumber) cleaned.push('--method=code');
  }

  process.argv.splice(2, process.argv.length - 2, ...cleaned);
}

async function askPhone(rl, signal) {
  while (true) {
    const rawPhone = await rl.question(
      chalk.hex(mint).bold('\n  ⟬ ✧ ⟭ Ingrese su número de WhatsApp:\n') +
      chalk.hex(softViolet)('  Ej: +51925092348\n') +
      chalk.hex(celeste)('  ──> '),
      { signal }
    );
    const phone = normalizePhone(rawPhone);
    if (phone) return phone;
    console.log(chalk.bgHex('#e63946').white.bold('\n [ ERROR ] Número inválido; usa el formato internacional, por ejemplo +51925092348.\n'));
  }
}

async function promptPairing({ phoneOnly = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  rl.once('close', () => ac.abort());
  try {
    if (phoneOnly) {
      const phone = await askPhone(rl, ac.signal);
      process.argv.push(`--phone=${phone}`);
      return;
    }

    while (true) {
      const choice = (await rl.question(
        chalk.hex(softViolet)('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n') +
        chalk.hex(mint).bold('  ⟬ ✦ ⟭ Seleccione un método de vinculación:\n') +
        chalk.hex(white)('  1. ✧ Escanear código QR\n') +
        chalk.hex(white)('  2. ✧ Código de 8 dígitos\n') +
        chalk.hex(celeste)('  ──> '),
        { signal: ac.signal }
      )).trim();

      if (choice === '1') {
        process.argv.push('--method=qr');
        return;
      }
      if (choice === '2') {
        const phone = await askPhone(rl, ac.signal);
        process.argv.push(`--phone=${phone}`, '--method=code');
        return;
      }
      console.log(chalk.hex('#e63946')('Opción no válida. Selecciona 1 o 2.\n'));
    }
  } catch (error) {
    if (error?.code === 'ERR_USE_AFTER_CLOSE' || error?.name === 'AbortError') {
      throw new Error('Se cerró la entrada estándar antes de elegir el método de vinculación. Usa --method=qr o --method=code --phone=+...');
    }
    throw error;
  } finally {
    rl.close();
  }
}

async function main() {
  normalizeCliArgs();
  acquireInstanceLock();
  printBanner();

  // Antes de cargar main.js (que instala gracefulShutdown), Ctrl+C no dispara
  // el evento 'exit' y dejaría el archivo de bloqueo en disco.
  const onEarlySignal = (code) => () => {
    releaseInstanceLock();
    process.exit(code);
  };
  const onSigInt = onEarlySignal(130);
  const onSigTerm = onEarlySignal(143);
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  try {
    if (!hasCredentials()) {
      const methodArg = process.argv.find((arg) => arg.startsWith('--method='));
      const hasPhone = Boolean(global.botnumber) || process.argv.some((arg) => arg === '--phone' || arg.startsWith('--phone='));
      if (!methodArg) {
        await promptPairing();
      } else if (methodArg === '--method=code' && !hasPhone) {
        await promptPairing({ phoneOnly: true });
      }
    }
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  }

  await import('./main.js');
}

main().catch((error) => {
  console.error(chalk.hex('#e63946').bold('❌ [ FATAL ERROR ]:'), error);
  releaseInstanceLock();
  process.exitCode = 1;
});
