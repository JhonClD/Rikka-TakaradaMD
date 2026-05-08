import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const handler = async (m, { conn, text }) => {
  const T = {
    noChanges: `_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] No hay actualizaciones pendientes.*`,
    updated:   `_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ℹ️ ] Actualización finalizada exitosamente.*\n\n`,
    conflict:  `_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ⚠️ ] Hay cambios locales en conflicto. Reinstala el bot o actualiza manualmente.*\n\n*Archivos en conflicto:*`,
    error:     `_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ❌ ] Ocurrió un error. Inténtalo de nuevo más tarde.*`,
  };

  // Paths a ignorar en el diff
  const IGNORE = ['.npm/', '.cache/', 'tmp/', 'RikkaSession/', 'npm-debug.log', 'node_modules/'];

  await conn.reply(m.chat, '⏳ Ejecutando git pull...', m);

  try {
    const extraArgs = m.fromMe && text ? ' ' + text : '';
    const { stdout } = await execAsync(`git pull${extraArgs}`, { timeout: 30_000 });

    if (stdout.includes('Already up to date.')) {
      return conn.reply(m.chat, T.noChanges, m);
    }

    if (stdout.includes('Updating') || stdout.includes('Fast-forward')) {
      return conn.reply(m.chat, T.updated + '```\n' + stdout.trim() + '\n```', m);
    }

    // Respuesta inesperada — mostrarla igual
    return conn.reply(m.chat, '```\n' + stdout.trim() + '\n```', m);

  } catch (pullErr) {
    // git pull falló → revisar si hay conflictos locales
    try {
      const { stdout: statusOut } = await execAsync('git status --porcelain', { timeout: 10_000 });

      const conflicted = statusOut
        .split('\n')
        .filter(line => line.trim())
        .filter(line => !IGNORE.some(ig => line.includes(ig)))
        .map(line => `*→ ${line.slice(3).trim()}*`);

      if (conflicted.length > 0) {
        return conn.reply(m.chat, `${T.conflict}\n\n${conflicted.join('\n')}`, m);
      }

      // No hay conflictos pero pull igualmente falló → mostrar stderr
      const errMsg = pullErr.stderr || pullErr.message || 'Sin detalles';
      return conn.reply(m.chat, T.error + '\n*Error:* ' + errMsg.slice(0, 300), m);

    } catch (statusErr) {
      console.error('[update] git status error:', statusErr);
      return conn.reply(m.chat, T.error + '\n*Error:* ' + statusErr.message.slice(0, 300), m);
    }
  }
};

handler.help    = ['update'];
handler.tags    = ['owner'];
handler.command = /^(update|actualizar|gitpull)$/i;
handler.rowner  = true;

export default handler;
                        
