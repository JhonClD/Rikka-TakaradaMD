import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const handler = async (m, { conn, args }) => {
  const filter = args[0]?.toLowerCase() || null; // .deps axios → busca solo axios

  await conn.sendMessage(m.chat, { text: '🔍 _Revisando dependencias..._' }, { quoted: m });

  // Leer package.json del bot
  let pkgDeps = {};
  try {
    const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
    pkgDeps = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
  } catch {
    throw '❌ No se pudo leer package.json';
  }

  const results = { ok: [], missing: [], error: [] };

  for (const [name, version] of Object.entries(pkgDeps)) {
    if (filter && !name.toLowerCase().includes(filter)) continue;

    // Resolver nombre real (para aliases tipo npm:paquete@version)
    const realName = version?.startsWith('npm:')
      ? version.replace(/^npm:/, '').replace(/@[^@]+$/, '')
      : name;

    const pkgPath = join('./node_modules', realName, 'package.json');

    if (!existsSync(pkgPath)) {
      results.missing.push(name);
      continue;
    }

    try {
      const installed = JSON.parse(readFileSync(pkgPath, 'utf8'));
      results.ok.push(`${name}@${installed.version}`);
    } catch {
      results.error.push(name);
    }
  }

  // Construir mensaje
  const total = results.ok.length + results.missing.length + results.error.length;
  const lines = [];

  lines.push(`📦 *Dependencias del bot* ${filter ? `_(filtro: ${filter})_` : ''}`);
  lines.push(`Total: ${total} | ✅ ${results.ok.length} | ❌ ${results.missing.length} | ⚠️ ${results.error.length}`);
  lines.push('');

  if (results.missing.length > 0) {
    lines.push('*❌ No instaladas:*');
    results.missing.forEach(p => lines.push(`  • ${p}`));
    lines.push('');
  }

  if (results.error.length > 0) {
    lines.push('*⚠️ Error al leer:*');
    results.error.forEach(p => lines.push(`  • ${p}`));
    lines.push('');
  }

  if (results.ok.length > 0) {
    lines.push('*✅ Instaladas:*');
    if (filter || results.ok.length <= 20) {
      results.ok.forEach(p => lines.push(`  • ${p}`));
    } else {
      lines.push(`  _${results.ok.length} paquetes instalados correctamente_`);
    }
  }

  if (results.missing.length > 0) {
    lines.push('');
    lines.push('💡 Para instalar las faltantes:');
    lines.push(`\`npm install ${results.missing.join(' ')}\``);
  }

  await conn.sendMessage(m.chat, { text: lines.join('\n') }, { quoted: m });
};

handler.help = ['deps'];
handler.tags = ['owner'];
handler.command = /^(deps|dependencias|checkdeps)$/i;
handler.owner = true;

export default handler;
