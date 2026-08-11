# Reklamadan lead olish — sozlash

Bu hujjat egasi uchun. Uch xil eshik bor, uchalasi ham bitta joyga tushadi:
**CRM → Voronka**, va hammasining ro'yxati **CRM → ⋯ → Kelgan arizalar**da.

Kod tomoni: `src/modules/wms/crm/inbound.ts` (qaror), `meta-leads.ts` (Meta),
`app/(public)/ariza` (sayt formasi), `telegram/ad-intake.ts` (bot).

---

## 0. Avval: taqsimotni sozlash

Reklamadan kelgan lead **navbat bilan** biriktiriladi (egasining so'zi:
«navbat bilan hammaga», keyin aniqlashtirdi: «hamma sotuvchi, lekin hamma
lead bilan ishlamaydi»). Hammasi bitta ekranda: **Boshqaruv → Arizalar
taqsimoti**.

1. **Navbat qatnashchilari** — hodimlar ro'yxati, kataklar bilan. Belgilangan
   ODAM navbatda; rol emas. Adminni olib tashlash — bitta katakni bo'shatish.
2. **Oqim qoidalari** (ixtiyoriy) — «bu manba shu odamlarga»: manba
   (instagram/facebook/telegram/google/sayt) va/yoki matndagi so'z bo'yicha.
   Qoidalar yuqoridan pastga o'qiladi, **birinchi mos kelgani ishlaydi** —
   tartibni ↑↓ bilan o'zgartirasiz. Bir qoidada bir necha hodim bo'lsa, ular
   orasida ham o'sha adolatli navbat ishlaydi.

Hech kim belgilanmasa lead baribir yaratiladi, lekin egasiz bo'ladi va
**hamma sotuvchining «Bugun qo'ng'iroq» ro'yxatida** turadi. Ya'ni hech
qachon yo'qolmaydi, faqat kimniki ekani aytilmaydi.

Kim birinchi navbatda — eng kam lead olgan odam; teng bo'lsa eng uzoq vaqt
lead olmagani. Hech qachon lead olmagan yangi sotuvchi eng oldinda turadi.
Qoidadagi hodimlarning hammasi ishdan chiqarilgan bo'lsa, o'sha oqim umumiy
navbatga qaytadi — jimgina egasiz bo'lib qolmaydi.

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

> **2026-08-11 da jonli sozlandi** (ilova: GSR CRM). Quyidagi bosqichlar o'sha
> kuni bosib o'tilgan yo'l; 3.5-bo'limdagi tuzoqlar ham o'sha kuni topilgan.

### 3.1 Meta tomonida

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
   **Create App** → turi: **Business**.
2. Ilovaga **Webhooks** va **Facebook Login for Business** mahsulotlarini
   qo'shing.
3. **App Settings → Basic** dan **App Secret**ni oling.
4. **Doimiy** Page Access Token oling — bosqichlari:
   1. Graph API Explorer'da (**Meta App = bizning ilova!**) **User Token**
      tanlab, ruxsatlarga `leads_retrieval`, `pages_show_list`,
      `pages_read_engagement`, `pages_manage_metadata` ni qo'shing →
      **Generate Access Token**.
   2. Serverda o'sha user tokenni uzoq muddatlisiga almashtiring va sahifa
      tokenini oling (APPID/SECRET — ilovaniki):
      ```bash
      read -r USERTOKEN   # Explorer'dagi tokenni shu yerga qo'yib Enter
      LL=$(curl -s "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=$APPID&client_secret=$SECRET&fb_exchange_token=$USERTOKEN" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
      curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=name,id,access_token&access_token=$LL"
      ```
      Ro'yxatdan **kerakli sahifaning** `access_token`ini oling — uzoq muddatli
      user tokendan chiqqan sahifa tokeni **muddatsiz** bo'ladi.
   3. Isbot — `debug_token`da **`"expires_at":0`** turishi shart:
      ```bash
      curl -s "https://graph.facebook.com/v21.0/debug_token?input_token=$TOKEN&access_token=$APPID|$SECRET" | grep -o '"expires_at":[0-9]*'
      ```
      Nol bo'lmasa token muddatli — o'sha kuni leadlar **jimgina to'xtaydi**.
5. Ilovani **Live/Published** qiling (Dashboard → Publish; Privacy Policy URL
   va ikonka so'raydi). O'z sahifamiz uchun App Review shart bo'lmadi —
   «Become a Tech Provider» taklifi ham kerak emas, u boshqa bizneslarga
   xizmat ko'rsatuvchilar uchun.

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
(konteynerni qayta ishga tushiring). Obyekt **Page** bo'lsin — `user`
obyektiga yozilgan callback leadgen uchun hech narsa qilmaydi.

Oxirida sahifani ilovaga **subscribe** qiling — sahifa TOKENI bilan, shunda
sahifa adashmaydi:

```bash
curl -s -X POST "https://graph.facebook.com/v21.0/me/subscribed_apps?subscribed_fields=leadgen&access_token=$TOKEN"
```

va o'qib tasdiqlang: `me/subscribed_apps` ilovani `subscribed_fields:
["leadgen"]` bilan ko'rsatsin. Yana bir eshik: **Business Settings →
Integrations → Leads Access** (Lead Access Manager yoqilgan sahifada) —
ilova **CRMs** ro'yxatida turishi kerak, aks holda Meta hodisani atayin
yubormaydi.

### 3.4 Tekshirish

Meta'ning **Lead Ads Testing Tool** orqali test lead yuboring →
`docker compose logs -f app | grep meta-leads` da `landed` yozuvi ko'rinadi →
**CRM → ⋯ → Kelgan arizalar**da qator paydo bo'ladi.

Testing Tool'ning ikki injiqligi (2026-08-11 da ko'rildi): «Track status»
Development rejimda **«Pending»da abadiy qotib qolishi mumkin** — bu bizning
nosozlik emas; va Webhooks sahifasidagi «Test» tugmasi soxta `444444444444`
raqamini yuboradi, log'dagi «does not exist» xatosi o'sha soxta raqam haqida
(qabul yo'li ishlayotganining isboti). Hal qiluvchi sinov — haqiqiy test
leadni O'ZIMIZ imzolab eshigimizga yuborish:

```bash
LEADID=$(curl -s "https://graph.facebook.com/v21.0/<FORMA_ID>/leads?access_token=$TOKEN" | grep -o '"id":"[0-9]*"' | head -1 | grep -o '[0-9]*')
BODY='{"object":"page","entry":[{"id":"<SAHIFA_ID>","time":0,"changes":[{"field":"leadgen","value":{"leadgen_id":"'$LEADID'","page_id":"<SAHIFA_ID>","form_id":"<FORMA_ID>"}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -s -X POST "https://gsrwms.uz/api/leads/meta" -H "content-type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary "$BODY"
```

Bu butun zanjirni (imzo → navbat → Graph'dan o'qish → CRM'ga tushish)
oxirigacha sinaydi; Meta keyin o'sha leadni o'zi ham yuborsa, baza takror
deb rad etadi.

### 3.5 Eng qimmat tuzoq: NOTO'G'RI SAHIFA

2026-08-11 dagi «hamma narsa yashil, lead kelmayapti»ning sababi: Explorer'da
token **boshqa sahifa** uchun olingan bo'lib, `subscribed_apps` o'sha begona
sahifaga yozilgan edi — webhook to'g'ri, token yaroqli, obuna «active», lekin
kerakli sahifadan hodisa kelmaydi va hech bir xato ko'rinmaydi (Testing Tool
faqat «Pending» deydi, `leadgen_forms` esa `(#10) insufficient privileges`
qaytaradi). Tekshiruv bitta savol:

```bash
curl -s "https://graph.facebook.com/v21.0/me?fields=id,name&access_token=$TOKEN"
```

**Chiqqan id/nomi aynan reklama yuradigan sahifa bo'lishi shart.** Boshqa
nom chiqsa — Explorer'da to'g'ri sahifani tanlab tokenni qaytadan oling;
`me/…` bilan ishlangan har buyruq shu tokenning sahifasiga tegishli bo'ladi,
shuning uchun sahifa id'sini qo'lda yozishdan ko'ra `me` ishonchliroq.

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
