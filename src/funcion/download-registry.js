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

// ─── Tests embebidos (solo al ejecutar `node --test src/funcion/download-registry.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { default: test } = await import('node:test');
    const { default: assert } = await import('node:assert/strict');

    const key = (over = {}) => downloadKey({ chat: 'grupo-1@g.us', sender: '51999@s.whatsapp.net', ...over });

    test('downloadKey separar usuarios dentro del mismo chat', () => {
      const a = downloadKey({ chat: 'g@g.us', sender: '111@s.whatsapp.net' });
      const b = downloadKey({ chat: 'g@g.us', sender: '222@s.whatsapp.net' });
      assert.notEqual(a, b);
      assert.equal(a, 'g@g.us:111@s.whatsapp.net');
    });

    test('cancelDownloads aborta todas las descargas activas del usuario', () => {
      const k = key();
      const mega = new AbortController();
      const mf = new AbortController();
      startDownload(k, 'mega', mega, { label: '☁️ Mega' });
      startDownload(k, 'mediafire', mf, { label: '🔥 MediaFire' });

      assert.deepEqual(listDownloads(k).map((j) => j.service), ['mega', 'mediafire']);

      const cancelled = cancelDownloads(k);
      assert.deepEqual(cancelled.map((j) => j.service).sort(), ['mediafire', 'mega']);
      assert.equal(mega.signal.aborted, true);
      assert.equal(mf.signal.aborted, true);
      assert.equal(hasDownload(k), false);
    });

    test('cancelDownloads sin descargas no lanza y devuelve lista vacía', () => {
      assert.deepEqual(cancelDownloads(key({ sender: 'nadie@x' })), []);
    });

    test('cancelDownloads puede filtrar por servicio', () => {
      const k = key({ sender: 'filtro@x' });
      const mega = new AbortController();
      const gd = new AbortController();
      startDownload(k, 'mega', mega);
      startDownload(k, 'gdrive', gd);

      const cancelled = cancelDownloads(k, 'mega');
      assert.deepEqual(cancelled.map((j) => j.service), ['mega']);
      assert.equal(mega.signal.aborted, true);
      assert.equal(gd.signal.aborted, false);
      assert.equal(hasDownload(k, 'gdrive'), true);
      assert.equal(hasDownload(k, 'mega'), false);
      cancelDownloads(k);
    });

    test('finishDownload solo libera el trabajo del mismo controller', () => {
      const k = key({ sender: 'reempazo@x' });
      const primero = new AbortController();
      startDownload(k, 'mega', primero);
      finishDownload(k, 'mega', primero);
      assert.equal(hasDownload(k, 'mega'), false);

      const segundo = new AbortController();
      startDownload(k, 'mega', segundo);
      finishDownload(k, 'mega', primero);
      assert.equal(hasDownload(k, 'mega'), true);
      cancelDownloads(k);
      assert.equal(hasDownload(k), false);
    });

    test('startDownload devuelve su propio limpiador', () => {
      const k = key({ sender: 'cleanup@x' });
      const controller = new AbortController();
      const stop = startDownload(k, 'mediafire', controller);
      assert.equal(hasDownload(k, 'mediafire'), true);
      stop();
      assert.equal(hasDownload(k, 'mediafire'), false);
    });
  }
}

