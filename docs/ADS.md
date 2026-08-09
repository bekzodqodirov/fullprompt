# Reklamadan lead olish — sozlash

Bu hujjat egasi uchun. Uch xil eshik bor, uchalasi ham bitta joyga tushadi:
**CRM → Voronka**, va hammasining ro'yxati **CRM → ⋯ → Kelgan arizalar**da.

Kod tomoni: `src/modules/wms/crm/inbound.ts` (qaror), `meta-leads.ts` (Meta),
`app/(public)/ariza` (sayt formasi), `telegram/ad-intake.ts` (bot).

---

## 0. Avval: navbatni yoqish

Reklamadan kelgan lead **navbat bilan** sotuvchilarga biriktiriladi (egasining
so'zi: «navbat bilan hammaga»). Kim navbatda turishini rol belgilaydi:

1. **Boshqaruv → Rollar**ni oching.
2. Sotuvchilar roli (masalan «Sotuv menejeri») yonidagi ✏️ ni bosing.
3. **«Kelgan arizalar navbati»** katagiga belgi qo'ying.

Belgilanmasa hech kim navbatda bo'lmaydi — lead baribir yaratiladi, lekin
egasiz bo'ladi va **hamma sotuvchining «Bugun qo'ng'iroq» ro'yxatida** turadi.
Ya'ni hech qachon yo'qolmaydi, faqat kimniki ekani aytilmaydi.

Kim birinchi navbatda — eng kam lead olgan odam; teng bo'lsa eng uzoq vaqt
lead olmagani. Hech qachon lead olmagan yangi sotuvchi eng oldinda turadi.

---

## 1. Sayt / Instagram bio formasi — hoziroq ishlaydi

Hech qanday sozlash kerak emas. Reklamani shu manzilga yo'naltiring:

```
https://gsrwms.uz/ariza?manba=instagram
```

`manba=` — bu leadning manbasi bo'lib yoziladi. Ruxsat etilgan qiymatlar:
`instagram`, `facebook`, `telegram`, `tiktok`, `google`, `sayt`, `meta`.
Boshqa har qanday so'z «Boshqa» bo'lib tushadi (bu ataylab: manzil satridan
turib CRM lug'atiga yangi qator qo'shib bo'lmasin).

Reklama kabineti qo'shadigan `utm_source` / `utm_campaign` kabi belgilar ham
saqlanadi — kelgan arizalar ro'yxatida ko'rinadi.

**Instagram bio uchun**: shu havolani bio'ga qo'ying.
**Stories uchun**: «swipe up» / havola stikeriga shu manzilni bering.

---

## 2. Telegram bot orqali reklama

Reklama havolasi:

```
https://t.me/<bot_nomi>?start=ad_instagram
```

Odam botni ochadi → bot faqat **raqamini** so'raydi (Telegram o'zi tasdiqlaydi,
qo'lda yozilmaydi) → «Rahmat, menejerimiz qo'ng'iroq qiladi» deydi va lead
voronkaga tushadi.

Agar raqam bizning mijozlar kitobimizda bo'lsa — lead ochilmaydi, odam o'z
**kabinetiga** ulanadi va savoli mijoz kartasining lentasiga yoziladi.

`ad_` dan keyingi so'z — manba, yuqoridagi ro'yxat bilan bir xil.

---

## 3. Instagram/Facebook Lead Ads — bir marta sozlanadi

Bu «Lead form» reklamasi: odam Instagramdan chiqmasdan, ismini va raqamini
Meta'ning o'z formasiga yozadi. Bizga darhol tushadi.

Egasining javobi bo'yicha: Instagram **biznes akkaunt** va Facebook sahifasiga
ulangan, reklamani **o'zi ham, agentlik ham** yuritadi — ikkalasi ham shu bitta
kanal orqali keladi.

### 3.1 Meta tomonida

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
   **Create App** → turi: **Business**.
2. Ilovaga **Webhooks** va **Facebook Login for Business** mahsulotlarini
   qo'shing.
3. **App Settings → Basic** dan **App Secret**ni oling.
4. Sahifa uchun **Page Access Token** oling (`leads_retrieval`,
   `pages_show_list`, `pages_manage_metadata` ruxsatlari bilan). Tokenni
   **uzoq muddatli** qilib oling — qisqasi 1-2 soatda o'ladi.
5. Ilovani **Live** rejimiga o'tkazing va `leads_retrieval` uchun App Review'dan
   o'tkazing (agentlik odatda buni biladi).

### 3.2 Serverda

`.env` fayliga uch qator qo'shing (**hech qachon chatga, repoga yozilmasin**):

```
META_APP_SECRET=...
META_VERIFY_TOKEN=<o'zingiz o'ylab topgan uzun so'z>
META_PAGE_TOKEN=...
```

Keyin: `docker compose up -d --build app`

Uchtasidan bittasi yo'q bo'lsa eshik butunlay yopiq turadi (`/api/leads/meta`
**404** qaytaradi) — bu ataylab: tokeni yo'q server o'zini bizniki deb tanitib
qo'ymasligi kerak.

### 3.3 Meta'da webhook'ni ulash

**Webhooks → Page → Subscribe to this object**:

| Maydon | Qiymat |
|---|---|
| Callback URL | `https://gsrwms.uz/api/leads/meta` |
| Verify Token | `.env` dagi `META_VERIFY_TOKEN` bilan **bir xil** |
| Field | `leadgen` |

«Verify and Save» bosilganda Meta bizga bir marta murojaat qiladi va yashil
belgi chiqishi kerak. Chiqmasa — token mos emas yoki `.env` o'qilmagan
(konteynerni qayta ishga tushiring).

Oxirida sahifani ilovaga **subscribe** qiling (Page → Subscribed Apps).

### 3.4 Tekshirish

Meta'ning **Lead Ads Testing Tool** orqali test lead yuboring →
`docker compose logs -f app | grep meta-leads` da `landed` yozuvi ko'rinadi →
**CRM → ⋯ → Kelgan arizalar**da qator paydo bo'ladi.

---

---

## 4. Hamma platforma — havola bilan (hech narsa sozlanmaydi)

**TikTok, YouTube, sayt, Instagram bio, bosma reklama, QR — hammasi.** Reklamaga
shu havolani qo'yasiz, odam bosadi, formani to'ldiradi, lead CRM ga tushadi:

```
https://gsrwms.uz/ariza?manba=tiktok
```

Tayyor havolalar **CRM → ⋯ → Kelgan arizalar → «Reklama havolalari»** da yozib
qo'yilgan — nusxa olib reklamaga qo'yavering. Har manba uchun alohida havola
bor, shunda qaysi reklama qancha olib kelgani hisobotda ko'rinadi.

Bu eng ishonchli yo'l: hech kimning ruxsati, tasdiqlashi yoki kaliti kerak
emas, va platforma o'z qoidasini o'zgartirsa ham buzilmaydi.

---

## 5. Platformaning o'z formasi — webhook

Bu faqat bitta holat uchun: odam **ilovadan chiqmay**, o'sha yerning o'z
formasini to'ldiradi. Google Ads (va YouTube — u ham Google Ads orqali ketadi),
TikTok konnektor orqali, yoki saytingizning o'z formasi.

### 5.1 Kalitni yoqish

1. **CRM → ⋯ → Kelgan arizalar** → «Reklama havolalari».
2. Kerakli manbani toping → **«Platformaning o'z formasi»** ni oching.
3. **«Yoqish va kalit yaratish»**. URL va kalit chiqadi — ikkalasini nusxa oling.

Kalit faqat shu manba uchun ishlaydi. Bittasini o'chirsangiz qolganlari
ishlayveradi. Kalitni qayta yaratsangiz **eskisi darhol ishlamay qoladi** — bu
ataylab, kalit chiqib ketsa shunday to'xtatasiz.

### 5.2 Google Ads (va YouTube)

Google Ads → **Assets → Lead form** → **Data integration** → *Webhook*:

| Maydon | Nima yoziladi |
|---|---|
| Webhook URL | `https://gsrwms.uz/api/leads/in/google` |
| Key | ekrandagi kalit |

«Send test data» tugmasi bor — bosing, «Kelgan arizalar» ro'yxatida darhol
ko'rinishi kerak. YouTube reklamasi ham xuddi shu forma, alohida sozlash
kerak emas.

### 5.3 Boshqa har qanday platforma yoki saytingiz

`POST https://gsrwms.uz/api/leads/in/<manba>`, sarlavhada `X-GSR-Key: <kalit>`,
tanasi:

```json
{ "name": "Aziz Karimov", "phone": "+998901112233", "note": "Yiwudan 5 kub" }
```

Boshqa maydonlar ham yuborilsa — izohga tushadi, yo'qolmaydi.

**Muhim:** javob har doim bir xil — `{"ok":true}`. Lead ochildimi, eskisiga
qo'shildimi, mijoz ekan deb tanildimi, chegaraga urildimi — yuboruvchiga farqi
bilinmaydi. Bu ataylab: aks holda har kim raqam yuborib bizning mijozimizmi
yo'qmi deb tekshirib chiqa olardi.

Kalit noto'g'ri bo'lsa yoki yoqilmagan bo'lsa — **404**. Ya'ni «bunday eshik
yo'q», «kalit noto'g'ri» emas.

---

## 6. Qaysi reklama pul keltiryapti

**CRM → ⋯ → Kelgan arizalar → «Manba bo'yicha natija»**. Har manba uchun:

- **necha ta ariza keldi** — shu jumladan bekor bo'lganlari ham;
- **necha tasi yutildi** va foizi;
- **yutilgan summa** — leadga qo'yilgan narx (round 71).

Ikkita son ikki xil savolga javob beradi: **ariza soni** reklama ishlayaptimi
deydi, **summa** esa qaysi reklamaga ko'proq pul tikish kerakligini. Ariza ko'p,
lead yo'q bo'lsa — forma buzilgan; ariza kam, pul katta bo'lsa — o'sha kanalga
ko'proq bering.

Instagram va Facebook endi **alohida** ko'rinadi (avval ikkalasi «Meta reklama»
edi).

---

## Bir xil odam ikki marta yozsa nima bo'ladi

Tartib shunday, yuqoridan pastga:

| Holat | Nima bo'ladi |
|---|---|
| Raqam **mijozlar kitobida** | Lead ochilmaydi — savol mijoz kartasi lentasiga tushadi |
| O'sha raqamda **ochiq lead** bor (30 kun ichida) | Yangi lead ochilmaydi — xabar o'sha leadga qo'shiladi, **egasi o'zgarmaydi** |
| Avval **yo'qotilgan** lead | **Yangi** lead ochiladi (qaytib kelgan odam — bu yangi ish) |
| Bitta raqam kuniga **4-marta** | Olinmaydi, lekin ro'yxatda «Olinmadi · capped» bo'lib yoziladi |
| Bitta manbadan kuniga **200 dan ortiq** | Xuddi shunday |

Meta bitta leadni bir necha marta yuborishi normal (u 200 javobini olguncha
takrorlaydi) — ikkinchisi bazaning o'zi tomonidan rad etiladi.

## Nima ataylab qilinmagan

- **TikTok'ning o'z Lead Ads API'si.** U tasdiqlangan ilova va Business
  Center talab qiladi. O'rniga: reklamada havola (4-bo'lim) yoki konnektor
  orqali webhook (5-bo'lim) — ikkalasi ham bugun ishlaydi.
- **Formada avtomatik javob (email/SMS).** Hozircha faqat menejer qo'ng'irog'i.
