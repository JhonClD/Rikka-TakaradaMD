import { patchBaileysSourceFiles } from '../src/funcion/baileys-pairing-fix.js';

const report = patchBaileysSourceFiles();
const changed = [report.socket, report.messagesRecv, report.validateConnection].some((r) => r?.changed);
if (changed) {
  console.log('[patch-baileys] Parche de vinculación por código de 8 dígitos aplicado correctamente.');
}
