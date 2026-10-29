import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import cfonts from 'cfonts';
import readline from 'readline';
import chalk from 'chalk';
import fs from 'fs';
import './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { say } = cfonts;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const instanceLock = join('/tmp', 'rikka-takarada-md.lock');
let lockAcquired = false;

function acquireInstanceLock() {
  try {
    const fd = fs.openSync(instanceLock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    lockAcquired = true;
  } catch (error) {
    try {
      const pid = Number(fs.readFileSync(instanceLock, 'utf8').trim());
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          throw new Error(`Ya existe otra instancia de Rikka (PID ${pid}).`);
        } catch (probeError) {
          if (probeError.code === 'ESRCH') {
            fs.unlinkSync(instanceLock);
            return acquireInstanceLock();
          }
          if (probeError.message?.startsWith('Ya existe otra instancia')) throw probeError;
          throw probeError;
        }
      }
      fs.unlinkSync(instanceLock);
      return acquireInstanceLock();
    } catch (lockError) {
      if (lockError.message?.startsWith('Ya existe otra instancia')) throw lockError;
      try { fs.unlinkSync(instanceLock); } catch {}
      return acquireInstanceLock();
    }
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

const ask = (text) => new Promise((resolve) => rl.question(text, resolve));
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
  return fs.existsSync(join(__dirname, global.authFile, 'creds.json'));
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
}

async function choosePairingMethod() {
  while (true) {
    const choice = (await ask(
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
      const rawPhone = await ask(
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
}

async function main() {
  acquireInstanceLock();
  printBanner();

  if (!hasCredentials() && !process.argv.some((arg) => arg.startsWith('--method='))) {
    await choosePairingMethod();
  }

  // Evita que la interfaz del menú compita por stdin con el proceso principal.
  rl.close();

  // Baileys, la base de datos, los plugins y los eventos corren en este proceso.
  // No hay worker, cluster ni canal IPC que pueda tragarse la salida o los comandos.
  await import('./main.js');
}

main().catch((error) => {
  console.error(chalk.hex('#e63946').bold('❌ [ FATAL ERROR ]:'), error);
  releaseInstanceLock();
  process.exitCode = 1;
});
