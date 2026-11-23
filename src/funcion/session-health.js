// Salud y auto-recuperación de la carpeta de sesión (`RikkaSession`).
//
// Cuando un VPS se apaga bruscamente (p. ej. límite de 8 horas) y pasa horas
// desconectado, la identidad del dispositivo en `creds.json` sigue siendo
// válida, pero los archivos efímeros de Signal (`session-*`, `sender-key-*`,
// `device-list-*`, `tctoken-*`) y el `routingInfo` quedan desfasados o truncados.
// Eso provoca tormentas de `Bad MAC` / `CIPHERTEXT` / `500 badSession` donde el
// bot parece conectado pero no responde a ningún comando aunque se reinicie.
//
// Este módulo limpia únicamente esa caché efímera y repara/respalda `creds.json`
// SIN borrar nunca la vinculación ni el estado de sincronización
// (`creds.json`, `pre-key-*`, `app-state-sync-key-*`, `app-state-sync-version-*`,
// `lid-mapping-*`, `identity-key-*`), evitando tener que eliminar `RikkaSession`.
import fs from 'node:fs';
import { join } from 'node:path';

export const CREDS_FILE = 'creds.json';
export const CREDS_BACKUP_FILE = 'creds.json.bak';

// Si el bot estuvo apagado más de este tiempo, `routingInfo` puede apuntar a un
// borde de WhatsApp antiguo y conviene limpiarlo antes de conectar.
export const STALE_ROUTING_AGE_MS = 30 * 60 * 1000;
// Si estuvo apagado más de este tiempo (típico en VPS con ciclos de 8 h),
// las sesiones Signal / sender-keys de grupos suelen estar desincronizadas y
// conviene purgar solo la caché efímera al arrancar, conservando `creds.json`.
export const DOWNTIME_PURGE_AGE_MS = 3 * 60 * 60 * 1000;

const EPHEMERAL_PREFIXES = [
  'session-',
  'sender-key-',
  'sender-key-memory-',
  'device-list-',
  'tctoken-',
];

/**
 * Determina si un archivo dentro de `RikkaSession/` es caché efímera que
 * Baileys regenera automáticamente (NUNCA coincide con `creds.json`,
 * `pre-key-*`, `app-state-sync-key-*`, `app-state-sync-version-*`,
 * `lid-mapping-*` ni `identity-key-*`).
 */
export function isEphemeralSessionFile(filename) {
  if (typeof filename !== 'string' || !filename) return false;
  if (filename === CREDS_FILE || filename === CREDS_BACKUP_FILE) return false;
  if (filename.startsWith('.corrupt-')) return true;
  if (!filename.endsWith('.json')) return false;
  return EPHEMERAL_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

export function isValidCredsJson(raw) {
  if (!raw || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === 'object' && parsed.noiseKey && parsed.signedIdentityKey);
  } catch {
    return false;
  }
}

/** Edad en ms desde la última modificación de `creds.json`, o 0 si no existe. */
export function getCredsAgeMs(authDir, now = Date.now()) {
  try {
    const stat = fs.statSync(join(authDir, CREDS_FILE));
    return Math.max(0, now - stat.mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * Elimina únicamente los archivos efímeros de Signal/sync dentro de `authDir`
 * para forzar una renegociación limpia sin desvincular la cuenta.
 *
 * @returns {Promise<{ removed: number, kept: number }>}
 */
export async function purgeEphemeralSessionFiles(authDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(authDir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  let removed = 0;
  let kept = 0;
  await Promise.all(
    entries.map(async (name) => {
      if (!isEphemeralSessionFile(name)) {
        kept += 1;
        return;
      }
      try {
        await fs.promises.unlink(join(authDir, name));
        removed += 1;
      } catch {
        // Archivo borrado en paralelo o bloqueado: ignorar.
      }
    }),
  );

  return { removed, kept };
}

/**
 * Repara `authDir` antes de abrir el socket:
 *  1. Restaura `creds.json` desde `creds.json.bak` si quedó truncado/corrupto.
 *  2. Ejecuta `repairAuthState` (si se provee) para aislar JSON corruptos.
 *  3. Opcionalmente purga archivos efímeros (tras apagado prolongado o tormenta
 *     de fallos de descifrado / `badSession`).
 */
export async function prepareAuthFolder(
  authDir,
  { repairAuthState, purgeEphemeral = false, log = console.log, warn = console.warn } = {},
) {
  const result = { restoredFromBackup: false, quarantined: [], purged: 0 };
  if (!fs.existsSync(authDir)) return result;

  const credsPath = join(authDir, CREDS_FILE);
  const backupPath = join(authDir, CREDS_BACKUP_FILE);

  let credsValid = false;
  try {
    credsValid = isValidCredsJson(await fs.promises.readFile(credsPath, 'utf8'));
  } catch {
    credsValid = false;
  }

  if (!credsValid && fs.existsSync(backupPath)) {
    try {
      const backupRaw = await fs.promises.readFile(backupPath, 'utf8');
      if (isValidCredsJson(backupRaw)) {
        const tmpRestore = `${credsPath}.restore-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tmpRestore, backupRaw, { mode: 0o600 });
        await fs.promises.rename(tmpRestore, credsPath);
        result.restoredFromBackup = true;
        log('[Auth] creds.json estaba dañado; restaurado automáticamente desde creds.json.bak.');
      }
    } catch (error) {
      warn('[Auth] No se pudo restaurar creds.json desde respaldo:', error?.message || error);
    }
  }

  if (typeof repairAuthState === 'function') {
    try {
      const report = await repairAuthState(authDir);
      if (report?.quarantined?.length) {
        result.quarantined = report.quarantined;
        const preview = report.quarantined.slice(0, 5).join(', ');
        log(`[Auth] Sesión reparada: se aislaron ${report.quarantined.length} archivo(s) corrupto(s) (${preview}).`);
      }
    } catch (error) {
      warn('[Auth] No se pudo verificar integridad de sesión:', error?.message || error);
    }
  }

  if (purgeEphemeral) {
    const { removed } = await purgeEphemeralSessionFiles(authDir);
    result.purged = removed;
    if (removed > 0) {
      log(`[Auth] Purgados ${removed} archivo(s) efímeros de Signal/sync (creds.json y pre-keys conservados).`);
    }
  }

  return result;
}

/**
 * Envuelve `saveCreds` para serializar escrituras concurrentes y mantener un
 * respaldo atómico (`creds.json.bak`) inmune a cortes de energía o SIGKILL.
 */
export function wrapSafeSaveCreds(rawSaveCreds, authDir) {
  let pending = Promise.resolve();
  return () => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        await rawSaveCreds();
        const credsPath = join(authDir, CREDS_FILE);
        const backupPath = join(authDir, CREDS_BACKUP_FILE);
        try {
          const raw = await fs.promises.readFile(credsPath, 'utf8');
          if (!isValidCredsJson(raw)) return;
          const tmpBak = `${backupPath}.tmp-${process.pid}-${Date.now()}`;
          await fs.promises.writeFile(tmpBak, raw, { mode: 0o600 });
          await fs.promises.rename(tmpBak, backupPath);
        } catch {
          // El guardado principal ya tuvo éxito; el respaldo se actualizará en el próximo creds.update.
        }
      });
    return pending;
  };
}

/**
 * Rastrea fallos de descifrado (`messages.decrypt-failed`) en una ventana
 * deslizante para decidir cuándo:
 *  - subir nuevas pre-keys (`uploadPreKeys`),
 *  - reiniciar la sesión Signal de un remitente concreto (`resetPeer`),
 *  - purgar la caché efímera global y reconectar (`purgeAndReconnect`).
 */
export function createDecryptFailureMonitor({
  windowMs = 60_000,
  peerThreshold = 2,
  globalThreshold = 6,
  purgeCooldownMs = 10 * 60 * 1000,
  preKeyCooldownMs = 2 * 60 * 1000,
} = {}) {
  const peerEvents = new Map();
  let globalEvents = [];
  let lastPurgeAt = 0;
  let lastPreKeyUploadAt = 0;

  return {
    record({ peerJid = '', isPreKeyError = false } = {}, now = Date.now()) {
      globalEvents = globalEvents.filter((ts) => now - ts <= windowMs);
      globalEvents.push(now);

      let peerCount = 0;
      if (peerJid) {
        const list = (peerEvents.get(peerJid) || []).filter((ts) => now - ts <= windowMs);
        list.push(now);
        peerEvents.set(peerJid, list);
        peerCount = list.length;
        // Evitar crecimiento infinito si hay muchos chats
        if (peerEvents.size > 300) {
          for (const [k, v] of peerEvents) {
            if (!v.length || now - v[v.length - 1] > windowMs) peerEvents.delete(k);
          }
        }
      }

      const shouldUploadPreKeys = Boolean(isPreKeyError) && (now - lastPreKeyUploadAt >= preKeyCooldownMs);
      if (shouldUploadPreKeys) lastPreKeyUploadAt = now;

      const shouldPurgeAndReconnect = globalEvents.length >= globalThreshold && (now - lastPurgeAt >= purgeCooldownMs);
      if (shouldPurgeAndReconnect) {
        lastPurgeAt = now;
        globalEvents = [];
        peerEvents.clear();
      }

      const shouldResetPeer = !shouldPurgeAndReconnect && Boolean(peerJid) && peerCount >= peerThreshold;
      if (shouldResetPeer) peerEvents.delete(peerJid);

      return {
        globalCount: globalEvents.length,
        peerCount,
        shouldUploadPreKeys,
        shouldResetPeer,
        shouldPurgeAndReconnect,
      };
    },
    reset() {
      peerEvents.clear();
      globalEvents = [];
    },
  };
}

/**
 * Filtra fallos de descifrado que NO implican una sesión Signal rota:
 *  - estados (`status@broadcast`) y canales (`@newsletter`) que expiran solos,
 *  - placeholders sin payload (`Message absent from node`), que Baileys reintenta aparte.
 */
export function isIgnorableDecryptFailure(info) {
  const remoteJid = String(info?.remoteJid || '');
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) {
    return true;
  }
  const errorMessage = String(info?.errorMessage || '');
  if (errorMessage === 'Message absent from node') return true;
  return false;
}

export function isPreKeyDecryptError(info) {
  if (info?.isPreKeyError) return true;
  return /prekey|key used already/i.test(String(info?.errorMessage || ''));
}

export function isResettablePeerJid(jid) {
  if (typeof jid !== 'string' || !jid || !jid.includes('@')) return false;
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  return true;
}

// ─── Tests embebidos (solo al ejecutar `node --test src/funcion/session-health.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { default: test } = await import('node:test');
    const { default: assert } = await import('node:assert/strict');
    const os = await import('node:os');

    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const VALID_CREDS = JSON.stringify({
      noiseKey: { private: 'a', public: 'b' },
      signedIdentityKey: { private: 'c', public: 'd' },
      registered: true,
    });

    function makeTempAuthDir(t) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rikka-session-health-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      return dir;
    }

    test('isEphemeralSessionFile selecciona solo cachés regenerables y jamás toca credenciales ni pre-keys', () => {
      const ephemeral = [
        'session-51999111222.0.json',
        'sender-key-120363000@g.us--51999111222--0.json',
        'sender-key-memory-120363000@g.us.json',
        'device-list-51999111222.json',
        'tctoken-51999111222@s.whatsapp.net.json',
        '.corrupt-session-123.json',
      ];
      for (const name of ephemeral) {
        assert.equal(isEphemeralSessionFile(name), true, `${name} debería considerarse efímero`);
      }

      const preserved = [
        CREDS_FILE,
        CREDS_BACKUP_FILE,
        'pre-key-1.json',
        'pre-key-812.json',
        'app-state-sync-key-AAAA.json',
        'app-state-sync-version-regular.json',
        'lid-mapping-51999111222.json',
        'identity-key-51999111222.json',
        'notes.txt',
        '',
        null,
      ];
      for (const name of preserved) {
        assert.equal(isEphemeralSessionFile(name), false, `${name} NUNCA debe purgarse`);
      }
    });

    test('isValidCredsJson y getCredsAgeMs validan credenciales y miden inactividad', (t) => {
      assert.equal(isValidCredsJson(VALID_CREDS), true);
      assert.equal(isValidCredsJson(''), false);
      assert.equal(isValidCredsJson('{"noiseKey": {}'), false);
      assert.equal(isValidCredsJson('{"foo":"bar"}'), false);

      const dir = makeTempAuthDir(t);
      assert.equal(getCredsAgeMs(dir), 0);

      const credsPath = path.join(dir, CREDS_FILE);
      fs.writeFileSync(credsPath, VALID_CREDS);
      const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000);
      fs.utimesSync(credsPath, fiveHoursAgo, fiveHoursAgo);

      const age = getCredsAgeMs(dir);
      assert.ok(age >= DOWNTIME_PURGE_AGE_MS, `esperaba >= ${DOWNTIME_PURGE_AGE_MS}, obtuve ${age}`);
      assert.ok(STALE_ROUTING_AGE_MS < DOWNTIME_PURGE_AGE_MS);
    });

    test('prepareAuthFolder restaura creds.json truncado desde respaldo y purga solo efímeros', async (t) => {
      const dir = makeTempAuthDir(t);
      fs.writeFileSync(path.join(dir, CREDS_FILE), '{"noiseKey":');
      fs.writeFileSync(path.join(dir, CREDS_BACKUP_FILE), VALID_CREDS);
      fs.writeFileSync(path.join(dir, 'pre-key-1.json'), '{"id":1}');
      fs.writeFileSync(path.join(dir, 'app-state-sync-key-k1.json'), '{"k":1}');
      fs.writeFileSync(path.join(dir, 'app-state-sync-version-regular.json'), '{"v":1}');
      fs.writeFileSync(path.join(dir, 'lid-mapping-123.json'), '"456"');
      fs.writeFileSync(path.join(dir, 'session-123.0.json'), '{"old":true}');
      fs.writeFileSync(path.join(dir, 'sender-key-g1.json'), '{"old":true}');
      fs.writeFileSync(path.join(dir, 'sender-key-memory-g1.json'), '{"old":true}');
      fs.writeFileSync(path.join(dir, 'device-list-123.json'), '["0"]');
      fs.writeFileSync(path.join(dir, 'tctoken-123.json'), '{}');
      fs.writeFileSync(path.join(dir, '.corrupt-session-9.json'), 'broken');

      let repairedDir = null;
      const report = await prepareAuthFolder(dir, {
        purgeEphemeral: true,
        repairAuthState: async (target) => {
          repairedDir = target;
          return { quarantined: ['session-bad.json'] };
        },
        log: () => {},
        warn: () => {},
      });

      assert.equal(repairedDir, dir);
      assert.equal(report.restoredFromBackup, true);
      assert.deepEqual(report.quarantined, ['session-bad.json']);
      assert.equal(report.purged, 6);
      assert.equal(isValidCredsJson(fs.readFileSync(path.join(dir, CREDS_FILE), 'utf8')), true);

      const remaining = fs.readdirSync(dir).sort();
      assert.deepEqual(remaining, [
        'app-state-sync-key-k1.json',
        'app-state-sync-version-regular.json',
        'creds.json',
        'creds.json.bak',
        'lid-mapping-123.json',
        'pre-key-1.json',
      ]);
    });

    test('purgeEphemeralSessionFiles tolera carpetas inexistentes', async () => {
      const res = await purgeEphemeralSessionFiles('/tmp/no-existe-rikka-session-xyz');
      assert.deepEqual(res, { removed: 0, kept: 0 });
    });

    test('wrapSafeSaveCreds serializa guardados y no sobreescribe el respaldo con JSON roto', async (t) => {
      const dir = makeTempAuthDir(t);
      const credsPath = path.join(dir, CREDS_FILE);
      const backupPath = path.join(dir, CREDS_BACKUP_FILE);

      let mode = 'valid';
      const safeSave = wrapSafeSaveCreds(async () => {
        fs.writeFileSync(credsPath, mode === 'valid' ? VALID_CREDS : '{"broken":');
      }, dir);

      await safeSave();
      assert.equal(fs.existsSync(backupPath), true);
      assert.equal(fs.readFileSync(backupPath, 'utf8'), VALID_CREDS);

      mode = 'corrupt';
      await safeSave();
      assert.equal(fs.readFileSync(backupPath, 'utf8'), VALID_CREDS);
    });

    test('createDecryptFailureMonitor sube pre-keys, reinicia peer y dispara purga global con enfriamiento', () => {
      const monitor = createDecryptFailureMonitor({
        windowMs: 60_000,
        peerThreshold: 2,
        globalThreshold: 6,
        purgeCooldownMs: 600_000,
        preKeyCooldownMs: 120_000,
      });

      const t0 = 1_000_000;
      const r1 = monitor.record({ peerJid: 'a@s.whatsapp.net', isPreKeyError: true }, t0);
      assert.equal(r1.shouldUploadPreKeys, true);
      assert.equal(r1.shouldResetPeer, false);
      assert.equal(r1.shouldPurgeAndReconnect, false);

      const r2 = monitor.record({ peerJid: 'a@s.whatsapp.net', isPreKeyError: true }, t0 + 1000);
      assert.equal(r2.shouldUploadPreKeys, false);
      assert.equal(r2.shouldResetPeer, true);
      assert.equal(r2.shouldPurgeAndReconnect, false);

      monitor.record({ peerJid: 'b@s.whatsapp.net' }, t0 + 2000);
      monitor.record({ peerJid: 'c@s.whatsapp.net' }, t0 + 3000);
      monitor.record({ peerJid: 'd@s.whatsapp.net' }, t0 + 4000);
      const r6 = monitor.record({ peerJid: 'e@s.whatsapp.net' }, t0 + 5000);
      assert.equal(r6.shouldPurgeAndReconnect, true);
      assert.equal(r6.shouldResetPeer, false);

      for (let i = 0; i < 6; i += 1) {
        const r = monitor.record({ peerJid: `x${i}@s.whatsapp.net` }, t0 + 10_000 + i * 100);
        assert.equal(r.shouldPurgeAndReconnect, false);
      }

      const afterPreKeyCooldown = monitor.record({ peerJid: 'z@s.whatsapp.net', isPreKeyError: true }, t0 + 130_000);
      assert.equal(afterPreKeyCooldown.shouldUploadPreKeys, true);
    });

    test('helpers de descifrado ignoran estados/canales/placeholders y protegen grupos', () => {
      assert.equal(isIgnorableDecryptFailure({ remoteJid: 'status@broadcast', errorMessage: 'Bad MAC' }), true);
      assert.equal(isIgnorableDecryptFailure({ remoteJid: '123@newsletter', errorMessage: 'Bad MAC' }), true);
      assert.equal(isIgnorableDecryptFailure({ remoteJid: '51999@s.whatsapp.net', errorMessage: 'Message absent from node' }), true);
      assert.equal(isIgnorableDecryptFailure({ remoteJid: '51999@s.whatsapp.net', errorMessage: 'Bad MAC' }), false);

      assert.equal(isPreKeyDecryptError({ isPreKeyError: true, errorMessage: '' }), true);
      assert.equal(isPreKeyDecryptError({ isPreKeyError: false, errorMessage: 'Key used already or never filled' }), true);
      assert.equal(isPreKeyDecryptError({ isPreKeyError: false, errorMessage: 'Invalid PreKey ID' }), true);
      assert.equal(isPreKeyDecryptError({ isPreKeyError: false, errorMessage: 'Bad MAC' }), false);

      assert.equal(isResettablePeerJid('51999@s.whatsapp.net'), true);
      assert.equal(isResettablePeerJid('123456789@lid'), true);
      assert.equal(isResettablePeerJid('120363000@g.us'), false);
      assert.equal(isResettablePeerJid('status@broadcast'), false);
      assert.equal(isResettablePeerJid(''), false);
    });

    test('cableado en main.js y handler.js protege sesiones tras apagados prolongados', () => {
      const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      const handlerSrc = fs.readFileSync(path.join(ROOT, 'handler.js'), 'utf8');

      assert.match(mainSrc, /ev\.on\('messages\.decrypt-failed',\s*activeConn\.onDecryptFailed\)/);
      assert.match(mainSrc, /ev\.off\('messages\.decrypt-failed',\s*activeConn\.onDecryptFailed\)/);
      assert.match(mainSrc, /loadAuthState\(global\.authFilePath,\s*\{\s*isStartup:\s*true\s*\}\)/);
      assert.match(mainSrc, /clearInterval\(healthTimer\)/);
      assert.match(handlerSrc, /const isLive = chatUpdate\.type === 'notify'/);
      assert.match(handlerSrc, /isValidMessage\(m,\s*\{\s*isLive\s*\}\)/);
    });
  }
}


