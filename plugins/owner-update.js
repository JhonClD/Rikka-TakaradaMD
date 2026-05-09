/**
 * owner-update.js  (versión corregida)
 * Actualiza el bot desde el repositorio git con manejo robusto de errores.
 *
 * Comandos (solo rowner):
 *   .update          → Hace git pull normal
 *   .update --force  → Fuerza el pull descartando cambios locales
 *   .actualizar      → Alias
 *   .gitpull         → Alias
 */

import { execSync } from 'child_process';

// Ejecuta un comando y devuelve { stdout, stderr } sin lanzar excepción
function runCmd(cmd) {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      timeout: 60_000,       // 60 s máximo
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || err.message || '').toString().trim(),
    };
  }
}

// Archivos/carpetas que deben ignorarse al listar conflictos
const IGNORAR = [
  '.npm/', '.cache/', 'tmp/', 'RikkaSession/', 'MysticSession/',
  'npm-debug.log', 'node_modules/', 'package-lock.json',
];

const handler = async (m, { conn, text, args }) => {
  const t = {
    sinCambios:  `_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] El bot ya está actualizado. No hay cambios pendientes.*`,
    exito:       `_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] Actualización aplicada correctamente.*\n\n`,
    forzado:     `_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] Actualización forzada aplicada.*\n_(Se descartaron los cambios locales)_\n\n`,
    conflictos:  `_*< PROPIETARIO - UPDATE />*_\n\n*[ ⚠️ ] Hay cambios locales en conflicto. Usa *.update --force* para sobreescribirlos o edítalos manualmente.*\n\n*Archivos con cambios locales:*`,
    sinGit:      `_*< PROPIETARIO - UPDATE />*_\n\n*[ ❌ ] Este directorio no es un repositorio git. Reinstala el bot correctamente.*`,
    error:       `_*< PROPIETARIO - UPDATE />*_\n\n*[ ❌ ] Error al actualizar. Detalles:*\n`,
    iniciando:   `_*< PROPIETARIO - UPDATE />*_\n\n*[ ⏳ ] Verificando actualizaciones...*`,
  };

  // Confirmar que es un repo git
  const gitCheck = runCmd('git rev-parse --is-inside-work-tree');
  if (!gitCheck.ok || gitCheck.stdout !== 'true') {
    return conn.reply(m.chat, t.sinGit, m);
  }

  await conn.reply(m.chat, t.iniciando, m);

  const forzar = args.some(a => ['--force', '-f', 'force'].includes(a.toLowerCase()));

  if (forzar) {
    // Modo forzado: descarta cambios locales y hace pull limpio
    runCmd('git fetch --all');
    const reset = runCmd('git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)');
    const pull  = runCmd('git pull --rebase=false');

    if (!reset.ok || !pull.ok) {
      const detalle = [reset.stderr, pull.stderr].filter(Boolean).join('\n');
      return conn.reply(m.chat, t.error + `\`\`\`\n${detalle || 'Error desconocido'}\n\`\`\``, m);
    }

    return conn.reply(
      m.chat,
      t.forzado + (pull.stdout || 'Pull ejecutado.'),
      m
    );
  }

  // Pull normal
  const pull = runCmd('git pull');

  if (pull.ok) {
    if (pull.stdout.toLowerCase().includes('already up to date')) {
      return conn.reply(m.chat, t.sinCambios, m);
    }
    return conn.reply(m.chat, t.exito + pull.stdout, m);
  }

  // Pull falló — analizar causa
  const stderr = pull.stderr.toLowerCase();

  // ¿Conflictos/cambios locales?
  if (
    stderr.includes('your local changes') ||
    stderr.includes('please commit') ||
    stderr.includes('would be overwritten') ||
    stderr.includes('conflict')
  ) {
    const status = runCmd('git status --porcelain');
    const lineas = (status.stdout || '')
      .split('\n')
      .filter(l => l.trim())
      .filter(l => !IGNORAR.some(ig => l.includes(ig)))
      .map(l => `*• ${l.slice(3).trim()}*`);

    const listaArchivos = lineas.length
      ? lineas.join('\n')
      : '_(no se pudieron determinar los archivos)_';

    return conn.reply(
      m.chat,
      `${t.conflictos}\n\n${listaArchivos}\n\n_Usa *.update --force* para descartar cambios locales y actualizar._`,
      m
    );
  }

  // ¿Sin acceso a internet / repo?
  if (stderr.includes('could not resolve') || stderr.includes('unable to connect') || stderr.includes('network')) {
    return conn.reply(
      m.chat,
      `_*< PROPIETARIO - UPDATE />*_\n\n*[ ❌ ] Sin conexión al repositorio.*\n_Revisa tu conexión a internet e inténtalo de nuevo._`,
      m
    );
  }

  // Error genérico
  const detalle = [pull.stderr, pull.stdout].filter(Boolean).join('\n').slice(0, 800);
  return conn.reply(m.chat, t.error + `\`\`\`\n${detalle || 'Error desconocido'}\n\`\`\``, m);
};

handler.help    = ['update', 'update --force'];
handler.tags    = ['owner'];
handler.command = /^(update|actualizar|gitpull)$/i;
handler.rowner  = false;

export default handler;
