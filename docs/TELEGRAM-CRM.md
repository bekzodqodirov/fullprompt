# Mijoz yozishmalarini CRM'ga olish — 1-bosqich

Egasining qarori: mijozlar bilan **95 % Telegram orqali** gaplashiladi, menejerlarning
shaxsiy akkauntidan. O'sha yozishmalar kompaniyaning aktivi — menejer ishdan
ketganda u bilan ketmasligi kerak.

Bu hujjat **1-bosqich** haqida: mavjud yozishmalarni bir marta CRM'ga ko'chirish.

## Nima olinadi, nima olinmaydi

**Olinadi:** faqat **mijozlar bazasida raqami bor** shaxsiy suhbatlar.

**Olinmaydi:** boshqa hamma narsa — oila, do'stlar, boshqa ishlar, guruhlar,
kanallar, botlar. Ular o'qib o'tiladi va **saqlanmaydi, sanalmaydi, nomi bilan
jurnalga yozilmaydi**.

Bu va'da kodda emas, **jadval tuzilishida**: `tg_messages.client_id` bo'sh
bo'lolmaydi, ya'ni hech kimga tegishli bo'lmagan xabarni qo'yadigan joy yo'q.

## Xavfsizlik

- **Hech narsa saqlanmaydi.** Telegram seansi faqat skript ishlagan vaqtda,
  xotirada turadi va tugashi bilan yo'qoladi. Serverda hech kimning shaxsiy
  Telegram'iga kalit **qolmaydi**.
- **Faqat o'qiydi.** Skriptda xabar yuboradigan kod yo'q — akkauntni aynan
  yuborish bloklaydi.
- 2-bosqich (jonli qabul) saqlangan seansni talab qiladi — u alohida qaror va
  alohida himoya bilan bo'ladi.

## Tayyorgarlik

`my.telegram.org` → **API development tools** → ariza (nomi `GSR CRM`,
platforma `Other`) → `api_id` va `api_hash`.

Serverda `.env` ga qo'shing (bir marta, butun kompaniya uchun):

```
TELEGRAM_API_ID=<raqam>
TELEGRAM_API_HASH=<32 belgi>
```

**Menejerlarga:** mijozlarni telefon kitobiga **kontakt qilib saqlang.**
Telegram raqamni faqat kontaktlarga ko'rsatadi — saqlanmagan bo'lsa, suhbat
mijozga bog'lanmaydi.

## Ishga tushirish

Har bir menejer uchun bir martadan, uning yonida turib:

```bash
cd ~/gsr
docker compose run --rm migrate sh -c "pnpm tg-import --user +998901757800"
```

- `--user` — menejerning **shu sistemadagi** login raqami
- `--tg` — Telegram akkaunti raqami (boshqacha bo'lsa)
- `--months` — necha oy orqaga (odatda 12)

Skript telefonga kelgan **kodni** so'raydi; ikki bosqichli parol bo'lsa uni ham.
Menejerning o'zi kiritadi.

## Natijani o'qish

```
suhbatlar ko'rildi:      412
mijoz deb topildi:        87
raqami ko'rinmadi:        63  ← kontaktga saqlansa topiladi
mijoz emas (o'tkazildi): 251
guruh/bot (o'tkazildi):   11
yangi xabar yozildi:    4318
allaqachon bor edi:        0
```

**«raqami ko'rinmadi»** katta son bo'lsa — menejer mijozlarni kontaktga
saqlamagan. Saqlatib, skriptni qayta ishga tushiring: takroriy ishga tushirish
**xavfsiz**, hech narsa ikkilanmaydi.

## Qayerda ko'rinadi

Mijoz kartasida — **«✈️ Telegram yozishmalari»** bo'limi, yuki va balansi
yonida. Yangisi tepada.
