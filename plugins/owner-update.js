import { simpleGit } from 'simple-git';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const handler = async (m, { conn, usedPrefix }) => {
  const isOwner =
    (global.owner || []).some(([num]) => m.sender.startsWith(num)) ||
    m.sender.startsWith(global.nomorown || '');

  if (!isOwner) return m.reply('❌ Solo el *owner* puede actualizar el bot.');

  const wait = await conn.sendMessage(m.chat, {
    text: `⏳ *Buscando actualizaciones...*`,
  }, { quoted: m });

  try {
    const git = simpleGit(ROOT);

    // Info del remote antes del pull
    const statusBefore = await git.log({ maxCount: 1 });
    const commitAntes = statusBefore.latest;

    // Fetch para ver si hay cambios
    await git.fetch();
    const status = await git.status();

    if (status.behind === 0) {
      return conn.sendMessage(m.chat, {
        text:
          `✅ *El bot ya está actualizado*\n\n` +
          `╰┈➤ 📌 *Commit actual:*\n` +
          `┊ \`${commitAntes?.hash?.slice(0, 7)}\` ${commitAntes?.message || ''}`,
        edit: wait.key,
      });
    }

    // Hay commits nuevos — hacer pull
    const pull = await git.pull('origin', undefined, { '--rebase': 'false' });

    const statusAfter = await git.log({ maxCount: 1 });
    const commitDespues = statusAfter.latest;

    const filesChanged = pull.files.length
      ? pull.files.slice(0, 10).map(f => `┊ 📄 ${f}`).join('\n') +
        (pull.files.length > 10 ? `\n┊ _...y ${pull.files.length - 10} más_` : '')
      : '┊ _Sin archivos detallados_';

    await conn.sendMessage(m.chat, {
      text:
        `✅ *Bot actualizado correctamente*\n\n` +
        `❖––––––『📦 *Resumen*\n` +
        `┊ 🔼 *Commits nuevos:* ${status.behind}\n` +
        `┊ ➕ *Inserciones:* ${pull.insertions || 0}\n` +
        `┊ ➖ *Eliminaciones:* ${pull.deletions || 0}\n` +
        `╰━═┅═━––––––๑\n\n` +
        `❖––––––『📄 *Archivos modificados*\n` +
        `${filesChanged}\n` +
        `╰━═┅═━––––––๑\n\n` +
        `❖––––––『🔖 *Commits*\n` +
        `┊ *Antes:* \`${commitAntes?.hash?.slice(0, 7)}\` ${commitAntes?.message || ''}\n` +
        `┊ *Ahora:* \`${commitDespues?.hash?.slice(0, 7)}\` ${commitDespues?.message || ''}\n` +
        `╰━═┅═━––––––๑\n\n` +
        `_Usa_ *${usedPrefix}reiniciar* _para aplicar los cambios_`,
      edit: wait.key,
    });

  } catch (err) {
    await conn.sendMessage(m.chat, {
      text:
        `❌ *Error al actualizar*\n\n` +
        `╰┈➤ ${err.message || err}`,
      edit: wait.key,
    });
  }
};

handler.help = ['update'];
handler.tags = ['owner'];
handler.command = /^(update|actualizar|gitpull)$/i;
handler.owner = true;

export default handler;
      
