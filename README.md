<div align="center">

# 💙 Rikka Takarada MD

### ✦ Bot multifunción para WhatsApp ✦

<img src="./src/menu/galaxiaMenu.png" alt="Rikka Takarada" width="720">

<p>
  <img src="https://img.shields.io/badge/Node.js-18%2B-0ea5e9?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Baileys-WhatsApp-2563eb?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys WhatsApp">
  <img src="https://img.shields.io/github/license/JhonClD/Rikka-TakaradaMD?style=for-the-badge&color=38bdf8" alt="Licencia">
</p>

<p><b>Descargas · Stickers · Herramientas · Administración · Entretenimiento</b></p>

</div>

---

## 🌊 Sobre el proyecto

**Rikka Takarada MD** es un bot de WhatsApp basado en **Node.js**, **Baileys** y un sistema modular de plugins. Está pensado para grupos y chats que necesitan descargas, herramientas multimedia, administración y comandos de entretenimiento desde un solo lugar.

> 💠 Código modular, comandos fáciles de ampliar y una experiencia de chat con estilo azul.

<div align="center">
  <img src="./src/avatar_contact.png" alt="Avatar de Rikka" width="420">
</div>

---

## ✨ Funciones principales

### 🔵 Descargadores

- 🎵 YouTube: MP3 y MP4
- 🎬 TikTok: vídeos e imágenes
- 📱 Instagram, Facebook y Twitter/X
- ☁️ MediaFire y Google Drive
- 💠 Mega
- 🎧 Spotify y SoundCloud
- 🖼️ Threads y Pinterest
- 🧩 Packs de stickers

### 🔷 Stickers y multimedia

- 🖼️ Crear stickers desde imagen, vídeo o GIF
- ✍️ Stickers con texto — TTP / ATTP
- ✂️ Quitar fondos y añadir marcas de agua
- 🎞️ Convertir vídeo a GIF con audio
- 🎙️ Texto a voz y conversión a MP3, MP4 o PTT
- 📄 Convertir imágenes a PDF

### 🔹 Búsquedas y herramientas

- 🔎 Google, YouTube, Pinterest y Wikipedia
- 🌸 Anime, manga, letras y películas
- 🌐 Traductor y OCR
- 🌦️ Clima y zona horaria
- 🧮 Calculadora, QR y acortador de enlaces
- 📤 Subir archivos o imágenes a una URL
- 🖥️ Captura de páginas web
- 🎼 Identificación de música
- 💬 Frases, piropos y contenido aleatorio

### 🛡️ Administración de grupos

- 👥 Agregar, expulsar, promover y degradar miembros
- ⚠️ Sistema de advertencias
- 📝 Cambiar nombre, descripción y foto del grupo
- 👋 Mensajes de bienvenida y despedida
- 📢 `tagall` e `hidetag`
- 🔗 Revocar enlaces
- ⚙️ Configuración e información del grupo

### 🔐 Protecciones

- 🚫 Anti-link
- 🛡️ Anti-spam y anti-trabas
- 🌍 Anti-árabe
- ☣️ Anti-tóxico
- 🔒 Anti-privado
- 👁️ Anti-viewonce

### 👑 Owner y administración avanzada

- 📣 Broadcast a grupos y chats
- 💎 Gestión de usuarios premium
- 🚷 Ban y unban de usuarios o chats
- 🔄 Reinicio del bot
- 🧰 Gestión de plugins
- 🧹 Limpieza de archivos temporales
- 🖥️ Ejecución de comandos del sistema

---

## 📥 Descargadores en evolución

Los descargadores actuales se encuentran en la carpeta `plugins/` y sus mensajes de progreso se irán unificando con una interfaz más limpia para el chat.

| Servicio | Plugin | Estado |
|---|---|---|
| Mega | [`downloader-mega.js`](./plugins/downloader-mega.js) | ✅ Disponible |
| MediaFire | [`downloader-mediafire.js`](./plugins/downloader-mediafire.js) | ✅ Disponible |
| Google Drive | [`downloader-drive.js`](./plugins/downloader-drive.js) | ✅ Disponible |
| Gofile | — | 🔜 Próximamente |
| Drime | — | 🔜 Próximamente |

---

## ⚙️ Requisitos

- **Node.js** v18 o superior
- **npm**
- **FFmpeg** instalado y disponible en el sistema
- **Git** — opcional, pero recomendado

---

## 🚀 Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/JhonClD/Rikka-TakaradaMD.git
cd Rikka-TakaradaMD
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Copia `.env.example` como `.env` y completa los valores necesarios:

```bash
cp .env.example .env
```

```env
OWNER_NUMBER=tu_numero_sin_+
APICAUSAS_KEY=tu_key
GEMINI_KEY=tu_key
GROQ_KEY=tu_key
OPENROUTER_KEY=tu_key
COHERE_KEY=tu_key
HUGGINGFACE_KEY=tu_key
```

> 🔒 Nunca publiques tu archivo `.env` ni compartas tus claves de API.

### 4. Iniciar el bot

**Código de emparejamiento — recomendado:**

```bash
npm run code
```

**Código QR:**

```bash
npm run qr
```

**Inicio normal:**

```bash
npm start
```

Después, vincula el bot desde **WhatsApp → Dispositivos vinculados**.

---

## 🧩 Estructura del proyecto

```text
Rikka-TakaradaMD/
├── index.js              # Entrada principal
├── main.js               # Conexión y eventos de WhatsApp
├── handler.js            # Manejador de mensajes
├── api.js                # API REST
├── config.js             # Configuración global
├── install.sh            # Instalador
├── .env.example          # Plantilla de variables
├── plugins/              # Comandos y descargadores
└── src/
    ├── funcion/          # Funciones auxiliares
    ├── libraries/         # Librerías internas
    ├── menu/              # Imágenes del menú
    ├── avatar_contact.png
    └── JSON/              # Datos estáticos
```

---

## 🧪 Comandos de desarrollo

```bash
# Revisar el código
npm run eslint

# Corregir automáticamente lo posible
npm run eslintfix
```

---

## 📝 Notas importantes

- La sesión se guarda en `RikkaSession/` y se crea automáticamente.
- Los archivos temporales se generan durante el uso del bot.
- El prefijo predeterminado es `.` y puede cambiarse con `setprefix`.
- Cada comando puede ampliarse o modificarse desde su plugin correspondiente.

---

<div align="center">

## 💙 Gracias por usar Rikka Takarada MD

<img src="./src/menu/menu.png" alt="Rikka Takarada MD" width="720">

<p>Hecho con 💙 para la comunidad de WhatsApp.</p>

</div>
