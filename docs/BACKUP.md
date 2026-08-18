# Zaxira nusxa (backup)

Bu hujjat egasi uchun. Bir marta sozlanadi, keyin har kecha o'zi ishlaydi.

## Nima uchun

Bugungacha bazaning **hamma nusxasi bitta diskda** turgan: tungi dump o'zi
himoya qilayotgan baza bilan bir mashinada. Server yo'qolsa — baza ham, nusxasi
ham ketadi.

Endi har kecha nusxa **tashqi omborga** ham chiqadi.

## Ikkita variant bor

| | Google Drive | S3 ombor (Contabo) |
|---|---|---|
| Kalit muddati | Ilova «Publish» qilinmasa **7 kunda o'ladi** | **Yo'q** |
| Sozlash | 8 qadam, brauzer orqali token | 1 ekran, 4 qator `.env` |
| Bepul hajmi | **15 GB** (Gmail va Google Photos bilan BIRGA) | yo'q, ~3 evro/oy 250 GB |
| 100 GB narxi | Google One ~2 dollar/oy | Contabo ~3 evro/oy |

**Ikkalasi ham to'ldirilsa S3 ishlaydi.** Bu ataylab: ikkinchisiga o'tib ketish
degani — bir kechalik nusxa hech kim qaramaydigan joyga tushishi va «ishladi»
degan yozuv bir oydan beri buzuq turgan manzilni yashirishi.

## ⚠️ Hajm haqida — buni oldindan biling

Baza kichkina: yiliga ~0.5 GB. **Suratlar va qo'ng'iroq yozuvlari esa yiliga
o'nlab GB.** Bepul Google Drive 15 GB va u Gmail'ingiz bilan umumiy — ya'ni
suratlarni ham Drive'ga olsangiz, bir yilga yetmasdan to'ladi.

Serveringizdagi haqiqiy raqamni ko'ring:

```bash
docker compose exec minio du -sh /data
```

- **15 GB dan kam bo'lsa** — bepul Drive hozircha yetadi.
- **Ko'p bo'lsa yoki qo'ng'iroq ilovasi tarqatilsa** — Google One 100 GB
  (~2 dollar/oy) oling, yoki S3 ga o'ting. Menga ayting, `.env` ni sozlaymiz.

Sistema **bazani suratlardan ustun qo'yadi**: Drive'da **2 GB doim baza uchun
band qilib turiladi**, suratlar unga tegmaydi. Joy tugasa suratlar to'xtaydi
va sizga Telegram'ga xabar keladi — jimgina to'xtamaydi.

---

# 1-variant: S3 ombor (Contabo) — tavsiya etiladi

## 1-qadam. Ombor yaratish

1. Contabo panelida **Object Storage** → **Create Object Storage**.
   Region: Yevropa (server ham o'sha yerda). Hajm: 250 GB yetadi.
2. Yaratilgach **S3 Object Storage** bo'limida:
   - **URL** (masalan `https://eu2.contabostorage.com`) — bu `ENDPOINT`.
   - **Access Key** va **Secret Key** — «S3 credentials» tugmasi ostida.
3. O'sha panelda **bucket** yarating, nomi masalan `gsr`.

## 2-qadam. Serverda `.env`

```
BACKUP_S3_ENDPOINT=https://eu2.contabostorage.com
BACKUP_S3_BUCKET=gsr
BACKUP_S3_KEY=<Access Key>
BACKUP_S3_SECRET=<Secret Key>
BACKUP_S3_REGION=auto
BACKUP_S3_PREFIX=gsr-backups
```

Keyin: `docker compose up -d app`

**Kalitlarni menga yubormang** — ular faqat serverdagi `.env` da turadi.

## 3-qadam. Tekshirish

Tungi nusxa soat 02:00 da (Toshkent) oladi. Kutmasdan tekshirish uchun
ertasi kuni loglarga qarang:

```
docker compose logs app | grep "offsite ok"
```

`where: "s3"`, fayl nomi va **bayt soni** ko'rinishi kerak. Bayt soni ombordan
**qaytadan so'rab** tasdiqlanadi — ya'ni yarim ketgan fayl «bo'ldi» deb
yozilmaydi, xato beradi va sizga xabar keladi.

Eskilari **30 kundan** keyin o'chiriladi (`BACKUP_RETENTION_DAYS`), va faqat
**yangisi muvaffaqiyatli tushgandan keyin** — nusxa tushmagan kechada eski
nusxa o'chirilmaydi.

---

# 2-variant: Google Drive (eski yo'l)

## ⚠️ Eng muhim qoida

**Ilovani «Publish» qilib, ANDAN KEYIN token oling.**

Google'da ilova «Testing» holatida turganda berilgan token **7 kundan keyin
o'ladi**. Soat ruxsat berilgan paytdan boshlanadi — keyin «Publish» qilsangiz
ham eski tokenni tiriltirmaydi. Backup bir hafta ishlaydi, keyin jimgina
to'xtaydi, va buni faqat tiklash kerak bo'lgan kuni bilasiz.

Shuning uchun quyidagi tartibni **buzmang**.

---

## 1-qadam. Google Cloud loyihasi

1. <https://console.cloud.google.com> ga kiring (gsr uchun ishlatadigan Gmail bilan).
2. Yuqorida **loyiha tanlash → NEW PROJECT** → nomi: `GSR Backup` → **CREATE**.

## 2-qadam. Drive API'ni yoqish

1. Chapdagi menyu → **APIs & Services → Library**.
2. Qidiruvga `Google Drive API` → ustiga bosing → **ENABLE**.

## 3-qadam. Ruxsat ekrani (Google Auth Platform)

1. Chapdagi menyu → **Google Auth Platform** → **Branding**.
2. **App name**: `GSR Backup`. **User support email**: o'zingizniki.
   **Logotip QO'YMANG** — logotip qo'yilsa Google tekshiruvga qo'yishi mumkin.
3. **Developer contact**: o'z pochtangiz → saqlang.

## 4-qadam. 🔴 PUBLISH — token olishdan OLDIN

1. **Google Auth Platform → Audience**.
2. **PUBLISH APP** tugmasini bosing → tasdiqlang.
3. Holat **«In production»** bo'lishi kerak. **«Testing» bo'lib qolmasin.**

Tekshiruv (verification) so'ralmaydi — biz eng tor ruxsatni ishlatamiz
(`drive.file`: ilova faqat **o'zi yaratgan** fayllarni ko'radi, sizning
boshqa fayllaringizga tegmaydi).

## 5-qadam. Klient yaratish

1. **Google Auth Platform → Clients → CREATE CLIENT**.
2. **Application type: Desktop app**. Nomi: `GSR server`. → **CREATE**.
3. **Client ID** va **Client secret** chiqadi — ularni yopmang, keyingi qadamda kerak.

## 6-qadam. Token olish (kompyuteringizda, bir marta)

Loyiha papkasida:

```bash
pnpm gdrive-auth
```

Skript so'raydi → Client ID va Client secret'ni qo'ying → bergan havolani
brauzerda oching → ruxsat bering → Google bergan kodni skriptga qaytaring.

Oxirida **3 qator** chiqadi.

## 7-qadam. Serverga qo'yish

O'sha 3 qatorni serverdagi `.env` fayliga qo'shing:

```bash
cd ~/gsr
nano .env          # 3 qatorni oxiriga qo'ying, saqlang (Ctrl+O, Enter, Ctrl+X)
docker compose up -d app
```

> ⚠️ Bu qatorlar **parol**. Hech kimga yubormang, menga ham. Ular faqat
> serverdagi `.env` da turadi — u git'ga tushmaydi.

## 8-qadam. Ishlayotganini tekshirish

Backup har kecha soat **02:00** (Toshkent) da ishlaydi. Kutmasdan tekshirish:

```bash
docker compose logs app --tail 100 | grep -i "backup\|offsite"
```

Ko'rinishi kerak: `db backup ok` va `offsite ok`.

Va Google Drive'ingizda **«GSR LOGISTICS backup»** papkasi paydo bo'ladi —
ichida `gsr-2026-07-27.dump` kabi fayllar.

---

## Nima saqlanadi, nima yo'q

| | Tashqi zaxiraga chiqadimi |
|---|---|
| Butun baza: mijozlar, prixodlar, qutilar, pul, hujjatlar | ✅ ha, har kecha |
| **Suratlar** (prixod fotolari, qadoqlash suratlari) | ✅ ha |
| **Qo'ng'iroq yozuvlari** | ✅ ha |
| **Telegram'dan kelgan fayl/rasm/ovoz** | ✅ ha |
| Biriktirilgan hujjatlar (hisob-faktura, dalolatnoma) | ✅ ha |
| Kichraytirilgan nusxalar (thumbnail) | ❌ ataylab — ular asl rasmdan qayta yasaladi |
| Haydovchi/qo'ng'iroq APK fayllari | ❌ ataylab — ular CI'da qayta yig'iladi |
| `.env` (parollar, kalitlar) | ❌ **yo'q — ataylab** |

### `.env` haqida alohida ogohlantirish

`.env` ni zaxiraga qo'ymayapmiz: unda bot tokeni, baza paroli va Telegram
sessiya kaliti bor, ularni Google'ga qo'yish — hammasini bitta joyga qo'yish.

**Lekin `TG_SESSION_KEY` yo'qolsa**, tiklangan bazadagi ulangan Telegram
akkauntlari ochilmaydi va menejerlar qaytadan ulanishlari kerak bo'ladi.
Shuning uchun: **`.env` ning bitta nusxasini parol menejeringizda yoki
qog'ozda saqlang.** Bu — bir martalik ish.

## Suratlar qanday ko'chadi

Har kecha **02:30** da (bazadan yarim soat keyin) alohida ish ishga tushadi:

- **Har bir fayl bir marta** ko'chadi. Nima ko'chganini baza eslab qoladi,
  shuning uchun serverni qayta ishga tushirish hech narsani buzmaydi.
- **Birinchi safar uzoq davom etadi** — o'n minglab fayl bor. Bir kechada
  hammasi emas, har kecha bir qismi ketadi va bir necha kunda tugaydi.
- Har kecha loglarda **«qolgani nechta»** yoziladi. Shu raqam kamayib
  borayotgan bo'lsa — ishlayapti.

Kutmasdan qo'lda yurgizish (birinchi safar shunday tezroq):

```bash
docker compose exec app node -e "1" >/dev/null 2>&1   # ilova tirikligini tekshirish
docker compose run --rm migrate pnpm backup-objects
```

Loglarni ko'rish:

```bash
docker compose logs app | grep "object backup"
```

> Bir-ikkita fayl «bo'lmadi» desa qo'rqmang: bu odatda bazada yozuvi bor,
> lekin fayli o'chib ketgan eski qatorlar. Ular boshqa fayllarni **to'sib
> qo'ymaydi** — qolganlari ko'chaveradi.

## Nechta nusxa saqlanadi

Drive'da oxirgi **30 tasi**. Eskisi o'chiriladi — lekin **faqat yangisi
muvaffaqiyatli yuklangandan keyin**. Yuklanmagan kechada hech narsa
o'chirilmaydi.

Serverda ham 30 kunlik nusxa qoladi (ikkita mustaqil mexanizm: biri ilova
ichida, biri alohida konteynerda — ilova o'chib qolsa ham dump olinadi).

## Xato bo'lsa nima bo'ladi

Backup yoki yuklash xato bersa — Telegram'ga xabar keladi (`admin` rolidagi
xodimlarga). Buning ishlashi uchun Profil → ✈️ orqali Telegram ulangan
bo'lishi kerak.

Eng ko'p uchraydigan xato — **token o'lgan** (`invalid_grant`). Sabab: 4-qadam
(Publish) bajarilmagan yoki tokendan keyin bajarilgan. Yechim: 4-qadamni
tekshiring, so'ng 6–7-qadamlarni qaytadan bajaring.

---

## Tiklash (restore)

Server yo'qolgan holatda:

1. Yangi serverda `docs/DEPLOY.md` bo'yicha tizimni ko'taring.
2. Google Drive'dan eng oxirgi `gsr-*.dump` faylni yuklab oling.
3. Serverga tashlang va tiklang:

```bash
# Ilovani TO'XTATING — jonli ulanishlar bilan tiklash yarim qolishi mumkin
docker compose stop app

docker compose cp gsr-2026-07-27.dump postgres:/tmp/restore.dump
docker compose exec -T postgres pg_restore -U gsr -d gsr --clean --if-exists /tmp/restore.dump

docker compose start app
```

4. **Migratsiyani qayta yuriting** (yangi klasterda bu majburiy):

```bash
docker compose run --rm migrate
```

5. **Suratlarni qaytaring** (baza tiklangandan KEYIN — fayl nomlari bazadagi
   yozuvlar bilan bog'lanadi):

```bash
docker compose run --rm migrate pnpm restore-objects --thumbs
```

`--thumbs` kichraytirilgan nusxalarni qayta yasaydi. Ular zaxirada yo'q,
chunki asl rasmdan qayta yasaladi — shuning uchun zaxira ikki barobar
kichik.

> `--no-owner` bilan olingan dump har qanday postgres'ga tushadi — `gsr`
> roli bo'lmagan mashinaga ham.

> Dump ichida jadval huquqlari bor, lekin **`gsr_ai_reader` roli klasterga
> tegishli** va dump bilan ko'chmaydi — 4-qadam usha rolni qayta yaratadi.
> U bo'lmasa AI yordamchining tahlil (SQL) qismi ishlamaydi va buni o'zi
> halol aytadi («fence unavailable»); qolgan hamma narsa ishlayveradi.

## Tiklash mashqi (fire drill)

Har yakshanba tizim oxirgi dump'ni tekshiradi. Ilova konteynerida
`pg_restore` yo'q, shuning uchun u yerda **to'liq tiklash o'tkazilmaydi** —
uning o'rniga fayl **haqiqatan pg_dump formatida ekani** va **kutilmaganda
kichrayib qolmagani** tekshiriladi (bu ikkinchisi muhim: yarim bo'sh dump
fayl sifatida mutlaqo soz ko'rinadi).

To'liq mashqni yiliga bir-ikki marta **qo'lda** o'tkazing — bu zaxirangiz
haqiqatan ishlashining yagona isboti:

```bash
docker compose cp <oxirgi dump> postgres:/tmp/drill.dump
docker compose exec postgres psql -U gsr -c "CREATE DATABASE gsr_drill"
docker compose exec postgres pg_restore -U gsr -d gsr_drill --no-owner /tmp/drill.dump
docker compose exec postgres psql -U gsr -d gsr_drill -c "select count(*) from clients"
docker compose exec postgres psql -U gsr -c "DROP DATABASE gsr_drill"
```

Oxirgi qator — **mijozlar soni**. U bugungi songa yaqin bo'lsa, zaxira soz.

## Kim dump oladi

Ikkita mustaqil mexanizm bor va ular bir papkaga yozadi:

1. **`backup` konteyneri** (postgres:16) — har kuni dump oladi. Ilova o'chib
   qolsa ham ishlaydi. **Amalda ishlaydigani shu.**
2. **Ilovaning tungi ishi** — o'zi dump olishga urinadi; ilova obrazida
   postgres asboblari yo'q, shuning uchun u **1-punktdagi dump'ni oladi** va
   tashqi omborga yuboradi.

Ya'ni: birinchisi olsa ham, olmasa ham — **ikkinchisi 26 soat ichida yangi
dump topolmasa Telegram'ga xato yozadi.** Shu bilan birinchisining jimgina
buzilib qolishi ham ko'rinadi.
