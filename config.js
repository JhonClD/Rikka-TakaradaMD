import {watchFile, unwatchFile} from 'fs';
import chalk from 'chalk';
import {fileURLToPath} from 'url';
import fs from 'fs';
import {loadEnv} from './src/funcion/env.js';
import {MENU_IMAGE, sessionFile} from './src/funcion/paths.js';

// Se carga antes que cualquier plugin para que process.env esté disponible.
loadEnv();

global.botnumber = "";
global.authFile = `RikkaSession`;
/** Carpeta de sesión resuelta al repositorio, no al directorio de arranque. */
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

// El menú se leía con una ruta relativa a process.cwd(): si el bot se
// arrancaba desde otro directorio, config.js lanzaba ENOENT y el proceso
// moría antes de imprimir nada.
try {
  global.imagen1 = fs.readFileSync(MENU_IMAGE);
} catch (error) {
  console.warn(chalk.yellow(`[ ⚠️ ] No se pudo leer ${MENU_IMAGE}; el bot sigue funcionando sin imagen de menú.`));
  global.imagen1 = null;
}

global.mods = [];

global.multiplier = 99;

// Recarga en caliente opcional: solo con --dev, para que un guardado
// accidental no vuelva a importar la configuración en producción.
const isDev = process.argv.includes('--dev');
const file = fileURLToPath(import.meta.url);
if (isDev) {
  watchFile(file, () => {
    unwatchFile(file);
    console.log(chalk.redBright('Update \'config.js\''));
    import(`${file}?update=${Date.now()}`);
  });
}
