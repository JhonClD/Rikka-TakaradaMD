import './config.js';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import { createRequire } from 'module';
import fs from 'fs';
import fsAsync from 'fs/promises';
import chalk from 'chalk';
import pino from 'pino';
import readline from 'readline';
import NodeCache from 'node-cache';
import { Boom } from '@hapi/boom';
import { Low, JSONFile } from 'lowdb';
import { makeWASocket, protoType, serialize, smsg } from './src/libraries/simple.js';
import { handler, participantsUpdate, reloadPlugin } from './handler.js';
import { registerLidPhone } from './lib/funcion/lid-resolver.js';

const {
  default: _makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
  PHONENUMBER_MCC,
  isJidBroadcast,
} = await import('@whiskeysockets/baileys');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(__dirname);

protoType();
serialize();

global.timestamp = { connect: Date.now() };
global.botUptime = Date.now();
global.groupCache = global.groupCache || new Map();
global.plugins = global.plugins || {};

global.prefix = new RegExp(
  '^[' +
    (process.env.PREFIX || '.!/\\-').replace(/[|\\{}()[\]^$+*?.\-^]/g, '\\$&') +
    ']'
);

const DB_PATH = join(__dirname, 'database', 'database.json');
global.db = new Low(new JSONFile(DB_PATH));

global.loadDatabase = async function () {
  if (global.db.READ) {
    return new Promise(res =>
      setInterval(() => {
        if (!global.db.READ) {
          clearInterval(this);
          res(global.db.data ?? global.loadDatabase());
        }
      }, 1000)
    );
  }
  if (global.db.data !== null) return;
  global.db.READ = true;
  await global.db.read().catch(() => {});
  global.db.READ = null;
  global.db.data = {
    users: {},
    chats: {},
    stats: {},
    settings: {},
    ...(global.db.data || {}),
  };
};

await global.loadDatabase();

setInterval(async () => {
  if (global.db.data) await global.db.write().catch(() => {});
}, 30_000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = t => new Promise(res => rl.question(t, res));

async function loadPlugins() {
  const pluginsDir = join(__dirname, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = join(pluginsDir, file);
    try {
      const mod = await import(`${filePath}?t=${Date.now()}`);
      global.plugins[file] = mod.default;
      loaded++;
    } catch (e) {
      console.log(chalk.red(`[ ❌ ] Error cargando ${file}: ${e.message}`));
      failed++;
    }
  }

  console.log(
    chalk.green(`[ ✅ ] Plugins: ${loaded} cargados`) +
      (failed ? chalk.red(` | ${failed} fallaron`) : '')
  );
}

function watchPlugins() {
  const pluginsDir = join(__dirname, 'plugins');
  fs.watch(pluginsDir, async (event, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    await new Promise(r => setTimeout(r, 500));
    await reloadPlugin(filename);
  });
}

async function startBot() {
  const authFolder = global.authFile || 'KanaSession';
  const authPath = join(__dirname, authFolder);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  const hasCreds = fs.existsSync(join(authPath, 'creds.json'));
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const msgCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

  let pairingCodeMode = false;
  let phoneNumber = global.botnumber;

  if (!hasCreds) {
    let opcion;
    if (process.argv.includes('qr')) {
      opcion = '1';
    } else if (process.argv.includes('code') || phoneNumber) {
      opcion = '2';
    } else {
      do {
        opcion = await question(
          chalk.yellowBright(
            '\n[ Kana Arima-MD ] Selecciona una opción:\n' +
              '  1. Código QR\n' +
              '  2. Código de 8 dígitos\n' +
              '→ '
          )
        );
      } while (!['1', '2'].includes(opcion));
    }

    if (opcion === '2') {
      pairingCodeMode = true;
      if (!phoneNumber) {
        phoneNumber = await question(
          chalk.cyan('\nIngresa tu número (ej: 5191234567890):\n→ ')
        );
        phoneNumber = phoneNumber.replace(/\D/g, '');
      }
    }
  }

  const conn = _makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !pairingCodeMode && !hasCreds,
    browser: ['KanaArima-MD', 'Chrome', '20.0.04'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    msgRetryCounterCache: msgCache,
    generateHighQualityLinkPreview: true,
    getMessage: async key => {
      return { conversation: '' };
    },
  });

  makeWASocket(conn);
  global.conn = conn;

  if (pairingCodeMode && !hasCreds && phoneNumber) {
    setTimeout(async () => {
      try {
        const code = await conn.requestPairingCode(phoneNumber);
        console.log(chalk.greenBright(`\n[ 🔑 ] Código de emparejamiento: ${chalk.bold(code)}\n`));
      } catch (e) {
        console.log(chalk.red('[ ❌ ] Error al obtener código:'), e.message);
      }
    }, 3000);
  }

  conn.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'open') {
      global.timestamp.connect = Date.now();
      global.botUptime = Date.now();

      const user = conn.user;
      console.log(
        chalk.greenBright(
          `\n[ ✅ ] Conectado como: ${user?.name || user?.verifiedName || 'Bot'} (${user?.id?.split(':')[0] || ''})`
        )
      );

      await loadPlugins();
      watchPlugins();
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log(
        chalk.yellow(`\n[ ⚠️ ] Desconectado. Razón: ${reason}`) +
          (shouldReconnect ? chalk.cyan(' → Reconectando...') : chalk.red(' → Sesión cerrada.'))
      );

      if (reason === DisconnectReason.loggedOut) {
        const credsFile = join(authPath, 'creds.json');
        if (fs.existsSync(credsFile)) fs.unlinkSync(credsFile);
        console.log(chalk.red('[ 🗑️ ] Sesión eliminada. Reinicia el bot.'));
        process.exit(1);
      }

      if (shouldReconnect) {
        setTimeout(() => startBot(), 5000);
      }
    }
  });

  conn.ev.on('creds.update', saveCreds);

  conn.ev.on('messages.upsert', async chatUpdate => {
    try {
      await handler.call(conn, chatUpdate);
    } catch (e) {
      console.error(chalk.red('[messages.upsert error]'), e.message);
    }
  });

  conn.ev.on('group-participants.update', async data => {
    try {
      await participantsUpdate.call(conn, data);
    } catch {}
  });

  conn.ev.on('groups.update', async updates => {
    for (const update of updates) {
      if (!update.id) continue;
      if (global.groupCache?.has(update.id)) {
        global.groupCache.delete(update.id);
      }
    }
  });

  conn.ev.on('contacts.update', updates => {
    for (const c of updates) {
      if (c.id && c.lid) registerLidPhone(c.lid, c.id);
    }
  });

  conn.ev.on('contacts.upsert', contacts => {
    for (const c of contacts) {
      if (c.id && c.lid) registerLidPhone(c.lid, c.id);
      if (conn.contacts) conn.contacts[c.id] = c;
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, { timestamp }] of global.groupCache.entries()) {
      if (now - timestamp > 5 * 60 * 1000) global.groupCache.delete(key);
    }
  }, 10 * 60 * 1000);

  return conn;
}

console.log(
  chalk.magentaBright(`
  ╔══════════════════════════════╗
  ║     🌸 Kana Arima-MD 🌸     ║
  ║    Bot de WhatsApp - v2.0   ║
  ╚══════════════════════════════╝
  `)
);

startBot().catch(e => {
  console.error(chalk.red('[ ❌ ] Error al iniciar:'), e.message);
  process.exit(1);
});
