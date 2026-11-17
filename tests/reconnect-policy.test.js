import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_POLICY,
  DISCONNECT_CODES,
  RECONNECT,
  STOP,
  classifyDisconnect,
  nextReconnectDelay,
  shouldAlertOwner,
} from '../src/funcion/reconnect-policy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// rng fija: wobble = 0.5 * 2 - 1 = 0 → el retardo es exactamente el objetivo,
// sin jitter, así que se puede comprobar la progresión real.
const noJitter = () => 0.5
const delay = (attempt, policy) => nextReconnectDelay(attempt, policy, noJitter)

test('el retroceso crece en doble hasta el techo y no pasa de ahí', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((a) => delay(a)), [1000, 2000, 4000, 8000, 16000])
  assert.deepEqual([5, 6, 9].map((a) => delay(a)), [30000, 30000, 30000])
})

test('una tormenta de reintentos baja el ritmo en vez de mantenerlo', () => {
  // El caso que justifica stormMs: WiFi caído 6 horas. Con el techo de 30 s se
  // golpeaba el endpoint de WhatsApp 120 veces por hora; a partir del intento
  // 10 el ritmo pasa a 60 s.
  assert.equal(delay(9), 30000)
  assert.equal(delay(10), 60000)
  assert.equal(delay(4000), 60000)
  const antes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((a) => delay(a))
  const despues = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((a) => delay(a))
  assert.ok(Math.max(...antes) <= Math.min(...despues), 'el ritmo nunca debe acelerarse al escalar')
})

test('el jitter reparte intentos sin sacarlos de la banda', () => {
  for (const rng of [() => 0, () => 0.25, () => 0.75, () => 0.99999]) {
    const value = nextReconnectDelay(3, {}, rng)
    assert.ok(value >= 8000 * 0.75 - 1 && value <= 8000 * 1.25 + 1, `fuera de banda: ${value}`)
  }
  // Dos instancias hermanas que caen a la vez no deben volver exactamente a la vez.
  const a = nextReconnectDelay(4, {}, () => 0.1)
  const b = nextReconnectDelay(4, {}, () => 0.9)
  assert.notEqual(a, b)
})

test('el retardo nunca baja del intervalo base ni se descontrola', () => {
  for (const attempt of [0, 1, 2, 7, 30, 5000]) {
    for (const rng of [() => 0, () => 0.5, () => 0.999]) {
      const value = nextReconnectDelay(attempt, {}, rng)
      assert.ok(value >= DEFAULT_POLICY.baseMs, `${value} < baseMs`)
      assert.ok(value <= DEFAULT_POLICY.stormMs * 1.25 + 1, `${value} fuera del techo`)
    }
  }
  // rng roto (undefined, NaN) no debe producir NaN en el temporizador.
  assert.ok(Number.isFinite(nextReconnectDelay(2, {}, () => undefined)))
  assert.ok(Number.isFinite(nextReconnectDelay(-4, {}, () => 0.5)))
})

test('los motivos de sesión no admiten reintento', () => {
  // Cada uno de estos exige acción humana; reintentar solo gasta el rate limit
  // de emparejamiento y puede dejar dos sesiones peleadas por el mismo número.
  // 500 = badSession y 515 = restartRequired en este fork (ver DISCONNECT_CODES).
  for (const reason of [401, 500, 440, 411, 405]) {
    assert.equal(classifyDisconnect(reason), STOP, `${reason} debería ser terminal`)
  }
  assert.equal(classifyDisconnect('connectionReplaced'), STOP)
  assert.equal(classifyDisconnect('loggedOut'), STOP)
})

test('los cortes de red sí se reintentan, y lo desconocido también', () => {
  for (const reason of [428, 408, 515, 403, 499, 503]) {
    assert.equal(classifyDisconnect(reason), RECONNECT, `${reason} debería reintentarse`)
  }
  // Sin motivo no se puede sentenciar: mejor intentar que quedarse parado.
  for (const reason of [undefined, null, '', 'someNewReason']) {
    assert.equal(classifyDisconnect(reason), RECONNECT)
  }
})

test('los códigos se contrastan con los de baileys', async (t) => {
  let DisconnectReason
  try {
    ({ DisconnectReason } = await import('baileys'))
  } catch {
    t.skip('baileys no está instalado en este entorno')
    return
  }
  // Si el fork cambia un número, la tabla local se queda obsoleta en silencio y
  // un badSession dejaría de ser terminal. Esto lo pilla.
  const TERMINALES = new Set(['loggedOut', 'badSession', 'connectionReplaced', 'multideviceMismatch'])
  for (const [name, code] of Object.entries({
    loggedOut: 401, connectionClosed: 428, connectionLost: 408, connectionReplaced: 440,
    badSession: 500, restartRequired: 515, multideviceMismatch: 411,
  })) {
    assert.equal(DisconnectReason[name], code, `el fork cambió DisconnectReason.${name}: ${DisconnectReason[name]} !== ${code}`)
    assert.equal(DISCONNECT_CODES[name], code, 'la tabla local se quedó atrás respecto al enum real')
    assert.equal(classifyDisconnect(DisconnectReason[name], DisconnectReason),
      TERMINALES.has(name) ? STOP : RECONNECT, `${name} mal clasificado`)
  }
  // Sin pasar el enum, la tabla local tiene que dar el mismo veredicto.
  for (const name of TERMINALES) {
    assert.equal(classifyDisconnect(DISCONNECT_CODES[name]), STOP, `${name} sin enum debería ser terminal`)
  }
})

test('el aviso al owner sale una vez y luego a intervalos, no en cada intento', () => {
  const alertas = Array.from({ length: 50 }, (_, i) => i + 1).filter((a) => shouldAlertOwner(a))
  assert.deepEqual(alertas, [8, 28, 48])
  assert.equal(shouldAlertOwner(DEFAULT_POLICY.alertAfterAttempts - 1), false)
})

test('los umbrales tienen sentido entre sí', () => {
  assert.ok(DEFAULT_POLICY.baseMs < DEFAULT_POLICY.maxMs)
  assert.ok(DEFAULT_POLICY.maxMs <= DEFAULT_POLICY.stormMs)
  assert.ok(DEFAULT_POLICY.terminalRetryMs > DEFAULT_POLICY.stormMs,
    'el latido terminal debe ser más lento que el retroceso normal')
  assert.ok(DEFAULT_POLICY.connectTimeoutMs > DEFAULT_POLICY.baseMs,
    'el vigilante no puede expirar antes del primer reintento')
  assert.ok(DEFAULT_POLICY.jitterRatio > 0 && DEFAULT_POLICY.jitterRatio < 1)
})

// ── El cableado en main.js ────────────────────────────────────────────────
// La política es pura y se prueba arriba; lo que se comprueba aquí es que
// main.js la use y que no vuelvan a colarse las tres formas en que este
// mecanismo se quedaba dormido.
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')

test('main.js usa la política en lugar de un retroceso propio', () => {
  assert.match(mainSrc, /nextReconnectDelay\(reconnectAttempt, RECONNECT_POLICY\)/)
  assert.doesNotMatch(mainSrc, /1000 \* \(2 \*\*/, 'retroceso a mano: muévelo a reconnect-policy.js')
  assert.doesNotMatch(mainSrc, /if \(reconnectTimer \|\| socketReloadInProgress\) return;/,
    'descartar la reconexión por haber un recargue en curso dejaba al bot sin socket y sin temporizador')
})

test('un recargue en curso se reintenta en vez de perderse', () => {
  assert.match(mainSrc, /if \(reloaded === false\)/)
  assert.match(mainSrc, /busy:\$\{reason\}/)
})

test('el handshake lleva vigilante y el estado terminal no es un callejón', () => {
  assert.match(mainSrc, /armConnectWatchdog\(reason\)/)
  assert.match(mainSrc, /RECONNECT_POLICY\.connectTimeoutMs/)
  assert.match(mainSrc, /RECONNECT_POLICY\.terminalRetryMs/)
  assert.match(mainSrc, /classifyDisconnect\(reason, DisconnectReason\)/)
})

test('el apagado cancela lo programado', () => {
  const shutdown = mainSrc.slice(mainSrc.indexOf('async function gracefulShutdown'))
  assert.match(shutdown.slice(0, 600), /terminalSession = true;[\s\S]*clearPendingReconnect\(\);/)
  assert.match(mainSrc, /if \(terminalSession \|\| reconnectTimer \|\| shutdownStarted\) return;/)
})

test('handler.js no se reimporta con un especificador nuevo en cada reconexión', () => {
  // `?update=${Date.now()}` convertía cada reintento en un módulo fresco que ESM
  // no puede descargar: en una tormenta de reintentos la memoria crecía sin tope.
  assert.doesNotMatch(mainSrc, /import\(`\.\/handler\.js\?update=\$\{Date\.now\(\)\}`\)/)
  assert.match(mainSrc, /statSync\(handlerPath\)\.mtimeMs/)
  assert.match(mainSrc, /global\.opts\?\.dev/)
})
