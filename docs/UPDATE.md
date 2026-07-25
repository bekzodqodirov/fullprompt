# Production yangilash (real ma'lumotlar bilan)

> Serverda ishlab turgan tizimni yangilash tartibi. Ma'lumotlar saqlanadi —
> migratsiyalar faqat yangi jadval/ustun qo'shadi, seed esa mavjud
> foydalanuvchi/klient/prixodlarga tegmaydi (parollar ham o'zgarmaydi).

## 1. Zaxira nusxa (majburiy, 20 soniya)

```bash
cd /root/gsr-erp            # loyiha papkasi
docker compose exec -T backup /backup.sh
docker compose run --rm -T backup sh -c 'ls -lh /backups | tail -3'
```

Yangi `gsr-YYYYMMDD-HHMMSS.dump` fayli ko'rinishi kerak (o'lchami 0 bo'lmasin).
Nusxani kompyuteringizga ham olib qo'ying:

```bash
docker compose cp backup:/backups ./backup-$(date +%F)
```

## 2. Yangi kodni olish

```bash
git pull
```

Chiqqan ro'yxatda `src/modules/platform/db/migrations/` ostida yangi `.sql`
fayllar bo'lsa — bu normal, ular 3-qadamda avtomatik qo'llanadi.

## 3. Yangilash

```bash
docker compose --profile https up -d --build
```

Nima bo'ladi: yangi image quriladi → `migrate` xizmati migratsiyalarni
qo'llaydi va seedni ishga tushiradi (yangi ruxsatlar shu yerda tarqaladi) →
ilova qayta ishga tushadi. Umumiy vaqt: 2-5 daqiqa, sayt shu davrda qisqa
uzilishi mumkin.

> `--profile https` — domen/HTTPS bilan ishlayotgan server uchun. Agar
> HTTPS'siz ishlatayotgan bo'lsangiz, profilsiz `docker compose up -d --build`.

## 4. Tekshirish

```bash
docker compose ps                    # hammasi Up bo'lsin, migrate = Exited (0)
docker compose logs --tail=40 app    # xatolik yo'qligiga ishonch
```

Brauzerda: saytni **Ctrl+F5** bilan oching → **Profil** sahifasi pastida
`build: ...` sanasi bugungi bo'lsin. Keyin bitta prixod va bitta partiyani
ochib ko'ring.

## 5. Demo hisoblarni yopish (bir marta)

Server birinchi marta bo'sh bazadan ko'tarilgani uchun unda demo hisoblar
(`+998900000001…011`, paroli `demo1234`) qolgan bo'lishi mumkin. Ularni
tekshirish va yopish:

```bash
docker compose run --rm migrate pnpm demo-users            # faqat ro'yxat
docker compose run --rm migrate pnpm demo-users --disable  # yopish
```

Skript **paroli o'zgartirilgan** hisoblarga tegmaydi (ular ishlatilyapti
degani) va oxirgi faol super-adminni ham qoldiradi — o'sha hisobning
parolini saytdan o'zgartirib qo'ying. Yopilgan hisob kira olmaydi, ochiq
sessiyalari ham uziladi.

> Yangi versiyada seed demo hisoblarni **faqat bo'sh bazaga** yozadi, shuning
> uchun yopgan/o'chirgan hisoblaringiz keyingi yangilanishlarda qaytmaydi.

## 6. Xarita (ixtiyoriy, bir marta)

```bash
docker compose --profile basemap run --rm basemap
docker compose up -d app
```

## Agar biror narsa buzilsa

Avvalgi ishlaydigan holatga qaytish (kod):

```bash
git log --oneline -5                 # ishlagan commit'ni toping
git checkout <commit>
docker compose --profile https up -d --build
```

Ma'lumotni tiklash (faqat kerak bo'lsa — bu amal joriy bazani almashtiradi;
avval yangi dump oling):

```bash
docker compose cp backup:/backups/gsr-YYYYMMDD-HHMMSS.dump ./restore.dump
docker compose cp ./restore.dump postgres:/tmp/restore.dump
docker compose exec -T postgres pg_restore -U gsr -d gsr --clean --if-exists /tmp/restore.dump
docker compose restart app
```

## Nima uchun xavfsiz

- **Migratsiyalar** faqat qo'shadi: `CREATE TABLE` / `ADD COLUMN`. Hech qanday
  `DROP`/`DELETE`/ma'lumot ko'chirish yo'q.
- **Seed** har safar ishlaydi, lekin: mavjud telefon raqamli foydalanuvchi
  qayta yaratilmaydi va **paroli o'zgarmaydi**; mavjud klient/sklad kodlari
  `onConflictDoNothing` bilan o'tkazib yuboriladi; namunaviy GS777 prixodi
  allaqachon bor bo'lsa umuman yaratilmaydi. Seed'ning asosiy foydasi —
  yangi ruxsatlar (masalan `finance.manage`) rollarga tarqalishi.
- **Fayllar/rasmlar** MinIO volume'ida qoladi, image qayta qurilishi ularga
  tegmaydi.
