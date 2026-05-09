import { jidDecode, areJidsSameUser } from '@whiskeysockets/baileys';

export function decodeJidSafe(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    if (/:\d+@/gi.test(jid)) {
      const decoded = jidDecode(jid);
      if (decoded?.user && decoded?.server) return `${decoded.user}@${decoded.server}`;
    }
    return jid.trim();
  } catch {
    return jid.trim();
  }
}

export function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    if (typeof jid === 'object') {
      jid = jid.phoneNumber || jid.id || jid.jid || '';
    }
    try {
      const parsed = JSON.parse(jid);
      if (parsed && typeof parsed === 'object') {
        jid = parsed.phoneNumber || parsed.id || jid;
      }
    } catch {}
    return decodeJidSafe(jid);
  } catch {
    return '';
  }
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isPhoneJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
}

export function isBroadcastJid(jid) {
  return typeof jid === 'string' && jid === 'status@broadcast';
}

export function isStatusJid(jid) {
  return isBroadcastJid(jid);
}

export function phoneFromJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

export function toPhoneJid(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

export function jidsSameUser(j1, j2) {
  try {
    return areJidsSameUser(j1, j2);
  } catch {
    if (!j1 || !j2) return false;
    return phoneFromJid(j1) === phoneFromJid(j2) && phoneFromJid(j1) !== '';
  }
}

export function resolveLidSync(jid, resolverOrConn) {
  if (!jid || typeof jid !== 'string') return jid || '';
  if (!jid.endsWith('@lid')) return jid;

  const resolver = resolverOrConn?.resolveLid ?? resolverOrConn;
  if (!resolver) return jid;

  const lidKey = jid.split('@')[0];

  if (resolver.cache instanceof Map) {
    const entry = resolver.cache.get(lidKey);
    if (entry?.jid && !entry.jid.endsWith('@lid')) return entry.jid;
  }

  if (resolver.lidCache instanceof Map) {
    const cached = resolver.lidCache.get(jid);
    if (cached && !cached.endsWith('@lid')) return cached;
  }

  if (resolver.jidToLidMap instanceof Map) {
    for (const [resolvedJid, lidFull] of resolver.jidToLidMap.entries()) {
      if (lidFull === jid || lidFull?.split('@')[0] === lidKey) {
        return resolvedJid;
      }
    }
  }

  return jid;
}

export function resolveParticipantJid(rawParticipant, conn) {
  if (!rawParticipant) return '';
  let jid = rawParticipant;

  if (typeof jid === 'string') {
    try {
      const parsed = JSON.parse(jid);
      if (parsed && typeof parsed === 'object') {
        jid = parsed.phoneNumber || parsed.id || jid;
      }
    } catch {}
  } else if (jid && typeof jid === 'object') {
    jid = jid.phoneNumber || jid.id || jid.jid || '';
  }

  if (!jid) return '';
  const decoded = decodeJidSafe(jid);
  if (decoded.endsWith('@lid')) return resolveLidSync(decoded, conn);
  return decoded;
}

export function normalizeParticipants(rawList, conn) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(p => {
      if (typeof p === 'string') return resolveParticipantJid(p, conn);
      if (p && typeof p === 'object') {
        const phone = p.phoneNumber ? toPhoneJid(p.phoneNumber) : '';
        const id = resolveParticipantJid(p.id || p.jid || '', conn);
        return phone || id;
      }
      return '';
    })
    .filter(Boolean);
}

export function isOwnerJid(senderJid, ownerList = []) {
  if (!senderJid) return false;
  const senderPhone = phoneFromJid(senderJid);
  return ownerList.some(ownerJid => {
    const ownerPhone = phoneFromJid(ownerJid);
    return ownerPhone && senderPhone && ownerPhone === senderPhone;
  });
}

export function buildOwnerList(globalOwner = []) {
  return globalOwner.map(entry => {
    const num = Array.isArray(entry) ? entry[0] : entry;
    return toPhoneJid(String(num).replace(/[^0-9]/g, ''));
  }).filter(Boolean);
}

export function isAdminInGroup(senderJid, participants = [], conn = null) {
  if (!senderJid || !participants.length) return false;
  const senderPhone = phoneFromJid(senderJid);
  const senderDecoded = decodeJidSafe(senderJid);

  return participants.some(p => {
    if (!p?.admin || (p.admin !== 'admin' && p.admin !== 'superadmin')) return false;

    const pId = decodeJidSafe(p.id || p.jid || '');
    const pLid = p.lid ? decodeJidSafe(p.lid) : null;
    const pPhone = p.phoneNumber ? phoneFromJid(toPhoneJid(p.phoneNumber)) : phoneFromJid(pId);

    if (pId && (pId === senderDecoded || jidsSameUser(pId, senderDecoded))) return true;
    if (pPhone && senderPhone && pPhone === senderPhone) return true;
    if (pLid) {
      const resolvedLid = conn ? resolveLidSync(pLid, conn) : pLid;
      if (resolvedLid && resolvedLid === senderDecoded) return true;
      if (resolvedLid && phoneFromJid(resolvedLid) === senderPhone) return true;
      if (pLid === senderJid || pLid === senderDecoded) return true;
    }
    return false;
  });
}

export function isBotAdminInGroup(botJid, participants = [], conn = null) {
  if (!botJid || !participants.length) return false;
  const botPhone = phoneFromJid(botJid);
  const botDecoded = decodeJidSafe(botJid);
  const botLid = conn?.user?.lid ? decodeJidSafe(conn.user.lid) : null;

  return participants.some(p => {
    if (!p?.admin || (p.admin !== 'admin' && p.admin !== 'superadmin')) return false;

    const pId = decodeJidSafe(p.id || p.jid || '');
    const pLid = p.lid ? decodeJidSafe(p.lid) : null;
    const pPhone = p.phoneNumber ? phoneFromJid(toPhoneJid(p.phoneNumber)) : phoneFromJid(pId);

    if (pId && (pId === botDecoded || jidsSameUser(pId, botDecoded))) return true;
    if (pPhone && botPhone && pPhone === botPhone) return true;
    if (pLid && botLid && jidsSameUser(pLid, botLid)) return true;
    return false;
  });
}
