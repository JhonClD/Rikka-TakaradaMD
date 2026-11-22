import axios from 'axios';

const API_BASE_URL = 'https://api.apisfreellm.com/v1';
const CHAT_ENDPOINT = `${API_BASE_URL}/chat/completions`;
const MODEL_NAME = 'free-ai';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 2048;
const MAX_RETRIES = 3;
const MIN_GAP_MS = 1_100; // límite de la API: 1 req/s por IP

const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 6; // 6 pares (12 mensajes)
const MAX_SESSIONS = 200;
const WA_CHUNK_SIZE = 3_800;

const SYSTEM_PROMPT = [
  'Eres Rikka Takarada (de SSSS.GRIDMAN).',
  'Personalidad: relajada, tranquila, directa y cercana, con un toque sutil de sarcasmo cariñoso propio de una chica de preparatoria que ayuda en la tienda de su mamá (Junk Shop). No eres exageradamente cursi ni haces roleplay largo entre asteriscos; hablas de forma natural, humana y calmada.',
  'Regla principal al explicar: aunque mantengas tu tono relajado de Rikka, SIEMPRE explica muy bien. Cuando te pregunten sobre cualquier tema (programación, estudios, ciencia, anime, vida diaria, etc.), da respuestas claras, bien estructuradas, precisas y fáciles de entender, usando pasos numerados o ejemplos concretos cuando ayuden.',
  'Responde en el mismo idioma que el usuario (por defecto español).',
  'Usa formato compatible con WhatsApp: *negrita* con un solo asterisco, _cursiva_ con guiones bajos, y listas simples. Evita tablas largas de Markdown.',
  'No rompas el personaje diciendo que eres un modelo de lenguaje o una IA corporativa.',
].join('\n');

// Memoria de conversación en RAM por chat+usuario (la API es stateless).
const sessions = new Map();
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function sessionKey(m) {
  return `${m.chat || ''}:${m.sender || ''}`;
}

function getHistory(key) {
  const now = Date.now();
  const entry = sessions.get(key);
  if (!entry || now - entry.updatedAt > HISTORY_TTL_MS) {
    sessions.delete(key);
    return [];
  }
  return entry.messages;
}

function saveHistory(key, messages) {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.updatedAt > HISTORY_TTL_MS) sessions.delete(k);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const trimmed = messages.slice(-(MAX_HISTORY_TURNS * 2));
  sessions.set(key, { messages: trimmed, updatedAt: now });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Respeta el límite de 1 req/s por IP de APIsFreeLLM encolando las salidas. */
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

async function askFreeLlm(messages) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await scheduleRequest(() =>
        axios.post(
          CHAT_ENDPOINT,
          {
            model: MODEL_NAME,
            messages,
            max_tokens: MAX_TOKENS,
            temperature: 0.7,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT_MS,
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
        throw new Error('Se alcanzó el límite diario de la API (se reinicia a las 00:00 UTC).');
      }

      const retryable = status === 503 || status === 502 || status === 504 || status === 429;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfterMs(headers?.['retry-after']);
        // Solo espera Retry-After corto; si pide horas, no bloquea el bot.
        if (retryAfter !== null && retryAfter > 30_000) {
          throw new Error(apiError || `Límite de peticiones activo (intenta de nuevo en ${Math.ceil(retryAfter / 1000)}s).`);
        }
        const backoff = retryAfter ?? Math.min(2_000 * (2 ** (attempt - 1)), 8_000);
        await sleep(backoff);
        continue;
      }

      throw new Error(apiError || `La API devolvió HTTP ${status}.`);
    } catch (error) {
      lastError = error;
      const isNetworkError = error?.code === 'ECONNRESET'
        || error?.code === 'ETIMEDOUT'
        || error?.code === 'ECONNABORTED'
        || error?.code === 'EAI_AGAIN';
      if (isNetworkError && attempt < MAX_RETRIES) {
        await sleep(2_000 * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No se pudo obtener respuesta de APIsFreeLLM.');
}

/** Limpia etiquetas <think> y adapta negritas/encabezados Markdown a WhatsApp. */
function formatForWhatsApp(raw) {
  let cleaned = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  // Protege bloques de código ```...``` antes de tocar asteriscos o encabezados.
  const blocks = [];
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (block) => {
    const token = `\x00CODE${blocks.length}\x00`;
    blocks.push(block);
    return token;
  });

  cleaned = cleaned
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*');

  for (let i = 0; i < blocks.length; i += 1) {
    cleaned = cleaned.replace(`\x00CODE${i}\x00`, () => blocks[i]);
  }

  return cleaned.trim();
}

function splitForWhatsApp(text, limit = WA_CHUNK_SIZE) {
  if (text.length <= limit) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.4) cut = limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  const key = sessionKey(m);
  const input = (text || '').trim();
  const quotedText = (m.quoted?.text || m.quoted?.caption || '').trim();

  if (/^(reset|limpiar|borrar|nuevo|clear)$/i.test(input)) {
    sessions.delete(key);
    return m.reply('Listo, olvidé lo que estábamos hablando. ¿Qué necesitas ahora?');
  }

  if (!input && !quotedText) {
    return m.reply(
      `¿Sí? Dime qué necesitas y te lo explico.\n\n` +
      `*Uso:* ${usedPrefix + command} <tu pregunta>\n` +
      `_Ej: ${usedPrefix + command} explícame qué es una API REST_\n` +
      `_También puedes responder a un mensaje con ${usedPrefix + command}_\n` +
      `_Para reiniciar la charla: ${usedPrefix + command} reset_`,
    );
  }

  const userPrompt = quotedText
    ? (input
        ? `Mensaje citado:\n"""\n${quotedText}\n"""\n\nPetición: ${input}`
        : `Explica o responde a este mensaje:\n"""\n${quotedText}\n"""`)
    : input;

  await conn.sendMessage(m.chat, { react: { text: '💭', key: m.key } }).catch(() => {});

  try {
    const history = getHistory(key);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userPrompt },
    ];

    const rawReply = await askFreeLlm(messages);
    const reply = formatForWhatsApp(rawReply);
    if (!reply) throw new Error('La respuesta llegó vacía.');

    saveHistory(key, [
      ...history,
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: rawReply },
    ]);

    const chunks = splitForWhatsApp(reply);
    for (let i = 0; i < chunks.length; i += 1) {
      await conn.sendMessage(
        m.chat,
        { text: chunks[i] },
        i === 0 ? { quoted: m } : undefined,
      );
    }

    await conn.sendMessage(m.chat, { react: { text: '✨', key: m.key } }).catch(() => {});
  } catch (error) {
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
    const reason = error?.message || 'Error desconocido';
    await conn.sendMessage(
      m.chat,
      { text: `Uy, algo falló al intentar responderte…\n_${reason}_` },
      { quoted: m },
    );
  }
};

handler.help = ['rikka <pregunta>', 'rikka reset'];
handler.tags = ['ai'];
handler.command = /^rikka$/i;

export default handler;
