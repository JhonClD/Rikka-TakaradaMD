import fs, { watchFile, unwatchFile } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { loadEnv } from './src/funcion/env.js';
import { MENU_IMAGE, sessionFile } from './src/funcion/paths.js';

loadEnv();

global.botnumber = '';
global.authFile = 'RikkaSession';
global.authFilePath = sessionFile();
global.isBaileysFail = false;
global.defaultLenguaje = 'es';

global.owner = [
  ['51925092348', '👑 Propietario 👑', true, '162234554671342@lid'],
];

global.packname = 'Rikka';
global.author = '᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎';
global.wm = 'Rikka Takarada - Bot';
global.wait = '*_[ ⏳ ] Cargando..._*';

try {
  global.imagen1 = fs.readFileSync(MENU_IMAGE);
} catch {
  console.warn(chalk.yellow(`[ ⚠️ ] No se pudo leer ${MENU_IMAGE}; el bot sigue funcionando sin imagen de menú.`));
  global.imagen1 = null;
}

global.mods = [];
global.multiplier = 99;

const isDev = process.argv.includes('--dev');
if (isDev) {
  const file = fileURLToPath(import.meta.url);
  const fileUrl = pathToFileURL(file).href;
  const onChange = () => {
    unwatchFile(file, onChange);
    console.log(chalk.redBright("Update 'config.js'"));
    import(`${fileUrl}?update=${Date.now()}`).catch((error) => {
      console.error(chalk.redBright("[ ❌ ] Error al recargar 'config.js':"), error);
      watchFile(file, onChange);
    });
  };
  watchFile(file, onChange);
}
