import {watchFile, unwatchFile} from 'fs';
import chalk from 'chalk';
import {fileURLToPath} from 'url';
import fs from 'fs';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import axios from 'axios';
import moment from 'moment-timezone';

// Shim de compatibilidad heredado de los bots base (GataBot/Neoxs): algunos
// plugins llaman a `fetch(...)` sin importarlo. Se mantiene, pero ya no es una
// "API REST" como decía el README: no hay servidor ni rutas aquí.
global.cheerio = cheerio;
global.fs = fs;
global.fetch = fetch;
global.axios = axios;
global.moment = moment;

// Clave del endpoint de traducción usado como respaldo por plugins/translate.js.
// Estaba hardcodeada con la clave de un tercero; ahora viene del entorno y, si
// no se define, el plugin omite el respaldo en lugar de usar una ajena.
global.lolkeysapi = process.env.LOLHUMAN_API_KEY || '';

const isDev = process.argv.includes('--dev');
const file = fileURLToPath(import.meta.url);
if (isDev) {
  watchFile(file, () => {
    unwatchFile(file);
    console.log(chalk.redBright('Update \'api.js\''));
    import(`${file}?update=${Date.now()}`);
  });
}
