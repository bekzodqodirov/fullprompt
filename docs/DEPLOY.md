# Probniy serverga chiqarish (VPS) — 10 daqiqalik yo'l

Bu hujjat egasi uchun: minimal ishtirok bilan sinov serverini ko'tarish.
Texnik tafsilotlar: [`README.md`](../README.md) (ops runbook bo'limi).

## Sizdan keraklisi (Claude buni qila olmaydi)

1. **VPS sotib olish** (~5–15 $/oy): Hetzner / Vultr / DigitalOcean.
   Region: **Гонконг yoki Singapur** — Xitoy skladlaridan VPN'siz ochilishi uchun.
   Eng kichik tarif ham yetadi (2 GB RAM tavsiya). OS: **Ubuntu 24.04**.
2. (Ixtiyoriy, kamera-skaner uchun kerak bo'ladi) **domen** — masalan
   `wms.gsr.uz` — va uning A-yozuvini server IP'siga qaratish.

## Serverda 3 ta buyruq

SSH bilan kirib (provayder "Console" tugmasi ham bo'ladi):

```bash
apt-get update && apt-get install -y git
git clone <REPO-URL> gsr && cd gsr
bash ops/bootstrap.sh                 # yoki: DOMAIN=wms.gsr.uz bash ops/bootstrap.sh
```

`<REPO-URL>` — GitHub'dagi private repo uchun token bilan:
GitHub → Settings → Developer settings → Fine-grained token (faqat shu repo,
Contents: Read) → `https://<TOKEN>@github.com/bekzodqodirov/fullprompt.git`

Skript o'zi: Docker o'rnatadi → parollarni generatsiya qilib `.env` yozadi →
build → Postgres + MinIO + app + nightly backup ko'taradi → migratsiya + demo
seed → manzilni chiqaradi.

Kirish: `+998900000001 / demo1234` (demo seed; darhol parol almashtiring).

## Keyingi qadamlar (xohlaganda)

- **Telegram**: `.env` dagi `TELEGRAM_BOT_TOKEN` ni to'ldirib
  `docker compose up -d app` — xodimlar Profil → ✈️ orqali ulanadi.
- **HTTPS'siz rejim**: telefon kamera-skaneri ishlamaydi (brauzer talabi),
  qo'lda kiritish va HID-skaner ishlayveradi. Domen ulagach
  `DOMAIN=... docker compose --profile https up -d` yetarli.
- **Yangilash**: `git pull && docker compose up -d --build` (migratsiyalar
  avtomatik o'tadi).
- **Backup**: har kuni avtomatik (`backups` volume), haftalik restore-sinov
  app ichidagi job orqali; qo'lda tekshirish — `docker compose exec app node
  --version` emas, README'dagi restore bo'limiga qarang.

## Claude'ga topshirish varianti

Agar VPS'ga SSH kalitni Claude Code muhitiga (environment secrets) qo'shib
bersangiz, qolgan hamma qadamlarni Claude o'zi bajaradi va tekshiradi.
