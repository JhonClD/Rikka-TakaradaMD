import { execSync } from 'child_process';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const handler = async (m, { conn, text }) => {
  const reply = (msg) => conn.reply(m.chat, msg, m);

  const extraArgs = m.fromMe && text ? ' ' + text : '';

  try {
    // ── 1. ¿Hay algo que actualizar? ─────────────────────────────────────
    run('git fetch origin');
    const behind = run('git rev-list HEAD..origin/$(git rev-parse --abbrev-ref HEAD) --count');

    if (behind === '0') {
      return reply('_*< PROPIETARIO - UPDATE />*_\n\n*[ ✅ ] No hay actualizaciones pendientes.*');
    }

    // ── 2. Detectar cambios locales ───────────────────────────────────────
    const statusRaw = run('git status --porcelain');
    const hasLocalChanges = statusRaw.length > 0;

    let stashed = false;
    if (hasLocalChanges) {
      try {
        const stashOut = run('git stash push -u -m "bot-autostash"');
        stashed = !stashOut.includes('No local changes');
      } catch {
        // Si stash falla, intentamos igual
      }
    }

    // ── 3. Pull ───────────────────────────────────────────────────────────
    let pullOut = '';
    try {
      pullOut = run('git pull' + extraArgs);
    } catch (pullErr) {
      // Si el pull falló, restaurar stash y reportar
      if (stashed) {
        try { run('git stash pop'); } catch { /* ignorar */ }
      }
      return reply(
        `_*< PROPIETARIO - ACTUALIZAR />*_\n\n` +
        `*[ ❌ ] Error al hacer pull:*\n\`\`\`${pullErr.message?.slice(0, 400) || 'desconocido'}\`\`\``
      );
    }

    // ── 4. Restaurar cambios locales (stash pop) ──────────────────────────
    let popWarning = '';
    if (stashed) {
      try {
        run('git stash pop');
      } catch (popErr) {
        // Hay conflictos reales entre remote y archivos locales
        const conflicts = run('git diff --name-only --diff-filter=U').split('\n').filter(Boolean);
        run('git checkout --theirs ' + conflicts.map(f => `"${f}"`).join(' '));
        run('git add ' + conflicts.map(f => `"${f}"`).join(' '));
        run('git stash drop');
        popWarning =
          `\n\n*[ ⚠️ ] Conflictos resueltos (se usó la versión remota en):*\n` +
          conflicts.map(f => `*→ ${f}*`).join('\n');
      }
    }

    // ── 5. Respuesta de éxito ─────────────────────────────────────────────
    const stashNote = stashed
      ? '\n*[ 💾 ] Cambios locales restaurados con stash pop.*'
      : '';

    reply(
      `_*< PROPIETARIO - ACTUALIZAR />*_\n\n` +
      `*[ ✅ ] Actualización exitosa.*${stashNote}${popWarning}\n\n` +
      `\`\`\`${pullOut.slice(0, 600)}\`\`\``
    );

  } catch (err) {
    console.error('[owner-update]', err);
    reply(
      `_*< PROPIETARIO - ACTUALIZAR />*_\n\n` +
      `*[ ❌ ] Error inesperado:*\n\`\`\`${err.message?.slice(0, 400) || String(err)}\`\`\``
    );
  }
};

handler.help = ['update'];
handler.tags = ['owner'];
handler.command = /^(update|actualizar|gitpull)$/i;
handler.rowner = true;

export default handler;
