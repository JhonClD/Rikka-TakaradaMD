process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
import './config.js';
import './api.js';
import { createRequire } from 'module';
import path, { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform } from 'process';
import os from 'os';
import fs, { readdirSync, statSync, unlinkSync, existsSync, readFileSync, watch } from 'fs';
import https from 'https';
import yargs from 'yargs';
import { spawn } from 'child_process';
import lodash from 'lodash';
import chalk from 'chalk';
import { format } from 'util';
import pino from 'pino';
import Pino from 'pino';
import { makeWASocket, protoType, serialize } from './src/libraries/simple.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import store from './src/libraries/store.js';
import { dbFile, TMP_DIR } from './src/funcion/paths.js';
import { STOP, classifyDisconnect, nextReconnectDelay, shouldAlertOwner, DEFAULT_POLICY as RECONNECT_POLICY } from './src/funcion/reconnect-policy.js';

const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser, withPairingGuard, createQRGuard } = await import("baileys");
// PHONENUMBER_MCC fue removido en itsliaaa/baileys — validacion por regex de codigo de pais
const _isValidCountryCode = (num) => /^[1-9]\d{0,14}$/.test(num);
import readline from 'readline';
import qrcodeTerminal from 'qrcode-terminal';
import NodeCache from 'node-cache';
const { chain } = lodash;
let stopped = 'close';
protoType();
serialize();
// stdTTL 0 en node-cache significa "no caduca nunca": con el bot varios días
// encendido estos dos cachés de Baileys crecían sin límite.
const msgRetryCounterCache = new NodeCache({ stdTTL: 10_000, checkperiod: 120 });
const userDevicesCache = new NodeCache({ stdTTL: 30_000, checkperiod: 120 });
// Nivel del logger interno de Baileys. 'silent' conserva el comportamiento
// actual; LOG_LEVEL=debug permite ver el handshake sin tocar el código.
const logLevel = process.env.LOG_LEVEL || 'silent';
const baileysLogger = () => pino({ level: logLevel });
// Reutiliza conexiones TLS del upload endpoint de WhatsApp entre envíos.
const mediaUploadAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 8,
  maxFreeSockets: 4,
  scheduling: 'lifo',
});
let socketReloadInProgress = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
// Vigilante del handshake: Baileys avisa con `close` casi siempre, pero hay
// desconexiones que no emiten nada (un TCP que se apaga sin FIN) y sin
// vigilancia el bot se queda con un socket que ni abre ni cierra.
let connectWatchdog = null;
// Sesión en un estado que ningún reintento arregla (logout, sesión reemplazada
// o inválida). Mientras esté activo no se programa ningún socket nuevo.
let terminalSession = false;
let terminalRetryTimer = null;
const qrGuard = createQRGuard({
  ttlMs: 60_000,
  onBlocked: () => console.log(chalk.gray('[ ℹ️ ] QR repetido ignorado; usa el último QR mostrado.')),
});

global.__filename = function filename(pathURL = import.meta.url, rmPrefix = platform !== 'win32') {
  return rmPrefix ? /file:\/\/\//.test(pathURL) ? fileURLToPath(pathURL) : pathURL : pathToFileURL(pathURL).toString();
}; global.__dirname = function dirname(pathURL) {
  return path.dirname(global.__filename(pathURL, true));
}; global.__require = function require(dir = import.meta.url) {
  return createRequire(dir);
};
global.timestamp = { start: new Date };
const __dirname = global.__dirname(import.meta.url);
const tmpDir = TMP_DIR;
fs.mkdirSync(tmpDir, { recursive: true });
global.opts = new Object(yargs(process.argv.slice(2)).exitProcess(false).parse());
global.prefix = new RegExp('^[#!/.]')
// --db con URL apuntaba a un cloudDBAdapter que nunca se importó (y que además
// pide `got`, ausente en package.json): reventaba con ReferenceError al
// arrancar. Se degrada a la base local en vez de romper el arranque.
const dbOption = String(global.opts['db'] || '');
if (/^https?:\/\//.test(dbOption)) {
  console.warn(chalk.yellow('[ ⚠️ ] --db con URL no está soportado en esta versión; se usará la base de datos local.'));
}
global.db = new Low(new JSONFile(dbFile(global.opts._?.[0] || '')), null);

global.loadDatabase = async function loadDatabase() {
  if (global.db.READ) {
    // Esperar con un setInterval dentro de `new Promise` dejaba un temporizador
    // vivo para siempre si la carga nunca terminaba (y la promesa no se
    // resolvía, congelando el handler). Se sondea con un tope de 30s.
    for (let attempt = 0; attempt < 120 && global.db.READ; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return global.db.data == null ? global.loadDatabase() : global.db.data;
  }
  if (global.db.data !== null) return;
  global.db.READ = true;
  await global.db.read().catch(console.error);
  global.db.READ = null;
  global.db.data = {
    users: {},
    chats: {},
    stats: {},
    msgs: {},
    sticker: {},
    settings: {},
    ...(global.db.data || {}),
  };
  global.db.chain = chain(global.db.data);
};
loadDatabase();

let { state, saveCreds } = await useMultiFileAuthState(global.authFilePath);
const version22 = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1033893291] }));
const version = version22?.version || [2, 3000, 1033893291];
console.log(chalk.gray(`[ ℹ️ ] Versión de WhatsApp: ${version.join('.')}`));
let phoneNumber = global.botnumber || process.argv.find(arg => arg.startsWith('--phone='))?.split('=')[1];
const methodCodeQR = process.argv.includes('--method=qr');
const methodCode = !!phoneNumber || process.argv.includes('--method=code');
const MethodMobile = process.argv.includes("mobile");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (texto) => new Promise((resolver) => rl.question(texto, resolver));

let opcion;
// Variables de estado para el pairing code (sobreviven reconexiones)
let pairingPhoneNumber = null;
let pairingCodeDone = false;
let pairingAttemptCount = 0;
let pairingRequestTimer = null;
if (methodCodeQR) opcion = '1';
if (!methodCodeQR && !methodCode && !fs.existsSync(join(global.authFilePath, 'creds.json'))) {
  do {
    opcion = await question('[ ℹ️ ] Seleccione una opción:\n1. Con código QR\n2. Con código de texto de 8 dígitos\n---> ');
    if (!/^[1-2]$/.test(opcion)) {
      console.log('[ ⚠️ ] Por favor, seleccione solo 1 o 2.\n');
    }
  } while (opcion !== '1' && opcion !== '2' || fs.existsSync(join(global.authFilePath, 'creds.json')));
}

const filterStrings = [
  "Q2xvc2luZyBzdGFsZSBvcGVu",
  "Q2xvc2luZyBvcGVuIHNlc3Npb24=",
  "RmFpbGVkIHRvIGRlY3J5cHQ=",
  "U2Vzc2lvbiBlcnJvcg==",
  "RXJyb3I6IEJhZCBNQUM=",
  "RGVjcnlwdGVkIG1lc3NhZ2U="
];

console.info = () => { };
console.debug = () => { };
['log', 'warn', 'error'].forEach(methodName => {
  const originalMethod = console[methodName];
  console[methodName] = function () {
    const message = arguments[0];
    if (typeof message === 'string' && filterStrings.some(filterString => message.includes(Buffer.from(filterString, 'base64').toString()))) {
      arguments[0] = "";
    }
    originalMethod.apply(console, arguments);
  };
});

const consoleErrorForOwnerAlerts = console.error.bind(console);
const pendingOwnerErrorAlerts = [];
// La cola solo se vacía con el socket abierto, así que durante una caída larga
// cada error de plugin dejaba otro aviso dentro: sin tope, un bot offline
// algunas horas acumulaba decenas de MB y luego los soltaba de golpe. Se
// conservan los más recientes y se suma un cartel con lo descartado.
const MAX_PENDING_OWNER_ALERTS = 50;
let droppedOwnerAlerts = 0;
const recentOwnerErrorAlerts = new Map();
let ownerErrorAlertFlushRunning = false;
let sendingOwnerErrorAlert = false;
function getOwnerErrorJid() {
  const configured = process.env.ERROR_REPORT_JID || process.env.TIO_ERROR_OWNER_JID;
  if (configured && configured.includes('@')) return configured;
  const owner = global.owner?.find(entry => entry?.[2]) || global.owner?.[0];
  const digits = String(owner?.[0] || '').replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}
async function flushOwnerErrorAlerts() {
  if (ownerErrorAlertFlushRunning) return;
  const target = global.conn;
  const ownerJid = getOwnerErrorJid();
  // No intentes enviar avisos usando un socket que ya recibió `close`.
  // En caso contrario cada error de un plugin genera otro error de conexión.
  if (stopped !== 'open' || target !== global.conn || !target?.sendMessage || !target?.user || !ownerJid) return;
  ownerErrorAlertFlushRunning = true;
  try {
    if (droppedOwnerAlerts > 0) {
      const dropped = droppedOwnerAlerts;
      droppedOwnerAlerts = 0;
      pendingOwnerErrorAlerts.unshift(
        `⚠️ Se descartaron ${dropped} aviso(s) anteriores por ir demasiado rápido (máx. ${MAX_PENDING_OWNER_ALERTS} en cola).`,
      );
    }
    while (pendingOwnerErrorAlerts.length) {
      const text = pendingOwnerErrorAlerts[0];
      try {
        sendingOwnerErrorAlert = true;
        await target.sendMessage(ownerJid, { text });
        pendingOwnerErrorAlerts.shift();
      } catch (error) {
        consoleErrorForOwnerAlerts('[Error alert] No se pudo enviar el aviso al owner:', error);
        break;
      } finally {
        sendingOwnerErrorAlert = false;
      }
    }
  } finally {
    ownerErrorAlertFlushRunning = false;
  }
}
global.notifyOwnerError = (...args) => {
  const details = format(...args).trim();
  if (!details || sendingOwnerErrorAlert) return;
  const now = Date.now();
  const fingerprint = (details.split(/\r?\n/, 1)[0] || details).slice(0, 2000);
  const previous = recentOwnerErrorAlerts.get(fingerprint);
  if (previous && now - previous < 60_000) return;
  recentOwnerErrorAlerts.set(fingerprint, now);
  for (const [key, timestamp] of recentOwnerErrorAlerts) {
    if (now - timestamp > 10 * 60_000) recentOwnerErrorAlerts.delete(key);
  }
  while (pendingOwnerErrorAlerts.length >= MAX_PENDING_OWNER_ALERTS) {
    pendingOwnerErrorAlerts.shift();
    droppedOwnerAlerts += 1;
  }
  pendingOwnerErrorAlerts.push(`🚨 *Error del bot (consola/plugin)*\n\n${details}`.slice(0, 3500));
  void flushOwnerErrorAlerts();
};
console.error = function (...args) {
  consoleErrorForOwnerAlerts.apply(console, args);
  if (!sendingOwnerErrorAlert) global.notifyOwnerError(...args);
};
const consoleWarnForOwnerAlerts = console.warn.bind(console);
console.warn = function (...args) {
  consoleWarnForOwnerAlerts.apply(console, args);
  const warning = format(...args);
  if (!sendingOwnerErrorAlert && (args.some(value => value instanceof Error) || /error|failed|failure|falló|fallo|no se pudo|exception|timed out|timeout/i.test(warning))) {
    global.notifyOwnerError('[Aviso de fallo]', ...args);
  }
};

const decodedFilterStrings = filterStrings
  .map((value) => {
    try {
      return Buffer.from(value, 'base64').toString();
    } catch {
      return '';
    }
  })
  .filter(Boolean);

// Ruido conocido de Baileys (sesiones cerradas, MAC inválida) que no aporta
// nada en la consola. err.message puede no ser un string: Buffer.from() dentro
// del propio handler mataba el proceso, así que aquí se normaliza primero.
const isFilteredError = (value) => {
  const message = typeof value === 'string' ? value : String(value?.message ?? value ?? '');
  return !!message && decodedFilterStrings.some((noise) => message.includes(noise));
};

process.on('uncaughtException', (err) => {
  if (isFilteredError(err)) return;
  console.error('Uncaught Exception:', err);
});

const connectionOptions = {
  logger: baileysLogger(),
  // El QR se imprime manualmente en connectionUpdate para evitar duplicados.
  printQRInTerminal: false,
  mobile: MethodMobile,
  browser: opcion === '1' ? ['Rikka-TakaradaMD', 'Safari', '2.0.0'] : methodCodeQR ? ['Rikka-TakaradaMD', 'Safari', '2.0.0'] : ['Ubuntu', 'Chrome', '20.0.04'],
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "fatal" }).child({ level: "fatal" })),
  },
  markOnlineOnConnect: false,
  generateHighQualityLinkPreview: false,
  syncFullHistory: false,
  getMessage: async (key) => {
    try {
      let jid = jidNormalizedUser(key.remoteJid);
      let msg = await store.loadMessage(jid, key.id);
      return msg?.message || "";
    } catch (error) {
      return "";
    }
  },
  msgRetryCounterCache,
  userDevicesCache,
  defaultQueryTimeoutMs: 20000,
  fetchAgent: mediaUploadAgent,
  cachedGroupMetadata: (jid) => global.conn.chats[jid]?.metadata ?? {},
  keepAliveIntervalMs: 30000,
  maxIdleTimeMs: 120000,
  version,
};

global.conn = makeWASocket(connectionOptions);
store?.bind(global.conn);
// El primer handshake también va vigilado: con credenciales válidas pero una
// red que no termina de conectar, no llegaba ni un `close` y había que
// reiniciar a mano. Con sesión sin registrar no se arma, que ahí lo que falta
// es un QR, no un reintento.
if (state.creds?.registered) armConnectWatchdog('arranque');

if (methodCode && !state.creds.registered) {
  withPairingGuard(global.conn, {
    maxPerHour: 3,
    globalMaxPerHour: 6,
    minIntervalMs: 60_000,
    logger: baileysLogger(),
  });
}

if (!fs.existsSync(join(global.authFilePath, 'creds.json'))) {
  if (opcion === '2' || methodCode) {
    opcion = '2';
    if (!conn.authState.creds.registered) {
      if (MethodMobile) throw new Error('No se puede usar un código de emparejamiento con la API móvil');

      let numeroTelefono;
      if (!!phoneNumber) {
        numeroTelefono = phoneNumber.replace(/[^0-9]/g, '');
        if (!_isValidCountryCode(numeroTelefono)) {
          console.log(chalk.bgBlack(chalk.bold.redBright("Comience con el código de país de su número de WhatsApp.\nEjemplo: +5219992095479\n")));
          process.exit(0);
        }
      } else {
        while (true) {
          numeroTelefono = await question(chalk.bgBlack(chalk.bold.yellowBright('Por favor, escriba su número de WhatsApp.\nEjemplo: +5219992095479\n')));
          numeroTelefono = numeroTelefono.replace(/[^0-9]/g, '');
          if (_isValidCountryCode(numeroTelefono)) break;
          console.log(chalk.bgBlack(chalk.bold.redBright("Por favor, escriba su número de WhatsApp.\nEjemplo: +5219992095479.\n")));
        }
        rl.close();
      }

      // Guardar número — el código se pedirá dentro de connectionUpdate
      // para sobrevivir reconexiones por badSession u otros errores
      pairingPhoneNumber = numeroTelefono;
      console.log(chalk.cyan(`[ ℹ️ ] Número guardado: ${pairingPhoneNumber} — esperando conexión WS...`));
    }
  }
}

// Solicitar el código después de crear el socket. Hacerlo desde
// connection.update puede repetir la solicitud durante el handshake y provocar
// que WhatsApp reemplace la conexión anterior. Se limita el número de intentos
// para no martillear el endpoint de pairing cuando WhatsApp devuelve un código
// inválido (rate limit).
const MAX_PAIRING_ATTEMPTS = 3;
const PAIRING_RETRY_DELAY_MS = 5_000;

function requestPairingCodeOnce() {
  if (pairingCodeDone || pairingAttemptCount >= MAX_PAIRING_ATTEMPTS) return;
  pairingAttemptCount += 1;
  void (async () => {
    try {
      if (state.creds.registered || !global.conn?.requestPairingCode) return;
      const raw = await global.conn.requestPairingCode(pairingPhoneNumber);
      const codigo = String(raw || '').replace(/[^A-Za-z0-9]/g, '');
      if (codigo.length !== 8) throw new Error(`WhatsApp devolvió un código inválido (${codigo.length} caracteres)`);
      pairingCodeDone = true;
      console.log(chalk.yellow('[ ℹ️ ] Introduce el código de emparejamiento en WhatsApp.'));
      console.log(chalk.black(chalk.bgGreen('Su código de emparejamiento: ')), chalk.black(chalk.bgWhite(` ${codigo.slice(0, 4)}-${codigo.slice(4)} `)));
    } catch (err) {
      console.log(chalk.red(`[ ⚠️ ] Error al obtener código (intento ${pairingAttemptCount}/${MAX_PAIRING_ATTEMPTS}): ${err.message}`));
      if (pairingAttemptCount < MAX_PAIRING_ATTEMPTS) {
        pairingRequestTimer = setTimeout(requestPairingCodeOnce, PAIRING_RETRY_DELAY_MS);
      }
    }
  })();
}

if (pairingPhoneNumber && !state.creds.registered) {
  pairingRequestTimer = setTimeout(requestPairingCodeOnce, 3000);
}

conn.isInit = false;
conn.well = false;
conn.logger.info(`[　ℹ️　] Cargando...\n`);

if (!opts['test']) {
  if (global.db) {
    setInterval(async () => {
      if (global.db.data) await global.db.write();
      if (opts['autocleartmp'] && (global.support || {}).find) {
        // os y cp no estaban importados: el `find` nunca se ejecutaba y el
        // ReferenceError quedaba tapado por el handler de unhandledRejection.
        const tmp = [os.tmpdir(), TMP_DIR].filter((dir) => dir && existsSync(dir));
        tmp.forEach((dir) => {
          spawn('find', [dir, '-amin', '3', '-type', 'f', '-delete']).on('error', (error) => {
            console.warn('[ ⚠️ ] No se pudo limpiar ', dir, error?.message || error);
          });
        });
      }
    }, 30 * 1000);
  }
}

function clearTmp() {
  const tmp = [tmpDir];
  const filename = [];
  tmp.forEach((dirname) => {
    if (!existsSync(dirname)) return;
    readdirSync(dirname).forEach((file) => filename.push(join(dirname, file)));
  });
  return filename.map((file) => {
    const stats = statSync(file);
    if (stats.isFile() && (Date.now() - stats.mtimeMs >= 1000 * 60 * 3)) return unlinkSync(file);
    return false;
  });
}

const dirToWatchccc = path.join(__dirname, './');
function deleteCoreFiles(filePath) {
  const coreFilePattern = /^core\.\d+$/i;
  const filename = path.basename(filePath);
  if (coreFilePattern.test(filename)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error eliminando el archivo ${filePath}:`, err);
    });
  }
}
fs.watch(dirToWatchccc, (eventType, filename) => {
  if (eventType === 'rename') {
    const filePath = path.join(dirToWatchccc, filename);
    fs.stat(filePath, (err, stats) => {
      if (!err && stats.isFile()) deleteCoreFiles(filePath);
    });
  }
});



async function connectionUpdate(update) {
  // Un socket viejo puede emitir eventos durante su cierre. Ignóralos para
  // evitar que vuelva a programar una reconexión después de crear el nuevo.
  if (this && this !== global.conn) return;
  const { connection, lastDisconnect, isNewLogin } = update;
  stopped = connection;
  if (isNewLogin) conn.isInit = true;

  if (global.db.data == null) loadDatabase();
  if (update.qr && (opcion == '1' || methodCodeQR) && qrGuard.handle(update.qr)) {
    qrcodeTerminal.generate(update.qr, { small: true }, (qr) => {
      console.log(qr);
      console.log(chalk.yellow('[　ℹ️　　] Escanea el código QR.'));
    });
  }
  if (connection == 'open') {
    const recoveredAfter = reconnectAttempt;
    reconnectAttempt = 0;
    terminalSession = false;
    clearPendingReconnect();
    if (recoveredAfter >= RECONNECT_POLICY.alertAfterAttempts) {
      console.log(chalk.yellow(`[　✅　　] Reconectado tras ${recoveredAfter} intentos.`));
    }
    // ── FIX DOBLE MENSAJE: registrar timestamp exacto de conexión ──
    global.timestamp.connect = new Date();
    console.log(chalk.yellow('[　ℹ️　　] Conectado correctamente.'));
    // Aquí había un `isFirstConnection = true;` sin declarar: en un módulo ES
    // (siempre estricto) lanzaba ReferenceError y cortaba la rama 'open' antes
    // del flush, de modo que los avisos acumulados durante la caída no se
    // entregaban hasta el siguiente error.
    void flushOwnerErrorAlerts();
  }
  const reason = lastDisconnect?.error?.output?.statusCode
    ?? lastDisconnect?.error?.output?.payload?.statusCode;
  const errorCounters = {};
  function shouldLogError(errorType) {
    if (!errorCounters[errorType]) errorCounters[errorType] = { count: 0, lastShown: 0 };
    const now = Date.now();
    const errorData = errorCounters[errorType];
    if (errorData.count >= 5) return false;
    if (now - errorData.lastShown < 2000) return false;
    errorData.count++;
    errorData.lastShown = now;
    return true;
  }
  if (reason == 405 || reason == 440 || reason === DisconnectReason.connectionReplaced) {
    // No reintentar aquí: cada socket nuevo invalida el anterior y mantiene
    // el conflicto activo (405/440). El usuario debe cerrar las sesiones
    // vinculadas y arrancar una única vez para obtener un código nuevo.
    console.log(chalk.bold.redBright('[ ⚠️ ] WhatsApp rechazó esta sesión porque fue reemplazada (405/440).'));
    console.log(chalk.yellow('[ ℹ️ ] Cierra todas las sesiones en WhatsApp > Dispositivos vinculados, detén el servidor y vuelve a iniciar una sola vez.'));
    markTerminalSession('sesión reemplazada (405/440)');
    return;
  }
  if (connection === 'close') {
    if (reason === DisconnectReason.badSession) {
      if (shouldLogError('badSession')) {
        conn.logger.error(`[ ⚠️ ] Sesión incorrecta, por favor elimina la carpeta ${global.authFile} y escanea nuevamente.`);
      }
      markTerminalSession('sesión inválida (badSession)');
    } else if (reason === DisconnectReason.connectionClosed) {
      if (shouldLogError('connectionClosed')) {
        conn.logger.warn(`[ ⚠️ ] Conexión cerrada, reconectando...`);
      }
      scheduleSocketReconnect('connectionClosed');
    } else if (reason === DisconnectReason.connectionLost) {
      if (shouldLogError('connectionLost')) {
        conn.logger.warn(`[ ⚠️ ] Conexión perdida con el servidor, reconectando...`);
      }
      scheduleSocketReconnect('connectionLost');
    } else if (reason === DisconnectReason.connectionReplaced) {
      // Ya manejado por el bloque reason == 405 con delay
    } else if (reason === DisconnectReason.loggedOut) {
      if (shouldLogError('loggedOut')) {
        conn.logger.error(`[ ⚠️ ] Conexion cerrada, por favor elimina la carpeta ${global.authFile} y escanea nuevamente.`);
      }
      markTerminalSession('sesión cerrada desde el teléfono (loggedOut)');
    } else if (reason === DisconnectReason.restartRequired) {
      if (shouldLogError('restartRequired')) {
        conn.logger.info(`[ ⚠️ ] Reinicio necesario, reconectando...`);
      }
      scheduleSocketReconnect('restartRequired');
    } else if (reason === DisconnectReason.timedOut) {
      if (shouldLogError('timedOut')) {
        conn.logger.warn(`[ ⚠️ ] Tiempo de conexión agotado, reconectando...`);
      }
      scheduleSocketReconnect('timedOut');
    } else {
      const unknownError = `unknown_${reason || ''}_${connection || ''}`;
      if (shouldLogError(unknownError)) {
        conn.logger.warn(`[ ⚠️ ] Razón de desconexión desconocida. ${reason || ''}: ${connection || ''}`);
      }
      // Motivo que no conocemos: se consulta la misma tabla que usan los
      // anteriores, porque WhatsApp inventa códigos nuevos de vez en cuando y
      // un código de sesión revocada no debe entrar en bucle.
      if (classifyDisconnect(reason, DisconnectReason) === STOP) {
        markTerminalSession(`motivo ${reason ?? 'desconocido'}`);
      } else {
        scheduleSocketReconnect(`unknown_${reason || 'none'}`);
      }
    }
  }
}

function clearConnectWatchdog() {
  if (!connectWatchdog) return;
  clearTimeout(connectWatchdog);
  connectWatchdog = null;
}

/** Descarta todo lo programado: reconexión, vigilante y latido terminal. */
function clearPendingReconnect() {
  clearConnectWatchdog();
  if (terminalRetryTimer) {
    clearTimeout(terminalRetryTimer);
    terminalRetryTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * La sesión exige acción humana. Se tiran los reintentos en cola: recrear el
 * socket con credenciales rechazadas no arregla nada, gasta el rate limit de
 * emparejamiento y puede dejar dos sesiones peleando por el mismo número (que
 * es precisamente como se entra en 405/440).
 */
function markTerminalSession(hint) {
  terminalSession = true;
  clearPendingReconnect();
  console.log(chalk.gray(`[ ℹ️ ] Reconexiones en pausa: ${hint}.`));
  if (terminalRetryTimer || shutdownStarted) return;
  terminalRetryTimer = setTimeout(() => {
    terminalRetryTimer = null;
    // Un solo intento, y solo si nadie reconectó ya ni se está apagando. Si
    // vuelve a caer, entrará aquí otra vez: es un latido de 5 minutos, no un bucle.
    if (shutdownStarted || stopped === 'open') return;
    terminalSession = false;
    console.log(chalk.gray('[ ℹ️ ] Se reintenta una vez tras el estado terminal de la sesión.'));
    scheduleSocketReconnect('terminal-retry');
  }, RECONNECT_POLICY.terminalRetryMs);
}

function armConnectWatchdog(reason) {
  clearConnectWatchdog();
  connectWatchdog = setTimeout(() => {
    connectWatchdog = null;
    // Si ya hay otro intento en cola (llegó un `close` mientras tanto), no hay
    // nada que duplicar: ese temporizador hace su trabajo mejor cronometrado.
    if (terminalSession || reconnectTimer || socketReloadInProgress || stopped === 'open') return;
    // Si no hay credenciales registradas hace falta escanear el QR: reintentar
    // en bucle solo volvería a imprimir códigos que nadie va a usar.
    if (!global.conn?.authState?.creds?.registered) {
      console.log(chalk.gray('[ ℹ️ ] Sin sesión registrada; se espera el QR en lugar de reintentar.'));
      return;
    }
    console.log(chalk.gray(`[ ℹ️ ] El socket no llegó a abrir tras "${reason}"; se reintenta.`));
    scheduleSocketReconnect(`watchdog:${reason}`);
  }, RECONNECT_POLICY.connectTimeoutMs);
}

function notifyReconnectTrouble(attempt) {
  if (!shouldAlertOwner(attempt, RECONNECT_POLICY)) return;
  // console.error realimenta el pipeline de avisos al owner (está interceptado
  // más arriba), así que el aviso no se pierde: sale por WhatsApp en cuanto el
  // socket vuelva a abrir, y se agrupa si hubo muchos errores de por medio.
  console.error(
    `[Socket] ${attempt} intentos seguidos sin reconectar. Si fue un corte de red, `
    + 'el bot sigue reintentando solo; si la sesión fue revocada hay que volver a '
    + 'vincular el dispositivo.',
  );
}

function scheduleSocketReconnect(reason) {
  // `shutdownStarted` importa: durante el apagado llegaba a crearse un socket
  // nuevo justo después de cerrar el viejo, porque el `close` del cierre
  // programado reentraba aquí.
  if (terminalSession || reconnectTimer || shutdownStarted) return;
  const delay = nextReconnectDelay(reconnectAttempt, RECONNECT_POLICY);
  reconnectAttempt += 1;
  console.log(chalk.gray(
    `[ ℹ️ ] Reconexión programada en ${Math.ceil(delay / 1000)}s (${reason}), intento ${reconnectAttempt}.`,
  ));
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      const reloaded = await global.reloadHandler(true);
      // reloadHandler(true) devuelve false cuando otro recargue va en curso.
      // Antes ese valor se tiraba a la basura y el intento desaparecía sin dejar
      // nada programado: el bot se quedaba offline hasta el reinicio manual.
      if (reloaded === false) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          scheduleSocketReconnect(`busy:${reason}`);
        }, RECONNECT_POLICY.baseMs * 2);
        return;
      }
    } catch (error) {
      console.error('[Socket] Falló la reconexión:', error);
      notifyReconnectTrouble(reconnectAttempt);
      scheduleSocketReconnect('retry');
      return;
    }
    if (stopped !== 'open') {
      armConnectWatchdog(reason);
      notifyReconnectTrouble(reconnectAttempt);
    }
  }, delay);
}


let isInit = true;
const handlerPath = join(__dirname, 'handler.js');
/** mtime de handler.js en el último import real (ver global.reloadHandler). */
let handlerLoadedAt = statSync(handlerPath).mtimeMs;
let handler = await import('./handler.js');

async function refreshAuthState() {
  const freshAuth = await useMultiFileAuthState(global.authFilePath)
  state = freshAuth.state
  saveCreds = freshAuth.saveCreds
  connectionOptions.auth = {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'fatal' }).child({ level: 'fatal' })),
  }
}

global.reloadHandler = async function (restatConn) {
  try {
    // Cada reconexión reimportaba handler.js con `?update=${Date.now()}`, y un
    // especificador nuevo es para ESM un módulo NUEVO que además no se puede
    // expulsar del caché: en una tormenta de reintentos (1s, 2s, 4s…) cada
    // intento dejaba otra copia del grafo de módulos residente. Se vuelve a
    // importar solo si el archivo cambió; en desarrollo (--dev) se fuerza, que
    // es justo cuando interesa ver cada guardado.
    const loadedAt = statSync(handlerPath).mtimeMs;
    if (loadedAt !== handlerLoadedAt || global.opts?.dev) {
      handlerLoadedAt = loadedAt;
      const Handler = await import(`${pathToFileURL(handlerPath).href}?update=${loadedAt}`).catch(console.error);
      if (Object.keys(Handler || {}).length) handler = Handler;
    }
  } catch (error) {
    console.error('[handler] no se pudo revisar handler.js:', error?.message || error);
  }
  if (restatConn) {
    if (socketReloadInProgress) return false;
    socketReloadInProgress = true;
    const oldConn = global.conn;
    try {
      // El patrón de Yuki es cerrar completamente la instancia anterior.
      // No reutilizamos su EventEmitter ni sus listeners, porque Baileys puede
      // emitir eventos tardíos del WebSocket que ya murió.
      oldConn?.ev?.removeAllListeners?.();
      try { oldConn?.ws?.close?.(); } catch {}
      try { oldConn?.end?.(new Error('socket-replaced')); } catch {}

      stopped = 'connecting';
      // Recargar la sesión en cada intento, como AlyaBot, para no reutilizar
      // creds/keys obsoletos después de un cierre prolongado.
      await refreshAuthState();
      global.conn = makeWASocket(connectionOptions);
      store?.bind(global.conn);
      isInit = true;
    }
    finally {
      socketReloadInProgress = false;
    }
  }

  const activeConn = global.conn;
  if (!isInit) {
    activeConn.ev.off('messages.upsert', activeConn.handler);
    activeConn.ev.off('group-participants.update', activeConn.participantsUpdate);
    activeConn.ev.off('groups.update', activeConn.groupsUpdate);
    activeConn.ev.off('message.delete', activeConn.onDelete);
    activeConn.ev.off('call', activeConn.onCall);
    activeConn.ev.off('connection.update', activeConn.connectionUpdate);
    activeConn.ev.off('creds.update', activeConn.credsUpdate);
  }

  activeConn.handler = handler.handler.bind(activeConn);

  activeConn.participantsUpdate = handler.participantsUpdate.bind(activeConn);
  activeConn.groupsUpdate = handler.groupsUpdate.bind(activeConn);
  activeConn.onDelete = handler.deleteUpdate.bind(activeConn);
  activeConn.onCall = handler.callUpdate.bind(activeConn);
  activeConn.connectionUpdate = connectionUpdate.bind(activeConn);
  activeConn.credsUpdate = saveCreds.bind(activeConn, true);

  activeConn.ev.on('messages.upsert', activeConn.handler);
  activeConn.ev.on('group-participants.update', activeConn.participantsUpdate);
  activeConn.ev.on('groups.update', activeConn.groupsUpdate);
  activeConn.ev.on('message.delete', activeConn.onDelete);
  activeConn.ev.on('call', activeConn.onCall);
  activeConn.ev.on('connection.update', activeConn.connectionUpdate);
  activeConn.ev.on('creds.update', activeConn.credsUpdate);


  isInit = false;
  return true;
};
;

// Los plugins viven directamente en ./plugins; no existe una subcarpeta index.
const pluginFolder = join(__dirname, './plugins');
const pluginFilter = (filename) => /\.js$/.test(filename);
global.plugins = {};

async function filesInit() {
  for (const filename of readdirSync(pluginFolder).filter(pluginFilter)) {
    try {
      const file = global.__filename(join(pluginFolder, filename));
      const module = await import(file);
      global.plugins[filename] = module.default || module;
    } catch (e) {
      conn.logger.error(e);
      global.notifyOwnerError?.(`No se pudo importar el plugin ${filename}:`, e);
      delete global.plugins[filename];
    }
  }
}
await filesInit();

global.reload = async (_ev, filename) => {
  if (pluginFilter(filename)) {
    const dir = global.__filename(join(pluginFolder, filename), true);
    if (filename in global.plugins) {
      if (existsSync(dir)) conn.logger.info(` updated plugin - '${filename}'`);
      else {
        conn.logger.warn(`deleted plugin - '${filename}'`);
        return delete global.plugins[filename];
      }
    } else conn.logger.info(`new plugin - '${filename}'`);
    // La validación previa con `syntax-error` se retiró a propósito: usa acorn
    // con ecmaVersion 2020 y marcaba como error sintaxis que Node ya ejecuta
    // sin problema (`||=`, `&&=`, `??=`, separadores numéricos `1_000`). Con un
    // falso positivo el plugin ni siquiera se importaba, así que un `||=`
    // dejaba `speedtest.js` fuera y rompía también a quien lo importara.
    // Node es el único juez válido: si el import falla, `import()` ya devuelve
    // el SyntaxError con línea y columna exactas.
    try {
      const module = (await import(`${global.__filename(dir)}?update=${Date.now()}`));
      global.plugins[filename] = module.default || module;
    } catch (e) {
      const esSintaxis = e instanceof SyntaxError;
      conn.logger.error(`${esSintaxis ? 'syntax error while loading' : 'error require plugin'} '${filename}'\n${format(e)}`);
      global.notifyOwnerError?.(`${esSintaxis ? 'Error de sintaxis en el plugin' : 'No se pudo recargar el plugin'} ${filename}:`, e);
    } finally {
      global.plugins = Object.fromEntries(Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b)));
    }
  }
};
Object.freeze(global.reload);
watch(pluginFolder, global.reload);
await global.reloadHandler();

setInterval(async () => {
  if (stopped === 'close' || !conn || !conn?.user) return;
  await clearTmp();
}, 180000);

setInterval(async () => {
  if (stopped === 'close' || !conn || !conn?.user) return;
  const _uptime = process.uptime() * 1000;
  const uptime = clockString(_uptime);
  const bio = `• Activo: ${uptime} | Rikka-TakaradaMD`;
  await conn?.updateProfileStatus(bio).catch((_) => _);
}, 10 * 60 * 1000); // cada 10 minutos (antes: 60s)


function clockString(ms) {
  const d = isNaN(ms) ? '--' : Math.floor(ms / 86400000);
  const h = isNaN(ms) ? '--' : Math.floor(ms / 3600000) % 24;
  const m = isNaN(ms) ? '--' : Math.floor(ms / 60000) % 60;
  const s = isNaN(ms) ? '--' : Math.floor(ms / 1000) % 60;
  return [d, 'd ', h, 'h ', m, 'm ', s, 's '].map((v) => v.toString().padStart(2, 0)).join('');
}

let shutdownStarted = false;
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopped = 'close';
  // Apagando: ningún reintento pendiente debe volver a crear un socket (el
  // `close` provocado por nuestro propio cierre entraba aquí y reprogramaba).
  terminalSession = true;
  clearPendingReconnect();
  console.log(`[ SHUTDOWN ] ${signal}: guardando datos y cerrando WhatsApp...`);
  if (pairingRequestTimer) {
    clearTimeout(pairingRequestTimer);
    pairingRequestTimer = null;
  }
  try {
    await global.db?.write?.();
  } catch (error) {
    console.error('[ SHUTDOWN ] No se pudo guardar la base local:', error);
  }
  try {
    global.conn?.ev?.removeAllListeners?.();
    global.conn?.ws?.close?.();
  } catch (error) {
    console.error('[ SHUTDOWN ] No se pudo cerrar el socket:', error);
  }
  process.exit(0);
}

process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

// Registrar este handler desactiva el crash por defecto de Node: si solo se
// loguea el caso LID, cualquier otra promesa rechazada queda silenciosa.
process.on('unhandledRejection', (reason) => {
  if (isFilteredError(reason)) return;
  const error = reason instanceof Error ? reason : new Error(String(reason?.message ?? reason));
  const isLidError = /\blid\b/i.test(error.message || '');
  console.error(isLidError ? '❌ Error no manejado relacionado con LID:' : '❌ Promesa rechazada sin manejo:', error);
});

async function _quickTest() {
  const test = await Promise.all([
    spawn('ffmpeg'),
    spawn('ffprobe'),
    spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex', 'color', '-frames:v', '1', '-f', 'webp', '-']),
    spawn('convert'),
    spawn('magick'),
    spawn('gm'),
    spawn('find', ['--version']),
  ].map((p) => {
    return Promise.race([
      new Promise((resolve) => {
        p.on('close', (code) => {
          resolve(code !== 127);
        });
      }),
      new Promise((resolve) => {
        p.on('error', (_) => resolve(false));
      })]);
  }));
  const [ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find] = test;
  global.support = { ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find };
  Object.freeze(global.support);
}
