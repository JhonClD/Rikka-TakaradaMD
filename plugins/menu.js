import moment from 'moment-timezone';

const TIMEZONE = 'America/Lima';

function getUptime(since) {
    if (!since) return 'INIT_STATE';
    const ms = Date.now() - since;
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return `${d > 0 ? d + 'ᴅ ' : ''}${h % 24}ʜ ${m % 60}ᴍ ${s % 60}s`.trim();
}

const CAT_ICONS = {
    anime: '◈', downloader: '⇲', search: '⌕', tools: '⚙︎', ai: '⌬', 
    sticker: '❏', game: '🕹', group: '⧉', nsfw: '⚔︎', owner: '✧', 
    info: 'ℹ︎', converter: '⏀', img: '🧩', xp: '📈', random: '⚄'
};

const getIcon = cat => CAT_ICONS[cat.toLowerCase()] || '⬡';

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
    const botName = 'Rikka Takarada';
    const uptime = getUptime(global.botUptime);
    const time = moment.tz(TIMEZONE).format('HH:mm');
    const date = moment.tz(TIMEZONE).format('DD.MM.YYYY');
    const categories = buildCategories();
    const totalCmds = Object.values(categories).flat().length;

    // --- ESTRUCTURA DE INTERFAZ PREMIUM ---
    let header = `─── · · ·  [ ${botName.toUpperCase()} ]  · · · ───\n\n`;
    
    header += `    ⎗  ꜱʏꜱᴛᴇᴍ.ɪɴꜰᴏ\n`;
    header += `    │  ◦  ᴜꜱᴇʀ : @${sender.split('@')[0]}\n`;
    header += `    │  ◦  ᴛɪᴍᴇ : ${time}  //  ${date}\n`;
    header += `    │  ◦  ᴜᴘᴛ : ${uptime}\n`;
    header += `    │  ◦  ʟɪʙ : ${totalCmds} ᴄᴍᴅꜱ\n`;
    header += `    └─────────────── · · ·\n\n`;

    const body = Object.entries(categories)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, cmds]) => {
            const icon = getIcon(cat);
            const title = cat.toUpperCase();
            // Formato de lista en doble columna simulada o lista limpia
            const list = cmds.map(c => `    │  ${c}`).join('\n');
            
            return `    ${icon}  [ ${title} ]\n` +
                   `    ┌───────────────\n` +
                   `${list}\n` +
                   `    └───────────────`;
        })
        .join('\n\n');

    // --- FOOTER IDENTITARIO ---
    const footer = `\n\n    · · · ───────────────────\n` +
                   `    ᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎  //  ʀɪᴋᴋᴀ-ɴᴇᴛ\n` +
                   `    ─────────────────── · · ·`;

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
    
