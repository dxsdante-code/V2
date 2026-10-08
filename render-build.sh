#!/usr/bin/env bash
set -e

echo "📦 Instalando FFmpeg y yt-dlp..."
apt-get update
apt-get install -y python3-pip ffmpeg
python3 -m pip install --upgrade yt-dlp

echo "🔎 Verificando herramientas..."
yt-dlp --version
ffmpeg -version | head -1
echo "✅ Build V2 completado"
