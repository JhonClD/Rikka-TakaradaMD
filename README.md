# 🔮 Rikka Takarada—MD Bot de WhatsApp

Bot multifunción para WhatsApp basado en Node.js y Baileys.

---

## 📋 Requisitos

- Node.js v18 o superior
- npm
- ffmpeg instalado en el sistema
- Git (opcional)

---

## ⚙️ Instalación

### 1. Extraer el proyecto
Descomprime el ZIP y entra a la carpeta:
```bash
cd KanaArima-MD-clean
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables
Edita el archivo `.env` con tus datos:
```env
OWNER_NUMBER=tu_numero_sin_+     # Ej: 5491112345678
APICAUSAS_KEY=tu_key             # https://apicausas.xyz
GEMINI_KEY=tu_key                # https://aistudio.google.com (requerida para búsqueda web)
GROQ_KEY=tu_key                  # https://console.groq.com (opcional)
OPENROUTER_KEY=tu_key            # https://openrouter.ai (opcional)
COHERE_KEY=tu_key                # https://cohere.com (opcional)
HUGGINGFACE_KEY=tu_key           # https://huggingface.co (opcional)
```

También puedes editar `config.js` para personalizar:
- Nombre del bot (`wm`, `titulowm`)
- Prefijo de comandos
- Número del owner
- Zona horaria

### 4. Iniciar el bot

**Con código de emparejamiento (recomendado):**
```bash
npm run code
```

**Con QR:**
```bash
npm run qr
```

**Inicio normal:**
```bash
npm start
```

Escanea el QR o ingresa el código de emparejamiento en WhatsApp → Dispositivos vinculados.

---

## ✨ Funciones disponibles

### 📥 Descargadores
- YouTube → MP3 y MP4
- TikTok (video e imágenes)
- Instagram, Facebook, Twitter/X
- Spotify, SoundCloud
- MediaFire, Google Drive
- Threads, Pinterest
- Packs de stickers

### 🖼️ Stickers
- Crear sticker desde imagen/video/GIF
- Sticker con texto (TTP/ATTP)
- Quitar fondo al sticker
- Añadir marca de agua
- Filtros de sticker
- Círculo, dado, slap
- EmojiMix

### 🔄 Conversores
- Imagen → Sticker y viceversa
- Video → GIF con audio
- Texto → Audio (TTS)
- Imagen → PDF
- Convertir a MP3, MP4, PTT

### 🔍 Búsquedas
- Google, YouTube, Pinterest
- Anime (info, descarga)
- Manga (ZonaTMO)
- Letras de canciones
- Play Store, NPM
- Stickers, películas (Cuevana)
- TikTok, Instagram stalker

### 🛠️ Herramientas
- Traducir texto
- OCR (leer texto de imágenes)
- Clima
- Zona horaria
- Calculadora
- Acortador de links
- QR (crear y leer)
- Subir imagen/archivo a URL
- Captura de pantalla web
- Escalar imagen
- Correo temporal (Dropmail)
- Recordatorio
- Encuesta
- Leer mensajes efímeros
- Identificar música (WhatMusic)
- Piropos, frases

### 👥 Grupos
- Agregar / Expulsar miembros
- Promover / Degradar admins
- Sistema de advertencias
- Cambiar nombre, descripción, foto
- Mensaje de bienvenida y despedida
- Tagall, hidetag
- Revocar enlace
- Ver fantasmas (inactivos)
- Info del grupo
- Configuración del grupo

### 🔒 Anti-spam / Protecciones
- Anti-link
- Anti-árabe
- Anti-tóxico
- Anti-privado
- Anti-trabas
- Anti-viewonce

### 👑 Owner / Admin
- Broadcast a grupos y chats
- Gestión de usuarios premium
- Ban / Unban usuarios y chats
- Reiniciar bot
- Ejecutar comandos del sistema
- Gestión de plugins
- Agregar/quitar owners
- Limpiar temporales

### 🎲 Varios
- Memes aleatorios
- Imágenes random (anime, waifu, neko, kpop)
- Wikipedia
- Notificador de Crunchyroll y TioAnime
- RSS notifier
- Sub-bot (mipilot)
- Sistema de idiomas (español)

---

## 📁 Estructura del proyecto

```
KanaArima-MD-clean/
├── index.js          # Entrada principal
├── main.js           # Lógica de conexión
├── handler.js        # Manejador de mensajes
├── api.js            # API REST
├── config.js         # Configuración global
├── install.sh        # Script de instalación
├── .env              # Variables de entorno (APIs)
├── plugins/          # Comandos del bot
└── src/
    ├── libraries/    # Librerías internas
    ├── languages/    # Traducciones (español)
    ├── assets/       # Imágenes y fuentes
    └── JSON/         # Datos estáticos
```

---

## 📝 Notas

- La sesión se guarda en la carpeta `KanaSession/` (se crea automáticamente).
- Los archivos temporales se generan en `src/tmp/` durante el uso.
- El prefijo por defecto es `.` — se puede cambiar con el comando `setprefix`.
