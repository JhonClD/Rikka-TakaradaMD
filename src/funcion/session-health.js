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

