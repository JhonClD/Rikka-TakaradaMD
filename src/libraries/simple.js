import {
  proto,
  extractMessageContent,
  areJidsSameUser,
  jidDecode,
  jidNormalizedUser,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from '@whiskeysockets/baileys';
import { fileTypeFromBuffer } from 'file-type';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export function protoType() {
  String.prototype.decodeJid = function () {
    if (/:\d+@/i.test(this)) {
      const decode = jidDecode(this + '') || {};
      return ((decode.user && decode.server && decode.user + '@' + decode.server) || this) + '';
    } else {
      return this + '';
    }
  };

  Number.prototype.toTimeString = function () {
    const seconds = Math.floor((this / 1000) % 60);
    const minutes = Math.floor((this / (1000 * 60)) % 60);
    const hours = Math.floor((this / (1000 * 60 * 60)) % 24);
    const days = Math.floor(this / (1000 * 60 * 60 * 24));
    return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`]
      .filter(Boolean)
      .join(' ');
  };
}

export function serialize() {
  const MediaType = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage',
    'documentMessage',
  ];

  return Object.defineProperties(proto.WebMessageInfo.prototype, {
    conn: { value: undefined, enumerable: false, writable: true },

    id: {
      get() { return this.key?.id; },
    },

    isBaileys: {
      get() {
        return (
          (this?.fromMe || areJidsSameUser(this.conn?.user?.id, this.sender)) &&
          this.id?.startsWith('3EB0') &&
          (this.id.length === 20 || this.id.length === 22 || this.id.length === 12)
        ) || false;
      },
    },

    chat: {
      get() {
        return (this.key?.remoteJid || '').decodeJid();
      },
    },

    isGroup: {
      get() { return this.chat.endsWith('@g.us'); },
      enumerable: true,
    },

    sender: {
      get() {
        return this.conn?.decodeJid(
          (this.key?.fromMe && this.conn?.user?.id) ||
          this.participant ||
          this.key?.participant ||
          this.chat ||
          ''
        );
      },
      enumerable: true,
    },

    fromMe: {
      get() {
        return this.key?.fromMe || areJidsSameUser(this.conn?.user?.id, this.sender) || false;
      },
    },

    mtype: {
      get() {
        if (!this.message) return '';
        const keys = Object.keys(this.message);
        return (
          (!['senderKeyDistributionMessage', 'messageContextInfo'].includes(keys[0]) && keys[0]) ||
          (keys.length >= 3 && keys[1] !== 'messageContextInfo' && keys[1]) ||
          keys[keys.length - 1]
        );
      },
      enumerable: true,
    },

    msg: {
      get() {
        if (!this.message) return null;
        return this.message[this.mtype];
      },
    },

    mediaMessage: {
      get() {
        if (!this.message) return null;
        const content =
          (this.msg?.url || this.msg?.directPath)
            ? { ...this.message }
            : extractMessageContent(this.message) || null;
        if (!content) return null;
        const mtype = Object.keys(content)[0];
        return MediaType.includes(mtype) ? content : null;
      },
      enumerable: true,
    },

    mediaType: {
      get() {
        const msg = this.mediaMessage;
        if (!msg) return null;
        return Object.keys(msg)[0];
      },
      enumerable: true,
    },

    text: {
      get() {
        const msg = this.msg;
        const type = this.mtype;
        return (
          (typeof msg === 'string' && msg) ||
          msg?.text ||
          msg?.caption ||
          msg?.contentText ||
          (type === 'buttonsResponseMessage' && msg?.selectedButtonId) ||
          (type === 'templateButtonReplyMessage' && msg?.selectedId) ||
          (type === 'listResponseMessage' && msg?.singleSelectReply?.selectedRowId) ||
          (this.message?.conversation) ||
          (this.message?.extendedTextMessage?.text) ||
          (this.message?.imageMessage?.caption) ||
          (this.message?.videoMessage?.caption) ||
          ''
        );
      },
      set(v) {
        this._text = v;
      },
      enumerable: true,
    },

    mentionedJid: {
      get() {
        return this.msg?.contextInfo?.mentionedJid ||
          this.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
          [];
      },
      enumerable: true,
    },

    name: {
      get() {
        return this.pushName || '';
      },
    },

    quoted: {
      get() {
        const self = this;
        const msg = self.msg;
        const ctx = msg?.contextInfo;
        const quoted = ctx?.quotedMessage;
        if (!msg || !ctx || !quoted) return null;
        const type = Object.keys(quoted)[0];
        const q = quoted[type];
        const qText = typeof q === 'string' ? q : q?.text || q?.caption || '';

        return Object.defineProperties(
          JSON.parse(JSON.stringify(typeof q === 'string' ? { text: q } : q)),
          {
            mtype: { get() { return type; }, enumerable: true },
            id: { get() { return ctx.stanzaId; }, enumerable: true },
            chat: { get() { return ctx.remoteJid || self.chat; }, enumerable: true },
            sender: {
              get() { return (ctx.participant || self.chat || '').decodeJid(); },
              enumerable: true,
            },
            fromMe: {
              get() { return areJidsSameUser(this.sender, self.conn?.user?.jid); },
              enumerable: true,
            },
            text: {
              get() { return qText || this.caption || ''; },
              enumerable: true,
            },
            mediaMessage: {
              get() {
                const c = (q?.url || q?.directPath)
                  ? { ...quoted }
                  : extractMessageContent(quoted) || null;
                if (!c) return null;
                const mt = Object.keys(c)[0];
                return MediaType.includes(mt) ? c : null;
              },
              enumerable: true,
            },
            mediaType: {
              get() {
                const mm = this.mediaMessage;
                return mm ? Object.keys(mm)[0] : null;
              },
              enumerable: true,
            },
            download: {
              value(saveToFile) { return self.conn?.downloadM(this, type.replace(/Message$/, ''), saveToFile); },
              enumerable: true,
            },
            fakeObj: {
              get() {
                return proto.WebMessageInfo.fromObject({
                  key: {
                    fromMe: areJidsSameUser(ctx.participant, self.conn?.user?.jid),
                    remoteJid: self.chat,
                    id: ctx.stanzaId,
                    participant: ctx.participant,
                  },
                  message: quoted,
                  ...(ctx.participant ? { participant: ctx.participant } : {}),
                });
              },
              enumerable: true,
            },
          }
        );
      },
    },

    download: {
      value(saveToFile) {
        const type = this.mtype?.replace(/Message$/, '');
        return this.conn?.downloadM(this, type, saveToFile);
      },
      enumerable: true,
    },

    reply: {
      async value(text, chatId, options = {}) {
        if (!this.conn) return;
        const chat = chatId || this.chat;
        return this.conn.sendMessage(
          chat,
          { text: String(text), ...options },
          { quoted: this }
        );
      },
      enumerable: true,
    },
  });
}

export function smsg(conn, m) {
  if (!m) return m;
  m = proto.WebMessageInfo.fromObject(m);
  m.conn = conn;
  return m;
}

export function makeWASocket(conn) {
  return Object.defineProperties(conn, {
    decodeJid: {
      value(jid) {
        if (!jid) return jid;
        if (/:\d+@/i.test(jid)) {
          const d = jidDecode(jid) || {};
          return (d.user && d.server ? d.user + '@' + d.server : jid) + '';
        }
        return jid.trim();
      },
    },

    getName: {
      value(jid) {
        const id = this.decodeJid(jid);
        if (id.endsWith('@g.us')) {
          const meta = global.groupCache?.get(id)?.data?.groupMetadata;
          return meta?.subject || id.split('@')[0];
        }
        const c = this.contacts?.[id];
        return c?.name || c?.notify || c?.verifiedName || id.split('@')[0];
      },
    },

    downloadM: {
      async value(m, type, saveToFile) {
        let filename;
        if (!m || !m.mediaMessage) return Buffer.alloc(0);
        const msg = m.mediaMessage[m.mediaType || type + 'Message'] || m.mediaMessage[Object.keys(m.mediaMessage)[0]];
        if (!msg) return Buffer.alloc(0);
        const stream = await downloadContentFromMessage(msg, type || m.mediaType?.replace('Message', ''));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (saveToFile) {
          const { ext } = (await fileTypeFromBuffer(buf)) || { ext: 'bin' };
          filename = path.join('./src/tmp', `${Date.now()}.${ext}`);
          await fs.promises.writeFile(filename, buf);
        }
        return saveToFile ? { res: buf, filename } : buf;
      },
    },

    sendFile: {
      async value(jid, filePath, filename = '', caption = '', quoted, ptt = false, options = {}) {
        const file = fs.existsSync(filePath) ? fs.readFileSync(filePath) : filePath;
        const { mime } = (await fileTypeFromBuffer(Buffer.isBuffer(file) ? file : Buffer.from(file, 'base64'))) || { mime: 'application/octet-stream' };
        const isAudio = mime.startsWith('audio');
        const isVideo = mime.startsWith('video');
        const isImage = mime.startsWith('image');

        const msg = isAudio
          ? { audio: file, ptt, mimetype: mime, ...options }
          : isVideo
          ? { video: file, caption, mimetype: mime, ...options }
          : isImage
          ? { image: file, caption, mimetype: mime, ...options }
          : { document: file, caption, fileName: filename, mimetype: mime, ...options };

        return this.sendMessage(jid, msg, { quoted, ...options });
      },
    },

    parseMention: {
      value(text = '') {
        return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net');
      },
    },
  });
}
