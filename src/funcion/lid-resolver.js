export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid')
}

export function isPhoneJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'))
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us')
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter')
}

export function isStatusJid(jid) {
  return jid === 'status@broadcast'
}

export function isBroadcastJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@broadcast')
}

export function cleanJid(jid) {
  if (!jid || typeof jid !== 'string') return jid

  jid = jid.trim()

  if (/:\d+@/.test(jid)) {
    const [user, server] = jid.split('@')
    return `${user.split(':')[0]}@${server}`
  }

  return jid
}

function getMapping(conn) {
  return conn?.signalRepository?.lidMapping
    || global?.conn?.signalRepository?.lidMapping
    || null
}

function getCache(conn) {
  return getMapping(conn)?.mappingCache || null
}

function fromCacheLidToPn(lidJid, conn) {
  const cache = getCache(conn)

  if (!cache || !isLidJid(lidJid)) return null

  const lid = cleanJid(lidJid).split('@')[0]
  const value = cache.get(`lid:${lid}`)

  if (!value || typeof value !== 'string') return null

  return value.includes('@')
    ? cleanJid(value)
    : `${value}@s.whatsapp.net`
}

function fromCachePnToLid(phoneJid, conn) {
  const cache = getCache(conn)

  if (!cache || !isPhoneJid(phoneJid)) return null

  const pn = cleanJid(phoneJid).split('@')[0]
  const value = cache.get(`pn:${pn}`)

  if (!value || typeof value !== 'string') return null

  return value.includes('@')
    ? cleanJid(value)
    : `${value}@lid`
}

export function resolveJidToPhone(jid, conn) {
  jid = cleanJid(jid)

  if (!jid || typeof jid !== 'string') return null

  if (isPhoneJid(jid)) {
    return jid.split('@')[0]
  }

  if (isLidJid(jid)) {
    const resolved = fromCacheLidToPn(jid, conn)
    return resolved ? resolved.split('@')[0] : null
  }

  return jid.split('@')[0]?.replace(/[^0-9]/g, '') || null
}

export function resolveToPhoneJid(jid, conn) {
  jid = cleanJid(jid)

  if (!jid) return null

  if (isPhoneJid(jid)) {
    return jid.endsWith('@c.us')
      ? `${jid.split('@')[0]}@s.whatsapp.net`
      : jid
  }

  if (isLidJid(jid)) {
    return fromCacheLidToPn(jid, conn)
  }

  const phone = String(jid).replace(/[^0-9]/g, '')

  return phone
    ? `${phone}@s.whatsapp.net`
    : null
}

export function normalizeSenderJid(jid, conn) {
  jid = cleanJid(jid)

  if (!jid) return jid

  return isLidJid(jid)
    ? (resolveToPhoneJid(jid, conn) || jid)
    : jid
}

export function getLidForJid(jid, conn) {
  jid = cleanJid(jid)

  if (!jid || !isPhoneJid(jid)) return null

  return fromCachePnToLid(jid, conn)
}

export async function resolveToPhoneJidAsync(jid, conn) {
  jid = cleanJid(jid)

  if (!jid) return null

  if (!isLidJid(jid)) {
    return resolveToPhoneJid(jid, conn) || jid
  }

  const mapping = getMapping(conn)

  try {
    const pn = await mapping?.getPNForLID?.(jid)

    if (pn && typeof pn === 'string' && !pn.endsWith('@lid')) {
      return cleanJid(pn.includes('@') ? pn : `${pn}@s.whatsapp.net`)
    }
  } catch {}

  return resolveToPhoneJid(jid, conn) || jid
}

export async function getLidForJidAsync(jid, conn) {
  jid = cleanJid(jid)

  if (!jid || !isPhoneJid(jid)) return null

  const mapping = getMapping(conn)

  try {
    const lid = await mapping?.getLIDForPN?.(jid)

    if (lid && typeof lid === 'string') {
      return cleanJid(lid.includes('@') ? lid : `${lid}@lid`)
    }
  } catch {}

  return getLidForJid(jid, conn)
}

export async function resolveFromParticipants(jid, conn, chat) {
  jid = cleanJid(jid)

  if (!jid || !conn || !chat?.endsWith?.('@g.us')) return null

  let metadata = null

  try {
    metadata = conn.chats?.[chat]?.metadata || await conn.groupMetadata(chat)
  } catch {}

  const participants = metadata?.participants || []

  if (!participants.length) return null

  const raw = jid.split('@')[0]

  for (const p of participants) {
    const id = cleanJid(p.id || p.jid || '')
    const lid = cleanJid(p.lid || '')
    const phoneNumber = p.phoneNumber
      ? cleanJid(p.phoneNumber.includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`)
      : ''

    if (id === jid && isPhoneJid(id)) return id
    if (phoneNumber === jid && isPhoneJid(phoneNumber)) return phoneNumber

    if (lid === jid && phoneNumber) return phoneNumber
    if (lid === jid && id && isPhoneJid(id)) return id

    if (id === jid && phoneNumber) return phoneNumber

    if (lid?.split('@')[0] === raw && phoneNumber) return phoneNumber
    if (id?.split('@')[0] === raw && isPhoneJid(id)) return id
    if (phoneNumber?.split('@')[0] === raw) return phoneNumber
  }

  return null
}

export async function resolveAnyJid(jid, conn, chat) {
  jid = cleanJid(jid)

  if (!jid) return null

  if (isPhoneJid(jid)) {
    return jid.endsWith('@c.us')
      ? `${jid.split('@')[0]}@s.whatsapp.net`
      : jid
  }

  const fromMapping = await resolveToPhoneJidAsync(jid, conn)

  if (fromMapping && isPhoneJid(fromMapping)) {
    return fromMapping
  }

  const fromParticipants = await resolveFromParticipants(jid, conn, chat)

  if (fromParticipants && isPhoneJid(fromParticipants)) {
    return fromParticipants
  }

  return jid
}

export function resolveUserId(jid, conn, fallback = null) {
  return resolveJidToPhone(jid, conn) ?? fallback ?? null
}

export function normalizeParticipantEntry(p, conn) {
  if (!p) return ''

  const jid = typeof p === 'string'
    ? p
    : (
      p.phoneNumber
        ? (p.phoneNumber.includes('@') ? p.phoneNumber : `${p.phoneNumber}@s.whatsapp.net`)
        : (p.id || p.jid || p.lid || '')
    )

  return normalizeSenderJid(jid, conn) || jid || ''
    }
