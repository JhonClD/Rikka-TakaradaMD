const _lidToPhoneCache = new Map();
const _jidToLidCache = new Map();

export function registerLidPhone(lid, phoneJid) {
  if (!lid || !phoneJid) return;
  const lidNorm = lid.includes('@') ? lid : `${lid}@lid`;
  const phoneNorm = phoneJid.includes('@') ? phoneJid : `${phoneJid}@s.whatsapp.net`;
  _lidToPhoneCache.set(lidNorm, phoneNorm);
  _jidToLidCache.set(phoneNorm, lidNorm);
}

export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isPhoneJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
}

export function isStatusJid(jid) {
  return jid === 'status@broadcast';
}

export function isBroadcastJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@broadcast');
}

// ─── Baileys nativo: LIDMappingStore (LRU síncrono + DB persistente) ───────
// mappingCache guarda: 'lid:{lidUser}' → pnUser  y  'pn:{pnUser}' → lidUser
function resolveFromBaileysMappingCache(lid) {
  const mappingCache = global?.conn?.signalRepository?.lidMapping?.mappingCache;
  if (!mappingCache) return null;
  const lidUser = lid.split('@')[0];
  const pnUser = mappingCache.get(`lid:${lidUser}`);
  if (pnUser && typeof pnUser === 'string') {
    const jid = `${pnUser}@s.whatsapp.net`;
    _lidToPhoneCache.set(lid, jid);
    _jidToLidCache.set(jid, lid);
    return jid;
  }
  return null;
}

function getLidFromBaileysMappingCache(phoneJid) {
  const mappingCache = global?.conn?.signalRepository?.lidMapping?.mappingCache;
  if (!mappingCache) return null;
  const pnUser = phoneJid.split('@')[0];
  const lidUser = mappingCache.get(`pn:${pnUser}`);
  if (lidUser && typeof lidUser === 'string') return `${lidUser}@lid`;
  return null;
}
// ────────────────────────────────────────────────────────────────────────────

function resolveFromGlobalConn(lid) {
  const resolver = global?.conn?.resolveLid;
  if (!resolver) return null;
  const lidKey = lid.split('@')[0];
  if (resolver.cache instanceof Map) {
    const entry = resolver.cache.get(lidKey);
    if (entry?.jid && !entry.jid.endsWith('@lid')) return entry.jid;
  }
  if (resolver.jidToLidMap instanceof Map) {
    for (const [resolvedJid, lidFull] of resolver.jidToLidMap.entries()) {
      if (lidFull === lid || lidFull?.split('@')[0] === lidKey) return resolvedJid;
    }
  }
  return null;
}

function resolveFromGroupCache(lid) {
  const cache = global.groupCache;
  if (!cache) return null;
  for (const entry of cache.values()) {
    const participants = entry?.data?.participants || entry?.participants;
    if (!Array.isArray(participants)) continue;
    const match = participants.find(p => p.lid === lid || p.lidJid === lid || p.lid?.split('@')[0] === lid.split('@')[0]);
    if (match) {
      const phone = match.phoneNumber
        ? (match.phoneNumber.includes('@') ? match.phoneNumber : match.phoneNumber + '@s.whatsapp.net')
        : (match.id || '');
      if (phone && !phone.endsWith('@lid')) {
        _lidToPhoneCache.set(lid, phone);
        return phone;
      }
    }
  }
  return null;
}

function resolveFromContacts(lid, conn) {
  const sources = [conn?.contacts, conn?.store?.contacts, global?.conn?.contacts];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [contactJid, contact] of Object.entries(source)) {
      if (!contactJid.endsWith('@s.whatsapp.net')) continue;
      if (contact?.lid === lid || contact?.lidJid === lid) {
        _lidToPhoneCache.set(lid, contactJid);
        return contactJid;
      }
    }
  }
  return null;
}

export function resolveJidToPhone(jid, conn) {
  if (!jid) return null;

  if (typeof jid === 'object') {
    jid = jid.phoneNumber || jid.id || jid.jid || '';
  } else if (typeof jid === 'string') {
    try {
      const parsed = JSON.parse(jid);
      if (parsed && typeof parsed === 'object') {
        jid = parsed.phoneNumber || parsed.id || jid;
      }
    } catch {}
  }

  if (!jid) return null;
  if (isPhoneJid(jid)) return jid.split('@')[0];

  if (isLidJid(jid)) {
    // 0. LIDMappingStore nativo de Baileys — más confiable (LRU + DB persistente)
    const fromBaileys = resolveFromBaileysMappingCache(jid);
    if (fromBaileys) return fromBaileys.split('@')[0];
    // 1. Caché local en memoria
    if (_lidToPhoneCache.has(jid)) return _lidToPhoneCache.get(jid).split('@')[0];
    // 2. LidResolver del bot (lidsresolve.json)
    const fromGlobal = resolveFromGlobalConn(jid);
    if (fromGlobal) return fromGlobal.split('@')[0];
    // 3. groupCache
    const fromGroup = resolveFromGroupCache(jid);
    if (fromGroup) return fromGroup.split('@')[0];
    // 4. conn.contacts (siempre vacío en Baileys moderno, último recurso)
    const fromContacts = resolveFromContacts(jid, conn);
    if (fromContacts) return fromContacts.split('@')[0];
    return null;
  }

  return jid.split('@')[0];
}

export function resolveToPhoneJid(jid, conn) {
  const phone = resolveJidToPhone(jid, conn);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

export function resolveUserId(jid, conn, fallback = null) {
  return resolveJidToPhone(jid, conn) ?? fallback ?? null;
}

export function normalizeSenderJid(jid, conn) {
  if (!jid) return jid;
  if (isLidJid(jid)) {
    const resolved = resolveToPhoneJid(jid, conn);
    return resolved || jid;
  }
  return jid;
}

// Obtener LID dado un JID de teléfono — primero LIDMappingStore nativo
export function getLidForJid(jid) {
  if (!jid || !isPhoneJid(jid)) return null;
  const fromBaileys = getLidFromBaileysMappingCache(jid);
  if (fromBaileys) return fromBaileys;
  return _jidToLidCache.get(jid) || null;
}

export function normalizeParticipantEntry(p, conn) {
  if (!p) return '';
  let jid = p;
  if (typeof p === 'string') {
    try {
      const parsed = JSON.parse(p);
      if (parsed && typeof parsed === 'object') {
        jid = parsed.phoneNumber || parsed.id || parsed.jid || p;
      }
    } catch {}
  } else if (typeof p === 'object') {
    const phone = p.phoneNumber ? (p.phoneNumber.includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`) : '';
    jid = phone || p.id || p.jid || '';
  }
  if (!jid) return '';
  if (typeof jid === 'string' && jid.endsWith('@lid')) {
    return normalizeSenderJid(jid, conn);
  }
  return jid;
      }
  
