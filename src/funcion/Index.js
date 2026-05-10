/**
 * src/funcion/index.js
 * ════════════════════════════════════════════════════════════════════════════
 * Resolver Universal — Rikka-TakaradaMD
 *
 * Reemplaza y unifica:
 *   • src/funcion/lid-resolver.js
 *   • src/funcion/messageValidation.js
 *   • src/libraries/jidHelper.js
 *   (los anteriores pueden eliminarse una vez migrados los imports)
 *
 * Exporta todo desde aquí:
 *   jid · lid · sender · participant · número · decode · normalize
 *   type-checkers · admin checks · message helpers
 * ════════════════════════════════════════════════════════════════════════════
 */

import { jidDecode, areJidsSameUser } from '@whiskeysockets/baileys';

// ══════════════════════════════════════════════════════════════════════════════
// §1  CACHÉ INTERNO  LID ↔ PHONE
//     Registro rápido sin necesidad de tocar el LidResolver class.
// ══════════════════════════════════════════════════════════════════════════════

const _lidToPhone = new Map();
const _phoneToLid = new Map();

/**
 * Registra manualmente un par LID ↔ JID de teléfono.
 * Útil para poblarlo desde participantes de grupo o contactos.
 */
export function registerLidPhone(lid, phoneJid) {
  if (!lid || !phoneJid) return;
  const l = lid.endsWith('@lid') ? lid : `${lid}@lid`;
  const p = phoneJid.includes('@') ? phoneJid : `${phoneJid}@s.whatsapp.net`;
  _lidToPhone.set(l, p);
  _phoneToLid.set(p, l);
}

/** Expone el caché de LID→Phone (sólo lectura) */
export const getLidCache = () => _lidToPhone;


// ══════════════════════════════════════════════════════════════════════════════
// §2  TYPE CHECKERS
//     Verifican el tipo de JID por su sufijo.
// ══════════════════════════════════════════════════════════════════════════════

export const isLidJid        = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
export const isPhoneJid      = (jid) => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
export const isGroupJid      = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
export const isNewsletterJid = (jid) => typeof jid === 'string' && jid.endsWith('@newsletter');
export const isStatusJid     = (jid) => jid === 'status@broadcast';
export const isBroadcastJid  = (jid) => typeof jid === 'string' && jid.endsWith('@broadcast');


// ══════════════════════════════════════════════════════════════════════════════
// §3  DECODE / NORMALIZE JID
//     Limpia el JID de dispositivo (ej. 521234:1@s.whatsapp.net → 521234@s.whatsapp.net)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Decodifica un JID con dispositivo embebido usando jidDecode de Baileys.
 * Siempre devuelve string (vacío en caso de error).
 */
export function decodeJidSafe(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    if (/:\d+@/gi.test(jid)) {
      const d = jidDecode(jid);
      if (d?.user && d?.server) return `${d.user}@${d.server}`;
    }
    return jid.trim();
  } catch {
    return jid.trim();
  }
}

/**
 * Normaliza cualquier forma de JID:
 *   • string plano            → decodificado
 *   • objeto {phoneNumber,...} → convierte y decodifica
 *   • JSON stringificado       → parsea y decodifica
 *
 * @param {string|object} raw
 * @returns {string}
 */
export function normalizeJid(raw) {
  if (!raw) return '';
  let jid = raw;

  if (typeof jid === 'object') {
    jid = jid.phoneNumber || jid.id || jid.jid || '';
  } else if (typeof jid === 'string') {
    try {
      const parsed = JSON.parse(jid);
      if (parsed && typeof parsed === 'object')
        jid = parsed.phoneNumber || parsed.id || jid;
    } catch {}
  }

  if (!jid || typeof jid !== 'string') return '';
  return decodeJidSafe(jid);
}


// ══════════════════════════════════════════════════════════════════════════════
// §4  NÚMERO ↔ JID
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Extrae sólo los dígitos de un JID.
 * "521234567890@s.whatsapp.net" → "521234567890"
 */
export function phoneFromJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].replace(/\D/g, '');
}

/**
 * Convierte dígitos a JID de teléfono.
 * "521234567890" → "521234567890@s.whatsapp.net"
 */
export function toPhoneJid(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

/**
 * Compara dos JIDs ignorando el sufijo de dispositivo.
 * Usa areJidsSameUser de Baileys con fallback a comparación de dígitos.
 */
export function jidsSameUser(j1, j2) {
  try { return areJidsSameUser(j1, j2); }
  catch {
    if (!j1 || !j2) return false;
    const p1 = phoneFromJid(j1), p2 = phoneFromJid(j2);
    return !!p1 && p1 === p2;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// §5  RESOLUCIÓN DE LID → JID PHONE
//     Busca en todas las fuentes disponibles en cascada.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resuelve un @lid a su JID de teléfono buscando en:
 *   1. Caché interno (_lidToPhone)
 *   2. LidResolver en conn (clase LidResolver)
 *   3. groupCache global
 *   4. contacts del conn / global.conn
 *
 * @param {string} lid   - JID con @lid (o sólo el key sin sufijo)
 * @param {object} conn  - Objeto de conexión Baileys (opcional)
 * @returns {string|null} JID @s.whatsapp.net o null si no se encontró
 */
export function resolveLidToPhone(lid, conn) {
  if (!lid || typeof lid !== 'string') return null;
  const lidFull = lid.endsWith('@lid') ? lid : `${lid}@lid`;
  const lidKey  = lidFull.split('@')[0];

  // 1. Caché interno rápido
  if (_lidToPhone.has(lidFull)) return _lidToPhone.get(lidFull);

  // 2. LidResolver (clase con archivo de caché JSON)
  const resolver = conn?.resolveLid ?? global?.conn?.resolveLid;
  if (resolver) {
    if (resolver.cache instanceof Map) {
      const entry = resolver.cache.get(lidKey);
      if (entry?.jid && !entry.jid.endsWith('@lid')) {
        _lidToPhone.set(lidFull, entry.jid);
        return entry.jid;
      }
    }
    if (resolver.lidCache instanceof Map) {
      const cached = resolver.lidCache.get(lidFull);
      if (cached && !cached.endsWith('@lid')) {
        _lidToPhone.set(lidFull, cached);
        return cached;
      }
    }
    if (resolver.jidToLidMap instanceof Map) {
      for (const [resolvedJid, lidVal] of resolver.jidToLidMap) {
        if (lidVal === lidFull || lidVal?.split('@')[0] === lidKey) {
          _lidToPhone.set(lidFull, resolvedJid);
          return resolvedJid;
        }
      }
    }
  }

  // 3. groupCache global (grupos en memoria)
  const gc = global.groupCache;
  if (gc instanceof Map) {
    for (const entry of gc.values()) {
      const parts = entry?.data?.participants ?? entry?.participants;
      if (!Array.isArray(parts)) continue;
      const match = parts.find(p =>
        p.lid === lidFull ||
        p.lid?.split('@')[0] === lidKey ||
        p.lidJid === lidFull
      );
      if (match) {
        const phone = match.phoneNumber
          ? (match.phoneNumber.includes('@') ? match.phoneNumber : `${match.phoneNumber}@s.whatsapp.net`)
          : (match.id || '');
        if (phone && !phone.endsWith('@lid')) {
          _lidToPhone.set(lidFull, phone);
          return phone;
        }
      }
    }
  }

  // 4. Contacts (conn y global.conn)
  const sources = [conn?.contacts, conn?.store?.contacts, global?.conn?.contacts];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [cJid, contact] of Object.entries(src)) {
      if (!cJid.endsWith('@s.whatsapp.net')) continue;
      if (contact?.lid === lidFull || contact?.lidJid === lidFull) {
        _lidToPhone.set(lidFull, cJid);
        return cJid;
      }
    }
  }

  return null;
}

/**
 * Versión síncrona simplificada — sólo consulta el LidResolver (sin groupCache/contacts).
 * Útil en contextos donde no puedes esperar async.
 *
 * @param {string} jid             - JID con @lid
 * @param {object} connOrResolver  - Conexión Baileys o instancia de LidResolver
 * @returns {string} JID resuelto o el original si no se encontró
 */
export function resolveLidSync(jid, connOrResolver) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@lid')) return jid;
  const resolver = connOrResolver?.resolveLid ?? connOrResolver;
  if (!resolver) return jid;

  const lidKey = jid.split('@')[0];

  if (resolver.cache instanceof Map) {
    const entry = resolver.cache.get(lidKey);
    if (entry?.jid && !entry.jid.endsWith('@lid')) return entry.jid;
  }
  if (resolver.lidCache instanceof Map) {
    const c = resolver.lidCache.get(jid);
    if (c && !c.endsWith('@lid')) return c;
  }
  if (resolver.jidToLidMap instanceof Map) {
    for (const [resolvedJid, lidFull] of resolver.jidToLidMap) {
      if (lidFull === jid || lidFull?.split('@')[0] === lidKey) return resolvedJid;
    }
  }

  return jid;
}


// ══════════════════════════════════════════════════════════════════════════════
// §6  RESOLVER SENDER  (punto de entrada principal)
//     Convierte CUALQUIER forma de identificador a un JID limpio.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resuelve cualquier forma de sender/participant a un JID canónico.
 *
 * Acepta:
 *   • string JID (@s.whatsapp.net / @g.us / @lid / con dispositivo)
 *   • string JSON  stringificado con {phoneNumber, id, jid}
 *   • objeto       {phoneNumber, id, jid}
 *
 * Proceso:
 *   1. Desempaqueta objeto o JSON
 *   2. Decodifica el dispositivo (521234:1@s.whatsapp.net → 521234@s.whatsapp.net)
 *   3. Si es @lid → intenta resolver a @s.whatsapp.net
 *
 * @param {string|object} raw
 * @param {object}        conn  - Objeto de conexión (opcional)
 * @returns {string}
 */
export function resolveSender(raw, conn) {
  if (!raw) return '';

  // Desempaquetar
  let jid = raw;
  if (typeof jid === 'object') {
    jid = jid.phoneNumber
      ? (String(jid.phoneNumber).includes('@') ? jid.phoneNumber : `${jid.phoneNumber}@s.whatsapp.net`)
      : (jid.id || jid.jid || '');
  } else if (typeof jid === 'string') {
    try {
      const p = JSON.parse(jid);
      if (p && typeof p === 'object') {
        jid = p.phoneNumber
          ? (String(p.phoneNumber).includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`)
          : (p.id || jid);
      }
    } catch {}
  }

  if (!jid || typeof jid !== 'string') return '';

  // Decodificar dispositivo
  jid = decodeJidSafe(jid);

  // Resolver @lid
  if (jid.endsWith('@lid')) {
    return resolveLidSync(jid, conn)
        || resolveLidToPhone(jid, conn)
        || jid; // fallback al lid original si no se puede resolver
  }

  return jid;
}


// ══════════════════════════════════════════════════════════════════════════════
// §7  NORMALIZACIÓN DE PARTICIPANTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resuelve un entry de participante (string, objeto, JSON) a su JID canónico.
 */
export function resolveParticipantJid(raw, conn) {
  if (!raw) return '';
  return resolveSender(raw, conn);
}

/**
 * Normaliza un array de participantes a JIDs canónicos, filtrando vacíos.
 */
export function normalizeParticipants(rawList, conn) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(p => resolveParticipantJid(p, conn)).filter(Boolean);
}


// ══════════════════════════════════════════════════════════════════════════════
// §8  OWNER / MOD / ADMIN CHECKS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Construye la lista de owners como JIDs @s.whatsapp.net
 * a partir del formato global.owner ([[number, label, bool], ...])
 */
export function buildOwnerList(globalOwner = []) {
  return globalOwner
    .map(entry => {
      const num = Array.isArray(entry) ? entry[0] : entry;
      return toPhoneJid(String(num).replace(/\D/g, ''));
    })
    .filter(Boolean);
}

/**
 * Verifica si un JID está en la lista de owners (compara por número de teléfono).
 */
export function isOwnerJid(senderJid, ownerList = []) {
  if (!senderJid) return false;
  const sp = phoneFromJid(senderJid);
  return ownerList.some(o => {
    const op = phoneFromJid(o);
    return op && sp && op === sp;
  });
}

/**
 * Verifica si el sender es admin en el grupo, considerando @lid.
 *
 * @param {string}   senderJid    - JID del sender (ya resuelto)
 * @param {object[]} participants - Array de participantes del grupo
 * @param {object}   conn         - Conexión Baileys (para resolver @lid)
 */
export function isAdminInGroup(senderJid, participants = [], conn = null) {
  if (!senderJid || !participants.length) return false;
  const sp = phoneFromJid(senderJid);
  const sd = decodeJidSafe(senderJid);

  return participants.some(p => {
    if (!p?.admin || !['admin', 'superadmin'].includes(p.admin)) return false;

    const pId    = decodeJidSafe(p.id || p.jid || '');
    const pLid   = p.lid ? decodeJidSafe(p.lid) : null;
    const pPhone = p.phoneNumber
      ? phoneFromJid(toPhoneJid(p.phoneNumber))
      : phoneFromJid(pId);

    if (pId && (pId === sd || jidsSameUser(pId, sd))) return true;
    if (pPhone && sp && pPhone === sp) return true;
    if (pLid) {
      const rLid = conn ? resolveLidSync(pLid, conn) : pLid;
      if (rLid && (rLid === sd || jidsSameUser(rLid, sd))) return true;
      if (rLid && phoneFromJid(rLid) === sp) return true;
      if (pLid === senderJid || pLid === sd) return true;
    }
    return false;
  });
}

/**
 * Verifica si el bot es admin en el grupo, considerando @lid.
 */
export function isBotAdminInGroup(botJid, participants = [], conn = null) {
  if (!botJid || !participants.length) return false;
  const bp   = phoneFromJid(botJid);
  const bd   = decodeJidSafe(botJid);
  const bLid = conn?.user?.lid ? decodeJidSafe(conn.user.lid) : null;

  return participants.some(p => {
    if (!p?.admin || !['admin', 'superadmin'].includes(p.admin)) return false;

    const pId    = decodeJidSafe(p.id || p.jid || '');
    const pLid   = p.lid ? decodeJidSafe(p.lid) : null;
    const pPhone = p.phoneNumber
      ? phoneFromJid(toPhoneJid(p.phoneNumber))
      : phoneFromJid(pId);

    if (pId && (pId === bd || jidsSameUser(pId, bd))) return true;
    if (pPhone && bp && pPhone === bp) return true;
    if (pLid && bLid && jidsSameUser(pLid, bLid)) return true;
    return false;
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// §9  MESSAGE UTILITIES
//     Unifica lo que antes estaba en messageValidation.js
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Valida si el mensaje debe ser procesado.
 * Descarta: status, broadcast, newsletter, mensajes de Baileys, mensajes viejos.
 */
export function isValidMessage(m) {
  if (!m?.message) return false;
  const rJid = m.key?.remoteJid || '';
  if (!rJid) return false;
  if (rJid === 'status@broadcast') return false;
  if (rJid.endsWith('@broadcast')) return false;
  if (rJid.endsWith('@newsletter')) return false;
  if (m.isBaileys && !m.message?.audioMessage) return false;

  const connTime = global.timestamp?.connect?.getTime() || Date.now();
  const msgTs = (typeof m.messageTimestamp === 'number'
    ? m.messageTimestamp
    : m.messageTimestamp?.low || m.messageTimestamp?.high || 0) * 1000;

  if (msgTs > 0 && msgTs < connTime - 60_000) return false;
  return true;
}

/**
 * Detecta mensajes duplicados usando un Map como caché.
 *
 * @param {string} msgId      - ID del mensaje
 * @param {string} sender     - JID del sender
 * @param {string} text       - Texto del mensaje
 * @param {Map}    cache      - Mapa compartido (módulo-level)
 * @param {number} timeout    - Ventana de dedup en ms (default 3000)
 * @param {number} maxSize    - Máximo de entradas en caché (default 150)
 */
export function isDuplicate(msgId, sender, text, cache, timeout = 3_000, maxSize = 150) {
  if (!msgId) return false;
  const key = `${msgId}_${(sender || '').split('@')[0]}_${(text || '').substring(0, 50)}`;

  if (cache.has(key) && Date.now() - cache.get(key) < timeout) return true;

  if (cache.size >= maxSize) cache.delete(cache.keys().next().value);
  cache.set(key, Date.now());
  return false;
}

/**
 * Extrae el texto visible de cualquier tipo de mensaje.
 */
export function extractMessageText(m) {
  if (!m?.message) return '';
  const msg = m.message;
  return (
    msg.conversation                                                            ||
    msg.extendedTextMessage?.text                                               ||
    msg.imageMessage?.caption                                                   ||
    msg.videoMessage?.caption                                                   ||
    msg.documentMessage?.caption                                                ||
    msg.buttonsResponseMessage?.selectedButtonId                                ||
    msg.templateButtonReplyMessage?.selectedId                                  ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId                   ||
    msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson       ||
    ''
  );
}

/**
 * Obtiene el tipo principal del mensaje (el primer key que no sea metadata).
 */
export function getMessageType(m) {
  if (!m?.message) return null;
  const skip = ['senderKeyDistributionMessage', 'messageContextInfo'];
  const types = Object.keys(m.message);
  return types.find(t => !skip.includes(t)) || types[types.length - 1] || null;
}

export function isMediaMessage(m) {
  return ['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage']
    .includes(getMessageType(m));
}

export function isViewOnceMessage(m) {
  return ['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension']
    .includes(getMessageType(m));
}

export function isEphemeralMessage(m) { return getMessageType(m) === 'ephemeralMessage'; }
export function isEditedMessage(m)    { return ['editedMessage','protocolMessage'].includes(getMessageType(m)); }
    
