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

- **Instagram va Facebook'ni ajratish.** Meta'ning webhook'i qaysi ilovada
  reklama chiqqanini aytmaydi, shuning uchun manba «Instagram/Facebook
  reklama» deb yoziladi. Ajratish uchun `ad_id` ni Meta'dan qayta so'rash
  kerak — keyingi raundga qoldirildi, `ad_id` saqlanib turibdi.
- **Formada avtomatik javob (email/SMS).** Hozircha faqat menejer qo'ng'irog'i.
