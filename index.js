import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import cluster from 'node:cluster';
import cfonts from 'cfonts';
import readline from 'readline';
import yargs from 'yargs';
import chalk from 'chalk'; 
import fs from 'fs'; 
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { say } = cfonts;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let isRunning = false;
let childProcess = null;
let shuttingDown = false;

// WhatsApp devuelve 405/440 si dos procesos usan la misma sesión. El bloqueo
// evita duplicados de esta instalación sin bloquear otras instalaciones del host.
const lockIdentity = `${process.getuid?.() ?? 'user'}:${fs.realpathSync(__dirname)}`;
const lockHash = createHash('sha256').update(lockIdentity).digest('hex').slice(0, 16);
const instanceLock = join(tmpdir(), `rikka-takarada-md-${lockHash}.lock`);
function acquireInstanceLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    let created = false;
    try {
      const fd = fs.openSync(instanceLock, 'wx', 0o600);
      created = true;
      try {
        fs.writeSync(fd, `${process.pid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (error) {
      if (created) {
        try { fs.unlinkSync(instanceLock); } catch {}
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;

      let lockStat;
      let pid;
      try {
        lockStat = fs.statSync(instanceLock);
        const pidText = fs.readFileSync(instanceLock, 'utf8').trim();
        if (!/^\d+$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) < 1) {
          throw new Error(`El archivo de bloqueo ${instanceLock} no contiene un PID válido; revísalo manualmente.`);
        }
        pid = Number(pidText);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }

      let processExists = true;
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (probeError.code === 'ESRCH') processExists = false;
        else throw new Error(`No se pudo verificar el PID ${pid} del bloqueo ${instanceLock}: ${probeError.message}`);
      }
      if (processExists) {
        throw new Error(`Ya existe otra instancia de Rikka (PID ${pid}). Deteniendo esta instancia.`);
      }

      try {
        const currentStat = fs.statSync(instanceLock);
        if (currentStat.dev === lockStat.dev && currentStat.ino === lockStat.ino) fs.unlinkSync(instanceLock);
      } catch (staleLockError) {
        if (staleLockError.code !== 'ENOENT') throw staleLockError;
      }
    }
  }
  throw new Error(`No se pudo adquirir el bloqueo de instancia tras varios intentos: ${instanceLock}`);
}
try {
  acquireInstanceLock();
} catch (error) {
  console.error(chalk.red(`[ ERROR ] ${error.message}`));
  process.exit(1);
}
const releaseInstanceLock = () => {
  try {
    if (Number(fs.readFileSync(instanceLock, 'utf8').trim()) === process.pid) fs.unlinkSync(instanceLock);
  } catch {}
};
process.once('exit', releaseInstanceLock);
function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();

  const child = childProcess;
  if (!child) {
    releaseInstanceLock();
    process.exit(0);
    return;
  }

  const finishShutdown = () => {
    clearTimeout(forceKillTimer);
    releaseInstanceLock();
    process.exit(0);
  };
  const forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  forceKillTimer.unref();
  child.once('exit', finishShutdown);
  if (!child.kill(signal) && (child.exitCode !== null || child.signalCode !== null)) finishShutdown();
}
process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

const question = (texto) => new Promise((resolver) => rl.question(texto, resolver));

// Paleta Soft-Cyber
const mint = '#b2f7ef';     
const celeste = '#8ecae6';  
const softViolet = '#dec0f1'; 
const white = '#f8f9fa';

console.log(chalk.hex(mint).bold('『 ✦ 』Iniciando sistema...'));

function verificarOCrearCarpetaAuth() {
  const authPath = join(__dirname, global.authFile);
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }
}

function verificarCredsJson() {
  const credsPath = join(__dirname, global.authFile, 'creds.json');
  return fs.existsSync(credsPath);
}

function formatearNumeroTelefono(numero) {
  const parsed = parsePhoneNumberFromString(numero.trim());
  return parsed?.isValid() ? parsed.number : null;
}

async function start(file) {
  if (isRunning) return;
  isRunning = true;

  // Título Completo: RIKKA TAKARADA
  say('RIKKA\nTAKARADA', {
    font: 'block',
    align: 'center',
    colors: [mint, softViolet],
    background: 'transparent',
    letterSpacing: 1,
    lineHeight: 1,
    space: true,
    gradient: true,
  });

  // Créditos en Celeste
  say(`Bot creado por JhonCID`, {
    font: 'console',
    align: 'center',
    colors: [celeste],
  });

  verificarOCrearCarpetaAuth();

  if (verificarCredsJson()) {
    const args = [join(__dirname, file), ...process.argv.slice(2)];
    cluster.setupPrimary({ exec: args[0], args: args.slice(1) });
    forkProcess(file);
    return;
  }

  console.log(chalk.hex(softViolet)('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  const opcion = await question(
    chalk.hex(mint).bold('  ⟬ ✦ ⟭ Seleccione un método de vinculación:\n') + 
    chalk.hex(white)('  1. ✧ Escanear código QR\n') + 
    chalk.hex(white)('  2. ✧ Código de 8 dígitos\n') + 
    chalk.hex(celeste)('  ──> ')
  );

  if (opcion === '2') {
    const phoneNumber = await question(
      chalk.hex(mint).bold('\n  ⟬ ✧ ⟭ Ingrese su número de WhatsApp:\n') + 
      chalk.hex(softViolet)('  Formato internacional, con + y código de país. Ej: +51925092348\n') +
      chalk.hex(celeste)('  ──> ')
    );
    const numeroTelefono = formatearNumeroTelefono(phoneNumber);
    
    if (!numeroTelefono) {
      console.log(chalk.bgHex('#e63946').white.bold('\n [ ERROR ] Número no válido. Ingresa un número internacional real, como +51925092348. \n'));
      process.exit(1);
    }
    
    process.argv.push('--phone=' + numeroTelefono);
    process.argv.push('--method=code');
  } else if (opcion === '1') {
    process.argv.push('--method=qr');
  }
  
  const args = [join(__dirname, file), ...process.argv.slice(2)];
  cluster.setupPrimary({ exec: args[0], args: args.slice(1) });
  forkProcess(file);
}

function forkProcess(file) {
  childProcess = cluster.fork();

  childProcess.on('message', (data) => {
    console.log(chalk.hex(celeste).bold('『 INFO 』'), data);
    switch (data) {
      case 'reset':
        console.log(chalk.hex(mint).bold('『 ✦ 』Reinicio en curso...'));
        childProcess.kill('SIGTERM');
        break;
      case 'uptime':
        childProcess.send(process.uptime());
        break;
    }
  });

  childProcess.on('exit', (code, signal) => {
    console.log(chalk.hex(softViolet).bold(`『 ! 』Proceso finalizado (${code || signal})`));
    isRunning = false;
    childProcess = null;
    
    if (!shuttingDown && (code !== 0 || signal === 'SIGTERM')) {
      console.log(chalk.hex(mint).bold('『 ✦ 』Reiniciando...'));
      setTimeout(() => start(file), 1000);
    }
  });
}

const opts = yargs(process.argv.slice(2)).argv;
if (!opts.test) {
  rl.on('line', (line) => {
    if (!childProcess || shuttingDown) return;
    childProcess.emit('message', line.trim());
  });
}

start('main.js').catch((error) => {
  console.error(chalk.hex('#e63946').bold('❌ [ FATAL ERROR ]:'), error);
  process.exit(1);
});
