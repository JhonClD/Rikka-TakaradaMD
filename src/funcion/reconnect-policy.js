// Política de reconexión del socket de WhatsApp.
//
// Vive aparte de main.js para poder probarla sin abrir un WebSocket: aquí solo
// hay funciones puras (números dentro, números fuera). main.js decide CUÁNDO
// reconectar usando esto, y aquí se decide CUÁNTO esperar y CUÁNDO parar.
//
/**
 * Códigos de desconexión (DisconnectReason). Se repiten a mano a propósito:
 * mantener este módulo sin `import('baileys')` es lo que le permite correr en
 * los tests sin sesión ni red.
 *
 * OJO: son los del fork `this-xys/bails`, que NO coinciden con los de Baileys
 * estándar en dos sitios — aquí `badSession` es 500 y `restartRequired` 515,
 * justo al revés que upstream (515/500). Copiar la tabla de otro proyecto
 * convertiría un "sesión inválida, hace falta escanear" en un bucle de
 * reintentos, y dejaría fuera el 515 que sí pide reintentar.
 * Los tests embebidos al final de este módulo comparan esta tabla con el enum real.
 */
export const DISCONNECT_CODES = {
  loggedOut: 401,
  forbidden: 403,
  connectionLost: 408,
  timedOut: 408,
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
};

/** Reintentar vale la pena: suele ser un corte de red o un reinicio del servicio. */
export const RECONNECT = 'reconnect';
/** Reintentar no arregla nada; hace falta acción humana (o una sesión nueva). */
export const STOP = 'stop';

export const DEFAULT_POLICY = {
  baseMs: 1_000,
  factor: 2,
  /** Techo del retroceso "normal". */
  maxMs: 30_000,
  /** A partir de este número de intentos seguidos se pasa a `stormMs`. */
  stormAfterAttempts: 10,
  /**
   * Ritmo durante una tormenta (WiFi caído, WhatsApp manteniendo el bloqueo).
   * Más largo que `maxMs` a propósito: martillear cada 30 s durante horas no
   * acelera la recuperación y sí alimenta los rate limits del lado del server.
   */
  stormMs: 60_000,
  /** ± fracción aplicada al retardo para desincronizar instancias hermanas. */
  jitterRatio: 0.25,
  /**
   * Si tras reconectar el socket sigue sin abrir la conexión, se fuerza otro
   * intento. Cubre el caso en el que Baileys no emite `close` (TCP en negro:
   * el peer desapareció sin mandar FIN) y sin esto el bot se queda colgado
   * para siempre con un socket zombie.
   */
  connectTimeoutMs: 45_000,
  /** Aviso al owner tras este número de intentos seguidos sin conectar. */
  alertAfterAttempts: 8,
  /** Y luego, recordatorios cada este número de intentos. */
  alertEveryAttempts: 20,
  /**
   * Un estado terminal (sesión reemplazada, logout, badSession repetido) no se
   * arregla reintentando, pero tampoco conviene quedarse sordo hasta que
   * alguien reinicie el proceso: se espera este tiempo y se hace UN reintento,
   * que es lo que salva el caso "cerré la otra sesión / volví a vincular y no
   * me di cuenta de que había que reiniciar".
   */
  terminalRetryMs: 300_000,
  /**
   * En este fork de Baileys (`this-xys/bails`), `badSession` es 500 y también
   * es el código comodín cuando llega un `stream:error` sin código, un fallo
   * temporal de servidor o un error genérico de WebSocket. Un solo 500 no
   * prueba que la sesión esté muerta: se reintenta hasta este número de veces
   * consecutivas (reparando archivos JSON dañados) antes de pausar.
   */
  maxBadSessionRetries: 3,
};

const clampExponent = (value) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, 16));

/**
 * Retardo del intento `attempt` (0 para el primero), en milisegundos.
 * Exponencial con techo, más un jitter simétrico para que varias instancias
 * que cayeron juntas no vuelvan a intentar exactamente a la vez.
 *
 * @param {number} attempt intentos fallidos consecutivos, empezando en 0
 * @param {Partial<typeof DEFAULT_POLICY>} [policy]
 * @param {() => number} [rng] fuente de jitter en [0, 1)
 */
export function nextReconnectDelay(attempt = 0, policy = {}, rng = Math.random) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const growth = p.baseMs * (p.factor ** clampExponent(attempt));
  const capped = Math.min(p.maxMs, growth);
  const target = attempt >= p.stormAfterAttempts ? Math.max(p.stormMs, capped) : capped;
  const random = Number(rng());
  const wobble = Number.isFinite(random) ? (random * 2 - 1) : 0;
  const jittered = target * (1 + p.jitterRatio * wobble);
  const floor = p.baseMs;
  const ceil = Math.max(p.stormMs, p.maxMs) * (1 + p.jitterRatio);
  return Math.round(Math.min(ceil, Math.max(floor, jittered)));
}

/**
 * ¿Este motivo de cierre admite reintento automático?
 *
 * `stop` cubre los estados en los que reintentar es activamente dañino: con la
 * sesión rechazada (405/440) cada socket nuevo invalida al anterior y mantiene
 * el conflicto, y con `loggedOut`/`multideviceMismatch` WhatsApp rechazó
 * explícitamente las credenciales.
 *
 * `badSession` (500) es especial: Baileys también lo emite ante errores
 * transitorios de stream/WebSocket sin código numérico, así que se reintenta
 * hasta `maxBadSessionRetries` veces seguidas antes de pasar a `stop`.
 *
 * @param {number|string|null|undefined} reason statusCode del cierre
 * @param {Partial<typeof DISCONNECT_CODES>} [codes]
 * @param {{ badSessionAttempts?: number, maxBadSessionRetries?: number }} [options]
 * @returns {typeof RECONNECT | typeof STOP}
 */
export function classifyDisconnect(reason, codes = DISCONNECT_CODES, options = {}) {
  const d = { ...DISCONNECT_CODES, ...codes };
  if (reason === undefined || reason === null || reason === '') return RECONNECT;
  const numeric = Number(reason);
  const value = Number.isFinite(numeric) ? numeric : String(reason);
  const maxBadSessionRetries = Number.isFinite(options?.maxBadSessionRetries)
    ? options.maxBadSessionRetries
    : DEFAULT_POLICY.maxBadSessionRetries;
  const badSessionAttempts = Number.isFinite(options?.badSessionAttempts)
    ? options.badSessionAttempts
    : 0;

  const isBadSession = value === d.badSession
    || (typeof value === 'string' && /bad.?session/i.test(value));
  if (isBadSession) {
    return badSessionAttempts >= maxBadSessionRetries ? STOP : RECONNECT;
  }

  // Estos cuatro exigen acción humana inmediata; 403 y 503 son del propio
  // servidor y sí se recuperan solos.
  const terminal = [d.loggedOut, d.connectionReplaced, d.multideviceMismatch, 405];
  if (terminal.includes(value)) return STOP;
  // `connectionReplaced` puede venir como nombre en lugar de número.
  // Nombres en lugar de números (log de Baileys, forks): 'loggedOut', no 'logout'.
  if (typeof value === 'string' && /replaced|logged.?out|multi.?device/i.test(value)) return STOP;
  return RECONNECT;
}

/**
 * Toca avisar al owner en este intento. Se avisa una vez cruzado el umbral y
 * luego cada `alertEveryAttempts`, no en cada reintento: un aviso por intento
 * es la forma más rápida de que el owner silencie al bot.
 */
export function shouldAlertOwner(attempt, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  if (attempt < p.alertAfterAttempts) return false;
  return (attempt - p.alertAfterAttempts) % Math.max(1, p.alertEveryAttempts) === 0;
}

// ─── Tests embebidos (solo al ejecutar `node --test src/funcion/reconnect-policy.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { default: test } = await import('node:test');
    const { default: assert } = await import('node:assert/strict');
    const fs = await import('node:fs');
    const { spawnSync } = await import('node:child_process');

    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const noJitter = () => 0.5;
    const delay = (attempt, policy) => nextReconnectDelay(attempt, policy, noJitter);

    test('el retroceso crece en doble hasta el techo y no pasa de ahí', () => {
      assert.deepEqual([0, 1, 2, 3, 4].map((a) => delay(a)), [1000, 2000, 4000, 8000, 16000]);
      assert.deepEqual([5, 6, 9].map((a) => delay(a)), [30000, 30000, 30000]);
    });

    test('una tormenta de reintentos baja el ritmo en vez de mantenerlo', () => {
      assert.equal(delay(9), 30000);
      assert.equal(delay(10), 60000);
      assert.equal(delay(4000), 60000);
      const antes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((a) => delay(a));
      const despues = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((a) => delay(a));
      assert.ok(Math.max(...antes) <= Math.min(...despues), 'el ritmo nunca debe acelerarse al escalar');
    });

    test('el jitter reparte intentos sin sacarlos de la banda', () => {
      for (const rng of [() => 0, () => 0.25, () => 0.75, () => 0.99999]) {
        const value = nextReconnectDelay(3, {}, rng);
        assert.ok(value >= 8000 * 0.75 - 1 && value <= 8000 * 1.25 + 1, `fuera de banda: ${value}`);
      }
      const a = nextReconnectDelay(4, {}, () => 0.1);
      const b = nextReconnectDelay(4, {}, () => 0.9);
      assert.notEqual(a, b);
    });

    test('el retardo nunca baja del intervalo base ni se descontrola', () => {
      for (const attempt of [0, 1, 2, 7, 30, 5000]) {
        for (const rng of [() => 0, () => 0.5, () => 0.999]) {
          const value = nextReconnectDelay(attempt, {}, rng);
          assert.ok(value >= DEFAULT_POLICY.baseMs, `${value} < baseMs`);
          assert.ok(value <= DEFAULT_POLICY.stormMs * 1.25 + 1, `${value} fuera del techo`);
        }
      }
      assert.ok(Number.isFinite(nextReconnectDelay(2, {}, () => undefined)));
      assert.ok(Number.isFinite(nextReconnectDelay(-4, {}, () => 0.5)));
    });

    test('los motivos de sesión terminales no admiten reintento', () => {
      for (const reason of [401, 440, 411, 405]) {
        assert.equal(classifyDisconnect(reason), STOP, `${reason} debería ser terminal`);
      }
      assert.equal(classifyDisconnect('connectionReplaced'), STOP);
      assert.equal(classifyDisconnect('loggedOut'), STOP);
    });

    test('badSession (500) tolera reintentos acotados antes de pasar a STOP', () => {
      for (let attempt = 0; attempt < DEFAULT_POLICY.maxBadSessionRetries; attempt += 1) {
        assert.equal(
          classifyDisconnect(500, DISCONNECT_CODES, { badSessionAttempts: attempt }),
          RECONNECT,
          `intento ${attempt} de 500 debería reintentarse`,
        );
      }
      assert.equal(
        classifyDisconnect(500, DISCONNECT_CODES, { badSessionAttempts: DEFAULT_POLICY.maxBadSessionRetries }),
        STOP,
        'tras agotar los reintentos consecutivos, 500 debe pasar a STOP',
      );
      assert.equal(
        classifyDisconnect('badSession', DISCONNECT_CODES, { badSessionAttempts: DEFAULT_POLICY.maxBadSessionRetries }),
        STOP,
      );
    });

    test('los cortes de red sí se reintentan, y lo desconocido también', () => {
      for (const reason of [428, 408, 515, 403, 499, 503]) {
        assert.equal(classifyDisconnect(reason), RECONNECT, `${reason} debería reintentarse`);
      }
      for (const reason of [undefined, null, '', 'someNewReason']) {
        assert.equal(classifyDisconnect(reason), RECONNECT);
      }
    });

    function readRealDisconnectReason() {
      const code = 'import("baileys").then((m) => process.stdout.write(JSON.stringify(m.DisconnectReason ?? null)))';
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
      });
      const out = (run.stdout || '').trim().match(/\{.*\}/s)?.[0];
      if (!out) return null;
      try {
        return JSON.parse(out);
      } catch {
        return null;
      }
    }

    const REAL_DISCONNECT = readRealDisconnectReason();

    test('los códigos se contrastan con los de baileys', {
      skip: REAL_DISCONNECT ? false : 'no se pudo importar baileys en este entorno',
    }, () => {
      const DisconnectReason = REAL_DISCONNECT;
      const TERMINALES_INMEDIATOS = new Set(['loggedOut', 'connectionReplaced', 'multideviceMismatch']);
      for (const [name, code] of Object.entries({
        loggedOut: 401, connectionClosed: 428, connectionLost: 408, connectionReplaced: 440,
        badSession: 500, restartRequired: 515, multideviceMismatch: 411,
      })) {
        assert.equal(DisconnectReason[name], code, `el fork cambió DisconnectReason.${name}: ${DisconnectReason[name]} !== ${code}`);
        assert.equal(DISCONNECT_CODES[name], code, 'la tabla local se quedó atrás respecto al enum real');
        assert.equal(
          classifyDisconnect(DisconnectReason[name], DisconnectReason),
          TERMINALES_INMEDIATOS.has(name) ? STOP : RECONNECT,
          `${name} mal clasificado en el primer intento`,
        );
      }
      assert.equal(
        classifyDisconnect(DisconnectReason.badSession, DisconnectReason, { badSessionAttempts: DEFAULT_POLICY.maxBadSessionRetries }),
        STOP,
        'badSession tras agotar reintentos debe ser terminal',
      );
      for (const name of TERMINALES_INMEDIATOS) {
        assert.equal(classifyDisconnect(DISCONNECT_CODES[name]), STOP, `${name} sin enum debería ser terminal`);
      }
    });

    test('el aviso al owner sale una vez y luego a intervalos, no en cada intento', () => {
      const alertas = Array.from({ length: 50 }, (_, i) => i + 1).filter((a) => shouldAlertOwner(a));
      assert.deepEqual(alertas, [8, 28, 48]);
      assert.equal(shouldAlertOwner(DEFAULT_POLICY.alertAfterAttempts - 1), false);
    });

    test('los umbrales tienen sentido entre sí', () => {
      assert.ok(DEFAULT_POLICY.baseMs < DEFAULT_POLICY.maxMs);
      assert.ok(DEFAULT_POLICY.maxMs <= DEFAULT_POLICY.stormMs);
      assert.ok(DEFAULT_POLICY.terminalRetryMs > DEFAULT_POLICY.stormMs);
      assert.ok(DEFAULT_POLICY.connectTimeoutMs > DEFAULT_POLICY.baseMs);
      assert.ok(DEFAULT_POLICY.jitterRatio > 0 && DEFAULT_POLICY.jitterRatio < 1);
      assert.ok(DEFAULT_POLICY.maxBadSessionRetries >= 2 && DEFAULT_POLICY.maxBadSessionRetries <= 5);
    });

    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    test('main.js usa la política en lugar de un retroceso propio', () => {
      assert.match(mainSrc, /nextReconnectDelay\(reconnectAttempt, RECONNECT_POLICY\)/);
      assert.doesNotMatch(mainSrc, /1000 \* \(2 \*\*/, 'retroceso a mano: muévelo a reconnect-policy.js');
      assert.doesNotMatch(mainSrc, /if \(reconnectTimer \|\| socketReloadInProgress\) return;/);
    });

    test('un recargue en curso se reintenta en vez de perderse', () => {
      assert.match(mainSrc, /if \(reloaded === false\)/);
      assert.match(mainSrc, /busy:\$\{reason\}/);
    });

    test('el handshake lleva vigilante y el estado terminal no es un callejón', () => {
      assert.match(mainSrc, /armConnectWatchdog\(reason\)/);
      assert.match(mainSrc, /RECONNECT_POLICY\.connectTimeoutMs/);
      assert.match(mainSrc, /RECONNECT_POLICY\.terminalRetryMs/);
      assert.match(mainSrc, /classifyDisconnect\(reason, DisconnectReason\)/);
      assert.match(mainSrc, /classifyDisconnect\(reason, DisconnectReason, \{ badSessionAttempts: consecutiveBadSessions \}\)/);
    });

    test('plugins y listeners se preparan para no perder creds.update ni open inicial', () => {
      const filesInitPos = mainSrc.indexOf('await filesInit();');
      const bootSocketPos = mainSrc.lastIndexOf('global.conn = makeWASocket(connectionOptions);');
      const attachPos = mainSrc.indexOf('attachSocketHandlers(global.conn);', bootSocketPos);
      assert.ok(filesInitPos > 0 && bootSocketPos > filesInitPos, 'filesInit() debe terminar antes de abrir el socket');
      assert.ok(attachPos > bootSocketPos && attachPos - bootSocketPos < 250, 'attachSocketHandlers debe ejecutarse justo tras makeWASocket sin await intermedio');
    });

    test('el apagado cancela lo programado', () => {
      const shutdown = mainSrc.slice(mainSrc.indexOf('async function gracefulShutdown'));
      assert.match(shutdown.slice(0, 600), /terminalSession = true;[\s\S]*clearPendingReconnect\(\);/);
      assert.match(mainSrc, /if \(terminalSession \|\| reconnectTimer \|\| shutdownStarted\) return;/);
    });

    test('handler.js no se reimporta con un especificador nuevo en cada reconexión', () => {
      assert.doesNotMatch(mainSrc, /import\(`\.\/handler\.js\?update=\$\{Date\.now\(\)\}`\)/);
      assert.match(mainSrc, /statSync\(handlerPath\)\.mtimeMs/);
      assert.match(mainSrc, /global\.opts\?\.dev/);
    });
  }
}

