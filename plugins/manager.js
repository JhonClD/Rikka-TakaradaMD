import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const PLUGINS_DIR = './plugins';

const fixName = (n) => n.endsWith('.js') ? n : n + '.js';

function getPluginList() {
  return readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.disabled'));
}

function pluginStatus(filename) {
  const loaded = filename in global.plugins;
  const disabled = filename.endsWith('.disabled');
  return disabled ? '⏸️' : loaded ? '✅' : '⚠️';
}

function getSysPackageManager() {
  if (process.env.PREFIX?.includes('com.termux')) return { i: 'pkg install -y', u: 'pkg uninstall -y' };
  
  try { execSync('apt-get --version', { stdio: 'ignore' }); return { i: 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y', u: 'sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y' }; } catch {}
  try { execSync('apk --version', { stdio: 'ignore' }); return { i: 'sudo apk add', u: 'sudo apk del' }; } catch {}
  try { execSync('pacman --version', { stdio: 'ignore' }); return { i: 'sudo pacman -S --noconfirm', u: 'sudo pacman -Rs --noconfirm' }; } catch {}
  try { execSync('dnf --version', { stdio: 'ignore' }); return { i: 'sudo dnf install -y', u: 'sudo dnf remove -y' }; } catch {}
  try { execSync('yum --version', { stdio: 'ignore' }); return { i: 'sudo yum install -y', u: 'sudo yum remove -y' }; } catch {}
  
  return null;
}

const CMDS = {
  help: async (m, conn) => {
    const txt = `🛠️ *Plugin & Package Manager*

*📦 Paquetes (NPM & Sistema)*
• \`.mgr install <paquete>\` — instala paquete npm
• \`.mgr install sys <paquete>\` — instala paquete del OS (apt, pkg, apk)
• \`.mgr uninstall <paquete>\` — desinstala de npm
• \`.mgr uninstall sys <paquete>\` — desinstala del OS

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

  install: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el paquete. Ej: `.mgr install axios` o `.mgr install sys ffmpeg`';
    
    const isSys = args[0].toLowerCase() === 'sys';
    const pkg = isSys ? args.slice(1).join(' ') : args.join(' ');
    
    if (isSys && !pkg) throw '⚠️ Indica el paquete del sistema. Ej: `.mgr install sys neofetch`';

    if (isSys) {
      const pm = getSysPackageManager();
      if (!pm) throw '❌ No se pudo detectar un gestor de paquetes soportado en este entorno (apt, pkg, apk, pacman).';
      
      await conn.sendMessage(m.chat, { text: `🖥️ _Instalando paquete del sistema *${pkg}*..._\n_Esto puede tardar unos minutos._` }, { quoted: m });
      try {
        const { stdout, stderr } = await execAsync(`${pm.i} ${pkg}`, { timeout: 300000 });
        const out = ((stdout || '') + (stderr || '')).trim().slice(-1500);
        await conn.sendMessage(m.chat, { text: `✅ *Instalado en el SO:* ${pkg}\n\n\`\`\`${out}\`\`\`` }, { quoted: m });
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).trim().slice(-2000);
        throw `❌ Error instalando en el sistema *${pkg}*:\n\`\`\`${out || e.message}\`\`\``;
      }
    } else {
      await conn.sendMessage(m.chat, { text: `📦 _Instalando en NPM *${pkg}*..._` }, { quoted: m });
      const runInstall = async (flags = '') => {
        return execAsync(`npm install ${pkg} --save ${flags}`.trim(), { timeout: 120000 });
      };
      try {
        let result;
        try {
          result = await runInstall();
        } catch (e1) {
          const out1 = ((e1.stdout || '') + (e1.stderr || '')).trim();
          if (out1.includes('ERESOLVE') || out1.includes('peer dep')) {
            await conn.sendMessage(m.chat, { text: `⚠️ _Conflicto de dependencias en NPM, reintentando con --legacy-peer-deps..._` }, { quoted: m });
            result = await runInstall('--legacy-peer-deps');
          } else {
            throw e1;
          }
        }
        const out = ((result.stdout || '') + (result.stderr || '')).trim().slice(-1500);
        await conn.sendMessage(m.chat, { text: `✅ *Instalado en NPM:* ${pkg}\n\n\`\`\`${out}\`\`\`` }, { quoted: m });
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).trim().slice(-2000);
        throw `❌ Error instalando npm *${pkg}*:\n\`\`\`${out || e.message}\`\`\``;
      }
    }
  },

  uninstall: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el paquete. Ej: `.mgr uninstall axios` o `.mgr uninstall sys ffmpeg`';
    
    const isSys = args[0].toLowerCase() === 'sys';
    const pkg = isSys ? args.slice(1).join(' ') : args.join(' ');
    
    if (isSys && !pkg) throw '⚠️ Indica el paquete del sistema.';

    if (isSys) {
      const pm = getSysPackageManager();
      if (!pm) throw '❌ Gestor de paquetes no detectado.';
      
      await conn.sendMessage(m.chat, { text: `🗑️ _Eliminando del sistema *${pkg}*..._` }, { quoted: m });
      try {
        const { stdout, stderr } = await execAsync(`${pm.u} ${pkg}`, { timeout: 120000 });
        const out = ((stdout || '') + (stderr || '')).trim().slice(-800);
        await conn.sendMessage(m.chat, { text: `✅ *Eliminado del SO:* ${pkg}\n\n\`\`\`${out}\`\`\`` }, { quoted: m });
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).trim().slice(-1000);
        throw `❌ Error eliminando:\n\`\`\`${out || e.message}\`\`\``;
      }
    } else {
      await conn.sendMessage(m.chat, { text: `🗑️ _Desinstalando de NPM *${pkg}*..._` }, { quoted: m });
      
      const runUninstall = async (flags = '') => {
        return execAsync(`npm uninstall ${pkg} --save ${flags}`.trim(), { timeout: 60000 });
      };

      try {
        let result;
        try {
          result = await runUninstall();
        } catch (e1) {
          const out1 = ((e1.stdout || '') + (e1.stderr || '')).trim();
          if (out1.includes('ERESOLVE') || out1.includes('peer dep')) {
            await conn.sendMessage(m.chat, { text: `⚠️ _Conflicto detectado. Forzando desinstalación con --legacy-peer-deps..._` }, { quoted: m });
            result = await runUninstall('--legacy-peer-deps');
          } else {
            throw e1;
          }
        }
        const out = ((result.stdout || '') + (result.stderr || '')).trim().slice(-800);
        await conn.sendMessage(m.chat, { text: `✅ *Desinstalado de NPM:* ${pkg}\n\n\`\`\`${out}\`\`\`` }, { quoted: m });
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).trim().slice(-1000);
        throw `❌ Error:\n\`\`\`${out || e.message}\`\`\``;
      }
    }
  },

  list: async (m, conn) => {
    const files = getPluginList();
    if (!files.length) return conn.sendMessage(m.chat, { text: '📂 No hay plugins.' }, { quoted: m });
    const lines = files.map(f => `${pluginStatus(f)} ${f}`);
    const txt = `🔌 *Plugins (${files.length})*\n\n` + lines.join('\n');
    await conn.sendMessage(m.chat, { text: txt }, { quoted: m });
  },

  view: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado.`;
    const code = readFileSync(path, 'utf8');
    const preview = code.length > 3000 ? code.slice(0, 3000) + '\n... (truncado)' : code;
    await conn.sendMessage(m.chat, { text: `📄 *${name}*\n\n\`\`\`${preview}\`\`\`` }, { quoted: m });
  },

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

  del: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre del plugin.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (!existsSync(path)) throw `❌ Plugin *${name}* no encontrado.`;
    unlinkSync(path);
    delete global.plugins[name];
    await conn.sendMessage(m.chat, { text: `🗑️ *${name}* eliminado.` }, { quoted: m });
  },

  new: async (m, conn, args) => {
    if (!args.length) throw '⚠️ Indica el nombre. Ej: `.mgr new mi-plugin`\nResponde un mensaje con el código JS.';
    const name = fixName(args[0]);
    const path = join(PLUGINS_DIR, name);
    if (existsSync(path)) throw `❌ Ya existe *${name}*. Usa \`.mgr edit ${name}\` para editarlo.`;

    const quoted = m.quoted;
    const code = quoted?.text || quoted?.caption || null;
    if (!code) throw '⚠️ Responde un mensaje que contenga el código JS del plugin.';

    writeFileSync(path, code, 'utf8');
    setTimeout(() => global.reload(null, name).catch(() => {}), 500);
    await conn.sendMessage(m.chat, { text: `✅ Plugin *${name}* creado y cargado.` }, { quoted: m });
  },

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
  
