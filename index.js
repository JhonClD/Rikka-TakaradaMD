import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { setupMaster, fork } from 'cluster';
import cfonts from 'cfonts';
import readline from 'readline';
import yargs from 'yargs';
import chalk from 'chalk'; 
import fs from 'fs'; 
import './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(__dirname);
const { say } = cfonts;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let isRunning = false;
let childProcess = null;

const question = (texto) => new Promise((resolver) => rl.question(texto, resolver));

// Nueva Paleta de Colores
const mint = '#b2f7ef';     // Verde Menta
const celeste = '#8ecae6';  // Celeste (Sky Blue)
const softViolet = '#dec0f1'; // Violeta suave
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
  let formattedNumber = numero.replace(/[^\d+]/g, '');
  if (formattedNumber.startsWith('+52') && !formattedNumber.startsWith('+521')) {
    formattedNumber = formattedNumber.replace('+52', '+521');
  } else if (formattedNumber.startsWith('52') && !formattedNumber.startsWith('521')) {
    formattedNumber = `+521${formattedNumber.slice(2)}`;
  } else if (formattedNumber.startsWith('52') && formattedNumber.length >= 12) {
    formattedNumber = `+${formattedNumber}`;
  } else if (!formattedNumber.startsWith('+')) {
    formattedNumber = `+${formattedNumber}`;
  }
  return formattedNumber;
}

function esNumeroValido(numeroTelefono) {
  const regex = /^\+\d{7,15}$/;
  return regex.test(numeroTelefono);
}

async function start(file) {
  if (isRunning) return;
  isRunning = true;

  // Título con degradado Menta -> Violeta
  say('RIKKA TAKARADA\nBOT', {
    font: 'block',
    align: 'center',
    colors: [mint, softViolet],
    background: 'transparent',
    letterSpacing: 1,
    lineHeight: 1,
    space: true,
    gradient: true,
  });

  // Créditos en Celeste (como pediste)
  say(`Bot creado por JhonCID`, {
    font: 'console',
    align: 'center',
    colors: [celeste],
  });

  verificarOCrearCarpetaAuth();

  if (verificarCredsJson()) {
    const args = [join(__dirname, file), ...process.argv.slice(2)];
    setupMaster({ exec: args[0], args: args.slice(1) });
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
      chalk.hex(softViolet)('  Ej: +51925092348\n') + 
      chalk.hex(celeste)('  ──> ')
    );
    const numeroTelefono = formatearNumeroTelefono(phoneNumber);
    
    if (!esNumeroValido(numeroTelefono)) {
      console.log(chalk.bgHex('#e63946').white.bold('\n [ ERROR ] El formato del número es incorrecto. \n'));
      process.exit(0);
    }
    
    process.argv.push('--phone=' + numeroTelefono);
    process.argv.push('--method=code');
  } else if (opcion === '1') {
    process.argv.push('--method=qr');
  }
  
  const args = [join(__dirname, file), ...process.argv.slice(2)];
  setupMaster({ exec: args[0], args: args.slice(1) });
  forkProcess(file);
}

function forkProcess(file) {
  childProcess = fork();

  childProcess.on('message', (data) => {
    console.log(chalk.hex(celeste).bold('『 INFO 』'), data);
    switch (data) {
      case 'reset':
        console.log(chalk.hex(mint).bold('『 ✦ 』Reinicio en curso...'));
        childProcess.removeAllListeners();
        childProcess.kill('SIGTERM');
        isRunning = false;
        setTimeout(() => start(file), 1000);
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
    
    if (code !== 0 || signal === 'SIGTERM') {
      console.log(chalk.hex(mint).bold('『 ✦ 』Reiniciando...'));
      setTimeout(() => start(file), 1000);
    }
  });

  const opts = yargs(process.argv.slice(2)).argv;
  if (!opts.test) {
    rl.on('line', (line) => {
      childProcess.emit('message', line.trim());
    });
  }
}

try {
  start('main.js');
} catch (error) {
  console.error(chalk.hex('#e63946').bold('❌ [ FATAL ERROR ]:'), error);
  process.exit(1);
  }
