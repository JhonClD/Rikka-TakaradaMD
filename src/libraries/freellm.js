import axios from 'axios';

export const FREELLM_BASE_URL = 'https://api.apisfreellm.com/v1';
export const FREELLM_CHAT_ENDPOINT = `${FREELLM_BASE_URL}/chat/completions`;
export const FREELLM_MODEL = 'free-ai';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_RETRIES = 3;
const MIN_GAP_MS = 1_100; // límite de la API: 1 req/s por IP

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Encola llamadas para respetar el límite global de 1 req/s por IP entre todos los plugins. */
function scheduleRequest(task) {
  const run = requestQueue.catch(() => {}).then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  requestQueue = run.catch(() => {});
  return run;
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(String(headerValue));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function isDailyLimitError(status, message) {
  return status === 429 && /daily|per day|allowance|00:00\s*utc/i.test(String(message || ''));
}

export function stripThinkingTags(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();
}

/**
 * Envía una conversación en formato OpenAI Chat Completions a APIsFreeLLM (sin API key).
 *
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {{ maxTokens?: number, temperature?: number, timeoutMs?: number, maxRetries?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function chatCompletion(messages, options = {}) {
  const {
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = DEFAULT_TEMPERATURE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    signal,
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await scheduleRequest(() =>
        axios.post(
          FREELLM_CHAT_ENDPOINT,
          {
            model: FREELLM_MODEL,
            messages,
            max_tokens: maxTokens,
            temperature,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
            signal,
            validateStatus: () => true,
          },
        ),
      );

      const { status, data, headers } = response;
      const apiError = data?.error?.message || (typeof data?.error === 'string' ? data.error : null);

      if (status >= 200 && status < 300) {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.trim()) {
          return content.trim();
        }
        throw new Error(apiError || 'La API respondió sin contenido.');
      }

      if (isDailyLimitError(status, apiError)) {
        const err = new Error('Se alcanzó el límite diario de APIsFreeLLM (se reinicia a las 00:00 UTC).');
        err.status = status;
        err.isRateLimit = true;
        throw err;
      }

      const retryable = status === 503 || status === 502 || status === 504 || status === 429;
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(headers?.['retry-after']);
        if (retryAfter !== null && retryAfter > 30_000) {
          const err = new Error(apiError || `Límite de peticiones activo (intenta de nuevo en ${Math.ceil(retryAfter / 1000)}s).`);
          err.status = status;
          err.isRateLimit = status === 429;
          throw err;
        }
        const backoff = retryAfter ?? Math.min(2_000 * (2 ** (attempt - 1)), 8_000);
        await sleep(backoff);
        continue;
      }

      const err = new Error(apiError || `APIsFreeLLM devolvió HTTP ${status}.`);
      err.status = status;
      err.isRateLimit = status === 429;
      throw err;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
        throw error;
      }
      const isNetworkError = error?.code === 'ECONNRESET'
        || error?.code === 'ETIMEDOUT'
        || error?.code === 'ECONNABORTED'
        || error?.code === 'EAI_AGAIN';
      if (isNetworkError && attempt < maxRetries) {
        await sleep(2_000 * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No se pudo obtener respuesta de APIsFreeLLM.');
}
