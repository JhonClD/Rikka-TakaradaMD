<div align="center">

# 💙 Rikka Takarada MD

### Bot multifunción para WhatsApp basado en Node.js y Baileys

<img src="./src/menu/menu.png" alt="Rikka Takarada" width="720">

<p>
  <img src="https://img.shields.io/badge/Node.js-18%2B-0ea5e9?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/WhatsApp-Baileys-2563eb?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys">
  <img src="https://img.shields.io/github/license/JhonClD/Rikka-TakaradaMD?style=for-the-badge&color=38bdf8" alt="Licencia">
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
- 🗜️ Compresión y procesamiento de vídeo — `Compres-harsub.js`, `video-redondo.js`
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

- **Node.js** v18 o superior
- **npm**
- **FFmpeg** disponible en el sistema
- **Git**, si quieres clonar o actualizar el repositorio

---

## 🚀 Instalación

```bash
git clone https://github.com/JhonClD/Rikka-TakaradaMD.git
cd Rikka-TakaradaMD
npm install
```

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
# Revisar el código
npm run eslint

# Aplicar correcciones automáticas de ESLint
npm run eslintfix
```

---

## 📁 Estructura real del proyecto

```text
Rikka-TakaradaMD/
├── index.js              # Entrada principal
├── main.js               # Conexión y eventos
├── handler.js            # Manejador de mensajes
├── api.js                # API REST
├── config.js             # Configuración global
├── install.sh            # Instalador
├── .env.example          # Plantilla de variables
├── plugins/              # Comandos del bot
└── src/
    ├── funcion/          # Funciones auxiliares
    ├── libraries/         # Librerías internas
    ├── menu/              # Imágenes del menú
    ├── antiArab.json      # Datos de protección
    └── *.png              # Recursos gráficos
```

---

## 🔌 Plugins destacados

- [`downloader-mega.js`](./plugins/downloader-mega.js)
- [`downloader-mediafire.js`](./plugins/downloader-mediafire.js)
- [`downloader-drive.js`](./plugins/downloader-drive.js)
- [`ytdl.js`](./plugins/ytdl.js)
- [`Tiktok-DL.js`](./plugins/Tiktok-DL.js)
- [`Facebook-DL.js`](./plugins/Facebook-DL.js)
- [`twitter-x.js`](./plugins/twitter-x.js)
- [`Play.js`](./plugins/Play.js)
- [`tool-sticker.js`](./plugins/tool-sticker.js)
- [`welcome.js`](./plugins/welcome.js)
- [`antilink.js`](./plugins/antilink.js)

---

## 📝 Notas

- La sesión de WhatsApp se guarda en `RikkaSession/` cuando se ejecuta el bot.
- El prefijo se configura desde `config.js` o mediante el plugin de prefijo.
- Los mensajes de descarga de Mega, MediaFire y Drive incluyen estados editables y control de cancelación donde el plugin lo permite.
- Gofile y Drime quedan reservados para una próxima actualización.

---

<div align="center">

### 💙 Hecho con cariño para la comunidad de WhatsApp

<img src="./src/menu/menu.png" alt="Rikka Takarada" width="520">

</div>
