// Parche de compatibilidad y refuerzo en tiempo de ejecución para la vinculación
// por código de 8 dígitos (`requestPairingCode`) y QR en `@this-xys/baileys`.
//
// Corrige los fallos de protocolo frente a los servidores actuales de WhatsApp:
//  1. `link_code_pairing_nonce` enviaba el carácter ASCII `'0'` (0x30) en vez
//     de un byte nulo (`Buffer.alloc(1)` = 0x00), haciendo que el teléfono
//     rechazara el código con "No se pudo vincular el dispositivo".
//  2. WhatsApp envía una notificación `link_code_companion_reg` inmediata sin
//     atributo `stage` (solo con `link_code_pairing_ref`) antes de que el
//     usuario escriba el código, y otra con `stage="primary_hello"` después.
//     Sin filtrar `stage === 'primary_hello'`, Baileys lanzaba `Invalid buffer`.
//  3. `requestPairingCode` fijaba `creds.me` antes de registrar la sesión y
//     `validateConnection` comprobaba solo `if (!creds.me)`, enviando un nodo
//     de login en lugar de registro en reconexiones previas a completar el par.
//  4. `requestPairingCode` usaba `sendNode` (sin esperar respuesta IQ ni errores
//     400/429) y podía ejecutarse antes de recibir `pair-device`, mostrando
//     códigos nunca registrados en WhatsApp.
//  5. `configureSuccessfulPairing` no marcaba `registered: true` y el evento
//     `creds.update` en `pair-success` disparaba `<presence>` antes de firmar.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fromRoot } from './paths.js';
import { isAuthenticatedCreds } from './session-health.js';

const DEFAULT_PAIRING_PLATFORM = { id: '1', displayName: 'Chrome' };

const PAIRING_BROWSER_PLATFORMS = {
  CHROME: DEFAULT_PAIRING_PLATFORM,
  FIREFOX: { id: '2', displayName: 'Firefox' },
  IE: { id: '3', displayName: 'IE' },
  OPERA: { id: '4', displayName: 'Opera' },
  SAFARI: { id: '5', displayName: 'Safari' },
  EDGE: { id: '6', displayName: 'Edge' },
};

const ACCEPTED_PAIRING_OS = new Map([
  ['ubuntu', 'Ubuntu'],
  ['mac os', 'Mac OS'],
  ['macos', 'Mac OS'],
  ['windows', 'Windows'],
]);

/**
 * Normaliza la tupla `browser` (`[os, browserName, version]`) a un par
 * `{ id, display }` aceptado por WhatsApp durante `companion_hello`.
 */
export function getPairingCodePlatform(browser) {
  const rawOs = String(browser?.[0] || '').trim().toLowerCase();
  const rawBrowser = String(browser?.[1] || '').trim().toUpperCase();
  const entry = PAIRING_BROWSER_PLATFORMS[rawBrowser] || DEFAULT_PAIRING_PLATFORM;
  const osDisplay = ACCEPTED_PAIRING_OS.get(rawOs) || 'Ubuntu';
  return {
    id: entry.id,
    display: `${entry.displayName} (${osDisplay})`,
  };
}

/**
 * Limpia y valida un número E.164 (7 a 15 dígitos, sin `+` ni ceros iniciales)
 * para construir el JID `<digits>@s.whatsapp.net` sin caracteres espurios.
 */
export function sanitizePairingPhone(phoneNumber) {
  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    throw new Error('Número de teléfono inválido; incluye el código de país (ej. 51925092348).');
  }
  return digits;
}

function applyFileReplacements(filePath, rules) {
  if (!fs.existsSync(filePath)) return { exists: false, changed: false, satisfied: false };
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { exists: true, changed: false, satisfied: false };
  }

  let updated = source;
  let allSatisfied = true;

  for (const { marker, target, replacement } of rules) {
    if (updated.includes(marker)) continue;
    if (updated.includes(target)) {
      updated = updated.replace(target, replacement);
    }
    if (!updated.includes(marker)) {
      allSatisfied = false;
    }
  }

  if (updated !== source) {
    try {
      fs.writeFileSync(filePath, updated, 'utf8');
      return { exists: true, changed: true, satisfied: allSatisfied };
    } catch {
      // Entorno de solo lectura: el refuerzo en tiempo de ejecución cubre el flujo.
      return { exists: true, changed: false, satisfied: false };
    }
  }

  return { exists: true, changed: false, satisfied: allSatisfied };
}

let cachedPatchReport = null;

/**
 * Aplica de forma idempotente los parches sobre `node_modules/baileys/lib/*`
 * antes de que Node cargue el paquete por ESM (`await import('baileys')`).
 */
export function patchBaileysSourceFiles(baileysDir = fromRoot('node_modules', 'baileys')) {
  const isDefaultDir = baileysDir === fromRoot('node_modules', 'baileys');
  if (isDefaultDir && cachedPatchReport) return cachedPatchReport;

  const socketPath = join(baileysDir, 'lib', 'Socket', 'socket.js');
  const messagesRecvPath = join(baileysDir, 'lib', 'Socket', 'messages-recv.js');
  const validateConnPath = join(baileysDir, 'lib', 'Utils', 'validate-connection.js');

  const socketResult = applyFileReplacements(socketPath, [
    {
      marker: 'if (!creds.me || (!creds.registered && !creds.account)) {',
      target: 'if (!creds.me) {',
      replacement: 'if (!creds.me || (!creds.registered && !creds.account)) {',
    },
    {
      marker: '{ tag: "link_code_pairing_nonce", attrs: {}, content: Buffer.alloc(1) }',
      target: '{ tag: "link_code_pairing_nonce", attrs: {}, content: "0" }',
      replacement: '{ tag: "link_code_pairing_nonce", attrs: {}, content: Buffer.alloc(1) }',
    },
    {
      marker: 'if (creds.me?.id && (creds.registered || creds.account)) {',
      target: 'if (creds.me?.id) {\n      ev.buffer();',
      replacement: 'if (creds.me?.id && (creds.registered || creds.account)) {\n      ev.buffer();',
    },
    {
      marker: 'if (name && creds.account && creds.me?.name !== name) {',
      target: 'if (creds.me?.name !== name) {',
      replacement: 'if (name && creds.account && creds.me?.name !== name) {',
    },
    {
      marker: 'buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser)',
      target: [
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
      ].join('\n'),
      replacement: [
        '    let pairingCodeExtended = false;',
        '    let qrMs = qrTimeout || 6e4;',
        '    const genPairQR = () => {',
        '      if (!ws.isOpen) {',
        '        return;',
        '      }',
        '      const refNode = refNodes.shift();',
        '      if (!refNode) {',
        '        if (creds.pairingCode && !creds.registered && !pairingCodeExtended) {',
        '          pairingCodeExtended = true;',
        '          qrTimer = setTimeout(genPairQR, 18e4);',
        '          return;',
        '        }',
        '        void end(new Boom("QR refs attempts ended", { statusCode: DisconnectReason.timedOut }));',
        '        return;',
        '      }',
        '      const ref = refNode.content.toString("utf-8");',
        '      const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);',
      ].join('\n'),
    },
  ]);

  const messagesRecvResult = applyFileReplacements(messagesRecvPath, [
    {
      marker: 'if (linkCodeCompanionReg?.attrs?.stage !== "primary_hello") break;',
      target: [
        '      case "link_code_companion_reg":',
        '        const linkCodeCompanionReg = getBinaryNodeChild(node, "link_code_companion_reg");',
      ].join('\n'),
      replacement: [
        '      case "link_code_companion_reg":',
        '        const linkCodeCompanionReg = getBinaryNodeChild(node, "link_code_companion_reg");',
        '        if (linkCodeCompanionReg?.attrs?.stage !== "primary_hello") break;',
      ].join('\n'),
    },
    {
      marker: 'buildAckStanza(node, errorCode, authState.creds.me?.id)',
      target: 'const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);',
      replacement: 'const stanza = buildAckStanza(node, errorCode, authState.creds.me?.id);',
    },
  ]);

  const validateConnResult = applyFileReplacements(validateConnPath, [
    {
      marker: 'platform: platformNode?.attrs.name, registered: true };',
      target: 'platform: platformNode?.attrs.name };',
      replacement: 'platform: platformNode?.attrs.name, registered: true };',
    },
  ]);

  const report = {
    socket: socketResult,
    messagesRecv: messagesRecvResult,
    validateConnection: validateConnResult,
    allSatisfied: Boolean(
      socketResult.satisfied && messagesRecvResult.satisfied && validateConnResult.satisfied,
    ),
  };

  if (isDefaultDir) cachedPatchReport = report;
  return report;
}

function defaultNormalizePairingCode(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : '';
}

/**
 * Refuerza una instancia viva de `WASocket` para que:
 *  - `requestPairingCode` espere siempre a que llegue `pair-device` antes de
 *    enviar `companion_hello`, use `query()` (verificando respuesta IQ sin
 *    errores), envíe `Buffer.alloc(1)` como nonce y normalice plataforma/JID.
 *  - Si `messages-recv.js` no pudo parchearse en disco (FS de solo lectura),
 *    filtre igualmente las notificaciones `link_code_companion_reg` sin
 *    `stage="primary_hello"` antes de que rompan con `Invalid buffer`.
 *  - Rote `advSecretKey` ante `companion_reg_refresh` en sesiones aún sin vincular.
 */
export function enhanceSocketForPairing(
  sock,
  { browser, baileys, pairReadyTimeoutMs = 25_000, messagesRecvPatched } = {},
) {
  if (!sock || sock.__rikkaPairingEnhanced) return sock;
  Object.defineProperty(sock, '__rikkaPairingEnhanced', { value: true, enumerable: false });

  const {
    S_WHATSAPP_NET = 's.whatsapp.net',
    aesEncryptCTR,
    bytesToCrockford,
    derivePairingCodeKey,
    jidEncode = (user, server) => `${user}@${server}`,
    normalizePairingCode = defaultNormalizePairingCode,
  } = baileys || {};

  let pairDeviceReady = Boolean(isAuthenticatedCreds(sock.authState?.creds));
  let closedError = null;
  const readyWaiters = new Set();

  const resolveReadyWaiters = () => {
    pairDeviceReady = true;
    for (const waiter of readyWaiters) waiter.resolve();
    readyWaiters.clear();
  };

  const rejectReadyWaiters = (err) => {
    const error = err instanceof Error ? err : new Error(String(err || 'Conexión cerrada antes de emparejar'));
    closedError = error;
    for (const waiter of readyWaiters) waiter.reject(error);
    readyWaiters.clear();
  };

  if (typeof sock.ws?.on === 'function') {
    sock.ws.on('CB:iq,type:set,pair-device', () => {
      // Dejar que el listener interno de socket.js envíe primero el IQ result de pair-device.
      queueMicrotask(resolveReadyWaiters);
    });
    sock.ws.on('close', () => {
      rejectReadyWaiters(new Error('WebSocket cerrado antes de recibir pair-device'));
    });

    // Respaldo en memoria si node_modules es de solo lectura y messages-recv.js no se parcheó.
    const recvPatched = messagesRecvPatched ?? Boolean(cachedPatchReport?.messagesRecv?.satisfied);
    if (!recvPatched && typeof sock.ws.prependListener === 'function') {
      sock.ws.prependListener('CB:notification', (node) => {
        if (!Array.isArray(node?.content)) return;
        for (const child of node.content) {
          if (child?.tag === 'link_code_companion_reg' && child.attrs?.stage !== 'primary_hello') {
            child.tag = 'link_code_companion_reg_ack_only';
          }
        }
      });
    }

    sock.ws.on('CB:notification,type:companion_reg_refresh', () => {
      const creds = sock.authState?.creds;
      if (!creds || isAuthenticatedCreds(creds)) return;
      creds.advSecretKey = randomBytes(32).toString('base64');
      sock.ev?.emit?.('creds.update', { advSecretKey: creds.advSecretKey });
    });
  }

  if (typeof sock.ev?.on === 'function') {
    sock.ev.on('connection.update', (update) => {
      if (update?.qr) resolveReadyWaiters();
      if (update?.connection === 'close') {
        rejectReadyWaiters(update?.lastDisconnect?.error || new Error('Conexión cerrada durante el emparejamiento'));
      }
    });
  }

  const waitForPairDeviceReady = () => {
    if (pairDeviceReady) return Promise.resolve();
    if (closedError) return Promise.reject(closedError);
    if (sock.ws && (sock.ws.isClosed || sock.ws.isClosing)) {
      return Promise.reject(new Error('El WebSocket se cerró antes de iniciar el emparejamiento'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(new Error('Tiempo agotado esperando que WhatsApp habilite el registro del dispositivo (pair-device)'));
      }, pairReadyTimeoutMs);
      timer.unref?.();

      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      readyWaiters.add(waiter);
    });
  };

  if (
    typeof sock.query === 'function'
    && typeof bytesToCrockford === 'function'
    && typeof derivePairingCodeKey === 'function'
    && typeof aesEncryptCTR === 'function'
  ) {
    let inFlightPairing = null;

    sock.requestPairingCode = async (phoneNumber, customPairingCode) => {
      if (inFlightPairing) return inFlightPairing;

      inFlightPairing = (async () => {
        const creds = sock.authState?.creds;
        if (!creds) {
          throw new Error('No hay estado de credenciales inicializado en el socket.');
        }

        const cleanPhone = sanitizePairingPhone(phoneNumber);
        let normalizedCustom = '';
        if (customPairingCode !== undefined && customPairingCode !== null && customPairingCode !== '') {
          normalizedCustom = normalizePairingCode(customPairingCode);
          if (!normalizedCustom) {
            throw new Error('El código personalizado debe tener exactamente 8 caracteres alfanuméricos.');
          }
        }

        await waitForPairDeviceReady();

        const pairingCode = normalizedCustom || bytesToCrockford(randomBytes(5));
        const salt = randomBytes(32);
        const randomIv = randomBytes(16);
        const derivedKey = await derivePairingCodeKey(pairingCode, salt);
        const cipheredPub = aesEncryptCTR(creds.pairingEphemeralKeyPair.public, derivedKey, randomIv);
        const wrappedCompanionEphemeralPub = Buffer.concat([salt, randomIv, cipheredPub]);

        const jid = jidEncode(cleanPhone, 's.whatsapp.net');
        const platform = getPairingCodePlatform(browser);
        const previousPairingCode = creds.pairingCode;
        creds.pairingCode = pairingCode;

        try {
          const result = await sock.query({
            tag: 'iq',
            attrs: {
              to: S_WHATSAPP_NET,
              type: 'set',
              xmlns: 'md',
            },
            content: [
              {
                tag: 'link_code_companion_reg',
                attrs: {
                  jid,
                  stage: 'companion_hello',
                  should_show_push_notification: 'true',
                },
                content: [
                  {
                    tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                    attrs: {},
                    content: wrappedCompanionEphemeralPub,
                  },
                  {
                    tag: 'companion_server_auth_key_pub',
                    attrs: {},
                    content: creds.noiseKey.public,
                  },
                  {
                    tag: 'companion_platform_id',
                    attrs: {},
                    content: platform.id,
                  },
                  {
                    tag: 'companion_platform_display',
                    attrs: {},
                    content: platform.display,
                  },
                  {
                    tag: 'link_code_pairing_nonce',
                    attrs: {},
                    content: Buffer.alloc(1),
                  },
                ],
              },
            ],
          });

          if (!result) {
            throw new Error('Tiempo agotado esperando confirmación de WhatsApp para el código de 8 dígitos.');
          }
        } catch (error) {
          if (creds.pairingCode === pairingCode) {
            creds.pairingCode = previousPairingCode;
          }
          throw error;
        }

        // Mutar creds.me ANTES de creds.update evita que el listener interno de
        // socket.js interprete el nombre '~' como cambio de pushName y envíe <presence>.
        creds.me = { id: jid, name: creds.me?.name || '~' };
        sock.ev?.emit?.('creds.update', creds);
        return pairingCode;
      })();

      try {
        return await inFlightPairing;
      } finally {
        inFlightPairing = null;
      }
    };
  }

  return sock;
}
