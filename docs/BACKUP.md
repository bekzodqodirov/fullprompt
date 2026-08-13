# Zaxira nusxa (backup)

Bu hujjat egasi uchun. Bir marta sozlanadi, keyin har kecha o'zi ishlaydi.

## Nima uchun

Bugungacha bazaning **hamma nusxasi bitta diskda** turgan: tungi dump o'zi
himoya qilayotgan baza bilan bir mashinada. Server yo'qolsa — baza ham, nusxasi
ham ketadi.

Endi har kecha nusxa **tashqi omborga** ham chiqadi.

## Ikkita variant bor — birinchisini tanlang

| | S3 ombor (tavsiya) | Google Drive (eski yo'l) |
|---|---|---|
| Kalit muddati | **Yo'q** | Ilova «Publish» qilinmasa **7 kunda o'ladi** |
| Sozlash | 1 ekran, 4 qator `.env` | 8 qadam, brauzer orqali token |
| Narxi | Contabo ~3 evro/oy 250 GB | 15 GB bepul |

**Ikkalasi ham to'ldirilsa S3 ishlaydi.** Bu ataylab: ikkinchisiga o'tib ketish
degani — bir kechalik nusxa hech kim qaramaydigan joyga tushishi va «ishladi»
degan yozuv bir oydan beri buzuq turgan manzilni yashirishi.

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

| | Drive'ga chiqadimi |
|---|---|
| Butun baza: mijozlar, prixodlar, qutilar, pul, hujjatlar | ✅ ha |
| **Suratlar** (prixod fotolari, qadoqlash suratlari) | ❌ **yo'q** |
| `.env` (parollar) | ❌ yo'q — ataylab |

**Suratlar hali chiqmaydi.** Ular MinIO'da turadi va hajmi ~1–1.5 GB —
bazadan yuz barobar katta. Buni alohida qilish kerak (faqat yangi
suratlarni yuborish), chunki har kecha 1.5 GB yuborilsa bepul 15 GB
Drive 10 kunda to'ladi. **Ayting — keyingi navbatda qilaman.**

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

> `--no-owner` bilan olingan dump har qanday postgres'ga tushadi — `gsr`
> roli bo'lmagan mashinaga ham.

> Dump ichida jadval huquqlari bor, lekin **`gsr_ai_reader` roli klasterga
> tegishli** va dump bilan ko'chmaydi — 4-qadam usha rolni qayta yaratadi.
> U bo'lmasa AI yordamchining tahlil (SQL) qismi ishlamaydi va buni o'zi
> halol aytadi («fence unavailable»); qolgan hamma narsa ishlayveradi.

Har yakshanba tizim o'zi **tiklash mashqi** o'tkazadi: oxirgi dump'ni
alohida bazaga tiklab, jadvallarni tekshiradi. Xato bo'lsa Telegram'ga
yozadi.
