import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, '../src/banner.jpg');
const more = String.fromCharCode(8206);
const readMore = more.repeat(4001);

const clockString = (milliseconds) => {
  const days = Math.floor(milliseconds / 86400000);
  const hours = Math.floor(milliseconds / 3600000) % 24;
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
};

const handler = async (m, { conn, usedPrefix }) => {
  const settings = global.db?.data?.settings?.[conn.user.jid] || {};
  const bannerUrl = settings.banner?.startsWith('http') ? settings.banner : null;
  const prefix = usedPrefix || '/';
  const command = (name) => `${prefix}${name}`;
  const botName = settings.botname || 'ᖇɩƙƙᥲ Ʈᥲƙᥲɾᥲᑯᥲ°ᙖOƮ';
  const pushname = m.pushName || 'Usuario';
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
  }).format(new Date());
  const uptime = clockString(process.uptime() * 1000);
  const userData = global.db?.data?.users?.[m.sender] || {};
  const resolveLid = (jid) => {
    if (typeof jid !== 'string' || !jid.endsWith('@lid')) return jid;
    const lidKey = jid.split('@')[0];
    const phone = conn?.signalRepository?.lidMapping?.mappingCache?.get(`lid:${lidKey}`);
    return phone ? `${phone}@s.whatsapp.net` : jid;
  };
  const normalizeLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid')
    ? jid.replace(/:\d+@lid$/, '@lid')
    : jid;
  const phoneOnly = (jid) => typeof jid === 'string'
    ? jid.split('@')[0].replace(/:\d+$/, '').replace(/\D/g, '')
    : '';
  const senderJid = resolveLid(m.sender);
  const senderLid = [m.sender, m.key?.participant, m.key?.remoteJid]
    .map(normalizeLid)
    .find((jid) => typeof jid === 'string' && jid.endsWith('@lid'));
  const ownerJids = (global.owner || [])
    .map(([number]) => `${String(number).replace(/\D/g, '')}@s.whatsapp.net`);
  const ownerLids = (global.owner || [])
    .map(([, , , lid]) => normalizeLid(lid))
    .filter((lid) => typeof lid === 'string' && lid.endsWith('@lid'));
  const senderPhone = phoneOnly(senderJid);
  const isOwner = m.fromMe || ownerLids.includes(senderLid) || ownerJids.some((ownerJid) =>
    ownerJid === senderJid || (
      phoneOnly(ownerJid) && senderPhone && phoneOnly(ownerJid) === senderPhone
    ),
  );
  const isPremium = isOwner
    ? '👑 Owner'
    : userData.premiumTime > Date.now() ? '✅' : '❌';
  const totalCommands = Object.values(global.plugins || {}).reduce((total, plugin) => {
    if (!plugin?.command) return total;
    const help = Array.isArray(plugin.help) ? plugin.help : [plugin.help];
    return total + help.filter(Boolean).length;
  }, 0);

  let thumbBuffer;
  try {
    if (bannerUrl) {
      const response = await fetch(bannerUrl);
      if (response.ok) thumbBuffer = Buffer.from(await response.arrayBuffer());
    } else if (existsSync(BANNER_PATH)) {
      thumbBuffer = readFileSync(BANNER_PATH);
    }
  } catch {
    if (existsSync(BANNER_PATH)) thumbBuffer = readFileSync(BANNER_PATH);
  }

  const menuTexto = `━━━━━❒「 \`${botName}\` 」⋆｡ﾟ🎐

 ୨୧     ꒰ \`Usuario\`   :  ${pushname}
 ୨୧     ꒰ \`Premium\`   :  ${isPremium}
  ୨୧     ꒰ \`Uptime\`    :  ${uptime}
  ୨୧     ꒰ \`Fecha\`     :  ${date}
  ୨୧     ꒰ \`Prefix\`    :  ${prefix}
  ୨୧     ꒰ \`Comandos\`  :  ${totalCommands}

❐✼❑✼❐✼❑✼❒✼❑✼❐✼❑✼❐✼❑✼❐✼❑✼
${readMore}
╭━━━〔 🎐 *ANIME & MONITORES* 〕━━━⬣
┃ ⟡ *${command('animev1')}* _<título>_
┃ ⟡ *${command('animev1info')}* _<núm | URL>_
┃ ⟡ *${command('animev1ep')}* | *${command('animev1dl')}* _<ep> [sub|dub]_
┃ ⟡ *${command('nidl')}* _<nombre> [ep] [SUB|DUB] [T2]_
┃ ⟡ *${command('crlogin')}* _<email> <pass>_ | *${command('crlogout')}*
┃ ⟡ *${command('cr')}* _<set | rem | status | list | notify>_
┃ ⟡ *Monitores (animev1 / dbs / jk / tio):*
┃   ╰› _start • stop • status • check • queue_
┃   ╰› _flush • unblock • interval • example_
┃ ⟡ *${command('latexample')}* _[N]_ | *${command('animev1help')}*
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 📥 *DESCARGAS* 〕━━━⬣
┃ ⟡ *${command('play')}* | *${command('play2')}* | *${command('playaudio')}*
┃ ⟡ *${command('ytmp3')}* | *${command('yta')}* | *${command('ytmp3doc')}*
┃ ⟡ *${command('ytmp4')}* | *${command('ytmp4doc')}* | *${command('autoyt')}* _<on|off>_
┃ ⟡ *${command('mp3')}* | *${command('mp4')}* | *${command('video')}*
┃ ⟡ *${command('tiktok')}* | *${command('fb')}* _<url>_
┃ ⟡ *${command('x')}* | *${command('twitter')}* _<url>_
┃ ⟡ *${command('mediafire')}* (*${command('mf')}*) _<url>_
┃ ⟡ *${command('mega')}* (*${command('mg')}*) | *${command('gdrive')}* _<url>_
┃ ⟡ *${command('torrent')}*
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 🔍 *BUSCADORES* 〕━━━⬣
┃ ⟡ *${command('anime')}* _<nombre>_
┃ ⟡ *${command('yts')}* _<texto>_
┃ ⟡ *${command('pinterest')}* _<búsqueda | enlace>_
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 🛠️ *HERRAMIENTAS & CONVERTIDORES* 〕━━━⬣
┃ ⟡ *${command('s')}* | *${command('sticker')}* | *${command('st')}*
┃ ⟡ *${command('tourl')}* | *${prefix}tourl[1-13]* | *${command('tourllist')}*
┃ ⟡ *${command('translate')}* _<idioma> <texto>_ | *${command('tts')}*
┃ ⟡ *${command('ss')}* | *${command('ssweb')}* _<url>_
┃ ⟡ *${command('fetch')}* | *${command('get')}* _<url>_
┃ ⟡ *${command('speedtest')}*
┃ ⟡ *RSS:* *${command('rssadd')}* _<url>_ | *${command('rssdel')}* _<n>_
┃   ╰› _rsslist • rssrecientes • rsscheck_
┃   ╰› _rsspause <n> • rssresume <n>_
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 🏯 *GRUPOS* 〕━━━⬣
┃ ⟡ *${command('welcome')}* _<on|off|msg|bye|reset|ver>_
┃ ⟡ *${command('antilink')}* | *${command('antilink2')}* _<on|off>_
┃ ⟡ *${command('kickall')}*
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 💫 *PERFIL & INFO* 〕━━━⬣
┃ ⟡ *${command('profile')}* | *${command('setbirth')}* | *${command('setgender')}*
┃ ⟡ *${command('menu')}* | *${command('owner')}* | *${command('sysinfo')}* | *${command('host')}*
┃ ⟡ *${command('jid')}* | *${command('lid')}* | *${command('myjid')}*
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 🔞 *NSFW* 〕━━━⬣
┃ ⟡ *${command('hdl')}* _<nombre> <episodio>_
╰━━━━━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 💎 *OWNER* 〕━━━⬣
┃ ⟡ *${command('ex')}* _<código>_ | *${command('e')}* _<expresión>_
┃ ⟡ *${command('bash')}* | *${command('sh')}* | *${command('sudo')}* _<cmd>_
┃ ⟡ *${command('npm')}* | *${command('pip')}* | *${command('pip3')}* | *${command('pkg')}* | *${command('apt')}* _<pkg>_
┃ ⟡ *${command('dep')}* _<cmd>_ | *${command('deps')}*
┃ ⟡ *${command('addprem')}* | *${command('delprem')}* | *${command('checkprem')}* _@user_
┃ ⟡ *${command('update')}* _[--force]_ | *${command('soloowner')}* _<on|off>_
┃ ⟡ *${command('setname')}* | *${command('resetname')}* | *${command('setbanner')}*
┃ ⟡ *${command('setprefix')}* _<prefijo|noprefix|reset>_
┃ ⟡ *${command('join')}* _<link>_ | *${command('testbtn')}* _<sub>_
╰━━━━━━━━━━━━━━━━━━━━━━⬣`;

  if (thumbBuffer) {
    try {
      return await conn.sendMessage(m.chat, {
        image: thumbBuffer,
        caption: menuTexto,
      }, { quoted: m });
    } catch (error) {
      console.error('menu.js image send error:', error?.message || error);
    }
  }

  await conn.sendMessage(m.chat, { text: menuTexto }, { quoted: m });
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help)$/i;

export default handler;
