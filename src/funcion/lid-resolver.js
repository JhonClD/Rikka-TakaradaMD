/**
 * lid-resolver.js - KanaArima-MD
 * Resolución LID → número real de teléfono
 * Compatible con @whiskeysockets/baileys (luna-baileys)
 */

const _lidToPhoneCache = new Map();

export function registerLidPhone(lid, phoneJid) {
  if (lid && phoneJid) {
    _lidToPhoneCache.set(lid, phoneJid.split('@')[0]);
  }
}

export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isPhoneJid(jid) {
  return typeof jid === 'string' && (
    jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')
  );
}

/**
 * Intentar resolver desde el groupCache global
 */
function resolveFromGroupCache(lid) {
  const cache = global.groupCache;
  if (!cache) return null;
  for (const entry of cache.values()) {
    const participants = entry?.data?.participants || entry?.participants;
    if (!Array.isArray(participants)) continue;
    const match = participants.find(p => p.lid === lid || p.lidJid === lid);
    if (match?.id) {
      const phone = match.id.split('@')[0];
      _lidToPhoneCache.set(lid, phone);
      return phone;
    }
  }
  return null;
}

/**
 * Intentar resolver desde los contactos de la conexión
 */
function resolveFromContacts(lid, conn) {
  const sources = [conn?.contacts, conn?.store?.contacts, global?.conn?.contacts];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [contactJid, contact] of Object.entries(source)) {
      if (!contactJid.endsWith('@s.whatsapp.net')) continue;
      if (contact?.lid === lid || contact?.lidJid === lid) {
        const phone = contactJid.split('@')[0];
        _lidToPhoneCache.set(lid, phone);
        return phone;
      }
    }
  }
  return null;
}

/**
 * Función principal: resuelve cualquier JID a número de teléfono
 */
export function resolveJidToPhone(jid, conn) {
  if (!jid) return null;

  // Formato JSON string del nuevo Baileys: {"id":"xxx@lid","phoneNumber":"yyy@s.whatsapp.net"}
  if (typeof jid === 'string') {
    try {
      const parsed = JSON.parse(jid);
      if (parsed && typeof parsed === 'object') {
        jid = parsed.phoneNumber || parsed.id || jid;
      }
    } catch { /* no es JSON, continuar */ }
  } else if (jid && typeof jid === 'object') {
    jid = jid.phoneNumber || jid.id || jid.jid || '';
  }

  if (!jid) return null;
  if (isPhoneJid(jid)) return jid.split('@')[0];

  if (isLidJid(jid)) {
    // 1. Cache directo
    if (_lidToPhoneCache.has(jid)) return _lidToPhoneCache.get(jid);
    // 2. GroupCache
    const fromGroup = resolveFromGroupCache(jid);
    if (fromGroup) return fromGroup;
    // 3. Contactos
    const fromContacts = resolveFromContacts(jid, conn);
    if (fromContacts) return fromContacts;
    // No resuelto
    return null;
  }

  return jid.split('@')[0];
}

/**
 * Resuelve a JID completo @s.whatsapp.net
 */
export function resolveToPhoneJid(jid, conn) {
  const phone = resolveJidToPhone(jid, conn);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

/**
 * Resuelve a phone o devuelve fallback
 */
export function resolveUserId(jid, conn, fallback = null) {
  return resolveJidToPhone(jid, conn) ?? fallback ?? null;
}

/**
 * Normaliza un JID de sender: si es LID, intenta resolverlo;
 * si no puede, devuelve el LID tal cual para no perder el mensaje.
 */
export function normalizeSenderJid(jid, conn) {
  if (!jid) return jid;
  if (isLidJid(jid)) {
    const resolved = resolveToPhoneJid(jid, conn);
    return resolved || jid; // fallback al LID original
  }
  return jid;
}
