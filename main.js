process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
import './config.js';
import './api.js';
import { createRequire } from 'module';
import path, { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform } from 'process';
import fs, { readdirSync, statSync, unlinkSync, existsSync, readFileSync, watch } from 'fs';
import yargs from 'yargs';
import { spawn } from 'child_process';
import lodash from 'lodash';
import chalk from 'chalk';
import syntaxerror from 'syntax-error';
import { format } from 'util';
import pino from 'pino';
import Pino from 'pino';
import { Boom } from '@hapi/boom';
import { makeWASocket, protoType, serialize } from './src/libraries/simple.js';
import { initializeSubBots, startSubBotWatcher } from './src/libraries/subsRikka.js';
import { Low, JSONFile } from 'lowdb';
import store from './src/libraries/store.js';

const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser } = await import("@whiskeysockets/baileys");
// PHONENUMBER_MCC fue removido en itsliaaa/baileys — validacion por regex de codigo de pais
const _isValidCountryCode = (num) => /^[1-9]\d{0,14}$/.test(num);
import readline from 'readline';
import qrcodeTerminal from 'qrcode-terminal';
import NodeCache from 'node-cache';
const { chain } = lodash;
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
let stopped = 'close';
protoType();
serialize();
const msgRetryCounterMap = new Map();
const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const userDevicesCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

global.__filename = function filename(pathURL = import.meta.url, rmPrefix = platform !== 'win32') {
  return rmPrefix ? /file:\/\/\//.test(pathURL) ? fileURLToPath(pathURL) : pathURL : pathToFileURL(pathURL).toString();
}; global.__dirname = function dirname(pathURL) {
  return path.dirname(global.__filename(pathURL, true));
}; global.__require = function require(dir = import.meta.url) {
  return createRequire(dir);
};
global.timestamp = { start: new Date };
const __dirname = global.__dirname(import.meta.url);
global.opts = new Object(yargs(process.argv.slice(2)).exitProcess(false).parse());
global.prefix = new RegExp('^[#!/.]')
global.db = new Low(/https?:\/\//.test(opts['db'] || '') ? new cloudDBAdapter(opts['db']) : new JSONFile(`${opts._[0] ? opts._[0] + '_' : ''}database.json`));

global.loadDatabase = async function loadDatabase() {
  if (global.db.READ) {
    return new Promise((resolve) => setInterval(async function () {
      if (!global.db.READ) {
        clearInterval(this);
        resolve(global.db.data == null ? global.loadDatabase() : global.db.data);
      }
    }, 1 * 1000));
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

const { state, saveCreds } = await useMultiFileAuthState(global.authFile);
const version22 = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1033893291] }));
console.log(version22)
const version = version22?.version || [2, 3000, 1033893291]; 
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
if (methodCodeQR) opcion = '1';
if (!methodCodeQR && !methodCode && !fs.existsSync(`./${global.authFile}/creds.json`)) {
  do {
    opcion = await question('[ ℹ️ ] Seleccione una opción:\n1. Con código QR\n2. Con código de texto de 8 dígitos\n---> ');
    if (!/^[1-2]$/.test(opcion)) {
      console.log('[ ⚠️ ] Por favor, seleccione solo 1 o 2.\n');
    }
  } while (opcion !== '1' && opcion !== '2' || fs.existsSync(`./${global.authFile}/creds.json`));
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

process.on('uncaughtException', (err) => {
  if (filterStrings.includes(Buffer.from(err.message).toString('base64'))) return;
  console.error('Uncaught Exception:', err);
});

const connectionOptions = {
  logger: pino({ level: 'silent' }),
  printQRInTerminal: opcion == '1' ? true : methodCodeQR ? true : false,
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
  msgRetryCounterCache: msgRetryCounterCache || new Map(),
  userDevicesCache: userDevicesCache || new Map(),
  defaultQueryTimeoutMs: 20000,
  cachedGroupMetadata: (jid) => global.conn.chats[jid]?.metadata ?? {},
  keepAliveIntervalMs: 30000,
  maxIdleTimeMs: 120000,
  version,
};

global.conn = makeWASocket(connectionOptions);

if (!fs.existsSync(`./${global.authFile}/creds.json`)) {
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

conn.isInit = false;
conn.well = false;
conn.logger.info(`[　ℹ️　] Cargando...\n`);

if (!opts['test']) {
  if (global.db) {
    setInterval(async () => {
      if (global.db.data) await global.db.write();
      if (opts['autocleartmp'] && (global.support || {}).find) {
        const tmp = [os.tmpdir(), 'tmp', 'jadibts'];
        tmp.forEach((filename) => cp.spawn('find', [filename, '-amin', '3', '-type', 'f', '-delete']));
      }
    }, 30 * 1000);
  }
}

if (opts['server']) (await import('./server.js')).default(global.conn, PORT);

function clearTmp() {
  const tmp = [join(__dirname, './src/tmp')];
  const filename = [];
  tmp.forEach((dirname) => readdirSync(dirname).forEach((file) => filename.push(join(dirname, file))));
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
  let isFirstConnection = '';
  let qrAlreadyShown = false;
  let qrTimeout = null;
  const { connection, lastDisconnect, isNewLogin } = update;
  stopped = connection;
  if (isNewLogin) conn.isInit = true;

  // ── PAIRING CODE: solicitar cuando el WS esté conectando ──
  if (connection === 'connecting' && pairingPhoneNumber && !pairingCodeDone) {
    if (!global.conn.authState.creds.registered) {
      setTimeout(async () => {
        if (pairingCodeDone) return;
        pairingAttemptCount++;
        try {
          let codigo = await global.conn.requestPairingCode(pairingPhoneNumber);
          if (!codigo) throw new Error('Código vacío recibido');
          pairingCodeDone = true;
          codigo = codigo?.match(/.{1,4}/g)?.join('-') || codigo;
          console.log(chalk.yellow('[ ℹ️ ] Introduce el código de emparejamiento en WhatsApp.'));
          console.log(chalk.black(chalk.bgGreen('Su código de emparejamiento: ')), chalk.black(chalk.bgWhite(chalk.black(` ${codigo} `))));
        } catch (err) {
          console.log(chalk.red(`[ ⚠️ ] Error al obtener código (intento ${pairingAttemptCount}/5): ${err.message}`));
          if (pairingAttemptCount >= 5) {
            console.log(chalk.red('[ ❌ ] No se pudo obtener el código. Reinicia y usa QR.'));
            pairingPhoneNumber = null; // detener reintentos
          }
          // El siguiente 'connecting' reintentará automáticamente
        }
      }, 1500);
    }
  }
  // ──────────────────────────────────────────────────────────
  const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
  if (code && code !== DisconnectReason.loggedOut && code !== 405 && conn?.ws.socket == null) {
    await global.reloadHandler(true).catch(console.error);
    global.timestamp.connect = new Date;
  }
  if (global.db.data == null) loadDatabase();
  if (update.qr && (opcion == '1' || methodCodeQR)) {
    qrcodeTerminal.generate(update.qr, { small: true }, (qr) => {
      console.log(qr);
      console.log(chalk.yellow('[　ℹ️　　] Escanea el código QR.'));
    });
    qrAlreadyShown = true;
    if (qrTimeout) clearTimeout(qrTimeout);
    qrTimeout = setTimeout(() => qrAlreadyShown = false, 60000);
  }
  if (connection == 'open') {
    // ── FIX DOBLE MENSAJE: registrar timestamp exacto de conexión ──
    global.timestamp.connect = new Date();
    console.log(chalk.yellow('[　ℹ️　　] Conectado correctamente.'));
    isFirstConnection = true;
    if (!global.subBotsInitialized) {
      global.subBotsInitialized = true;
      try {
        await initializeSubBots();
      } catch (error) {
        console.error(chalk.red('[ ⚠️ ] Error al inicializar sub-bots:'), error);
      }
    }
  }
  let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
  const lastErrors = {};
  const errorTimers = {};
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
  if (reason == 405) {
    console.log(chalk.bold.redBright(`[ ⚠️ ] Conexión replazada, reconectando en 10 segundos...`));
    await new Promise(r => setTimeout(r, 10000));
    await global.reloadHandler(true).catch(console.error);
    return;
  }
  if (connection === 'close') {
    if (reason === DisconnectReason.badSession) {
      if (shouldLogError('badSession')) {
        conn.logger.error(`[ ⚠️ ] Sesión incorrecta, por favor elimina la carpeta ${global.authFile} y escanea nuevamente.`);
      }
      await global.reloadHandler(true).catch(console.error);
    } else if (reason === DisconnectReason.connectionClosed) {
      if (shouldLogError('connectionClosed')) {
        conn.logger.warn(`[ ⚠️ ] Conexión cerrada, reconectando...`);
      }
      await global.reloadHandler(true).catch(console.error);
    } else if (reason === DisconnectReason.connectionLost) {
      if (shouldLogError('connectionLost')) {
        conn.logger.warn(`[ ⚠️ ] Conexión perdida con el servidor, reconectando...`);
      }
      await global.reloadHandler(true).catch(console.error);
    } else if (reason === DisconnectReason.connectionReplaced) {
      // Ya manejado por el bloque reason == 405 con delay
    } else if (reason === DisconnectReason.loggedOut) {
      if (shouldLogError('loggedOut')) {
        conn.logger.error(`[ ⚠️ ] Conexion cerrada, por favor elimina la carpeta ${global.authFile} y escanea nuevamente.`);
      }
    } else if (reason === DisconnectReason.restartRequired) {
      if (isFirstConnection) {
        if (shouldLogError('restartRequired')) {
          //conn.logger.info(`[ ⚠️ ] Primer inicio: Ignorando restartRequired (posible falso positivo)`);
        }
        isFirstConnection = false;
      } else {
        if (shouldLogError('restartRequired')) {
          conn.logger.info(`[ ⚠️ ] Reinicio necesario, reconectando...`);
        }
        await global.reloadHandler(true).catch(console.error);
      }
    } else if (reason === DisconnectReason.timedOut) {
      if (shouldLogError('timedOut')) {
        conn.logger.warn(`[ ⚠️ ] Tiempo de conexión agotado, reconectando...`);
      }
      await global.reloadHandler(true).catch(console.error);
    } else {
      const unknownError = `unknown_${reason || ''}_${connection || ''}`;
      if (shouldLogError(unknownError)) {
        conn.logger.warn(`[ ⚠️ ] Razón de desconexión desconocida. ${reason || ''}: ${connection || ''}`);
      }
      await global.reloadHandler(true).catch(console.error);
    }
  }
}

process.on('uncaughtException', console.error);

let isInit = true;
let handler = await import('./handler.js');

global.reloadHandler = async function (restatConn) {
  try {
    const Handler = await import(`./handler.js?update=${Date.now()}`).catch(console.error);
    if (Object.keys(Handler || {}).length) handler = Handler;
  } catch (e) {
    console.error(e);
  }
  if (restatConn) {
    const oldChats = global.conn.chats;
    try {
      global.conn.ws.close();
    } catch { }
    conn.ev.removeAllListeners();
    global.conn = makeWASocket(connectionOptions, { chats: oldChats });
    store?.bind(conn);
    isInit = true;
  }
  if (!isInit) {
    conn.ev.off('messages.upsert', conn.handler);
    conn.ev.off('group-participants.update', conn.participantsUpdate);
    conn.ev.off('groups.update', conn.groupsUpdate);
    conn.ev.off('message.delete', conn.onDelete);
    conn.ev.off('call', conn.onCall);
    conn.ev.off('connection.update', conn.connectionUpdate);
    conn.ev.off('creds.update', conn.credsUpdate);
  }

  conn.handler = handler.handler.bind(global.conn);

  conn.participantsUpdate = handler.participantsUpdate.bind(global.conn);
  conn.groupsUpdate = handler.groupsUpdate.bind(global.conn);
  conn.onDelete = handler.deleteUpdate.bind(global.conn);
  conn.onCall = handler.callUpdate.bind(global.conn);
  conn.connectionUpdate = connectionUpdate.bind(global.conn);
  conn.credsUpdate = saveCreds.bind(global.conn, true);

  conn.ev.on('messages.upsert', conn.handler);
  conn.ev.on('group-participants.update', conn.participantsUpdate);
  conn.ev.on('groups.update', conn.groupsUpdate);
  conn.ev.on('message.delete', conn.onDelete);
  conn.ev.on('call', conn.onCall);
  conn.ev.on('connection.update', conn.connectionUpdate);
  conn.ev.on('creds.update', conn.credsUpdate);


  isInit = false;
  return true;
};
;

const pluginFolder = global.__dirname(join(__dirname, './plugins/index'));
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
      delete global.plugins[filename];
    }
  }
}
filesInit().then((_) => Object.keys(global.plugins)).catch(console.error);

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
    const err = syntaxerror(readFileSync(dir), filename, {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
    if (err) conn.logger.error(`syntax error while loading '${filename}'\n${format(err)}`);
    else {
      try {
        const module = (await import(`${global.__filename(dir)}?update=${Date.now()}`));
        global.plugins[filename] = module.default || module;
      } catch (e) {
        conn.logger.error(`error require plugin '${filename}\n${format(e)}'`);
      } finally {
        global.plugins = Object.fromEntries(Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b)));
      }
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

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  gracefulShutdown();
  process.exit(0);
});

// Manejo de errores no capturadas relacionadas con LID
process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.message && reason.message.includes('lid')) {
    console.error('❌ Error no manejado relacionado con LID:', reason);
  }
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
