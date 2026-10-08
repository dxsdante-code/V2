# YouTube Music Downloader V2

Versión mejorada con análisis previo, cola, progreso, descargas por lote y limpieza automática.

## Estructura

- `server.js` — API y cola de trabajos.
- `public/index.html` — interfaz.
- `public/styles.css` — estilos.
- `public/app.js` — lógica frontend.
- `render-build.sh` — instala FFmpeg y yt-dlp.
- `package.json` — dependencias.

## Deploy en Render

Si este proyecto está dentro de `v2/` del repositorio:

- Root Directory: `v2`
- Build Command: `bash render-build.sh && npm install`
- Start Command: `npm start`

Variables opcionales:

- `MAX_CONCURRENT_JOBS=2`
- `JOB_TTL_MS=900000`
- `MAX_URLS_PER_BATCH=10`

Si usas Persistent Disk en Render, configura `RENDER_FS` con el punto de montaje del disco para conservar temporalmente los archivos durante el proceso.

## API

- `GET /api/health`
- `POST /api/analyze`
- `POST /api/download`
- `POST /api/download-batch`
- `GET /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `GET /api/download/:id`

## Uso responsable

Descarga únicamente contenido que tengas derecho a descargar y respeta las condiciones de uso y derechos de autor aplicables.
