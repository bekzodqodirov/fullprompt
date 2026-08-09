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
build → Postgres + MinIO + app + nightly backup ko'taradi → migratsiya va
ma'lumotnoma (huquqlar, rollar, sozlamalar) → manzilni chiqaradi.

**Birinchi hisobni o'zingiz yaratasiz** — demo hisoblar ataylab yaratilmaydi
(raund 83: ilgari ular productionga tushib qolar edi):

```bash
docker compose run --rm migrate pnpm create-admin +998901234567 "Ism Familiya"
```

Parol generatsiya qilinadi va **bir marta** ekranga chiqadi — yozib oling,
kirgach Profil sahifasidan almashtiring. Qolgan xodimlarni Boshqaruv →
Xodimlar sahifasidan qo'shasiz, skladlarni esa Boshqaruv → Skladlar dan.

## Telegram tinglovchisi (mijozlar bilan yozishmalar)

Servis nomi **`tg-listen`** (`tg-listener` emas) va u `telegram` profili
ortida turadi — profilsiz `docker compose logs` uni topa olmaydi.

```bash
# loglar
docker compose --profile telegram logs -f tg-listen
# qayta ishga tushirish (xabarlar «navbatda» bo'lib qotib qolsa — shu)
docker compose --profile telegram restart tg-listen
```

**«401: SESSION_REVOKED»** — Telegram akkauntning seansi tugatilgan. Restart
yordam bermaydi: saytda **Suhbatlar → Ulash** dan qayta ulash kerak (telefon →
kod). 2026-08-03 dan boshlab sistema buni o'zi taniydi, akkauntni «signed_out»
deb belgilaydi va **bot orqali** ogohlantiradi.

**«getaddrinfo EAI_AGAIN postgres»** — konteyner bazani topa olmayapti
(Docker'ning ichki DNS'i). Sayt ishlayotgan bo'lsa ham shu bo'lishi mumkin.
Yuqoridagi `restart` yetadi. 2026-08-03 dan boshlab tinglovchi bu holatni
1 daqiqadan keyin **sizning Telegramingizga («Saved Messages») o'zi yozadi**.


## Keyingi qadamlar (xohlaganda)

- **Telegram**: `.env` dagi `TELEGRAM_BOT_TOKEN` ni to'ldirib
  `docker compose up -d app` — xodimlar Profil → ✈️ orqali ulanadi.
- **HTTPS'siz rejim**: telefon kamera-skaneri ishlamaydi (brauzer talabi),
  qo'lda kiritish va HID-skaner ishlayveradi. Domen ulagach
  `DOMAIN=... docker compose --profile https up -d` yetarli.
- **Sekin ekranni topish**: postgres har bir 0,2 soniyadan uzun so'rovni
  jurnalga yozadi — `docker compose logs postgres | grep duration:`. Bo'sh
  bo'lsa baza aybdor emas; keyingi qadam — bitta ekranni ochib, o'sha
  ochilishda nechta so'rov ketganini SANASH (raund 45 shu bilan «Uchyot»
  ekranidagi 1564 ta so'rovni topgan — ularning har biri alohida tez edi).
- **Yangilash**: `git pull && docker compose up -d --build`. Migratsiyalar
  `migrate` servisi orqali o'tadi — u bir marta ishlab to'xtaydi va
  **xato bersa hech kim sezmaydi**. Yangi kod eski bazaga tushib qolsa,
  ekranlar «Something went wrong» deb chiqadi. Tekshirish va tuzatish:

  ```bash
  # oxirgi qo'llangan migratsiyalar
  docker compose exec -T postgres psql -U gsr -d gsr \
    -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
  # migratsiyani qo'lda o'tkazish (seed idempotent — zarar qilmaydi)
  docker compose run --rm migrate
  ```
- **Demo ma'lumotlar serverga TUSHMAYDI** (raund 83). `pnpm db:seed` — bu
  `migrate` servisi har deployda ishga tushiradigan skript — endi faqat
  ma'lumotnoma yozadi: huquqlar, rollar, sozlamalar, valyutalar, xarajat
  turlari, voronka bosqichlari. Demo skladlar, demo xodimlar (`demo1234`
  paroli bilan), demo mijozlar va namuna prixod **boshqa faylda**
  (`pnpm db:seed:demo`) va uni faqat test bazalari ishlatadi. Ilgari ular shu
  faylda, bitta shart ortida turardi — va o'sha shart yangi bazada bir marta
  to'g'ri bo'lgani uchun ular productionga tushib qolgan edi.
  Serverdagi eskilarini o'chirish: `docker compose run --rm migrate pnpm
  demo-users --disable`.
- **Bir martalik buyruqlar — `migrate` orqali, `app` orqali EMAS.** `app`
  obrazi ataylab yalang'och: unda `pnpm` ham, `tsx` ham, kodning o'zi ham yo'q
  (faqat yig'ilgan `server.js`). Shuning uchun `docker compose run --rm app
  pnpm ...` xato beradi — `node` obrazining kirish nuqtasi `pnpm` ni topolmay,
  uni **fayl nomi** deb node'ga uzatadi:
  `Error: Cannot find module '/app/pnpm'`. To'liq obraz — `migrate` servisi:

  ```bash
  # demo hisoblarni o'chirish (avval hisobot, keyin --disable bilan o'chirish)
  docker compose run --rm migrate pnpm demo-users
  docker compose run --rm migrate pnpm demo-users --disable

  # boshqa har qanday skript ham shu yo'l bilan
  docker compose run --rm migrate pnpm tg-doctor
  ```
- **Backup**: har kuni avtomatik (`backups` volume), haftalik restore-sinov
  app ichidagi job orqali; qo'lda tekshirish — `docker compose exec app node
  --version` emas, README'dagi restore bo'limiga qarang.
- **🗺 Xarita (haqiqiy)**: bir marta
  `docker compose --profile basemap run --rm basemap`
  (~30-80 MB OSM nusxasi `.data/basemap/` ga tushadi; Windows/Mac/Linux —
  farqi yo'q), so'ng `docker compose up -d app` — /map sahifadagi chizma
  zoom'lanadigan haqiqiy xaritaga almashadi. Faylsiz ham xarita chizma
  rejimda ishlayveradi. (Docker'siz Linux serverda muqobil:
  `bash ops/fetch-basemap.sh`.)

## Claude'ga topshirish varianti

Agar VPS'ga SSH kalitni Claude Code muhitiga (environment secrets) qo'shib
bersangiz, qolgan hamma qadamlarni Claude o'zi bajaradi va tekshiradi.

## Yangi VPS'ga ko'chirish (kattaroq serverga)

Hammasi ko'chadi: mijozlar, prixodlar, qutilar, partiyalar, pul hisobi,
fotolar, yozishmalar, qo'ng'iroq yozuvlari. Yo'qoladigan yagona narsa — siz
nusxa olayotgan paytda yozilgan ma'lumot, shuning uchun **tunda yoki dam
olish kunida** qiling.

**Domenni o'zgartirmang.** `gsrwms.uz` yangi serverga qaratilsa, haydovchi va
qo'ng'iroq ilovalari o'rnatilgan telefonlarga **umuman tegish shart emas** —
ular domen bo'yicha ulanadi (#282: ilovada manzil kompilyatsiya paytida
yoziladi, o'shanda butun park bir kunda uzilib qolgan edi).

### Ko'chiriladigan uchta narsa

| Nima | Qayerda | Qayta yaratib bo'ladimi? |
|---|---|---|
| **Baza** | `gsr_pgdata` volume | Yo'q — bu butun biznes yozuvi |
| **Fayllar** (fotolar, yozuvlar, APK) | `gsr_miniodata` volume | Yo'q |
| **`.env`** | repo ildizida, gitignored | **Yo'q, va eng xavflisi shu** |

`.env` haqida alohida: unda `TG_SESSION_KEY` bor — u menejerlarning Telegram
seansini shifrlaydi. Uni yo'qotsangiz baza joyida qolsa ham **har bir menejer
Telegramini qaytadan ulashiga** to'g'ri keladi. `GDRIVE_REFRESH_TOKEN` va
`ANTHROPIC_API_KEY` ham o'sha yerda. Avval `.env` nusxasini oling.

### ESKI serverda

```bash
cd gsr
# 1) hammani ogohlantiring, keyin yozishni to'xtating
docker compose stop app
docker compose --profile telegram stop tg-listen    # ishlatayotgan bo'lsangiz

# 2) bazaning to'liq nusxasi
docker compose exec -T postgres pg_dump -U gsr -d gsr -Fc --no-owner > gsr.dump
ls -lh gsr.dump                     # 0 BAYT BO'LMASIN — bu yagona tekshiruv

# 3) fotolar va .env
tar czf minio.tar.gz -C /var/lib/docker/volumes/gsr_miniodata/_data .
ls -lh minio.tar.gz gsr.dump .env
```

`gsr_` prefiksi compose loyihasi nomidan keladi — `docker volume ls` bilan
o'zingizdagini tekshiring.

### YANGI serverda

```bash
apt-get update && apt-get install -y git rsync
git clone https://<TOKEN>@github.com/bekzodqodirov/fullprompt.git gsr && cd gsr
```

Endi **eski `.env`, `gsr.dump`, `minio.tar.gz` ni shu papkaga ko'chiring**
(eski serverdan: `scp gsr.dump minio.tar.gz .env root@<YANGI-IP>:/root/gsr/`).

```bash
chmod 600 .env
bash ops/bootstrap.sh              # .env bor — u tegmaydi, faqat Docker + build
```

Bootstrap tugagach baza bo'sh (demo bilan) turadi. Ustiga haqiqiysini yozamiz:

```bash
# app va migrate to'xtasin, postgres bilan minio qolsin
docker compose stop app

# bazani tozalab, nusxadan tiklash
docker compose exec -T postgres psql -U gsr -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='gsr';"
docker compose exec -T postgres dropdb -U gsr gsr
docker compose exec -T postgres createdb -U gsr gsr
docker compose exec -T postgres pg_restore -U gsr -d gsr --no-owner < gsr.dump

# fotolar
docker compose stop minio
tar xzf minio.tar.gz -C /var/lib/docker/volumes/gsr_miniodata/_data
docker compose up -d
```

### Tekshirish — domenni qaratishdan OLDIN

Yangi serverning IP'si bilan `http://<YANGI-IP>:3000` ni oching va:

1. **Kirish** — o'z login/parolingiz bilan (seanslar ham ko'chgan).
2. **Mijozlar soni** — eski serverdagi bilan bir xilmi (`1692` atrofida).
3. **Prixod fotosi ochilsinmi** — bu MinIO ko'chganini isbotlaydi.
4. **Migratsiyalar soni**: `docker compose exec -T postgres psql -U gsr -d gsr
   -tAc "select count(*) from drizzle.__drizzle_migrations"` — eski serverdagi
   bilan teng bo'lsin.
5. **Pul ekrani** (`/accounting`) — jamlanmalar eskisi bilan bir xilmi.

Hammasi to'g'ri bo'lsagina domenning A-yozuvini yangi IP'ga qarating.

### Keyin

- Telegram tinglovchisi: `docker compose --profile telegram up -d`
- **Eski serverni kamida bir hafta o'chirmang.** U sizning yagona orqaga
  qaytish yo'lingiz. O'chirishdan oldin `gsr.dump` faylini o'z kompyuteringizga
  ham ko'chirib qo'ying.
- Yangi serverda fotolarni darhol **alohida diskka** joylang — pastdagi
  bo'lim. Ko'chish kuni buni qilish eng arzon payt: konteynerlar allaqachon
  to'xtagan.

## Disk — fotolarni alohida diskka ko'chirish

Round 74 da o'lchandi: **baza yiliga ~0,5 GB**, **fotolar va qo'ng'iroq
yozuvlari yiliga o'nlab GB** o'sadi. Hozir ikkovi ham bitta diskda. Disk
to'lса — postgres to'xtaydi **va** ayni o'sha daqiqada zaxira ololmay
qolasiz. Shuning uchun **qo'ng'iroq ilovasini tarqatishdan oldin** fotolarni
ikkinchi diskka ko'chiring.

Bu bir martalik ish, konteynerlar to'xtatilgan holda (flag emas: mavjud
bo'lmagan yo'lga bind qilingan volume konteynerni umuman ishga tushirmaydi,
va bu production'da yangilash kuni chiqadi — #472).

```bash
cd gsr
# 0) zaxira, har doimgidek
docker compose exec -T postgres pg_dump -U gsr -d gsr -Fc --no-owner > pre-move-$(date +%F).dump
ls -lh pre-move-*.dump          # 0 bo'lmasin

# 1) to'xtating
docker compose down             # -v EMAS, hech qachon

# 2) yangi diskni ulang va nusxa oling (misol: /mnt/data)
mkdir -p /mnt/data/minio
rsync -a /var/lib/docker/volumes/gsr_miniodata/_data/ /mnt/data/minio/
du -sh /var/lib/docker/volumes/gsr_miniodata/_data /mnt/data/minio   # hajmlar teng bo'lsin

# 3) eski volume'ni chetga suring, yangisini o'sha nom bilan yarating
docker volume rename gsr_miniodata gsr_miniodata_old
docker volume create --driver local \
  --opt type=none --opt o=bind --opt device=/mnt/data/minio gsr_miniodata

# 4) ko'taring va TEKSHIRING: bir nechta prixod fotosi ochilsin
docker compose up -d
```

Fotolar joyida ekaniga ishonch hosil qilganingizdan **keyin** eskisini
o'chiring: `docker volume rm gsr_miniodata_old`. Shoshilmang — u sizning
yagona nusxangiz.

Eslatma: `gsr_` prefiksi compose loyihasining nomidan keladi. O'zingizdagi
nomni `docker volume ls` bilan tekshiring.

## Faqat HTTPS orqali kirilsin (2026-08-09)

`docker-compose.yml` ilova uchun `3000:3000` portini ochib qo'ygan edi, ya'ni
`https://gsrwms.uz` dan tashqari xuddi shu ilova `http://<server-ip>:3000` da
ham javob berardi — HTTPS'siz, Caddy'ni aylanib o'tib. Bu olib tashlandi.

**Yangilagandan keyin tekshiring** (ilova konteyneri qayta yaratilgandan so'ng):

```
curl -sS -m 5 http://<server-ip>:3000/login   # javob BERMASLIGI kerak
curl -sSI https://gsrwms.uz/login | head -1   # 200 bo'lishi kerak
```

Agar nosozlikni tekshirish uchun port kerak bo'lsa, uni faqat serverning o'ziga
oching (`127.0.0.1:3000:3000`) va SSH tunnel orqali ulaning — hech qachon
`0.0.0.0` ga emas.
