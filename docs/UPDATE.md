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

## 6. Haydovchi ilovasi (APK)

APK GitHub'da avtomatik yig'iladi — serverga hech narsa o'rnatilmaydi:
repo → **Actions** → **driver-apk** → oxirgi ✅ ish → **Artifacts** →
`GSRDriver-apk`. Batafsil: `apps/driver-android/README.md`.

> **Muhim:** har bir CI yig'ilishi APK'ni yangi kalit bilan imzolaydi, shuning
> uchun yangi versiyani eskisining **ustiga o'rnatib bo'lmaydi** (Android
> "imzo mos kelmadi" deydi). Telefonda eski GSRDriver bo'lsa: avval **o'chirib
> tashlang**, keyin yangisini o'rnating va reys kodini qaytadan kiriting.
> Ilova har reysda skladda yangi kod bilan ulanadigani uchun bu qo'shimcha ish
> emas. Ustiga-ustma yangilash kerak bo'lsa — doimiy imzo kalitini GitHub
> secret sifatida qo'shish kerak, ayting, sozlab beraman.

## 7. Xarita (ixtiyoriy, bir marta)

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

---

## Mijozlar ro'yxatini bazaga yuklash (bir martalik)

Ro'yxat repoda: `data/clients-import.tsv` (303 qator). Skript **avval faqat hisobot beradi**, hech narsa yozmaydi — bu jonli baza, xato qilsa yuk boshqa mijozga bog'lanib qolishi mumkin.

```bash
cd ~/gsr                 # yoki repo qayerda bo'lsa

# 0) Kodni yangilash. `migrate` konteyner OBRAZ ichida yuradi, ya'ni
#    skript obrazga build paytida tushadi — pull qilgach REBUILD shart,
#    aks holda "Command import-clients not found" chiqadi.
git fetch origin
git checkout claude/gsr-logistics-wms-phase1-o8h4en
git pull --ff-only
docker compose build migrate

# 1) Ko'rish: nima tushadi, nima tushmaydi (hech narsa yozilmaydi)
docker compose run --rm migrate pnpm import-clients

# 2) Yozish: mavjud kodlarga tegmaydi, faqat yo'qlarini qo'shadi
docker compose run --rm migrate pnpm import-clients --apply
```

`--update` ni faqat **ataylab** ishlating: u mavjud kartalardagi ism va telefonni fayldagisiga almashtiradi.

```bash
docker compose run --rm migrate pnpm import-clients --apply --update
```

**«Command not found» chiqsa** — obraz eski. `docker compose build migrate` ni qayta yurgizing.
**`git pull` «Already up to date» desa** — boshqa branchdasiz. `git branch --show-current` bilan tekshiring; yuqoridagi `git checkout` qatori shuni tuzatadi.

**Nima bo'ladi:**
- Telefon `+998XXXXXXXXX` ko'rinishiga keltiriladi (xitoy raqami `+86...`)
- Ismi yo'q qatorga kodning o'zi ism bo'lib qo'yiladi — keyin qo'lda tuzatasiz
- «sotuvchi» ustuni mijoz kartasidagi **«Sotuvchi»** maydoniga tushadi (CRM custom field). Sotuvchining login akkaunti bo'lsa, mijoz o'sha xodimga biriktiriladi ham; akkaunt ochilgandan keyin `--apply --update` bilan qayta yurgizsangiz bog'lanadi
- Bir xil kod ikki marta yozilgan bo'lsa — birinchisi olinadi, ikkinchisi hisobotda ko'rsatiladi
- Kirilcha kod (`аднаротка Б`) tushmaydi — kod faqat lotin harf/raqamdan iborat bo'lishi kerak, hisobotda chiqadi
