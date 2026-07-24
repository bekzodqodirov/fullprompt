#!/usr/bin/env bash
# One-shot VPS bootstrap for GSR WMS (Ubuntu 22.04/24.04, run as root).
#
#   git clone <repo-url> gsr && cd gsr && bash ops/bootstrap.sh
#
# Optional: DOMAIN=wms.example.com bash ops/bootstrap.sh
#   → also starts Caddy with automatic HTTPS (required for the phone
#     camera scanner; without a domain the app is HTTP on port 3000).
set -euo pipefail

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash ops/bootstrap.sh)"; exit 1
fi

say "1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

say "2/5 .env"
if [ ! -f .env ]; then
  gen() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
  POSTGRES_PASSWORD="$(gen 24)"
  cat > .env <<EOF
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
SESSION_SECRET=$(gen 48)
APP_URL=${DOMAIN:+https://${DOMAIN}}
S3_ACCESS_KEY=gsr
S3_SECRET_KEY=$(gen 24)
S3_BUCKET=gsr-files
STORAGE_DRIVER=s3
TELEGRAM_BOT_TOKEN=
TELEGRAM_POLLING=1
TRANSLATE_PROVIDER=libretranslate
TRANSLATE_API_URL=
TRANSLATE_API_KEY=
BACKUP_DIR=/backups
BACKUP_RETENTION_DAYS=30
DOMAIN=${DOMAIN:-}
EOF
  chmod 600 .env
  echo ".env yaratildi (parollar avtomatik). Telegram uchun TELEGRAM_BOT_TOKEN ni keyin to'ldiring."
else
  echo ".env allaqachon bor — o'zgartirilmadi."
fi

say "3/5 Build + start"
if [ -n "${DOMAIN:-}" ]; then
  docker compose --profile https up -d --build
else
  docker compose up -d --build
fi

say "4/5 Health check"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/api/health >/dev/null; then break; fi
  sleep 2
  [ "$i" = 60 ] && { echo "App 120 soniyada ko'tarilmadi — docker compose logs app"; exit 1; }
done

say "5/5 Tayyor"
IP=$(curl -sf -4 https://ifconfig.me || hostname -I | awk '{print $1}')
if [ -n "${DOMAIN:-}" ]; then
  echo "✅ https://${DOMAIN}  (DNS A-yozuvi shu serverga ko'rsatishi kerak: ${IP})"
else
  echo "✅ http://${IP}:3000  (kamera-skaner uchun keyinroq domen + HTTPS kerak bo'ladi)"
fi
echo "Kirish (demo seed): +998900000001 / demo1234 — birinchi ishdan keyin parolni almashtiring!"
