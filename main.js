process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
import './config.js';
import './api.js';
import path, { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform } from 'process';
import fs, { readdirSync, statSync, unlinkSync, existsSync, watch } from 'fs';
import https from 'https';
import { createInterface } from 'node:readline/promises';
import yargs from 'yargs';
import chalk from 'chalk';
import { format } from 'util';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import NodeCache from 'node-cache';
import { makeWASocket, protoType, serialize } from './src/libraries/simple.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import store from './src/libraries/store.js';
import { dbFile, TMP_DIR } from './src/funcion/paths.js';
import { RECONNECT, STOP, classifyDisconnect, nextReconnectDelay, shouldAlertOwner, DEFAULT_POLICY as RECONNECT_POLICY } from './src/funcion/reconnect-policy.js';
import { patchBaileysSourceFiles } from './src/funcion/baileys-pairing-fix.js';
import {
  DOWNTIME_PURGE_AGE_MS,
  STALE_ROUTING_AGE_MS,
  createDecryptFailureMonitor,
  getCredsAgeMs,
  hasRegisteredCredentials,
  isAuthenticatedCreds,
  isIgnorableDecryptFailure,
  isPreKeyDecryptError,
  isResettablePeerJid,
  prepareAuthFolder,
  wrapSafeSaveCreds,
} from './src/funcion/session-health.js';

patchBaileysSourceFiles();

const {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  useMultiFileAuthState,
  fetchBestWaVersion,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  repairAuthState,
  isRateLimitError,
  createQRGuard,
} = await import('baileys');

// PHONENUMBER_MCC fue removido en itsliaaa/baileys — validación E.164 básica (7 a 15 dígitos sin cero inicial)
const isValidPhoneNumber = (num) => /^[1-9]\d{6,14}$/.test(num);

let stopped = 'close';
protoType();
serialize();
// stdTTL en node-cache está en SEGUNDOS: 1 h para reintentos y 5 min para
// listas de dispositivos (alineado con DEFAULT_CACHE_TTLS de Baileys) para no
// retener dispositivos caducados durante horas tras un reinicio o cambio de sesión.
const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const userDevicesCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
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
let shutdownStarted = false;
let socketReloadInProgress = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let consecutiveBadSessions = 0;
let pendingEphemeralPurge = false;
let lastOpenedAt = 0;
const decryptFailureMonitor = createDecryptFailureMonitor();
// Vigilante del handshake: Baileys avisa con `close` casi siempre, pero hay
// desconexiones que no emiten nada (un TCP que se apaga sin FIN) y sin
// vigilancia el bot se queda con un socket que ni abre ni cierra.
let connectWatchdog = null;
// Sesión en un estado que ningún reintento arregla (logout, sesión reemplazada
// o badSession persistente). Mientras esté activo no se programa ningún socket nuevo.
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
};
global.timestamp = { start: new Date() };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = TMP_DIR;
fs.mkdirSync(tmpDir, { recursive: true });
global.opts = yargs(process.argv.slice(2)).exitProcess(false).parse();
global.prefix = new RegExp('^[#!/.]');
// --db con URL apuntaba a un cloudDBAdapter que nunca se importó (y que además
// pide `got`, ausente en package.json): reventaba con ReferenceError al
// arrancar. Se degrada a la base local en vez de romper el arranque.
const dbOption = String(global.opts['db'] || '');
if (/^https?:\/\//.test(dbOption)) {
  console.warn(chalk.yellow('[ ⚠️ ] --db con URL no está soportado en esta versión; se usará la base de datos local.'));
}
const dbPrefix = (global.opts._ || []).find((arg) => !['qr', 'code'].includes(String(arg).toLowerCase())) || '';
global.db = new Low(new JSONFile(dbFile(dbPrefix)), null);

let loadDbPromise = null;
global.loadDatabase = async function loadDatabase() {
  if (global.db.data !== null) return global.db.data;
  if (loadDbPromise) return loadDbPromise;
  loadDbPromise = (async () => {
    try {
      await global.db.read().catch(console.error);
      global.db.data = {
        users: {},
        chats: {},
        stats: {},
        msgs: {},
        sticker: {},
        settings: {},
        ...(global.db.data || {}),
      };
      return global.db.data;
    } finally {
      loadDbPromise = null;
    }
  })();
  return loadDbPromise;
};
await global.loadDatabase();

const filterStrings = [
  'Q2xvc2luZyBzdGFsZSBvcGVu',
  'Q2xvc2luZyBvcGVuIHNlc3Npb24=',
  'RmFpbGVkIHRvIGRlY3J5cHQ=',
  'U2Vzc2lvbiBlcnJvcg==',
  'RXJyb3I6IEJhZCBNQUM=',
  'RGVjcnlwdGVkIG1lc3NhZ2U=',
];

const decodedFilterStrings = filterStrings
  .map((value) => Buffer.from(value, 'base64').toString())
  .filter(Boolean);

console.info = () => { };
console.debug = () => { };
['log', 'warn', 'error'].forEach(methodName => {
  const originalMethod = console[methodName];
  console[methodName] = function (...args) {
    if (typeof args[0] === 'string' && decodedFilterStrings.some(noise => args[0].includes(noise))) {
      args[0] = '';
    }
    originalMethod.apply(console, args);
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

// ── Integridad, respaldo atómico y auto-limpieza de sesión tras apagados ─────
// Si el VPS estuvo apagado horas (típico en ciclos de 8 h), `creds.json` sigue
// siendo válido, pero los archivos efímeros de Signal (`session-*`, `sender-key-*`,
// `device-list-*`, `tctoken-*`) y `routingInfo` suelen quedar desfasados y hacen
// que el bot deje de descifrar mensajes aunque se reinicie. Aquí se limpia solo
// esa caché efímera conservando `creds.json`, `pre-key-*`, `app-state-sync-*` y `lid-mapping-*`.
async function loadAuthState(authDir, { isStartup = false, purgeEphemeral = false, clearRouting = false } = {}) {
  const alreadyPaired = hasRegisteredCredentials(authDir);
  const credsAgeMs = alreadyPaired ? getCredsAgeMs(authDir) : 0;
  const longDowntime = isStartup && alreadyPaired && credsAgeMs >= DOWNTIME_PURGE_AGE_MS;
  const shouldPurge = purgeEphemeral || longDowntime;
  const shouldClearRouting = clearRouting || (isStartup && credsAgeMs >= STALE_ROUTING_AGE_MS);

  if (longDowntime) {
    const hours = (credsAgeMs / 3_600_000).toFixed(1);
    console.log(chalk.yellow(`[Auth] Sesión inactiva ~${hours} h (apagado prolongado del VPS); regenerando sesiones Signal efímeras sin desvincular.`));
  }

  await prepareAuthFolder(authDir, {
    repairAuthState,
    purgeEphemeral: shouldPurge,
    cleanUnpaired: isStartup,
    log: (msg) => console.log(chalk.yellow(msg)),
    warn: (...args) => console.warn(...args),
  });

  const auth = await useMultiFileAuthState(authDir);
  if (shouldClearRouting && auth.state?.creds?.routingInfo) {
    delete auth.state.creds.routingInfo;
    console.log(chalk.gray('[Auth] routingInfo obsoleto descartado; WhatsApp asignará una ruta fresca al conectar.'));
  }

  return {
    state: auth.state,
    saveCreds: wrapSafeSaveCreds(auth.saveCreds, authDir),
  };
}

function describeDisconnectError(lastDisconnect) {
  const err = lastDisconnect?.error;
  if (!err) return 'sin detalle';
  const parts = [];
  if (err.message) parts.push(err.message);
  const tag = err.data?.tag;
  const attrReason = err.data?.attrs?.reason ?? err.data?.reason;
  const attrCode = err.data?.attrs?.code;
  if (tag && !err.message?.includes(tag)) parts.push(`tag=${tag}`);
  if (attrReason !== undefined) parts.push(`reason=${attrReason}`);
  if (attrCode !== undefined) parts.push(`code=${attrCode}`);
  return parts.join(' | ') || String(err);
}

// ── Handler y plugins ANTES de abrir el WebSocket ────────────────────────────
// Antes `makeWASocket()` corría antes de `await filesInit()` (58 plugins): el
// socket llegaba a conectar y emitir `creds.update` + `connection: 'open'`
// mientras nadie escuchaba todavía, perdiendo rotaciones de pre-keys (causa de
// `badSession` 500) y disparando falsos reinicios del vigilante de arranque.
const handlerPath = join(__dirname, 'handler.js');
/** mtime de handler.js en el último import real (ver global.reloadHandler). */
let handlerLoadedAt = statSync(handlerPath).mtimeMs;
let handler = await import('./handler.js');

// Los plugins viven directamente en ./plugins; no existe una subcarpeta index.
const pluginFolder = join(__dirname, './plugins');
const pluginFilter = (filename) => typeof filename === 'string' && /\.js$/.test(filename);
global.plugins = {};

async function filesInit() {
  for (const filename of readdirSync(pluginFolder).filter(pluginFilter)) {
    try {
      const file = global.__filename(join(pluginFolder, filename));
      const module = await import(file);
      global.plugins[filename] = module.default || module;
    } catch (e) {
      console.error(`No se pudo importar el plugin ${filename}:`, e);
      delete global.plugins[filename];
    }
  }
}
await filesInit();

global.reload = async (_ev, filename) => {
  if (!pluginFilter(filename)) return;
  const dir = global.__filename(join(pluginFolder, filename), true);
  if (filename in global.plugins) {
    if (existsSync(dir)) global.conn?.logger?.info(` updated plugin - '${filename}'`);
    else {
      global.conn?.logger?.warn(`deleted plugin - '${filename}'`);
      return delete global.plugins[filename];
    }
  } else global.conn?.logger?.info(`new plugin - '${filename}'`);
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
    global.conn?.logger?.error(`${esSintaxis ? 'syntax error while loading' : 'error require plugin'} '${filename}'\n${format(e)}`);
    global.notifyOwnerError?.(`${esSintaxis ? 'Error de sintaxis en el plugin' : 'No se pudo recargar el plugin'} ${filename}:`, e);
  } finally {
    global.plugins = Object.fromEntries(Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b)));
  }
};
Object.freeze(global.reload);

// Un guardado de editor suele disparar varios eventos fs.watch seguidos en
// pocos milisegundos; el debounce evita importar dos veces el mismo plugin.
const pluginReloadTimers = new Map();
const pluginWatcher = watch(pluginFolder, (ev, filename) => {
  if (!pluginFilter(filename)) return;
  clearTimeout(pluginReloadTimers.get(filename));
  pluginReloadTimers.set(filename, setTimeout(() => {
    pluginReloadTimers.delete(filename);
    void global.reload(ev, filename);
  }, 150));
});

// ── Sesión, versión y método de vinculación ──────────────────────────────────
let { state, saveCreds } = await loadAuthState(global.authFilePath, { isStartup: true });
const FALLBACK_WA_VERSION = DEFAULT_CONNECTION_CONFIG?.version || [2, 3000, 1051627909];
const versionFetcher = fetchBestWaVersion || fetchLatestBaileysVersion;
const version = (await versionFetcher().catch(() => null))?.version || FALLBACK_WA_VERSION;
console.log(chalk.gray(`[ ℹ️ ] Versión de WhatsApp: ${version.join('.')}`));

const phoneFlag = global.opts.phone ?? process.argv.find(arg => arg.startsWith('--phone='))?.split('=')[1];
const phoneNumber = global.botnumber || (phoneFlag ? String(phoneFlag) : '');
const methodCodeQR = process.argv.includes('--method=qr') || process.argv.some(arg => arg.toLowerCase() === 'qr');
const methodCode = Boolean(phoneNumber) || process.argv.includes('--method=code') || process.argv.some(arg => arg.toLowerCase() === 'code');

async function question(texto) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(texto)).trim();
  } finally {
    rl.close();
  }
}

let opcion;
// Variables de estado para el pairing code (sobreviven reconexiones)
let pairingPhoneNumber = null;
let pairingCodeDone = false;
let pairingAttemptCount = 0;
let pairingRequestTimer = null;
let pairingRateLimited = false;
let pendingNewLogin = false;
if (methodCodeQR) opcion = '1';
if (!methodCodeQR && !methodCode && !isAuthenticatedCreds(state.creds)) {
  do {
    opcion = await question('[ ℹ️ ] Seleccione una opción:\n1. Con código QR\n2. Con código de texto de 8 dígitos\n---> ');
    if (!/^[1-2]$/.test(opcion)) {
      console.log('[ ⚠️ ] Por favor, seleccione solo 1 o 2.\n');
    }
  } while (opcion !== '1' && opcion !== '2' && !hasRegisteredCredentials(global.authFilePath));
}

if (!isAuthenticatedCreds(state.creds) && (opcion === '2' || methodCode)) {
  opcion = '2';
  let numeroTelefono;
  if (phoneNumber) {
    numeroTelefono = phoneNumber.replace(/[^0-9]/g, '');
    if (!isValidPhoneNumber(numeroTelefono)) {
      console.log(chalk.bgBlack(chalk.bold.redBright('Comience con el código de país de su número de WhatsApp.\nEjemplo: +5219992095479\n')));
      process.exit(1);
    }
  } else {
    while (true) {
      numeroTelefono = await question(chalk.bgBlack(chalk.bold.yellowBright('Por favor, escriba su número de WhatsApp.\nEjemplo: +5219992095479\n')));
      numeroTelefono = numeroTelefono.replace(/[^0-9]/g, '');
      if (isValidPhoneNumber(numeroTelefono)) break;
      console.log(chalk.bgBlack(chalk.bold.redBright('Por favor, escriba su número de WhatsApp.\nEjemplo: +5219992095479.\n')));
    }
  }
  // El código se pide en cuanto WhatsApp habilita pair-device en el socket.
  pairingPhoneNumber = numeroTelefono;
  console.log(chalk.cyan(`[ ℹ️ ] Número guardado: +${pairingPhoneNumber} — conectando con WhatsApp...`));
}

// Se mantiene el mismo perfil de navegador entre vinculación y reinicios para
// no cambiar la huella del dispositivo de un arranque a otro.
const BROWSER_PROFILE = Browsers?.ubuntu?.('Chrome') || ['Ubuntu', 'Chrome', '22.04.4'];

const connectionOptions = {
  logger: baileysLogger(),
  // El QR se imprime manualmente en connectionUpdate para evitar duplicados.
  printQRInTerminal: false,
  browser: BROWSER_PROFILE,
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
  },
  markOnlineOnConnect: false,
  generateHighQualityLinkPreview: false,
  syncFullHistory: false,
  qrTimeout: pairingPhoneNumber ? 60_000 : undefined,
  getMessage: async (key) => {
    try {
      const jid = jidNormalizedUser(key.remoteJid);
      const msg = await store.loadMessage(jid, key.id);
      return msg?.message || undefined;
    } catch {
      return undefined;
    }
  },
  msgRetryCounterCache,
  userDevicesCache,
  defaultQueryTimeoutMs: 20000,
  fetchAgent: mediaUploadAgent,
  // Devolver `undefined` (no `{}`) cuando no hay caché: Baileys trata `{}` como
  // objeto truthy sin `participants` al enviar a grupos/estados.
  cachedGroupMetadata: async (jid) => global.conn?.chats?.[jid]?.metadata || undefined,
  keepAliveIntervalMs: 30000,
  maxIdleTimeMs: 120000,
  version,
};

// ── Limpieza de temporales y core dumps ──────────────────────────────────────
let dbWriteTimer = null;
if (!opts['test']) {
  // La limpieza de temporales vive en clearTmp(): el bloque `autocleartmp` que
  // había aquí dependía de `global.support.find`, que sticker.js fija en false,
  // así que nunca se ejecutaba.
  dbWriteTimer = setInterval(async () => {
    try {
      if (global.db.data) await global.db.write();
    } catch (error) {
      console.error('[db] No se pudo guardar la base local:', error);
    }
  }, 30 * 1000);
}

function clearTmp() {
  if (!existsSync(tmpDir)) return;
  for (const name of readdirSync(tmpDir)) {
    const file = join(tmpDir, name);
    try {
      const stats = statSync(file);
      if (stats.isFile() && (Date.now() - stats.mtimeMs >= 1000 * 60 * 3)) unlinkSync(file);
    } catch {
      // El archivo desapareció entre el listado y el borrado: nada que limpiar.
    }
  }
}

// Borra los volcados `core.<pid>` que aparezcan en la carpeta del bot. En
// algunas plataformas `filename` llega vacío, y path.join(dir, null) lanzaba un
// TypeError dentro del callback del watcher.
const CORE_FILE_PATTERN = /^core\.\d+$/i;
const coreWatcher = fs.watch(__dirname, (eventType, filename) => {
  if (eventType !== 'rename' || !filename || !CORE_FILE_PATTERN.test(filename)) return;
  const filePath = path.join(__dirname, filename);
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return;
    fs.unlink(filePath, (unlinkError) => {
      if (unlinkError) console.error(`Error eliminando el archivo ${filePath}:`, unlinkError);
    });
  });
});

// ── Reconexión y eventos de conexión ─────────────────────────────────────────
// Limita cuántas veces se muestra cada motivo de desconexión durante una misma
// caída; se reinicia cuando la conexión vuelve a abrir.
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

function ensureBotJid(activeConn) {
  if (activeConn?.user?.id && !activeConn.user.jid) {
    activeConn.user.jid = activeConn.decodeJid(activeConn.user.id);
  }
}

/**
 * Auto-repara sesiones Signal desfasadas sin borrar `creds.json`:
 *  - Si falta una pre-key en disco, sube un lote nuevo al servidor.
 *  - Si un remitente falla repetidamente (Bad MAC / No session), borra solo su sesión Signal.
 *  - Si hay una tormenta de fallos tras horas apagado, purga la caché efímera y reconecta.
 */
async function handleDecryptFailed(info) {
  if (this && this !== global.conn) return;
  if (isIgnorableDecryptFailure(info)) return;

  const peerJid = info?.participant || info?.remoteJid || '';
  const isPreKeyError = isPreKeyDecryptError(info);
  const errorMessage = info?.errorMessage || 'sin detalle';
  const verdict = decryptFailureMonitor.record({ peerJid, isPreKeyError });

  if (shouldLogError(`decrypt_${peerJid || 'unknown'}`)) {
    // Pasar `errorMessage` como segundo argumento evita que el filtro de ruido
    // de `console.log` (que revisa solo `args[0]`) borre este aviso.
    console.log(
      chalk.yellow(`[ ⚠️ ] Fallo al descifrar mensaje (${peerJid || 'desconocido'}) [fallos=${verdict.globalCount}]:`),
      errorMessage,
    );
  }

  if (verdict.shouldUploadPreKeys && typeof global.conn?.uploadPreKeys === 'function') {
    console.log(chalk.yellow('[Auth] Error de PreKey detectado; subiendo nuevas pre-keys a WhatsApp...'));
    global.conn.uploadPreKeys().catch((err) => {
      console.warn('[Auth] No se pudieron subir nuevas pre-keys:', err?.message || err);
    });
  }

  if (verdict.shouldResetPeer && isResettablePeerJid(peerJid) && typeof global.conn?.signalRepository?.deleteSession === 'function') {
    console.log(chalk.yellow(`[Auth] Reiniciando sesión Signal desincronizada con ${peerJid}...`));
    global.conn.signalRepository.deleteSession([peerJid]).catch(() => {});
  }

  if (verdict.shouldPurgeAndReconnect && !terminalSession && !shutdownStarted) {
    console.log(chalk.yellow('[Auth] Tormenta de fallos de descifrado; purgando caché efímera de RikkaSession (conservando creds.json) y reconectando...'));
    pendingEphemeralPurge = true;
    scheduleSocketReconnect('decrypt-storm');
  }
}

async function connectionUpdate(update) {
  // Un socket viejo puede emitir eventos durante su cierre. Ignóralos para
  // evitar que vuelva a programar una reconexión después de crear el nuevo.
  if (this && this !== global.conn) return;
  const { connection, lastDisconnect } = update;
  // Baileys emite eventos parciales (p. ej. `receivedPendingNotifications`) sin
  // campo `connection`: sobrescribir con `undefined` borraba `'open'` y rompía
  // el vigilante y el envío de avisos al owner.
  if (connection) stopped = connection;

  if (global.db.data == null) void global.loadDatabase();
  if (update.isNewLogin) {
    pendingNewLogin = true;
    pairingCodeDone = true;
    if (pairingRequestTimer) {
      clearTimeout(pairingRequestTimer);
      pairingRequestTimer = null;
    }
    console.log(chalk.green('[ ✅ ] Código aceptado por WhatsApp; finalizando vinculación...'));
  }
  if (update.qr && (opcion == '1' || methodCodeQR) && qrGuard.handle(update.qr)) {
    qrcodeTerminal.generate(update.qr, { small: true }, (qr) => {
      console.log(qr);
      console.log(chalk.yellow('[　ℹ️　　] Escanea el código QR.'));
    });
  }
  if (connection === 'open') {
    const recoveredAfter = reconnectAttempt;
    reconnectAttempt = 0;
    consecutiveBadSessions = 0;
    terminalSession = false;
    pendingNewLogin = false;
    pairingPhoneNumber = null;
    pairingCodeDone = true;
    lastOpenedAt = Date.now();
    decryptFailureMonitor.reset();
    ensureBotJid(global.conn);
    for (const key of Object.keys(errorCounters)) delete errorCounters[key];
    clearPendingReconnect();
    if (recoveredAfter >= RECONNECT_POLICY.alertAfterAttempts) {
      console.log(chalk.yellow(`[　✅　　] Reconectado tras ${recoveredAfter} intentos.`));
    }
    // ── FIX DOBLE MENSAJE: registrar timestamp exacto de conexión ──
    global.timestamp.connect = new Date();
    console.log(chalk.yellow(`[　ℹ️　　] Conectado correctamente (${global.conn?.user?.jid || 'sesión activa'}).`));
    // Aquí había un `isFirstConnection = true;` sin declarar: en un módulo ES
    // (siempre estricto) lanzaba ReferenceError y cortaba la rama 'open' antes
    // del flush, de modo que los avisos acumulados durante la caída no se
    // entregaban hasta el siguiente error.
    void flushOwnerErrorAlerts();
  }
  const reason = lastDisconnect?.error?.output?.statusCode
    ?? lastDisconnect?.error?.output?.payload?.statusCode;
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
    // Si el socket se cerró antes de completar el vínculo, el código de 8 dígitos
    // anterior caducó junto con el socket: permitir pedir uno nuevo al reconectar.
    if (pairingPhoneNumber && !isAuthenticatedCreds(state.creds) && !pendingNewLogin && pairingCodeDone) {
      pairingCodeDone = false;
      if (pairingAttemptCount < MAX_PAIRING_ATTEMPTS && !pairingRateLimited) {
        console.log(chalk.yellow('[ ⚠️ ] La conexión se cerró antes de completar el vínculo; se generará un código nuevo al reconectar.'));
      }
    }
    const detail = describeDisconnectError(lastDisconnect);
    if (reason === DisconnectReason.badSession) {
      // En Baileys, 500 (`badSession`) también es el código por defecto ante
      // stream:error sin código o fallos temporales de servidor/WebSocket.
      // Se reintenta reparando archivos corruptos (y purgando caché efímera en
      // el segundo intento, sin tocar creds.json) antes de declarar la sesión muerta.
      const decision = classifyDisconnect(reason, DisconnectReason, { badSessionAttempts: consecutiveBadSessions });
      consecutiveBadSessions += 1;
      if (decision === RECONNECT) {
        if (consecutiveBadSessions >= 2) pendingEphemeralPurge = true;
        const msg = `[ ⚠️ ] Desconexión 500/badSession (intento ${consecutiveBadSessions}/${RECONNECT_POLICY.maxBadSessionRetries}): ${detail}. Reparando y reconectando...`;
        console.log(chalk.yellow(msg));
        global.conn.logger.warn(msg);
        scheduleSocketReconnect('badSession');
      } else {
        if (shouldLogError('badSession')) {
          const msg = `[ ⚠️ ] Sesión incorrecta tras ${consecutiveBadSessions} intentos (${detail}). Elimina la carpeta ${global.authFile} y escanea nuevamente.`;
          console.log(chalk.redBright(msg));
          global.conn.logger.error(msg);
        }
        markTerminalSession(`sesión inválida tras ${consecutiveBadSessions} intentos (badSession: ${detail})`);
      }
    } else if (reason === DisconnectReason.connectionClosed) {
      if (shouldLogError('connectionClosed')) {
        const msg = `[ ⚠️ ] Conexión cerrada (${detail}), reconectando...`;
        console.log(chalk.yellow(msg));
        global.conn.logger.warn(msg);
      }
      scheduleSocketReconnect('connectionClosed', { immediate: pendingNewLogin });
    } else if (reason === DisconnectReason.connectionLost) {
      if (shouldLogError('connectionLost')) {
        const msg = `[ ⚠️ ] Conexión perdida con el servidor (${detail}), reconectando...`;
        console.log(chalk.yellow(msg));
        global.conn.logger.warn(msg);
      }
      scheduleSocketReconnect('connectionLost');
    } else if (reason === DisconnectReason.loggedOut) {
      if (shouldLogError('loggedOut')) {
        const msg = `[ ⚠️ ] Conexión cerrada desde WhatsApp (${detail}). Elimina la carpeta ${global.authFile} y escanea nuevamente.`;
        console.log(chalk.redBright(msg));
        global.conn.logger.error(msg);
      }
      markTerminalSession('sesión cerrada desde el teléfono (loggedOut)');
    } else if (reason === DisconnectReason.restartRequired) {
      if (shouldLogError('restartRequired')) {
        const msg = `[ ⚠️ ] Reinicio necesario (${detail}), reconectando...`;
        console.log(chalk.gray(msg));
        global.conn.logger.info(msg);
      }
      // Tras aceptar el código de 8 dígitos / QR, WhatsApp envía 515 para que
      // el cliente reconecte enseguida con las credenciales recién firmadas.
      scheduleSocketReconnect('restartRequired', { immediate: true });
    } else if (reason === DisconnectReason.timedOut) {
      if (shouldLogError('timedOut')) {
        const msg = `[ ⚠️ ] Tiempo de conexión agotado (${detail}), reconectando...`;
        console.log(chalk.yellow(msg));
        global.conn.logger.warn(msg);
      }
      scheduleSocketReconnect('timedOut');
    } else {
      const unknownError = `unknown_${reason || ''}_${connection || ''}`;
      if (shouldLogError(unknownError)) {
        const msg = `[ ⚠️ ] Razón de desconexión desconocida (${reason || 'none'}: ${detail})`;
        console.log(chalk.yellow(msg));
        global.conn.logger.warn(msg);
      }
      // Motivo que no conocemos: se consulta la misma tabla que usan los
      // anteriores, porque WhatsApp inventa códigos nuevos de vez en cuando y
      // un código de sesión revocada no debe entrar en bucle.
      if (classifyDisconnect(reason, DisconnectReason) === STOP) {
        markTerminalSession(`motivo ${reason ?? 'desconocido'} (${detail})`);
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
    consecutiveBadSessions = 0;
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
    // Si no hay credenciales registradas hace falta escanear el QR / meter el código.
    if (!isAuthenticatedCreds(global.conn?.authState?.creds)) {
      console.log(chalk.gray('[ ℹ️ ] Sin sesión vinculada; se espera la vinculación en lugar de reintentar.'));
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

function scheduleSocketReconnect(reason, { immediate = false } = {}) {
  // `shutdownStarted` importa: durante el apagado llegaba a crearse un socket
  // nuevo justo después de cerrar el viejo, porque el `close` del cierre
  // programado reentraba aquí.
  if (terminalSession || reconnectTimer || shutdownStarted) return;
  const delay = immediate ? 250 : nextReconnectDelay(reconnectAttempt, RECONNECT_POLICY);
  if (!immediate) reconnectAttempt += 1;
  console.log(chalk.gray(
    immediate
      ? `[ ℹ️ ] Reconexión inmediata (${reason}) para completar sesión.`
      : `[ ℹ️ ] Reconexión programada en ${Math.ceil(delay / 1000)}s (${reason}), intento ${reconnectAttempt}.`,
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
      if (!immediate) notifyReconnectTrouble(reconnectAttempt);
    }
  }, delay);
}

let isInit = true;

/** Enlaza todos los eventos del socket de forma síncrona (sin ningún `await` intermedio). */
function attachSocketHandlers(activeConn) {
  ensureBotJid(activeConn);
  if (!isInit) {
    activeConn.ev.off('messages.upsert', activeConn.handler);
    activeConn.ev.off('group-participants.update', activeConn.participantsUpdate);
    activeConn.ev.off('groups.update', activeConn.groupsUpdate);
    activeConn.ev.off('message.delete', activeConn.onDelete);
    activeConn.ev.off('messages.decrypt-failed', activeConn.onDecryptFailed);
    activeConn.ev.off('connection.update', activeConn.connectionUpdate);
    activeConn.ev.off('creds.update', activeConn.credsUpdate);
  }

  activeConn.handler = handler.handler.bind(activeConn);
  activeConn.participantsUpdate = handler.participantsUpdate.bind(activeConn);
  activeConn.groupsUpdate = handler.groupsUpdate.bind(activeConn);
  activeConn.onDelete = handler.deleteUpdate.bind(activeConn);
  activeConn.onDecryptFailed = handleDecryptFailed.bind(activeConn);
  activeConn.connectionUpdate = connectionUpdate.bind(activeConn);
  activeConn.credsUpdate = () => {
    ensureBotJid(activeConn);
    return saveCreds();
  };

  activeConn.ev.on('messages.upsert', activeConn.handler);
  activeConn.ev.on('group-participants.update', activeConn.participantsUpdate);
  activeConn.ev.on('groups.update', activeConn.groupsUpdate);
  activeConn.ev.on('message.delete', activeConn.onDelete);
  activeConn.ev.on('messages.decrypt-failed', activeConn.onDecryptFailed);
  activeConn.ev.on('connection.update', activeConn.connectionUpdate);
  activeConn.ev.on('creds.update', activeConn.credsUpdate);

  isInit = false;
}

async function refreshAuthState() {
  // Esperar a que termine cualquier escritura en curso de `creds.update` (p. ej.
  // `pair-success` justo antes del cierre 515) para no releer un creds.json viejo.
  try {
    await saveCreds?.flush?.();
  } catch {}
  const purgeEphemeral = pendingEphemeralPurge;
  pendingEphemeralPurge = false;
  if (purgeEphemeral) {
    msgRetryCounterCache.flushAll();
    userDevicesCache.flushAll();
  }
  const freshAuth = await loadAuthState(global.authFilePath, {
    purgeEphemeral,
    clearRouting: true,
  });
  state = freshAuth.state;
  saveCreds = freshAuth.saveCreds;
  connectionOptions.auth = {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
  };
  connectionOptions.qrTimeout = pairingPhoneNumber && !isAuthenticatedCreds(state.creds) ? 60_000 : undefined;
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
      // Cerrar por completo la instancia anterior (`end()` limpia keepAlive,
      // signalRepository y el buffer de eventos) antes de abrir una nueva.
      oldConn?.ev?.removeAllListeners?.();
      await Promise.race([
        Promise.resolve().then(() => oldConn?.end?.(new Error('socket-replaced'))),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]).catch(() => {});
      try { oldConn?.ws?.close?.(); } catch {}

      stopped = 'connecting';
      // Recargar y reparar la sesión antes de crear el nuevo socket para no
      // reutilizar creds/keys obsoletos ni archivos JSON truncados.
      await refreshAuthState();
      // `makeWASocket` en simple.js ya ejecuta `store.bind(sock)` internamente.
      global.conn = makeWASocket(connectionOptions);
      isInit = true;
    } finally {
      socketReloadInProgress = false;
    }
  }

  attachSocketHandlers(global.conn);
  if (restatConn && pairingPhoneNumber && !isAuthenticatedCreds(state.creds) && !pairingCodeDone && !pairingRateLimited) {
    requestPairingCodeOnce();
  }
  return true;
};

// ── Arranque del socket (plugins, DB y handler ya están listos) ──────────────
// `makeWASocket` en simple.js ya enlaza `store.bind(sock)`.
global.conn = makeWASocket(connectionOptions);
// Enlace síncrono inmediato: ni un solo `creds.update` ni `connection: 'open'`
// inicial puede perderse antes de registrar los listeners.
attachSocketHandlers(global.conn);

// El primer handshake también va vigilado: con credenciales válidas pero una
// red que no termina de conectar, no llegaba ni un `close` y había que
// reiniciar a mano. Con sesión sin registrar no se arma, que ahí lo que falta
// es un QR o código de 8 dígitos, no un reintento.
if (isAuthenticatedCreds(state.creds)) armConnectWatchdog('arranque');

// `global.conn.requestPairingCode` ya espera internamente el evento `pair-device`
// de WhatsApp y verifica la respuesta IQ antes de devolver el código.
const MAX_PAIRING_ATTEMPTS = 3;
const PAIRING_RETRY_DELAY_MS = 6_000;

function requestPairingCodeOnce() {
  if (pairingCodeDone || pairingRateLimited || pairingAttemptCount >= MAX_PAIRING_ATTEMPTS) return;
  if (pairingRequestTimer) {
    clearTimeout(pairingRequestTimer);
    pairingRequestTimer = null;
  }
  const targetConn = global.conn;
  pairingAttemptCount += 1;
  const attempt = pairingAttemptCount;
  void (async () => {
    try {
      if (isAuthenticatedCreds(state.creds) || !targetConn?.requestPairingCode || targetConn !== global.conn) return;
      const raw = await targetConn.requestPairingCode(pairingPhoneNumber);
      if (targetConn !== global.conn) return;
      const codigo = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (codigo.length !== 8) throw new Error(`WhatsApp devolvió un código inválido (${codigo.length} caracteres)`);
      pairingCodeDone = true;
      console.log(chalk.yellow('\n[ ℹ️ ] En WhatsApp ve a: Dispositivos vinculados > Vincular un dispositivo > Vincular con el número de teléfono.'));
      console.log(chalk.black(chalk.bgGreen(' Su código de emparejamiento: ')), chalk.black(chalk.bgWhite(` ${codigo.slice(0, 4)}-${codigo.slice(4)} `)), '\n');
    } catch (err) {
      if (targetConn !== global.conn || shutdownStarted) return;
      if (typeof isRateLimitError === 'function' && isRateLimitError(err)) {
        pairingRateLimited = true;
        console.log(chalk.redBright('[ ⚠️ ] WhatsApp limitó temporalmente las solicitudes de código para este número (429). Espera unos minutos antes de volver a intentarlo.'));
        return;
      }
      console.log(chalk.red(`[ ⚠️ ] Error al obtener código (intento ${attempt}/${MAX_PAIRING_ATTEMPTS}): ${err.message}`));
      if (pairingAttemptCount < MAX_PAIRING_ATTEMPTS && !isAuthenticatedCreds(state.creds)) {
        pairingRequestTimer = setTimeout(requestPairingCodeOnce, PAIRING_RETRY_DELAY_MS);
      }
    }
  })();
}

if (pairingPhoneNumber && !isAuthenticatedCreds(state.creds)) {
  requestPairingCodeOnce();
}

// Vigila sockets zombie (WS cerrado en silencio sin emitir `close`) y buffers
// de eventos atascados tras una reconexión con mucha cola offline.
const healthTimer = setInterval(() => {
  if (shutdownStarted || terminalSession || socketReloadInProgress || stopped !== 'open') return;
  if (global.conn?.ws && !global.conn.ws.isOpen) {
    console.log(chalk.yellow('[Socket] WebSocket cerrado en silencio; reconectando automáticamente...'));
    stopped = 'close';
    scheduleSocketReconnect('zombie-ws');
    return;
  }
  if (global.conn?.ev?.isBuffering?.() && lastOpenedAt > 0 && Date.now() - lastOpenedAt > 35_000) {
    console.log(chalk.yellow('[Socket] Event buffer retenido >35s tras abrir; forzando flush para liberar mensajes.'));
    try { global.conn.ev.flush(); } catch {}
  }
}, 60_000);
healthTimer.unref?.();

const tmpTimer = setInterval(() => {
  if (stopped === 'close' || !global.conn?.user) return;
  clearTmp();
}, 180_000);

const bioTimer = setInterval(async () => {
  if (stopped === 'close' || !global.conn?.user) return;
  const uptime = clockString(process.uptime() * 1000);
  const bio = `• Activo: ${uptime} | Rikka-TakaradaMD`;
  await global.conn.updateProfileStatus(bio).catch(() => {});
}, 10 * 60 * 1000); // cada 10 minutos (antes: 60s)

function clockString(ms) {
  const d = isNaN(ms) ? '--' : Math.floor(ms / 86400000);
  const h = isNaN(ms) ? '--' : Math.floor(ms / 3600000) % 24;
  const m = isNaN(ms) ? '--' : Math.floor(ms / 60000) % 60;
  const s = isNaN(ms) ? '--' : Math.floor(ms / 1000) % 60;
  return [d, 'd ', h, 'h ', m, 'm ', s, 's '].map((v) => v.toString().padStart(2, '0')).join('');
}

async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopped = 'close';
  // Apagando: ningún reintento pendiente debe volver a crear un socket (el
  // `close` provocado por nuestro propio cierre entraba aquí y reprogramaba).
  terminalSession = true;
  clearPendingReconnect();
  if (dbWriteTimer) clearInterval(dbWriteTimer);
  clearInterval(healthTimer);
  clearInterval(tmpTimer);
  clearInterval(bioTimer);
  for (const timer of pluginReloadTimers.values()) clearTimeout(timer);
  pluginReloadTimers.clear();
  try { pluginWatcher.close(); } catch {}
  try { coreWatcher.close(); } catch {}
  console.log(`[ SHUTDOWN ] ${signal}: guardando datos y cerrando WhatsApp...`);
  if (pairingRequestTimer) {
    clearTimeout(pairingRequestTimer);
    pairingRequestTimer = null;
  }
  try {
    await saveCreds?.();
  } catch (error) {
    console.error('[ SHUTDOWN ] No se pudieron guardar las credenciales:', error);
  }
  try {
    await global.db?.write?.();
  } catch (error) {
    console.error('[ SHUTDOWN ] No se pudo guardar la base local:', error);
  }
  try {
    global.conn?.ev?.removeAllListeners?.();
    await Promise.race([
      Promise.resolve().then(() => global.conn?.end?.(new Error('shutdown'))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]).catch(() => {});
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
