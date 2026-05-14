import {watchFile, unwatchFile} from 'fs';
import chalk from 'chalk';
import {fileURLToPath} from 'url';
import fs from 'fs';

global.botnumber = "";
global.authFile = `RikkaSession`;
global.isBaileysFail = false;
global.defaultLenguaje = 'es';

global.owner = [
  ['51925092348', '👑 Propietario 👑', true],
  ['51997149670']
];

global.packname = 'Rikka';
global.author = '᭄🅜֟፝ıηͨσ‍ͥяͩυ🧸⃝꙰ཻུ⸙͎';
global.wm = 'Rikka Takarada - Bot';
global.wait = '*_[ ⏳ ] Cargando..._*';

global.imagen1 = fs.readFileSync('./src/menu/menu.png');

global.mods = [];

global.multiplier = 99;

const file = fileURLToPath(import.meta.url);
watchFile(file, () => {
  unwatchFile(file);
  console.log(chalk.redBright('Update \'config.js\''));
  import(`${file}?update=${Date.now()}`);
});
