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
| — | **Qaysi chatlar**: qaysi birini olish, qaysi birini olmaslik — o'zingiz | `pnpm tg-scan` + ekran |
| 4 | **Javob yozish**: CRM'dan mijozga javob | sozlamadagi tugma |

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

Yoki — kontaktga saqlamasdan — **«Qaysi chatlar»** ekranidan qo'lda
belgilaysiz. Pastga qarang.

---

# Qaysi chatlarni olish, qaysinisini olmaslik

Avtomatik qoida sodda: **raqami mijozlar bazasida bo'lsa — olinadi.** U to'g'ri,
lekin ikki narsani bilolmaydi:

1. Telegram raqamni **faqat kontaktlarga** ko'rsatadi. Kontaktga saqlanmagan
   haqiqiy mijoz avtomatik qoida uchun ko'rinmaydi — birinchi importda
   **122 ta** shunday chat bo'lgan edi.
2. Bazada raqami bor odamning chati ham **kerak bo'lmasligi** mumkin.

Shuning uchun endi **siz** javob berasiz, va sizning javobingiz avtomatik
qoidadan **kuchliroq** — ikkala tomonga ham.

## Qanday ishlaydi

**1-qadam.** Menejer o'z akkauntida ro'yxatni yig'adi:

```bash
docker compose run --rm migrate sh -c "pnpm tg-scan --user +998901757800"
```

Bu skript **xabarlarni o'qimaydi** — o'qiy olmaydi ham. U faqat avtomatik
qoidaga tushmagan chatlarning **ismini, raqamini (ko'rinsa) va id sini** yozib
qo'yadi. Guruhlar va botlar hech qachon so'ralmaydi.

**2-qadam.** Ilovada: **Suhbatlar → «Qaysi chatlar»**. Har qatorda ikki tugma:

- **«Bu mijoz»** → mijozni tanlaysiz → o'sha chat endi olinadi;
- **«Hech qachon»** → boshqa so'ralmaydi va olinmaydi.

Har qanday javobni **bir bosishda o'zgartirsa bo'ladi** — bu ism bo'yicha
qilingan taxmin, xato bo'lishi tabiiy.

**3-qadam.** Import va jonli tinglovchi bu qoidalarni o'zi o'qiydi. Tinglovchi
uchun qayta ishga tushirish shart emas — 10 daqiqada o'zi biladi.

## Kim ko'radi

| Kim | Nima ko'radi |
|---|---|
| Menejer (`clients.manage`) | **faqat o'zining** chatlari |
| Egasi (`admin.settings.manage`) | hammasi |
| Sotuv menejeri (`crm.leads`) | **ko'rmaydi** — u yozishmani o'qiy oladi, lekin nima saqlanishini hal qilmaydi |

Bu ataylab shunday: ro'yxatda menejerning **oilasi va do'stlari** ismi turadi —
aynan shularni «hech qachon» deb belgilash uchun. Uni butun kompaniya ko'rmasin.

## Nima yozilmaydi

Bu jadvalda **birorta ham xabar yo'q va bo'lolmaydi**. Faqat ism, raqam va id.
Siz «ha» demagan chatning gapi hech qayerga tushmaydi.

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

**Osonroq yo'l (round 21):** har bir menejer o'z akkauntini ILOVANING
O'ZIDAN ulaydi — «Suhbatlar → Telegram ulash» ekrani (telefon → kod →
kerak bo'lsa ikki bosqichli parol). Server `.env` da `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH` va `TG_SESSION_KEY` turgan bo'lsa yetadi; `tg-login`
skripti zaxira yo'l sifatida qoladi.

Keyin tinglovchini yoqasiz. **`docker compose run` bilan emas** — u qayta
ishga tushmaydi, ya'ni server o'chsa yoki jarayon yiqilsa tinglovchi jimgina
o'ladi. Alohida servis bor — va u BITTA konteynerda BARCHA ulangan
akkauntlarni tinglaydi: yangi ulangan akkauntni bir daqiqa ichida o'zi
oladi, docker'ga tegish shart emas:

```bash
docker compose --profile telegram up -d
docker compose --profile telegram logs -f tg-listen
```

Birinchi qator shunday bo'lishi kerak:

```
tinglayapman: Bekzod (Super admin) · +998901757800 · 20 mijoz · 0 qoida
```

To'xtatish: `docker compose --profile telegram stop tg-listen`.
Qayta yoqish: `docker compose --profile telegram up -d`.

**Ishlamayotganini bilish uchun:**

```bash
docker compose run --rm migrate sh -c "pnpm tg-doctor"
```

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


---

# 4-bosqich: CRM'dan javob yozish

«Suhbatlar» ichida, chat ostida javob yozish oynasi.

## Nega bu boshqa bosqichlardan jiddiyroq

1–3-bosqichlar bitta jumlaga tayangan edi: **«yuboradigan kod yo'q»**. Akkauntni
bloklatadigan asosiy sabab aynan yuborish. Endi u jumla yo'q, o'rniga qoidalar:

| Qoida | Nega |
|---|---|
| **Birinchi bo'lib yozib bo'lmaydi** | Mijoz sizga yozmagan bo'lsa, javob oynasi chiqmaydi. So'ralmagan xabar — «spam» tugmasi aynan shu uchun |
| **Umumiy tugma, odatda o'chiq** | Deploy qilishning o'zi hech kimni yuborishga majburlamaydi. Muammo chiqsa — bitta joydan hammasi to'xtaydi |
| **12/daqiqa · 200/kun · 4 ta bitta chatga/daqiqa** | Odam yeta olmaydi. Bu chegara **dastur xatosi** uchun |
| **Telegram «kuting» desa — kutamiz** | Mensimaslik akkauntni yo'qotishning eng tez yo'li |
| **Faqat o'z akkauntingizdan** | Xabar menejerning ismi va rasmi bilan chiqadi |

## Yoqish

**Sozlamalar → «Telegram orqali yuborish»** ni yoqing. Tinglovchi ishlab
turishi shart — o'chiq bo'lsa javob oynasi ochilmaydi.

## Navbatdagi xabar — yuborilgan xabar emas

Javob avval **navbatga** tushadi (chatda punktir ramka bilan «navbatda» deb
turadi), tinglovchi uni oladi va yuboradi. Yuborilgach oddiy xabarga aylanadi.

- **«Yuborilmadi»** (qizil) — sabab yoziladi. Mijoz sizni bloklagan bo'lsa
  qayta urinilmaydi (qayta urinish — aynan spam xatti-harakati).
- **«yuborilayotganda uzilib qolgan»** — tinglovchi xabar yo'ldayotganda
  o'chgan. Telegram uni oldimi-yo'qmi — bu yerdan bilib bo'lmaydi, shuning
  uchun **taxmin qilinmaydi**: o'z Telegramingizdan qarab, kerak bo'lsa qayta
  yuborasiz.

## Nima qilinmadi — ataylab

- **Rasm/fayl yuborish** — hozircha faqat matn.
- **Ommaviy tarqatma** — yo'q va bo'lmaydi. Bir xil matnni ko'p odamga yuborish
  akkauntni bloklatadigan uchinchi sabab.
- **Avtomatik javob** — hech qanday robot mijozga o'zi yozmaydi.
