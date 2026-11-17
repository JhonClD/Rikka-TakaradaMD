<div align="center">

# 💙 Rikka Takarada MD

### Bot multifunción para WhatsApp basado en Node.js y Baileys

<img src="./src/assets/menu.png" alt="Rikka Takarada" width="720">

<p>
  <img src="https://img.shields.io/badge/Node.js-20%2B-0ea5e9?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/WhatsApp-Baileys-2563eb?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys">
  <img src="https://img.shields.io/github/actions/workflow/status/JhonClD/Rikka-TakaradaMD/ci.yml?style=for-the-badge&label=CI" alt="Estado de la integración continua">
</p>

<p>📥 Descargas · 🧩 Plugins · 🛠️ Herramientas · 👥 Grupos · 💙 Estilo Rikka</p>

</div>

---

## 🌊 Sobre el proyecto

**Rikka Takarada MD** es un bot de WhatsApp modular. Cada función está organizada como un plugin dentro de `plugins/`, lo que permite añadir, retirar o actualizar comandos sin mezclar toda la lógica del bot.

> ℹ️ Esta documentación refleja los archivos y plugins que existen actualmente en la rama `main`. Las funciones no incluidas en esta lista todavía no forman parte de esta versión.

---

## ✨ Funciones disponibles en esta versión

### 📥 Descargadores

- ☁️ Mega — `mega`, `mg`
- 🔥 MediaFire — `mediafire`, `mf`
- 📁 Google Drive — `gdrive`, `gd`, `drive`
- 🎵 YouTube — `ytmp3`, `yta`, `ytmp4`, `ytmp3doc`, `ytmp4doc`
- ▶️ Búsqueda de YouTube — `ytsearch`, `yts`, `searchyt`
- 🎬 TikTok — `tiktok`, `ttdl`, `tiktokdl`, `tiktoknowm`, `ttnowm`, `tiktokaudio`
- 📘 Facebook — `fb`, `facebook`, `fbdl`
- 📺 Voe — `voe`, `voedl`, `voedownload`
- 𝕏 Twitter/X — `x`, `twitter`, `xdl`, `dlx`, `twdl`, `twt`, `twitterdl`
- 🎧 Play multimedia — `play`, `play2`, `mp3`, `video`, `mp4`, `playaudio`
- 🧲 Torrent / leech — `torrent`, `bt`, `tcancel`
- 🔞 Contenido Hentai — `hdl`, `hentaidl`, `hlatest`, `hentailatest`
- 📺 AnimeV1 — `animev1`, `animeinfo`, `animeep`, `animev1dl`

### 🧰 Herramientas y multimedia

- 🖼️ Stickers y herramientas de sticker — `tool-sticker.js`
- 🔗 Subir archivos o convertirlos a URL — `upload`, `uploader`, `tourl`
- 🌐 Obtener contenido HTTP — `fetch`, `get`
- 🖥️ Captura de páginas web — `ssweb`, `ssf`
- 🗜️ Compresión y procesamiento de vídeo — `compres-harsub.js`, `video-redondo.js`
- 🌍 Traducción — `translate`, `traducir`, `trad`
- ⚡ Speedtest — `speedtest`, `speed`, `stest`
- 🧾 Perfil de usuario — `perfil`, `profile`, `pf`
- 🏓 Estado del bot — `ping`, `info`, `status`, `estado`, `infobot`
- 🆔 Información JID/LID — `jid`, `lid`, `myjid`, `miid`, `infojid`
- 📦 Comprobación de dependencias — `deps`, `dependencias`, `checkdeps`

### 👥 Grupos y configuración

- 🛡️ Anti-enlaces — `antilink`, `antilink2`
- 👋 Bienvenida y despedida — `welcome`, `bienvenida`, `setwelcome`
- 👤 Promover y degradar miembros — `promote`, `promover`, `demote`, `degradar`
- 🧹 Purga de mensajes — `kickall`, `purge`
- 🔗 Unir mediante enlace — `join`, `unir`
- 🖼️ Cambiar banner — `setbanner`, `setbotbanner`
- ✏️ Cambiar nombre — `setbotname`, `setname`, `resetname`
- 📝 Cambiar prefijo — `setprefix`, `setbotprefix`

### 👑 Owner y mantenimiento

- 👑 Información del owner — `owner`, `creator`, `creador`, `propietario`
- 💎 Usuarios premium — `addprem`, `delprem`, `removeprem`, `checkprem`
- 🧰 Ejecutar comandos — `ex`, `e`
- 📦 Instalar dependencias — `npm`, `pip`, `pip3`, `pkg`, `apt`, `dep`, `sudo`, `bash`, `sh`
- 🔄 Actualizar el bot — `update`, `actualizar`, `gitpull`
- 🧪 Diagnóstico y sistema — `sysinfo`, `host`

### 🔔 Notificaciones y automatizaciones incluidas

- 📡 RSS — `rss`
- 🍿 Crunchyroll — plugins de inicio, estado y notificaciones
- 🎞️ TioAnime — plugins de inicio, estado y notificaciones
- 🏀 DBS — plugins de inicio, estado y notificaciones
- 🎬 JK — plugins de inicio, estado y notificaciones

---

## 📥 Descargadores en desarrollo

| Servicio | Estado actual |
|---|---|
| Mega | ✅ Disponible |
| MediaFire | ✅ Disponible |
| Google Drive | ✅ Disponible |
| Gofile | 🔜 Aún no incluido |
| Drime | 🔜 Aún no incluido |

---

## ⚙️ Requisitos

- **Node.js** v20 o superior (recomendado v22)
- **npm**
- **FFmpeg** y **ffprobe** disponibles en el sistema (`sticker`, `dw`, conversores)
- **ImageMagick** o **GraphicsMagick** (`convert`/`magick`/`gm`) para stickers y pósters
- **python3**, solo para `speedtest` (usa `src/libraries/ookla-speedtest.py`)
- **Git**, si quieres clonar o actualizar el repositorio

El bot comprueba esas herramientas al arrancar (`_quickTest` en `main.js`) y los
plugins que las necesitan avisan si faltan.

---

## 🚀 Instalación

```bash
git clone https://github.com/JhonClD/Rikka-TakaradaMD.git
cd Rikka-TakaradaMD
npm ci --ignore-scripts     # instala exactamente lo del lockfile
```

`--ignore-scripts` evita la descarga del Chromium de `puppeteer` (es
dependencia *opcional*, solo la usan los descargadores de AnimeV1). Si te falla
`npm ci`, usa `bash install.sh`, que además crea las carpetas de trabajo.

> 💡 `package.json` fija `baileys` a un commit concreto
> (`github:this-xys/bails#61af77a…`) para que la instalación sea reproducible.
> Para actualizar Baileys, cambia ese SHA al commit que quieras.

### Configurar `.env`

Copia la plantilla y completa solo las claves que vayas a utilizar:

```bash
cp .env.example .env
```

Las variables disponibles están documentadas en `.env.example` e incluyen las APIs de `nidl`, la configuración opcional de AnimeV1, Crunchyroll y notificaciones de TioAnime.

> 🔒 No subas claves reales al repositorio ni compartas tu archivo `.env`.

### Iniciar el bot

```bash
# Código de emparejamiento
npm run code

# Código QR
npm run qr

# Inicio normal
npm start
```

---

## 🧪 Scripts de desarrollo

```bash
npm test              # todos los tests de tests/ (node --test)
npm run lint          # ESLint (.  entero; los avisos cuentan como error)
npm run lint:fix      # correcciones automáticas
npm run check         # node --check sobre index/main/handler/config/api
npm run check:ghosts  # asignaciones a identificadores que nadie declaró
```

`npm run lint` es `eslint .` con `js.configs.recommended` y `no-unused-vars` a
nivel de **error** (sin umbral de avisos: el código heredado ya está limpio, así
que cualquier descuido nuevo rompe la integración). Se mantiene `no-undef`
apagado (el bot se apoya en globales declarados en `main.js`) y `args: 'none'`
por las firmas de callback impuestas por la API.

GitHub Actions (`.github/workflows/ci.yml`) ejecuta `npm ci`, `npm run check`,
lint y tests en Node 20 y 22 en cada PR, y falla si alguien versiona la sesión
de WhatsApp o el `.env`.

### Tests que ya cubren cosas delicadas

| Archivo | Qué protege |
|---|---|
| `tests/jkanime-extractors.test.js` | extracción de enlaces JKAnime, sin ejecutar el JS remoto |
| `tests/download-registry.test.js` | cancelación única de descargas (`download-registry.js`) |
| `tests/message-validation.test.js` | filtrado de mensajes, dedupe, texto de mensajes interactivos |
| `tests/plugins-structure.test.js` | cada plugin exporta handler, declara comando o `.all`, ningún alias lo comparten dos plugins, y los archivos se llaman en kebab-case |
| `tests/project-paths.test.js` | nada resuelve rutas contra `process.cwd()` y las imágenes del proyecto están donde dice `paths.js` |
| `tests/ghost-identifiers.test.js` | nadie asigna a un identificador no declarado (`npm run check:ghosts`) |

---

## 📁 Estructura real del proyecto

```text
Rikka-TakaradaMD/
├── index.js              # Banner, bloqueo de instancia y elección de vinculación
├── main.js               # Conexión Baileys, reconexión, carga de plugins
├── handler.js            # Despacho de comandos y eventos de grupo
├── config.js             # Configuración global (prefijo, owner, textos)
├── api.js                # Shim de globales heredado (axios/fetch/moment/cheerio)
├── eslint.config.js      # Reglas de lint
├── install.sh            # Instalador (Termux y apt)
├── .env.example          # Plantilla de variables
├── THIRD-PARTY-NOTICES.md# Avisos de código de terceros y licencia pendiente
├── .github/workflows/    # CI: lint + tests
├── scripts/              # Herramientas de desarrollo (check-ghost-identifiers)
├── tests/                # node --test
├── plugins/              # 58 plugins, un archivo por función, en kebab-case
└── src/
    ├── assets/           # Imágenes (menú, avatares, svg de bienvenida)
    ├── funcion/          # Funciones auxiliares (rutas, .env, validación, LID)
    └── libraries/        # Librerías internas (Baileys simple, store, stickers…)
```

Los nombres de archivo de `plugins/` van todos en minúsculas y con guiones
(`tiktok-dl.js`, no `Tiktok-DL.js`), y `tests/plugins-structure.test.js` lo
vigila: con nombres que solo se distinguen en mayúsculas, un checkout en
Windows/macOS puede acabar cargando el plugin equivocado.

---

## 🔌 Plugins destacados

- [`downloader-mega.js`](./plugins/downloader-mega.js)
- [`downloader-mediafire.js`](./plugins/downloader-mediafire.js)
- [`downloader-drive.js`](./plugins/downloader-drive.js)
- [`ytdl.js`](./plugins/ytdl.js)
- [`tiktok-dl.js`](./plugins/tiktok-dl.js)
- [`facebook-dl.js`](./plugins/facebook-dl.js)
- [`voe-dl.js`](./plugins/voe-dl.js)
- [`twitter-x.js`](./plugins/twitter-x.js)
- [`play.js`](./plugins/play.js)
- [`tool-sticker.js`](./plugins/tool-sticker.js)
- [`welcome.js`](./plugins/welcome.js)
- [`antilink.js`](./plugins/antilink.js)

---

## ⚙️ Flags de arranque

Se pasan después de `npm start --`, por ejemplo `npm start -- --self --autocleartmp`:

| Flag | Efecto |
|---|---|
| `qr` / `code` / `mobile` | método de vinculación (también `npm run qr`, `npm run code`) |
| `--test` | no abre sesión ni programa guardados automáticos |
| `--self` | ignora mensajes propios |
| `--pconly` / `--gconly` / `--swonly` | solo privados / solo grupos / solo estados |
| `--nyimak` | conectado y sin responder nada (útil para depurar) |
| `--restrict` | oculta los plugins marcados `admin` |
| `--autoread` / `--noprint` / `--img` / `--queque` | marcar leídos / no imprimir mensajes / menú con imagen / cola de mensajes |
| `--autocleartmp` | limpia `src/tmp` y el tmp del sistema cada 30s |
| `--dev` | recarga en caliente de `config.js` y `api.js` (los plugins se recargan siempre que cambien en disco) |

## 🔒 Seguridad

- `RikkaSession/` contiene las claves Signal de tu cuenta: está en `.gitignore`,
  no la subas ni la compartas por chat. Si alguna vez la subiste, elimina la
  sesión desde WhatsApp y vuelve a vincular.
- `npm start` bloquea una segunda instancia con un lock en `/tmp`; si el proceso
  muere de forma brusca, borra `/tmp/rikka-takarada-md.lock`.
- Los plugins `ex`/`e` ejecutan JavaScript arbitrario y `npm`, `update` ejecutan
  comandos del sistema: están limitados al owner (`handler.owner`), no añadas
  más usuarios a `global.owner` a la ligera.
- Las claves van en `.env` (se carga solo, desde la raíz del proyecto, antes de
  importar los plugins).

## 📝 Notas

- La sesión de WhatsApp se guarda en `RikkaSession/` cuando se ejecuta el bot.
- El prefijo se configura desde `config.js` o mediante el plugin de prefijo.
- `*.cancelar*` / `*.stop*` cancela **todas** tus descargas activas (Mega,
  MediaFire y Drive), o solo un servicio con `*.cancelar mediafire*`.
- Gofile y Drime quedan reservados para una próxima actualización.

---

<div align="center">

### 💙 Hecho con cariño para la comunidad de WhatsApp

<img src="./src/assets/menu.png" alt="Rikka Takarada" width="520">

</div>
