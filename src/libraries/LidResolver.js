import fs from 'fs';
import path from 'path';
import PhoneValidator from './PhoneValidator.js';

class LidResolver {
  constructor(conn) {
    this.conn = conn;
    this.processingQueue = new Map();
    this.cacheFile = path.join(process.cwd(), 'src', 'lidsresolve.json');
    this.cache = new Map();
    this.jidToLidMap = new Map();
    this.isDirty = false;
    this.saveTimeout = null;
    this.maxCacheSize = 1000;
    this.phoneValidator = new PhoneValidator();
    this.ensureDirectoryExists();
    this.loadCache();
    this.setupAutoSave();
    this.cleanupPhoneNumbers();
  }

  ensureDirectoryExists() {
    const srcDir = path.dirname(this.cacheFile);
    if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf8');
        const parsed = JSON.parse(data);
        for (const [key, entry] of Object.entries(parsed)) {
          if (entry && typeof entry === 'object' && entry.jid && entry.lid && entry.timestamp) {
            this.cache.set(key, entry);
            if (entry.jid && entry.jid.includes('@s.whatsapp.net')) {
              this.jidToLidMap.set(entry.jid, entry.lid);
            }
          }
        }
      } else {
        this.saveCache();
      }
    } catch (error) {
      console.error('❌ Error cargando caché LID:', error.message);
      this.cache = new Map();
      this.jidToLidMap = new Map();
      this.saveCache();
    }
  }

  cleanupPhoneNumbers() {
    const toCleanup = [];
    for (const [lidKey, entry] of this.cache.entries()) {
      const phoneDetection = this.phoneValidator.detectPhoneInLid(lidKey);
      if (phoneDetection.isPhone && entry.notFound) {
        const correctJid = phoneDetection.jid;
        const countryInfo = this.phoneValidator.getCountryInfo(phoneDetection.phoneNumber);
        toCleanup.push({
          oldKey: lidKey,
          newEntry: {
            jid: correctJid,
            lid: `${lidKey}@lid`,
            name: phoneDetection.phoneNumber,
            timestamp: Date.now(),
            corrected: true,
            country: countryInfo?.country,
            phoneNumber: phoneDetection.phoneNumber
          },
          correctJid
        });
      }
    }
    for (const cleanup of toCleanup) {
      this.cache.delete(cleanup.oldKey);
      this.cache.set(cleanup.oldKey, cleanup.newEntry);
      this.jidToLidMap.set(cleanup.correctJid, `${cleanup.oldKey}@lid`);
    }
    if (toCleanup.length > 0) this.markDirty();
  }

  saveCache() {
    try {
      const data = {};
      for (const [key, value] of this.cache.entries()) data[key] = value;
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), 'utf8');
      this.isDirty = false;
    } catch (error) {
      console.error('❌ Error guardando caché LID:', error.message);
    }
  }

  setupAutoSave() {
    setInterval(() => { if (this.isDirty) this.saveCache(); }, 30000);
    process.on('SIGINT',  () => { if (this.isDirty) this.saveCache(); });
    process.on('SIGTERM', () => { if (this.isDirty) this.saveCache(); });
  }

  markDirty() {
    this.isDirty = true;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveCache();
  }

  isDuplicate(lidKey, jid) {
    return this.cache.has(lidKey) || this.jidToLidMap.has(jid);
  }

  async getUserName(jid) {
    try {
      const contactDetails = await this.conn?.onWhatsApp(jid);
      if (contactDetails?.[0]?.name) return contactDetails[0].name;
      return jid.replace('@s.whatsapp.net', '');
    } catch {
      return jid.replace('@s.whatsapp.net', '');
    }
  }

  async resolveLid(lidJid, groupChatId, maxRetries = 3) {
    if (!lidJid.endsWith('@lid')) {
      return lidJid.includes('@') ? lidJid : `${lidJid}@s.whatsapp.net`;
    }
    if (!groupChatId?.endsWith('@g.us')) return lidJid;

    const lidKey = lidJid.split('@')[0];

    const phoneDetection = this.phoneValidator.detectPhoneInLid(lidKey);
    if (phoneDetection.isPhone) {
      const countryInfo = this.phoneValidator.getCountryInfo(phoneDetection.phoneNumber);
      this.cache.set(lidKey, {
        jid: phoneDetection.jid, lid: lidJid, name: phoneDetection.phoneNumber,
        timestamp: Date.now(), phoneDetected: true,
        country: countryInfo?.country, phoneNumber: phoneDetection.phoneNumber
      });
      this.jidToLidMap.set(phoneDetection.jid, lidJid);
      this.markDirty();
      return phoneDetection.jid;
    }

    if (this.cache.has(lidKey)) return this.cache.get(lidKey).jid;
    if (this.processingQueue.has(lidKey)) return await this.processingQueue.get(lidKey);

    const resolvePromise = (async () => {
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          const metadata = await this.conn?.groupMetadata(groupChatId);
          if (!metadata?.participants) throw new Error('No se obtuvieron participantes');

          for (const participant of metadata.participants) {
            try {
              const pJid = participant?.id || participant?.jid;
              if (!pJid) continue;

              const directLid = participant?.lid?.split?.('@')[0];
              if (directLid && directLid === lidKey) {
                if (this.isDuplicate(lidKey, pJid)) {
                  this.processingQueue.delete(lidKey);
                  return this.cache.get(lidKey)?.jid || pJid;
                }
                this.cache.set(lidKey, { jid: pJid, lid: lidJid, name: pJid.split('@')[0], timestamp: Date.now() });
                this.jidToLidMap.set(pJid, lidJid);
                this.markDirty();
                this.processingQueue.delete(lidKey);
                return pJid;
              }

              const contactDetails = await this.conn?.onWhatsApp(pJid).catch(() => null);
              if (!contactDetails?.[0]?.lid) continue;
              const participantLid = contactDetails[0].lid.split('@')[0];
              if (participantLid === lidKey) {
                if (this.isDuplicate(lidKey, pJid)) {
                  this.processingQueue.delete(lidKey);
                  return this.cache.get(lidKey)?.jid || pJid;
                }
                const userName = await this.getUserName(pJid);
                this.cache.set(lidKey, { jid: pJid, lid: lidJid, name: userName, timestamp: Date.now() });
                this.jidToLidMap.set(pJid, lidJid);
                this.markDirty();
                this.processingQueue.delete(lidKey);
                return pJid;
              }
            } catch { continue; }
          }

          this.cache.set(lidKey, { jid: lidJid, lid: lidJid, name: 'Usuario no encontrado', timestamp: Date.now(), notFound: true });
          this.markDirty();
          this.processingQueue.delete(lidKey);
          return lidJid;

        } catch (e) {
          if (++attempts >= maxRetries) {
            this.cache.set(lidKey, { jid: lidJid, lid: lidJid, name: 'Error al resolver', timestamp: Date.now(), error: true });
            this.markDirty();
            this.processingQueue.delete(lidKey);
            console.error(`❌ Error resolviendo LID ${lidKey}:`, e.message);
            return lidJid;
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
      return lidJid;
    })();

    this.processingQueue.set(lidKey, resolvePromise);
    return await resolvePromise;
  }

  findLidByJid(jid) { return this.jidToLidMap.get(jid) || null; }
  getUserInfo(lidKey) { return this.cache.get(lidKey) || null; }
  getUserInfoByJid(jid) {
    const lid = this.findLidByJid(jid);
    if (lid) return this.cache.get(lid.split('@')[0]) || null;
    return null;
  }

  analyzePhoneNumbers() {
    const phoneNumbers = [], realLids = [], problematic = [];
    for (const [lidKey, entry] of this.cache.entries()) {
      const phoneDetection = this.phoneValidator.detectPhoneInLid(lidKey);
      if (phoneDetection.isPhone) {
        const countryInfo = this.phoneValidator.getCountryInfo(phoneDetection.phoneNumber);
        phoneNumbers.push({ lidKey, phoneNumber: phoneDetection.phoneNumber, correctJid: phoneDetection.jid, currentJid: entry.jid, country: countryInfo?.country, isProblematic: entry.notFound || entry.error || entry.jid.includes('@lid'), entry });
      } else {
        realLids.push({ lidKey, entry });
      }
      if (entry.jid && entry.jid.includes('@lid')) problematic.push({ lidKey, issue: 'JID contiene @lid', entry });
    }
    return { phoneNumbers, realLids, problematic, stats: { totalEntries: this.cache.size, phoneNumbersDetected: phoneNumbers.length, realLids: realLids.length, problematicEntries: problematic.length, phoneNumbersProblematic: phoneNumbers.filter(p => p.isProblematic).length } };
  }

  autoCorrectPhoneNumbers() {
    const analysis = this.analyzePhoneNumbers();
    let correctionCount = 0;
    for (const phoneEntry of analysis.phoneNumbers) {
      if (phoneEntry.isProblematic) {
        this.cache.set(phoneEntry.lidKey, { jid: phoneEntry.correctJid, lid: `${phoneEntry.lidKey}@lid`, name: phoneEntry.phoneNumber, timestamp: Date.now(), corrected: true, country: phoneEntry.country, phoneNumber: phoneEntry.phoneNumber, originalEntry: phoneEntry.entry });
        if (phoneEntry.entry.jid && this.jidToLidMap.has(phoneEntry.entry.jid)) this.jidToLidMap.delete(phoneEntry.entry.jid);
        this.jidToLidMap.set(phoneEntry.correctJid, `${phoneEntry.lidKey}@lid`);
        correctionCount++;
      }
    }
    if (correctionCount > 0) this.markDirty();
    return { corrected: correctionCount, analysis };
  }

  async processObject(obj, groupChatId) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      const results = [];
      for (const item of obj) results.push(await this.processObject(item, groupChatId));
      return results;
    }
    const processed = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.endsWith('@lid') && groupChatId) {
        processed[key] = await this.resolveLid(value, groupChatId);
      } else if (typeof value === 'object' && value !== null) {
        processed[key] = await this.processObject(value, groupChatId);
      } else {
        processed[key] = value;
      }
    }
    return processed;
  }

  async processMessage(message) {
    try {
      if (!message || !message.key) return message;
      const groupChatId = message.key.remoteJid?.endsWith('@g.us') ? message.key.remoteJid : null;
      if (!groupChatId) {
        const processedMessage = JSON.parse(JSON.stringify(message));
        let changed = false;
        if (processedMessage.key?.remoteJid?.endsWith('@lid')) {
          const lidKey = processedMessage.key.remoteJid.split('@')[0];
          const cached = this.cache.get(lidKey);
          if (cached?.jid && !cached.jid.endsWith('@lid')) {
            processedMessage.key.remoteJid = cached.jid;
            changed = true;
          } else {
            try {
              const contact = await this.conn?.onWhatsApp(processedMessage.key.remoteJid);
              if (contact?.[0]?.jid && !contact[0].jid.endsWith('@lid')) {
                this.cache.set(lidKey, { jid: contact[0].jid, lid: processedMessage.key.remoteJid, timestamp: Date.now() });
                this.jidToLidMap.set(contact[0].jid, processedMessage.key.remoteJid);
                this.markDirty();
                processedMessage.key.remoteJid = contact[0].jid;
                changed = true;
              }
            } catch (_) {}
          }
        }
        const rawLid = processedMessage.key?.participant || processedMessage.participant;
        if (rawLid?.endsWith('@lid')) {
          const lidKey = rawLid.split('@')[0];
          const cached = this.cache.get(lidKey);
          if (cached?.jid && !cached.jid.endsWith('@lid')) {
            if (processedMessage.key?.participant) processedMessage.key.participant = cached.jid;
            if (processedMessage.participant) processedMessage.participant = cached.jid;
            changed = true;
          } else {
            try {
              const contact = await this.conn?.onWhatsApp(rawLid);
              if (contact?.[0]?.jid && !contact[0].jid.endsWith('@lid')) {
                this.cache.set(lidKey, { jid: contact[0].jid, lid: rawLid, timestamp: Date.now() });
                this.jidToLidMap.set(contact[0].jid, rawLid);
                this.markDirty();
                if (processedMessage.key?.participant) processedMessage.key.participant = contact[0].jid;
                if (processedMessage.participant) processedMessage.participant = contact[0].jid;
                changed = true;
              }
            } catch (_) {}
          }
        }
        return changed ? processedMessage : message;
      }

      const processedMessage = JSON.parse(JSON.stringify(message));
      if (processedMessage.key?.participant?.endsWith('@lid')) {
        processedMessage.key.participant = await this.resolveLid(processedMessage.key.participant, groupChatId);
      }
      if (processedMessage.participant?.endsWith('@lid')) {
        processedMessage.participant = await this.resolveLid(processedMessage.participant, groupChatId);
      }
      if (processedMessage.message) {
        for (const msgType of Object.keys(processedMessage.message)) {
          const msgContent = processedMessage.message[msgType];
          if (msgContent?.contextInfo?.mentionedJid) {
            const resolvedMentions = [];
            for (const jid of msgContent.contextInfo.mentionedJid) {
              resolvedMentions.push(typeof jid === 'string' && jid.endsWith('@lid') ? await this.resolveLid(jid, groupChatId) : jid);
            }
            msgContent.contextInfo.mentionedJid = resolvedMentions;
          }
          if (msgContent?.contextInfo?.quotedMessage && msgContent.contextInfo.participant?.endsWith('@lid')) {
            msgContent.contextInfo.participant = await this.resolveLid(msgContent.contextInfo.participant, groupChatId);
          }
        }
      }
      return processedMessage;
    } catch (error) {
      console.error('Error procesando mensaje para resolver LIDs:', error);
      return message;
    }
  }

  get lidCache() {
    return {
      size: this.cache.size,
      has: (key) => {
        const lidKey = key.includes('_') ? key.split('_')[0].replace('@lid', '') : key.replace('@lid', '');
        return this.cache.has(lidKey);
      },
      get: (key) => {
        const lidKey = key.includes('_') ? key.split('_')[0].replace('@lid', '') : key.replace('@lid', '');
        const entry = this.cache.get(lidKey);
        return entry ? entry.jid : undefined;
      },
      set: (key, value) => {
        const lidKey = key.includes('_') ? key.split('_')[0].replace('@lid', '') : key.replace('@lid', '');
        if (typeof value === 'string') {
          if (this.findLidByJid(value) || this.cache.has(lidKey)) return;
          this.cache.set(lidKey, { jid: value, lid: `${lidKey}@lid`, name: 'Nombre pendiente', timestamp: Date.now() });
          this.jidToLidMap.set(value, `${lidKey}@lid`);
        } else {
          if (value.jid) {
            const existingLid = this.findLidByJid(value.jid);
            if (existingLid && existingLid !== value.lid) return;
          }
          if (this.cache.has(lidKey) && this.cache.get(lidKey).jid !== value.jid) return;
          this.cache.set(lidKey, value);
          if (value.jid) this.jidToLidMap.set(value.jid, value.lid);
        }
        this.markDirty();
      },
      delete: (key) => {
        const lidKey = key.includes('_') ? key.split('_')[0].replace('@lid', '') : key.replace('@lid', '');
        const entry = this.cache.get(lidKey);
        if (entry?.jid && this.jidToLidMap.has(entry.jid)) this.jidToLidMap.delete(entry.jid);
        const result = this.cache.delete(lidKey);
        if (result) this.markDirty();
        return result;
      },
      clear: () => { this.cache.clear(); this.jidToLidMap.clear(); this.markDirty(); },
      entries: () => [...this.cache.entries()].map(([key, entry]) => [`${key}@lid`, entry.jid]),
      forEach: (callback) => { for (const [key, entry] of this.cache.entries()) callback(entry.jid, `${key}@lid`, this); }
    };
  }

  getStats() {
    let notFound = 0, errors = 0, valid = 0, phoneNumbers = 0, corrected = 0;
    for (const [, entry] of this.cache.entries()) {
      if (entry.phoneDetected || entry.corrected) phoneNumbers++;
      if (entry.corrected) corrected++;
      if (entry.notFound) notFound++;
      else if (entry.error) errors++;
      else valid++;
    }
    return { total: this.cache.size, valid, notFound, errors, phoneNumbers, corrected, processing: this.processingQueue.size, cacheFile: this.cacheFile, fileExists: fs.existsSync(this.cacheFile), isDirty: this.isDirty, jidMappings: this.jidToLidMap.size };
  }

  getAllUsers() {
    const users = [];
    for (const [, entry] of this.cache.entries()) {
      if (!entry.notFound && !entry.error) {
        users.push({ lid: entry.lid, jid: entry.jid, name: entry.name, country: entry.country, phoneNumber: entry.phoneNumber, isPhoneDetected: entry.phoneDetected || entry.corrected, timestamp: new Date(entry.timestamp).toLocaleString() });
      }
    }
    return users.sort((a, b) => a.name.localeCompare(b.name));
  }

  getUsersByCountry() {
    const countries = {};
    for (const [, entry] of this.cache.entries()) {
      if (!entry.notFound && !entry.error && entry.country) {
        if (!countries[entry.country]) countries[entry.country] = [];
        countries[entry.country].push({ lid: entry.lid, jid: entry.jid, name: entry.name, phoneNumber: entry.phoneNumber });
      }
    }
    for (const country of Object.keys(countries)) countries[country].sort((a, b) => a.name.localeCompare(b.name));
    return countries;
  }

  forceSave() {
    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }
    this.saveCache();
  }

  bulkCacheFromParticipants(participants) {
    if (!Array.isArray(participants)) return 0;
    let cached = 0;
    for (const p of participants) {
      const pJid = p?.id || p?.jid;
      const pLid = p?.lid;
      if (!pJid || !pLid || !pLid.includes('@lid')) continue;
      const lidKey = pLid.split('@')[0];
      if (!lidKey || this.cache.has(lidKey)) continue;
      this.cache.set(lidKey, { jid: pJid, lid: pLid, name: pJid.split('@')[0], timestamp: Date.now() });
      this.jidToLidMap.set(pJid, pLid);
      cached++;
    }
    if (cached > 0) this.markDirty();
    return cached;
  }
}

export default LidResolver;

const _rljCache     = new Map();
const _rljMetaCache = new Map();
const _META_TTL     = 5000;

export async function resolveLidToRealJid(jid, client, groupChatId) {
  if (!jid) return jid;

  if (!jid.endsWith('@lid'))
    return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

  if (_rljCache.has(jid)) return _rljCache.get(jid);

  const lidKey = jid.split('@')[0];

  if (!groupChatId?.endsWith('@g.us')) return jid;

  let metadata = null;
  const metaCached = _rljMetaCache.get(groupChatId);
  if (metaCached && Date.now() - metaCached.ts < _META_TTL) {
    metadata = metaCached.data;
  } else {
    try {
      metadata = await client.groupMetadata(groupChatId);
      _rljMetaCache.set(groupChatId, { data: metadata, ts: Date.now() });
    } catch {
      return jid;
    }
  }

  for (const p of metadata?.participants || []) {
    const pJid  = p?.id || p?.jid;
    const pLid  = p?.lid?.split?.('@')?.[0];
    const pPhone = p?.phoneNumber?.replace?.(/\D/g, '');
    if (!pJid) continue;
    if (pLid === lidKey || pPhone === lidKey) {
      _rljCache.set(jid, pJid);
      return pJid;
    }
  }

  return jid;
}
