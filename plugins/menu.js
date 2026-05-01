import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

function getUptime(since) {
    if (!since) return 'Recién iniciado';
    const ms = Date.now() - since;
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    let uptime = [];
    if (d > 0) uptime.push(`${d}d`);
    if (h % 24 > 0) uptime.push(`${h % 24}h`);
    if (m % 60 > 0) uptime.push(`${m % 60}m`);
    uptime.push(`${s % 60}s`);
    return uptime.join(' ');
}

const CAT_ICONS = {
    anime: '🌸', downloader: '📥', descargas: '📥', search: '🔍', buscadores: '🔍',
    tools: '🛠️', herramientas: '🛠️', ai: '🤖', ia: '🤖', sticker: '🎭', stickers: '🎭',
    game: '🎮', games: '🎮', group: '🏯', grupos: '👥', nsfw: '🔞',
    owner: '👑', info: '✨', converter: '🪄', img: '🖼️', xp: '🔮',
    random: '🎲', otros: '📌',
};

const getIcon = cat => CAT_ICONS[cat.toLowerCase()] || '🔖';

function buildCategories() {
    const cats = {};
    for (const [, plugin] of Object.entries(global.plugins || {})) {
        if (!plugin?.command) continue;
        const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : plugin.tags) || 'otros';
        let cmds = Array.isArray(plugin.help) ? plugin.help : (plugin.help ? [plugin.help] : []);
        if (!cmds.length) {
            cmds = plugin.command instanceof RegExp
                ? [plugin.command.source.replace(/[^a-z|]/gi, '').split('|')[0]]
                : Array.isArray(plugin.command) ? [plugin.command[0]] : [plugin.command];
        }
        if (!cats[tag]) cats[tag] = [];
        cats[tag].push(...cmds.filter(Boolean));
    }
    return cats;
}

const handler = async (m, { conn, usedPrefix }) => {
    const prefix = usedPrefix || '.';
    const sender = m.sender;
    const pushname = m.pushName || sender.split('@')[0];
    const botName = 'Rikka Takarada'; // Nombre actualizado
    const uptime = getUptime(global.botUptime);
    const time = moment.tz(TIMEZONE).format('hh:mm A');
    const date = moment.tz(TIMEZONE).format('DD/MM/YYYY');
    const categories = buildCategories();

    // --- HEADER FLORAL ---
    let header = `︿︿︿︿︿〔 *${botName}* 〕︿︿︿︿︿\n`;
    header += `. . . . . ╰──╮ ˗ ˏˋ ˎˊ - ╭──╯ . . . . .\n\n`;
    header += `  ˚♡⋆｡ *Usuario:* @${sender.split('@')[0]}\n`;
    header += `  ˚♡⋆｡ *Fecha:* ${date}\n`;
    header += `  ˚♡⋆｡ *Hora:* ${time}\n`;
    header += `  ˚♡⋆｡ *Uptime:* ${uptime}\n\n`;
    header += `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;

    // --- CUERPO DEL MENÚ ---
    const body = Object.entries(categories)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, cmds]) => {
            const icon = getIcon(cat);
            const title = cat.charAt(0).toUpperCase() + cat.slice(1);
            const list = cmds.map(c => `  » ${prefix}${c}`).join('\n');
            
            return `  ⊱ ❒ *${icon} ${title}*\n` +
                   `﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏\n` +
                   `${list}\n` +
                   `  ───────────────`;
        })
        .join('\n\n');

    // --- FOOTER ESTÉTICO ---
    const footer = `\n\n*ੈ✩‧₊˚ ᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎ *ੈ✩‧₊˚\n_Usa ${prefix}ayuda si necesitas soporte_`;

    const finalMenu = `${header}${body}${footer}`;
    const menuImage = global.imagen1 || null;

    if (menuImage) {
        await conn.sendMessage(m.chat, {
            image: menuImage,
            caption: finalMenu,
            mentions: [sender],
        }, { quoted: m });
    } else {
        await m.reply(finalMenu, m.chat, { mentions: [sender] });
    }
};

handler.help = ['menu'];
handler.tags = ['info'];
handler.command = /^(menu|ayuda|help|start|comandos)$/i;

export default handler;
