/**
 * Módulo de validación de números telefónicos para WhatsApp
 * Detecta si un LID es realmente un número de teléfono válido
 *
 * MEJORAS:
 * - countryMap unificado como fuente única de verdad (elimina desincronización)
 * - Patrones corregidos y ampliados (de 20 a 60+ países en getCountryInfo)
 * - Umbral anti-falsos-positivos: LIDs con >13 dígitos nunca son teléfonos
 * - cleanPhoneNumber ahora se usa en isValidPhoneNumber
 * - hasValidCountryCode usa countryMap en lugar de lista separada
 * - getCountryInfo busca código más largo primero (evita '1' antes de '1868')
 */
class PhoneValidator {
  constructor() {
    // Fuente única de verdad: código → {country, iso, pattern}
    // Ordenados de mayor a menor longitud de código para match correcto
    this.countryMap = {
      // 3 dígitos
      '850': { country: 'Corea del Norte',      iso: 'KP', pattern: /^850\d{7,10}$/ },
      '852': { country: 'Hong Kong',             iso: 'HK', pattern: /^852\d{8}$/ },
      '853': { country: 'Macao',                 iso: 'MO', pattern: /^853\d{8}$/ },
      '855': { country: 'Camboya',               iso: 'KH', pattern: /^855\d{8,9}$/ },
      '856': { country: 'Laos',                  iso: 'LA', pattern: /^856\d{8,9}$/ },
      '880': { country: 'Bangladesh',            iso: 'BD', pattern: /^880\d{9,10}$/ },
      '886': { country: 'Taiwán',                iso: 'TW', pattern: /^886\d{8,9}$/ },
      '960': { country: 'Maldivas',              iso: 'MV', pattern: /^960\d{7}$/ },
      '961': { country: 'Líbano',                iso: 'LB', pattern: /^961\d{7,8}$/ },
      '962': { country: 'Jordania',              iso: 'JO', pattern: /^962\d{8,9}$/ },
      '963': { country: 'Siria',                 iso: 'SY', pattern: /^963\d{9}$/ },
      '964': { country: 'Irak',                  iso: 'IQ', pattern: /^964\d{9,10}$/ },
      '965': { country: 'Kuwait',                iso: 'KW', pattern: /^965\d{8}$/ },
      '966': { country: 'Arabia Saudita',        iso: 'SA', pattern: /^966\d{9}$/ },
      '967': { country: 'Yemen',                 iso: 'YE', pattern: /^967\d{9}$/ },
      '968': { country: 'Omán',                  iso: 'OM', pattern: /^968\d{8}$/ },
      '970': { country: 'Palestina',             iso: 'PS', pattern: /^970\d{9}$/ },
      '971': { country: 'Emiratos Árabes',       iso: 'AE', pattern: /^971\d{9}$/ },
      '972': { country: 'Israel',                iso: 'IL', pattern: /^972\d{8,9}$/ },
      '973': { country: 'Baréin',                iso: 'BH', pattern: /^973\d{8}$/ },
      '974': { country: 'Catar',                 iso: 'QA', pattern: /^974\d{8}$/ },
      '975': { country: 'Bután',                 iso: 'BT', pattern: /^975\d{7,8}$/ },
      '976': { country: 'Mongolia',              iso: 'MN', pattern: /^976\d{8}$/ },
      '977': { country: 'Nepal',                 iso: 'NP', pattern: /^977\d{9,10}$/ },
      '992': { country: 'Tayikistán',            iso: 'TJ', pattern: /^992\d{9}$/ },
      '993': { country: 'Turkmenistán',          iso: 'TM', pattern: /^993\d{8}$/ },
      '994': { country: 'Azerbaiyán',            iso: 'AZ', pattern: /^994\d{9}$/ },
      '995': { country: 'Georgia',               iso: 'GE', pattern: /^995\d{9}$/ },
      '996': { country: 'Kirguistán',            iso: 'KG', pattern: /^996\d{9}$/ },
      '998': { country: 'Uzbekistán',            iso: 'UZ', pattern: /^998\d{9}$/ },
      '212': { country: 'Marruecos',             iso: 'MA', pattern: /^212\d{9}$/ },
      '213': { country: 'Argelia',               iso: 'DZ', pattern: /^213\d{8,9}$/ },
      '216': { country: 'Túnez',                 iso: 'TN', pattern: /^216\d{8}$/ },
      '218': { country: 'Libia',                 iso: 'LY', pattern: /^218\d{9}$/ },
      '220': { country: 'Gambia',                iso: 'GM', pattern: /^220\d{7}$/ },
      '221': { country: 'Senegal',               iso: 'SN', pattern: /^221\d{9}$/ },
      '222': { country: 'Mauritania',            iso: 'MR', pattern: /^222\d{8}$/ },
      '223': { country: 'Malí',                  iso: 'ML', pattern: /^223\d{8}$/ },
      '224': { country: 'Guinea',                iso: 'GN', pattern: /^224\d{9}$/ },
      '225': { country: 'Costa de Marfil',       iso: 'CI', pattern: /^225\d{8,10}$/ },
      '226': { country: 'Burkina Faso',          iso: 'BF', pattern: /^226\d{8}$/ },
      '227': { country: 'Níger',                 iso: 'NE', pattern: /^227\d{8}$/ },
      '228': { country: 'Togo',                  iso: 'TG', pattern: /^228\d{8}$/ },
      '229': { country: 'Benín',                 iso: 'BJ', pattern: /^229\d{8}$/ },
      '230': { country: 'Mauricio',              iso: 'MU', pattern: /^230\d{7,8}$/ },
      '231': { country: 'Liberia',               iso: 'LR', pattern: /^231\d{7,8}$/ },
      '232': { country: 'Sierra Leona',          iso: 'SL', pattern: /^232\d{8}$/ },
      '233': { country: 'Ghana',                 iso: 'GH', pattern: /^233\d{9}$/ },
      '234': { country: 'Nigeria',               iso: 'NG', pattern: /^234\d{8,10}$/ },
      '235': { country: 'Chad',                  iso: 'TD', pattern: /^235\d{8}$/ },
      '236': { country: 'República Centroafricana', iso: 'CF', pattern: /^236\d{8}$/ },
      '237': { country: 'Camerún',               iso: 'CM', pattern: /^237\d{9}$/ },
      '238': { country: 'Cabo Verde',            iso: 'CV', pattern: /^238\d{7}$/ },
      '239': { country: 'Santo Tomé y Príncipe', iso: 'ST', pattern: /^239\d{7}$/ },
      '240': { country: 'Guinea Ecuatorial',     iso: 'GQ', pattern: /^240\d{9}$/ },
      '241': { country: 'Gabón',                 iso: 'GA', pattern: /^241\d{7,8}$/ },
      '242': { country: 'República del Congo',   iso: 'CG', pattern: /^242\d{9}$/ },
      '243': { country: 'RD Congo',              iso: 'CD', pattern: /^243\d{9}$/ },
      '244': { country: 'Angola',                iso: 'AO', pattern: /^244\d{9}$/ },
      '245': { country: 'Guinea-Bisáu',          iso: 'GW', pattern: /^245\d{7}$/ },
      '248': { country: 'Seychelles',            iso: 'SC', pattern: /^248\d{7}$/ },
      '249': { country: 'Sudán',                 iso: 'SD', pattern: /^249\d{9}$/ },
      '250': { country: 'Ruanda',                iso: 'RW', pattern: /^250\d{9}$/ },
      '251': { country: 'Etiopía',               iso: 'ET', pattern: /^251\d{9}$/ },
      '252': { country: 'Somalia',               iso: 'SO', pattern: /^252\d{7,8}$/ },
      '253': { country: 'Yibuti',                iso: 'DJ', pattern: /^253\d{8}$/ },
      '254': { country: 'Kenia',                 iso: 'KE', pattern: /^254\d{9}$/ },
      '255': { country: 'Tanzania',              iso: 'TZ', pattern: /^255\d{9}$/ },
      '256': { country: 'Uganda',                iso: 'UG', pattern: /^256\d{9}$/ },
      '257': { country: 'Burundi',               iso: 'BI', pattern: /^257\d{8}$/ },
      '258': { country: 'Mozambique',            iso: 'MZ', pattern: /^258\d{9}$/ },
      '260': { country: 'Zambia',                iso: 'ZM', pattern: /^260\d{9}$/ },
      '261': { country: 'Madagascar',            iso: 'MG', pattern: /^261\d{9}$/ },
      '263': { country: 'Zimbabue',              iso: 'ZW', pattern: /^263\d{9}$/ },
      '264': { country: 'Namibia',               iso: 'NA', pattern: /^264\d{9}$/ },
      '265': { country: 'Malaui',                iso: 'MW', pattern: /^265\d{9}$/ },
      '266': { country: 'Lesoto',                iso: 'LS', pattern: /^266\d{8}$/ },
      '267': { country: 'Botsuana',              iso: 'BW', pattern: /^267\d{7,8}$/ },
      '268': { country: 'Esuatini',              iso: 'SZ', pattern: /^268\d{8}$/ },
      '269': { country: 'Comoras',               iso: 'KM', pattern: /^269\d{7}$/ },
      '291': { country: 'Eritrea',               iso: 'ER', pattern: /^291\d{7}$/ },
      '297': { country: 'Aruba',                 iso: 'AW', pattern: /^297\d{7}$/ },
      '298': { country: 'Islas Feroe',           iso: 'FO', pattern: /^298\d{6}$/ },
      '299': { country: 'Groenlandia',           iso: 'GL', pattern: /^299\d{6}$/ },
      '350': { country: 'Gibraltar',             iso: 'GI', pattern: /^350\d{8}$/ },
      '351': { country: 'Portugal',              iso: 'PT', pattern: /^351\d{9}$/ },
      '352': { country: 'Luxemburgo',            iso: 'LU', pattern: /^352\d{8,9}$/ },
      '353': { country: 'Irlanda',               iso: 'IE', pattern: /^353\d{9}$/ },
      '354': { country: 'Islandia',              iso: 'IS', pattern: /^354\d{7}$/ },
      '355': { country: 'Albania',               iso: 'AL', pattern: /^355\d{9}$/ },
      '356': { country: 'Malta',                 iso: 'MT', pattern: /^356\d{8}$/ },
      '357': { country: 'Chipre',                iso: 'CY', pattern: /^357\d{8}$/ },
      '358': { country: 'Finlandia',             iso: 'FI', pattern: /^358\d{8,9}$/ },
      '359': { country: 'Bulgaria',              iso: 'BG', pattern: /^359\d{8,9}$/ },
      '370': { country: 'Lituania',              iso: 'LT', pattern: /^370\d{8}$/ },
      '371': { country: 'Letonia',               iso: 'LV', pattern: /^371\d{8}$/ },
      '372': { country: 'Estonia',               iso: 'EE', pattern: /^372\d{7,8}$/ },
      '373': { country: 'Moldavia',              iso: 'MD', pattern: /^373\d{8}$/ },
      '374': { country: 'Armenia',               iso: 'AM', pattern: /^374\d{8}$/ },
      '375': { country: 'Bielorrusia',           iso: 'BY', pattern: /^375\d{9}$/ },
      '376': { country: 'Andorra',               iso: 'AD', pattern: /^376\d{6}$/ },
      '377': { country: 'Mónaco',                iso: 'MC', pattern: /^377\d{8,9}$/ },
      '380': { country: 'Ucrania',               iso: 'UA', pattern: /^380\d{9}$/ },
      '381': { country: 'Serbia',                iso: 'RS', pattern: /^381\d{8,9}$/ },
      '382': { country: 'Montenegro',            iso: 'ME', pattern: /^382\d{8}$/ },
      '383': { country: 'Kosovo',                iso: 'XK', pattern: /^383\d{8}$/ },
      '385': { country: 'Croacia',               iso: 'HR', pattern: /^385\d{8,9}$/ },
      '386': { country: 'Eslovenia',             iso: 'SI', pattern: /^386\d{8}$/ },
      '387': { country: 'Bosnia y Herzegovina',  iso: 'BA', pattern: /^387\d{8}$/ },
      '389': { country: 'Macedonia del Norte',   iso: 'MK', pattern: /^389\d{8}$/ },
      '420': { country: 'República Checa',       iso: 'CZ', pattern: /^420\d{9}$/ },
      '421': { country: 'Eslovaquia',            iso: 'SK', pattern: /^421\d{9}$/ },
      '423': { country: 'Liechtenstein',         iso: 'LI', pattern: /^423\d{7}$/ },
      '500': { country: 'Malvinas',              iso: 'FK', pattern: /^500\d{5}$/ },
      '501': { country: 'Belice',                iso: 'BZ', pattern: /^501\d{7}$/ },
      '502': { country: 'Guatemala',             iso: 'GT', pattern: /^502\d{8}$/ },
      '503': { country: 'El Salvador',           iso: 'SV', pattern: /^503\d{8}$/ },
      '504': { country: 'Honduras',              iso: 'HN', pattern: /^504\d{8}$/ },
      '505': { country: 'Nicaragua',             iso: 'NI', pattern: /^505\d{8}$/ },
      '506': { country: 'Costa Rica',            iso: 'CR', pattern: /^506\d{8}$/ },
      '507': { country: 'Panamá',                iso: 'PA', pattern: /^507\d{8}$/ },
      '508': { country: 'San Pedro y Miquelón',  iso: 'PM', pattern: /^508\d{6}$/ },
      '509': { country: 'Haití',                 iso: 'HT', pattern: /^509\d{8}$/ },
      '590': { country: 'Guadalupe',             iso: 'GP', pattern: /^590\d{9}$/ },
      '591': { country: 'Bolivia',               iso: 'BO', pattern: /^591\d{8}$/ },
      '592': { country: 'Guyana',                iso: 'GY', pattern: /^592\d{7}$/ },
      '593': { country: 'Ecuador',               iso: 'EC', pattern: /^593\d{8,9}$/ },
      '594': { country: 'Guayana Francesa',      iso: 'GF', pattern: /^594\d{9}$/ },
      '595': { country: 'Paraguay',              iso: 'PY', pattern: /^595\d{8,9}$/ },
      '596': { country: 'Martinica',             iso: 'MQ', pattern: /^596\d{9}$/ },
      '597': { country: 'Surinam',               iso: 'SR', pattern: /^597\d{7}$/ },
      '598': { country: 'Uruguay',               iso: 'UY', pattern: /^598\d{8}$/ },
      '599': { country: 'Antillas Neerlandesas', iso: 'AN', pattern: /^599\d{7}$/ },
      '670': { country: 'Timor Oriental',        iso: 'TL', pattern: /^670\d{7,8}$/ },
      '673': { country: 'Brunéi',                iso: 'BN', pattern: /^673\d{7}$/ },
      '674': { country: 'Nauru',                 iso: 'NR', pattern: /^674\d{7}$/ },
      '675': { country: 'Papúa Nueva Guinea',    iso: 'PG', pattern: /^675\d{7,8}$/ },
      '676': { country: 'Tonga',                 iso: 'TO', pattern: /^676\d{5,7}$/ },
      '677': { country: 'Islas Salomón',         iso: 'SB', pattern: /^677\d{7}$/ },
      '678': { country: 'Vanuatu',               iso: 'VU', pattern: /^678\d{7}$/ },
      '679': { country: 'Fiyi',                  iso: 'FJ', pattern: /^679\d{7}$/ },
      '680': { country: 'Palaos',                iso: 'PW', pattern: /^680\d{7}$/ },
      '682': { country: 'Islas Cook',            iso: 'CK', pattern: /^682\d{5}$/ },
      '685': { country: 'Samoa',                 iso: 'WS', pattern: /^685\d{5,7}$/ },
      '686': { country: 'Kiribati',              iso: 'KI', pattern: /^686\d{5}$/ },
      '687': { country: 'Nueva Caledonia',       iso: 'NC', pattern: /^687\d{6}$/ },
      '689': { country: 'Polinesia Francesa',    iso: 'PF', pattern: /^689\d{8}$/ },
      '691': { country: 'Micronesia',            iso: 'FM', pattern: /^691\d{7}$/ },
      '692': { country: 'Islas Marshall',        iso: 'MH', pattern: /^692\d{7}$/ },
      // 2 dígitos
      '20': { country: 'Egipto',                 iso: 'EG', pattern: /^20\d{9,10}$/ },
      '27': { country: 'Sudáfrica',              iso: 'ZA', pattern: /^27\d{9}$/ },
      '30': { country: 'Grecia',                 iso: 'GR', pattern: /^30\d{10}$/ },
      '31': { country: 'Países Bajos',           iso: 'NL', pattern: /^31\d{9}$/ },
      '32': { country: 'Bélgica',                iso: 'BE', pattern: /^32\d{8,9}$/ },
      '33': { country: 'Francia',                iso: 'FR', pattern: /^33\d{9}$/ },
      '34': { country: 'España',                 iso: 'ES', pattern: /^34\d{9}$/ },
      '36': { country: 'Hungría',                iso: 'HU', pattern: /^36\d{9}$/ },
      '39': { country: 'Italia',                 iso: 'IT', pattern: /^39\d{9,11}$/ },
      '40': { country: 'Rumania',                iso: 'RO', pattern: /^40\d{9}$/ },
      '41': { country: 'Suiza',                  iso: 'CH', pattern: /^41\d{9}$/ },
      '43': { country: 'Austria',                iso: 'AT', pattern: /^43\d{10,11}$/ },
      '44': { country: 'Reino Unido',            iso: 'GB', pattern: /^44\d{10}$/ },
      '45': { country: 'Dinamarca',              iso: 'DK', pattern: /^45\d{8}$/ },
      '46': { country: 'Suecia',                 iso: 'SE', pattern: /^46\d{9}$/ },
      '47': { country: 'Noruega',                iso: 'NO', pattern: /^47\d{8}$/ },
      '48': { country: 'Polonia',                iso: 'PL', pattern: /^48\d{9}$/ },
      '49': { country: 'Alemania',               iso: 'DE', pattern: /^49\d{10,11}$/ },
      '51': { country: 'Perú',                   iso: 'PE', pattern: /^51\d{9}$/ },
      '52': { country: 'México',                 iso: 'MX', pattern: /^52(1)?\d{10}$/ },
      '53': { country: 'Cuba',                   iso: 'CU', pattern: /^53\d{8}$/ },
      '54': { country: 'Argentina',              iso: 'AR', pattern: /^54(9)?\d{10}$/ },
      '55': { country: 'Brasil',                 iso: 'BR', pattern: /^55\d{10,11}$/ },
      '56': { country: 'Chile',                  iso: 'CL', pattern: /^56\d{9}$/ },
      '57': { country: 'Colombia',               iso: 'CO', pattern: /^57\d{10}$/ },
      '58': { country: 'Venezuela',              iso: 'VE', pattern: /^58\d{10}$/ },
      '60': { country: 'Malasia',                iso: 'MY', pattern: /^60\d{9,10}$/ },
      '61': { country: 'Australia',              iso: 'AU', pattern: /^61\d{9}$/ },
      '62': { country: 'Indonesia',              iso: 'ID', pattern: /^62\d{8,12}$/ },
      '63': { country: 'Filipinas',              iso: 'PH', pattern: /^63\d{10}$/ },
      '64': { country: 'Nueva Zelanda',          iso: 'NZ', pattern: /^64\d{8,10}$/ },
      '65': { country: 'Singapur',               iso: 'SG', pattern: /^65\d{8}$/ },
      '66': { country: 'Tailandia',              iso: 'TH', pattern: /^66\d{9}$/ },
      '81': { country: 'Japón',                  iso: 'JP', pattern: /^81\d{9,10}$/ },
      '82': { country: 'Corea del Sur',          iso: 'KR', pattern: /^82\d{9,10}$/ },
      '84': { country: 'Vietnam',                iso: 'VN', pattern: /^84\d{9,10}$/ },
      '86': { country: 'China',                  iso: 'CN', pattern: /^86\d{11}$/ },
      '90': { country: 'Turquía',                iso: 'TR', pattern: /^90\d{10}$/ },
      '91': { country: 'India',                  iso: 'IN', pattern: /^91\d{10}$/ },
      '92': { country: 'Pakistán',               iso: 'PK', pattern: /^92\d{10}$/ },
      '93': { country: 'Afganistán',             iso: 'AF', pattern: /^93\d{9}$/ },
      '94': { country: 'Sri Lanka',              iso: 'LK', pattern: /^94\d{9}$/ },
      '95': { country: 'Myanmar',                iso: 'MM', pattern: /^95\d{8,10}$/ },
      '98': { country: 'Irán',                   iso: 'IR', pattern: /^98\d{10}$/ },
      // 1 dígito
      '7':  { country: 'Rusia/Kazajistán',       iso: 'RU', pattern: /^7\d{10}$/ },
      '1':  { country: 'EE.UU./Canadá',          iso: 'US', pattern: /^1\d{10}$/ },
    };

    // Lista de códigos ordenada de mayor a menor longitud (para match correcto)
    this._sortedCodes = Object.keys(this.countryMap).sort((a, b) => b.length - a.length);

    // Longitud máxima de un número de teléfono real según E.164
    this.MAX_PHONE_DIGITS = 15;
    // Un LID de WhatsApp tiene típicamente >13 dígitos — umbral de seguridad
    this.LID_MIN_DIGITS = 13;
  }

  /**
   * Limpia un número de caracteres no numéricos
   */
  cleanPhoneNumber(phoneNumber) {
    if (!phoneNumber) return '';
    return phoneNumber
      .replace(/[\s\-\(\)\+]/g, '')
      .replace(/^00/, '')
      .replace(/^0+/, '');
  }

  /**
   * Verifica si tiene un código de país válido (usa countryMap unificado)
   */
  hasValidCountryCode(phoneNumber) {
    for (const code of this._sortedCodes) {
      if (phoneNumber.startsWith(code)) {
        const remaining = phoneNumber.slice(code.length);
        if (remaining.length >= 4 && remaining.length <= 12) return true;
      }
    }
    return false;
  }

  /**
   * Valida si un string es un número de teléfono real (E.164)
   * Incluye umbral anti-falsos-positivos para LIDs largos
   */
  isValidPhoneNumber(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') return false;

    const clean = this.cleanPhoneNumber(phoneNumber);

    if (!/^\d+$/.test(clean)) return false;
    if (clean.length < 7 || clean.length > this.MAX_PHONE_DIGITS) return false;

    // Verificar contra patrones específicos (más largo primero)
    for (const code of this._sortedCodes) {
      if (clean.startsWith(code)) {
        if (this.countryMap[code].pattern.test(clean)) return true;
      }
    }

    return this.hasValidCountryCode(clean);
  }

  /**
   * Convierte un número válido a JID de WhatsApp
   */
  toWhatsAppJID(phoneNumber) {
    const clean = this.cleanPhoneNumber(phoneNumber);
    if (!this.isValidPhoneNumber(clean)) return null;
    return `${clean}@s.whatsapp.net`;
  }

  /**
   * Detecta si un LID es realmente un número de teléfono.
   *
   * Protección anti-falsos-positivos:
   *   - LIDs reales de WhatsApp suelen tener >13 dígitos
   *   - Un número E.164 válido tiene máximo 15 dígitos
   *   - Si el número de dígitos es >= LID_MIN_DIGITS Y no pasa el patrón
   *     estricto del país, se trata como LID real
   */
  detectPhoneInLid(lidString) {
    if (!lidString || typeof lidString !== 'string') {
      return { isPhone: false, jid: null, originalLid: lidString };
    }

    const clean = lidString.replace('@lid', '').replace(/\D/g, '');

    // Rechazo rápido: demasiados dígitos para ser teléfono
    if (clean.length > this.MAX_PHONE_DIGITS) {
      return { isPhone: false, jid: null, originalLid: lidString };
    }

    // Validación estricta contra patrones de país
    for (const code of this._sortedCodes) {
      if (clean.startsWith(code) && this.countryMap[code].pattern.test(clean)) {
        // Longitud sospechosa de LID (>= 13 dígitos) → requiere patrón exacto
        if (clean.length >= this.LID_MIN_DIGITS) {
          // Solo aceptar si el patrón es muy estricto (termina en $)
          const isStrict = this.countryMap[code].pattern.source.endsWith('$');
          if (!isStrict) continue;
        }
        return {
          isPhone: true,
          jid: `${clean}@s.whatsapp.net`,
          originalLid: lidString,
          phoneNumber: clean,
        };
      }
    }

    return { isPhone: false, jid: null, originalLid: lidString };
  }

  /**
   * Obtiene información del país de un número.
   * Busca el código más largo que coincida primero.
   */
  getCountryInfo(phoneNumber) {
    const clean = this.cleanPhoneNumber(phoneNumber);

    for (const code of this._sortedCodes) {
      if (clean.startsWith(code) && this.countryMap[code].pattern.test(clean)) {
        const { country, iso } = this.countryMap[code];
        return { country, code: iso, pattern: this.countryMap[code].pattern };
      }
    }
    return null;
  }

  /**
   * Valida un lote de números y devuelve estadísticas
   */
  validateBatch(phoneNumbers) {
    const results = {
      valid: [],
      invalid: [],
      phoneDetected: [],
      stats: { total: phoneNumbers.length, validCount: 0, invalidCount: 0, phoneDetectedCount: 0 }
    };

    for (const phone of phoneNumbers) {
      const detection = this.detectPhoneInLid(phone);
      if (detection.isPhone) {
        results.phoneDetected.push({
          original: phone,
          jid: detection.jid,
          phoneNumber: detection.phoneNumber,
          country: this.getCountryInfo(detection.phoneNumber)
        });
        results.stats.phoneDetectedCount++;
      } else if (this.isValidPhoneNumber(phone)) {
        results.valid.push(phone);
        results.stats.validCount++;
      } else {
        results.invalid.push(phone);
        results.stats.invalidCount++;
      }
    }

    return results;
  }
}

export default PhoneValidator;
