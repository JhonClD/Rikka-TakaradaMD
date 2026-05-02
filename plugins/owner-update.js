import { execSync } from 'child_process';

const handler = async (m, { conn, text, command }) => {
  const tradutor = {
    texto1: "_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] No hay actualizaciones pendientes.*",
    texto2: "_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ℹ️ ] Actualización finalizada exitosamente.*\n\n",
    texto3: "_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ℹ️ ] Se han hecho cambios locales en archivos del bot que entran en conflicto con las actualizaciones del repositorio. Para actualizar, reinstala el bot o realiza las actualizaciones manualmente.*\n\n*Archivos en conflicto:*",
    texto4: "_*< PROPIETARIO - ACTUALIZAR />*_\n\n*[ ℹ️ ] Ocurrió un error. Por favor, inténtalo de nuevo más tarde.*"
  };

  // .skipfile plugins/speedtest.js → protege un archivo del git pull
  if (/^(skipfile|proteger)$/i.test(command)) {
    const file = text?.trim();
    if (!file) return conn.reply(m.chat, '❌ Indica el archivo.\nEjemplo: `.skipfile plugins/speedtest.js`', m);
    try {
      execSync(`git update-index --skip-worktree ${file}`);
      return conn.reply(m.chat, `✅ *${file}* protegido. Git pull ya no lo sobreescribirá.`, m);
    } catch (e) {
      return conn.reply(m.chat, `❌ Error: ${e.message}`, m);
    }
  }

  // .unskipfile plugins/speedtest.js → quita la protección
  if (/^(unskipfile|desproteger)$/i.test(command)) {
    const file = text?.trim();
    if (!file) return conn.reply(m.chat, '❌ Indica el archivo.\nEjemplo: `.unskipfile plugins/speedtest.js`', m);
    try {
      execSync(`git update-index --no-skip-worktree ${file}`);
      return conn.reply(m.chat, `✅ *${file}* desprotegido. Git pull volverá a actualizarlo.`, m);
    } catch (e) {
      return conn.reply(m.chat, `❌ Error: ${e.message}`, m);
    }
  }

  // .skiplist → ver archivos protegidos
  if (/^(skiplist|protegidos)$/i.test(command)) {
    try {
      const out = execSync('git ls-files -v').toString();
      const skipped = out.split('\n')
        .filter(l => l.startsWith('S '))
        .map(l => `  • ${l.slice(2)}`);
      if (skipped.length === 0) return conn.reply(m.chat, '📋 No hay archivos protegidos.', m);
      return conn.reply(m.chat, `📋 *Archivos protegidos del git pull:*\n\n${skipped.join('\n')}`, m);
    } catch (e) {
      return conn.reply(m.chat, `❌ Error: ${e.message}`, m);
    }
  }

  // .gitpull / .update normal
  try {
    const stdout = execSync('git pull' + (m.fromMe && text ? ' ' + text : ''));
    let messager = stdout.toString();
    if (messager.includes('Already up to date.')) messager = tradutor.texto1;
    if (messager.includes('Updating')) messager = tradutor.texto2 + stdout.toString();
    conn.reply(m.chat, messager, m);
  } catch {
    try {
      const status = execSync('git status --porcelain');
      if (status.length > 0) {
        const conflictedFiles = status
          .toString()
          .split('\n')
          .filter(line => line.trim() !== '')
          .map(line => {
            if (
              line.includes('.npm/') ||
              line.includes('.cache/') ||
              line.includes('tmp/') ||
              line.includes('RikkaSession/') ||
              line.includes('npm-debug.log')
            ) return null;
            return '*→ ' + line.slice(3) + '*';
          })
          .filter(Boolean);

        if (conflictedFiles.length > 0) {
          const errorMessage = `${tradutor.texto3}\n\n${conflictedFiles.join('\n')}.*`;
          await conn.reply(m.chat, errorMessage, m);
        }
      }
    } catch (error) {
      console.error(error);
      let errorMessage2 = tradutor.texto4;
      if (error.message) errorMessage2 += '\n*- Mensaje de error:* ' + error.message;
      await conn.reply(m.chat, errorMessage2, m);
    }
  }
};

handler.help = ['update', 'skipfile <archivo>', 'unskipfile <archivo>', 'skiplist'];
handler.tags = ['owner'];
handler.command = /^(update|actualizar|gitpull|skipfile|proteger|unskipfile|desproteger|skiplist|protegidos)$/i;
handler.rowner = true;

export default handler;
