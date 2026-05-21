import { generateWAMessageFromContent } from "@whiskeysockets/baileys";
import { smsg } from './src/libraries/simple.js';
import { format } from 'util';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import { unwatchFile, watchFile } from 'fs';
import fs from 'fs';
import chalk from 'chalk';
import ws from 'ws';
import { isDuplicate, isValidMessage, extractMessageText } from './src/funcion/messageValidation.js';

import _printModule from './src/libraries/print.js';
const _printMessage = _printModule?.default ?? _printModule;

const _recentMessages = new Map();
const _DUPLICATE_TIMEOUT = 3000;
const _MAX_CACHE_SIZE = 150;

const _initializedUsers = new Map();
const _USER_INIT_TTL = 60 * 60 * 1000;

const _prefixRegexCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of _recentMessages.entries()) {
    if (now - ts > _DUPLICATE_TIMEOUT * 3) _recentMessages.delete(key);
  }
  for (const [key, ts] of _initializedUsers.entries()) {
    if (now - ts > _USER_INIT_TTL) _initializedUsers.delete(key);
  }
}, 30000);

let mconn;

const { proto } = (await import("@whiskeysockets/baileys")).default;
const isNumber = (x) => typeof x === 'number' && !isNaN(x);
const delay = (ms) => isNumber(ms) && new Promise((resolve) => setTimeout(function () {
  clearTimeout(this);
  resolve();
}, ms));

export async function handler(chatUpdate) {
  this.msgqueque = this.msgqueque || [];
  this.uptime = this.uptime || Date.now();
  if (!chatUpdate) return;

  const connectionTime = global.timestamp?.connect?.getTime() || Date.now();
  if (chatUpdate.messages?.length) {
    chatUpdate.messages = chatUpdate.messages.filter(msg => {
      const msgTs = (msg.messageTimestamp || 0) * 1000;
      return msgTs >= connectionTime - 60000;
    });
    if (!chatUpdate.messages.length) return;
  }

  this.pushMessage(chatUpdate.messages).catch(console.error);
  let m = chatUpdate.messages[chatUpdate.messages.length - 1];
  if (!m) return;

  if (!isValidMessage(m)) return;
  const _msgText = extractMessageText(m);
  const _sender = m.key?.fromMe ? (this?.user?.jid || '') : (m.key?.participant || m.key?.remoteJid || '');
  if (isDuplicate(m.key?.id, _sender, _msgText, _recentMessages, _DUPLICATE_TIMEOUT, _MAX_CACHE_SIZE)) return;

  if (global.db.data == null) await global.loadDatabase();

  try {
    m = smsg(this, m) || m;
    if (!m) return;

    global.mconn = m;
    mconn = m;
    m.exp = 0;
    m.money = false;
    m.limit = false;

    try {
      const user = global.db.data.users[m.sender];
      if (typeof user !== 'object') {
        global.db.data.users[m.sender] = {};
      }

      if (user && !_initializedUsers.has(m.sender)) {
        _initializedUsers.set(m.sender, Date.now());
        const defaults = {
          afk: -1,
          afkReason: '',
          age: -1,
          antispam: 0,
          antispamlastclaim: 0,
          atm: 0,
          autolevelup: true,
          banned: false,
          BannedReason: '',
          Banneduser: false,
          bank: 0,
          coin: 0,
          exp: 0,
          expired: 0,
          health: 100,
          hero: 1,
          job: 'Pengangguran',
          joincount: 2,
          joinlimit: 1,
          judilast: 0,
          lastclaim: 0,
          lastduel: 0,
          lastwork: 0,
          lastseen: 0,
          laper: 100,
          haus: 100,
          level: 0,
          limit: 20,
          limitjoinfree: 1,
          mana: 20,
          money: 15,
          mute: false,
          name: m.name,
          note: 0,
          pasangan: '',
          pet: 0,
          premium: false,
          premiumTime: 0,
          registered: false,
          reglast: 0,
          regTime: -1,
          role: 'Novato',
          rtrofi: 'bronce',
          sewa: false,
          skill: '',
          skillexp: 0,
          spammer: 0,
          stamina: 100,
          strength: 30,
          title: '',
          trofi: 0,
          unreglast: 0,
          warn: 0,
          lastrw: 0,
          gacha_characters: [],
          gacha_favorite: '',
          gacha_claimMsg: '',
          subbot_requested: false,
          subbot_request_ts: 0,
          subbot_jid: '',
          language: 'es',
          wallet: 0,
          wait: 0,
          intelligence: 10,
          agility: 16,
          pointxp: 0,
          potion: 10,
          tprem: 0,
          tigame: 50,
          snlast: 0,
          spinlast: 0,
          ssapi: 0,
          lastSetStatus: 0,
          lastspam: 0,
          lastngocok: 0,
          lastadventure: 0,
          lastbunga: 0,
          lastcoins: 0,
          lastcode: 0,
          lastcrusade: 0,
          lastdagang: 0,
          lasthourly: 0,
          lasthunt: 0,
          lastmining: 0,
          lastmisi: 0,
          lastmonthly: 0,
          lastpago: 0,
          lastrob: 0,
          lastweekly: 0,
          lbars: '[▒▒▒▒▒▒▒▒▒]',
          misi: '',
          gameglx: {},
        };
        Object.assign(user, { ...defaults, ...user });
      }

      const chat = global.db.data.chats[m.chat];
      if (typeof chat !== 'object') {
        global.db.data.chats[m.chat] = {};
      }
      if (chat) {
        const chats = {
          isBanned: false,
          welcome: true,
          detect: true,
          detect2: false,
          sWelcome: '',
          sBye: '',
          sPromote: '',
          sDemote: '',
          antidelete: false,
          modohorny: true,
          autosticker: false,
          audios: true,
          antiLink: false,
          antiLink2: false,
          antiviewonce: false,
          antiToxic: false,
          antiTraba: false,
          antiArab: false,
          antiArab2: false,
          antiporno: false,
          modoadmin: false,
          simi: false,
          game: true,
          expired: 0,
          language: 'es',
          setPrimaryBot: '',
          gacha: true,
          gacha_characters: {},
          gacha_rolls: {},
          gacha_sales: {},
          gacha_intercambios: [],
          gacha_timeTrade: 0,
          gacha_regalos: {},
        };
        Object.assign(chat, { ...chats, ...chat });
      }

      const settings = global.db.data.settings[this.user.jid];
      if (typeof settings !== 'object') global.db.data.settings[this.user.jid] = {};
      if (settings) {
        const setttings = {
          self: false,
          autoread: false,
          autoread2: false,
          restrict: false,
          antiCall: false,
          antiPrivate: false,
          modejadibot: true,
          antispam: false,
          audios_bot: true,
          modoia: false,
        };
        Object.assign(settings, { ...setttings, ...settings });
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

    {
      const _iResp = m.message?.interactiveResponseMessage;
      if (_iResp) {
        const _nfResp = _iResp.nativeFlowResponseMessage;
        if (_nfResp?.paramsJson) {
          try {
            const _nfParams = JSON.parse(_nfResp.paramsJson);
            if (typeof _nfParams?.id === 'string' && _nfParams.id) {
              m.text = _nfParams.id;
            }
          } catch (_) {}
        }
      }
      if (!m.text) {
        const _listId = m.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
        if (_listId) m.text = _listId;
      }
    }

    const _resolveLidJid = (jid) => {
      if (!jid?.endsWith('@lid')) return jid;
      const lidKey = jid.split('@')[0];
      const pnUser = this?.signalRepository?.lidMapping?.mappingCache?.get(`lid:${lidKey}`);
      if (pnUser && typeof pnUser === 'string') return `${pnUser}@s.whatsapp.net`;
      return jid;
    };
    const _phoneOnly = (jid) => (jid || '').replace(/[^0-9]/g, '');
    const _senderJid = _resolveLidJid(m.sender);
    const _ownerList = [...global.owner.map(([number]) => number)].map((v) => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const _senderPhone = _phoneOnly(_senderJid);
    const isROwner = _ownerList.some(ownerJid => {
      if (ownerJid === _senderJid) return true;
      const ownerPhone = _phoneOnly(ownerJid);
      return ownerPhone && _senderPhone && ownerPhone === _senderPhone;
    }) || m.fromMe;
    const isOwner = isROwner || m.fromMe;
    const _modsList = global.mods.map((v) => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const isMods = isOwner || _modsList.some(modJid => {
      if (modJid === _senderJid) return true;
      return _phoneOnly(modJid) === _senderPhone && _senderPhone !== '';
    });

    const _userDb = global.db.data.users[m.sender] || {};
    const _premExpiry = typeof _userDb.premiumTime === 'number' ? _userDb.premiumTime : 0;
    const isPremium = _premExpiry > Date.now();
    if (_premExpiry > 0 && !isPremium) { _userDb.premiumTime = 0; _userDb.premium = false; }

    const _thisBotJid = this.user?.jid || '';
    const _isSubBot = !_ownerList.includes(_thisBotJid) && global.conns?.some(c => c.user?.jid === _thisBotJid);

    const _subBotAllowed = new Set([
      's', 'sticker', 'st',
      'tiktok', 'ttdl', 'tiktokdl', 'tiktoknowm', 'tt', 'ttnowm', 'tiktokaudio', 'tiktok2', 'tt2',
      'fb', 'facebook', 'fbdl',
      'play', 'play2', 'playaudio', 'mp4', 'video',
      'rw', 'rollwaifu', 'roll', 'c', 'claim', 'reclamar',
      'harem', 'waifus', 'claims', 'mischicas',
      'ginfo', 'infogacha', 'gachainfo',
      'sell', 'vender', 'buyc', 'buychar', 'comprarwaifu', 'wshop', 'haremshop', 'tiendawaifus',
      'trade', 'intercambiar', 'aceptar', 'accept',
      'setfav', 'setfavourite', 'favorito', 'charimage', 'waifuimage', 'cimage', 'wimage', 'charinfo', 'wifu',
      'removesale', 'quitarventa', 'cancelsale',
      'balance', 'bal', 'monedas', 'coins', 'deposit', 'depositar', 'withdraw', 'retirar',
      'daily', 'diario', 'weekly', 'semanal', 'monthly', 'mensual', 'work', 'trabajar', 'farm',
      'waifu', 'neko',
      ...['pat','kiss','hug','slap','fuck','bite','lick','dance','cry','blush','wave',
          'punch','run','sleep','laugh','angry','bored','clap','coffee','cuddle',
          'pout','sad','scared','shy','smile','stare','think','wink','eat','bleh',
          'bonk','blowkiss','call','cold','comfort','cringe','curious','draw','dramatic',
          'drunk','gaming','handhold','happy','heat','highfive','impregnate','jump',
          'kill','kisscheek','love','nope','peek','push','scream','seduce','sing',
          'smoke','smug','sniff','snuggle','spit','step','thinkhard','tickle',
          'trip','walk','bath','bully','abrazar','besar','acariciar','morder','lamer',
          'bailar','llorar','sonrojarse','saludar','golpear','correr','dormir',
          'reir','enojado','aburrido','aplaudir','cafe','acurrucar','mueca',
          'triste','asustado','timido','sonreir','fumar','escupir','pisar',
          'caminar','guiñar','comer','nom','bañarse','molestar','pensar',
          'muak','choca','tomarlamano','calor','jugar','dibujar','llamar',
          'besito','tropezar','mirar','oler','curioso','consolar','embarazar',
          'besomejilla','coger','follar','preñar'],
    ]);

    const isPrems = isROwner || isOwner || isMods || isPremium;

    if (opts['queque'] && m.text && !(isMods || isPrems)) {
      const queque = this.msgqueque;
      const time = 1000 * 5;
      const previousID = queque[queque.length - 1];
      queque.push(m.id || m.key.id);
      setInterval(async function () {
        if (queque.indexOf(previousID) === -1) clearInterval(this);
        await delay(time);
      }, time);
    }

    if (m.isBaileys) return;

    m.exp += Math.ceil(Math.random() * 10);

    let usedPrefix;
    const _user = global.db.data && global.db.data.users && global.db.data.users[m.sender];

    const _META_TTL = 5 * 60 * 1000;
    let _cachedMeta = conn.chats[m.chat]?.metadata || null;
    let _freshMeta = null;
    if (m.isGroup) {
      const _lastFetch = conn.chats[m.chat]?._metaFetchedAt || 0;
      if (!_cachedMeta || (Date.now() - _lastFetch) > _META_TTL) {
        try {
          _freshMeta = await this.groupMetadata(m.chat);
          if (_freshMeta && conn.chats[m.chat]) {
            conn.chats[m.chat].metadata = _freshMeta;
            conn.chats[m.chat]._metaFetchedAt = Date.now();
          }
        } catch (_) {}
      }
    }
    const _rawMeta = m.isGroup ? (_freshMeta || _cachedMeta || {}) : {};
    const _rawParticipants = (_rawMeta.participants || []).map(p => ({
      ...p,
      id: p.id || p.jid,
      jid: p.id || p.jid,
      lid: p.lid || null,
    }));
    const groupMetadata = m.isGroup ? { ..._rawMeta, participants: _rawParticipants } : {};
    const participants = _rawParticipants.map(participant => ({
      id: participant.id || participant.jid,
      jid: participant.id || participant.jid,
      lid: participant.lid,
      admin: participant.admin,
    }));

    let resolvedSender = _senderJid;
    const user = (m.isGroup ? (
      participants.find((u) => {
        const uId = conn.decodeJid(u.id || u.jid || '');
        if (uId && uId === resolvedSender) return true;
        if (uId && _phoneOnly(uId) === _phoneOnly(resolvedSender)) return true;
        if (u.lid) {
          const resolvedLid = _resolveLidJid(conn.decodeJid(u.lid));
          if (resolvedLid === resolvedSender) return true;
          if (_phoneOnly(resolvedLid) === _phoneOnly(resolvedSender)) return true;
        }
        return false;
      }) ||
      participants.find((u) => conn.decodeJid(u.id || u.jid || '') === m.sender) ||
      participants.find((u) => u.lid && (u.lid === m.sender || u.lid?.split('@')[0] === m.sender?.split('@')[0]))
    ) : {}) || {};
    const bot = (m.isGroup ? (
      participants.find((u) => {
        const uId = conn.decodeJid(u.id || u.jid || '');
        if (uId && uId === this.user?.jid) return true;
        if (uId && _phoneOnly(uId) === _phoneOnly(this.user?.id || '')) return true;
        if (u.lid) {
          const resolvedLid = _resolveLidJid(conn.decodeJid(u.lid));
          if (resolvedLid && _phoneOnly(resolvedLid) === _phoneOnly(this.user?.id || '')) return true;
        }
        return false;
      })
    ) : {}) || {};
    const isRAdmin = user?.admin === 'superadmin' || false;
    const isAdmin = isRAdmin || user?.admin === 'admin' || isROwner || false;
    const isBotAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin' || false;

    const ___dirname = handler._pluginsDir ??= path.join(path.dirname(fileURLToPath(import.meta.url)), './plugins');
    for (const name in global.plugins) {
      const plugin = global.plugins[name];
      if (!plugin) continue;
      if (plugin.disabled) continue;

      const __filename = join(___dirname, name);
      if (typeof plugin.all === 'function') {
        try {
          await plugin.all.call(this, m, {
            chatUpdate,
            __dirname: ___dirname,
            __filename,
          });
        } catch (e) {
          console.error(e);
        }
      }

      if (!opts['restrict']) {
        if (plugin.tags && plugin.tags.includes('admin')) continue;
      }

      const _str2Regex = (str) => {
        if (_prefixRegexCache.has(str)) return _prefixRegexCache.get(str);
        const re = new RegExp(str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'));
        _prefixRegexCache.set(str, re);
        return re;
      };
      const _prefix = plugin.customPrefix ? plugin.customPrefix : conn.prefix ? conn.prefix : global.prefix;
      const match = (_prefix instanceof RegExp ?
        [[_prefix.exec(m.text), _prefix]] :
        Array.isArray(_prefix) ?
          _prefix.map((p) => {
            const re = p instanceof RegExp ? p : _str2Regex(p);
            return [re.exec(m.text), re];
          }) :
          typeof _prefix === 'string' ?
            [[_str2Regex(_prefix).exec(m.text), _str2Regex(_prefix)]] :
            [[[], new RegExp]]
      ).find((p) => p[1]);

      if (typeof plugin.before === 'function') {
        if (await plugin.before.call(this, m, {
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
          __dirname: ___dirname,
          __filename,
        })) continue;
      }

      if (typeof plugin !== 'function') continue;

      if ((usedPrefix = (match[0] || '')[0])) {
        const noPrefix = m.text.replace(usedPrefix, '');
        let [command, ...args] = noPrefix.trim().split` `.filter((v) => v);
        args = args || [];
        const _args = noPrefix.trim().split` `.slice(1);
        const text = _args.join` `;
        command = (command || '').toLowerCase();
        const fail = plugin.fail || global.dfail;
        const isAccept = plugin.command instanceof RegExp ?
          plugin.command.test(command) :
          Array.isArray(plugin.command) ?
            plugin.command.some((cmd) => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
            typeof plugin.command === 'string' ?
              plugin.command === command :
              false;

        if (!isAccept) continue;

        if (_isSubBot && !_subBotAllowed.has(command)) continue;

        if (m.id.startsWith('EVO') || m.id.startsWith('Lyru-') || (m.id.startsWith('BAE5') && m.id.length === 16) || m.id.startsWith('B24E') || (m.id.startsWith('8SCO') && m.id.length === 20) || m.id.startsWith('FizzxyTheGreat-')) return;

        m.plugin = name;
        if (m.chat in global.db.data.chats || m.sender in global.db.data.users) {
          const chat = global.db.data.chats[m.chat];
          const user = global.db.data.users[m.sender];
          const botSpam = global.db.data.settings[mconn.conn.user.jid];

          if (!['owner-update.js'].includes(name) && chat && chat?.isBanned && !isROwner) return;
          if (name != 'owner-update.js' && chat?.isBanned && !isROwner) return;

          if (m.text && user.banned && !isROwner) {
            if (typeof user.bannedMessageCount === 'undefined') user.bannedMessageCount = 0;
            if (user.bannedMessageCount < 3) {
              user.bannedMessageCount++;
            } else if (user.bannedMessageCount === 3) {
              user.bannedMessageSent = true;
            } else {
              return;
            }
            return;
          }

          if (botSpam.antispam && m.text && user && user.lastCommandTime && (Date.now() - user.lastCommandTime) < 5000 && !isROwner) {
            if (user.commandCount === 2) {
              const remainingTime = Math.ceil((user.lastCommandTime + 5000 - Date.now()) / 1000);
              if (remainingTime > 0) {
                m.reply(`*[ ℹ️ ] Espera* _${remainingTime} segundos_ *antes de utilizar otro comando.*`);
                return;
              } else {
                user.commandCount = 0;
              }
            } else {
              user.commandCount += 1;
            }
          } else {
            user.lastCommandTime = Date.now();
            user.commandCount = 1;
          }
        }

        const adminMode = global.db.data.chats[m.chat].modoadmin;
        if (adminMode && !isOwner && !isROwner && m.isGroup && !isAdmin) return;

        if (plugin.rowner && plugin.owner && !(isROwner || isOwner)) { fail('owner', m, this); continue; }
        if (plugin.rowner && !isROwner) { fail('rowner', m, this); continue; }
        if (plugin.owner && !isOwner) { fail('owner', m, this); continue; }
        if (plugin.mods && !isMods) { fail('mods', m, this); continue; }
        if (plugin.premium && !isPrems) { fail('premium', m, this); continue; }
        if (plugin.group && !m.isGroup) { fail('group', m, this); continue; }
        else if (plugin.botAdmin && !isBotAdmin) { fail('botAdmin', m, this); continue; }
        else if (plugin.admin && !isAdmin) { fail('admin', m, this); continue; }
        if (plugin.private && m.isGroup) { fail('private', m, this); continue; }
        if (plugin.register == true && _user.registered == false) { fail('unreg', m, this); continue; }

        m.isCommand = true;
        const xp = 'exp' in plugin ? parseInt(plugin.exp) : 17;
        if (xp > 200) {
          m.reply('Ngecit -_-');
        } else {
          m.exp += xp;
        }

        if (!isPrems && plugin.limit && global.db.data.users[m.sender].limit < plugin.limit * 1) {
          mconn.conn.reply(m.chat, `_${usedPrefix}buyall_`, m);
          continue;
        }
        if (plugin.level > _user.level) {
          mconn.conn.reply(m.chat, `Necesitas nivel ${plugin.level} (tienes ${_user.level})`, m);
          continue;
        }

        const normalizeJid = (jid) => jid?.replace(/[^0-9]/g, '');
        const isActiveBot = (jid) => {
          const normalizedJid = normalizeJid(jid) + '@s.whatsapp.net';
          return normalizedJid === global.conn.user.jid ||
            global.conns.some(bot => bot.user.jid === normalizedJid);
        };
        const chatPrim = global.db.data.chats[m.chat] || {};
        if (chatPrim.setPrimaryBot) {
          const primaryNumber = normalizeJid(chatPrim.setPrimaryBot) + '@s.whatsapp.net';
          const currentBotNumber = normalizeJid(mconn.conn.user.jid) + '@s.whatsapp.net';
          if (!isActiveBot(chatPrim.setPrimaryBot)) {
            console.log(`⚠ Bot primario ${primaryNumber} no está activo - Liberando chat`);
            delete chatPrim.setPrimaryBot;
            global.db.data.chats[m.chat] = chatPrim;
          } else if (primaryNumber && currentBotNumber !== primaryNumber) {
            return;
          }
        }

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
          isSubBot: _isSubBot,
          chatUpdate,
          __dirname: ___dirname,
          __filename,
        };
        try {
          await plugin.call(this, m, extra);
          if (!isPrems) {
            m.limit = m.limit || plugin.limit || false;
          }
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
    if (opts['queque'] && m.text) {
      const quequeIndex = this.msgqueque.indexOf(m.id || m.key.id);
      if (quequeIndex !== -1) this.msgqueque.splice(quequeIndex, 1);
    }

    let user;
    const stats = global.db.data.stats;
    if (m) {
      if (m.sender && (user = global.db.data.users[m.sender])) {
        user.exp += m.exp;
        user.limit -= m.limit * 1;
      }
      let stat;
      if (m.plugin) {
        const now = +new Date;
        if (m.plugin in stats) {
          stat = stats[m.plugin];
          if (!isNumber(stat.total)) stat.total = 1;
          if (!isNumber(stat.success)) stat.success = m.error != null ? 0 : 1;
          if (!isNumber(stat.last)) stat.last = now;
          if (!isNumber(stat.lastSuccess)) stat.lastSuccess = m.error != null ? 0 : now;
        } else {
          stat = stats[m.plugin] = {
            total: 1,
            success: m.error != null ? 0 : 1,
            last: now,
            lastSuccess: m.error != null ? 0 : now,
          };
        }
        stat.total += 1;
        stat.last = now;
        if (m.error == null) {
          stat.success += 1;
          stat.lastSuccess = now;
        }
      }
    }

    try {
      if (!opts['noprint']) await _printMessage(m, this);
    } catch (e) {
      console.log(m, m.quoted, e);
    }
    const settingsREAD = global.db.data.settings[mconn.conn.user.jid] || {};
    if (opts['autoread']) await mconn.conn.readMessages([m.key]);
    if (settingsREAD.autoread2) await mconn.conn.readMessages([m.key]);
  }
}

export async function participantsUpdate({ id, participants: _rawParticipants, action }) {
  const m = mconn;
  if (opts['self']) return;
  if (global.db.data == null) await loadDatabase();
  const chat = global.db.data.chats[id] || {};
  const botTt = global.db.data.settings[mconn?.conn?.user?.jid] || {};
  let text = '';

  const _normalizeJidEntry = (p) => {
    if (typeof p === 'string') {
      try {
        const parsed = JSON.parse(p);
        if (parsed && typeof parsed === 'object') {
          const phone = parsed.phoneNumber || parsed.id || parsed.jid || p;
          return typeof phone === 'string' ? phone : p;
        }
      } catch (_) {}
      if (p.endsWith('@lid')) {
        const mappingCache = mconn?.conn?.signalRepository?.lidMapping?.mappingCache;
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
      const id = p.id || p.jid || '';
      return phone || id || '';
    }
    return String(p);
  };
  const participants = _rawParticipants.map(_normalizeJidEntry).filter(Boolean);

  switch (action) {
    case 'add':
    case 'remove':
      if (chat.welcome && !chat?.isBanned) {
        if (action === 'remove' && participants.includes(m?.conn?.user?.jid)) return;
        const groupMetadata = await m?.conn?.groupMetadata(id) || (conn?.chats[id] || {}).metadata;
        for (const userJid of participants) {
          try {
            let pp = await m?.conn?.profilePictureUrl(userJid, 'image').catch(_ => 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png?q=60');
            const apii = await mconn?.conn?.getFile(pp);
            const antiArab = JSON.parse(fs.readFileSync('./src/antiArab.json'));
            const userPrefix = antiArab.some((prefix) => userJid.startsWith(prefix));
            const botJidClean = m?.conn?.user?.jid || '';
            const botPhoneClean = botJidClean.replace(/[^0-9]/g, '');
            const botTt2 = groupMetadata?.participants?.find((u) => {
              const uId = m?.conn?.decodeJid(u.id || u.jid || '');
              if (uId === botJidClean) return true;
              const uPhone = uId.replace(/[^0-9]/g, '');
              if (uPhone && botPhoneClean && uPhone === botPhoneClean) return true;
              if (u.lid) {
                const resolvedLid = _normalizeJidEntry(u.lid);
                const resolvedPhone = resolvedLid.replace(/[^0-9]/g, '');
                if (resolvedPhone && botPhoneClean && resolvedPhone === botPhoneClean) return true;
              }
              return false;
            }) || {};
            const isBotAdminNn = botTt2?.admin === 'admin' || botTt2?.admin === 'superadmin' || false;
            text = (action === 'add'
              ? (chat.sWelcome || conn.welcome || 'Welcome, @user!')
                  .replace('@subject', await m?.conn?.getName(id))
                  .replace('@desc', groupMetadata?.desc?.toString() || '*SIN DESCRIPCIÓN*')
                  .replace('@user', '@' + userJid.split('@')[0])
              : (chat.sBye || conn.bye || 'Bye, @user!')
            ).replace('@user', '@' + userJid.split('@')[0]);
            if (userPrefix && chat.antiArab && botTt.restrict && isBotAdminNn && action === 'add') {
              const responseb = await m.conn.groupParticipantsUpdate(id, [userJid], 'remove');
              if (responseb[0].status === '404') return;
              const fkontak2 = { 'key': { 'participants': '0@s.whatsapp.net', 'remoteJid': 'status@broadcast', 'fromMe': false, 'id': 'Halo' }, 'message': { 'contactMessage': { 'vcard': `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:y\nitem1.TEL;waid=${userJid.split('@')[0]}:${userJid.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD` } }, 'participant': '0@s.whatsapp.net' };
              await m?.conn?.sendMessage(id, { text: `*[❗] @${userJid.split('@')[0]} no se permiten números árabes o raros, serás removido*`, mentions: [userJid] }, { quoted: fkontak2 });
              return;
            }
            await m?.conn?.sendFile(id, apii.data, 'pp.jpg', text, null, false, { mentions: [userJid] });
          } catch (e) {
            console.log(e);
          }
        }
      }
      break;
    case 'promote':
    case 'daradmin':
    case 'darpoder':
      text = (chat.sPromote || conn?.spromote || '@user ```es ahora Admin```');
      break;
    case 'demote':
    case 'quitarpoder':
    case 'quitaradmin': {
      if (!text) text = (chat?.sDemote || conn?.sdemote || '@user ```ya no es Admin```');
      let _p0 = participants[0] || '';
      try {
        const _parsed = JSON.parse(_p0);
        if (_parsed && typeof _parsed === 'object') _p0 = _parsed.phoneNumber || _parsed.id || _p0;
      } catch (_) {}
      const _p0Number = _p0.includes('@') ? _p0.split('@')[0] : _p0;
      text = text.replace('@user', '@' + _p0Number);
      if (chat.detect && !chat?.isBanned) {
        mconn?.conn?.sendMessage(id, { text, mentions: mconn?.conn?.parseMention(text) });
      }
      break;
    }
  }
}

export async function groupsUpdate(groupsUpdate) {
  if (opts['self']) return;
  for (const groupUpdate of groupsUpdate) {
    const id = groupUpdate.id;
    if (!id) continue;
    if (groupUpdate.size == NaN) continue;
    if (groupUpdate.subjectTime) continue;
    const chats = global.db.data.chats[id];
    let text = '';
    if (!chats?.detect) continue;
    if (groupUpdate?.desc) text = (chats?.sDesc || conn?.sDesc || '```Descripción cambiada a```\n@desc').replace('@desc', groupUpdate.desc);
    if (groupUpdate?.subject) text = (chats?.sSubject || conn?.sSubject || '```Nombre cambiado a```\n@subject').replace('@subject', groupUpdate.subject);
    if (groupUpdate?.icon) text = (chats?.sIcon || conn?.sIcon || '```Ícono cambiado```').replace('@icon', groupUpdate.icon);
    if (groupUpdate?.revoke) text = (chats?.sRevoke || conn?.sRevoke || '```Link del grupo cambiado a```\n@revoke').replace('@revoke', groupUpdate.revoke);
    if (!text) continue;
    await mconn?.conn?.sendMessage(id, { text, mentions: mconn?.conn?.parseMention(text) });
  }
}

export async function callUpdate(callUpdate) {}

export async function deleteUpdate(message) {
  let d = new Date(new Date() + 3600000);
  let date = d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
  let time = d.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });
  try {
    const fromMe = message?.key?.fromMe;
    const msgId = message?.key?.id;
    const participant = message?.participant || message?.key?.participant || '';
    if (fromMe) return;
    if (!msgId) return;
    let msg = mconn.conn.serializeM(mconn.conn.loadMessage(msgId));
    if (!msg) return;
    let chat = global.db.data.chats[msg?.chat] || {};
    if (!chat?.antidelete) return;
    if (!msg?.isGroup) return;
    const participantNum = participant.split('@')[0];
    const antideleteMessage = `Mensaje eliminado de @${participantNum}\nHora: ${time}\nFecha: ${date}`.trim();
    await mconn.conn.sendMessage(msg.chat, { text: antideleteMessage, mentions: participant ? [participant] : [] }, { quoted: msg });
    mconn.conn.copyNForward(msg.chat, msg).catch(e => console.log(e, msg));
  } catch (e) {
    console.error(e);
  }
}

global.dfail = (type, m, conn) => {
  const msg = '';
  const warn = ['', '', ''];
  const aa = { quoted: m, userJid: conn.user.jid };
  const prep = generateWAMessageFromContent(m.chat, { extendedTextMessage: { text: msg, contextInfo: { externalAdReply: { title: warn[0], body: warn[1], thumbnail: imagen1, sourceUrl: warn[2] } } } }, aa);

  const chatPrim2 = global.db.data.chats[m.chat] || {};
  const normalizeJid2 = (jid) => jid?.replace(/[^0-9]/g, '');
  const isActiveBot2 = (jid) => {
    const normalizedJid2 = normalizeJid2(jid) + '@s.whatsapp.net';
    return normalizedJid2 === global.conn.user.jid ||
      global.conns.some(bot => bot.user.jid === normalizedJid2);
  };
  if (chatPrim2.setPrimaryBot) {
    const primaryNumber2 = normalizeJid2(chatPrim2.setPrimaryBot) + '@s.whatsapp.net';
    const currentBotNumber2 = normalizeJid2(mconn.conn.user.jid) + '@s.whatsapp.net';
    if (!isActiveBot2(chatPrim2.setPrimaryBot)) {
      delete chatPrim2.setPrimaryBot;
      global.db.data.chats[m.chat] = chatPrim2;
    } else if (primaryNumber2 && currentBotNumber2 !== primaryNumber2) {
      return;
    }
  } else if (msg) return conn.relayMessage(m.chat, prep.message, { messageId: prep.key.id });
};

const file = global.__filename(import.meta.url, true);
watchFile(file, async () => {
  unwatchFile(file);
  console.log(chalk.redBright("Update 'handler.js'"));
  if (global.reloadHandler) console.log(await global.reloadHandler());
  if (global.conns && global.conns.length > 0) {
    const users = [...new Set([...global.conns.filter((conn) => conn.user && conn.ws.socket && conn.ws.socket.readyState !== ws.CLOSED).map((conn) => conn)])];
    for (const userr of users) {
      userr.subreloadHandler(false);
    }
  }
});
