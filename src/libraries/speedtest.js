import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const CONFIG_URL = 'https://www.speedtest.net/speedtest-config.php';
const SERVER_LIST_URLS = [
  'https://www.speedtest.net/api/js/servers?engine=js&limit=12&https_functional=true',
  'https://www.speedtest.net/speedtest-servers.php?threads=4',
  'https://www.speedtest.net/speedtest-servers-static.php?threads=4',
];
const MAX_SERVERS_TO_PROBE = 8;
const PING_SAMPLES = 3;
const PING_TIMEOUT = 3_000;
const TEST_DURATION = 10_000;
const CONNECTIONS = 4;
const DOWNLOAD_SIZES = [750, 1000, 1500, 2000, 2500, 3000];
const UPLOAD_BYTES = 1_000_000;
const UPLOAD_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const UPLOAD_CONTENT = UPLOAD_CHARSET
  .repeat(Math.ceil((UPLOAD_BYTES - 9) / UPLOAD_CHARSET.length))
  .slice(0, UPLOAD_BYTES - 9);
const UPLOAD_PAYLOAD = Buffer.from(`content1=${UPLOAD_CONTENT}`, 'ascii');
const DEFAULT_HEADERS = {
  'Cache-Control': 'no-cache',
  'User-Agent': 'Mozilla/5.0 (compatible; RikkaTakaradaMD-Speedtest/1.0)',
};

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseXmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    attributes[match[1].toLowerCase()] = decodeXml(match[3]);
  }
  return attributes;
}

function normalizeServer(raw) {
  const rawUrl = raw.url || raw.uploadUrl || (raw.host ? `https://${raw.host}/speedtest/upload.php` : '');
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;

    return {
      id: String(raw.id || raw.serverId || 'N/A'),
      url: url.href,
      baseUrl: new URL('.', url).href,
      name: raw.name || raw.location || 'N/A',
      sponsor: raw.sponsor || raw.org || 'N/A',
      country: raw.country || '',
      distance: Number(raw.dist ?? raw.distance) || 0,
    };
  } catch {
    return null;
  }
}

function parseServerList(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.servers)
        ? parsed.servers
        : [];
    return entries.map(normalizeServer).filter(Boolean);
  }

  const tags = trimmed.match(/<server\b[^>]*>/gi) || [];
  return tags
    .map((tag) => normalizeServer(parseXmlAttributes(tag)))
    .filter(Boolean);
}

async function requestText(input, { timeoutMs = 12_000, ...options } = {}) {
  const target = new URL(input);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(target, {
      ...options,
      cache: 'no-store',
      headers: { ...DEFAULT_HEADERS, ...options.headers },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Se agotó el tiempo al conectar con ${target.host}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cacheBust(input) {
  const url = new URL(input);
  url.searchParams.set('x', `${Date.now()}.${Math.random().toString(16).slice(2)}`);
  return url;
}

function serverEndpoint(server, filename) {
  return cacheBust(new URL(filename, server.baseUrl));
}

async function getClientInfo() {
  try {
    const xml = await requestText(CONFIG_URL);
    const clientTag = xml.match(/<client\b[^>]*>/i)?.[0] || '';
    const client = parseXmlAttributes(clientTag);
    return { isp: client.isp || client.org || 'N/A' };
  } catch {
    return { isp: 'N/A' };
  }
}

async function getServers() {
  let lastError;
  for (const endpoint of SERVER_LIST_URLS) {
    try {
      const body = await requestText(endpoint);
      const servers = parseServerList(body);
      if (servers.length) return servers;
      lastError = new Error('La lista de Ookla no contenía servidores válidos.');
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`No pude obtener los servidores de Ookla: ${lastError?.message || 'sin respuesta'}`);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function probeServer(server) {
  const latencyUrl = new URL('latency.txt', server.baseUrl);
  const samples = [];

  for (let index = 0; index < PING_SAMPLES; index += 1) {
    const start = performance.now();
    try {
      const body = await requestText(cacheBust(latencyUrl), { timeoutMs: PING_TIMEOUT });
      if (!body.includes('test=test')) throw new Error('Respuesta de latencia inválida.');
      samples.push(performance.now() - start);
    } catch {
      // Se conservan las muestras válidas; los servidores que no respondan
      // a ninguna prueba quedan fuera de la selección.
    }
  }

  if (!samples.length) throw new Error(`El servidor ${server.name} no respondió.`);

  const differences = samples.slice(1).map((sample, index) => Math.abs(sample - samples[index]));
  return {
    ...server,
    latency: average(samples),
    jitter: differences.length ? average(differences) : 0,
  };
}

async function selectBestServer(servers) {
  const candidates = servers.slice(0, MAX_SERVERS_TO_PROBE);
  const results = await Promise.allSettled(candidates.map(probeServer));
  const available = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .sort((first, second) => first.latency - second.latency);

  if (!available.length) throw new Error('No encontré un servidor Ookla disponible.');
  return available[0];
}

async function measureDownload(server) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const state = { bytes: 0, requestIndex: 0, error: null };
  const timer = setTimeout(() => controller.abort(), TEST_DURATION);

  const worker = async () => {
    while (!controller.signal.aborted && performance.now() - startedAt < TEST_DURATION) {
      const size = DOWNLOAD_SIZES[state.requestIndex % DOWNLOAD_SIZES.length];
      state.requestIndex += 1;
      const url = serverEndpoint(server, `random${size}x${size}.jpg`);

      try {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: DEFAULT_HEADERS,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Descarga rechazada por el servidor (HTTP ${response.status}).`);
        }

        // `main.js` carga api.js, que reemplaza `global.fetch` por `node-fetch`:
        // su `body` es un stream de Node sin `getReader()`. La iteración
        // asíncrona funciona igual con ese stream y con el ReadableStream web.
        for await (const chunk of response.body) {
          if (controller.signal.aborted) break;
          state.bytes += chunk.byteLength ?? chunk.length;
        }
      } catch (error) {
        if (!controller.signal.aborted) state.error ||= error;
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  } finally {
    clearTimeout(timer);
  }

  const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
  if (!state.bytes) {
    throw new Error(state.error?.message || 'El servidor no entregó datos para medir la descarga.');
  }

  return {
    bytes: state.bytes,
    bitsPerSecond: (state.bytes * 8) / elapsed,
  };
}

async function measureUpload(server) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const state = { bytes: 0, error: null };
  const timer = setTimeout(() => controller.abort(), TEST_DURATION);

  const worker = async () => {
    while (!controller.signal.aborted && performance.now() - startedAt < TEST_DURATION) {
      try {
        const response = await fetch(cacheBust(server.url), {
          method: 'POST',
          cache: 'no-store',
          headers: {
            ...DEFAULT_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: UPLOAD_PAYLOAD,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`El servidor rechazó la subida (HTTP ${response.status}).`);
        await response.arrayBuffer();
        state.bytes += UPLOAD_PAYLOAD.byteLength;
      } catch (error) {
        if (!controller.signal.aborted) state.error ||= error;
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  } finally {
    clearTimeout(timer);
  }

  const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
  if (!state.bytes) {
    throw new Error(state.error?.message || 'El servidor no aceptó datos para medir la subida.');
  }

  return {
    bytes: state.bytes,
    bitsPerSecond: (state.bytes * 8) / elapsed,
  };
}

async function createShareResult({ server, download, upload }) {
  try {
    const ping = Math.round(server.latency);
    const downloadKbps = Math.round(download.bitsPerSecond / 1000);
    const uploadKbps = Math.round(upload.bitsPerSecond / 1000);
    const hash = createHash('md5')
      .update(`${ping}-${uploadKbps}-${downloadKbps}-297aae72`)
      .digest('hex');
    const form = new URLSearchParams({
      recommendedserverid: server.id,
      ping: String(ping),
      screenresolution: '',
      promo: '',
      download: String(downloadKbps),
      screendpi: '',
      upload: String(uploadKbps),
      testmethod: 'http',
      hash,
      touchscreen: 'none',
      startmode: 'pingselect',
      accuracy: '1',
      bytesreceived: String(download.bytes),
      bytessent: String(upload.bytes),
      serverid: server.id,
    });
    const body = await requestText('https://www.speedtest.net/api/api.php', {
      timeoutMs: 8_000,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'http://c.speedtest.net/flash/speedtest.swf',
      },
      body: form.toString(),
    });
    const resultId = new URLSearchParams(body).get('resultid');
    if (!resultId) return null;

    return {
      image: `https://www.speedtest.net/result/${encodeURIComponent(resultId)}.png`,
      url: `https://www.speedtest.net/result/${encodeURIComponent(resultId)}`,
    };
  } catch {
    return null;
  }
}

function formatMbps(bitsPerSecond) {
  const value = Number(bitsPerSecond);
  return Number.isFinite(value) ? `${(value / 1_000_000).toFixed(2)} Mbps` : 'N/A';
}

function formatData(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) ? `${(value / 1_000_000).toFixed(2)} MB` : 'N/A';
}

function formatMetric(value, unit) {
  return Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : 'N/A';
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

export function buildCaption(result, { title = '📡 *Speedtest de Ookla completado*' } = {}) {
  const location = [result.server.name, result.server.country].filter(Boolean).join(', ');
  const lines = title ? [title, ''] : [];
  lines.push(
    `⬇️ *Descarga:* ${formatMbps(result.download.bitsPerSecond)}`,
    `⬆️ *Subida:* ${formatMbps(result.upload.bitsPerSecond)}`,
    `📶 *Ping:* ${formatMetric(result.server.latency, 'ms')}`,
    `🧭 *Jitter:* ${formatMetric(result.server.jitter, 'ms')}`,
    '',
    `🏢 *ISP:* ${result.client.isp}`,
    `🖥️ *Servidor:* ${result.server.sponsor}`,
    `📍 *Ubicación:* ${location || 'N/A'}`,
    `🆔 *ID del servidor:* ${result.server.id}`,
    '',
    `📦 *Descargado:* ${formatData(result.download.bytes)}`,
    `📤 *Subido:* ${formatData(result.upload.bytes)}`,
    `🕒 *Fecha:* ${formatDate(result.timestamp)}`,
  );

  if (result.share?.url) lines.push('', `🔗 *Resultado:* ${result.share.url}`);
  return lines.join('\n');
}

/** Medición completa. Devuelve métricas crudas (bits/s, ms, bytes). */
export async function runSpeedtest({ share = true, onProgress } = {}) {
  const notify = (phase, data) => {
    try { onProgress?.(phase, data); } catch { /* un callback roto no debe frenar la medición */ }
  };

  notify('servers');
  const [client, servers] = await Promise.all([getClientInfo(), getServers()]);
  notify('ping');
  const server = await selectBestServer(servers);
  notify('download', server);
  const download = await measureDownload(server);
  notify('upload', server);
  const upload = await measureUpload(server);
  notify('share', server);
  const result = { client, server, download, upload, timestamp: new Date() };
  result.share = share ? await createShareResult(result) : null;
  return result;
}

/**
 * Da formato al resultado para WhatsApp.
 * La usan el comando `speedtest` y el bloque `sysinfo` de `tool-hots.js`,
 * así que no hay una segunda implementación del speedtest en el proyecto.
 */
export function speedtestReport(result, { title = '📡 *Speedtest de Ookla completado*' } = {}) {
  return {
    ...result,
    text: buildCaption(result, { title }),
    image: result.share?.image ?? null,
    url: result.share?.url ?? null,
  };
}

