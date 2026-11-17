// Registro central de descargas cancelables.
//
// Cada descargador mantenía su propio mapa (`global.megaActiveDownloads`,
// `global.mfActiveDownloads`, `global.gdActiveDownloads`) y los tres
// reclamaban `.cancelar` / `.stop` en su `handler.command`. El despachador de
// handler.js no se detiene tras la primera coincidencia, así que un único
// `.cancelar` ejecutaba los tres plugins y contestaba hasta tres veces
// ("No hay descarga activa para este chat"). Ahora un solo plugin atiende la
// cancelación y consulta este registro.
import { randomUUID } from 'crypto';

/** userKey -> Map(service -> job) */
const active = new Map();

/** Clave por usuario dentro de un chat: dos personas del mismo grupo no comparten descarga. */
export const downloadKey = (m) => `${m.chat}:${m.sender || ''}`;

/**
 * Registra un trabajo de descarga.
 * @param {string} key clave de usuario (downloadKey)
 * @param {string} service identificador del servicio ('mega', 'mediafire', 'gdrive')
 * @param {AbortController} controller controlador que cancela la descarga
 * @param {{label?: string, meta?: object}} [extra] datos para el mensaje de confirmación
 * @returns {() => void} función de limpieza
 */
export function startDownload(key, service, controller, extra = {}) {
  let jobs = active.get(key);
  if (!jobs) {
    jobs = new Map();
    active.set(key, jobs);
  }
  const job = {
    id: randomUUID(),
    service,
    label: extra.label || service,
    controller,
    startedAt: Date.now(),
    meta: extra.meta || {},
  };
  jobs.set(service, job);
  return () => finishDownload(key, service, controller);
}

/**
 * Quita el trabajo del registro. Solo si sigue siendo el mismo controller, para
 * que el `finally` de una descarga terminada no deje huérfana a la siguiente.
 */
export function finishDownload(key, service, controller) {
  const jobs = active.get(key);
  if (!jobs) return;
  const job = jobs.get(service);
  if (job && (!controller || job.controller === controller)) jobs.delete(service);
  if (!jobs.size) active.delete(key);
}

/** ¿Hay una descarga en curso de este servicio para este usuario? */
export function hasDownload(key, service) {
  const jobs = active.get(key);
  if (!jobs) return false;
  return service ? jobs.has(service) : jobs.size > 0;
}

/** Descargas activas de un usuario, en orden de inicio. */
export function listDownloads(key) {
  const jobs = active.get(key);
  if (!jobs) return [];
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Cancela las descargas de un usuario (o solo las de un servicio).
 * @returns {Array<{service: string, label: string}>} lo que se canceló
 */
export function cancelDownloads(key, service) {
  const jobs = active.get(key);
  if (!jobs) return [];
  const targets = service ? [service] : [...jobs.keys()];
  const cancelled = [];
  for (const name of targets) {
    const job = jobs.get(name);
    if (!job) continue;
    cancelled.push({ service: name, label: job.label });
    try {
      job.controller?.abort?.();
    } catch (error) {
      console.warn(`[descargas] no se pudo cancelar ${name}:`, error?.message || error);
    }
    jobs.delete(name);
  }
  if (!jobs.size) active.delete(key);
  return cancelled;
}

/** Tiempo transcurrido de un trabajo, en texto corto. */
export function elapsedLabel(job) {
  const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
