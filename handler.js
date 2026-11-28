import { smsg } from './src/libraries/simple.js';
import { format } from 'util';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import fs, { unwatchFile, watchFile } from 'fs';
import chalk from 'chalk';
import { isDuplicate, isValidMessage, extractMessageText } from './src/funcion/messageValidation.js';
import { ANTI_ARAB_JSON } from './src/funcion/paths.js';

// La lista anti-números árabes se leía con una ruta relativa a process.cwd()
// y dentro del bucle de participantes, por participante. Como el archivo no
// existe en el repositorio, JSON.parse lanzaba ENOENT, el try/catch lo
// tragaba y el mensaje de bienvenida no se enviaba nunca. Se carga una sola
// vez y tolera su ausencia.
function loadAntiArabPrefixes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ANTI_ARAB_JSON, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const antiArabPrefixes = loadAntiArabPrefixes();

const PLUGINS_DIR = join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');
const DEFAULT_PROFILE_PICTURE = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png?q=60';

const DUPLICATE_TIMEOUT = 3000;
const MAX_CACHE_SIZE = 150;
const USER_INIT_TTL = 60 * 60 * 1000;
const META_TTL = 5 * 60 * 1000;
const ANTISPAM_WINDOW = 5000;

const recentMessages = new Map();
const initializedUsers = new Map();
const prefixRegexCache = new Map();

// handler.js se reimporta al editarlo (ver global.reloadHandler en main.js).
// Un setInterval a nivel de módulo se acumulaba en cada recarga, así que se
// descarta el anterior antes de crear el nuevo.
clearInterval(global.__handlerCleanupTimer);
global.__handlerCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentMessages) {
    if (now - ts > DUPLICATE_TIMEOUT * 3) recentMessages.delete(key);
  }
  for (const [key, ts] of initializedUsers) {
    if (now - ts > USER_INIT_TTL) initializedUsers.delete(key);
  }
}, 30000);
global.__handlerCleanupTimer.unref?.();

const USER_DEFAULTS = {
  afk: -1,
  afkReason: '',
  age: -1,
  antispam: 0,
  antispamlastclaim: 0,
  atm: 0,
  banned: false,
  BannedReason: '',
  Banneduser: false,
  bank: 0,
  coin: 0,
  expired: 0,
  money: 15,
  mute: false,
  note: 0,
  premium: false,
  premiumTime: 0,
  registered: false,
  reglast: 0,
  regTime: -1,
  role: 'Novato',
  rtrofi: 'bronce',
  sewa: false,
  spammer: 0,
  title: '',
  trofi: 0,
  unreglast: 0,
  warn: 0,
  language: 'es',
  wallet: 0,
  wait: 0,
};

const CHAT_DEFAULTS = {
  isBanned: false,
  welcome: false,
  detect: true,
  detect2: false,
  sWelcome: '',
  sBye: '',
  sPromote: '',
  sDemote: '',
  antidelete: false,
  autosticker: false,
  audios: true,
  antiLink: false,
  antiLink2: false,
  antiviewonce: false,
  antiToxic: false,
  antiTraba: false,
  antiArab: false,
  antiArab2: false,
  modoadmin: false,
  simi: false,
  expired: 0,
  language: 'es',
};

const SETTINGS_DEFAULTS = {
  self: false,
  autoread: false,
  autoread2: false,
  restrict: false,
  antiCall: false,
  antiPrivate: false,
  antispam: false,
  audios_bot: true,
  modoia: false,
};

/** Crea el registro si falta (o no es un objeto) y devuelve el objeto vivo de la base. */
function ensureRecord(collection, key) {
  const current = collection[key];
  if (!current || typeof current !== 'object') collection[key] = {};
  return collection[key];
}

const escapeRegex = (str) => String(str).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

function prefixToRegex(str) {
  const key = String(str);
  let re = prefixRegexCache.get(key);
  if (!re) {
    re = new RegExp('^' + escapeRegex(key));
    prefixRegexCache.set(key, re);
  }
  return re;
}

/**
 * Busca el prefijo al inicio del texto. Devuelve `[resultadoRegExp, regex]` del
 * primer prefijo que coincide, o undefined si ninguno lo hace.
 */
function matchPrefix(prefix, text) {
  let candidates;
  if (prefix instanceof RegExp) candidates = [prefix];
  else if (Array.isArray(prefix)) candidates = prefix.map((p) => (p instanceof RegExp ? p : prefixToRegex(p)));
  else if (typeof prefix === 'string') candidates = [prefixToRegex(prefix)];
  else return undefined;

  for (const re of candidates) {
    re.lastIndex = 0;
    const result = re.exec(text);
    if (result) return [result, re];
  }
  return undefined;
}

/** Respuestas de botones/listas interactivas: el id elegido se trata como texto del comando. */
function applyInteractiveResponse(m) {
  const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nativeFlow?.paramsJson) {
    try {
      const params = JSON.parse(nativeFlow.paramsJson);
      if (typeof params?.id === 'string' && params.id) m.text = params.id;
    } catch { /* paramsJson no es JSON: se ignora */ }
  }
  if (!m.text) {
    const listId = m.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (listId) m.text = listId;
  }
}

// Mensajes enviados por otros bots/clientes conocidos: nunca deben ejecutar comandos.
function isForeignClientMessage(id) {
  const value = String(id || '');
  return value.startsWith('EVO')
    || value.startsWith('Lyru-')
    || (value.startsWith('BAE5') && value.length === 16)
    || value.startsWith('B24E')
    || (value.startsWith('8SCO') && value.length === 20)
    || value.startsWith('FizzxyTheGreat-');
}

/** Extrae el timestamp en ms tolerando tanto números como objetos protobuf Long. */
function parseMessageTimestampMs(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw * 1000 : 0;
  if (raw && typeof raw === 'object') {
    const value = typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw.low ?? 0);
    return Number.isFinite(value) ? value * 1000 : 0;
  }
  const value = Number(raw || 0);
  return Number.isFinite(value) ? value * 1000 : 0;
}

export async function handler(chatUpdate) {
  if (!chatUpdate?.messages?.length) return;

  // Baileys marca mensajes en tiempo real como `type === 'notify'` y la cola
  // atrasada/historial como `'append'`. Solo filtramos por timestamp los no-live
  // para que un desfase de reloj en un VPS nunca descarte comandos en vivo.
  const isLive = chatUpdate.type === 'notify';
  if (!isLive) {
    const connectionTime = global.timestamp?.connect?.getTime() || Date.now();
    chatUpdate.messages = chatUpdate.messages.filter(msg => {
      const msgTs = parseMessageTimestampMs(msg?.messageTimestamp);
      return msgTs === 0 || msgTs >= connectionTime - 60000;
    });
    if (!chatUpdate.messages.length) return;
  }

  this.pushMessage(chatUpdate.messages).catch(console.error);
  if (global.db.data == null) await global.loadDatabase();

  for (const rawMsg of chatUpdate.messages) {
    await handleMessage.call(this, rawMsg, chatUpdate, isLive);
  }
}

async function handleMessage(rawMsg, chatUpdate, isLive = false) {
  let m = rawMsg;
  if (!m) return;

  if (!isValidMessage(m, { isLive })) return;
  const msgText = extractMessageText(m);
  const botJid = this?.user?.jid || (this?.user?.id ? this.decodeJid?.(this.user.id) : '') || '';
  const rawSender = m.key?.fromMe
    ? botJid
    : (m.key?.participantAlt || m.key?.participantPN || m.key?.participant || m.key?.remoteJidAlt || m.key?.remoteJidPN || m.key?.remoteJid || '');
  if (isDuplicate(m.key?.id, rawSender, msgText, recentMessages, DUPLICATE_TIMEOUT, MAX_CACHE_SIZE)) return;

  try {
    m = smsg(this, m) || m;
    if (!m) return;

    global.mconn = m;

    let dbUser;
    let dbChat;
    let settings;
    try {
      // Se vuelve a leer el registro tras crearlo: antes la variable quedaba en
      // `undefined` en el primer mensaje y los valores por defecto de un
      // usuario/chat nuevo solo se aplicaban desde el segundo.
      dbUser = ensureRecord(global.db.data.users, m.sender);
      if (!initializedUsers.has(m.sender)) {
        initializedUsers.set(m.sender, Date.now());
        Object.assign(dbUser, { ...USER_DEFAULTS, name: m.name, ...dbUser });
      }

      dbChat = ensureRecord(global.db.data.chats, m.chat);
      Object.assign(dbChat, { ...CHAT_DEFAULTS, ...dbChat });

      settings = ensureRecord(global.db.data.settings, botJid || this.user?.jid || 'default');
      Object.assign(settings, { ...SETTINGS_DEFAULTS, ...settings });

      // Aplicar prefijo guardado al conn
      if (settings.prefix === true) {
        // noprefix mode: acepta comandos sin prefijo o con cualquiera de los estándar
        this.prefix = /^[#!/.]?/;
      } else if (Array.isArray(settings.prefix)) {
        this.prefix = settings.prefix;
      } else if (typeof settings.prefix === 'string' && settings.prefix.length) {
        this.prefix = [settings.prefix];
      } else {
        this.prefix = global.prefix;
      }
    } catch (e) {
      console.error(e);
    }

    if (opts['nyimak']) return;
    if (!m.fromMe && opts['self']) return;
    if (opts['pconly'] && m.chat.endsWith('g.us')) return;
    if (opts['gconly'] && !m.chat.endsWith('g.us')) return;
    if (opts['swonly'] && m.chat !== 'status@broadcast') return;
    if (typeof m.text !== 'string') m.text = '';

    applyInteractiveResponse(m);

    const resolveLidJid = (jid) => {
      if (!jid?.endsWith('@lid')) return jid;
      const lidKey = jid.split('@')[0];
      const pnUser = this?.signalRepository?.lidMapping?.mappingCache?.get(`lid:${lidKey}`);
      if (pnUser && typeof pnUser === 'string') return `${pnUser}@s.whatsapp.net`;
      return jid;
    };
    const phoneOnly = (jid) => typeof jid === 'string' ? jid.split('@')[0].replace(/:\d+$/, '').replace(/\D/g, '') : '';
    const normalizeLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid') ? jid.replace(/:\d+@lid$/, '@lid') : jid;
    const senderJid = resolveLidJid(m.sender);
    const ownerList = global.owner.map(([number]) => number.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const senderLid = [m.sender, m.key?.participant, m.key?.remoteJid].map(normalizeLid).find(jid => typeof jid === 'string' && jid.endsWith('@lid'));
    const ownerLids = global.owner.map(([, , , lid]) => normalizeLid(lid)).filter(lid => typeof lid === 'string' && lid.endsWith('@lid'));
    const senderPhone = phoneOnly(senderJid);
    const isROwner = ownerList.some(ownerJid => {
      if (ownerJid === senderJid) return true;
      const ownerPhone = phoneOnly(ownerJid);
      return ownerPhone && senderPhone && ownerPhone === senderPhone;
    }) || ownerLids.includes(senderLid) || m.fromMe;
    const isOwner = isROwner;
    const modsList = global.mods.map((v) => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const isMods = isOwner || modsList.some(modJid => {
      if (modJid === senderJid) return true;
      return phoneOnly(modJid) === senderPhone && senderPhone !== '';
    });

    const premiumExpiry = typeof dbUser?.premiumTime === 'number' ? dbUser.premiumTime : 0;
    const isPremium = premiumExpiry > Date.now();
    if (dbUser && premiumExpiry > 0 && !isPremium) { dbUser.premiumTime = 0; dbUser.premium = false; }

    const isPrems = isMods || isPremium;

    if (m.isBaileys) return;

    let cachedMeta = this.chats[m.chat]?.metadata || null;
    let freshMeta = null;
    if (m.isGroup) {
      const lastFetch = this.chats[m.chat]?._metaFetchedAt || 0;
      if (!cachedMeta || (Date.now() - lastFetch) > META_TTL) {
        try {
          freshMeta = await this.groupMetadata(m.chat);
          if (freshMeta && this.chats[m.chat]) {
            this.chats[m.chat].metadata = freshMeta;
            this.chats[m.chat]._metaFetchedAt = Date.now();
          }
        } catch { /* sin metadata fresca: se usa la cacheada */ }
      }
    }
    const rawMeta = m.isGroup ? (freshMeta || cachedMeta || {}) : {};
    const rawParticipants = (rawMeta.participants || []).map(p => ({
      ...p,
      id: p.id || p.jid,
      jid: p.id || p.jid,
      lid: p.lid || null,
    }));
    const groupMetadata = m.isGroup ? { ...rawMeta, participants: rawParticipants } : {};
    const participants = rawParticipants.map(participant => ({
      id: participant.id || participant.jid,
      jid: participant.id || participant.jid,
      lid: participant.lid,
      admin: participant.admin,
    }));

    const botPhone = phoneOnly(this.user?.jid || this.user?.id || '');
    const user = (m.isGroup ? (
      participants.find((u) => {
        const uId = this.decodeJid(u.id || u.jid || '');
        if (uId && uId === senderJid) return true;
        if (uId && senderPhone && phoneOnly(uId) === senderPhone) return true;
        if (u.lid) {
          const resolvedLid = resolveLidJid(this.decodeJid(u.lid));
          if (resolvedLid === senderJid) return true;
          if (senderPhone && phoneOnly(resolvedLid) === senderPhone) return true;
        }
        return false;
      }) ||
      participants.find((u) => this.decodeJid(u.id || u.jid || '') === m.sender) ||
      participants.find((u) => u.lid && (u.lid === m.sender || u.lid?.split('@')[0] === m.sender?.split('@')[0]))
    ) : {}) || {};
    const bot = (m.isGroup ? (
      participants.find((u) => {
        const uId = this.decodeJid(u.id || u.jid || '');
        if (uId && uId === this.user?.jid) return true;
        if (uId && phoneOnly(uId) === botPhone) return true;
        if (uId?.endsWith('@lid')) {
          const resolvedUId = resolveLidJid(uId);
          if (resolvedUId && resolvedUId !== uId && phoneOnly(resolvedUId) === botPhone) return true;
          const contactJid = this.contacts?.[uId]?.id || this.contacts?.[uId]?.jid || '';
          if (contactJid && phoneOnly(contactJid) === botPhone) return true;
        }
        if (u.lid) {
          const resolvedLid = resolveLidJid(this.decodeJid(u.lid));
          if (resolvedLid && phoneOnly(resolvedLid) === botPhone) return true;
        }
        return false;
      })
    ) : {}) || {};
    const isRAdmin = user?.admin === 'superadmin' || false;
    const isAdmin = isRAdmin || user?.admin === 'admin' || isROwner || false;
    const isBotAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin' || false;

    for (const name in global.plugins) {
      const plugin = global.plugins[name];
      if (!plugin) continue;
      if (plugin.disabled) continue;

      const __filename = join(PLUGINS_DIR, name);
      if (typeof plugin.all === 'function') {
        try {
          await plugin.all.call(this, m, {
            chatUpdate,
            __dirname: PLUGINS_DIR,
            __filename,
          });
        } catch (e) {
          console.error(e);
        }
      }

      if (!opts['restrict']) {
        if (plugin.tags && plugin.tags.includes('admin')) continue;
      }

      const _prefix = plugin.customPrefix ? plugin.customPrefix : this.prefix ? this.prefix : global.prefix;
      const match = matchPrefix(_prefix, m.text);

      if (typeof plugin.before === 'function') {
        try {
          const _beforeResult = await plugin.before.call(this, m, {
            match,
            conn: this,
            participants,
            groupMetadata,
            user,
            bot,
            isROwner,
            isOwner,
            isRAdmin,
            isAdmin,
            isBotAdmin,
            isPrems,
            chatUpdate,
            __dirname: PLUGINS_DIR,
            __filename,
          });
          if (_beforeResult) {
            if (opts['debug']) console.log('[debug] plugin.before cortó el flujo en:', name);
            continue;
          }
        } catch (e) {
          console.error(e);
        }
      }

      if (typeof plugin !== 'function') continue;

      const hasPrefixMatch = Boolean(match?.[0]) && m.text.length > 0;
      const usedPrefix = match?.[0]?.[0] || '';
      if (hasPrefixMatch) {
        const noPrefix = m.text.slice(usedPrefix.length);
        const words = noPrefix.trim().split(' ');
        const args = words.filter((v) => v).slice(1);
        const _args = words.slice(1);
        const text = _args.join(' ');
        const command = (words.find((v) => v) || '').toLowerCase();
        const fail = plugin.fail || global.dfail;
        const isAccept = plugin.command instanceof RegExp ?
          plugin.command.test(command) :
          Array.isArray(plugin.command) ?
            plugin.command.some((cmd) => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
            typeof plugin.command === 'string' ?
              plugin.command === command :
              false;

        if (!isAccept) continue;
        if (opts['debug']) console.log('[debug] comando', command, '→', name);

        if (isForeignClientMessage(m.id)) return;

        // Chat baneado: solo el owner real puede seguir usando el bot ahí.
        if (dbChat?.isBanned && !isROwner) return;
        // Usuario baneado: se ignoran sus mensajes en silencio.
        if (m.text && dbUser?.banned && !isROwner) return;

        if (settings?.antispam && m.text && dbUser?.lastCommandTime && (Date.now() - dbUser.lastCommandTime) < ANTISPAM_WINDOW && !isROwner) {
          if (dbUser.commandCount === 2) {
            const remainingTime = Math.ceil((dbUser.lastCommandTime + ANTISPAM_WINDOW - Date.now()) / 1000);
            m.reply(`*[ ℹ️ ] Espera* _${remainingTime} segundos_ *antes de utilizar otro comando.*`)?.catch?.(console.error);
            return;
          }
          dbUser.commandCount = (dbUser.commandCount || 0) + 1;
        } else if (dbUser) {
          dbUser.lastCommandTime = Date.now();
          dbUser.commandCount = 1;
        }

        if (dbChat?.modoadmin && !isOwner && m.isGroup && !isAdmin) return;

        if (plugin.rowner && !isROwner) { fail('rowner', m, this); continue; }
        if (plugin.owner && !isOwner) { fail('owner', m, this); continue; }
        if (plugin.mods && !isMods) { fail('mods', m, this); continue; }
        if (plugin.premium && !isPrems) { fail('premium', m, this); continue; }
        if (plugin.group && !m.isGroup) { fail('group', m, this); continue; }
        else if (plugin.botAdmin && !isBotAdmin) { fail('botAdmin', m, this); continue; }
        else if (plugin.admin && !isAdmin) { fail('admin', m, this); continue; }
        if (plugin.private && m.isGroup) { fail('private', m, this); continue; }
        if (plugin.register == true && dbUser?.registered === false) { fail('unreg', m, this); continue; }

        m.isCommand = true;
        const extra = {
          match,
          usedPrefix,
          noPrefix,
          _args,
          args,
          command,
          text,
          conn: this,
          participants,
          groupMetadata,
          user,
          bot,
          isROwner,
          isOwner,
          isRAdmin,
          isAdmin,
          isBotAdmin,
          isPrems,
          isPremium,
          chatUpdate,
          __dirname: PLUGINS_DIR,
          __filename,
        };
        try {
          await plugin.call(this, m, extra);
        } catch (e) {
          m.error = e;
          console.error(e);
          if (e) {
            const text = format(e);
            await m.reply(text);
          }
        } finally {
          if (typeof plugin.after === 'function') {
            try {
              await plugin.after.call(this, m, extra);
            } catch (e) {
              console.error(e);
            }
          }
        }
        break;
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    // Se usa `this` y no un `mconn` compartido: con mensajes concurrentes (o
    // tras una reconexión) apuntaba al socket o al mensaje de otro handler. Un
    // fallo al marcar como leído tampoco debe escapar como promesa rechazada.
    try {
      const settingsRead = global.db.data?.settings?.[this.user?.jid] || {};
      if (m?.key && (opts['autoread'] || settingsRead.autoread2)) await this.readMessages([m.key]);
    } catch (e) {
      console.error(e);
    }
  }
}

export async function participantsUpdate({ id, participants: rawParticipants, action }) {
  if (opts['self']) return;
  try {
    if (global.db.data == null) await global.loadDatabase();
    const chat = global.db.data.chats[id] || {};
    const botSettings = global.db.data.settings[this.user?.jid] || {};

    const normalizeJidEntry = (p) => {
      if (typeof p === 'string') {
        try {
          const parsed = JSON.parse(p);
          if (parsed && typeof parsed === 'object') {
            const phone = parsed.phoneNumber || parsed.id || parsed.jid || p;
            return typeof phone === 'string' ? phone : p;
          }
        } catch { /* no es JSON: es un jid normal */ }
        if (p.endsWith('@lid')) {
          const mappingCache = this.signalRepository?.lidMapping?.mappingCache;
          if (mappingCache) {
            const lidKey = p.split('@')[0];
            const pnUser = mappingCache.get(`lid:${lidKey}`);
            if (pnUser && typeof pnUser === 'string') return `${pnUser}@s.whatsapp.net`;
          }
        }
        return p;
      }
      if (p && typeof p === 'object') {
        const phone = p.phoneNumber ? (p.phoneNumber.includes('@') ? p.phoneNumber : p.phoneNumber + '@s.whatsapp.net') : '';
        const entryId = p.id || p.jid || '';
        return phone || entryId || '';
      }
      return String(p);
    };
    const participants = rawParticipants.map(normalizeJidEntry).filter(Boolean);

    switch (action) {
      case 'add':
      case 'remove': {
        if (!chat.welcome || chat?.isBanned) break;
        if (action === 'remove' && participants.includes(this.user?.jid)) return;

        const groupMetadata = await this.groupMetadata(id).catch(() => null) || (this.chats[id] || {}).metadata;
        const botJid = this.user?.jid || '';
        const botPhone = botJid.replace(/[^0-9]/g, '');
        const botParticipant = groupMetadata?.participants?.find((u) => {
          const uId = this.decodeJid(u.id || u.jid || '');
          if (uId === botJid) return true;
          const uPhone = uId.replace(/[^0-9]/g, '');
          if (uPhone && botPhone && uPhone === botPhone) return true;
          if (u.lid) {
            const resolvedPhone = normalizeJidEntry(u.lid).replace(/[^0-9]/g, '');
            if (resolvedPhone && botPhone && resolvedPhone === botPhone) return true;
          }
          return false;
        }) || {};
        const isBotAdmin = botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin' || false;
        const subject = action === 'add' ? await this.getName(id) : '';

        for (const userJid of participants) {
          try {
            const userNumber = userJid.split('@')[0];

            if (action === 'add' && antiArabPrefixes.some((prefix) => userJid.startsWith(prefix)) && chat.antiArab && botSettings.restrict && isBotAdmin) {
              const removal = await this.groupParticipantsUpdate(id, [userJid], 'remove');
              if (removal[0].status === '404') continue;
              const fkontak = { 'key': { 'participants': '0@s.whatsapp.net', 'remoteJid': 'status@broadcast', 'fromMe': false, 'id': 'Halo' }, 'message': { 'contactMessage': { 'vcard': `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:y\nitem1.TEL;waid=${userNumber}:${userNumber}\nitem1.X-ABLabel:Ponsel\nEND:VCARD` } }, 'participant': '0@s.whatsapp.net' };
              await this.sendMessage(id, { text: `*[❗] @${userNumber} no se permiten números árabes o raros, serás removido*`, mentions: [userJid] }, { quoted: fkontak });
              continue;
            }

            const template = action === 'add'
              ? (chat.sWelcome || this.welcome || 'Welcome, @user!')
                  // Funciones como reemplazo: un `$&` dentro de la descripción no debe interpretarse.
                  .replace('@subject', () => subject)
                  .replace('@desc', () => groupMetadata?.desc?.toString() || '*SIN DESCRIPCIÓN*')
              : (chat.sBye || this.bye || 'Bye, @user!');
            const text = template.replace('@user', () => '@' + userNumber);

            const pp = await this.profilePictureUrl(userJid, 'image').catch(() => DEFAULT_PROFILE_PICTURE);
            const file = await this.getFile(pp);
            await this.sendFile(id, file.data, 'pp.jpg', text, null, false, { mentions: [userJid] });
          } catch (e) {
            console.log(e);
          }
        }
        break;
      }
      // `promote` no envía aviso aquí: el comando group-promote ya responde, y
      // el caso estaba armado sin llegar a enviar nada.
      case 'demote':
      case 'quitarpoder':
      case 'quitaradmin': {
        if (!chat.detect || chat?.isBanned) break;
        const template = chat?.sDemote || this.sdemote || '@user ```ya no es Admin```';
        for (const target of participants) {
          const text = template.replace('@user', () => '@' + target.split('@')[0]);
          await this.sendMessage(id, { text, mentions: this.parseMention(text) });
        }
        break;
      }
    }
  } catch (e) {
    console.error(e);
  }
}

export async function groupsUpdate(groupsUpdate) {
  if (opts['self']) return;
  if (global.db.data == null) await global.loadDatabase();
  for (const groupUpdate of groupsUpdate) {
    const id = groupUpdate.id;
    if (!id) continue;
    if (groupUpdate.subjectTime) continue;
    const chats = global.db.data?.chats?.[id];
    let text = '';
    if (!chats?.detect) continue;
    if (groupUpdate?.desc) text = (chats?.sDesc || this.sDesc || '```Descripción cambiada a```\n@desc').replace('@desc', () => groupUpdate.desc);
    if (groupUpdate?.subject) text = (chats?.sSubject || this.sSubject || '```Nombre cambiado a```\n@subject').replace('@subject', () => groupUpdate.subject);
    if (groupUpdate?.icon) text = (chats?.sIcon || this.sIcon || '```Ícono cambiado```').replace('@icon', () => groupUpdate.icon);
    if (groupUpdate?.revoke) text = (chats?.sRevoke || this.sRevoke || '```Link del grupo cambiado a```\n@revoke').replace('@revoke', () => groupUpdate.revoke);
    if (!text) continue;
    try {
      await this.sendMessage(id, { text, mentions: this.parseMention(text) });
    } catch (e) {
      console.error(e);
    }
  }
}

export async function deleteUpdate(message) {
  try {
    const fromMe = message?.key?.fromMe;
    const msgId = message?.key?.id;
    const participant = message?.participant || message?.key?.participant || '';
    if (fromMe || !msgId) return;
    if (global.db.data == null) await global.loadDatabase();
    const loaded = this.loadMessage(msgId);
    if (!loaded) return;
    const msg = this.serializeM(loaded);
    if (!msg) return;
    const chat = global.db.data?.chats?.[msg?.chat] || {};
    if (!chat?.antidelete) return;
    if (!msg?.isGroup) return;

    // `new Date(new Date() + 3600000)` concatenaba un texto y producía
    // «Invalid Date» en el aviso. Se formatea el instante actual en hora de Lima.
    const now = new Date();
    const date = now.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' });
    const time = now.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true, timeZone: 'America/Lima' });
    const participantNum = participant.split('@')[0];
    const antideleteMessage = `Mensaje eliminado de @${participantNum}\nHora: ${time}\nFecha: ${date}`.trim();
    await this.sendMessage(msg.chat, { text: antideleteMessage, mentions: participant ? [participant] : [] }, { quoted: msg });
    this.copyNForward(msg.chat, msg).catch(e => console.log(e, msg));
  } catch (e) {
    console.error(e);
  }
}

// Los avisos de permiso denegado (owner, admin, group…) se descartan en
// silencio a propósito; un plugin puede definir su propio `plugin.fail`.
global.dfail = () => {};

if (process.argv.includes('--dev')) {
  const file = fileURLToPath(import.meta.url);
  watchFile(file, async () => {
    unwatchFile(file);
    console.log(chalk.redBright("Update 'handler.js'"));
    if (global.reloadHandler) {
      try {
        await global.reloadHandler();
      } catch (e) {
        console.error('[handler] no se pudo recargar:', e);
      }
    }
  });
}
