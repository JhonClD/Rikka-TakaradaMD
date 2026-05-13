/**
 * lid-resolver.js — Rikka-TakaradaMD
 * Utilidades LID ↔ JID usando exclusivamente el LIDMappingStore
 * nativo de Baileys (signalRepository.lidMapping).
 */

export function isLidJid(jid)         { return typeof jid === 'string' && jid.endsWith('@lid'); }
export function isPhoneJid(jid)       { return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')); }
export function isGroupJid(jid)       { return typeof jid === 'string' && jid.endsWith('@g.us'); }
export function isNewsletterJid(jid)  { return typeof jid === 'string' && jid.endsWith('@newsletter'); }
export function isStatusJid(jid)      { return jid === 'status@broadcast'; }
export function isBroadcastJid(jid)   { return typeof jid === 'string' && jid.endsWith('@broadcast'); }

// ── LRU cache síncrono de Baileys ────────────────────────────────────────────
function _cache() {
  return global?.conn?.signalRepository?.lidMapping?.mappingCache ?? null;
}
function _syncLidToUser(lidJid) {
  const c = _cache(); if (!c) return null;
  const u = c.get(`lid:${lidJid.split('@')[0]}`);
  return (u && typeof u === 'string') ? u : null;
}
function _syncPnToLid(phoneJid) {
  const c = _cache(); if (!c) return null;
  const u = c.get(`pn:${phoneJid.split('@')[0]}`);
  return (u && typeof u === 'string') ? `${u}@lid` : null;
}

// ── API pública ───────────────────────────────────────────────────────────────

/** Devuelve el número limpio (solo dígitos) dado cualquier JID/LID. */
export function resolveJidToPhone(jid) {
  if (!jid || typeof jid !== 'string') return null;
  if (isPhoneJid(jid))  return jid.split('@')[0];
  if (isLidJid(jid))    return _syncLidToUser(jid) ?? null;
  return jid.split('@')[0];
}

/** Devuelve el JID @s.whatsapp.net. Si es LID sin mapping, retorna null. */
export function resolveToPhoneJid(jid) {
  const phone = resolveJidToPhone(jid);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

/** Si es LID lo normaliza a @s.whatsapp.net cuando hay mapping; si no, devuelve el original. */
export function normalizeSenderJid(jid) {
  if (!jid) return jid;
  return isLidJid(jid) ? (resolveToPhoneJid(jid) || jid) : jid;
}

/** Dado un @s.whatsapp.net retorna su LID si está en el mapping cache. */
export function getLidForJid(jid) {
  if (!jid || !isPhoneJid(jid)) return null;
  return _syncPnToLid(jid);
}

/** Async: usa getPNForLID (LRU + DB persistente) para resolver LID → phoneJid. */
export async function resolveToPhoneJidAsync(lidJid, conn) {
  const _conn = conn ?? global?.conn;
  if (!isLidJid(lidJid)) return resolveToPhoneJid(lidJid) ?? lidJid;
  try {
    const pn = await _conn?.signalRepository?.lidMapping?.getPNForLID(lidJid);
    if (pn && !pn.endsWith('@lid')) return pn;
  } catch {}
  return resolveToPhoneJid(lidJid) ?? lidJid;
}

/** Async: getLIDForPN (LRU + DB persistente) para phoneJid → LID. */
export async function getLidForJidAsync(phoneJid, conn) {
  const _conn = conn ?? global?.conn;
  if (!isPhoneJid(phoneJid)) return null;
  try {
    const result = await _conn?.signalRepository?.lidMapping?.getLIDForPN(phoneJid);
    if (result) return result;
  } catch {}
  return getLidForJid(phoneJid);
}

// Alias de compatibilidad
export function resolveUserId(jid, _conn, fallback = null) {
  return resolveJidToPhone(jid) ?? fallback ?? null;
}

export function normalizeParticipantEntry(p) {
  if (!p) return '';
  const jid = typeof p === 'string' ? p
    : (p.phoneNumber ? (p.phoneNumber.includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`)
    : (p.id || p.jid || ''));
  if (!jid) return '';
  return isLidJid(jid) ? (normalizeSenderJid(jid)) : jid;
}
