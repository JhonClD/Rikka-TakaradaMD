#!/bin/bash
# install.sh - KanaArima-MD v2.0
# Instalador para Termux/Linux con Baileys actualizado

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}"
echo "╔═══════════════════════════════════╗"
echo "║     KanaArima-MD Installer v2     ║"
echo "╚═══════════════════════════════════╝"
echo -e "${NC}"

# Verificar Node.js >= 20
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 20 ]; then
  echo -e "${RED}[ ❌ ] Necesitas Node.js 20 o superior.${NC}"
  echo -e "En Termux: ${YELLOW}pkg install nodejs${NC}"
  exit 1
fi
echo -e "${GREEN}[ ✓ ] Node.js $(node -v) detectado${NC}"

# Verificar ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo -e "${YELLOW}[ ⚠️ ] FFmpeg no encontrado. Instalando...${NC}"
  if command -v pkg &>/dev/null; then
    pkg install ffmpeg -y
  elif command -v apt &>/dev/null; then
    apt install ffmpeg -y
  fi
fi

# Instalar dependencias
echo -e "${CYAN}[ ⏳ ] Instalando dependencias npm...${NC}"
npm install --legacy-peer-deps

if [ $? -ne 0 ]; then
  echo -e "${YELLOW}[ ⚠️ ] Reintentando con --force...${NC}"
  npm install --force
fi

# Crear carpetas necesarias
mkdir -p src/tmp MysticSession src/lidsresolve.json.bak
touch src/lidsresolve.json 2>/dev/null || echo "{}" > src/lidsresolve.json

echo -e "${GREEN}"
echo "╔═══════════════════════════════════╗"
echo "║  ✅ Instalación completada!       ║"
echo "║  Ejecuta: npm start               ║"
echo "╚═══════════════════════════════════╝"
echo -e "${NC}"
