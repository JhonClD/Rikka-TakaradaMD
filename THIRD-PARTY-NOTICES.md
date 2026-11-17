# Avisos de terceros

Este repositorio incluye código adaptado de otros proyectos. Se conservan sus
avisos de copyright y sus licencias originales, tal como exigen.

| Archivo(s) | Procedencia | Licencia |
|---|---|---|
| `src/libraries/animev1.cjs`, `src/libraries/animev1-download.cjs` | anime1v-api — Copyright (c) 2025 Feer (FxxMorgan) | MIT (ver `src/libraries/ANIMEV1-LICENSE` y `src/libraries/ANIME1V-API-LICENSE`) |
| `src/libraries/jkanime-extractors.js` | adaptado del extractor `jkanime.service.js` de anime1v-api (ruta del proyecto original) — Copyright (c) 2025 Feer (FxxMorgan) | MIT |
| `src/libraries/store.js`, `src/libraries/simple.js` | Baileys de @Skidy89, con arreglos de @BrunoSobrino | la del fork `this-xys/bails` |
| `plugins/tool-hots.js` | Copyright (C) 2025 Weskerty | **AGPLv3** |
| `src/libraries/ookla-speedtest.py` | script de prueba de velocidad de Ookla | términos de Ookla |

## ⚠️ Licencia del propio repositorio: pendiente de decidir

Hoy no hay archivo `LICENSE` (por eso el badge de licencia del README sale
roto). El obstáculo es `plugins/tool-hots.js`, que viene de un proyecto
**AGPLv3**: es una licencia copyleft que, al distribuirse, normalmente obliga a
publicar todo el trabajo derivado bajo la misma licencia.

Opciones, de más a menos conservadora:

1. Reescribir ese plugin desde cero (o quitarlo) y licenciar el resto como MIT.
2. Licenciar todo el repositorio como AGPLv3 — compatible con las piezas MIT,
   que solo exigen conservar sus avisos.
3. Seguir sin licencia: nadie puede reutilizar el código legalmente y el badge
   del README debe borrarse.

Elijas la que elijas: añade `LICENSE` en la raíz, enlázalo desde el README y
deja esta tabla al pie para conservar los avisos de los originales.
