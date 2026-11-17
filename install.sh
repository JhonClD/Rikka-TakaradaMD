#!/bin/bash

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# Todo se resuelve contra la carpeta del script, no contra el directorio desde
# el que se ejecute (`bash /ruta/al/bot/install.sh` desde ~ funcionaba a medias).
cd "$(dirname "$(readlink -f "$0")")" || exit 1

echo -e "${CYAN}"
echo "╔═══════════════════════════════════╗"
echo "║   Rikka-TakaradaMD Installer      ║"
echo "╚═══════════════════════════════════╝"
echo -e "${NC}"

NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 20 ]; then
  echo -e "${RED}[ ❌ ] Necesitas Node.js 20 o superior.${NC}"
  echo -e "En Termux: ${YELLOW}pkg install nodejs${NC}"
  exit 1
fi
echo -e "${GREEN}[ ✓ ] Node.js $(node -v) detectado${NC}"

if ! command -v git &>/dev/null; then
  echo -e "${RED}[ ❌ ] Falta git; es necesario para la dependencia 'baileys' (repositorio de GitHub).${NC}"
  exit 1
fi

# ffmpeg/ffprobe: los plugins de multimedia los buscan en el PATH.
if ! command -v ffmpeg &>/dev/null; then
  echo -e "${YELLOW}[ ⚠️ ] FFmpeg no encontrado. Instalando...${NC}"
  if command -v pkg &>/dev/null; then
    pkg install ffmpeg -y
  elif command -v apt &>/dev/null; then
    apt install ffmpeg -y
  else
    echo -e "${YELLOW}Instálalo manualmente para que funcionen stickers y compresión.${NC}"
  fi
fi

# python3 solo lo usa el plugin speedtest.
if ! command -v python3 &>/dev/null; then
  echo -e "${YELLOW}[ ⚠️ ] python3 no está disponible: el comando speedtest no funcionará.${NC}"
fi

echo -e "${CYAN}[ ⏳ ] Instalando dependencias npm...${NC}"
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi

# Un fallo de dependencias NO se tapa con --force: si algo no encaja, mejor
# verlo. Se reintenta una vez con --legacy-peer-deps (Termux suele necesitarlo).
if [ $? -ne 0 ]; then
  echo -e "${YELLOW}[ ⚠️ ] npm ci falló; reintentando con npm install --legacy-peer-deps...${NC}"
  npm install --legacy-peer-deps --ignore-scripts || {
    echo -e "${RED}[ ❌ ] No se pudieron instalar las dependencias. Revisa el error anterior.${NC}"
    exit 1
  }
fi

mkdir -p src/tmp database temp_videos RikkaSession

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${GREEN}[ ✓ ] Creado .env desde .env.example (edítalo con tus claves).${NC}"
fi

echo -e "${GREEN}"
echo "╔═══════════════════════════════════╗"
echo "║  ✅ Instalación completada!       ║"
echo "║  Ejecuta: npm start               ║"
echo "╚═══════════════════════════════════╝"
echo -e "${NC}"
