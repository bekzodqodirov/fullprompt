# Mijoz yozishmalarini CRM'ga olish

Egasining qarori: mijozlar bilan **95 % Telegram orqali** gaplashiladi, menejerlarning
shaxsiy akkauntidan. O'sha yozishmalar kompaniyaning aktivi — menejer ishdan
ketganda u bilan ketmasligi kerak.

Bu hujjat uch bosqich haqida:

| Bosqich | Nima qiladi | Buyruq |
|---|---|---|
| 1 | Eski yozishmalarni **bir marta** ko'chiradi | `pnpm tg-import` |
| 2 | «Suhbatlar» ekrani — kim yozgan, kim javob kutyapti | — |
| 3 | **Jonli qabul**: yangi xabar bir necha soniyada CRM'da | `pnpm tg-login` + `pnpm tg-listen` |

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
- **Jonli qabul (3-bosqich) esa seansni saqlaydi** — pastga qarang. U boshqa
  qaror va boshqa himoya bilan.

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

- **✈️ Suhbatlar** bo'limi (menyuda, CRM yonida) — yozishmasi bor mijozlar
  ro'yxati, eng oxirgi yozgani tepada, «javob kutyapti» belgisi bilan.
- **Mijoz kartasida**, shuningdek **bitim** va **lid** kartochkalarida —
  «✈️ Telegram yozishmalari» paneli. Eskisi tepada, yangisi pastda, ochilishi
  bilan oxirgi xabarda turadi.

Yozishmani o'qish **ruxsat bilan**: sotuv (`crm.leads`) yoki mijozlar
(`clients.manage`). Omborchi ko'ra olmaydi — bu mijoz sizga ishonib aytgan gap.

---

# 3-bosqich: jonli qabul

Mijoz xabar yozdi — u bir necha soniyada CRM'da. Buning uchun server
menejerning Telegram seansini **saqlashi** kerak, va bu 1-bosqichdan jiddiy
farq qiladi.

## Nima o'zgaradi, nima o'zgarmaydi

**O'zgarmaydi:** kimning xabari saqlanadi. Baribir **faqat mijozlar bazasida
raqami bor** odamlarning xabari yoziladi — o'sha bitta funksiya qaror qiladi.
Kechqurun oilangiz yozgan xabar shu koddan o'tadi, rad etiladi va hech qayerga
yozilmaydi.

**O'zgaradi:** server endi shaxsiy Telegram akkauntga kalit ushlaydi. Shuning
uchun u:

- **shifrlangan** holda saqlanadi (AES-256-GCM), kalit `.env` da —
  `TG_SESSION_KEY`;
- **egasiga bog'langan**: bir menejerning qatorini boshqasiga ko'chirib
  qo'ysangiz, ochilmaydi;
- **faqat o'qiydi** — bu bosqichda ham xabar yuboradigan kod yo'q.

## Tayyorgarlik

```bash
openssl rand -base64 32
```

Chiqqan qatorni serverdagi `.env` ga qo'ying:

```
TG_SESSION_KEY=<yuqoridagi qator>
```

Bu kalitni **yo'qotsangiz** — hamma menejer qaytadan kiradi. **Chiqib
ketsa** — bazaga kirgan odam ularning Telegramini o'qiy oladi. `.env` dan
tashqariga chiqmasin.

## Ishga tushirish

Bir marta, har menejer uchun (o'zi yonida turib, kodni o'zi kiritadi):

```bash
cd ~/gsr
docker compose run --rm migrate sh -c "pnpm tg-login --user +998901757800"
```

Keyin tinglovchini yoqasiz — u doim ishlab turadi:

```bash
docker compose run -d --name tg-listen-bekzod migrate \
  sh -c "pnpm tg-listen --tg +998901757800"
```

To'xtatish: `docker stop tg-listen-bekzod`. Qayta yoqish: `docker start ...`.

## Ishlayaptimi?

**✈️ Suhbatlar** ekranining tepasida yozib turadi:

| Yozuv | Ma'nosi | Nima qilish kerak |
|---|---|---|
| Telegram ulangan | ishlayapti | — |
| Telegram javob bermayapti | 90 soniyadan beri ovoz yo'q | `docker start ...` |
| Telegram hali ishga tushmagan | login bor, tinglovchi yo'q | tinglovchini yoqing |
| Telegram to'xtatilgan | qo'lda to'xtatilgan | `docker start ...` |
| Telegram akkauntdan chiqdi | Telegram seansni tugatgan | `pnpm tg-login` qaytadan |
| *kalit mos kelmadi* | `.env` dagi `TG_SESSION_KEY` boshqa | eski kalitni qaytaring |

## Ikki nusxa ishlamaydi — ataylab

Bitta akkauntga **ikkinchi tinglovchi ulanmaydi**: bazada qulf bor va ikkinchisi
«another listener already holds …» deb chiqib ketadi. Bitta shaxsiy akkauntga
ikkita ulanish — akkauntni bloklatadigan asosiy sabab.
