import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const PLUGINS_DIR = './plugins';

// ─── Helpers ────────────────────────────────────────────────
const fixName = (n) => n.endsWith('.js') ? n : n + '.js';

function getPluginList() {
  return readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.disabled'));
}

function pluginStatus(filename) {
  const loaded = filename in global.plugins;
  const disabled = filename.endsWith('.disabled');
  return disabled ? '⏸️' : loaded ? '✅' : '⚠️';
}

// ─── Subcomandos ────────────────────────────────────────────
const CMDS = {

  // .mgr help
  help: async (m, conn) => {
    const txt = `🛠️ *Plugin Manager*

*📦 npm*
• \`.mgr install <paquete>\` — instala paquete npm
• \`.mgr uninstall <paquete>\` — desinstala paquete

*🔌 Plugins*
• \`.mgr list\` — lista todos los plugins
• \`.mgr view <plugin>\` — ver código fuente
• \`.mgr reload <plugin>\` — recargar plugin
• \`.mgr disable <plugin>\` — desactivar plugin
• \`.mgr enable <plugin>\` — activar plugin
• \`.mgr del <plugin>\` — eliminar plugin

*✏️ Crear plugin*
Responde a un mensaje con el código JS:
\`.mgr new <nombre>\`

*♻️ Editar plugin*
Responde a un mensaje con el nuevo código:
\`.mgr edit <nombre>\``.trim();
    await conn.sendMessage(m.chat, { text: txt }, { quoted: m });
  },

  // .mgr install axios
  install: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el paquete. Ej: `.mgr install axios`';
    const pkg = args.join(' ');
    await conn.sendMessage(m.chat, { text: `📦 _Instalando *${pkg}*..._` }, { quoted: m });
    try {
      const { stdout, stderr } = await execAsync(`npm install ${pkg} --save 2>&1`, { timeout: 120000 });
      const out = (stdout + stderr).slice(-1500);
      await conn.sendMessage(m.chat, { text: `✅ *Instalado:* ${pkg}\n\n\`\`\`${out}\`\`\`` }, { quoted: m });
    } catch (e) {
      throw `❌ Error instalando:\n\`\`\`${String(e.message).slice(0, 1000)}\`\`\``;
    }
  },

  // .mgr uninstall axios
  uninstall: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el paquete.';
    const pkg = args.join(' ');
    await conn.sendMessage(m.chat, { text: `🗑️ _Desinstalando *${pkg}*..._` }, { quoted: m });
    try {
      const { stdout } = await execAsync(`npm uninstall ${pkg} --save 2>&1`, { timeout: 60000 });
      await conn.sendMessage(m.chat, { text: `✅ *Desinstalado:* ${pkg}\n\n\`\`\`${stdout.slice(-800)}\`\`\`` }, { quoted: m });
    } catch (e) {
      throw `❌ Error:\n\`${String(e.message).slice(0, 800)}\``;
    }
  },

  // .mgr list
  list: async (m, conn) => {
    const files = getPluginList();
    if (!files.length) return conn.sendMessage(m.chat, { text: '📂 No hay plugins.' }, { quoted: m });
    const lines = files.map(f => `${pluginStatus(f)} ${f}`);
    const txt = `🔌 *Plugins (${files.length})*\n\n` + lines.join('\n');
    await conn.sendMessage(m.chat, { text: txt }, { quoted: m });
  },

  // .mgr view Tiktok-DL
  view: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado.`;
    const code = readFileSync(path, 'utf8');
    const preview = code.length > 3000 ? code.slice(0, 3000) + '\n... (truncado)' : code;
    await conn.sendMessage(m.chat, { text: `📄 *${name}*\n\n\`\`\`${preview}\`\`\`` }, { quoted: m });
  },

  // .mgr reload Tiktok-DL
  reload: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado.`;
    try {
      await global.reload(null, name);
      await conn.sendMessage(m.chat, { text: `♻️ *${name}* recargado correctamente.` }, { quoted: m });
    } catch (e) {
      throw `❌ Error al recargar:\n\`${e.message}\``;
    }
  },

  // .mgr disable Tiktok-DL
  disable: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const src = join(PLUGINS_DIR, name);
    const dst = join(PLUGINS_DIR, name + '.disabled');
    if (!existsSync(src)) throw `❌ Plugin *${name}* no encontrado.`;
    renameSync(src, dst);
    delete global.plugins[name];
    await conn.sendMessage(m.chat, { text: `⏸️ *${name}* desactivado.` }, { quoted: m });
  },

  // .mgr enable Tiktok-DL
  enable: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const base = fixName(args[0]);
    const src = join(PLUGINS_DIR, base + '.disabled');
    const dst = join(PLUGINS_DIR, base);
    if (!existsSync(src)) throw `❌ Plugin desactivado *${base}* no encontrado.`;
    renameSync(src, dst);
    await global.reload(null, base);
    await conn.sendMessage(m.chat, { text: `✅ *${base}* activado y cargado.` }, { quoted: m });
  },

  // .mgr del Tiktok-DL
  del: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado.`;
    unlinkSync(path);
    delete global.plugins[name];
    await conn.sendMessage(m.chat, { text: `🗑️ *${name}* eliminado.` }, { quoted: m });
  },

  // .mgr new mi-plugin  (respondiendo un mensaje con el código JS)
  new: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre. Ej: `.mgr new mi-plugin`\nResponde un mensaje con el código JS.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (existsSync(path)) throw `❌ Ya existe *${name}*. Usa \`.mgr edit ${name}\` para editarlo.`;

    // Obtener código del mensaje citado
    const quoted = m.quoted;
    const code = quoted?.text || quoted?.caption || null;
    if (!code) throw '⚠️ Responde un mensaje que contenga el código JS del plugin.';

    writeFileSync(path, code, 'utf8');
    // El watcher lo carga automáticamente, pero forzamos por si acaso
    setTimeout(() => global.reload(null, name).catch(() => {}), 500);
    await conn.sendMessage(m.chat, { text: `✅ Plugin *${name}* creado y cargado.` }, { quoted: m });
  },

  // .mgr edit Tiktok-DL  (respondiendo un mensaje con el nuevo código)
  edit: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado. Usa \`.mgr new\` para crearlo.`;

    const quoted = m.quoted;
    const code = quoted?.text || quoted?.caption || null;
    if (!code) throw '⚠️ Responde un mensaje con el nuevo código JS.';

    writeFileSync(path, code, 'utf8');
    setTimeout(() => global.reload(null, name).catch(() => {}), 500);
    await conn.sendMessage(m.chat, { text: `✏️ Plugin *${name}* actualizado y recargado.` }, { quoted: m });
  },
};

// ─── Handler principal ───────────────────────────────────────
const handler = async (m, { conn, args }) => {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!sub || !(sub in CMDS)) return CMDS.help(m, conn);

  await CMDS[sub](m, conn, rest);
};

handler.help = ['manager'];
handler.tags = ['owner'];
handler.command = /^(mgr|manager|pluginmgr)$/i;
handler.owner = true;

export default handler;
      
