import { randomUUID } from 'node:crypto';

const active = new Map();

export const downloadKey = (m) => `${m?.chat || ''}:${m?.sender || ''}`;

export function startDownload(key, service, controller, extra = {}) {
  let jobs = active.get(key);
  if (!jobs) {
    jobs = new Map();
    active.set(key, jobs);
  }

  const previous = jobs.get(service);
  const { label, meta } = extra || {};
  const id = randomUUID();
  const job = {
    id,
    service,
    label: label || service,
    controller,
    startedAt: Date.now(),
    meta: meta || {},
  };
  jobs.set(service, job);

  if (previous && previous.controller !== controller) {
    try {
      previous.controller?.abort?.();
    } catch (error) {
      console.warn(`[descargas] no se pudo cancelar ${service} anterior:`, error?.message || error);
    }
  }

  return () => {
    const currentJobs = active.get(key);
    if (!currentJobs) return;
    if (currentJobs.get(service)?.id === id) {
      currentJobs.delete(service);
    }
    if (!currentJobs.size) active.delete(key);
  };
}

export function finishDownload(key, service, controller) {
  const jobs = active.get(key);
  if (!jobs) return;
  const job = jobs.get(service);
  if (job && (controller === undefined || job.controller === controller)) {
    jobs.delete(service);
  }
  if (!jobs.size) active.delete(key);
}

export function hasDownload(key, service) {
  const jobs = active.get(key);
  if (!jobs) return false;
  return service ? jobs.has(service) : jobs.size > 0;
}

export function listDownloads(key) {
  const jobs = active.get(key);
  if (!jobs) return [];
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function cancelDownloads(key, service) {
  const jobs = active.get(key);
  if (!jobs) return [];
  const targets = service ? [service] : [...jobs.keys()];
  const toAbort = [];
  for (const name of targets) {
    const job = jobs.get(name);
    if (!job) continue;
    jobs.delete(name);
    toAbort.push({ name, job });
  }
  if (!jobs.size) active.delete(key);

  const cancelled = [];
  for (const { name, job } of toAbort) {
    cancelled.push({ service: name, label: job.label });
    try {
      job.controller?.abort?.();
    } catch (error) {
      console.warn(`[descargas] no se pudo cancelar ${name}:`, error?.message || error);
    }
  }
  return cancelled;
}

export function elapsedLabel(job) {
  if (!Number.isFinite(job?.startedAt)) return '0s';
  const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
