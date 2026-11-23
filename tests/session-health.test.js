import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDS_BACKUP_FILE,
  CREDS_FILE,
  DOWNTIME_PURGE_AGE_MS,
  STALE_ROUTING_AGE_MS,
  createDecryptFailureMonitor,
  getCredsAgeMs,
  isEphemeralSessionFile,
  isIgnorableDecryptFailure,
  isPreKeyDecryptError,
  isResettablePeerJid,
  isValidCredsJson,
  prepareAuthFolder,
  purgeEphemeralSessionFiles,
  wrapSafeSaveCreds,
} from '../src/funcion/session-health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  fs.writeFileSync(path.join(dir, CREDS_FILE), '{"noiseKey":'); // truncado por SIGKILL
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
  // El respaldo debe conservar la última copia válida.
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
  // 1er fallo con error de PreKey → sube pre-keys, aún no reinicia peer ni purga
  const r1 = monitor.record({ peerJid: 'a@s.whatsapp.net', isPreKeyError: true }, t0);
  assert.equal(r1.shouldUploadPreKeys, true);
  assert.equal(r1.shouldResetPeer, false);
  assert.equal(r1.shouldPurgeAndReconnect, false);

  // 2do fallo del mismo peer dentro del enfriamiento → reinicia peer, no repite uploadPreKeys
  const r2 = monitor.record({ peerJid: 'a@s.whatsapp.net', isPreKeyError: true }, t0 + 1000);
  assert.equal(r2.shouldUploadPreKeys, false);
  assert.equal(r2.shouldResetPeer, true);
  assert.equal(r2.shouldPurgeAndReconnect, false);

  // 4 fallos más de distintos peers completan el umbral global (6) → purga global
  monitor.record({ peerJid: 'b@s.whatsapp.net' }, t0 + 2000);
  monitor.record({ peerJid: 'c@s.whatsapp.net' }, t0 + 3000);
  monitor.record({ peerJid: 'd@s.whatsapp.net' }, t0 + 4000);
  const r6 = monitor.record({ peerJid: 'e@s.whatsapp.net' }, t0 + 5000);
  assert.equal(r6.shouldPurgeAndReconnect, true);
  assert.equal(r6.shouldResetPeer, false);

  // Durante el enfriamiento no vuelve a disparar purga global aunque lleguen otros 6
  for (let i = 0; i < 6; i += 1) {
    const r = monitor.record({ peerJid: `x${i}@s.whatsapp.net` }, t0 + 10_000 + i * 100);
    assert.equal(r.shouldPurgeAndReconnect, false);
  }

  // Pasado el enfriamiento de pre-keys sí vuelve a permitir subida
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
