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
 * `tests/reconnect-policy.test.js` compara esta tabla con el enum real.
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
