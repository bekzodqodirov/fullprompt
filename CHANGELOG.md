# CHANGELOG

## 🕘 «Lenta» — mijozning butun tarixi bitta ustunda — 2026-07-28

Siz aytgan narsa: *«amocrm bitrixlardek katta polyada ketma-ketlikda ko'rinib
tursa yaxshi edi … chatga o'xshab qachon nima bo'lgani 1 joyda ko'rinar edi»*.

Endi mijoz, **bitim** va lid kartochkasida shu bor.

### Nima ko'rinadi

Bitta ustun, chatdek — tepada eskisi, pastda yangisi:

| | |
|---|---|
| 💬 | mijoz yozdi |
| ↩️ | biz javob berdik |
| ◷ | navbatda — hali yuborilmadi |
| 📦 | yuk qabul qilindi (qaysi ombor, nechta quti) |
| 🧾 | hisob |
| 💵 | to'lov |
| 📝 | izoh |

Bekor qilingan hisob **yo'qolmaydi** — xiralashib «bekor qilingan» deb turadi.
Bo'lgan ish bo'lgan, keyin uni kimdir bekor qilgan — ikkalasi ham tarix.

### Ostida ikkita yozish oynasi

- **mijozga** — Telegramga ketadi;
- **ichki izoh** — mijoz **ko'rmaydi**.

Ataylab **ikkita alohida oyna**. amoCRM'da bitta oyna va o'tkazgich bo'ladi —
va o'shanda odam mijoz haqidagi ichki gapni **mijozga** yuborib qo'yadi. Ikkita
alohida oyna bunday xato qila olmaydi.

### «Bitimda chat yo'q» — endi savol yo'qoladi

Chat paneli yozishmasi yo'q mijozda **umuman ko'rinmasdi**. Lenta esa doim
to'la — yuk ham, pul ham mijoz yozmasa ham bo'lib turadi.

### Yuborish nega ko'rinmasligini aniqlaydigan buyruq

```bash
docker compose run --rm migrate sh -c "pnpm tg-doctor"
```

Ettita sababni bittalab tekshirib, qaysi biri ekanini aytadi. Sizning
holatingizda ehtimol: **Sozlamalar → «Telegram orqali yuborish» o'chiq**.

Tekshirildi: 630 ta test + 73 ta ekran testi.

## Zaxira ogohlantirishi ishlamayotgan ekan — 2026-07-28

Rasmlarni zaxiralashni loyihalash uchun mavjud kodni surishtirdim va **haftalar
davomida ishlamay turgan** narsani topdim.

### Kechasi zaxira olinmasa, sizga nima kelardi

Faqat shu:

```
BackupFailed
https://gsrwms.uz
```

Xolos. **Nima buzilgani yozilmasdi** — disk to'ldimi, Drive rad etdimi,
parol eskirdimi — hech biri. Kodda `RestoreTestFailed` uchun matn bor edi,
`BackupFailed` uchun esa yo'q, shuning uchun u «nomini aytib qo'yish» degan
zaxira yo'lga tushib ketardi.

Endi shunday keladi:

```
🆘 KECHASI ZAXIRA OLINMADI!
Google Drive: hajm mos kelmadi: diskda 41231872 bayt, Drive'da 0 bayt
Baza bugun saqlanmadi. Ertaga emas, hozir tekshiring.
```

Bunday xabarlar **faqat yomon kunda** keladi — aynan shuning uchun ular
ishlamay turganini hech kim sezmaydi. Endi **har bir ogohlantirish** to'rt
tilda tekshiriladi: nomining o'zi emasligi va sababni olib kelishi shart.

### Rasmlarni zaxiralash — poydevor

Google Drive tomonining ikki qismi tayyor: **xotiradan yuklash** (rasm MinIO'dan
keladi, diskka yozilmaydi) va **bo'sh joyni o'lchash**.

Ikkinchisi eng muhimi: Google'dagi 15 GB'ni sizning Gmail'ingiz va shaxsiy
rasmlaringiz ham bo'lishadi. Faqat o'z papkasiga qaraydigan zaxira oxirgi
gigabaytni yeb qo'yib, **baza zaxirasini o'ldirishi** mumkin edi. Endi u
butun akkauntning bo'sh joyini o'qiydi.

Tekshirildi: 626 ta test + 73 ta ekran testi.

## Deploy paytida yo'qolayotgan xabarlar + «bu chatni olmang» — 2026-07-28

### 1. Har deploy'da xabarlar yo'qolar edi ⚠

Kodimda «Telegram qayta ulanganda oxirgi xabarlarni o'zi qaytaradi» deb
yozilgan edi. **Bunday emas ekan** — kutubxonada o'sha funksiya butunlay bo'sh
(`catchUp() { // TODO }`).

Ya'ni: `docker compose up -d --build` qilganingizda tinglovchi 1–2 daqiqaga
o'chadi. O'sha oraliqda mijoz yozgan xabar **hech qachon, hech qayerga
tushmaydi**. Yomoni — «javob kutyapti» belgisi ham chiqmaydi, ya'ni ekran
«hech kim kutmayapti» deb turadi.

Endi tinglovchi ishga tushganda har bir chatni **o'zi to'xtagan joyidan**
davom ettiradi. Log'da ko'rasiz: `uzilish davridagi N ta xabar olindi`.

### 2. «Bu chatni olmang» — yetishmayotgan yarmi

O'tgan safar «Qaysi chatlar» ni qilganimda **faqat yarmi ishlagan ekan**:
raqami bazada yo'q chatni **qo'shish** mumkin edi, lekin raqami bazada **bor**
chatni **rad etish** mumkin emas edi. Skan faqat mos kelmagan chatlarni
so'rardi, mos kelganlari esa ro'yxatga umuman tushmasdi.

Endi rad etish **chatning o'zidan** qilinadi — mijoz kartochkasida yoki
«Suhbatlar»da, javob oynasi ostidagi kichik havoladan. Bu yaxshiroq ham:
ismga qarab emas, **yozishmani ko'rib turib** qaror qilasiz.

Faqat kelgusi xabarlarga ta'sir qiladi — eski xabarlar o'chmaydi. Bosishdan
oldin shu yozib qo'yiladi.

Tekshirildi: 625 ta test + 73 ta ekran testi — hammasi yashil.

## Javob yozish oynasi endi kartochkalarda ham — 2026-07-28

Siz aytdingiz: «crm kartochkalarda, bitim kartochkalarda va chatda sms
jo'natish ko'rinmayapti».

**Ikkita sabab bor edi, biri meniki.**

### 1. Kartochkalarda oyna umuman yo'q edi — mening kamchiligim

Javob oynasini faqat **«Suhbatlar»** ekraniga qo'ygan ekanman. Mijoz, bitim va
lid kartochkalarida esa faqat **o'qish** paneli turardi.

Endi uchalasida ham bor. Yuborilmagan javob kartochkada ham «navbatda» bo'lib
ko'rinadi — aks holda javob yozgandan keyin panel avvalgidek turaverardi.

### 2. Yuborish sozlamada o'chiq turadi

Bu ataylab: kodni yangilashning o'zi hech kimning akkauntini yuborishga
majburlamasligi kerak.

**Yoqish:** ⚙️ Sozlamalar → «Telegram orqali yuborish» → yoqing.

### Ko'rinmasa — endi sababini yozadi

Ilgari oyna shunchaki yo'q edi. Endi o'rnida sabab turadi:

| Yozuv | Nima qilish |
|---|---|
| «Yuborish o'chirilgan» | Sozlamalardan yoqing |
| «Telegram ulanmagan» | `docker start tg-listen-bekzod` |
| «Mijoz sizga hali yozmagan» | Birinchi bo'lib yozib bo'lmaydi — bu qoida |
| «Boshqa menejerning akkauntida» | O'sha menejer javob beradi |
| «Juda tez-tez» | Bir daqiqa kuting |

Tekshirildi: 620 ta test + 73 ta ekran testi — hammasi yashil.

## Telegram bo'limiga qattiq tekshiruv — 5 ta jiddiy xato tuzatildi — 2026-07-28

1–4-bosqichlarni yozib bo'lib, ustidan **adversarial tekshiruv** o'tkazdim —
ya'ni maqsadi maqtash emas, buzish bo'lgan tekshiruv. 19 ta muammo tasdiqlandi.
Eng jiddiy 5 tasi tuzatildi.

### 1. Tinglovchi umuman ulanmas edi ⚠

Eng yomoni. `connectionRetries: -1` deb yozgan edim — «cheksiz qayta urin»
degan ma'noda. Kutubxonada esa bu **sikl chegarasi**: `-1` bo'lsa sikl
**umuman ishlamaydi**. Ulanish `false` qaytaradi, xato tashlamaydi — men esa
javobini tekshirmagan edim.

Natija bo'lardi: ekranda «ulangan», hech qanday xato yo'q, **birorta xabar
kelmaydi**. Yaxshiyamki siz hali ishga tushirmagansiz.

### 2. Bir marta o'chirib-yoqsangiz, javob yozish butunlay ishlamay qolardi

To'xtatganda holat «to'xtatilgan» bo'lib yozilardi, «ishlayapti» ga esa faqat
qaytadan login qilganda qaytardi. Ya'ni bir marta restart — va javob yozish
oynasi boshqa ochilmasdi (u tinglovchi tirik bo'lishini talab qiladi).

Yonidagi yarmi: yurak urishi **jarayon tirik**ligini isbotlardi, **ulanish**
tirikligini emas. Uzilgan aloqa ham «ulangan» bo'lib ko'rinardi.

### 3. «Saved Messages» mijoz yozishmasi bo'lib tushishi mumkin edi

O'zingizga yozgan chatingizda **o'zingizning raqamingiz** turadi. Sizning
raqamingiz esa mijozlar bazasida bor. Ya'ni shaxsiy eslatmalaringiz o'sha
mijozning yozishmasi bo'lib saqlanib, uni ko'ra oladigan hammaga ko'rinardi.

Endi u mijozlar bazasiga qaramasdanoq rad etiladi — va **qo'lda ham qo'shib
bo'lmaydi**.

### 4. Bitta Telegram raqamiga ikkita tinglovchi ulanishi mumkin edi

Cheklov «bir odamga bitta login» edi, kerak bo'lgani esa «bitta Telegram
akkauntga bitta tinglovchi». Migratsiya **0038** shuni qo'yadi.

### 5. Bitta raqamda bir necha kod bo'lsa, yozishma har safar boshqasiga tushardi

Sizda bu odatiy hol (777, 555, 444 bitta odamda). Baza tartibsiz o'qilardi,
shuning uchun bugun 777 ga, ertaga 444 ga tushishi mumkin edi. Endi tartib
qat'iy — noto'g'ri bo'lsa ham **barqaror**, ya'ni qo'lda tuzatsa bo'ladi.

### Qolgan 14 tasi

Ro'yxatga olindi, keyingi navbatda. Ular orasida: aloqa uzilganda o'sha
paytdagi xabarlar yo'qoladi (keyin qidirib olinmaydi), «hech qachon» degan
chatning eski xabarlari o'chmaydi, tahrirlangan xabar yangilanmaydi,
suhbatlar ro'yxati katta bazada sekinlashadi.

Tekshirildi: 620 ta test + 72 ta ekran testi — hammasi yashil.

## CRM'dan javob yozish (4-bosqich) + jonli qabuldagi jiddiy tuzatish — 2026-07-28

### ⚠ Avval tuzatish — bu muhim

Kechagi jonli tinglovchida xato bor edi va uni Telegram kutubxonasining
o'zida tekshirib tasdiqladim:

**Shaxsiy chatda o'zingiz yozgan xabarning "jo'natuvchisi" bo'lmaydi.** Men esa
aynan jo'natuvchidan mijozni aniqlayotgan edim. Natijasi:

- mijozning xabarlari **tushaveradi**,
- sizning javoblaringiz **jimgina yo'qoladi**.

Ekranda «ulangan» deb turadi, xabarlar kelib turadi — buni faqat bir necha
hafta o'tib, «biz nima deb javob bergan edik?» deb qaraganda sezgan bo'lardingiz.

Endi mijoz **chatdan** aniqlanadi (u ikkala yo'nalishda ham bir xil odam), va
import ham, tinglovchi ham **bitta funksiyadan** foydalanadi.

### 4-bosqich: mijozga CRM'dan javob yozish

«Suhbatlar» ichida chat ostida **javob yozish oynasi** paydo bo'ldi.

**Nega bu jiddiy:** 1–3-bosqichlar «hech qachon yubormaydi» degan kafolatga
tayangan edi — akkaunt bloklanishining asosiy sababi aynan yuborish. Endi bu
kafolat yo'q, shuning uchun uning o'rniga **qoidalar** qo'ydim:

- **birinchi bo'lib yozib bo'lmaydi.** Mijoz sizga yozmagan bo'lsa — javob
  oynasi umuman chiqmaydi. Bu eng muhim qoida;
- **umumiy tugma**, sozlamalarda, **odatda o'chiq**. Kodni deploy qilishning
  o'zi hech kimning akkauntini yuborishga majburlamaydi. Akkauntda muammo
  chiqsa — bitta joydan hammasini to'xtatasiz;
- **daqiqasiga 12 ta, kuniga 200 ta, bitta chatga daqiqasiga 4 ta.** Odam bu
  chegaraga yeta olmaydi — bu chegaralar **dastur xatosi** uchun (aylanib
  qolgan sikl, to'xtamaydigan qayta urinish);
- Telegram «kuting» desa — **kutamiz**. Buni mensimaslik akkauntni yo'qotishning
  eng tez yo'li.

**Yuborilmagan xabar — yuborilgan xabar emas.** Navbatdagi javob chatda
punktir ramka bilan «navbatda» deb turadi. Tinglovchi o'chiq bo'lsa, javob
oynasi ochilmaydi va sababi yoziladi — chunki eng yomon holat bu mijozning
hech kim yubormagan javobni kutib o'tirishi.

**Faqat o'z akkauntingizdan.** Xabar menejerning shaxsiy Telegramidan, uning
ismi va rasmi bilan chiqadi. Shuning uchun boshqa menejerning yozishmasiga
javob yozib bo'lmaydi — o'qish mumkin, yozish yo'q. Bu sizga ham tegishli.

### Sizdan

Migratsiya **0037**. Yuborishni yoqish uchun: **Sozlamalar →
«Telegram orqali yuborish»** ni yoqasiz (hozir o'chiq).

Tekshirildi: 609 ta test + 72 ta ekran testi — hammasi yashil, CI tartibida,
toza bazada.

**Sinab ko'ra olmaganim:** haqiqiy yuborish. Bu kompyuterda Telegramga chiqish
yo'q. Birinchi javobni o'zingiz yozib ko'ring va telefoningizdan tekshiring.

## «Qaysi chatlar» — endi siz tanlaysiz — 2026-07-28

Siz so'ragan narsa: **qaysi chat CRM'ga tushsin, qaysi biri yo'q — o'zingiz
belgilaysiz.**

### Nega kerak edi

Avtomatik qoida sodda: raqami mijozlar bazasida bo'lsa — olinadi. U to'g'ri,
lekin ikki narsani bilolmaydi:

1. Telegram raqamni **faqat kontaktlarga** ko'rsatadi. Kontaktga saqlanmagan
   haqiqiy mijoz ko'rinmaydi — birinchi importda **122 ta** shunday chat bor edi;
2. bazada raqami bor odamning chati ham kerak bo'lmasligi mumkin.

Endi sizning javobingiz avtomatik qoidadan **kuchliroq** — ikkala tomonga ham.

### Qanday ishlaydi

**1.** Serverda ro'yxatni yig'asiz:

```bash
docker compose run --rm migrate sh -c "pnpm tg-scan --user +998901757800"
```

Bu skript **xabarlarni o'qimaydi**. Faqat avtomatik qoidaga tushmagan
chatlarning ismi, raqami (ko'rinsa) va id sini yozib qo'yadi. Guruh va botlar
hech qachon so'ralmaydi.

**2.** Ilovada: **Suhbatlar → «Qaysi chatlar»**. Har qatorda ikki tugma —
**«Bu mijoz»** (mijozni tanlaysiz) yoki **«Hech qachon»**. Har qanday javobni
bir bosishda o'zgartirsa bo'ladi.

**3.** Import va jonli tinglovchi qoidalarni o'zi o'qiydi. Tinglovchini qayta
yoqish shart emas — 10 daqiqada biladi.

### Kim ko'radi

- **Menejer** — faqat **o'zining** chatlarini;
- **siz** — hammasini;
- **sotuv menejeri** — **ko'rmaydi**: u yozishmani o'qiy oladi, lekin nima
  saqlanishini hal qilmaydi.

Bu ataylab: ro'yxatda menejerning oilasi va do'stlari ismi turadi — aynan
shularni «hech qachon» deb belgilash uchun. Uni butun kompaniya ko'rmasin.

### Nima yozilmaydi

Bu jadvalda **birorta ham xabar yo'q va bo'lolmaydi**. Siz «ha» demagan
chatning gapi hech qayerga tushmaydi.

Migratsiya: **0036** — bitta yangi jadval, mavjud ma'lumotga tegilmaydi.

Tekshirildi: 564 ta test + 72 ta ekran testi — hammasi yashil, CI tartibida,
toza bazada. Qo'shish / rad etish / qaytarish brauzerda haqiqiy bosib
ko'rilgan.

## Jonli qabul — 3-bosqich — 2026-07-28

Mijoz xabar yozdi — u **bir necha soniyada** CRM'da. Endi «Suhbatlar»
ro'yxatini qo'lda yangilash kerak emas: yozishma o'zi kelib turadi.

### Nima o'zgarmadi — eng muhimi

Kimning xabari saqlanishi **o'zgarmadi**. Baribir faqat **mijozlar bazasida
raqami bor** odamning xabari yoziladi. Kechqurun oilangiz yozgan xabar shu
koddan o'tadi, rad etiladi va **hech qayerga yozilmaydi** — nomi ham,
raqami ham. Buni 1-bosqichdagi **aynan bitta funksiya** hal qiladi, ikkinchi
qoida yozilmadi.

### Nima o'zgardi

Server endi menejerning Telegram seansini **saqlaydi** (1-bosqich saqlamas
edi). Shuning uchun:

- seans **shifrlangan** holda yotadi, kalit `.env` da — `TG_SESSION_KEY`;
- seans **egasiga bog'langan**: bir menejerning qatorini boshqasiga ko'chirsangiz
  ochilmaydi;
- **yuborish kodi yo'q** — bu bosqichda ham faqat o'qiydi.

### Ishlayotganini ko'rib turasiz

«Suhbatlar» tepasida holat yozuvi paydo bo'ldi: **ulangan / javob bermayapti /
to'xtatilgan / akkauntdan chiqdi**. Bu bekorga emas — tinglovchi to'xtasa hech
qayerda xato chiqmaydi, ro'yxat shunchaki o'smay qo'yadi, va buni birinchi
bo'lib «nega javob bermadingiz» degan mijoz aytadi.

Bitta akkauntga **ikkinchi tinglovchi ulanmaydi** — bazada qulf bor. Bitta
shaxsiy akkauntga ikkita ulanish akkauntni bloklatadigan asosiy sabab.

### Sizdan kerak bo'ladigan 3 ta buyruq

Serverda, `docs/TELEGRAM-CRM.md` da to'liq yozilgan:

```bash
openssl rand -base64 32          # → .env ga TG_SESSION_KEY= qilib qo'ying
docker compose run --rm migrate sh -c "pnpm tg-login --user +998901757800"
docker compose run -d --name tg-listen-bekzod migrate \
  sh -c "pnpm tg-listen --tg +998901757800"
```

Migratsiya: **0035**. Bazadagi hech nima o'zgarmaydi — bitta yangi jadval
qo'shiladi, xolos.

Tekshirildi: 540 ta test + 69 ta ekran testi — hammasi yashil, CI tartibida,
toza bazada.

## Chat tuzatildi: to'g'ri tartib va oxirgi xabarga fokus — 2026-07-28

Siz aytgan ikkala kamchilik ham tuzatildi.

### 1. Mijoz kartochkasidagi chat teskari edi

Endi hamma joyda **bir xil**: yuqorida eski xabar, pastda eng yangisi —
Telegramning o'zidagidek.

### 2. Chatni ochganda fokus bugunga qaratilmagan edi

Endi chat **darhol eng oxirgi xabarda ochiladi**. Sakrash yo'q: ekran
birinchi chizilganidayoq pastda turadi. Yuqoriga surasiz — tarix.

To'liq chat ekranida oyna balandligi ham to'g'irlandi: avval u pastdagi
menyu ostiga bir oz kirib ketardi va eng oxirgi xabar ko'rinmay qolardi.

### Yo'l-yo'lakay topilgan 3 ta ko'rinmas xato

Chatni tekshirayotib, ranglar bilan bog'liq bir muammo chiqdi. Dasturda
mavjud bo'lmagan rang nomi yozilsa, hech qayerda xato chiqmaydi — shunchaki
rang **umuman chizilmaydi**. Shuning uchun:

- **mijozning xabarlari fon rangisiz** chiqayotgan ekan (bizniki rangli
  edi, mijozniki oq) — endi ikkalasi ham o'z fonida;
- **kartadagi mashina yo'li** (xaritadagi punktir chiziq) umuman
  chizilmayotgan ekan;
- **haydovchi ilovasi sahifasi** foni ham shunday edi.

Endi bunday xato **testda ushlanadi**: har bir rang nomi dizayn ro'yxatida
bor-yo'qligi avtomatik tekshiriladi. Test yozilishi bilanoq xaritadagi
xatoni o'zi topdi.

Tekshirildi: 499 ta test + 68 ta ekran testi — hammasi yashil, CI
tartibida, toza bazada.

## «Suhbatlar» ekrani — 2-bosqich — 2026-07-28

1-bosqich yozishmalarni bazaga oldi va mijoz kartasida ko'rsatdi. Bu esa
menejer kuni boshida beradigan savolga javob beradi: **kim yozgan va kim
javob kutyapti**.

### Yangi bo'lim: ✈️ Suhbatlar

Menyuda, CRM yonida. Ichida — yozishmasi bor mijozlar ro'yxati:

- eng oxirgi yozishgan **tepada**
- har qatorda: mijoz kodi, ismi, **oxirgi xabar** va qachonligi
- **«javob kutyapti»** belgisi — oxirgi so'zni mijoz aytgan va hech kim
  javob bermagan

Oxirgisi shu ekranning asosiy ma'nosi: javobsiz qolgan mijoz — bu yerdagi
yagona pul turadigan narsa.

Qatorni bosasiz — butun yozishma ochiladi, boshidan oxirigacha (kartadagi
panel esa teskari: u «oxirgi nima dedik» uchun). Yon tomonda **«Kartochka»**
tugmasi — yuki, balansi, bitimlariga bir bosishda o'tasiz.

Mijoz yoki kod bo'yicha **qidiruv** bor.

### Ruxsat

Bu ekranni **faqat sotuvchilar va rahbariyat** ochadi. Sklad xodimi ochsa —
bosh sahifaga qaytariladi. Bu shunchaki menyudan yashirish emas: mijoz o'z
menejeriga ishonib aytgan gaplar, va sahifaning o'zida qo'riq turadi.

### Hozircha o'qish uchun

Javob yozish — 4-bosqich. Ekran o'zini boshqacha ko'rsatmaydi: yozish oynasi
yo'q.

### Yo'l-yo'lakay

1-bosqichda yozgan uchta testim **faqat toza bazada** ishlar ekan — ikkinchi
marta ishga tushirilsa yiqilardi. CI har safar toza baza bilan ishlaydi,
shuning uchun ular yashil turaverib, xato bo'lib qolaverardi. Tuzatildi va
uch marta ketma-ket sinab ko'rildi.

## Mijoz yozishmalari CRM'ga — 1-bosqich — 2026-07-27

Siz aytdingiz: mijozlar bilan **95 % Telegram orqali** gaplashiladi, menejerning
shaxsiy telefonida. Menejer ketsa — kim nima va'da qilgani, qanday narx
aytilgani u bilan ketadi.

### Nima qilindi

Bir martalik ko'chirish: menejer bir marta kiradi, dastur **mijozlar bilan
yozishmalarni** o'qib CRM'ga yozadi va chiqadi.

Natijasi mijoz kartasida — **«✈️ Telegram yozishmalari»** bo'limida, yuki va
balansi yonida. Yangisi tepada, chunki savol odatda «oxirgi marta nima
degandik».

### Xavfsizlik — bu yerda eng muhimi

- **Serverda hech kimning Telegram kaliti qolmaydi.** Seans faqat dastur
  ishlagan vaqtda, xotirada turadi va tugashi bilan yo'qoladi.
- **Faqat o'qiydi.** Xabar yuboradigan kod yo'q — akkauntni aynan yuborish
  bloklaydi.
- **Faqat mijozlar bilan suhbat olinadi.** Oila, do'stlar, boshqa ishlar,
  guruhlar, botlar — o'qib o'tiladi va saqlanmaydi, sanalmaydi, nomi bilan
  jurnalga yozilmaydi.

Oxirgisi shunchaki va'da emas: jadvalda **mijozsiz xabarni qo'yadigan joy
yo'q**. Ya'ni kelajakda kimdir e'tiborsizlik qilsa ham, baza qabul qilmaydi.

### Sizdan

1. `.env` ga `TELEGRAM_API_ID` va `TELEGRAM_API_HASH` (bir marta, butun
   kompaniya uchun)
2. **Menejerlarga ayting: mijozlarni telefon kitobiga kontakt qilib saqlasin.**
   Telegram raqamni faqat kontaktlarga ko'rsatadi — saqlanmagani bog'lanmaydi.
3. Bekzod va Siroj yonida turib bir martadan ishga tushirasiz

To'liq yo'riqnoma: `docs/TELEGRAM-CRM.md`.

### Keyingi bosqichlar

2 — «Suhbatlar» ekrani · 3 — jonli qabul · 4 — CRM'dan javob berish.

## Partiya va planni bekor qilish — 2026-07-27

Siz aytgan edingiz: *«dev payitida tekshirish uchun batch mashinalar ochib
tashlagan edim endi shularni o'chira olmayabman … productionga partiyalar
planlar yaratib qo'ygandim»*.

### Endi qanday

Partiya kartasida — hali yo'lga chiqmagan bo'lsa — pastda **«✖ Partiyani bekor
qilish»** yozuvi bor. Bosasiz, **sababini** yozasiz, tasdiqlaysiz. Shundan
keyin:

- partiya **doskadan yo'qoladi** (arxivda qoladi, kerak bo'lsa topiladi)
- undagi **qutilar skladga qaytadi** — yana rejaga qo'shsa bo'ladi
- **plan ham** birga bekor bo'ladi
- haydovchi telefoni **uziladi** — o'chgan reysga joylashuv yubormaydi

Plan hali tasdiqlanmagan bo'lsa (qoralama yoki agent qaytargan), plan
sahifasida **«✖ Planni bekor qilish»** bor.

### Nimalarni bekor qilib **bo'lmaydi**

Bu tugma haqiqiy mashinalar bilan bitta doskada turadi, shuning uchun qattiq
qoidalar bor. Bekor qilinmaydi, agar:

- partiya **jo'natilgan** bo'lsa — kodi bojxona hujjatlarida, yuk ikki davlat
  orasida
- partiyaga **xarajat** kiritilgan bo'lsa
- shu partiya bo'yicha mijozga **hisob qo'yilgan** bo'lsa
- qutilardan biri allaqachon **oldinga ketgan** bo'lsa

Har birida ekranda nima uchun bo'lmasligi yozilib chiqadi va hech narsa
o'zgarmaydi.

**Bekor qilish faqat menejerga ochiq** (`batches.depart_close` huquqi). Sklad
xodimi mashinani jo'nata oladi — u mashina yonida turibdi — lekin reysni bekor
qilish menejerning ishi.

### Yo'l-yo'lakay topilgan uchta narsa

1. **Haydovchi telefoni to'xtamas ekan.** Telefon uzilganda server unga
   «ruxsat yo'q» deb javob berardi — ilova buni «serverda vaqtinchalik nosozlik»
   deb tushunib, **abadiy qayta urinaverardi** va navbatini to'plardi. Endi
   «reys tugadi» deb javob beradi: ilova o'zini to'xtatadi va ma'lumotni
   tozalaydi. Bu haydovchi ilovasi chiqqanidan beri shunday edi.
2. **Partiyaga qo'yilgan vazifalar** ochiq qolardi — kimningdir kunida turib,
   o'chgan reysga havola qilardi. Endi partiya bilan birga yopiladi.
3. **«Partiyalar» hisoboti** bekor qilinganlarni ham ko'rsatardi — ya'ni siz
   tozalamoqchi bo'lgan ro'yxatning o'zi. Endi ular hisobotga tushmaydi.

### Nega «o'chirish» emas, «bekor qilish»

Partiya bazada yolg'iz emas. Sizning bazangizda **10 588 ta quti harakati**
partiyaga ishora qiladi, ustiga 2 130 audit va 2 305 hodisa yozuvi. Bazada
bularni ushlab turadigan bog'lanish yo'q — ya'ni partiyani chindan o'chirsa,
o'sha yozuvlar **jimgina yetim qoladi**: qutining tarixi endi mavjud bo'lmagan
partiyaga qaraydi va hech kim buni sezmaydi.

Shuning uchun qator o'chirilmaydi — u **«bekor qilingan»** deb belgilanadi,
sababi va kim qilgani bilan. Bu sistemada kvitansiya, quti va xarajat ham
xuddi shunday: o'chirilmaydi, bekor qilinadi.

Qiziq tomoni: «bekor qilingan» holati bazada M3 dan beri bor edi, doska ham,
xarita ham, hisobotlar ham uni to'g'ri tushunardi — faqat unga **olib
boradigan tugma yo'q edi**. Ya'ni bu yangi imkoniyat emas, yetishmayotgan eshik.

## Haydovchi ilovasi: nega o'chdi va endi havoladan yuklab olinadi — 2026-07-27

### Nega ishlamay qoldi

Ilova server manzilini **ichiga yozilgan holda** olib yuradi. U eski manzilga
(`169-58-65-23.sslip.io`) qaragan edi. Biz domenni `gsrwms.uz` ga
ko'chirganimizda eski manzil xizmat qilishdan to'xtadi — va **ulangan hamma
telefon bir vaqtda jim bo'ldi**. Haydovchi ekranida buni bildiradigan hech
narsa yo'q, shuning uchun birinchi belgi — mashina xaritada qimirlamay
qolishi.

**Darhol tuzatish (telefonga tegmasdan):** `.env` da eski nomni ham qoldiring —

```
DOMAIN=gsrwms.uz, www.gsrwms.uz, 169-58-65-23.sslip.io
```

va `docker compose --profile https up -d --force-recreate caddy`. Telefonlar
o'sha zahoti qayta ishlaydi.

**Bitta telefonni qo'lda tuzatish:** ilovadagi **Server manzili** maydonini
`https://gsrwms.uz` ga o'zgartirish yetarli — qayta ulash shart emas.

Ilovaning yangi versiyasi (1.2) endi to'g'ri domenga qaraydi. Kelajakda domen
o'zgarsa **uchalasi ham** kerak: eski nomni bir muddat qoldirish → yangi APK
chiqarish → hamma yangilangach eski nomni olib tashlash. Bu README'ga
yozib qo'yildi.

### Endi bitta havola

Ilgari APK'ni GitHub'dan olish kerak edi: akkaunt, Actions, zip, keyin faylni
telefonga o'tkazish. Haydovchi bularning birortasini qila olmaydi.

Endi:

```
https://gsrwms.uz/driver
```

**Login talab qilinmaydi.** Sahifada: yuklab olish tugmasi, versiya, o'rnatish
yo'riqnomasi (o'zbekcha va ruscha), va **QR kod** — sklad xodimi sahifani
ekranda ochadi, haydovchi kamerasi bilan skanerlaydi. Havola hech qachon
o'zgarmaydi.

**Yangi versiya chiqarish:** GitHub Actions'dan APK'ni oling → saytda
**Admin → Haydovchi ilovasi** → versiya nomini yozing, faylni tanlang,
**Chiqarish**. Shu zahoti havola yangi faylni beradi.

Xavfsizlik: yuklanayotgan fayl **haqiqatan APK ekanligi** ichidan tekshiriladi
— nomiga qarab emas. Bu ilovani biz haydovchilarga "noma'lum manbadan
o'rnating" deb aytamiz, ya'ni bu sistema tarqatadigan eng ishonchli fayl.
Chiqarish faqat administratorga ochiq va audit jurnaliga yoziladi.

## Katta tugma + mijoz ilovasining dizayni — 2026-07-27

Siz aytgan edingiz: *«buttonga urg'u ber web appni ochishi uchun button
glavniy katta button bo'lib ko'rinib tursin va web appni o'zida ham UI UX
designni maksimal darajada yaxshila»*.

### 1. Katta tugma

Burchakdagi kichkina belgi — mijoz uni topmaydi. Endi **butun kenglikdagi
tugma** paydo bo'ladi, uchta joyda:

- **«Yukingiz omborimizga qabul qilindi»** xabarining tagida — mijoz eng
  qiziqqan daqiqada, bitta bosishda ochiladi
- **«📦 Yuklarim»** javobining tagida — qo'shimcha xabarsiz
- **Birinchi ulanganda** — bir marta

Burchakdagi tugma ham qoladi: bir hafta o'tib qaytgan mijozga tepaga
o'tkazadigan xabar bo'lmasligi mumkin. Ikkalasi bir joyga olib boradi — buni
test tekshiradi.

### 2. Ilovaning dizayni

**Telegram'ning bir qismidek** ko'rinadi, ichidagi begona sayt kabi emas:
mijozning o'z rangi (kunduzgi ham, tungi ham), tepasi va pastki chekkasi ham
o'sha rangda, tanlaganda telefon sekin titraydi, rasm Telegram'ning **o'z
"orqaga" tugmasi** bilan yopiladi.

Har bir tovar kartasida:

- **Uchta katta raqam** — dona / kg / m³, yonma-yon, o'qishga oson
- **Yo'l chizig'i** — qutilar qayerdaligi kenglik bo'yicha: «ko'pi yo'lga
  chiqdi, 4 tasi hali Yiwuda» bitta qarashda ko'rinadi
- **Rangli belgilar**: kulrang — skladda · ko'k — tayyorlandi · sariq —
  yuklanmoqda · binafsha — yo'lda · yashil — olib ketishga tayyor
- **Rasmlar** — bosilsa butun ekranga ochiladi

Balansda summa **rangli**: qarz bo'lsa qizil, bo'lmasa yashil. To'lovlar `+`
bilan, yashil.

Ochilayotganda «Yuklanmoqda…» degan so'z emas, **javobning shakli** turadi —
mijoz sekin internetda ham «deyarli keldi» deb ko'radi.

### Tekshiruv

456 test + 57 e2e. Ilovaning ekrani ham test bilan qoplandi: raqamlar, yo'l
chizig'i kengliklari, rasm ochilishi va uchala bo'lim.

## Mijoz tomoni, 2-qism: Telegram ichida ochiladigan «Mening yuklarim» — 2026-07-27

Siz so'ragan edingiz: *«kubi kilosi soni rasimi hammasini to'liq ko'rsa yaxshi
bo'lar edi… client uchun telegramda web ochiladi shunda ko'rinadgan chiroyli
interface qilib bersak zo'r bo'lar edi»*.

### Mijoz nima ko'radi

Telegram'da bot chatining pastki chap burchagida **tugma** paydo bo'ladi —
«Mening yuklarim». Bosadi, chat ichida ilova ochiladi. Chiqmaydi, brauzer
ochilmaydi, parol so'ralmaydi.

Yuqorida — jami: nechta quti, necha kilo, necha kub. Pastda uchta bo'lim:

- **📦 Yuklarim** — har bir tovar alohida karta: nomi (tarjimasi bilan),
  nechta quti, necha kilo, necha kub, qaysi omborda, va har bir qutining
  holati («skladda», «yo'lda 🚛», «olib ketishga tayyor ✅»).
  **Rasmlar shu yerda** — qabul qilishda tushirilgan suratlar tasma bo'lib
  chiqadi, bosib kattalashtiradi.
- **💰 Balans** — qarzi bormi yoki yo'q, va so'nggi amallar (hisoblandi /
  to'lov).
- **🗄 Tarix** — allaqachon berilgan yuklari.

Hammasi mijoz tilida: **o'zbek · rus · ingliz**. Til bo'yicha tanlovi
botdagi 🌐 Til tugmasi bilan bir xil — bir joyda o'zgartirsa, ikkalasida ham
o'zgaradi, burchakdagi tugmaning yozuvi ham.

### Mijoz **ko'rmaydigan** narsalar

- **Mashina qayerdaligi** — siz aytganingizdek, hozircha yo'q. Keyin har bir
  mijoz o'z yukini xaritada ko'radigan qilib qo'shamiz.
- **Tannarx, foyda, biznikiga tushgan puli** — bazada bir qadam narida
  turadi. Mijoz kabinetiga hech qachon tushmasligi uchun buni **test tekshirib
  turadi**: kelajakda kimdir e'tiborsizlik bilan qo'shib yuborsa, CI qizil
  bo'ladi.
- **Boshqa mijozning yuki** — quyida.

### Xavfsizlik: eng muhim qismi

Telegram ilovasi mijozning telefonida ishlaydi, ya'ni u yuboradigan **har
qanday ma'lumotni o'zgartirish mumkin**. Agar shunchaki «men falonchiman»
deganiga ishonilsa, mijoz raqamni almashtirib **boshqa mijozning yuki,
rasmlari va qarzini** ko'rar edi.

Shuning uchun Telegram har ochilganda **imzo** beradi, imzo esa bot tokeni
bilan tekshiriladi — token faqat serverda. Har bir so'rovda qayta
tekshiriladi. Buning uchun **28 ta test** yozilgan: imzoni buzib ko'rish,
boshqa bot tokeni bilan imzolash, eski imzoni qayta ishlatish, foydalanuvchi
raqamini almashtirish — hammasi rad etilishi kerak, va rad etilyapti.

Server tokenni yo'qotsa — kabinet **umuman ochilmaydi**. Tekshirmasdan
ochiladigan kabinetdan ko'ra ochilmagani yaxshi.

### CRM'da o'zgargani

Hech narsa. **Bazadagi mijozlar tegilmagan** — siz aytgan shart bajarildi:
bu bosqichda birorta mijoz ma'lumoti o'zgartirilmaydi, o'chirilmaydi.

### Sizdan nima talab qilinadi

1. `.env` faylida **`APP_URL=https://gsrwms.uz`** turgani tekshiring (avval
   `http://…` yoki IP bo'lgan bo'lsa — almashtiring). Telegram ilovani faqat
   haqiqiy HTTPS manzilda ochadi; `APP_URL` noto'g'ri bo'lsa tugma umuman
   qo'yilmaydi (bu ataylab: ishlamaydigan tugmadan ko'ra tugmasiz yaxshi).
2. Deploy qiling. Tugma **o'zi** qo'yiladi: yangi mijoz ulanganda darhol,
   eskilariga esa botga birinchi marta biror narsa yozganda.
3. `docs/BACKUP.md` va migratsiyalar bo'yicha oldingi vazifalar o'z kuchida.

## Mijoz tomoni, 1-qism: «yuk keldi» xabari + 3 til — 2026-07-27

### 1. Yuk skladga kelganda mijozga xabar ketadi

Ilgari mijoz **faqat Toshkentga yetganda** xabar olardi. Ya'ni yo'lning butun
birinchi yarmi — «tovarim yetdimi?» degan savol kuniga necha marta so'raladigan
qism — **jim** edi.

Endi Xitoy omboriga qabul qilinishi bilan:

> 📥 **Yukingiz omborimizga qabul qilindi**
> GS777 · YW-IN-260727-006
> Ombor: YW
>
> · A Чехлы — 6 dona
> · B 杂货 — 4 dona
>
> Jami: 10 dona · 68.5 kg · 1 m³

**Mahsulot nomi endi tarjimasi bilan chiqadi.** Ilgari xitoycha nom
saqlanardi va mijozga `手机壳` ko'rinardi — endi ruscha/o'zbekcha nomi
ustuvor, xitoycha faqat tarjima yo'q bo'lsa.

### 2. Uch til: o'zbek · rus · ingliz

Mijoz kabinetida endi **🌐 Til** tugmasi bor. Bosadi — o'zi tanlaydi.

Birinchi ulanganda til **Telegram'ining tilidan** avtomatik olinadi, lekin
faqat bir marta: mijoz o'zi tanlagandan keyin hech narsa uni o'zgartirmaydi.

Bitta odam bir nechta kod tutsa (777, 555, 444) — hammasi birga o'zgaradi.

### 3. Mijozlar ro'yxati bosh ekranga chiqdi

Ilgari u **eng oxirgi** bo'limda edi — mashina shablonlari va sozlamalardan
ham pastda, ya'ni yiliga ikki marta ochiladigan ekranlar orasida. Endi
**«Sotuv» bo'limining eng tepasida**, CRM va bitimlar yonida.

### Yo'l-yo'lakay topilgan 4 ta xato

1. **Mijozga ruscha xodim xabari chiqardi.** Botni shunchaki ochgan mijoz
   «Профиль → Подключить Telegram» degan yozuvni ko'rardi — noto'g'ri odamga,
   noto'g'ri tilda, mijoz ocholmaydigan ekran haqida.
2. **Bitta xabar ikki marta ketishi mumkin edi.** Bazada bitta mijoz-chat
   juftligi uchun ikkita yozuv bo'lsa, mijoz har xabarni ikki marta olardi.
3. **Botni bloklagan mijoz «xabar yetdi» deb hisoblanardi** — Telegram'ning
   javobi umuman o'qilmasdi.
4. **Tugmalar tarjima qilinsa kabinet o'lardi.** Tugma yozuvi ayni paytda
   botning «yo'naltiruvchisi» ham — rus tiliga o'tgan mijozning tugmalari
   umuman ishlamay qolardi. Endi hamma til birdan tanilади.

### Production ma'lumotiga tegilmadi

Sizning talabingiz bo'yicha tekshirdim: **migratsiya bironta mavjud mijoz
qatoriga tegmaydi.** `locale` ustuni **bo'sh (NULL) qilib** qo'shildi —
PostgreSQL bunda jadvalni qayta yozmaydi, 1700 qator ham, 100 000 qator ham
bir xil tez.

⚠️ Va eslatma: **`pnpm import-clients --apply --update` ni HECH QACHON
ishlatmang** — u 300 ga yaqin mijozning ismi, telefoni va sotuvchisini qayta
yozadi.

### Tekshiruv

Lint · typecheck · **428 test** (11 tasi yangi) · build · toza bazada
**50 e2e** — yashil.

**Migratsiya bor (0033).** Deploy oldidan backup oling.

## Backup Google Drive'ga chiqadi — 2026-07-27

Siz «Google Drive eng yaxshisi» dedingiz. Qilindi.

Bugungacha bazaning **hamma nusxasi bitta diskda** edi — tungi nusxa o'zi
himoya qilayotgan baza bilan bir mashinada. Server yo'qolsa ikkalasi ham
ketardi.

### Endi

Har kecha soat 02:00 da: baza nusxasi olinadi → **sizning Google
Drive'ingizga** yuklanadi → **hajmi tekshiriladi** → eskilari tozalanadi.

Drive'da **«GSR LOGISTICS backup»** papkasi o'zi yaratiladi. Oxirgi 30 ta
nusxa saqlanadi.

### Sozlash — bir marta, 15 daqiqa

Batafsil qo'llanma: **`docs/BACKUP.md`** (o'zbekcha, qadamma-qadam).

**🔴 Eng muhim qoida:** Google'da ilovani avval **«Publish»** qiling,
**keyin** token oling. Aks holda token **7 kundan keyin o'ladi** — backup bir
hafta ishlaydi, keyin jimgina to'xtaydi, va buni faqat tiklash kerak bo'lgan
kuni bilasiz. Qo'llanmada Publish 4-qadam, token esa 6-qadam — shu sababdan.

Token olish: `pnpm gdrive-auth` — skript hammasini so'raydi va oxirida `.env`
ga qo'yiladigan 3 qatorni beradi.

> Bu qatorlar parol. **Menga ham yubormang** — ular faqat serverdagi `.env`
> da turadi.

### Nima chiqadi, nima yo'q

| | Drive'ga |
|---|---|
| Butun baza: mijozlar, prixodlar, qutilar, pul, hujjatlar | ✅ |
| **Suratlar** | ❌ hali yo'q |

**Suratlar (~1–1.5 GB) hali chiqmaydi** — bazadan yuz barobar katta. Har
kecha 1.5 GB yuborilsa bepul 15 GB Drive 10 kunda to'ladi, shuning uchun
faqat yangi suratlarni yuboradigan alohida mexanizm kerak. **Ayting — keyingi
navbatda qilaman.**

### Yo'l-yo'lakay topilgan 3 ta xato

**1. Ikkita backup tizimi bir-birini ko'rmasdi.** Alohida konteyner nusxani
`backups` diskiga yozardi; ilovaning o'z nusxasi esa **konteyner ichiga**
tushardi va har deploy'da o'chib ketardi. Haftalik «tiklash mashqi» esa
o'sha o'chib ketadigan joyga qarardi — ya'ni **serverda hech qachon hech
narsa tekshirilmagan**. Endi ikkalasi bitta joyga yozadi.

**2. Alohida konteyner nusxasi `--no-owner`siz olinardi** — bunday nusxa
faqat aynan o'sha serverga tushadi. Boshqa kompyuterga yoki yangi provayderga
tiklamoqchi bo'lsangiz — har bir jadvalda xato berardi. Ya'ni aynan backup
kerak bo'ladigan holatda ishlamasdi.

**3. Telegram xabarlari o'z jadvaliga ega emasdi.** «Pending» yozilgan xabar
(digestlar, eslatmalar, va eng muhimi **«backup tiklanmayapti» ogohlantirishi**)
boshqa biror prixod tasdiqlanishini kutib turardi. Eng kechiktirib bo'lmaydigan
xabar eng kechikadiganlardan biri edi. Endi har daqiqada yuboriladi.

### Tekshiruv

Lint · typecheck · **417 test** (13 tasi yangi) · build · toza bazada
**50 e2e** — yashil. Google hisobisiz tekshirildi: o'lgan token, yarim
yuklangan fayl, tozalash qoidasi — hammasi test bilan qopланган. Eng muhim
test: **yuklash xato bergan kechada eski nusxa o'chirilmaydi.**

## Skanerlash tezligi + 3 ta jiddiy xato tuzatildi — 2026-07-27

### Skaner nega sekin edi

Har bir skandan keyin telefon **butun mashinani serverdan qaytadan yuklab olardi**. Rejali partiyada — hamma qutilar; tez partiyada esa yana ombordagi butun qoldiq ham (1500 tagacha, **~300 KB**). Har bir quti uchun. Yivudagi ombor wi-fi'sida.

Buning keragi yo'q edi: skanning **javobi** serverdan allaqachon kelayapti. Qaytadan yuklash faqat **boshqa telefonlar** nima skanerlaganini qo'shardi — va buni o'sha soniyada bilish shart emas.

**Endi:** skan — faqat skanni yuboradi. To'liq yangilanish **15 soniyada bir marta**.

**Nimadan voz kechdik:** ikkinchi yuklovchining ishi ekraningizda 15 soniyagacha kechroq chiqadi. Hisoblagich ilgari ham shunday ishlardi.

### Bazada yetishmayotgan indeks

«Bu quti shu mashinadami?» degan savol — yuklash ekrani, partiya taxtasi, mashinalar xaritasi, narx qo'yish va tannarx hisobi — hammasi shuni so'raydi. Bazada bu ustunga **indeks yo'q edi**, shuning uchun har safar butun jadval varaqlanardi.

Sizning haqiqiy ma'lumotingizda o'lchadim (10 920 quti, 26 180 harakat):

| | Ilgari | Endi |
|---|---|---|
| Iliq | 40 ms | **1.2 ms** |
| Sovuq | 380 ms | ~0 |
| Eng yomon holat | **9.6 soniya** | yo'qoldi |

**Nimadan voz kechdik:** ikkita indeks disk oladi (bir necha MB) va yozishni juda oz sekinlashtiradi. Migratsiya paytida jadval bir lahzaga qulflanadi — hozir 10 ming qatorda bu **millisekundlar**. 200 ming qutida esa bir necha soniya bo'lardi. **Shuning uchun hozir qilish arzon.**

### Sinab ko'rgan, lekin QAYTARIB olgan narsam

Skanlarni 350 ms to'plab, bittada yuborish — arzon foyda ko'rinardi. **Testlar xatoni tutdi:** yuklovchi oxirgi qutini skanerlab, o'sha soniyada «yuklashni tugatish»ni bosadi — va skan hali yo'lda. **Quti mashinada, ro'yxatda yo'q.**

Kechikishsiz qildim: skan darhol ketadi, faqat yo'lda turgan so'rov bo'lsa keyingilar bittaga qo'shiladi. Foyda bor, xavf yo'q.

---

## Uchta jiddiy xato tuzatildi

### 1. 💰 To'langan bitim qarzni yashirardi

Mijoz bitimni kechiktirdi (masalan 1000 $), keyin **to'ladi**. Lekin tizim hali ham «1000 $ kechiktirilgan» deb hisoblardi. Eshik esa qarzdan kechiktirilganni ayiradi.

Natija: mijozning **boshqa, eski 500 $ qarzi** bor bo'lsa ham — 500 − 1000 = manfiy → **eshik ochilardi**. Ombor yukni berardi, hech kim «ruxsat» bosmagan, jurnalda ham hech narsa yo'q.

Tuzatildi: kechiktirilgan deb **o'sha ish bo'yicha hali qarzdor bo'lgan summa** hisoblanadi. Ortiqcha to'lov ham boshqa qarzni yopmaydi.

### 2. ⚙️ Fon vazifalari jimgina o'lishi mumkin edi

Server ko'tarilganda 9 ta fon vazifasi ro'yxatdan o'tadi (**tungi backup**, backup tekshiruvi, tannarx qayta hisobi, digestlar). «Ishga tushdi» bayrog'i **ro'yxatdan o'tishdan oldin** qo'yilardi.

Bittasi xato bersa: qayta urinish «allaqachon ishga tushgan» deb hech narsani ro'yxatdan o'tkazmasdi — **va xato ham chiqmay qo'yardi**. Server sog'lom ko'rinardi, backup esa olinmasdi.

Tuzatildi: bayroq eng oxirida qo'yiladi.

### 3. 🧰 (o'tgan safar) Yashik skaneri

Yuqorida yozilgan.

---

### Tekshiruv

Lint · typecheck · **404 test** · build · toza bazada **50 e2e** — yashil. Pul xatosining testi eski kodda **yiqildi** (0 o'rniga 1000 chiqardi). Indeks o'lchovi sizning haqiqiy bazangizda, qaytariladigan tranzaksiya ichida qilindi — ma'lumotingizga tegilmadi.

**Migratsiya bor (0032).** Deploy qilishdan oldin backup oling.

## Skaner tuzatildi — yuklash yana ishlaydi — 2026-07-27

Siz aytdingiz: «eski versiyasi yaxshi ishlar edi, hozir 1 scan qilib ketidan noto'g'ri deyabti va umuman ishlamayabti, yuklatib bo'mayabti».

**Bu mening xatoim edi. Kechirasiz.**

### Nima bo'lgan

O'tgan safar «scan qilyapti, lekin mashinaga qo'shmayapti» degan xatoni tuzatgandim. O'shanda server yashiklarni **rad qilayotganini ko'rsatadigan qildim** — bu to'g'ri edi.

Lekin serverning **rad qilishi ham noto'g'ri** ekan, men buni ko'rmagandim. Ikkita holatda:

**1. Yashikni ikkinchi marta skanerlash.** Birinchi skandan keyin qutilar «yuklanmoqda» holatiga o'tadi. Server esa «rejada» holatidagilarni kutardi. Natijada — ikkinchi skan, yoki internet uzilib qayta yuborilgan skan, yoki ikkinchi telefondan skan → **«rejada yo'q»**.

**2. Yashikda reja tuzilgandan keyin qo'shilgan quti bo'lsa.** Ombordagi odam yashikka yana bitta quti sig'dirsa, butun yashik «rejada yo'q» bo'lib qolardi.

Ikkalasida ham qizil oyna ekranni yopib, **ostidagi skanerni o'chirib qo'yardi** — shuning uchun «umuman ishlamayabti».

Ilgari bu rad javoblari ekranda **ko'rinmasdi**, shuning uchun bilinmagan. Men ularni ko'rinadigan qildim-u, javobning o'zini tuzatmadim.

### Endi

- **Allaqachon yuklangan quti ham «shu mashinada»** hisoblanadi. Qayta skanerlash, internet uzilishi, ikkinchi telefon — hammasi normal ishlaydi.
- **Yashik — o'zining rejadagi qutilari bo'yicha baholanadi.** Rejadagilar yuklanadi.
- **Ortiqcha quti bo'lsa — ekran aytadi**: «🧰 CR-YW26-00001: 1 ta quti rejada yo'q — qo'shilsinmi?» Siz qaror qilasiz. Jimgina yuklab yubormaydi — chegaradan hujjatsiz yuk o'tishi aynan shundan boshlanadi.
- **«Baribir yukla» tugmasi** endi hisoblagichni darhol harakatga keltiradi (ilgari yashikda 15 soniya turib qolardi).

### Tekshiruv

Avval **xatoni takrorlaydigan 2 ta test** yozdim — ikkalasi ham eski kodda **yiqildi**. Keyin tuzatdim. Endi: lint · typecheck · **402 test** · build · toza bazada **50 e2e** — hammasi yashil.

**Darhol deploy qiling.**

## Chop etish oynasi — printer va sahifalarni tanlash — 2026-07-27

Siz aytdingiz: «print buttonini bosganda stikerlar ochilyabti, o'sha yerga print qilishni qo'shsa bo'ladimi — qaysi pagelarni qaysi printer deb belgilaydigan oyna borku».

**To'g'ri aytdingiz, va shu qilindi.**

### Nega ilgari bo'lmagan

Men sizga **PDF fayl** berayotgan edim. PDF — bu fayl, uni telefon ko'rsatib turadi, xolos. Chop etish oynasi PDF'da yo'q, ayniqsa ekranga chiqarilgan ilovada.

Siz so'ragan oyna — **telefonning o'zining chop etish oynasi**. U faqat oddiy sahifadan ochiladi, fayldan emas.

### Endi qanday ishlaydi

«🖨 Stiker chiqarish» tugmasini bosasiz →

**Stikerlar sahifa bo'lib ochiladi va chop etish oynasi o'zi chiqadi.** O'sha oynada:
- **qaysi printer** — ro'yxatdan tanlaysiz
- **qaysi sahifalar** — masalan «5–12» deb faqat kerakli stikerlarni
- nechta nusxa

Agar oynani tasodifan yopib yuborsangiz — yuqoridagi **«🖨 Chop etish»** tugmasi uni qayta ochadi.

### Bir ekranda uchta yo'l

Har xil telefonda har xili ishlaydi, shuning uchun uchalasi ham ko'rinib turadi — endi men sizga telefon orqali «u yerni bosing» deb tushuntirishim shart emas:

1. **🖨 Chop etish** — telefonning o'z oynasi (printer + sahifalar). Asosiy yo'l.
2. **📤 Printerga yuborish** — ulashish oynasi: AirPrint yoki printeringizning o'z ilovasi.
3. **Brauzerda ochish** — PDF. Androidda RawBT shuni ushlab printerga yuboradi.

### Ochig'ini aytaman

iPhone'da ekranga chiqarilgan ilovada chop etish oynasi ba'zi iOS versiyalarida ochilmasligi haqida xabarlar bor — **men buni tekshira olmadim**, chunki menda iPhone yo'q. Shuning uchun **📤 Printerga yuborish** tugmasini yashirmadim, o'sha yerda katta qilib qo'ydim. Agar birinchisi ishlamasa — ikkinchisi ishlaydi, va u ko'rinib turibdi.

**Telefoningizda sinab ko'ring va qaysi biri ishlaganini ayting.**

### Yo'l-yo'lakay topilgan haqiqiy xato — stikerda

Stikerlarning o'lchamlarini tekshirayotib **egasi noma'lum yuk stikerida xato** topdim.

Qutiga yozilgan belgi (masalan `444-A`) katta qilib bosiladi, va uning **ustiga** `#UNKNOWN` yozuvi tushib qolgan edi — 2 mm joyda ikkalasi ustma-ust. Aynan o'sha stiker odam «bu kimniki?» deb qaraydigan stiker.

Tuzatildi: `#UNKNOWN` endi belgidan **yuqorida** turadi, aralashmaydi. Bu ham PDF'da, ham yangi sahifada.

### Yana ikkita

- **Yashik (karkas) stikeri** — u hali ham eski usulda, tugmasiz oynada ochilardi. Endi u ham xuddi quti stikerlari kabi ishlaydi.
- **Bitta quti stikeri** — bitta qutining stikeri yirtilsa, ilgari butun lotni qayta bosishga to'g'ri kelardi. Endi quti kartasida «Stiker chiqarish» tugmasi bor.

### Tekshirildi

Lint · 396 test · build · toza bazada 50 e2e — hammasi yashil. Stikerni PDF va yangi sahifada yonma-yon chizib solishtirdim: bir xil.

## «Yangi versiya bor» tasmasi + iPhone'da chop etish tugmasi — 2026-07-27

Siz «deploy qildim lekin tugma chiqmadi» dedingiz. Tekshirdim: **tugma o'z joyida edi**. iPhone o'lchamidagi ekranda ochib ko'rdim — «🖨 Stikerlarni chop etish» tugmasi prixod kartasida ham, har bir lot yonida ham chiqib turibdi.

Ya'ni serverda yangi kod bor edi, **telefoningiz esa kechagi sahifani ko'rsatib turgan**.

### Nega shunday bo'ladi

Ilovani ekranga chiqarib olganingizda telefon uni **o'z xotirasiga saqlab qo'yadi** — internetsiz ham ishlashi uchun. Siz serverni yangilaganingizda telefon buni bilmaydi va eski sahifani ko'rsatishda davom etadi. Tugma serverda bor, telefonda yo'q.

Eng yomoni: **buni telefonni ushlab turgan odam bilib bo'lmaydi.** Bir haftada uch marta shu bo'ldi — ish bajarilgan, siz esa «ishlamadi» deb yozdingiz, va biz ikkalamiz ham deploy tushdimi yoki telefon eskimi — ajrata olmadik.

### Endi ilova buni o'zi aytadi

Serverda yangi versiya chiqsa, ekranning tepasida sariq tasma paydo bo'ladi:

> 🔄 **Ilovaning yangi versiyasi bor** — [Yangilash]

**«Yangilash» tugmasini bosasiz, tamom.** Ilova o'zi eski xotirani tozalaydi va yangisini yuklaydi. Endi hech kimga telefon orqali «sozlamalarga kiring, keshni tozalang» deb tushuntirish kerak emas — bu ishni tugma qiladi.

Tasma faqat haqiqatan eskirganda chiqadi, bekorga bezovta qilmaydi. Telefon cho'ntakda yotganda emas — **ekran yoqilgan payt** tekshiradi, chunki ombordagi telefon kun bo'yi cho'ntakda yotadi.

Bu hamma xodimga tegishli: skladchi ham, sotuvchi ham endi eski ekran bilan ishlab qolmaydi.

### Bundan tashqari — iPhone'da chop etish tugmasi haqiqatan ishlamayotgan edi

Bu mening xatoim edi, siz «ohwamadi» deganingizda topdim.

iPhone'da ulashish oynasi faqat **barmoq tekkan zahoti** ochiladi. Men esa avval PDF'ni serverdan yuklab, keyin oynani ochmoqchi bo'lganman — 100 ta stiker yuklanguncha iPhone «kech bo'ldi» deb oynani ochmay qo'yadi. **Tugmani bosasiz, hech narsa bo'lmaydi.** Aynan siz aytgan holat.

Tuzatildi: endi PDF **barmoq tushgan zahoti** yuklana boshlaydi, bosib bo'lgunicha tayyor turadi. Ulashish oynasi ochiladi.

Ikkinchi tuzatish: «brauzerda ochish» havolasi iPhone'da fayl yuklab olardi — va o'sha faylni yana **o'sha tugmasiz oynada** ochardi. Endi yangi oynada ochadi, u yerda panel bor.

### Sizdan hali javob kutayapman

1. **Printeringiz qaysi model?** AirPrint borligini aniqlab, aniq qadamlarni yozib beraman.
2. Server bazasida quyidagini ishlatib, natijasini yuboring — mendagi nusxa bilan farq bor:
   `docker compose exec db psql -U gsr -d gsr -c "SELECT count(*) jami, count(sales_manager_id) sotuvchili FROM clients;"`

## Telefondan stiker chop etish — 2026-07-27

Siz ilovani telefon ekraniga chiqarib olganingizdan keyin chop etish ishlamay qoldi, ayniqsa iPhone'da: «hech qanday tugmasiz stikerlar ro'yxati turibdi».

### Nega shunday bo'lgan

Bu tugmaning xatosi emas — **ekranga chiqarilgan ilova iPhone'da brauzer panelisiz ishlaydi**. PDF o'sha ilova ichida ochilganda **ulashish ham, chop etish ham, hech qanday tugma ham bo'lmaydi**. Stikerlar ko'rinib turadi, lekin ularni chiqarib olishning yo'li yo'q. Brauzerda ochilganda esa panel bor edi, shuning uchun ilgari ishlagan.

### Endi qanday

Har bir chop etish joyida **ikkita yo'l** bor, chunki telefonda bittasi bo'lmasligi mumkin:

**1. 🖨 tugmasi — telefonning o'z «ulashish» oynasini ochadi.** iPhone'da bu yerda **«Print»** turadi (AirPrint), va **Bluetooth printeringizning o'z ilovasi** ham shu ro'yxatda chiqadi. Bitta bosish: 🖨 → printer ilovasi. Androidda ham xuddi shunday ishlaydi.

**2. Ostida kichik havola — «Brauzerda ochish».** iPhone'da bu ilovadan Safari'ga chiqaradi, u yerda panel bor. Androidda esa **RawBT** o'sha PDF'ni ushlab, ulangan printerga jo'natadi — ilgarigidek.

Fayl nomi ham to'g'rilandi: `YW26-000123-A.pdf` — printer ilovasida qaysi stiker ekani ko'rinib turadi.

### Ochig'ini aytishim kerak

**iPhone brauzeridan Bluetooth printerga to'g'ridan-to'g'ri yozib bo'lmaydi.** Apple bunday imkoniyatni hech qachon qo'shmagan va qo'shmoqchi ham emas. Bu mening dasturimning chegarasi emas — iPhone'ning chegarasi. Kim «brauzerdan Bluetooth'ga chiqaraman» desa, u Android haqida gapiryapti.

Shuning uchun iPhone'da yagona to'g'ri yo'l — **ulashish oynasi orqali printer ilovasiga berish** yoki **AirPrint**. Men aynan shuni qildim.

Agar printeringiz **AirPrint'ni qo'llasa** — 🖨 → Print → printer, hech qanday qo'shimcha ilovasiz. Qo'llamasa — printer ishlab chiqaruvchisining iPhone ilovasini o'rnating, u ulashish ro'yxatida paydo bo'ladi.

**Printeringiz qaysi model ekanini ayting** — AirPrint bor-yo'qligini aniqlab, aniq qadamlarni yozib beraman.

**Tekshiruv:** 385 test + 44 e2e. E2E endi ikkala yo'lni ham tekshiradi. Migratsiya yo'q.


## ❗ Skaner: sanayotgan, lekin mashinaga qo'shmayotgan edi — 2026-07-27

Siz yuklash paytida aytdingiz, va bu jiddiy xato edi — **yuk mashinaga chiqib ketardi, tizimda esa yo'q bo'lardi**.

### Nima bo'lgan edi

1. Skladchi **yashikni** skanerlaydi.
2. Ekran darhol sanaydi, **yashil chaqnaydi va «ok» deb signal beradi**.
3. Skanerlash serverga ketadi.
4. Server: «bu yashik bu mashinaning rejasida yo'q» deb **rad etadi va hech narsa yozmaydi**.
5. **Ekranda bu rad javobiga hech qanday ishlov yo'q edi** — hech narsa ko'rinmasdi.
6. Navbat esa javob kelgani uchun yozuvni **o'chirib yuborardi**.
7. Qayta skanerlansa — «🔁 allaqachon skanerlangan» derdi.

Ya'ni: **sanoq oshdi, signal yashil, yuk mashinaga chiqdi — lekin manifestda, bojxona invoysida va tannarx hisobida u yo'q.** Va skladchi buni tuzata olmasdi.

### Nega yashik bilan sodir bo'lgan

Yuklash ekrani skladdagi **hamma yashiklarni** taklif qiladi, faqat shu mashinaga rejalashtirilganini emas. Kod esa yashikni **tekshirmasdan** qabul qilardi — «yashik bo'lsa bo'ldi» degan qisqa yo'l bor edi. Alohida karobkada bunday emas: u rejada bo'lmasa **qizil tasdiq ekrani** chiqadi. Yashik o'sha qizil ekranga umuman yetib bormasdi.

### Endi qanday

- **Yashik ham karobka bilan bir xil savolga javob beradi**: hamma karobkalari shu rejadami? Yo'q bo'lsa — **qizil tasdiq ekrani** chiqadi, skladchi sababini yozib ataylab qo'shadi. Bu ekran allaqachon bor edi, unga yo'l yo'q edi.
- **Server rad etsa — sanoq orqaga qaytadi**, ekran qizil chaqnaydi va sabab yoziladi. Ilgari faqat 2 xil rad javobi ko'rsatilardi, 6 tadan.
- Qoida kodga yozib qo'yildi: **serverga so'ramasdan ekranda ko'rsatilgan har qanday natija, javob boshqacha kelsa, orqaga qaytarilishi shart.**

### Nima qilish kerak

**Deploydan oldin:** yuklanayotgan mashinalarni tekshiring. Skaner yashil deganiga qaramay tizim yozmagan karobkalar bo'lishi mumkin — partiya kartochkasidagi son bilan mashinadagi haqiqiy sonni solishtiring. Farq bo'lsa, o'sha karobkalarni **qizil tasdiq orqali** qayta qo'shish kerak (deploydan keyin).

**Tekshiruv:** 385 test (5 tasi yangi) + 44 e2e. Xatoni ko'rsatadigan test yozildi va **tuzatishsiz yiqilishi** isbotlandi. Migratsiya yo'q.


## Mijoz bo'limi: to'rtta tuzatish — 2026-07-27

Auditda topilgan, hammasi mijoz bo'limiga tegishli.

**1. Kartochkani saqlash sotuvchini o'chirmaydi endi.**

Bu eng jiddiysi edi. Sotuvchi ro'yxatiga faqat «sotuv manageri» roli borlar tushardi. Agar mijozning sotuvchisi **siz**, **logist** yoki o'zingiz o'ylab topgan boshqa rolda bo'lsa — u ro'yxatda yo'q edi, brauzer bo'sh variantni tanlardi, va telefon raqamini to'g'rilash uchun bosilgan **«Saqlash» biriktiruvni o'chirib yuborardi**. Lid kartochkasida ham xuddi shunday.

Sizning haqiqiy ma'lumotingizda o'lchadim: **269 ta biriktirilgan mijoz**, ulardan **2 xil sotuvchi** ro'yxatga umuman tushmasdi.

Endi ro'yxat **rol nomiga emas, huquqqa** qarab yig'iladi — ya'ni siz `/admin/roles` da yangi rol o'ylab topsangiz ham u avtomat ishlaydi. Va **hozir biriktirilgan odam har doim ro'yxatda turadi**, hatto u ishdan chiqqan bo'lsa ham. Qoida oddiy: **forma ko'rsata olmaydigan qiymatni forma o'chirib yuboradi.**

**2. Mijozlar ro'yxati logistga ochiladi.**

Logist mijoz yaratadi, kartochkasini tahrirlaydi, Telegram havolasi beradi — lekin ro'yxatning o'zi «omborlarni boshqarish» huquqini so'rardi, u esa logistda yo'q. Menyuda «Mijozlar» yozuvi turardi, bosardi — bosh sahifaga qaytarardi. Excel ham xuddi shunday.

Uchtasi ham endi bir xil huquqni so'raydi. Yo'l-yo'lakay o'zim qilgan xatoni ham topdim: menyuni tozalaganimda logistdan mijozlarni olib tashlab qo'ygan ekanman — qaytardim.

**3. Telefon bo'yicha mijoz topiladi.**

Mijoz qo'ng'iroq qilganda menejer qo'lida raqam bo'ladi — lekin qidiruv faqat kod va ismni bilardi. Endi telefon ham. Raqamni **qanday yozsangiz ham** topadi: `+998 90 175 78 00`, `998901757800`, `901757800`, hatto oxirgi 7 ta raqam. Bu Telegram kabinetdagi tekshiruv qoidasi bilan bir xil — **oxirgi 9 raqam**, chunki mamlakat kodini taxmin qilish bir odamni boshqasining yukiga bog'lab qo'yishi mumkin.

Qisqa raqam (5 tadan kam) telefon qidiruvini **ishga tushirmaydi** — aks holda `444` degan haqiqiy mijoz kodini qidirganingizda yarim kitob chiqib kelardi.

**4. Ro'yxat «200 ta» deb yolg'on gapirmaydi.**

Ekran 200 tada to'xtardi va tepasida «200» deb yozardi — ya'ni sizga mijozlaringiz 200 ta deb aytardi. Endi **«313 tadan 200 tasi»** deb yozadi va «qidiruvni aniqlashtiring» deb ogohlantiradi. Excel ham xuddi shu chegara bilan ishlaydi.

**Tekshiruv:** 380 test (10 tasi yangi) + 44 e2e (1 tasi yangi), toza bazada CI tartibida. Har bir tuzatish uchun test bor va **tuzatishsiz yiqilishini** ko'rsatdim.


## Bitim (deal) — kelishilgan narx bilan haqiqat yonma-yon — 2026-07-26

Siz 26-iyulda men bilan to'liq kelishib olgan, lekin hali qurilmagan eng katta narsa shu edi. Endi bor.

### Nima uchun

Sizning so'zingiz bilan: klientga **1 kub / 100 kg — 200$** deyiladi. Yuk skladga kelganda **1.4 kub** chiqadi. Sotuv manageri ko'rib qolsa — qayta hisoblab, klientga aytadi; klient rozi bo'ladi yoki yukini qaytarib oladi. **Ko'rmasa** — yuk Toshkentga yetib boradi va «narxi qimmat chiqdi» degan janjal boshlanadi.

Muammo «yozuv yo'q»ligida emas — hammasi Telegram va Excelda bor. Muammo **kelishilgan narx bilan haqiqatda chiqqan narsa orasidagi farqni hech kim o'z vaqtida ko'rmasligida**.

### Bitim nima

Bitta mijozning bitta ishi — «narx ayting» dan «to'landi» gacha. **Ikkita ustun yonma-yon:**

| Kelishilgan | Haqiqatda |
|---|---|
| Hajm, og'irlik, summa — **odam yozadi** | Hajm, og'irlik, karobkalar — **prixodlardan o'zi qo'shiladi** |

Haqiqat tomonini **hech kim qo'lda kirita olmaydi**. Buni ataylab shunday qildim: agar u yerga ham qo'lda yozish mumkin bo'lsa, birinchi marta kimdir «to'g'rilab» qo'yishi bilan butun taqqoslashning ma'nosi yo'qoladi.

### Eng muhimi — ogohlantirish

**Prixod tasdiqlangan zahoti** tizim solishtiradi va sotuv managerga xabar yuboradi:

1. **Yuk umuman narxsiz keldi** → «GS777 dan narxi kelishilmagan yuk: 1.4 kub, 180 kg — narx qo'ying». Sizning aytishingizcha bu «qimmat chiqdi» shikoyatlarining eng katta manbasi.
2. **Bitim bor, lekin farq chegaradan oshdi** → «Kelishilgan 1.0 kub / 200$, haqiqatda 1.4 kub, **+40%**. Fakt bo'yicha qayta hisob: **280$**».

**Yuk hali Xitoyda turganida** ketadi — ya'ni klient hali «unda orqaga qaytaring» deya oladigan paytda. Toshkentdagi janjal aynan shu yerda oldi olinadi.

**Yuklashni hech qachon to'xtatmaydi** (sizning javobingiz: «10% dan oshsa xabar, lekin bloklamasin»). Chegara — **sozlama**, hozir 10%, Sozlamalardan o'zgartiriladi.

Ikkita nozik joy, ikkalasini ham test topdi:

- **Yuk bo'lib kelsa — bekorga qo'ng'iroq qilmaydi.** Bugun yarmi, ertaga yarmi kelsa, birinchi yarmi «50% kam» bo'lib ko'rinadi. Agar shunga xabar yuborilsa, har bir bo'lib kelgan yukda yolg'on signal ketardi va bir oyda hech kim bu xabarlarni o'qimay qo'yardi. Shuning uchun **faqat ko'p chiqqanda** xabar ketadi; kam chiqqani kartochkada ko'rinadi, lekin xabar qilinmaydi.
- **Solishtirish butun bitim bo'yicha**, bitta prixod bo'yicha emas. Ikkinchi yarmi kelganda bitim yana me'yorga qaytadi.

### To'lovni kechiktirish — «hammasi kelganda to'layman»

Siz aytgan holat: 10 ta karobkadan 9 tasi keldi, 1 tasi kech qoladi, klient «hammasi kelsin, keyin to'layman» deydi.

Bu **mijozga emas, bitimga** yoziladi. Sababi oddiy: mijozga yozilsa u **abadiy** bo'lib qoladi, hamma unutadi, va qarz nazorati shu bilan o'ladi. Bitimga yozilsa — faqat o'sha ishga tegishli.

Har bir kechiktirishda: **sabab**, **kim ruxsat berdi**, va **qachongacha**. Muddat ikki xil bo'ladi — sana, yoki **«butun yuk yetib kelguncha»**. Ikkinchisi **o'zi tugaydi**: tizim bitimda nechta karobka borligini va nechtasi yetib kelganini biladi, oxirgisi yetib kelganda kechiktirish avtomat yopiladi va ruxsat bergan odamga xabar ketadi. Hech kim eslab turishi shart emas.

**Yo'qolgan karobka kutilmaydi** — u hech qachon kelmaydi, va uni kutish kechiktirishni abadiy ochiq qoldirardi.

Ruxsat: `finance.debt_override` — bu allaqachon bor va aynan shuni bildiradi.

### Qayerda ko'rinadi

- **`/bitimlar`** — kanban taxta, lidlar voronkasi bilan bir xil ko'rinishda (odamlaringiz uni allaqachon biladi). Ustida **«E'tibor kerak»** ro'yxati: qaysi ishlar noto'g'ri ketyapti. Taxta «hammasi qayerda» ga javob beradi, bu ro'yxat esa «nima yonyapti» ga — va odam ilovani aynan shuning uchun ochadi.
- **Bitim kartochkasi** — ikkita ustun, farq foizda, taklif qilingan yangi summa (bu **faqat taklif** — narxni odam qo'yadi), qatorlar, bog'langan prixodlar, vazifalar, o'z maydonlaringiz, tarix.
- **Mijoz kartochkasida** — o'sha mijozning bitimlari, qaysi biri chetga chiqqani bilan. Sotuvchi telefon qilishdan oldin shu yerga qaraydi.
- **Qabul ekranida** — mijoz tanlangach, uning ochiq bitimlari ro'yxati chiqadi. Skladchi yukni o'z ishiga bog'laydi. **Bu — butun ogohlantirish shu bir tanlovga bog'liq**, shuning uchun uni skladchidan yashirmadim.

Bosqichlar: Narx so'raldi → Narx berildi → Yuk kutilmoqda → Skladda → Yo'lda → Yetkazildi → To'landi / Bekor qilindi. Bular **jadval**, ya'ni keyin o'zingiz nomini o'zgartirasiz.

### Ruxsatlar

Yangi ruxsat kodi **yaratmadim** — ataylab. Yangi kod rollarga faqat seed orqali yetadi, seed esa siz tahrirlagan rolni chetlab o'tadi (#170), ya'ni sizning bazangizda ekran **hech kimga berib bo'lmaydigan** holga tushib qolardi. Bitimni **sotuv manageri ham, VED manageri ham** ochadi (sizning javobingiz: «ikkalasi») — mavjud kodlar bilan.

### Pul: bitimga hisob yozish

Kechiktirish faqat gapda qolmasligi uchun bitta narsa yetishmayotgan edi: **qarz darvozasi uni ko'rmasdi**. Ya'ni siz «hammasi kelganda to'laydi» deb yozardingiz, sklad esa baribir yukni bermasdi — operator yana «ruxsat» tugmasini bosardi va sabab yana Telegramda qolardi.

Endi: bitim kartochkasidan **mijoz hisobiga summa yoziladi** (kelishilgan narx, yoki yuk katta chiqqan bo'lsa qayta hisoblangan summa — o'zi taklif qilinadi). Aynan **shu yozuv** kechiktirish ostiga tushadi.

Ikkita nozik joy:
- **Mijozning qarzi kamaymaydi** — ekranda to'liq summa turadi. Faqat **darvoza qaraydigan raqam** kamayadi. Tizim qarzni yashirmaydi.
- **Eski qarz baribir to'sadi.** Kechiktirish bitta ishga berilgan, mijozga emas — shuning uchun partiya bo'yicha yozilgan eski qarz o'z holicha to'sib turaveradi. Test buni alohida tekshiradi.

Berish ekranida endi sabab yozilib turadi: «shundan 200$ bitim bo'yicha kechiktirilgan — berishni to'xtatmaydi». Aks holda operator ochiq darvozani xato deb o'ylab ofisga qo'ng'iroq qilardi.

### Nima qilinmadi

- **Shikast uchun chegirma** — jadval va sabab majburiyati tayyor, formasi keyingi bosqichda.
- **50 ta tovarli faylni o'qish va TN VED bo'yicha guruhlash** — bu alohida ish, `ANTHROPIC_API_KEY` serverga qo'yilgandan keyin.
- **Bitim bo'yicha foyda** — tannarx mexanizmiga ulanishi kerak, keyingi bosqich.

**Tekshiruv:** 368 test (32 tasi yangi) + 43 e2e (2 tasi yangi) — toza bazada, CI tartibida, hammasi yashil. Migratsiya 0030 — faqat **qo'shadi**, bironta ustunni o'zgartirmaydi.


## Dostuplar va tozalash: kimga nima ko'rinadi — 2026-07-26

Sizning so'zingiz bilan: «mening kunim / kalendarlar skladchiga ko'rinishi shart emas … dostuplarni kimga nimalar ko'rinishini yahwilab organ va to'g'irla … juda ko'p funksiyalar bo'lib ketti».

Ikkita **butunlay boshqa** ish qildim va ularni ataylab aralashtirmadim. Birinchisi — **ortiqcha narsalarni yashirish** (xavfsizlikka aloqasi yo'q). Ikkinchisi — **haqiqiy teshiklarni yopish** (men tekshirganimda topilgan, va ochig'i, bir nechtasi jiddiy edi).

---

### 1. Menyu endi har kimning ishiga qarab

Ilgari menyuda 8 ta bo'lim **hech qanday ruxsat so'ramas edi** — ya'ni ular *hammaga* ko'rinardi. Kalendar, «mening kunim», mashinalar taxtasi, xarita — skladchining telefonida ham turardi. Buni faylni o'qib topib bo'lmaydi: xato aynan **hech narsa yozilmagan** qatorlarda edi, shuning uchun har bir rol uchun har bir bo'limni sanab chiqadigan skript yozdim.

Natija (menyudagi bo'limlar soni):

| Rol | Ilgari | Endi |
|---|---|---|
| Sklad operatori | 15 | **8** |
| Sklad boshlig'i | 15 | **11** |
| Sotuv manageri | 14 | **9** |
| VED manager | 11 | **8** |
| Buxgalter | 13 | **10** |
| Logist | 22 | **13** |
| Kuzatuvchi | 10 | **5** |
| Siz (super admin) | 27 | **27** — o'zgarmadi |

**Skladchi endi faqat sklad ishini ko'radi:** qabul, kutilayotgan yuklar, partiyalar, berish, yashiklar, qoldiq, prixodlar. Kalendar ham, «mening kunim» ham, CRM ham, buxgalteriya ham yo'q.

Uchta muhim jihat:

**a) Bu ruxsat emas, tozalash.** Menyudan yashirish hech kimga hech narsa **qo'sha olmaydi** — faqat olib tashlaydi. Kod shunday yozilgan (`ruxsat bor && kerakli`), va buni test tekshiradi. Ya'ni bu ikkinchi, chalkash ruxsat tizimiga aylanib ketmaydi.

**b) Siz yangi rol o'ylab topsangiz — u to'liq menyuni oladi.** `/admin/roles` da yaratilgan rol uchun ro'yxat yo'q, demak u ochiq bo'lib qoladi. Bo'sh ilova bilan qolib ketish — eng yomon variant. Keyin kerak bo'lsa toraytiramiz.

**c) Ish yo'qolib qolmaydi.** `/bugun` skladchining menyusidan chiqdi — lekin unga topshirilgan vazifa **bosh ekranda** ko'rinadi: 🔴 kechikkan yoki 🟡 bugunga, soni bilan, bosilsa o'sha ro'yxatga olib boradi. Bu shart edi: menyuni tozalash ishni yo'qotishga aylanib qolsa, bu tozalash emas. Test ikkala tomonni bitta faylda tekshiradi.

Kuzatuvchi rolida yana bitta eskidan kelayotgan xato chiqdi: telefonning pastki panelida **atigi 2 ta tugma** turardi (o'rniga 4 ta). To'g'rilandi.

---

### 2. Endi haqiqiy teshiklar — bularni topganimda kutmagan edim

**a) 5 ta admin sahifada umuman tekshiruv yo'q edi.**
`/admin/users`, `/admin/users/new`, `/admin/users/<id>`, `/admin/warehouses/new`, `/admin/warehouses/<id>`, `/admin/clients/new` va `/admin/settings`.

Ular «admin bo'limi» darvozasi ortida turardi — lekin o'sha darvoza `clients.view_own` yoki `crm.leads` bo'lgan **har qanday odamni**, ya'ni **har bir sotuv managerini** kiritadi. Ya'ni sotuv manageri manzilni qo'lda yozsa, **yangi login yaratadigan va rol beradigan ishlaydigan forma** ochilardi. Yana ikkitasi noto'g'ri ruxsatni tekshirardi (xodimlar ro'yxati va sozlamalar «omborlarni boshqarish» ruxsatini so'rardi).

Endi har bir sahifa **o'zining** ruxsatini tekshiradi.

**b) Ombor cheklovi 13 ta joyda teshik edi.**
Kod shunday yozilgan edi: «agar odam omborga bog'langan **va** omborlari bo'lsa — filtrla, aks holda — filtrlama». Ikkinchi qismi xato: omborga bog'langan, lekin **hali hech qaysi omborga biriktirilmagan** odam (yangi ishga kirgan, yoki biriktiruvi olib tashlangan) **butun kompaniyaning** yukini ko'rardi. Jimgina, va aynan ochib yuboradigan tomonga.

Endi bitta yordamchi funksiya bor va u **«filtrsiz»ni umuman ifodalay olmaydi**: bog'lanmagan → filtr yo'q; omborlari bor → o'shalar; omborsiz → **hech narsa**. Xatoning shakli muhim: eski yozuvni to'g'ri yozish va noto'g'ri yozish ko'zga bir xil ko'rinadi, shuning uchun u shuncha vaqt turgan.

**c) Ro'yxatlar cheklangan edi, kartochkalar — yo'q.**
`/receipts` Yiwu operatoriga Guanchjou prixodini hech qachon ko'rsatmasdi. `/receipts/<id>` esa — **doim** ko'rsatardi. Bu yerda havolalar Telegramda kun bo'yi yuriladi. Endi prixod, yashik, reja, partiya va karobka kartochkalari ham tekshiradi.

Ikkita nozik joy: **partiya** ikkala uchida ham ko'rinadi (u yetib borgunicha jo'natgan omborniki, keyin qabul qilgannikki — ikkalasiga ham kerak), **karobka** esa hozirgi ombori yoki uni qabul qilgan omborda ko'rinadi (ko'chirilgan karobkani uni joylagan odam ko'ra olishi kerak).

**d) Vazifani istalgan odam yopa olardi.**
Vazifa mexanizmi faqat «tizimga kirganmi» deb tekshirardi. Ya'ni har qanday xodim, id sini bilsa, **kompaniyadagi istalgan vazifani** yopishi, bekor qilishi yoki boshqaga o'tkazishi mumkin edi — va tarixda «ataylab qildi» deb yozilardi. Endi: **kimga berilgan**, **kim bergan**, va hammaning ishini ko'rish huquqi borlar. **Yaratish ochiq qoladi** — bu yerda hamma bir-biridan kun bo'yi narsa so'raydi, muammo hech qachon bunda emas edi.

Yana bittasi: VED managerga menyuda **partiyalar** yo'q edi — bojxona hujjatlari aynan partiya kartochkasida turadi. Qo'shildi.

---

### Nima qilinmadi va nega

To'rtta narsani **ataylab** qoldirdim, chunki hozir qilinsa ishlab turgan narsani buzardi:

1. **Sotuvchi faqat o'z mijozini ko'rsin.** Bu to'g'ri, lekin hozir mijozlarning deyarli hech biriga sotuvchi biriktirilmagan — 17 ta sotuvchi login hali yaratilmagan. Bugun yoqsam, sotuv bo'limi ertaga **bo'sh ro'yxat** ochadi. Avval loginlar, keyin `pnpm import-clients --apply --update`, keyin bu.
2. **Ombor cheklovi rol nomiga emas, rol sozlamasiga bog'lansin.** Hozir «bu rol omborga bog'lanadimi» degan javob ikkita rol nomiga qattiq yozilgan — siz yangi sklad roli o'ylab topsangiz, u **cheklovsiz** tug'iladi. To'g'rilash kerak, lekin bu `roles` jadvaliga ustun qo'shish, ya'ni migratsiya — alohida qadam.
3. **Fayllarga (rasm/hujjat) ruxsat tekshiruvi.** Hozir havolani bilgan tizimdagi odam ochadi. To'g'ri yechim — avval faqat **log yozadigan** rejimda qo'yib, kim nimani ochayotganini bir hafta kuzatish; to'g'ridan-to'g'ri yopsam, ishlab turgan biror jarayonni bilmasdan sindirishim mumkin.
4. **Lid tahrirlashda egalik tekshiruvi** — yuqoridagi 1-band bilan bir paytda qilinishi kerak.

---

**Tekshiruv:** 336 test (14 tasi yangi) + 41 e2e (4 tasi yangi) — hammasi yashil, toza bazada, CI dagi tartibda. Lint va typecheck toza. Ishlab turgan bironta ekran o'zgarmadi.


## 3-bosqich davomi: takror, mashinalar kalendarda, rahbarga xabar — 2026-07-26

To'rtta savolimga javobingiz bo'yicha:

**1. Kim kimga vazifa bera oladi — cheklov yo'q.** Hozirgidek qoldi: hamma hammaga.

**2. Mashinalar endi kalendarda.** Har kunda ko'rinadi:
- 🚚 qaysi partiya **yo'lga chiqdi** (YW → TAS, mashina raqami bilan)
- 🏁 qaysi biri **yetib keldi**
- 📦 qaysi mijozdan **yuk kutilmoqda** (va'da qilingan sana bo'yicha)

Bular **alohida saqlanmaydi** — partiyaning o'zidan o'qiladi. Ya'ni partiya kartochkasida sanani tuzatsangiz, kalendarda ham o'sha zahoti to'g'rilanadi; ikkalasi bir-biriga zid bo'lishi mumkin emas. Yuqoridagi 🚚 tugmasi bilan yoqib-o'chiriladi (sotuvchiga kerak emas — u faqat o'z ishini ko'radi).

**3. Takrorlanuvchi vazifa bor** — har kuni / har hafta / har oy. Ikkita muhim jihat:
- **Keyingisi vazifa yopilganda tug'iladi**, oldindan emas. Ya'ni bir vaqtning o'zida **doim bitta ochiq nusxa** bo'ladi. Aks holda bir oy ta'tildan keyin «har dushanba kassani tekshir» ning 4 ta bajarilmagan nusxasi ekranda turardi — va odam bunday ro'yxatni bir haftada o'qimay qo'yadi.
- **Muddat asosida sanaladi, bajarilgan vaqtdan emas.** Dushanbaning ishini shanba kuni bajarsangiz — keyingisi **keyingi dushanba**, shanbadan bir hafta keyin emas. Kechikib bajarsangiz — kelajakka suriladi, yana o'tmishga tushmaydi. «Har oyning 31-i» esa fevralda **28-iga** tushadi, mart oyiga sakrab ketmaydi.
- **To'xtatish — bekor qilish.** Bajarish davom ettiradi, bekor qilish seriyani tugatadi. Qo'shimcha tugma kerak emas, ma'nosi ham to'g'ri: «buni qilmayman» va «bu bizga umuman kerak emas».

**4. Kechikkan vazifa haqida ikkalasiga xabar ketadi** — xodimga ham, **vazifani bergan odamga** ham. «Siz bergan vazifalar kechikdi (3)» degan alohida xabar, kimga berilgani va qancha kechikkani bilan. O'ziga o'zi qo'ygan vazifa ikki marta yuborilmaydi.

Rahbar sifatida vazifani bergan odam olinadi — tizimda «boshliq-xodim» ierarxiyasi yo'q, va uni shu bitta xabar uchun yaratish haqiqiy tuzilma yonida ikkinchi, hech kim yangilamaydigan tuzilma bo'lardi. Ishni siz bergan bo'lsangiz — siz kutyapsiz, demak sizga aytish kerak.

320 test + 37 e2e yashil.

## 3-bosqich: vazifalar va kalendar — 2026-07-26

Xodimlar bir-biriga ish topshiradigan joy. Ilgari bu Telegramda edi: kim nima qilishi kerakligi yozishmada qolib ketardi, kim bajardi — bilinmasdi.

**«Mening kunim» (`/bugun`)** — ertalab ochiladigan bitta ekran:
- 🔴 **Kechikkan** — muddati o'tgan ishlar, tepada
- 🟡 **Bugunga**
- 📞 **Bugun qo'ng'iroq qilinadiganlar** — CRM'dagi eski ro'yxat, o'sha joyida
- ⚪ **Muddatsiz** — pastda, chunki uni e'tiborsiz qoldirish hech qachon xato emas

Vazifa **har qanday yozuvga ilinadi**: mijoz kartochkasidan, prixoddan, partiyadan, lid'dan, yuklash rejasidan, yashikdan. Ya'ni ombor boshlig'i prixodni ko'rib turib, o'sha yerdan VED managerga «kubini qayta hisobla» deb topshiradi — qaysi prixod ekanini tushuntirib o'tirmaydi, vazifada havola turadi.

**Har bir vazifada:** nima qilish kerak, kimga, muddat (sana yoki sana+vaqt), turi (📞 qo'ng'iroq / 🤝 uchrashuv / 🧮 hisoblash / 📄 hujjat / 💰 to'lov — bu ro'yxat tahrirlanadi), muhimligi, izoh.

**Yopishda natija so'raladi** — «nima bo'ldi?». Bu ortiqcha rasmiyatchilik emas: «qo'ng'iroq qildim, dushanba kuni tasdiqlaydi» — bu yagona qoladigan iz. Natijasiz yopiladigan maydonni odamlar bir haftada bezak deb bilib qoladi.

**Kalendar (`/kalendar`)** — oy to'ri, har kunda nima borligi ko'rinadi. Kunni bosib to'liq ro'yxatini ko'rasiz. Oy o'zgartirish — havola, ya'ni oyni **birovga yuborsa bo'ladi**. Rahbar boshqa xodimning yoki hammaning kalendarini ko'ra oladi.

**Telegram:** ertalab **08:00** da har bir xodimga **shaxsan o'ziga** «bugun sizda nima bor» xabari ketadi (kechikkanlari alohida). Hech narsa bo'lmasa — **xabar yubormaydi**: doim bo'sh keladigan kundalik xabar odamni o'qimaslikka o'rgatadi. Profil sozlamalarida buni alohida o'chirish mumkin — ataylab «kunlik xabarlar» guruhidan ajratildi, chunki ombor hisobotini o'chirgan odam «o'z ishim haqida ham aytmang» demagan.

**Nima buzilmadi:** CRM'ning «bugun qo'ng'iroq» mexanizmi **tegilmadi**. U ishlayapti va sotuvchilar har kuni ishlatadi; uni vazifaga aylantirib bitta chiroyli ro'yxat qilish — ishlaydigan ekranni yangisiga almashtirish bo'lardi. `/crm/today` ham o'z joyida qoldi, `/bugun` esa ikkalasini bir joyda ko'rsatadi.

**Ikkita mayda, lekin muhim qaror:**
- «Juma» deb qo'yilgan muddat — juma kunining **oxiri**, boshi emas. Aks holda butun kompaniya juma kuni ertalab soat 00:01 dan «kechikdingiz» degan qizil ro'yxatni ko'rardi.
- Vazifa **o'chirilmaydi, bekor qilinadi**. Kimgadir topshirilgan va keyin «kerak emas» deyilgan ish — bu ham ishning qanday ketgani haqidagi ma'lumot.

**Yangi huquq kodi yo'q** — hammada vazifa bo'ladi, ya'ni kirish uchun tizimga kirgan bo'lish yetarli. 20 kishilik kompaniyada «kim kimga vazifa bera oladi» matritsasini hech kim yuritmaydi.

314 test + 37 e2e yashil.

## 2-bosqich: har joyda «o'zim qo'shgan maydonlar» — 2026-07-26

Custom maydonlar mexanizmi bor edi, lekin faqat **ikkita** obyektga: lid va mijoz. Qaysi obyektlar ruxsat etilganini baza darajasida CHECK bog'lab turardi va uni o'zgartirish uchun beshta faylni bir vaqtda tahrirlash kerak edi. Endi bu **platforma qatlami**: prixod, quti, yashik, partiya, yuklash rejasi, ombor, xodim, mashina, xarajat — hammasiga maydon qo'shasiz.

**`Sozlamalar → Maydonlar va obyektlar`** (`/admin/fields`) — bitta ekran, obyektlar bo'yicha guruhlangan:

- **12 xil maydon turi**: matn, uzun matn, son, sana, ro'yxatdan bittasi, ro'yxatdan bir nechtasi, belgi (galochka), telefon, havola, **pul (summa + valyuta)**, **yozuvga havola** (mijoz / xodim / ombor / mashina) va **fayl**.
- **Tekshiruv qoidalari** — min/maks son, min/maks belgi, shablon (regex). Server ham, telefon ham tekshiradi.
- **Shartli ko'rinish** — «Hujjat raqami» maydoni faqat «Hujjat turi = Shartnoma» bo'lganda chiqadi. Sahifa qayta yuklanmaydi, darhol ochiladi.
- **Izoh** — maydon ostida turadigan tushuntirish («Kub — m³ da»).
- **«Ro'yxatda»** belgisi — maydon mijozlar ro'yxatida **ustun** bo'lib chiqadi, **filtr** paydo bo'ladi va **Excel**ga tushadi.

**Filtr, saralash, Excel** (siz «to'liq kerak» degandingiz):
- Ro'yxat tepasida har bir maydon uchun filtr. Son uchun `>10`, `<10`, `5..9` yoziladi; sana uchun `2026-01-01..2026-03-01`; matn uchun ichida qidiradi; ro'yxat uchun tayyor tanlov.
- Ustun sarlavhasini bosib saralaysiz. **Son son bo'lib saralanadi** — bu bejiz emas: eski saqlash usulida «5» «40» dan keyin turardi. Endi har bir javob **o'z turidagi ustunda** yotadi.
- **⬇ XLSX** tugmasi — ekranda nima ko'rinsa, o'shani yuklab beradi (filtri bilan). Filtrlangan ro'yxat filtrsiz eksport bo'lishi — mijozga noto'g'ri fayl jo'natishning eng oson yo'li.

**Ma'lumot yo'qolishiga qarshi choralar** (bu qismga ko'p vaqt ketdi):
- **Yashirilgan maydon o'chirilmaydi.** Shart o'zgargani uchun maydon ko'rinmay qolsa, unga yozilgan javob **joyida qoladi**. Aks holda bitta dropdownni o'zgartirish butun bazadagi javoblarni jimgina o'chirib yuborardi.
- **Boshqa maydon bog'liq bo'lgan maydonni o'chirib bo'lmaydi** — avval bog'liqni oling. Aks holda «ko'rsatilsin, agar…» hech narsaga ishora qilib qolardi va bog'liq maydon hamma kartochkadan yo'qolardi.
- **Turini o'zgartirib bo'lmaydi** — javoblar boshqa ustunda yotibdi.
- **Zanjir shart yo'q** (A → B → C) — bu bog'liqlik grafi, birinchi halqa sahifani osib qo'yardi.
- Maydonni o'chirishdan oldin **nechta javob o'chishi** aytiladi.

**Ko'chirish (migratsiya) haqida.** Jonli bazangizdagi 76 ta javob yangi ustunlarga ko'chiriladi va tekshirildi — nusxada sinab ko'rildi, bitta javob ham yo'qolmadi. Migratsiya bitta tranzaksiyada, ya'ni biror joyda xato chiqsa baza **butunlay eskiday qoladi**.

**Boshqa o'zgarishlar:**
- Maydonlar `/crm/settings` dan chiqdi (u yerda havola qoldi) — ikkita tahrirlagich bitta jadvalga yozishi, biri eskirib qolishining eng qisqa yo'li.
- Mijoz kartochkasidagi maydonlar endi CRM huquqiga bog'liq emas: mijozlarni boshqaradigan, lekin CRM'ga kirmaydigan odam ham ko'radi va to'ldiradi. Sotuvchilar ilgarigidek to'ldiraveradi.
- **Yangi huquq kodi qo'shilmadi** — atayin. Yangi kod faqat seed orqali rollarga yetadi, seed esa siz tahrirlagan rolga tegmaydi (1-bosqich), ya'ni siz `super_admin`ni tahrirlagan bo'lsangiz ekran hech kimga ochilmay qolardi. Shu sababli ishlatilmay turgan `admin.dictionaries.manage` kodi olindi — u hamma bazada `super_admin` va `admin`da allaqachon bor.
- Lid yaratish shaklidagi custom maydonlar endi **lid saqlanishidan oldin** tekshiriladi: ilgari xato chiqsa lid yaratilib bo'lgan, ekranda esa «xato» yozuvi turardi.

**Bu bosqichda qilinmagani:** formula maydoni (siz sanagan ro'yxatdan) — bu alohida loyiha, va aytgan hisob-kitoblaringiz (tannarx, zichlik, foyda) allaqachon kod bilan sanaladi. Custom **obyekt** (o'zingiz o'ylab topgan yangi ro'yxat) — keyingi bosqichda; buning uchun poydevor solindi (obyektlar ro'yxati endi jadval).

297 test + 32 e2e yashil.

## 1-bosqich: rollar konstruktori — kim nimani qila olishi endi sozlama — 2026-07-26

Shu paytgacha «kim nimaga ruxsatli» degan savolning javobi **kodda** turardi (`ROLE_MATRIX`) va bazaga faqat bir marta, seed orqali tushardi — faqat **qo'shish** mumkin edi. Rolga bitta huquq qo'shish uchun ham men kerak edim (yangi versiya chiqarish kerak edi), olib tashlashning esa **umuman iloji yo'q edi**.

Endi `Sozlamalar → Rollar va huquqlar` sahifasi bor:

- **Har bir rol — kartochka**: kodi, nomi, nechta odam shu rolda ishlayapti, nechta huquqi bor. Ochib, **har bir huquqni belgilash yoki olib tashlash** mumkin. Huquqlar sohalar bo'yicha guruhlangan (prixod, partiya, moliya, CRM, admin...) — 38 ta katakcha bir ustunda emas.
- **Yangi rol yaratish.** Masalan «Dispecher» yoki «Ombor boshlig'i o'rinbosari» — o'zingiz nom berasiz, o'zingiz huquq belgilaysiz. Yangi rol **nol huquq bilan** boshlanadi.
- **Yangi rol darhol odamlarga beriladi** — xodim kartochkasidagi rollar ro'yxati endi bazadan o'qiydi. (Ilgari u ham kodga yozilgan edi: siz yaratgan rolni hech kimga bera olmasdingiz — ya'ni konstruktor hech kim kiya olmaydigan kiyim tikkan bo'lardi.)
- **Ishlatilmayotgan rolni o'chirish** mumkin — lekin faqat tizim roli bo'lmasa **va** unda hech kim ishlamasa.

**Himoya choralari — sahifaning asosiy qismi shu.** O'zini o'chirib qo'yadigan yoki birov o'zini yashirincha ko'tarib oladigan ekran — yo'q ekrandan yomonroq:

1. **O'zingiz turgan rolni o'zgartira olmaysiz.** Ekran buni oldindan aytadi (ogohlantirish + katakchalar bloklangan), server ham rad etadi. Sizga rolingizni boshqa admin o'zgartiradi. Bu — o'zini tizimdan qulflab qo'yishning va o'ziga yashirincha huquq berishning eng keng tarqalgan yo'li.
2. **O'zingizda yo'q huquqni bera olmaysiz.** Aks holda `rollarni boshqarish` huquqi bor har qanday odam amalda super-admin bo'lardi: rolga hamma katakchani belgilab, o'sha rolni o'ziga berardi. Bunday huquqlar ko'rinadi, lekin qulf belgisi bilan — yashirish rolni aslidan kuchsizroq ko'rsatgan bo'lardi.
3. **Rollarni boshqara oladigan oxirgi odamni yo'qotib bo'lmaydi.** Tekshiruv **tranzaksiya ichida**, ya'ni yozuv qanday holat yaratayotgan bo'lsa, o'shanga qarab. Agar saqlash natijasida tizimda bu ekranga kira oladigan **birorta ham faol odam** qolmasa — o'zgarish butunlay bekor qilinadi.
4. **Har bir o'zgarish tarixga yoziladi** — kim, qachon, qaysi huquqni qo'shdi yoki oldi (oldingi va yangi ro'yxat bilan).
5. **Qo'lda o'zgartirilgan rolga yangilanish tegmaydi.** Rolni tahrirlaganingizdan keyin u «✏️ o'zgartirilgan» deb belgilanadi va keyingi versiyalarda seed uni **qayta yozmaydi** — aks holda mening har bir yangilanishim sizning sozlamangizni bekor qilardi. (Seed konsolda qaysi rollarga tegmaganini aytadi.)

Texnik tomondan: 0026-migratsiya (`roles.description`, `roles.grants_customised`, `role_permissions.source`), yangi `platform.roles.manage` huquqi (hozircha faqat `super_admin` va `admin`da), 16 ta integratsiya testi — jumladan «oxirgi admin» ssenariysi (u testda **atayin bekor qilinadigan tranzaksiya** ichida ishlaydi, chunki bu holat bazada qolsa tizimga kirib bo'lmaydi) — va 3 ta e2e.

272 test + 29 e2e yashil.

## 0-bosqich: serverda turgan xatolarni tuzatish — 2026-07-26

CRM platformasini qurishdan oldin kodni chuqur tekshirdim va **jonli 6 ta xato** topildi. Hammasi tuzatildi.

- **`/admin/settings` sahifasi ochilmasdi.** `crm_dormant_days` sozlamasining tavsifi 4 ta tilning **hech birida** yo'q edi, sahifa esa har bir sozlama uchun tavsif chiqaradi — natijada sahifa qulardi. Tavsif qo'shildi va **test yozildi**: endi tavsifsiz sozlama qo'shilsa CI to'xtatadi. (Eski til testi buni ushlay olmasdi — kalit 4 ta tilda barobar yo'q edi, ya'ni ular bir-biriga «mos» edi.)
- **CRM Telegram digestlari axlat matn yuborardi.** «Bugun bog'lanish kerak» va «Jim qolgan mijozlar» xabarlarining matni tayyorlanardi-yu, yuborishda tashlab yuborilardi; haydovchi `CrmFollowUps` va `/receipts/undefined` havolasini olardi. Endi qoida umumiy: **xabarda tayyor matn bo'lsa — o'sha matn yuboriladi**, ya'ni kelajakda yoziladigan har qanday digest ham ishlaydi. Test bor va u tuzatishsiz **yiqiladi** (tekshirdim).
- **Bitta yomon Telegram chat butun navbatni to'xtatardi.** Xato bo'lsa kod darhol `throw` qilardi — o'sha partiyadagi qolgan xabarlar (jumladan «yuk yo'qoldi») yuborilmasdi. Endi har bir xabar alohida urinib ko'riladi, xatosi yoziladi, oxirida navbat qayta urinadi. Botni bloklagan raqam **6 marta**dan keyin «yuborilmadi» deb yopiladi va boshqalarni ushlab turmaydi.
- **Huquq teshigi.** Ombor cheklovi `.every()` bilan hisoblanardi: bir odamga ikkita rol berilsa (masalan `skladchi` + `viewer`) cheklov **butunlay yo'qolardi** va u hamma omborni ko'rardi. Endi: **bittasi ham ombor roli bo'lsa — cheklov qoladi** (huquqlar qo'shiladi, cheklov toraytiriladi). Qoida alohida funksiyaga ajratildi va **haqiqiy funksiya** test qilinadi — nusxasi emas, ya'ni orqaga qaytarilsa test yiqiladi. 17 ta sotuvchiga login yaratganingizda birinchi tegib ketadigan joy shu edi.
- **Tezlik:** foydalanuvchi huquqlari har sahifada **70+ marta** bazadan qayta o'qilardi (har safar 3 ta so'rov). Endi bir so'rov davomida bir marta o'qiladi. Dashboard kabi og'ir sahifalarda sezilarli.
- **Custom maydonlar yarim saqlanishi mumkin edi** — har bir maydon alohida yozilardi, o'rtada xato chiqsa birinchilari saqlanib, qolgani yo'qolardi. Endi bitta tranzaksiya: yo hammasi, yo hech narsa.
- **Fayl yuklash** endi faqat haqiqiy 4 turdagi obyektga ruxsat beradi (prixod, lot, yashik, akt) — ilgari brauzer istalgan nomni yuborishi mumkin edi. *(Har bir faylni kim ko'rishi mumkinligini tekshirish — 1-bosqichda, huquqlar qatlami bilan birga.)*

256 test + 26 e2e yashil.

## Uchta tuzatish: sklad tanlash, QR skaner ramkasi, yuklashdagi kg/m³ — 2026-07-26

- **Skladchi endi faqat o'z omborini tanlaydi.** «Yuklash» sahifasidagi tez partiya shaklida barcha omborlar ro'yxatda turardi. Server allaqachon begona omborni rad etardi — lekin ro'yxatda ko'rinib turgani odamlarni urinishga o'rgatardi, rad etish esa xatoga o'xshab ko'rinardi. Endi: bitta omborda ishlaydigan odamga tanlov umuman ko'rsatilmaydi (ombor kodi shunchaki yozilib turadi), bir nechta omborda ishlaydiganga faqat o'shalar ko'rsatiladi. **Qayerga** yuborish — hamma ombor, avvalgidek (partiyaning maqsadi shu). Plan yaratish ekranida ham xuddi shunday tuzatildi — u yerda aksincha xato bor edi: bitta omborga biriktirilgan odam manzil tanlay olmasdi.
- **QR skaner endi faqat ramka ichini o'qiydi.** Kamera tasviri `object-cover` bilan kesilardi — ya'ni ekranda ko'rinmagan joy ham skanerlanardi va yonidagi quti yorlig'ini o'qib yuborardi. Endi: **kvadrat oyna**, ichida burchakli ramka, tashqarisi qorong'ilashtirilgan — va eng muhimi, har bir kadr **ramka bo'yicha kesilib** keyin o'qishga beriladi. Ekranda ko'rinmayotgan QR endi o'qilmaydi. Ikkala skaner (telefon o'zining BarcodeDetector'i va zaxira zxing) bir xil kesilgan tasvirni o'qiydi.
- **Yuklash paytida umumiy kg, m³ va kg/m³ ko'rinadi** — quti sanog'i ostida, har bir skandan keyin yangilanadi. Mashina kg va m³ bilan to'ldiriladi, ilgari esa faqat quti sanab, taxmin qilinardi.

241 test + 26 e2e yashil.

## Sizning ro'yxatingiz — 4-partiya: dashboard va xarita — 2026-07-26

**(7) Dashboard endi butun kompaniyani ko'rsatadi** — ilgari u faqat ombor dashboardi edi (ostatka, yo'ldagilar, egasiz yuklar); oy foyda keltirdimi yoki lidlar bilan kim ishlayapti — javob yo'q edi. Endi yuqoridan pastga to'rtta savolga javob beradi:

1. **Sarlavhada 4 ta raqam** — omborda nechta quti, yo'lda nechta mashina, qancha qarzdorlik, nechta ochiq lid. Har biri bosiladi.
2. **Bugun** — nechta prixod, nechta mashina yo'lga chiqdi, nechtasi yetib keldi, bugun nima kutilmoqda (kechikkanlari sariq bilan).
3. **Pul** — shu oyda qancha hisoblandi va qancha tushdi (nisbati chiziqcha bilan ko'rinadi), jami qarzdorlik, nechta mijoz qarzdor, shundan qanchasi 60 kundan oshgan, va **eng katta 5 ta qarzdor** — to'g'ridan-to'g'ri ularning hisobiga o'tiladi.
4. **Sotuv** — ochiq lidlar, shu oyda sotilganlar, bugun qo'ng'iroq qilinishi kerak bo'lganlar, va **voronkaning o'zi chiziqchalar bilan** — qaysi bosqichda tiqilib qolgani raqam o'qimasdan ko'rinadi.
5. Keyin logistika (omborlar to'lganligi, ostatka, yo'ldagilar) va «e'tibor talab qiladi» bloki — avvalgidek.

Har bir blok huquqqa qarab: buxgalter bo'lmagan odam pul blokini umuman ko'rmaydi (bo'sh emas — yo'q). Skladchi eski ombor dashboardini oladi.

**(6) Xarita:**
- **To'g'ri nisbatlar.** Ilgari uzunlik 16.6, kenglik 24 ga ko'paytirilardi — nisbati 0.69, aslida 35° kenglikda 0.819 bo'lishi kerak. Ya'ni xarita yon tomondan ~16% siqilgan edi. Endi proyeksiya to'g'ri, va buni test tekshiradi.
- **To'liq ekran** — o'ng yuqoridagi tugma. Butun ekranni egallaydi (menyu ham, sarlavha ham ostida qoladi), Escape yoki o'sha tugma bilan chiqiladi. Leaflet xaritasi o'lchamini qayta hisoblaydi — kulrang bo'sh joylar qolmaydi.
- **Sklad va mashina endi aralashmaydi** — 🏭 va 🚛 emojilar o'rniga: sklad — **ko'k kvadrat**, mashina — **sariq doira** (kechikkani qizil). Shakl bilan farq qiladi, ya'ni ustma-ust tushsa ham, kichraytirilsa ham ajratib bo'ladi. Pastda **izoh (legenda)** turadi. Mashinaning kodi belgidan **yuqorida**, skladniki **pastda** — mashina sklad ustida turganda yozuvlar bir-birini bosmaydi.
- Sxematik xaritada qo'lda chizilgan «davlat konturlari» olib tashlandi (ular hech qachon haqiqiy geografiya emas edi va yangi nisbatlarda butunlay noto'g'ri bo'lib qolardi) — o'rniga **koordinata to'ri** (70°E, 80°E … 25°N, 30°N …), u proyeksiyaning o'zi, ya'ni hech qachon noto'g'ri bo'lolmaydi.

241 test + 25 e2e yashil.

## Sizning ro'yxatingiz — 3-partiya: sklad jarayoni — 2026-07-26

- **(3) «Kelayotgan yuklar» — yangi ekran.** Skladga nima kelayotganini oldindan ko'rsatadi, ikki qismda:
  - **Bizga kelayotgan mashinalar** — boshqa skladdan yo'lga chiqqan partiyalar: kodi, yo'nalishi, nechta quti / kg, mashina raqami, haydovchi va **nechtasi hali qabul qilinmagani**. Bosasiz — to'g'ridan-to'g'ri skanerlab qabul qilish ekrani ochiladi.
  - **Mijozlardan kutilayotgan yuk** — sotuvchi (yoki skladchi) «GS777 juma kuni 5 quti jo'natadi» deb yozib qo'yadi: kodi, taxminiy quti soni, kutilayotgan sana, izoh. Kodi yo'q mijoz uchun qutidagi belgini yozib qo'yish mumkin. Kechikkanlari ⚠️ bilan belgilanadi.
  - **Yuk kelib prixod qilinganda yozuv o'zi yopiladi** — hech kim belgilashni eslab turishi shart emas. Bir mijozda ikkita ochiq yozuv bo'lsa, tizim taxmin qilmaydi — ikkalasi ham ochiq qoladi (noto'g'risini yopib qo'yishdan ko'ra yaxshiroq).
- **(2) «Mijozga berish» endi har sklad uchun alohida sozlama.** Sozlamalarda (Omborlar → o'sha ombor) belgilanadi. Migratsiya TAS/AND (customs va distribution turidagi) omborlarga avtomatik yoqdi, Xitoy omborlarida o'chirdi. Endi Xitoydagi skladchining ekranida hech qachon kelmaydigan «Berish» tugmasi turmaydi.
- **(15) Mashinalar ikkiga bo'lindi:**
  - **Sozlamalarda «Mashinalar»** (`/admin/trucks`) — mashina turlari, sig'imi. Yiliga ikki marta ochiladigan sozlama.
  - **«Mashinalar qayerda»** (`/trucks`) — endi shu manzilda: qaysi partiya yuklanmoqda, qaysisi yo'lda, qaysisi qayerga **yetib bordi**. Har qatorda quti/kg, mashina raqami, haydovchi va **hozir qayerdaligi**: yetib borgan bo'lsa sanasi, bo'lmasa haydovchi telefonidan kelgan oxirgi GPS nuqtasi, u ham bo'lmasa logist qo'ygan belgi (chegara / Qirg'iziston / O'zbekiston).

**Yo'l-yo'lakay topilgan sekinlik:** kelayotgan mashinalar so'rovi 28 soniya ishlayotgan ekan — noto'g'ri join butun qutilar jadvalini har bir partiya uchun qaytadan o'qiyotgan edi. 0,36 soniyaga tushdi.

237 test + 22 e2e yashil.

## CRM voronkasi telefonda — yangi ko'rinish — 2026-07-26

Telefonda 8 ta ustunni yonma-yon qo'yish ishlamas edi: 360 px ekranda qo'shni bosqichning atigi ~76 px'i ko'rinadi, kartani ko'rinmayotgan ustunga sudrash bir necha soniya davom etadi va ko'pincha noto'g'ri joyga tushadi. Shuning uchun telefondagi voronka boshqacha ishlaydi:

- **Yuqorida — bosqichlar lentasi**: har bir bosqich nomi va soni bilan. Butun voronka bir qarashda ko'rinadi, boshqasiga o'tish — bitta bosish. Tanlangan bosqich lenta o'rtasiga o'zi suriladi.
- **Pastda — o'sha bosqichning kartalari, to'liq kenglikda.** O'qish qulay, matn kesilmaydi.
- **Kartada «→ Keyingi bosqich» tugmasi** — kuniga o'n marta bo'ladigan harakat endi bitta bosish. Yonidagi «⋯» tugmasi pastdan chiqadigan ro'yxatni ochadi: istalgan bosqichga ko'chirish (yo'qotilganga ko'chirsangiz sababini so'raydi, avvalgidek).
- **‹ › tugmalari** bosqichlar orasida oldinga-orqaga yurish uchun.
- Voronka ochilganda **birinchi bo'sh bo'lmagan bosqich** ko'rsatiladi — ish uchinchi bosqichda bo'lsa, bo'sh «yangi» ustuniga qarab turmaysiz.

**Kompyuterda hech narsa o'zgarmadi** — hamma ustunlar yonma-yon, sudrab ko'chirish avvalgidek ishlaydi (u yerda hamma ustun ekranga sig'adi, sudrash eng tez usul).

Ikkala ko'rinish ham test bilan qoplandi: telefon uchun bosish orqali ko'chirish, kompyuter uchun sudrash (Playwright'ga alohida «desktop» profili qo'shildi).

232 test + 19 e2e yashil.

## Sizning ro'yxatingiz — 2-partiya: pul va mijoz (5 punkt) — 2026-07-26

- **(8) Narx qo'yish ekrani endi tannarx ↔ narx ↔ foyda ni bir qatorda ko'rsatadi.** Mashinaga bir marta kiritgan rastamojka/yo'l xarajati har bir klientga kg/m³ nisbatida bo'linib, o'sha klientning qatorida turadi: **tannarx** (va $/kg, $/m³), **narx**, **foyda** (va foizi). Yuqorida — butun partiya bo'yicha jami: qancha ketdi, qancha oldik, qancha qoldi, nechta klientga narx qo'yilgan. Xarajat kiritilmagan klient ⚠️ bilan belgilanadi — foyda 0 dan hisoblanib qolmasin.
- **(12) Moliyada: qarz qaysi yukdan kelgani ko'rinadi.** Klient hisobida endi har bir mashina alohida qator: kod, yo'nalish, sana, nechta quti / kg / m³, unga qo'yilgan narx va **o'shandan qancha qarz qolgani**. To'lov eng eski hisobdan yopiladi (bu qoida qarzdorlik hisobotidagi bilan bir xil, ikkalasi hech qachon qarama-qarshi javob bermaydi). Hech qaysi mashinaga bog'lanmagan qo'lda kiritilgan qarz ham alohida ko'rsatiladi.
- **(9, 16) Mijoz kartasi endi yukni ham biladi.** Karta ichida: yuk hozir qayerda (qaysi omborda / yo'lda / olib ketishga tayyor) — har biri quti/kg/m³ bilan, keyin butun yuk tarixi (qaysi mashinada ketgan, qachon, qancha) va pastida hisoblangan / to'langan / qarz. Pul faqat moliyani ko'rish huquqi bor xodimga ko'rinadi.
- **(13) «Mijozlarim» — yangi ekran.** Sotuvchi o'z mijozlarini bir ro'yxatda ko'radi: yuki bor / qarzdor filtrlari, har bir qatorda quti-kg-m³ va qarz summasi, qo'ng'iroq sanasi. Egasi va logist «hamma mijozlar» ga o'tib turishi mumkin. Sotuvchining pastki menusi: Bosh · CRM · Bugun · Mijozlar.
- **Yo'l-yo'lakay tuzatilgan xato:** sotuvchi CRM'dan mijoz kartasiga bosganda bosh sahifaga uloqtirilardi (karta `/admin/...` ostida yotgani uchun). Endi sotuvchi kartani o'qiy oladi, lekin tahrirlash va Telegram-kabinet tugmalari faqat adminda qoladi.

232 test + 18 e2e yashil.

## Sizning ro'yxatingiz — 1-partiya (17 tadan 8 tasi) — 2026-07-26

- **(1) «Inventarizatsiya» menudan olib tashlandi** — RFID o'quvchilar kelgunicha. Butun omborni qo'lda skanerlab sanashni hech kim qilmaydi; ekranlar va kod joyida qoldi, apparat kelgan kuni menuga qaytadi.
- **(5) Qidiruv — yuqoridagi panelda, har qanday ekran kengligida.** Ilgari u menuda alohida bo'lim edi; qidiruv — bo'lim emas, asbob.
- **(10, 11) CRM endi darhol voronkani ochadi.** `/crm` — doskaning o'zi (ilgari u yerda hech kimga kerak bo'lmagan «manbalar» jadvali turardi). Bugungi qo'ng'iroqlar ro'yxati `/crm/today` ga ko'chdi. Sotuvchining pastki menusi: Bosh · CRM · Bugun · Moliya.
- **(17) Partiya kartasi tozalandi** — manifest XLSX tugmasi olib tashlandi (yuk bilan VED hujjatlari va foto-qadoqlash ro'yxati ketadi, manifest emas). Mashina va haydovchi ma'lumoti VED hujjatlaridan keyingi yig'iladigan panelga o'tdi, panel sarlavhasida mashina raqami ko'rinib turadi.
- **(14) Kurs endi odam o'ylaganday kiritiladi: «1 USD = 12 345 UZS».** Ilgari teskari raqam (0.000081) so'ralardi. Ustunning aniqligi ham oshirildi (12 xona) — 12 345 kiritib 12 346 chiqib qolish xatosi shundan edi, endi yo'q. 4 ta test buni ushlab turadi.
- **(4) Plan berayotganda kg/m³ ko'rinib turadi** — sklad ostatkasidagidek: kg/📦, Σ kg, m³ va zichlik (kg/m³, rangli). Qutilarni belgilaganingizda raqamlar **olayotgan miqdorga** o'zgaradi, ya'ni «qancha yuk oldim» savolining javobi o'sha qatorning o'zida turadi. Plan kartasida ham har qator kg va m³ bilan ko'rsatiladi.
- **(Savol 1) Haydovchi kodi endi partiya tug'ilishi bilan yaratiladi** va partiya kartasining sarlavhasida katta harflar bilan turadi. Yuk ortayotgan skladchi tugma qidirmaydi — kodni sarlavhadan o'qib beradi. Telefon ulangach kod kuyadi va sarlavhadan yo'qoladi; kerak bo'lsa «Kod yaratish» tugmasi o'z joyida.

229 test + 16 e2e yashil.

## Yangi dizayn — 2-qism: GSR brendi, qorong'i rejim, rolga qarab menu — 2026-07-26

- **Logotip va rang** — endi haqiqiy GSR GROUP belgisi ilova sarlavhasida va kirish ekranida. Butun ilovaning rangi logotipdan olindi (#B80000). PWA ikonkalari ham yangilandi — telefon ekraniga chiqarsangiz o'z belgingiz turadi.
- **Qorong'i rejim** — yuqoridagi quyosh/oy tugmasi. Tanlovingiz eslab qolinadi (bir yil). Hech narsa tanlamasangiz, telefon sozlamasiga qarab o'zi tanlaydi. Sahifa ochilganda oq chaqnash bo'lmaydi — tanlov serverda o'qiladi.
- **Har kimga o'z menusi** — pastdagi 4 ta tugma endi lavozimga qarab:
  - skladchi: Bosh · Qabul · Yuklash · Berish
  - sotuvchi: Bosh · CRM · Voronka · Moliya
  - buxgalter: Bosh · Hisob · Moliya · Hisobot
  - siz: Bosh · Hisob · CRM · Sklad
  Qolgani ••• ortida. Buni test tekshiradi.
- **Ranglar tizimga o'tkazildi** — 112 ta faylda qattiq yozilgan ranglar (oq fon, kulrang matn, ko'k tugma) tokenlarga almashtirildi. Shuning uchun qorong'i rejim bitta joydan boshqariladi.

225 test + 16 e2e yashil.

## Yangi dizayn — 1-qism: poydevor va navigatsiya — 2026-07-25

Siz aytgan «hamma narsa har qayoqda yotgandek» — bu bo'yoq muammosi emas edi, navigatsiya muammosi. Tuzatildi.

- **Pastdagi menu (telefonda)** — endi har doim barmoq ostida: Bosh sahifa · Qabul · Yuklash · CRM/Moliya · ••• (qolgan hammasi). Ilgari bir bo'limdan boshqasiga o'tish uchun bosh sahifaga qaytish kerak edi — «har qayoqda yotgan» degan tuyg'u shundan.
- **Kompyuterda chap tomonda menu** — hamma bo'lim bir ko'rinishda.
- **Emoji o'rniga haqiqiy ikonkalar** — 30 ta ikonka qo'lda chizildi. Emoji xitoy telefonlarida har xil chiqardi, ba'zan kvadrat bo'lib qolardi; endi hamma joyda bir xil.
- **Bo'lim ichidagi tablar** (moliya, CRM, boshqaruv) — endi qaysi sahifada turganingiz ko'rinib turadi va tab o'zi ko'rinadigan joyga suriladi.
- **Bir xil sahifa sarlavhasi** — ikonka + nom + o'ng tomonda amal tugmasi. 67 ta ekran o'z o'lchamini o'zi tanlab yurardi.
- **Ranglar, shriftlar, soyalar, tugmalar, inputlar, jadvallar** — bitta tizimga keltirildi (`.card`, `.btn`, `.input`, `.table`). Barcha ekranlar birdan yangilandi.
- **Ish rejimlarida** (qabul, plan, yashik, berish, skanerlash) pastki menu ko'rinmaydi — o'sha ekranlarning o'z tugmalar paneli bor, menu ustiga chiqib bosishga xalaqit berardi. Buni testda ushladik.

224 test + 16 e2e yashil.

**Keyingi qism:** qolgan ekranlar ichidagi emoji va jadvallar yangi uslubga o'tkaziladi (sklad, prixodlar, partiyalar, hisobotlar, mijoz kartasi).

## Voronkada kartani ushlab sudrash (drag & drop) — 2026-07-25

- **Kartochkani ushlab turib boshqa bosqichga sudrasangiz bo'ladi** — amoCRM dagidek. Telefonda: bosib **ushlab turasiz** (~0.3 soniya), karta qo'lingizga «ko'chadi», keyin sudraysiz. Kompyuterda oddiy sichqoncha bilan sudrasangiz kifoya.
- Ustun chetiga yaqinlashsangiz **doska o'zi suriladi** — 360 px ekranda qo'shni ustunning atigi ~76 px'i ko'rinadi, shusiz uzoqdagi bosqichga yeta olmas edingiz.
- Karta darhol yangi ustunga tushadi (server javobini kutmaydi); server rad etsa joyiga qaytadi va xato ko'rsatiladi.
- «Yo'qotildi» ga sudrasangiz — sababini so'raydi, bekor qilsangiz karta joyida qoladi. Kartani oddiy bosish avvalgidek uni ochadi.
- Kutubxona qo'shilmadi: drag-and-drop paketi shu 150 qatordan kattaroq bo'lardi va baribir touch uchun alohida kod kerak edi. HTML5 drag-and-drop telefonda umuman ishlamaydi.

## CRM: leads, the funnel and one place for every conversation (Phase 2.3) — 2026-07-25

Endi CRM ishlaydi — quyida qayerda nima qilishingiz yozilgan.

**📞 CRM (bosh sahifadan)** — ertalab ochasiz: bugun kimga qo'ng'iroq qilish kerak, leadlar va mijozlar bitta ro'yxatda, kechikkanlari sariq chiziq bilan.

**🎯 Voronka** (`/crm/leads`) — amoCRM kabi ustunlar: Yangi → Bog'lanildi → Ma'lumot olindi → Hisoblanilyapti → Narx aytildi → Javob kutilyapti → Sotuv / Yo'qotildi. Har ustunda kartochkalar, pastda esa qaysi manba haqiqiy mijoz berayotgani.

**Lead kartasi** — bosqichni bitta bosishda ko'chirasiz (yo'qotilganda sabab so'raydi), qo'ng'iroqni yozasiz va o'sha zahoti keyingi sanani qo'yasiz, «Mijozga aylantirish» tugmasi kod berib mijoz kartasini ochadi. Lead «Sotuv» ga o'tishi bilan aylantirish paneli o'zi ochiladi.

**😴 Uxlab qolgan mijozlar** — ilgari yuk yuborib, keyin to'xtaganlar. Kunini o'zgartirasiz (60 kun standart).

**👥 Odamlar** — bitta odamning bir nechta kodi (GS777 + GS102). Telefoni bir xil kodlarni sistema o'zi topib taklif qiladi, siz tasdiqlaysiz. Kodlar birlashtirilmaydi — har biri o'z harflari, yuklari va kabineti bilan qoladi.

**⚙️ CRM sozlamalari** — bu yerda CRM sizniki bo'ladi: bosqich qo'shasiz/o'chirasiz/rangini va tartibini o'zgartirasiz, manbalar ro'yxatini yuritasiz, va **o'z maydonlaringizni** qo'shasiz (matn, raqam, sana, tanlov, ko'p tanlov, belgi, telefon, havola) — lead kartasiga ham, mijoz kartasiga ham.

**Mijoz kartasida** — qo'ng'iroqlar tarixi, o'zingiz qo'shgan maydonlar va shu odamning boshqa kodlari.

**Telegram** — har kuni 08:30 «bugun kimga qo'ng'iroq», har dushanba 09:00 uxlab qolganlar. Har kimga o'zinikini: sotuv menejeriga o'z mijozlari, sizga hammasi.

Sotuv menejeri o'z leadlarini yuritadi, lekin voronkani hamma uchun o'zgartira olmaydi — buni e2e test tekshiradi.

Migratsiyalar 0021–0022, 213 test + 16 e2e yashil.


## Management accounting: P&L, cash flow, receivables, profit per batch (Phase 2.4) — 2026-07-25

The money side is now closed: the cargo costs were already in the system, what was missing was everything around them.

**What you can now do**
- **Expense book** (`/accounting/expenses`) — rent, salaries, phone bills, anything. Kind, amount in any currency, date, and optionally which warehouse, which employee and which cash box it was paid from. Nothing is deleted: a mistake is voided with a reason, exactly like the client ledger.
- **Fixed costs as templates** — enter the rent and each salary once, then press "post this month's fixed costs" and review what landed. Deliberately a button, not an automatic job: a silent monthly insert would quietly falsify the P&L of any month where the rent changed or someone left. Pressing it twice cannot double-charge.
- **Expense kinds are yours** (`/accounting/categories`) — nothing hard-coded, as you asked. 13 starter kinds are seeded and you edit the list yourself. One flag matters: untick "Cash" for something that never moves money (depreciation) and it enters the P&L but stays out of the cash flow.
- **Cash boxes and accounts** (`/accounting/accounts`) — your five: China (USD), Uzbekistan cash USD, cash soʻm, card soʻm, company account soʻm. Opening balances entered, so a balance on screen matches what is actually in the box. Moving money between your own accounts is a transfer with two amounts (a CNY box can fund a USD account) and is never counted as income or spending.

**The reports, each downloadable as XLSX**
- **P&L** — one column per month: revenue, cargo costs by type, gross profit with margin, overheads by kind, net profit. Totals also shown in soʻm at today's rate.
- **Cash flow (ДДС)** — money that actually moved, plus what sits in each account right now.
- **Receivables by age** — 0–30 / 31–60 / 61–90 / 90+ days, where a payment settles the OLDEST charge first, so a client who pays every month never appears in the 90+ column just because they have been a client for a year.
- **Profit by batch / client / route** — the report that answers "did that trip earn money?". Unlike the monthly P&L, both sides belong to the batch whatever month they were entered, so a price agreed after the costs were booked does not distort it. The P&L page says so on the page itself.

**Who sees it**: owner and accountant only. A sales manager keeps client balances and cannot reach the company's margin — checked on the pages and on the download links, and an e2e test now holds that line.

**Caught in verification**: the per-batch profit report was returning zeros. Drizzle renders a column name unqualified in a single-table select, so a bare `id` inside the report's correlated subqueries bound to the *subquery's* table instead of the batch — revenue and cost silently came back as 0 and the box count died outright on a type mismatch. Fixed by qualifying every correlated reference, and a test now pins each column of a real batch (2 boxes, 50 kg, $1000 revenue, $400 cost, $600 profit, 60% margin).

- Tax is out of scope on purpose — the accountant runs that separately, so there is no tax line in the P&L.
- Migration 0020, 187 unit/integration + 14 e2e green on a fresh build and a fresh database.


## Telegram messages in each person's own language (part 3 of 3) — 2026-07-25

- **Staff Telegram notifications now follow the recipient**, not a fixed Russian channel language. Every event (receipt confirmed, unidentified cargo, plan approved / changes requested, off-plan load, undocumented transfer, missing in transit, stocktake summary, cargo arrived, handover, backup-restore failure) renders once per reader in their own `users.locale` — a warehouse manager reading Uzbek and an accountant reading English get the same event in their own words.
- **The client-facing drafts stay as they were.** Inside the "cargo arrived" message there are two ready-to-forward texts for the client (uz + ru); the manager copies them to the client, so they follow the CLIENT's language, not the manager's. Translating those into the manager's language would have been the wrong move.
- Tests: a message rendered in English contains no Russian labels (not merely English ones alongside), an Uzbek one uses Uzbek wording, and an unknown locale on a user row never produces the word "undefined" in a message going to a real phone.
- 168 unit/integration + 12 e2e green.
- **Client cabinet bot**: still Uzbek. Clients are Uzbek and there is no per-chat language yet; adding one means storing a language per client and a switch button in the bot. Say the word if a foreign client needs it.


## English in the exports and the paperwork (part 2 of 3) — 2026-07-25

Two different rules, because these files have two different readers.

- **Report exports follow the reader.** All ten downloads (landed cost, stock aging, batch register, receipts journal, unclaimed, client history, staff activity, label prints, in transit, stock) now take the locale of whoever pressed the button, so an English-speaking manager gets English column headers and sheet titles — ~55 labels in all four languages.
- **Customs paperwork is bilingual RU/EN and ignores the interface language.** The invoice, packing list, manifest, packing photos, agent file and handover act are read by an Uzbek customs officer and a Chinese forwarding agent, never by the person who clicked download. Letting them follow the interface would let someone working in English hand customs a paper nobody at the border can process. The invoice already carried a few pairs ("Отправитель/Sender:"); this finishes the pattern everywhere.
- **Caught in verification**: a bilingual label was used as an Excel TAB name, and Excel rejects `/` in one — every manifest download answered 500. Sheet names got their own slash-free constants, and two tests now stand where the bug was: one asserting no sheet name carries an illegal character, one generating all five documents end to end.
- Also guarded: every report label exists in every language, and an unknown locale on a user row falls back instead of producing blank headers.
- **Deliberately untouched**: the box and crate stickers. Their Russian words sit in a fixed 100×100 mm layout that I cannot proof-print here, and a longer bilingual string risks clipped text on real labels. Say the word and I will do them with a careful layout pass.
- 167 unit/integration + 12 e2e green.


## English interface (part 1 of 3) — 2026-07-25

- **English joins Russian, Uzbek and Chinese** — all 644 interface strings across 30 areas (receiving, batches, stock, finance, reports, map, admin…). Pick it from the language selector or set it per employee.
- Migration 0019 widens the `users_locale_check` constraint; without it nobody could actually be switched to English. Existing users keep their language — nothing moves by itself.
- **A test now guards all four bundles**: every locale must carry every key, keep the same `{placeholders}`, and not silently ship a Russian string as a translation. next-intl throws at RENDER time on a missing key, so a forgotten translation would otherwise surface as a broken page for whoever uses that language — usually not the person who added it. Verified against deliberately broken bundles: all three checks fire.
- Verified in a browser: 15 screens render English with no client-side errors. 163 unit/integration + 12 e2e green.
- **Still Russian/Uzbek** (parts 2 and 3, next): the customs documents (invoice, packing list, manifest, handover act, report exports) and the Telegram bot.


## The admin nav stays in the admin section — 2026-07-25

- **Owner's report**: "warehouses / clients / employees" sat at the top of the home screen; it should appear only after opening the admin panel. It was rendered by the protected layout, so it followed an admin onto every operational screen. Moved into the admin section's own layout, reachable from the home tile as before.
- **Found while moving it**: the section gate demanded `admin.warehouses.manage`, but the accountant holds `costs.fx.manage` and the home screen offers them the 💱 FX tile — clicking it bounced them straight back home, so an accountant could never open their own exchange-rate page. The gate now admits any admin-section permission and the nav lists only what the person may actually use; the four pages that had been leaning on the old gate (warehouses, clients, users, settings) check `admin.warehouses.manage` themselves, so widening the entrance opened nothing.
- The smoke test now asserts both halves: no nav on an admin's home screen, a nav inside the admin section. 153 unit/integration + 12 e2e green.


## Owner's UI round: archive, foldable panels, manual batch code — 2026-07-25

- **A finished batch used to vanish.** The board rendered only forming/loading/in transit/arrived, so once a truck was unloaded its manifest, costs and history were unreachable. There is now an archive drawer under the board — unloaded/closed/cancelled — searchable by code, plate or driver. Its box count comes from the departure movements, since a finished batch no longer owns any boxes.
- **The batch code can be typed by hand** (owner: the per-warehouse sequence YW-001, YW-002 is not always the number the papers use). A ✏️ next to the code opens an input, the generated code stays the default, and the new one is trimmed, uppercased and checked for collisions case-insensitively. Editable **only before departure**: after that the code is on the invoice, the manifest and whatever the agent already received, and renaming it would leave papers and system disagreeing. The change is audited with the old and new value.
- **Three panels fold away**: the driver pairing code ("it should sit somewhere small where it bothers nobody" — collapsed, with a badge showing the pending code so it stays findable), the VED documents, and — in receiving — the note and extra-cost fields, which belong to a minority of receipts. Photos and file attachments stay open, because those are used on every receipt. A draft that already carries a note or a cost comes back open. Native `<details>`: no client JavaScript, works on the slowest warehouse phone.
- **The draft packing list button is gone** — the photo packing list replaced it in practice. The generator itself stays reachable.
- **The stock table sorts by any column** (code, product, boxes, kg, m³, density, note, warehouse, date), reusing the reports' sort header, with the warehouse filter and search preserved in the link.
- 153 unit/integration + 12 e2e green, verified against a fresh build and a fresh database.


## Unload: accepted cargo stopped disappearing, and "accept everything" exists — 2026-07-25

Owner's report: cargo arrived, boxes were accepted by hand, the counter never moved, and finishing the unload declared the whole truck missing.

- **Root cause: an accepted box fell off the unload screen.** The screen's snapshot selected boxes by `current_batch_id` — which accepting a box CLEARS. So each acceptance removed a box from the list instead of ticking it off: the counter went 0/13 → 0/12 → 0/11, and a page reload showed nothing had been accepted at all. Membership now comes from the departure movement, which is written once and never changes.
- **Second cause: the screen only recognised `in_stock`.** Unloading at a customs or distribution warehouse — which is every Uzbekistan destination — lands cargo in `ready_for_pickup`, so even a correct snapshot would have read as "nothing accepted". The screen now treats anything that is no longer `in_transit` as accepted, whatever the destination type.
- **"Accept everything" is now its own button.** Finishing an unload marks whatever was not accepted as lost — and it was the ONLY one-tap action on the screen, so it got pressed by someone who meant "take it all in". `📥 Hammasini qabul qilish (N ta)` accepts the remaining manifest in one go, through the normal unload path (movements, scan events, ready-for-pickup notices, audit trail identical to a scanned unload; pressing it twice is a no-op). It sits ABOVE the finish button whenever anything is outstanding.
- **Finishing now says what it is about to do**: the batch card shows "Hali qabul qilinmagan: N ta", the finish button steps back to secondary styling while boxes remain, and it asks for confirmation naming the number that will be flagged lost.
- **A box resolved as "found here" lands where a scanned one lands.** It was hardcoded to `in_stock`, so at a distribution warehouse a recovered box stayed invisible to the ready-for-pickup and issue flows.
- Also: the audit page threw `MISSING_MESSAGE` on any `delete` entry (untranslated in all three languages) — added, and an unknown action now falls back to the raw verb instead of taking the page down.
- Five integration cases cover the owner's exact scenario end to end at a distribution destination; the membership one was checked against the old query and fails there. 151 unit/integration + 12 e2e green.


## GSRDriver: battery-first schedule, quiet notification, real setup screen — 2026-07-25

Owner's first field round on the driver app, after it ran on a real phone.

- **A position every 2 hours instead of every 5 minutes** ("menga aniq hozirgi location kerak emas"). The GPS is no longer registered permanently: an `AlarmManager` wakes the service, it takes ONE fix (up to a 90 s window, stopping early once accuracy is good enough), uploads, and lets the radio sleep until the next slot — the phone spends the trip idle instead of tracking. A cycle that gets nothing (tunnel, garage) retries in 10 minutes rather than waiting out the full interval, and the interval itself is 1 / 2 / 3 hours, switchable on the phone.
- **The battery exemption is now part of the first-run flow, not a button to remember.** Setup walks location → notifications → "always allow" → the system *"let this app run in the background?"* dialog → the vendor auto-start list, one step at a time, and each step is offered once so a refusal cannot loop. It is not cosmetic: without the exemption Android defers the alarm, so the every-2-hours schedule only holds because the app is on the allowlist.
- **The notification stopped narrating.** No more "✅ Hammasi yuborildi" every cycle: the channel is silent and minimum-importance (a new channel id — Android never lowers an existing one), and the text stays empty unless something is actually wrong (no location permission, or a real upload backlog). Android does not allow a foreground service to hide its notification entirely, so the trip name remains.
- **A real screen for the phone**: a green/amber state line, the trip, a setup checklist that stays red per unfinished item with a button that opens exactly that setting, the chosen interval, the last position with its time and coordinates, the next report time, the offline queue, the last error, and "Hozir yuborish" for the warehouse worker who wants to see a dot appear before the truck leaves. It renders in the **phone's own language** — Uzbek, Chinese or Russian — since the driver in China is the one who reads it for the next six days.
- **Server side follows the new rhythm**: a fix counts as real for 8 hours instead of 90 minutes (2-3 h reporting + a missed cycle + a dead zone), otherwise every genuine position would have been drawn as stale and handed back to the estimate. Ages are shown in hours once minutes stop being the honest unit, and the map/batch texts say the location updates every 2-3 hours so nobody reads a still dot as a fault. 146 unit/integration green.


## GSRDriver — Android app for drivers (phase B) — 2026-07-25

- **The app the warehouse worker installs on the driver's phone** while the truck is being loaded: type the trip's 6-character code once, grant the permissions (the worker does it, not the driver), hand the phone back. From then on the phone reports its position by itself.
- **Works on ANY Android phone**: location comes from the framework's own `LocationManager`, not Google's fused provider — most Chinese phones (Huawei above all) ship without Google services, and the driver's own phone is whatever it is. No third-party networking library either; the whole app is Kotlin + the Android SDK.
- **Built for the corridor's dead zones**: a fix every ~5 minutes (or 250 m) goes into a local SQLite queue and is deleted only once the server has accepted it, so a week without signal loses nothing. A truck restart brings tracking back by itself (boot receiver), and Android killing the service is answered with an automatic restart.
- **Stops itself when the trip ends**: the server answers "trip finished" once the batch is closed and the app clears the token and shuts down — nobody is tracked outside a trip.
- **The screen is written for the warehouse worker**: status in Uzbek ("✅ Kuzatuv ishlayapti", "📦 Yuborilmagan nuqtalar: 12", "⚠️ «Doim ruxsat» berilmagan"), plus a one-tap shortcut to the battery settings — the Chinese-OEM battery killer is the single most common reason tracking goes silent, so it gets its own button and a hint.
- **Distribution without a store**: GitHub Actions builds the APK on every change (`apps/driver-android/`); download it from the run's artifacts and install it directly. No Play Console, no review, no $25 — and it works in China where Play does not exist. `apps/driver-android/README.md` documents the whole setup in Uzbek.

## Driver tracking — server side (phase A) — 2026-07-25

Owner's flow: at loading the warehouse worker takes the driver's phone, installs the app and grants the permissions himself, then sends the truck off. Android phones stream real positions; iPhone / HarmonyOS stay on the logist's manual updates plus the schedule estimate.

- **Pairing is per TRIP, not per driver**: the batch card gained a "📲 Haydovchi telefoni" panel that mints a single-use 6-character code (ambiguous letters excluded — it is read off a screen). The app sends the code once and gets a trip token back; the code is burned immediately, so a screenshot of it is worthless. Tracking ends by itself when the batch is closed — the server answers "trip finished" and the app stops.
- **Position ingest** accepts a whole queue of fixes at once (the corridor is full of dead zones, so the phone stores and flushes on reconnect) and ignores duplicates from a re-flush. Every device shows its last-seen time and fix count on the batch card; the code can be revoked at any moment.
- **The map now prefers reality**: a fix newer than 90 minutes replaces the estimated dot and the truck panel says "🟢 Real position · N minutes ago"; an older one falls back to the schedule with "🟡 Estimated · last real signal N minutes ago". Manual pins by the logist count as positions too, which is exactly the iPhone/HarmonyOS path.
- Migration 0018 (`driver_devices`, `driver_positions`); tokens are stored hashed like session tokens and never leave the server; 10 integration cases cover single-use pairing, re-flush deduplication, revoked/finished-trip rejection and freshness. 145 unit/integration + 12 e2e green.
- Next: the Android app itself (`apps/driver-android/`, built into an APK by CI) against this API.

## Demo accounts stop coming back — 2026-07-25

- **The seed no longer re-creates demo data on a live system.** It runs on every deploy (that is how new permissions reach the roles), and it used to re-insert any demo user/client/warehouse that was missing — so an account the owner deleted, with the published `demo1234` password, reappeared on the next update. Demo users, demo clients, demo warehouses, the example FX rates and the canonical GS777 receipt are now seeded **only into an empty database** (the bootstrap that gives a fresh install someone to log in as). `SEED_DEMO=1` forces them back for test environments.
- Reference data — permissions, roles, role grants, settings, currencies, cost types, truck presets, the product dictionary — still refreshes on every run, unchanged.
- **`pnpm demo-users`** retires the accounts an existing server already carries: it reports every demo phone still present and, with `--disable`, deactivates the ones that STILL HAVE the demo password (login blocked, live sessions dropped). An account whose password was changed is in real use and is never touched, and the last active super admin is always kept with a warning to change its password.
- Verified end to end on scratch databases: fresh DB → demo seeded; existing DB → deleted demo account stays deleted while grants still refresh; `SEED_DEMO=1` → restored. A unit test pins the gating so it cannot be undone by accident.
- `docs/UPDATE.md` (production update runbook) documents the step.

## Receiving: an unknown code no longer offers a look-alike client — 2026-07-25

- **Owner's report**: typing GS500 (a code that does not exist) during receiving offered **GS300**, and the "unknown cargo" path disappeared behind that suggestion.
- **Search fixed**: digits in a client code are meaningful — GS500 and GS300 are different customers, but trigram similarity happily matched them. A query containing digits now matches codes literally (exact / prefix / substring); fuzzy matching is kept for names and for digit-free code typos, so `gs777` → GS777, `777` → GS777 and a misspelled client name still work, while GS500 simply finds nothing.
- **"Unknown cargo" is always reachable**: it is now the last row of the suggestion list (after the real matches, never before them, and deliberately unlabelled with the typed code so it cannot be mistaken for one), and the big button below appears whenever the list is empty.
- **Race removed**: that button used to flash up with the typed code for a moment BEFORE the lookup answered — a fast tap on an existing code filed the receipt as unclaimed. It now waits for the search to finish before claiming a code is unknown.
- Client search extracted into one module used by the receiving, issue and finance screens alike, with a DB-level suite (unknown code → nothing, exact/lowercase/partial, name typos, inactive clients hidden). 132 unit/integration + 12 e2e green; the e2e receiving flow now asserts the unclaimed path stays reachable for a look-alike code.

## Auto client code follows the MAIN sequence again — 2026-07-25

- **Owner's report**: codes run GS1…GS425, but a few one-off manual codes exist (GS777, GS5564, GS5909); asking the system to assign a code produced **GS5910** instead of **GS426** — plain "biggest + 1" was dragged along by the outliers.
- **New rule**: the existing numbers are split into groups (a jump of more than 50 starts a new group), the **biggest group is the main sequence**, and the next code is the first free number above it. Isolated special codes form their own one-member groups and are stepped over — until the sequence genuinely grows up to them, at which point it simply continues past. Scattered codes with no real sequence keep the old "biggest + 1" behaviour, and gaps left by voided codes are never re-issued.
- Hardened along the way (found by an adversarial review of the first attempt): a prefix that itself ends in a digit no longer corrupts the extracted number; a prefix containing regex characters is matched literally; a lowercase `client_code_prefix` setting no longer generates codes the database rejects; absurd/overflowing numbers can no longer hang the generator while it holds the sequence lock; and two managers saving the same manual code at the same moment now get a clean "code already exists" instead of an error page.
- 14 unit cases (including the owner's exact dataset and the 100-start variant) + a DB-level suite covering the prefix edge cases. 126 unit/integration + 12 e2e green.

## Real basemap for the tracking map (self-hosted, China-safe) — 2026-07-25

- **The /map schematic upgrades to a REAL zoomable map** (owner's ask for an external map): Leaflet renders a self-hosted OpenStreetMap extract (PMTiles vector tiles) covering the whole corridor (UZ + KG + all of China). Why not Yandex/Baidu: Baidu requires a Chinese-ID developer account and barely covers Uzbekistan; Yandex is unreliable behind the GFW. Hosting the map data ourselves gives the same look with guaranteed China performance and zero runtime dependency on anyone.
- **One-time server step**: `bash ops/fetch-basemap.sh` downloads a ~30-80 MB corridor extract into `.data/basemap/` (docker volume added); until then the map page keeps the schematic SVG with a gray hint — nothing breaks, both modes share the same trucks/warehouses/popups.
- Waypoints refactored to real lon/lat (single source for both renderers); `/api/basemap/corridor.pmtiles` serves the file with proper HTTP Range support (the PMTiles reader fetches byte ranges) — unit-tested including 206/416 edges.
- 110 unit/integration + 12 e2e green (CI exercises the SVG fallback path).

## 🗺 Tracking map: approximate truck positions + warehouse stock — 2026-07-24

- **New "Xarita" page** (home → info tiles): a self-drawn SVG of the whole corridor (Guangzhou/Yiwu → Urumqi → Kashgar → Irkeshtam → Osh → Andijan → Tashkent) — deliberately NO external map tiles, so it opens instantly in China and adds zero dependencies (owner-approved tradeoff).
- **Trucks on the map**: every in-transit batch is placed along its route by the owner's typical timings (YW→KA 6-7 d, GZ→KA 5-6 d, KA→UZ: to border → 1-3 d border queue → 2 d Kyrgyzstan → UZ leg), pulsing amber; red when the schedule says it should already have arrived. Tap a truck → batch code, phase ("Chegarada navbatda"), ETA range, progress bar, per-client contents, link to the batch.
- **Warehouses on the map**: 🏭 icons with live stock badges; tap → per-client stock chips + link to the stock browser.
- **Manual position pins** (the honesty mechanism — this is a simulation, not GPS): the batch card gains "📍 Mashina qayerda?" buttons — 🛃 at the border / 🇰🇬 in Kyrgyzstan / 🇺🇿 in Uzbekistan. One tap re-anchors the map estimate from that moment (audited, tap again to clear). The map header always says positions are approximate.
- Estimator is a pure unit-tested engine (segment schedules, stationary border wait, checkpoint re-anchoring, overdue detection); migration 0017 (`batches.tracking_checkpoint`); map assertions added to the m3 e2e flow. 105 unit/integration + 12 e2e green.

## One phone = all codes: cabinet multi-code round — 2026-07-24

- **New-client save lands on the client CARD**, not the list (owner: "after Сохранить everything vanishes — can't tell what code the system assigned"). The assigned code is in the heading, and the Telegram-cabinet block is right there for the next step. Client edits land on the card too.
- **One verified phone connects EVERY code of that person** (owner: one customer holds 777, 555, 444, 333): the client taps ONE link, confirms their phone once, and all active client codes registered under that number join the chat together — the welcome message lists them all.
- **New codes join automatically**: when staff opens another code for an already-verified person (same phone on the card), it appears in their cabinet by itself with a "🔗 yangi kod qo'shildi" ping — no new link ceremony.
- Phone verification stays (it is exactly what catches the wrong-recipient case from the last incident) — but it now runs ONCE per person, not once per code.
- In the bot every code shows separately under 📦/💰/🗄 — a multi-code client scrolls through each code's cargo and balance.
- e2e: m5 spec no longer trips over accumulated unclaimed stock rows (picks a real GS client row).


## Cabinet linking is now phone-verified — 2026-07-24

- **Owner's incident**: a cabinet link minted for one client was sent to a different person, who tapped it and instantly saw the other client's cargo and debt. Root cause: the link was a bearer token — whoever tapped it got linked, identity unchecked.
- **Now linking is two-step**: tapping the link reveals NOTHING — the bot first asks the person to share their own phone number via Telegram's contact button (spoof-proof: a forwarded stranger's contact card is detected and rejected). The number is matched against the client card's registered phones (digit-normalized, so +998 90 175-78-00 and 998901757800 match) and only then does the cabinet open.
- **On mismatch**: the link is burned immediately, the person sees a neutral "contact your manager" (no client data), and the staff member who minted the link gets a 🚨 Telegram alert to check who they sent it to.
- A client with NO phone on file can't be verified — the bot tells the person to contact the manager, the staff member gets a prompt to fill the phone in (the link survives for a retry after that).
- The admin card now shows the client code right next to each pending link — the incident started as a wrong-tab mix-up between two same-named clients.
- Phone-matching unit suite + reworked linking integration tests (97 unit/integration + 12 e2e green). Also fixed the second e2e code-collision flake (client code now uses the full run id).

## Quick-batch loading: pick the box, don't type the code — 2026-07-24

- **⚡ Quick (plan-less) batches**: the loading screen's manual button becomes "📦 Skladdan tanlab yuklash" — it opens the origin warehouse's loadable stock (in_stock / ready_for_pickup, grouped by client-letter with product names and crate badges). Tap a box → loaded; the sheet stays open so several boxes go in a row, and loaded ones drop off the list instantly (owner's request: no code typing).
- A search field (code / client / marking / product) appears on lists longer than 8 — for both the quick-batch stock list and the planned batches' sticker-lost list.
- Typing the code by hand still works as a fallback; everything is recorded as a `manual / sticker_lost` scan exactly as before.
- e2e flake fixed: the M0 smoke test's generated warehouse code collided with leftovers of earlier runs — now uses the full 6-digit run id.

## Phase 2.2 — Telegram client cabinet — 2026-07-24

- **Clients get their own cabinet in the SAME bot** (owner's spec): staff opens Admin → Client → "🤖 Telegram kabinet", mints a one-time deep link and sends it to the client; the client taps it and gets a persistent uz-language menu.
- **📦 Yuklarim** — active cargo grouped by lot (letter, product zh/ru, per-status counts: skladda / yo'lda 🚛 / olib ketishga tayyor ✅, warehouse codes) with 📷 buttons that send the lot's photos (server thumbnails, ownership re-checked on every tap).
- **💰 Balans** — the Phase 2.1 ledger balance ("qarzingiz: $X" or "qarzingiz yo'q ✅") plus the last 5 charges/payments — old delivered-cargo debt included (owner explicit).
- **🗄 Tarix** — already-issued cargo history.
- **Auto-messages to the client's own chat** (best-effort, uz): cargo arrived at the UZ warehouse (owner's Q5 wording — "rasmiylashtiruv tugagach olib ketish vaqtini kelishamiz") and cargo issued (receiver name, boxes left).
- One chat can hold several clients (broker case); codes are single-use; staff can revoke a link any time and access ends immediately; linking/revoking is audited. Migration 0016; cabinet integration suite (90 unit/integration + 12 e2e green).

## Phase 2.1 — Finance: client ledger, batch pricing, debt gate — 2026-07-24

- **💰 Finance section** (`/finance`, home tile for finance roles): every client with money activity, charges/payments/balance in USD, debtors first and in red; client page shows the full ledger (who entered what, when, against which batch) with void-with-reason for mistakes (audited, struck-through in history — never deleted).
- **No tariffs by design** (owner's rule): the price of every shipment is whatever the sales manager and the client agreed — the ledger records **charges** (agreed prices) and **payments** (cash 💵 / card 💳 / bank transfer 🏦, owner accepts all three) in any currency. Amounts convert to USD at the dated FX rate **frozen at entry time** — later rate edits never move settled money. A currency with no rate at all is refused with a pointer to the FX page.
- **Batch pricing page** (`/batches/[id]/pricing`, batch card → "💰"): after customs, the VED manager and accountant see each client on the batch (boxes / kg / m³), enter the negotiated amount, and it lands in the client's ledger as a charge tied to that batch (owner's flow: "yangi yuki rastamojkadan keyin tayyor bo'lganda VED menejer va buxgalter narxlarni belgilab chiqishadi").
- **Debt gate on issue** (owner's rule: "manager ruxsati bilan yuklar beriladi"): the issue screen shows the client's debt up front; a debtor's cargo is blocked at confirm unless someone holding the new `finance.debt_override` permission ticks "manager allowed" (recorded on the handover + audit). Operators can't override — managers, sales managers, accountants and admins can (adjustable per role in admin, as all grants are).
- New permissions `finance.manage` (accountant, VED manager, admins), `finance.view`, `finance.debt_override`; migration 0015 (`client_transactions`); integration suite for conversion/balance/void + the debt gate (84 unit/integration + 12 e2e green).

## Phase 1.5 — AI ТНВЭД assistant (memory-first) — 2026-07-24

- **🏷 ТНВЭД page per batch** (VED-doc card → "ТНВЭД"): one row per product with photo, code input and a 🤖 button — the AI (Claude) suggests a 10-digit UZ customs code from the product name (zh/ru) + photo, tuned to be duty-optimal but customs-defensible, with a confidence note and reasoning. "Suggest for all empty" fills the gaps in one tap.
- **Memory-first** (owner's rule): every SAVED code lands in `tnved_assignments` keyed by the normalized product name — known products pre-fill instantly and the AI is only asked about products never seen before. The human always confirms; AI output is a draft.
- **Invoice prefill**: the ka23 INVOICE & PACKING LIST now fills its ТНВЭД column from the memory (still editable in Excel); unknown products stay blank as before.
- Requires `ANTHROPIC_API_KEY` in `.env` (documented in `.env.example`); without it the page still works with manual entry + memory, and the 🤖 button explains what's missing.
- Migration 0014; audited saves; unit tests for the key/code helpers (76 total).

## Feedback round 8 — Depart for loaders, iPhone scan feedback, photo packing list — 2026-07-24

- **"Отправить" now visible to the loading warehouse too** (owner's request): anyone who can load (`scan.load`) at the origin warehouse can send the truck off — behind a confirmation dialog for everyone ("after this the load list locks"). Closing/arrival stays manager-only.
- **Scan counter goes live across phones**: every 15-second sync now also pulls the server's view of the batch, so boxes scanned on ANOTHER phone (or an earlier session) count without refreshing the page. Union-merge keeps local unsynced scans visible.
- **iPhone scan feedback**: iOS has no vibration API — every scan verdict now also beeps (WebAudio: high blip = ok, low buzz = duplicate/error), armed on the first touch as iOS requires. Shared module used by loading, unloading, inventory and issue screens; the issue screen also buzzes on unknown/duplicate codes instead of silently ignoring them.
- **Packing list with photos** (owner's request): new "⬇️ 📷 Packing (фото)" on the batch card — one row per loaded lot (code, product zh/ru, boxes, kg, m³) with every lot photo embedded, built from load scans so it works after unload/close too.
- **Stock page bug (owner's report: "13 boxes at TAS1 but stock shows nothing")**: boxes unloaded at a customs/distribution warehouse become `ready_for_pickup` and vanished from the stock browser/stock XLSX, which filtered `in_stock` only. Stock now shows everything physically on the shelf (in_stock / planned / loading / ready_for_pickup) with per-box status chips.
- **Planned (Phase 1.5)**: AI ТНВЭД assistant — suggests the customs code from product name+photo, remembers every confirmed assignment and reuses it without calling the AI again; VED manager confirms (PLAN.md).

## Feedback round 7 — Sticker product names, departed-batch view — 2026-07-24

- **Sticker bug fixed: product name now actually prints** (owner's report). The PDF library's font subsetter silently emitted broken CJK fonts — 化妆品 came out as empty squares (or nothing at all on thermal printers) on box labels, crate labels and the handover act. Fonts are now subsetted with HarfBuzz (`subset-font`) to exactly the characters each document uses: both 中文 and русский names print, and label PDFs stay small (DECISIONS #103).
- **Departed batch: sending warehouse keeps a read-only view** (owner's request): the batch card gained a collapsible "🧾 Loaded boxes" list built from load scan events — box codes grouped by client-letter — so the origin operator can always see exactly WHAT left, even after unload/close. No actions — view only.
- Owner's question about photo size answered in-app: photos are already compressed on the phone before upload (≤1600 px, ~0.3 MB, web worker) at all three upload points, and lists serve server-generated thumbnails.

## Deploy kit — probniy server in one command — 2026-07-24

- `docker-compose.yml`: one-shot **migrate+seed service** (the app previously started against an empty DB with no admin user), optional **Caddy HTTPS profile** (`DOMAIN=… docker compose --profile https up -d`) — phones need a secure context for the camera scanner.
- **`.dockerignore` added** — `.env` secrets and `.data` (dumps, photos) no longer leak into the image (`COPY . .` was copying them).
- **`ops/bootstrap.sh`**: fresh Ubuntu VPS → running stack in one command (installs Docker, generates `.env` with random secrets, build, health-wait, prints the URL and demo login).
- **`docs/DEPLOY.md`** (uz): the owner's 10-minute path — buy a HK/SG VPS, clone, run the script; or hand Claude SSH access and skip even that.

## M6 part 7 (final) — Digest polish, restore fire drill, runbook — 2026-07-24

**M6 closes with this release — all Phase 1 milestones (M0–M6) are done.**

- **Per-user Telegram mutes** (spec §11): profile page gained a 🔕 card — mute everything, or just the daily digest / alerts / operational messages. The in-app bell still shows everything; muted sends are recorded as `muted by user` (migration 0013, DECISIONS #100).
- **Admin → Notifications**: Telegram delivery journal with a problems-first filter (retrying errors, muted/unlinked recipients) and a 7-day status summary — spec §11's "failures visible in admin".
- **Weekly backup fire drill**: new `db.restore_test` job (Sunday 04:00 Tashkent) + `pnpm restore-test` — restores the latest dump into a scratch DB, sanity-checks the six core tables, drops it, and alerts admins in Telegram if anything fails (DECISIONS #101). Verified against a real dump.
- **README rewritten as an ops runbook**: production start rules (standalone only), update procedure, job schedule table, backup/restore commands, Telegram bot setup, troubleshooting; `.env.example` documents `BACKUP_DIR`/`BACKUP_RETENTION_DAYS`.
- **Performance pass**: first-load JS measured at 104 kB shared / ≤150 kB worst route — within the 3G budget; dashboards intentionally stay chart-lib-free (DECISIONS #101).
- Tests: 74 unit/integration (+6 mute-logic) + 12 e2e — full regression green.

## M6 part 6 — Whole-app UI/UX sweep — 2026-07-23

Full-project audit (every page + shared component) against the owner's "find and fix the UX shortcomings" request:

- **Home screen regrouped**: big tiles for daily operations (receive / batches / plans / issue / crates / inventory), small tiles for info (stock, receipts, unclaimed, search, dashboard, reports, pipeline) and management (FX, trucks, admin) — section headers in all three languages.
- **No more dead ends**: friendly error page (😵 + retry + home instead of the raw Next.js digest screen) and 404 page; every detail page (receipt, batch, box, crate, plan) and all 8 report pages got a "← back to list" link.
- **Destructive-action safety**: deleting a receiving lot that already has data asks for confirmation; photo/attachment delete errors now surface instead of failing silently (receive wizard, return-to-sender, cost panel void).
- **Touch targets**: tiny ✕/🗑 icons enlarged to ≥28 px hit areas (lightbox, gallery, attachments, clear-client); small box-pick buttons in crate builder and issue screen brought up to comfortable tap size.
- **Scanner ergonomics**: manual code inputs autofocus + uppercase on load/unload/inventory screens; inventory scans now vibrate + flash like the other scan modes.
- **Feedback everywhere**: pending states on assign-client and photo uploads ('…' + disabled), stale-fetch guards (AbortController) in crate builder and issue screen so slow responses can't overwrite fresh lists.
- **Consistency**: bare "—" placeholders replaced with a proper localized empty state on plans/crates/transit/unclaimed/pipeline/stock and admin lists; audit page no longer crashes on a malformed date filter; stock page uses locale-aware number formatting.
- **Fixed en route**: a route-transition skeleton (`loading.tsx`) added early in this sweep silently broke every server-action redirect/refresh (crate dissolve, box lost/found) — root-caused and removed (DECISIONS #98). Full suite back to green: 68 unit/integration + 12 e2e.

## M6 part 5 — All nine reports + sorting — 2026-07-23

- **§13 report set complete** (all with audited XLSX): + receipts journal (7/30/90-day filter, operator column), unclaimed cargo (7/14-day colors), client cargo history (search by code → per-lot journey: batches ridden, in stock / in transit / ready / issued), staff activity (receipts/edits/prints/scans per user per day, last 14 days), label print log; in-transit XLSX added to the existing view.
- **Sortable columns** (owner request #13): clickable headers on stock-aging, batch register, receipts journal and unclaimed tables — sort lives in the URL so it composes with filters (DECISIONS #96).
- **Dashboard cost-hygiene warning**: batches departed > 3 days with zero cost entries (spec 6.9) in the attention card (DECISIONS #97).
- Management-only reports (landed cost, client history, staff activity, label prints) gated by `reports.all_warehouses`.

## M6 part 4 — Inventory mode — 2026-07-23

- **📋 Inventory (stocktake) mode** (owner's request, home tile for scan-capable staff): pick a warehouse → scan everything (camera/HID/manual; a crate QR counts all its boxes) with a live X/Y counter → results screen. Boxes recorded elsewhere but scanned here move to this warehouse on submit (`inventory_found` correcting movement; issued/void boxes are listed but never auto-moved). Unscanned boxes become `lost` only when TICKED by a warehouse manager (`receipts.void` gate — operators see the list read-only). The full summary (scanned / moved / lost) goes to admins+logists via Telegram (`InventoryCompleted`). Runs parallel to normal operations (DECISIONS #93).
- **Aging colors 7/14** per the owner: stock/aging report days turn yellow at 7, red at 14 (DECISIONS #94).
- Landed cost confirmed management-only (DECISIONS #95).
- Tests: 68 unit/integration (+ inventory reconciliation: found-here move, manager gate, no-op/skip cases) + 12 e2e.

## M6 part 3 — Dashboard + first reports — 2026-07-23

- **📊 /dashboard** (role-aware, §13): warehouse fill bars (moved here from the home screen per the owner), stock per warehouse (boxes/kg/m³), in-transit batches, last-24h receipts, and an "attention" card — unclaimed, stale stock (> `stale_stock_days`), missing-in-transit and undocumented-transfer counts. Admin/logist/VED/accountant see all warehouses; warehouse staff their own; sales managers land on the pipeline.
- **📑 /reports hub** + the owner's top-3 reports, each with an audited XLSX export:
  1. **Landed cost by client** (`reports.all_warehouses` only): Σ USD per client, drill into per-lot breakdown with $/box.
  2. **Stock & aging**: every lot in stock with boxes/kg/m³/density and days-in-warehouse, oldest first (>14 d orange, >30 d red).
  3. **Batch register**: route, status, departed date, loaded/short-loaded/added-on-spot deviations, kg/m³, costs USD and $/kg (costs hidden from warehouse-scoped staff).
- Home screen: fill card removed, 📊 Dashboard tile added.
- Shared report read-model module (`wms/reports/queries`) reused by pages, XLSX and the dashboard.

## M6 part 2 — Real invoice, capacity, backups (+ owner answers) — 2026-07-23

- **INVOICE & PACKING LIST now mirrors the owner's real ka23 file**: combined sheet with Invoice №/date/container, Sender/Seller/Consignee, transport/delivery-terms/customs-post — all six requisites are editable settings (`ved_*`) with defaults taken from the uploaded document; ТНВЭД column present (VED fills codes+prices), live amount/total formulas (DECISIONS #89).
- **Warehouse capacity indicator**: `capacity_m3` on the warehouse admin form; home screen shows a fill bar per warehouse — yellow from 60%, red + 🚨 from 80% (owner's thresholds, DECISIONS #90).
- **Backups**: nightly 02:00 Tashkent `pg_dump` to `.data/backups` with 30-day retention + manual `pnpm backup` (owner: local disk for now, DECISIONS #91).
- **Loading screen shows crate contents** (owner's request): crated boxes group under `🧰 CR-…` with a "GS777-A 化妆品 · …" summary so the operator scans the crate instead of hunting boxes; sticker-lost list shows the crate chip per box.
- **Vehicle panel collapses to one line** once filled (owner's request) — ✏️ expands it back.
- Plan editor: origin switch now clears the stock list instantly + aborts stale fetches — typed counts can no longer vanish mid-entry (this was also an e2e flake, DECISIONS #92).
- Owner's answers recorded: FX stays manual; dashboard order approved; report priority = landed cost → stock/aging → batch register; inventory runs parallel to operations.

## M6 part 1 — Costing core (W9) — 2026-07-23

- **Allocation engine** (pure, tests-first): all five bases (weight/volume/chargeable/boxes/direct-to-client), 4-dp shares with drift absorbed by the last box; §6.9 worked example passes as a unit test AND as a full two-leg integration test (acceptance test 16): box P rides two batches → landed cost = Σ per-leg shares, each converted at that entry's dated rate; rate edit recomputes; void removes the share.
- **FX rates** (migration 0012, replaces the unused M0 pair-based placeholder): USD-base dated manual rates, `/admin/fx` page (`costs.fx.manage`), rate edits enqueue a per-currency recompute. Currencies with no rate leave entries visibly "no rate" instead of guessing (DECISIONS #86).
- **Cost capture (W9)**: 💰 panel on the batch card (freight/agent/customs…, `costs.enter_batch`) and the receipt page (`costs.enter_receipt`) — type, amount+currency, dated, allocation basis, void with reason; batch card shows Σ USD + unit cost per kg / m³ of the departed load.
- **Materialized `cost_allocations`** rebuilt idempotently by a pg-boss job on entry create/void, FX edit and batch depart (DECISIONS #87–88).
- **Box card shows landed cost** with a per-entry breakdown (receipt/batch/crate share) for cost/report roles.
- Migration 0012 also adds `warehouses.capacity_m3` (fill indicator lands with the M6 dashboards).
- Seed: dated CNY/UZS rates for the worked example. Tests: 65 unit/integration + 12 e2e.

## Feedback round 5 (owner testing) — 2026-07-23

- **Unclaimed labels print the marking**: sticker shows `444-A` (whatever is written on the box) as the dominant code with a small `#UNKNOWN` flag; `#UNKNOWN` alone only when no marking was captured (DECISIONS #82).
- **Per-letter sticker printing**: the after-confirm screen offers a 🖨 button per letter (A, B, C…) next to "print all".
- **Plan editor**: live average density (Ø kg/m³) in the totals bar; place count shown when crates are selected (`Σ 12 📦 · 5 joy`).
- **Truck presets are owner-managed** (`/trucks`, linked via ⚙️ from the plan editor): add/edit/hide with audit — no more seed-only trucks (DECISIONS #84).
- **Crate = one place in a plan** (migration 0011): crated boxes leave loose availability; the editor lists each active crate as a single tickable unit; approval reserves the crate's exact boxes so scanning the crate QR at loading matches the plan (DECISIONS #83).
- **Agent Excel**: ALL lot photos embedded side by side after the data columns (was: single photo in column A).
- **Vehicle info editable until batch close** — wrong plate/driver fixable after departure (DECISIONS #85).
- Planned for M6 (owner's questions): warehouse capacity indicator with red fill warning, inventory/stocktake mode with reconciliation, sortable table columns (PLAN.md M6 #11–13).
- Tests: 59 unit/integration (+ crate-planning lifecycle) + 12 e2e.

## Bugfix round 4 (owner testing) — 2026-07-23

- **File attach fixed**: the upload whitelist was too narrow — now accepts TXT/CSV/ZIP/RAR/7z/GIF/HEIC and MP4/MOV/WebM video (photos ≤15 MB, files ≤25 MB, video ≤60 MB), with an extension fallback for files the browser sends without a content type (common on Windows). Rejections now show the real reason ("type not supported" / "too large") in the operator's language instead of a generic "upload failed".
- **Delete wrongly-added photos/files**: ✕ badge on every thumb/file chip in the receiving screen (lot photos, general photos, receipt files), on the receipt page galleries and attachments panel (for users who can edit). New `DELETE /api/attachments/[id]` — allowed for the uploader and `receipts.edit` holders; removes bytes + thumbnails and writes an audit entry.
- **"Warehouse out of scope" crash fixed**: a stale localStorage draft (same browser, different account) kept a warehouse the operator wasn't assigned to; the confirm action then threw an unhandled AuthError and crashed the page with a digest. The restored draft now snaps back to an allowed warehouse, the action returns a translated error instead of throwing, and a warehouse-scoped operator never sees the all-warehouses fallback (zero assignments → clear "no warehouse assigned" message).
- **Save feedback**: lot edit now collapses on success and shows ✅ Saved (+ label reprint hints); vehicle info form shows a pending state and ✅ Saved on the button (was a silent server action).
- Tests: 57 unit/integration (+ attachment lifecycle, content-type fallback) + 12 e2e.

## M5 — Export & UZ side — 2026-07-23

- **VED documents (W6)**: invoice + packing-list DRAFT XLSX from the actual manifest (blank price column with live amount formulas; company header from settings — real requisites still needed from the owner), "sent to agent" flag with date on the batch card.
- **UZ arrival**: unloading at a customs/distribution warehouse puts cargo straight into `ready_for_pickup`; per-client `ReadyForPickup` Telegram to the sales manager including ready-to-forward client message drafts in uz + ru (cautious "being cleared" wording per the owner's answer).
- **Issue mode (W7)** 🤝: warehouse + client → issuable boxes grouped by lot → tap or scan out → receiver name/phone + "no debt" checkbox (record-only) → partial pickup leaves the rest; handover record + `BoxIssued` notify with remaining count; **handover act PDF**.
- **Quick batch** ⚡: plan-less internal transfers from the batch board — load scanning accepts any loose box at the origin without the not-on-plan ceremony.
- **Sales pipeline view** 📈: per-client counts across in stock → in transit → ready → issued (managers see own clients).
- Home tiles: issue + pipeline are live; no "coming soon" buttons remain.
- Migration 0009 (handovers: nullable receipt, client_id, debt_ok). Tests: 51 unit/integration + 12 e2e (full export chain: plan→load→depart→customs unload→ready→issue→act PDF). DECISIONS #76–81.

## M4 — Transfer receiving — 2026-07-23

- **Unload mode (W5)**: same scanner core + offline outbox as loading; first scan marks the batch `arrived`; on-manifest boxes land `in_stock` at the destination; crate scans fan out; sticker-lost manual entry from the un-unloaded list.
- **Auto-transfer** (edge case 4, reality wins): a known box NOT on the manifest is accepted and moved to THIS warehouse regardless of its recorded location — flagged `undocumented_transfer`, correcting movement, instant logist Telegram. Unknown QR → red toast with a link to the unclaimed intake.
- **Finish unload**: never-scanned manifest boxes flagged `missing_in_transit` + alert; batch card shows them with manager resolutions "found at origin" (back to origin stock) / "found here"; batch → `unloaded` → `closed`.
- **/transit report** (KA hub v1): in-transit/arrived batches + every missing-in-transit box, linked from the batch board.
- Notification rules + Telegram texts for `UndocumentedTransfer` / `MissingInTransit`.
- Tests: 49 unit/integration (+ unload reconciliation, auto-transfer, resolutions, close) + 11 e2e including the full phone round-trip plan→load→depart→unload→close. DECISIONS #71–75.

## M3 — Load planning & scanning — 2026-07-23

- **Plan editor (W3)**: pick origin→dest + truck preset, tick lots from FIFO-sorted stock with photos and days-in-stock, partial box counts, live kg/m³ gauges that go red over capacity but never block; submit creates an immutable version for the agent.
- **Agent loop** (owner's rule: agent stays outside the system): Excel with embedded photo thumbnails per line; the logist records the verdict — changes_requested reopens the editor for v2, approved creates the batch (`YW-001` per-WH sequence) and reserves the lowest-seq boxes as `planned` (no double-planning).
- **Batch card & board**: kanban (forming/loading/in transit/arrived), vehicle info (plate, driver, phone), finish-loading deviation summary (short-loaded boxes revert to stock), depart → everything `in_transit` + `BatchDeparted`, actual-manifest XLSX (fact, not plan — per-box sheet with crate + on-spot flags, per-lot summary).
- **Loading mode (W4)**: camera scanning (native BarcodeDetector, @zxing fallback) + USB/BT HID scanners; <300 ms local verdicts from a cached batch snapshot; big running counter + per-lot progress; duplicate soft-warning; **not-on-plan red screen** with "load anyway + reason" → flagged + instant Telegram to logists; **sticker-lost** manual entry from the unscanned list; **offline outbox** in IndexedDB with idempotent sync and a visible online/offline/pending banner.
- Notifications: PlanApproved / PlanChangesRequested / not-on-plan alerts → logists+admins.
- Seed: two real truck presets. Deferred (recorded in DECISIONS #68–70): SSE live-push, reprint offer in sticker-lost flow, presets admin CRUD.
- Tests: 47 unit/integration (plan lifecycle, double-plan guard, scan idempotency/replay, crate fan-out, finish/depart) + 10 e2e including the full phone lifecycle plan→verdict loop→approve→load→depart→manifest.

## M2 — Stock ops: crates, lost/void, WH-move, unclaimed return, digests, XLSX — 2026-07-23

- **Crates (yashik/karkas, W2)**: schema + `CR-{WH}{YY}-{00000}` codes; mobile builder — pick warehouse + client, tick whole lots or individual boxes, mandatory "Logist approved" checkbox, optional measured dims/weight + note + crating cost (stored scope=crate under the `crating` type, carried to the client for M6 allocation); one-client-per-crate enforced with clear errors (unclaimed cannot be crated); crate label PDF (dominant client code, ЯЩИК/КАРКАС marker, contents A×10-style summary, QR = crate code); crate detail with contents, measurements-after-packing form, photos, dissolve (audited); crate-resolution service ready as the shared primitive for M3–M5 scan modes.
- **Box lost/void/found**: manager-only (`receipts.void` holders) with mandatory reason; lost boxes can be marked found (back to stock, owner's decision); boxes in an active crate must be un-crated first; full movement trail.
- **Wrong-warehouse fix**: manager moves a whole receipt between warehouses with correcting movements — only while everything is still in stock and un-crated; UI prompts a label reprint afterwards.
- **Unclaimed return-to-sender**: whole receipt handed over at once; receiver name + phone mandatory, note/photo optional; boxes → issued (`returned_to_sender`) with a handover record; audited + event.
- **Daily digest**: one consolidated Telegram/in-app message at 09:00 Tashkent to logist + admins — unclaimed cargo older than `unclaimed_aging_days`, stale stock older than `stale_stock_days`, grouped per warehouse; suppressed when empty.
- **Stock XLSX export** from the stock browser with the current filter applied (download-only for now); exports audit-logged.
- Migrations 0006 (crates, handovers, boxes.crate_id FK) + 0007 (cost_entries scope=crate); new home tile 🧰; long home-tile labels now wrap at 360px.
- Tests: +8 integration (crate lifecycle incl. idempotent create, cross-client/unclaimed rejection, crating cost row, lost→found transitions, move guards, return idempotency, digest run) and +4 e2e (crate build→label→dissolve on a phone, lost→found, unclaimed return, XLSX download): 42 unit/integration + 9 e2e, all green.

## Status sync + hygiene sweep — 2026-07-23

- Docs brought up to date with the three feedback rounds: DECISIONS #48–55 recorded (per-lot note removed from intake, ru display-only, single total cost under "other", general box photos as a first-class concept, direct attachment streaming, LightboxImg standard, no photo-required indicator, dual rendering scoped to product lines only); PLAN.md M1/M2/M6 tasks annotated as-built; ARCHITECTURE.md attachment-read path corrected; open questions Q1/Q2 marked answered.
- Cleanup found by a full audit: removed ghost `note` fields from the wizard draft (a stale localStorage draft could silently submit text the operator can no longer see), pruned 21 orphaned i18n keys from all three locales, localized the last hardcoded placeholder (lot editor note).
- Tests caught up with the recent features: the receipt e2e now also uploads a general box photo, enters the single total cost, and asserts the cost + photos on the receipt detail, the stock table (product + amber general photo), and the tap-to-zoom lightbox open/close; the hardcoded debounce sleep replaced with a deterministic response wait; e2e serialized (shared DB/sequencer); CI seeds before vitest.

## Receipt header panel rework — 2026-07-23

- The receipt-info panel is now compact: client row, then one line with the source note + a SINGLE total-cost amount+currency (no more per-type cost rows — stored under the "other" cost type), then two small buttons (📷 general box photos, 📎 files) with thumbnails inline. No stacked label-above-field blocks.
- Removed the photo-required warning icon from product lines (the confirm button staying disabled is the signal).

## Owner feedback round 3 — 2026-07-23

- **Photos fixed**: attachments are now streamed directly by the server instead of redirecting to an absolute URL — the redirect host could differ from the one the browser used (phone on LAN → `localhost` → broken images). Correct content type is set too.
- Receiving: per-line note field removed (only the receipt-level note remains); warehouse+client, general box photos, note, files and costs all live in ONE top panel.
- New: general box photos (receipt-level) with camera upload in receiving, shown in the stock list next to the product photo (amber border) — both open in a tap-to-zoom popup instead of navigating away.
- Russian translation no longer has its own column/field — it shows in parentheses under the Chinese name.
- "Need at least 1 photo" text replaced with a compact ⚠️ icon.
- Mixed-mode line entry order is now m³ first, then kg.

## UI cleanup — receive screen — 2026-07-23

- Receive page reorganized into three aligned panels on every screen size: client/warehouse card → product lines → note/files/costs card, with the sticky totals bar below. No more scattered blocks.
- Desktop table now fits the page without hidden horizontal scroll (per-line Σ totals and delete are visible); tighter column widths, compact cell inputs, wider page container.
- Client and bottom panels are rendered once and shared by both layouts (previously duplicated for desktop/mobile, which also produced duplicate element ids).
- Mobile keeps stacked cards with labeled dims grid; same visual language (cards, compact inputs) as desktop.

## M1.6 — Excel-style desktop entry, notes, receipt files — 2026-07-23

- Desktop (md+ viewport): product lines are now a real spreadsheet-style table — one row per lot, tab through cells like Excel (product zh/ru, boxes, dims, note, photos, live totals) — matches the owner's request to enter receipts "like filling an Excel sheet" on a computer.
- Mobile: unchanged stacked-card layout (kept mobile-friendly per owner's request).
- Replaced the "pieces" (shtuk) field with a free-text **note** per line (owner's Kashgar file uses remarks like "loader miscounted", not a pieces count) — schema column swap (pieces_count/packaging_type → note), service/edit/UI updated.
- Added **receipt-level file attachments** (any type — invoice, packing list, supplier docs, not just box photos) via a shared AttachmentsPanel component, persisted in the draft so they survive reload; shown on the receipt detail page too.
- Costs + notes are no longer hidden behind a collapsed accordion — attachments, costs, and the source note are all visible together in one open section, as requested.
- Fixed a missing i18n key (receive.attachments) caught during visual verification.
- e2e updated for the responsive layout (scoped locators to the visible container) and extended to cover the new note field end-to-end.

## M1.5 — Owner feedback round — 2026-07-23

- Single-window receiving (owner's request): client + Excel-style product lines + collapsed costs + sticky totals/confirm on one screen; no more stepper.
- Excel-like stock table (mirrors the owner's Kashgar file): photo thumbnail, code+letter, product zh(ru), boxes, kg/box, Σkg, m³, density badge, pieces, WH, date; warehouse + text filters; totals row.
- Lot fields from the real file: pieces count and packaging type (optional).
- Unclaimed cargo now captures the marking written on boxes; labels print MARKING-letter instead of #UNKNOWN; assign-to-client (or change-client) action notifies the new client's sales manager.
- Lot editing after confirm per spec 4.4: operator same warehouse-day, manager/logist/admin anytime; box-count changes do label reconciliation (new labels to print / labels to destroy listed); structural fields lock once boxes are in motion.
- Client code validation relaxed to any 2–10 alphanumerics (real codes are 444/555/GS277); auto-generation still uses the GS prefix.
- Fixes: server no longer dies permanently if the DB is briefly unreachable at boot (workers retry in background); wizard uses uuid lib instead of crypto.randomUUID (which is missing on non-HTTPS LAN origins — phone testing over Wi-Fi); photo thumbnails retry with the original variant on error.
- e2e updated: single-window receipt flow + unclaimed-marking intake (5/5 green).

## M1 — Receiving + labels + Telegram — 2026-07-22

- Client code auto-generation: empty code on create ⇒ next sequential code for the configured prefix (advisory-lock protected); manual duplicates still rejected (owner's request).
- Schema: receipts, receipt_lots, boxes, box_movements, product_dictionary, cost_types, cost_entries, counters; trigram indexes for search.
- Letter sequencer (spec 5.3): pure A…ZZ logic with blacklist skip, ZZ→A wrap + cycle_no, optional I/O exclusion — 10 unit tests; transactional assignment under warehouse row lock with a concurrency integration test (acceptance tests 1–4).
- Code generators: receipt numbers ({WH}-IN-{YYMMDD}-{seq}, per-WH-local-day) and box short codes ({WH}{YY}-{000000}, per-WH-year) via lock-safe counters.
- W1 receiving wizard (mobile stepper Client→Lots→Costs→Review→Confirm→Print): fuzzy client autocomplete, unknown-code → unclaimed intake, uniform/mixed lots with live volume/density badge/chargeable weight (acceptance test 5), min-1-photo with client-side compression, letter preview, extra costs with CNY default at CN warehouses, localStorage draft autosave surviving app kill.
- Confirm transaction: letters + boxes + movements + ReceiptConfirmed/UnknownCargoReceived event in one transaction, idempotent by client-generated receipt UUID.
- Label PDF (spec §7): 100×100 mm, dominant client-code+letter, QR = short code, WH-local date, #UNKNOWN variant, embedded subset CJK font (Noto Sans SC); per-receipt/lot/box reprint with audit.
- zh→ru translation pipeline: dictionary exact → trigram fuzzy → pluggable API (LibreTranslate default), cached back into the dictionary; never blocks receiving.
- Notifications: event fan-out to in-app rows + Telegram via pg-boss with retry; grammY bot with /start deep-link account linking from the profile; ReceiptConfirmed → sales manager, UnknownCargoReceived → logist+admins.
- Screens: receipt list/detail (void with reason, per-lot reprint, History tab, photos), stock browser WH→client→lot→box with full box timeline, unclaimed pool, global search incl. the combined gs777-a form.
- Seed: canonical GS777 receipt (化妆品→A 250 kg/1.25 m³, 键盘→B, 鼠标 mixed→C), GS102 → D, cost types, dictionary entries — idempotent.
- Tests: 34 unit/integration + 4 Playwright mobile e2e (incl. the full receiving flow with photo upload and PDF check).

## M0 — Platform foundation — 2026-07-22

- Next.js 15 + strict TypeScript scaffold; pnpm workspace; Tailwind; docker-compose (app/postgres/minio/backup) for deploys.
- Drizzle schema + migrations: users, sessions, login_attempts, RBAC tables, warehouses (with letter-sequencer state), clients, settings, currencies, fx_rates, letter_blacklist, audit_log (append-only, DB-level immutability trigger + revoked grants), events, notifications, telegram_links, attachments; pg_trgm + trigram indexes.
- Auth: phone/username + Argon2id, httpOnly 30-day rolling sessions in Postgres, 5/15min rate limiting, device list + "logout other devices".
- Data-driven RBAC seeded from the §16 matrix; single `authorize()` server-side gate with warehouse scoping.
- Audit write path (changed-fields before/after diff) on every mutation; reusable History tab; admin global audit browser with filters; domain-event emitter + events table.
- Admin CRUDs: warehouses, clients (code validated against `client_code_prefix`), users (roles + warehouse binding); settings editor for all §17 keys.
- i18n: next-intl with ru/uz/zh-CN catalogs, per-user locale, header switcher.
- Files: storage abstraction (S3/MinIO + signed local-disk dev driver), upload API, sharp 200/800px thumbnails via pg-boss, photo gallery component.
- PWA: manifest + icons + Serwist app-shell caching; role-aware Home with big-button shortcuts; high-contrast UI, no horizontal scroll at 360px.
- Observability: pino logs, `/health`, pg-boss started via instrumentation hook.
- Seed: 7 warehouses, 11 users (one per role, `demo1234`), 20 clients (GS777→Dilnoza), currencies, blacklist AM/XU, settings, permission matrix.
- Tests: 15 unit (audit diff, RBAC matrix, client-code format) + 3 Playwright mobile e2e (login guard, admin CRUD + audit flow, warehouse-scope isolation); GitHub Actions CI (typecheck, lint, unit, migrate+seed, build, e2e).

## Planning stage — 2026-07-22

- Added `docs/SPEC.md` — the Phase 1 WMS build specification (single source of truth).
- Added `docs/ARCHITECTURE.md` — application architecture + complete PostgreSQL/Drizzle schema design for all milestones.
- Added `docs/PLAN.md` — M0–M6 task breakdown, acceptance-test mapping, edge-case → milestone table, testing strategy, and open questions for the owner.
- Added `DECISIONS.md` — 24 pre-implementation ambiguity resolutions.
- No application code yet — implementation starts with M0 after owner approval.
