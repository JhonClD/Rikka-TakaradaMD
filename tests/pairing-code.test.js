import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enhanceSocketForPairing,
  getPairingCodePlatform,
  patchBaileysSourceFiles,
  sanitizePairingPhone,
} from '../src/funcion/baileys-pairing-fix.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rikka-pairing-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitizePairingPhone y getPairingCodePlatform normalizan número y plataforma para companion_hello', () => {
  assert.equal(sanitizePairingPhone('+51 925-092-348'), '51925092348');
  assert.equal(sanitizePairingPhone('5219992095479'), '5219992095479');
  assert.throws(() => sanitizePairingPhone('0123456'), /inválido/i);
  assert.throws(() => sanitizePairingPhone('123'), /inválido/i);

  assert.deepEqual(getPairingCodePlatform(['Ubuntu', 'Chrome', '22.04.4']), {
    id: '1',
    display: 'Chrome (Ubuntu)',
  });
  assert.deepEqual(getPairingCodePlatform(['Mac OS', 'Safari', '14.4.1']), {
    id: '5',
    display: 'Safari (Mac OS)',
  });
  assert.deepEqual(getPairingCodePlatform(['CustomBotName', 'Desktop', '1.0.0']), {
    id: '1',
    display: 'Chrome (Ubuntu)',
  });
});

test('patchBaileysSourceFiles corrige nonce 0x00, filtro primary_hello, handshake y registered de forma idempotente', (t) => {
  const fakeBaileys = makeTempDir(t);
  fs.mkdirSync(path.join(fakeBaileys, 'lib', 'Socket'), { recursive: true });
  fs.mkdirSync(path.join(fakeBaileys, 'lib', 'Utils'), { recursive: true });

  const socketFile = path.join(fakeBaileys, 'lib', 'Socket', 'socket.js');
  const messagesRecvFile = path.join(fakeBaileys, 'lib', 'Socket', 'messages-recv.js');
  const validateConnFile = path.join(fakeBaileys, 'lib', 'Utils', 'validate-connection.js');

  fs.writeFileSync(
    socketFile,
    [
      'if (!creds.me) {',
      '  node = generateRegistrationNode(creds, config);',
      '} else {',
      '  node = generateLoginNode(creds.me.id, config);',
      '}',
      'await sendNode({ content: [{ tag: "link_code_pairing_nonce", attrs: {}, content: "0" }] });',
      '    const advB64 = creds.advSecretKey;',
      '    let qrMs = qrTimeout || 6e4;',
      '    const genPairQR = () => {',
      '      if (!ws.isOpen) {',
      '        return;',
      '      }',
      '      const refNode = refNodes.shift();',
      '      if (!refNode) {',
      '        void end(new Boom("QR refs attempts ended", { statusCode: DisconnectReason.timedOut }));',
      '        return;',
      '      }',
      '      const ref = refNode.content.toString("utf-8");',
      '      const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);',
      '    };',
      'if (creds.me?.id) {\n      ev.buffer();',
      '}',
      'if (creds.me?.name !== name) {',
      '  sendNode({ tag: "presence", attrs: { name } });',
      '}',
    ].join('\n'),
  );

  fs.writeFileSync(
    messagesRecvFile,
    [
      'const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);',
      '      case "link_code_companion_reg":',
      '        const linkCodeCompanionReg = getBinaryNodeChild(node, "link_code_companion_reg");',
      '        const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, "link_code_pairing_ref"));',
    ].join('\n'),
  );

  fs.writeFileSync(
    validateConnFile,
    'const authUpdate = { account, me: { id: jid, name: bizName, lid }, signalIdentities: [], platform: platformNode?.attrs.name };\n',
  );

  const first = patchBaileysSourceFiles(fakeBaileys);
  assert.equal(first.allSatisfied, true);
  assert.equal(first.socket.changed, true);
  assert.equal(first.messagesRecv.changed, true);
  assert.equal(first.validateConnection.changed, true);

  const patchedSocket = fs.readFileSync(socketFile, 'utf8');
  const patchedRecv = fs.readFileSync(messagesRecvFile, 'utf8');
  const patchedValidate = fs.readFileSync(validateConnFile, 'utf8');

  assert.match(patchedSocket, /content:\s*Buffer\.alloc\(1\)/);
  assert.doesNotMatch(patchedSocket, /link_code_pairing_nonce.*content:\s*"0"/);
  assert.match(patchedSocket, /if \(!creds\.me \|\| \(!creds\.registered && !creds\.account\)\)/);
  assert.match(patchedSocket, /if \(name && creds\.account && creds\.me\?\.name !== name\)/);
  assert.match(patchedRecv, /if \(linkCodeCompanionReg\?\.attrs\?\.stage !== "primary_hello"\) break;/);
  assert.match(patchedRecv, /authState\.creds\.me\?\.id/);
  assert.match(patchedValidate, /registered:\s*true/);

  // Segunda pasada idempotente: no vuelve a reescribir nada.
  const second = patchBaileysSourceFiles(fakeBaileys);
  assert.equal(second.allSatisfied, true);
  assert.equal(second.socket.changed, false);
  assert.equal(second.messagesRecv.changed, false);
  assert.equal(second.validateConnection.changed, false);
});

test('enhanceSocketForPairing espera pair-device, usa query(), envía nonce 0x00 y revierte si WhatsApp rechaza', async () => {
  const ws = new EventEmitter();
  ws.isOpen = true;
  const ev = new EventEmitter();
  const queries = [];
  let shouldFailNextQuery = false;

  const creds = {
    registered: false,
    noiseKey: { public: Buffer.alloc(32, 7), private: Buffer.alloc(32, 8) },
    pairingEphemeralKeyPair: { public: Buffer.alloc(32, 9), private: Buffer.alloc(32, 10) },
    advSecretKey: Buffer.alloc(32, 1).toString('base64'),
    me: undefined,
    pairingCode: undefined,
  };

  const mockBaileys = {
    S_WHATSAPP_NET: 's.whatsapp.net',
    bytesToCrockford: () => 'R1KKA888',
    derivePairingCodeKey: async (_code, salt) => Buffer.alloc(32, salt[0] ^ 0x5a),
    aesEncryptCTR: (plaintext, key) => Buffer.from(plaintext.map((b, i) => b ^ key[i % key.length])),
    jidEncode: (user, server) => `${user}@${server}`,
  };

  const sock = {
    ws,
    ev,
    authState: { creds, keys: {} },
    query: async (node) => {
      queries.push(node);
      if (shouldFailNextQuery) throw new Error('bad-request (400)');
      return { tag: 'iq', attrs: { type: 'result' } };
    },
    requestPairingCode: async () => 'BROKEN00',
  };

  enhanceSocketForPairing(sock, {
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    baileys: mockBaileys,
    pairReadyTimeoutMs: 5_000,
    messagesRecvPatched: false,
  });

  // 1) Llamado ANTES de que llegue pair-device: debe encolarse sin mandar el IQ todavía.
  let resolvedCode = null;
  const pendingPromise = sock.requestPairingCode('+51 925-092-348').then((code) => {
    resolvedCode = code;
    return code;
  });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(queries.length, 0, 'no debe enviar companion_hello antes de pair-device');
  assert.equal(resolvedCode, null);

  // 2) Cuando WhatsApp envía pair-device, se desbloquea y envía companion_hello con nonce 0x00.
  ws.emit('CB:iq,type:set,pair-device', { tag: 'iq', attrs: { id: '1' } });
  const code = await pendingPromise;
  assert.equal(code, 'R1KKA888');
  assert.equal(queries.length, 1);

  const regNode = queries[0].content[0];
  assert.equal(regNode.tag, 'link_code_companion_reg');
  assert.equal(regNode.attrs.stage, 'companion_hello');
  assert.equal(regNode.attrs.jid, '51925092348@s.whatsapp.net');

  const childMap = Object.fromEntries(regNode.content.map((c) => [c.tag, c.content]));
  assert.equal(childMap.companion_platform_id, '1');
  assert.equal(childMap.companion_platform_display, 'Chrome (Ubuntu)');
  assert.ok(Buffer.isBuffer(childMap.link_code_pairing_nonce));
  assert.deepEqual(childMap.link_code_pairing_nonce, Buffer.from([0x00]));
  assert.equal(creds.me?.id, '51925092348@s.whatsapp.net');

  // 3) Si el FS fuera de solo lectura, la notificación temprana sin stage se neutraliza en memoria.
  const earlyNotif = {
    tag: 'notification',
    attrs: { type: 'link_code_companion_reg' },
    content: [{ tag: 'link_code_companion_reg', attrs: {}, content: [] }],
  };
  ws.emit('CB:notification', earlyNotif);
  assert.equal(earlyNotif.content[0].tag, 'link_code_companion_reg_ack_only');

  // La notificación real con stage="primary_hello" NO se toca.
  const primaryHello = {
    tag: 'notification',
    attrs: { type: 'link_code_companion_reg' },
    content: [{ tag: 'link_code_companion_reg', attrs: { stage: 'primary_hello' }, content: [] }],
  };
  ws.emit('CB:notification', primaryHello);
  assert.equal(primaryHello.content[0].tag, 'link_code_companion_reg');

  // 4) companion_reg_refresh rota advSecretKey mientras la sesión siga sin vincularse.
  const oldAdv = creds.advSecretKey;
  ws.emit('CB:notification,type:companion_reg_refresh', { tag: 'notification', attrs: {} });
  assert.notEqual(creds.advSecretKey, oldAdv);

  // 5) Si WhatsApp rechaza una solicitud posterior, no deja un pairingCode nuevo colgado.
  shouldFailNextQuery = true;
  await assert.rejects(() => sock.requestPairingCode('51925092348', 'ABCD2345'), /400/);
  assert.equal(creds.pairingCode, 'R1KKA888');
});

// Verifica el flujo criptográfico real sobre node_modules/baileys en un subproceso
// aislado (igual que reconnect-policy.test.js) para no contaminar process.exitCode en Node 20.
const baileysInstalled = fs.existsSync(path.join(ROOT, 'node_modules', 'baileys', 'lib', 'index.js'));

test('integración real con baileys: parches aplicados sobre node_modules y criptografía de código de 8 dígitos válida', {
  skip: baileysInstalled ? false : 'baileys no está instalado en node_modules',
}, () => {
  const e2eScript = `
    import assert from 'node:assert/strict';
    import { randomBytes } from 'node:crypto';
    import fs from 'node:fs';
    import { patchBaileysSourceFiles, enhanceSocketForPairing } from './src/funcion/baileys-pairing-fix.js';

    const patchReport = patchBaileysSourceFiles();
    assert.equal(patchReport.allSatisfied, true);

    const baileys = await import('baileys');
    assert.equal(typeof baileys.configureSuccessfulPairing, 'function');

    // Verificar que los tres módulos de baileys quedaron parcheados en disco
    const socketSrc = fs.readFileSync('./node_modules/baileys/lib/Socket/socket.js', 'utf8');
    const recvSrc = fs.readFileSync('./node_modules/baileys/lib/Socket/messages-recv.js', 'utf8');
    const valSrc = fs.readFileSync('./node_modules/baileys/lib/Utils/validate-connection.js', 'utf8');

    assert.ok(socketSrc.includes('content: Buffer.alloc(1)'));
    assert.ok(socketSrc.includes('if (!creds.me || (!creds.registered && !creds.account))'));
    assert.ok(recvSrc.includes('linkCodeCompanionReg?.attrs?.stage !== "primary_hello"'));
    assert.ok(recvSrc.includes('authState.creds.me?.id'));
    assert.ok(valSrc.includes('registered: true'));

    // Verificar cifrado/descifrado simétrico del código de 8 dígitos igual que el teléfono primario
    const creds = baileys.initAuthCreds();
    const pairingCode = 'ABCD2345';
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const key = await baileys.derivePairingCodeKey(pairingCode, salt);
    const primaryKeyPair = baileys.Curve.generateKeyPair();
    const wrappedPrimary = Buffer.concat([salt, iv, baileys.aesEncryptCTR(primaryKeyPair.public, key, iv)]);
    const unwrapped = baileys.aesDecryptCTR(wrappedPrimary.subarray(48, 80), key, wrappedPrimary.subarray(32, 48));
    assert.deepEqual(Buffer.from(unwrapped), Buffer.from(primaryKeyPair.public));
    void creds;
    void enhanceSocketForPairing;
    process.stdout.write('PAIRING_E2E_OK\\n');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', e2eScript], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.match(run.stdout || '', /PAIRING_E2E_OK/, `Falló prueba E2E de Baileys:\n${run.stderr || run.stdout}`);
});

test('index.js y main.js usan validación real de sesión vinculada y esperan flush antes de reconectar tras 515', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  assert.match(indexSrc, /hasRegisteredCredentials\(global\.authFilePath\)/);
  assert.doesNotMatch(indexSrc, /existsSync\(join\(global\.authFilePath,\s*'creds\.json'\)\)/);
  assert.match(mainSrc, /await saveCreds\?\.flush\?\.\(\)/);
  assert.match(mainSrc, /scheduleSocketReconnect\('restartRequired',\s*\{\s*immediate:\s*true\s*\}\)/);
  assert.doesNotMatch(mainSrc, /setTimeout\(requestPairingCodeOnce,\s*3000\)/);
});
