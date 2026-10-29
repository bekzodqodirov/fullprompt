# Production yangilash (real ma'lumotlar bilan)

> Serverda ishlab turgan tizimni yangilash tartibi. Ma'lumotlar saqlanadi —
> migratsiyalar faqat yangi jadval/ustun qo'shadi, seed esa mavjud
> foydalanuvchi/klient/prixodlarga tegmaydi (parollar ham o'zgarmaydi).

## 1. Zaxira nusxa (majburiy, 20 soniya)

```bash
cd ~/gsr                    # loyiha papkasi
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
docker compose build migrate
docker compose --profile https up -d --build
```

Birinchi qator kodni bir marta quradi, ikkinchisi o'sha natijani qayta
ishlatadi — og'ir qurish serverda faqat bir marta yuradi. 2026-09-29 dagi
deploy qurish paytida xotira yetmay to'xtagan edi (DECISIONS #1223).

> **Qurish «Corepack is about to download … registry.npmjs.org …» va
> `ConnectTimeoutError` bilan to'xtasa** — server npm saytiga ulana olmayapti.
> Sayt bu paytda eski versiyada ishlab turadi: yangi versiya qurilmaguncha
> hech bir konteyner almashtirilmaydi. 2026-09-29 dan boshlab faqat kod
> o'zgargan yangilanish npm'ga murojaat qilmaydi (DECISIONS #1228). npm
> faqat quyidagi hollarda kerak bo'ladi: `package.json` o'zgargan bo'lsa
> (yangi buyruq qo'shilgani ham hisob), `pnpm-lock.yaml` o'zgargan bo'lsa,
> Docker Hub'da `node:22-slim` yangilangan bo'lsa yoki build keshi
> tozalangan bo'lsa. Unda ulanishni tekshiring va bir necha daqiqadan keyin
> qayta urining:
> `curl -sS -m 15 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/`
> → `200` chiqsa, qurishni qaytaring.

Nima bo'ladi: yangi image quriladi → `migrate` xizmati migratsiyalarni
qo'llaydi va seedni ishga tushiradi (yangi ruxsatlar shu yerda tarqaladi) →
ilova qayta ishga tushadi. Umumiy vaqt: 2-5 daqiqa, sayt shu davrda qisqa
uzilishi mumkin.

> `--profile https` — domen/HTTPS bilan ishlayotgan server uchun. Agar
> HTTPS'siz ishlatayotgan bo'lsangiz, profilsiz `docker compose up -d --build`.

## 4. Tekshirish

```bash
# 1) MIGRATSIYALAR QO'LLANDIMI — buni birinchi sanang. Yarim qo'llangan
#    deployda ilova ko'tariladi, lekin mijoz kitobi, ostatka va /o/<kod>
#    xato sahifasini ko'rsatadi (52-raund).
docker compose exec -T postgres psql -U gsr -d gsr \
  -tAc "select count(*) from drizzle.__drizzle_migrations"
#    ==> repodagi migratsiya fayllari soniga TENG bo'lishi shart:
#        ls src/modules/platform/db/migrations/*.sql | wc -l
#    Kam chiqsa: docker compose run --rm migrate  (va CHIQISHINI o'qing)

# 2) `ps` emas, `ps -a` — `migrate` ishini tugatib chiqib ketgan, shuning
#    uchun oddiy `ps` da ko'rinmaydi va xatosi ham ko'rinmaydi.
docker compose ps -a                 # hammasi Up, migrate = Exited (0)
docker compose logs --tail=40 app    # xatolik yo'qligiga ishonch

# 3) Yangi kod chindan ketdimi. Migratsiyasiz raundda sanash hech nimani
#    tekshirmaydi (to'rtinchi deploy tuzog'i) — build vaqtini o'qing.
curl -s https://gsrwms.uz/api/version; echo
```

> `tg-listen` (Telegram ko'prigi) `telegram` profilida, shuning uchun
> `--profile https up -d --build` unga TEGMAYDI — u eski image bilan ishlab
> turadi. Kod o'zgargan raundda uni ham yangilang:
> `docker compose --profile telegram up -d --build tg-listen`, keyin bir
> daqiqa `docker compose --profile telegram logs -f tg-listen`.

Brauzerda: saytni **Ctrl+F5** bilan oching → **Profil** sahifasi pastida
`build: ...` sanasi bugungi bo'lsin. Keyin bitta prixod va bitta partiyani
ochib ko'ring.

### Balans hisoboti (Balansni ochishdan OLDIN)

Balansda «Narxi hali yozilmagan yukka sarflangan» qatori paydo bo'lgan
deploydan keyin (U03) — Balansni ochishdan oldin shu buyruqni yurgizing va
chiqqan matnni chatga tashlang:

```bash
docker compose run --rm migrate pnpm balans-hisobot
```

U faqat o'qiydi — bazaga hech narsa yozmaydi (har bir ulanish «read only»
rejimida ochiladi). Balansning har bir qatorini, yangi qatorning hisobini
ikkala qoida bo'yicha (kartadagi narx), topshirishdagi taqiqdan oldin
narxsiz topshirilgan yukni va qatorga kirmagan hamma narsani chiqaradi.
Bir necha qator bir kunda o'zgaradi — shu hisobot bilan har bir qatorning
raqamini oldindan bilasiz.

### Zavod reysi tekshiruvi (0133 — «zavod reysi yopiladi»)

Shu raunddan keyin zavod reysi yopiladi va prixod qaysi qatorni qabul
qilganini eslab qoladi (`docs/ZAVOD-YOPISH.md`). Eski ekranlar nima qoldirib
ketganini faqat sizning bazangiz biladi — shuning uchun:

1. **Migratsiyalar 134 bo'lishi shart** (yuqoridagi sanash). Kam chiqsa —
   davom etmang, avval `docker compose run --rm migrate` va uning chiqishini
   o'qing.
2. **Tekshiruvni yurgizing** — faqat o'qiydi, bazaga hech narsa yozmaydi
   (ulanish «read only» rejimida ochiladi):

   ```bash
   docker compose run --rm migrate pnpm exec tsx scripts/zavod-tekshir.ts
   ```

   Chiqqan matnni to'liq chatga tashlang. Besh ro'yxat:
   1. bitta qatorni bir nechta tirik prixod qabul qilgan — yuk ikki marta
      qabul qilingan bo'lishi mumkin;
   2. ochiq reyslardagi qabul qilinmagan qatorlar (logist qabul qiladi yoki
      «Reysni yopish» bilan sababini yozib yopadi), yonida — skladda ALLAQACHON
      turgan, reysga bog'lanmagan prixodlar: «biriktiring, qayta qabul
      qilmang»;
   3. reysga bog'langan, lekin hech bir qatorga javob bermaydigan prixodlar;
   4. **ehtimol**: qabul qilingan qator egasining shu skladdagi, reysga
      bog'lanmagan prixodi — zavoddan olingandan keyingi 21 kun ichida, reys
      orqali qabul qilinishidan OLDIN ham, KEYIN ham. Eski ekranda eng ko'p
      uchragan ikki marta qabul aynan shu: yuk avval oddiy prixod bilan
      qabul qilingan, reys esa ro'yxatda qolgan va yana «Qabul qilish»
      bosilgan. Har satrda zavod/haydovchi sanog'i va ikkala prixodning
      karobka soni — egizakmi yoki alohida yukmi, odam hal qiladi;
   5. yopilgan reys: xarajat bor, tirik prixod yo'q — pul hech bir karobkaga
      tushmagan (yuksiz qo'lda yopilgan reys yoki deploydan oldingi holat;
      endi yopilgan reysning yagona prixodini bekor qilish yoki reysdan
      ajratish rad etiladi).

   **Bu besh ro'yxat egasiga o'qib berilmaguncha hech kim «tuzatildi»
   demaydi.** Skript hech narsani o'zi hal qilmaydi: ikki prixoddan qaysi biri
   haqiqiysini faqat odam biladi.
3. **Deploy oynasi — bir marta, deploydan darhol keyin.** Migratsiya yurgan
   daqiqalarda sayt hali ESKI kodda ishlaydi; o'sha paytda reysga bog'langan
   prixod qaysi qatorni qabul qilganini eslab qolmagan bo'ladi. U 3-ro'yxatda
   «egasining qatori hali ochiq — bog‘lanish eslab qolinmagan» deb chiqadi.
   Shunday prixod chiqsa, quyidagini **bir marta** yurgizing — u migratsiyaning
   o'z eslab qolish qadamini faqat eslab qolinmagan TIRIK bog'langan
   prixodlar uchun qaytaradi, keyin hamma qatori qabul qilingan reyslarni
   yopadi (ikkalasi ham qayta yurgizilsa hech narsa o'zgarmaydi):

   ```bash
   docker compose exec -T postgres psql -U gsr -d gsr -v ON_ERROR_STOP=1 <<'SQL'
   BEGIN;
   -- ZAVOD-HEAL-MEMORY-BEGIN
   INSERT INTO "pickup_line_receipts" ("line_id", "receipt_id", "created_at")
   SELECT pl."id", r."id", coalesce(r."confirmed_at", r."created_at")
     FROM "receipts" r
     JOIN "pickup_lines" pl ON pl."stop_id" = r."pickup_stop_id"
    WHERE r."pickup_stop_id" IS NOT NULL
      AND r."voided_at" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "pickup_line_receipts" had WHERE had."receipt_id" = r."id")
      AND CASE WHEN EXISTS (SELECT 1 FROM "pickup_lines" ml
                             WHERE ml."stop_id" = pl."stop_id" AND ml."client_id" IS NULL
                               AND btrim(coalesce(ml."marking", '')) <> ''
                               AND lower(btrim(ml."marking")) = lower(btrim(r."unclaimed_marking")))
               THEN pl."client_id" IS NULL
                    AND lower(btrim(coalesce(pl."marking", ''))) = lower(btrim(r."unclaimed_marking"))
               ELSE pl."client_id" IS NOT NULL AND pl."client_id" = r."client_id"
          END
   ON CONFLICT DO NOTHING;
   -- ZAVOD-HEAL-MEMORY-END
   -- ZAVOD-HEAL-CLOSE-BEGIN
   WITH "closing" AS (
     SELECT p."id", p."status" AS "was", p."dest_warehouse_id",
            (SELECT max(coalesce(r."confirmed_at", r."created_at"))
               FROM "pickup_stops" ps
               JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
               JOIN "pickup_line_receipts" plr ON plr."line_id" = pl."id"
               JOIN "receipts" r ON r."id" = plr."receipt_id" AND r."voided_at" IS NULL
              WHERE ps."pickup_id" = p."id") AS "at"
       FROM "pickups" p
      WHERE p."status" IN ('planned', 'on_road', 'arrived')
        AND EXISTS (
          SELECT 1 FROM "pickup_stops" ps
            JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
           WHERE ps."pickup_id" = p."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "pickup_stops" ps
            JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
           WHERE ps."pickup_id" = p."id"
             AND NOT EXISTS (
               SELECT 1 FROM "pickup_line_receipts" plr
                 JOIN "receipts" r ON r."id" = plr."receipt_id" AND r."voided_at" IS NULL
                WHERE plr."line_id" = pl."id"
             )
        )
   ), "closed" AS (
     UPDATE "pickups" p
        SET "status" = 'closed',
            "close_kind" = 'auto',
            "closed_at" = c."at",
            "updated_at" = now()
       FROM "closing" c
      WHERE p."id" = c."id"
     RETURNING p."id", c."was", p."dest_warehouse_id"
   )
   INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "before", "after", "warehouse_id")
   SELECT 'pickup', c."id", 'status_change',
          jsonb_build_object('status', c."was"),
          jsonb_build_object('status', 'closed', 'closeKind', 'auto', 'backfill', true),
          c."dest_warehouse_id"
     FROM "closed" c;
   -- ZAVOD-HEAL-CLOSE-END
   COMMIT;
   SQL
   ```

   `INSERT 0 N` qatorlarini o'qing: birinchisi — nechta qator eslab qolindi,
   ikkinchisi — nechta reys yopildi. Keyin 2-qadamdagi tekshiruvni **qayta**
   yurgizing: o'sha prixodlar 3-ro'yxatdan chiqishi kerak; agar u ikkinchi
   qabul bo'lsa, endi 1-ro'yxatda ko'rinadi.

   **Faqat deploydan darhol keyin, logistlar kartadan prixod bog'lashni
   boshlamasidan oldin.** Yangi kod ham ba'zan qatorsiz bog'laydi (bir egada
   ikkita ochiq qator bo'lsa, qaysi biri kelganini odam tanlaydi) — keyinroq
   yurgizilsa, bu buyruq o'sha joyda odam o'rniga taxmin qiladi.

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

## Yo‘lkira: bitta jadval va har bir lot (2026-10-15) — tekshiruv tartibi

Bu raundning o‘zida migratsiya yo‘q — u yuqoridagi «zavod reysi yopiladi»
raundining 0133 si bilan bitta deployda chiqadi. **Va 2026-10-14 dagi deploy (PR #120,
migratsiya 0132) qilinmagan bo‘lsa, shu deploy uni ham olib keladi** — shuning
uchun tekshiruv ikkalasi: migratsiyalar soni VA build vaqti (yuqoridagi §4
tartibida).

1. Zaxira (§1) — hajmi 0 emasligini tekshiring.
2. `git pull`, keyin avval `docker compose build migrate`, so‘ng
   `docker compose --profile https up -d --build`.
3. **Sonni o‘qing** — repo’dagi fayllar soniga teng bo‘lishi kerak
   (`ls src/modules/platform/db/migrations/*.sql | wc -l`, bu raundda
   **134**), #120 avval deploy qilingan bo‘lsa ham, qilinmagan bo‘lsa ham:

   ```bash
   docker compose exec -T postgres psql -U gsr -d gsr -tAc \
     "SELECT count(*) FROM drizzle.__drizzle_migrations"
   ```

   134 dan kam chiqsa — `docker compose run --rm migrate` ning o‘z chiqishini
   o‘qing va `docker compose ps -a` da `migrate` = `Exited (0)` ekanini
   tekshiring. Kam son bilan qoldirilsa, yangi kod eski bazada ishlaydi va
   har bir mashinada «server yangilanmagan» chiqadi.
4. **Build vaqtini o‘qing**: `curl -s https://gsrwms.uz/api/version` —
   bugungi vaqt chiqishi kerak.
5. **Faqat shundan keyin** — bir martalik qayta bo‘lish ro‘yxati. U
   **faqat o‘qiydi** va faqat lot bo‘yicha bo‘linganda o‘zgaradigan
   hisoblarni ko‘rsatadi (yangi kod saqlagan hisoblar o‘zgarmaydi, ular
   ro‘yxatga tushmaydi):

   ```bash
   docker compose run --rm migrate pnpm exec tsx scripts/freight-resplit.ts
   ```

   **«0 ta hisob o‘zgaradi» chiqsa — hech narsa qilinmaydi** (kutilgani shu:
   0132 da skladlarga ustun yozilmagan edi). Ro‘yxat chiqsa — bir marta lot
   bo‘yicha qayta bo‘ling (summa, kurs, kassa, kontragent qarzi, saqlangan
   tarif nusxasi o‘zgarmaydi; eski «Qashqar» ustunida saqlangan hisob o‘z
   ustunida qoladi va faqat lot bo‘yicha bo‘linadi):

   ```bash
   docker compose run --rm migrate pnpm exec tsx scripts/freight-resplit.ts --apply
   ```

   `--apply` dan keyin skript bazada AYNAN yozilganini o‘qib chiqaradi;
   «⚠ changed since the list was read» chiqsa — ro‘yxatni qayta oling.
   Ro‘yxatda `HELD (GS…-B)` degan qator bo‘lsa — o‘sha lot 1 kubga 10 kg dan
   yengil yoki kub/kg yozilmagan: lot prixod kartasida to‘g‘rilanmaguncha bu
   mashinaning yo‘lkirasi hech kimning tannarxiga tushmaydi (⚠ bilan ko‘rinib
   turadi). Lotni to‘g‘rilang — hisob o‘zi bo‘linadi.
6. **/admin/tarif ni oching** — tepada ⚠ bo‘lmasligi kerak. ⚠ chiqsa,
   «Yiwu / Guangzhou → Toshkent» ustunida teshik yoki ikki qatorga tushgan
   zichlik bor: shu holatda yo‘lkira hech bir mashinada tarif bo‘yicha
   bo‘linmaydi, ⚠ qaysi sanadan va qaysi zichlik ekanini aytadi.

`package.json` buyrug‘i qilinmagani ataylab: `package.json` o‘zgarsa image
qurilishi npm saytiga ulanadi (DECISIONS #1228).

## Jamoa guruhi (2026-10-20, 0134) — tekshiruv tartibi

Bu raundda migratsiya bor: **0134** — deploydan keyin son **135** bo‘ladi.
Yuqoridagi «134 bo‘lishi shart» qatorlari o‘z raundlari uchun yozilgan; bu
deploydan keyin to‘g‘ri son — repo’dagi fayllar soni
(`ls src/modules/platform/db/migrations/*.sql | wc -l`, ya’ni **135**).

1. Zaxira (§1) — hajmi 0 emasligini tekshiring.
2. `git pull`, keyin avval `docker compose build migrate`, so‘ng
   `docker compose --profile https --profile telegram up -d --build`
   (bot app ichida ishlaydi — u ham qayta quriladi).
3. Sonni o‘qing — **135**. Kam chiqsa, `docker compose run --rm migrate` ning
   o‘z chiqishini o‘qing.
4. `curl -s https://gsrwms.uz/api/version` — bugungi vaqt.
5. Telegramda botni hodimlar guruhiga **o‘zingiz** qo‘shing, keyin Boshqaruv →
   «Jamoa guruhi» → «Sinov xabari». Guruhda xabar chiqmasa, sahifadagi
   xabarlar ro‘yxatidagi xatoni o‘qing va
   `docker compose logs --since 10m app | grep staff-group` ni yuboring.

## Uch band (2026-10-27, 0136) — tekshiruv tartibi

Bu raundda migratsiya bor: **0136** — deploydan keyin son **137** bo‘ladi
(repo’dagi fayllar soni: `ls src/modules/platform/db/migrations/*.sql | wc -l`).

1. Zaxira (§1) — hajmi 0 emasligini tekshiring.
2. `git pull`, keyin avval `docker compose build migrate`, so‘ng
   `docker compose --profile https --profile telegram up -d --build` —
   **tg-listen ham qayta qurilsin**: sayt va reklama lidlarining «shu raqamdagi
   lidga qo‘shish» qoidasi o‘zgardi.
3. Sonni o‘qing — **137**. Kam chiqsa, `docker compose run --rm migrate` ning
   o‘z chiqishini o‘qing.
4. `curl -s https://gsrwms.uz/api/version` — bugungi vaqt.
5. Sinov: CRM’da bitta lidni mavjud mijoz kodiga «Yutildi» qiling — «bu kodda lid
   bor» demasligi va yangi bitim ochishi kerak.

## «AI habarni ko‘rmayapti» tuzatishi (2026-10-29, migratsiyasiz)

Migratsiya yo‘q — son **139** bo‘lib qoladi, shuning uchun son yangilanishni ko‘rsatmaydi (to‘rtinchi tuzoq).
O‘zgarish asosan **tg-listen**da, demak u albatta qayta qurilishi kerak.

1. Zaxira (§1).
2. `git pull`, keyin `docker compose build migrate`, so‘ng
   `docker compose --profile https --profile telegram up -d --build`.
3. `curl -s https://gsrwms.uz/api/version` — bugungi vaqt.
4. Tinglovchi yangi kodda ekanini logdan bilasiz:
   `docker compose --profile telegram logs --since 5m tg-listen | grep catch-up`
   Endi 8 ta uzun «Could not find the input entity» xatosi o‘rniga **bitta** qator chiqadi:
   «catch-up: N ta saqlangan suhbat bu Telegram akkauntda ochilmadi …». Eski matn chiqsa, tg-listen qayta
   qurilmagan.
5. Mijoz yozganda logda `GS… ← in` yoki «· o‘tkazildi …: <sabab>» qatori chiqadi:
   `docker compose --profile telegram logs --since 5m tg-listen | tail -20`

## AI sotuvchi (2026-10-29, 0138) — tekshiruv tartibi

Bu raundda migratsiya bor: **0138** — deploydan keyin son **139** bo‘ladi
(repo’dagi fayllar soni: `ls src/modules/platform/db/migrations/*.sql | wc -l`).
Uch band (0136) va yo‘ldagi yuk (0137) hali deploy qilinmagan bo‘lsa, shu deploy
ularni ham olib keladi — son baribir **139**. Yangi kalit kerak emas: AI
yordamchining kaliti va Telegram sozlamalari `.env`’da allaqachon bor.

1. Zaxira (§1) — hajmi 0 emasligini tekshiring.
2. `git pull`, keyin avval `docker compose build migrate`, so‘ng
   `docker compose --profile https --profile telegram up -d --build` —
   **tg-listen albatta qayta qurilsin**: AI sotuvchining javoblarini u yuboradi.
   Eski tinglovchi bilan sahifada «tinglovchi yangilanmagan» chiqadi va ✅
   ishlamaydi.
3. Sonni o‘qing — **139**. Kam chiqsa, `docker compose run --rm migrate` ning
   o‘z chiqishini o‘qing.
4. `curl -s https://gsrwms.uz/api/version` — bugungi vaqt.
5. Bilimlar (uchta Xitoy omborining manzili, AI qoidalari). Birinchi buyruq
   faqat ko‘rsatadi, ikkinchisi yozadi:

   ```bash
   docker compose run --rm migrate pnpm exec tsx scripts/agent-seed-kb.ts
   docker compose run --rm migrate pnpm exec tsx scripts/agent-seed-kb.ts --apply
   ```

6. Telegram’ning xizmat chati (777000 — kirish kodlari, ogohlantirishlar)
   CRM’da saqlanib qolgan bo‘lsa, uni tozalash. Birinchi buyruq faqat sanaydi,
   ikkinchisi tozalaydi:

   ```bash
   docker compose run --rm migrate pnpm exec tsx scripts/tg-service-chat-cleanup.ts
   docker compose run --rm migrate pnpm exec tsx scripts/tg-service-chat-cleanup.ts --apply
   ```

7. Tinglovchi ishlayaptimi — bir daqiqa qarang (chiqish: Ctrl+C):
   `docker compose --profile telegram logs -f tg-listen`
8. Saytda: **Suhbatlar → AI sotuvchi → Sozlamalar** — akkaunt egasini tanlang
   va seansni tasdiqlang; keyin staff botda `/agent on`. AI soya rejimida
   ishlaydi: siz ✅ bosmaguningizcha mijozga hech narsa ketmaydi. Darhol
   to‘xtatish: botda `/agent off`.

**0138 dan PASTGA qaytish**: avval botda `/agent off`. AI sotuvchi jadvallari
bazada qoladi, eski kod ularni o‘qimaydi — boshqa hech narsa qilish shart emas.

## Agar biror narsa buzilsa

Avvalgi ishlaydigan holatga qaytish (kod):

```bash
git log --oneline -5                 # ishlagan commit'ni toping
git checkout <commit>
docker compose --profile https up -d --build
```

**0136 dan (uch band) PASTGA qaytishdan oldin — o‘qing.** Migratsiya bir
tomonlama: «bir mijozga bitta lid» indeksi olib tashlangan, va bir mijozda ikki
lid bo‘lsa uni qayta qo‘yib bo‘lmaydi — eski kod indekssiz ham ishlaydi. Lekin
eski kod **bitta qatorli tarkibni ko‘rmaydi** (lot butun holda hujjatga chiqadi)
va «hamkasb mijozi haqidagi lid»ni oddiy lid deb biladi. Qaytishdan oldin
sanang va soni nol bo‘lmasa, menga yuboring:

```bash
docker compose exec -T postgres psql -U gsr -d gsr -tAc \
  "SELECT count(*) FROM (SELECT lot_id FROM lot_composition_lines GROUP BY lot_id HAVING count(*) = 1) x"
docker compose exec -T postgres psql -U gsr -d gsr -tAc \
  "SELECT count(*) FROM batch_sent_compositions WHERE jsonb_array_length(lines) = 1"
docker compose exec -T postgres psql -U gsr -d gsr -tAc \
  "SELECT count(*) FROM lead_about_client"
```

**0132 dan (yo‘lkira tarifi bo‘yicha taqsimlash) PASTGA qaytishdan oldin —
majburiy.** Eski kod «yo‘lkira tarifi bo‘yicha» bo‘lingan xarajatni tanimaydi:
uni ko‘rsatgan har bir xarajat kartasi xato sahifasini beradi va kechki
tekshiruv bunday xarajatni karobka soniga teng bo‘lib yuboradi. Shuning uchun
avval o‘sha xarajatlarni og‘irlik bo‘yicha bo‘lishga o‘tkazing:

```bash
docker compose stop app                                         # yangi xarajat yozilmasin
# zaxira nusxa oling (1-bo‘lim) va hajmi 0 emasligini tekshiring
docker compose run --rm migrate pnpm freight-to-weight          # ro‘yxat, hech narsa o‘zgarmaydi
docker compose run --rm migrate pnpm freight-to-weight --apply  # hammasi og‘irlik bo‘yicha
docker compose exec -T postgres psql -U gsr -d gsr -tAc \
  "SELECT count(*) FROM cost_entries WHERE allocation_basis = 'freight' AND voided_at IS NULL"
# ==> 0 chiqishi SHART. Faqat shundan keyin git checkout <eski commit>.
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
