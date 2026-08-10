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
  # openssl instead of tr|head: head closing the pipe SIGPIPEs tr, which
  # under `set -o pipefail` silently killed the whole script.
  gen() { openssl rand -hex "$1"; }
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
# Probed INSIDE the container, on purpose. Round 81 removed the `3000:3000`
# port mapping — it served the login form over plain HTTP straight off the
# VPS's address, outside TLS and outside the proxy — so `curl localhost:3000`
# on the HOST has answered nothing since, and this check called every healthy
# fresh install a failure. Nobody noticed for five rounds because nobody
# bootstraps a new server often; the first person to hit it was the owner,
# mid-move, on the machine where a false alarm is most expensive.
#
# `node -e` rather than curl or wget: the runner is node:22-slim, which ships
# neither, and node with a global fetch is the one thing it is guaranteed to
# have. The address is the container's OWN hostname, not 127.0.0.1: Next
# standalone binds to `process.env.HOSTNAME`, which Docker sets to the
# container id. The Dockerfile now pins HOSTNAME=0.0.0.0 so loopback works
# too, and this form is correct either way — including on an image built
# before that line existed, which is every image already deployed.
probe='fetch("http://"+require("os").hostname()+":3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
for i in $(seq 1 60); do
  if docker compose exec -T app node -e "$probe" >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && { echo "App 120 soniyada ko'tarilmadi — docker compose logs app"; exit 1; }
done

say "5/5 Tayyor"
IP=$(curl -sf -4 https://ifconfig.me || hostname -I | awk '{print $1}')
if [ -n "${DOMAIN:-}" ]; then
  echo "✅ https://${DOMAIN}  (DNS A-yozuvi shu serverga ko'rsatishi kerak: ${IP})"
else
  # No public address, and that is deliberate: the app port is not published
  # (round 81), so without a domain the only way in is an SSH tunnel. Saying
  # "open http://IP:3000" here would send the reader to a door that does not
  # answer — which is exactly how this script's own health check went wrong.
  echo "✅ Ilova ishlayapti, lekin TASHQARIDAN OCHIQ EMAS (bu ataylab)."
  echo ""
  echo "Domensiz ko'rish uchun — SSH tunnel, ikki qadam:"
  echo "  1) SHU serverda, vaqtincha faqat loopback'ga chiqaring:"
  echo "       cat > docker-compose.override.yml <<'YML'"
  echo "       services:"
  echo "         app:"
  echo "           ports: ['127.0.0.1:3000:3000']"
  echo "       YML"
  echo "       docker compose up -d app"
  echo "  2) O'Z KOMPYUTERINGIZDA:"
  echo "       ssh -L 3000:127.0.0.1:3000 root@${IP}"
  echo "     va brauzerda http://localhost:3000"
  echo ""
  echo "  Tekshirib bo'lgach o'chiring:"
  echo "       rm docker-compose.override.yml && docker compose up -d app"
fi
echo ""
echo "Endi BIRINCHI hisobni yarating (demo hisoblar ataylab yaratilmaydi):"
echo "  docker compose run --rm migrate pnpm create-admin +998901234567 \"Ism Familiya\""
echo "Parol bir marta ekranga chiqadi — yozib oling."
