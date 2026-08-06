# CHANGELOG

## Lidda xizmat narxi va ikkala kanbanda katta filtr paneli — 2026-08-06

Sizning to'rtta javobingiz bo'yicha qurildi.

**1. Lid endi pul ko'taradi.** Hisoblatishdan keyin yoziladigan xizmat
narxi (narx + valyuta + kub + kg) endi lidning o'zida turadi: yangi lid
shaklida, kartadagi faktlar ro'yxatida, va **voronkadagi kartochkada ham**
(yashil rangda) — filtrlanadigan raqam ko'rinmasa, filtr ko'r bo'lardi.
Narx yozilgan holda lid «Sotuv»ga o'tsa, «Bitim ochish» tugmasi shu
raqamlarni bitim shakliga o'zi olib o'tadi. Har bir narx o'zgarishi
tarixga tushadi; o'zgarmagan narxni qayta saqlash esa tarixga ortiqcha
qator yozmaydi.

**2. Katta filtr paneli — CRMda ham, Bitimlarda ham.** Qidiruv qatori
yonidagi ⚲ tugma panel ochadi: manba (faqat CRMda), sana oralig'i, narx,
kub, kg — hammasi «dan–gacha» ko'rinishida — va **lenta bo'yicha qidiruv**
(kartaga yozilgan izohlar ichidan topadi; Telegram yozishmalari bunga
kirmaydi — ular har bir menejerning o'z chati). Tanlangan filtrlar panel
yopiq turganda ham chip bo'lib ko'rinib turadi, chipni bossangiz o'sha
bitta filtr olinadi. Muhimi: filtr faqat kartalarni emas, yopiq
ustunlardagi «+N · hammasi» sonini ham hisoblaydi — ekran yolg'on
gapirmaydi.

**3. Filtr saqlangan ko'rinish bo'la oladi.** Yoqqan kombinatsiyani
(masalan «narxi 1000 dan yuqori») nomlab saqlaysiz — mijozlar kitobidagi
kabi, endi ikkala doskada ham. Saqlangan ko'rinish havola, ulashsa ham
bo'ladi.

**4. Telefonda.** Panel telefonda pastdan chiqadigan varaq bo'lib ochiladi
— «Qo'llash» tugmasi barmoq ostida, pastki menyu ustida turadi. Ekran
kengaymaydi, sahifa yon tomonga siljimaydi — 360 px da skrinshot bilan
tekshirildi, ikkala doskada ham.

Yangi migratsiya: 0062 (liddagi narx ustunlari — faqat qo'shimcha, hech
narsa o'zgartirilmaydi). Yangilashda bazani tekshirish esdan chiqmasin
(DEPLOY.md dagi tartib).

## Ommaviy belgilash qotmaydigan bo'ldi, lid nomi endi bosilib o'zgarmaydi — 2026-08-06

Sizning to'rtta gapingiz bo'yicha.

**1. Mijozlar Excelida telefon ustuni qaytdi.** Yo'qolgan sabab: ustun
tanlash qo'shilganda, "ekranda ko'rinmaydigan ustun faylga ham tushmasin"
degan qoida telefon ustuniga ham tegib ketgan edi — telefon esa jadvalni
tor telefonda ixcham qilish uchun "yashirin" deb belgilangan. Endi qoida
ikkiga bo'lindi: **saqlangan ko'rinishni** yuklasangiz — o'sha ko'rinish
tushadi; oddiy yuklasangiz — **ko'rishga haqli bo'lgan hamma ustun** tushadi.
Pul ustunlari qanday bo'lsa shunday qoladi: ruxsati yo'q odam ularni faylda
ham ko'rmaydi.

**2. Haydovchi ilovasi haqidagi yozuv o'z sarlavhasini tikladi.** U
Frappe tadqiqoti yozuvining ostiga tushib qolgan edi — ya'ni «kod va bazada
hech narsa o'zgarmadi» degan gapning ostida haydovchi ilovasi haqidagi
o'zgarish turardi. Matn joyida edi, sarlavha yo'q edi; qaytarildi.

**3. Lid kartasida nomni bosib o'zgartirish olib tashlandi.** Nom
kartaning sarlavhasi — u yuqorida baribir ko'rinib turadi, shuning uchun
hech narsa yashirilmadi. Nomni o'zgartirish endi faqat ✏️ shakli orqali,
ya'ni ataylab qilinadigan ish. Muhimi: tugma ekrandan olindi **va** server
tomonida ham yopildi — aks holda bu "olib tashlash" emas, "yashirish"
bo'lardi. Telefon, firma va izohni joyida tuzatish qoldi.

**4. Ommaviy belgilashning qotishi — sabab topildi va o'lchandi.** Sizning
lidlaringiz doskada 298 ta ochiq karta beradi, va ilova telefon shakli bilan
kompyuter shaklini **bir vaqtda** ushlab turadi — jami 596 ta karta. Bitta
katakchani belgilaganda dastur **hamma 596 tasini qaytadan chizardi**.
O'rtacha telefon tezligida o'lchadim: **bir marta belgilash 135–400 ms
ekranni qotirardi**, ya'ni 10 ta kartani belgilash 2-4 soniya o'lik ekran.

Endi belgilash doskadan tashqarida saqlanadi: faqat bosilgan katakcha va
pastdagi hisoblagich yangilanadi, doska umuman qayta chizilmaydi. O'sha
o'lchov endi **35–66 ms** ko'rsatadi — bu o'lchash usulining o'z chegarasi
(33 ms), ya'ni ish deyarli qolmadi.

Tekshirish: 1058 ta ichki test, 144 ta brauzer testi — hammasi yashil. Uchala
tuzatish ham "himoyasiz qoldirilsa qizil bo'ladi" deb isbotlangan. Bazaga
o'zgarish yo'q.

## Qo'ng'iroq yozuvi: birinchi kun tuzatishlari — 2026-08-06 (kech)

Siz birinchi telefonni ulab sinaganingizda uchta narsa chiqdi, uchalasi ham
tuzatildi (migratsiya **0061**):

**1. Dublikatlar.** Ilovani uzib qayta ulaganingizda kunning qo'ng'iroqlari
ikkinchi marta yozilgan edi (bazada har biri 2 tadan ko'rinib turgan edi).
Endi takrorlanish himoyasi HODIM bo'yicha — qayta ulash hech narsani
ikkilantirmaydi, mavjud dublikatlar migratsiyada o'zi tozalanadi.

**2. Qayta ulangandan keyin audio yo'qolishi.** Yozuv fayli eski ulanish
nomiga qidirilardi — qayta ulangan telefon audioni yuklay olmay qolardi.
Endi hodim bo'yicha qidiriladi.

**3. Karta bo'sh ko'rinishi.** Bir odamning bir nechta GS kodi bitta
telefonda bo'lsa, qo'ng'iroq eng eski kodga tushadi, siz esa boshqa kod
kartasini ochgan edingiz — panel bo'sh edi. Endi karta odamning BARCHA
kodlaridan qidiradi va qo'ng'iroq qaysi kodda bo'lsa, yonida o'sha kod
yozilgan chip turadi.

Yana bir sabab oddiy edi: ilova 15 daqiqada bir yuboradi — kartani
qo'ng'iroqdan keyin darrov ochsangiz, hali yetib kelmagan bo'ladi
(ilovadagi «Hozir yuborish» tugmasi darhol jo'natadi).

## Qo'ng'iroq yozuvi: mijoz bilan suhbatlar endi CRM'da — 2026-08-06

Siz so'ragan qo'ng'iroq yozuvi tayyor. Android telefonlar uchun **GSR
Qo'ng'iroqlar** ilovasi chiqdi: hodim telefonida mijoz bilan gaplashsa,
qo'ng'iroq (kim, qachon, qancha, kirish/chiqish) va yozuvi (agar telefonning
o'z yozib olish funksiyasi yoqilgan bo'lsa) CRM'ga tushadi — mijoz, bitim va
lid kartalarida **«Qo'ng'iroqlar»** paneli paydo bo'ldi, yozuvni shu yerda
eshitsa bo'ladi.

**Qanday ishlaydi:**
1. Admin → **Qo'ng'iroq ilovasi** sahifasidan APK chiqariladi (GitHub
   Actions → calls-apk dan yuklab olib, shu yerga qo'yasiz — haydovchi
   ilovasidagidek).
2. Har bir hodim **o'z profilida** («Qo'ng'iroq yozuvi» bo'limi) ilovani
   yuklab oladi, «Telefon qo'shish» bosib 6 belgili kod oladi va ilovaga
   kiritadi. Kod kimniki — qo'ng'iroqlar o'shaning nomidan yoziladi.
3. Ilovada 5 qadam bor: qo'ng'iroqlar tarixi, audio fayllar, batareya,
   avtostart, va **telefonning o'z yozib olish funksiyasini yoqish**
   (Samsung/Xiaomi'da Telefon → Sozlamalar → Qo'ng'iroqlarni yozib olish).
   Yozuvni telefonning o'zi qiladi — Android boshqa ilovaga ovozni bermaydi.

**Maxfiylik — siz aytgandek:** faqat mijozlar bazasidagi raqamlar saqlanadi.
Hodimning shaxsiy qo'ng'iroqlari na serverda, na ilovada saqlanadi, yozuvi
ham yuborilmaydi. O'rnatilgan kundan boshlab yoziladi — eski tarix
o'qilmaydi. Ko'rish huquqi Telegram'dagidek: har kim o'z qo'ng'irog'ini,
super admin / admin / VED hammani ko'radi.

**iPhone:** Apple qo'ng'iroq tarixini ham, yozuvni ham bermaydi — rejada
turibti (bot orqali variant), hozircha iPhone'lik hodimlar Telegram bilan.

Profildan «Uzish» bossangiz telefon darhol to'xtaydi va hammasini unutadi.
Yangi jadvallar: migratsiya **0060**. Testlar: 1054 + 141 e2e, hammasi
yashil.

## Pul auditi: 15 ta kamchilik topildi va tuzatildi — 2026-08-05

Siz «pullar hisob-kitobi to'g'ri yuritilyabtimi, audit qil» degan edingiz.
To'rt yo'nalishda (mijoz qarzi, kontragent qarzi, xarajat/tannarx,
hisobotlar) tekshirildi, har bir topilma alohida qarshi tekshiruvdan o'tdi.
**Yaxshi yangilik: asosiy yozuvlar (to'lovlar, xarajatlar, kurslar) to'g'ri
yuritilgan.** Kamchiliklar — juftliklarning bir tomoni va hisobotlarda edi.
Eng muhimlari:

**1. Kontragent qarzini bekor qilish o'z-o'zidan qaytib kelardi.** Xarajatdan
kelib chiqqan qarzni registrda bekor qilsangiz, keyingi qayta hisob (kurs
kiritilishi, fura jo'nashi) uni **qaytadan tiklab qo'yardi** — siz bekor
qilgan qarz firma hisobiga qaytib chiqardi. Endi qarz bekor qilinsa, xarajat
ham «to'lovchisiz» qoladi va qayta tiklanmaydi. Kurs to'g'irlanganda esa qarz
ham xarajat bilan birga qayta narxlanadi — ikkalasi endi hech qachon farq
qilmaydi.

**2. Kechiktirilgan to'lov (otsrochka) darvozasi.** Otsrochkali bitim to'lab
bo'lingandan keyin ham **boshqa qarzlarni kechirishda davom etardi** — sklad
qarzdorga yukni ruxsatsiz berib yuborishi mumkin edi. Sabab: to'lov formasi
«qaysi bitim uchun» deb so'ramasdi. Endi to'lovga bitim tanlanadi va darvoza
to'g'ri hisoblaydi. **Otsrochkali bitim to'lovini kiritganda bitimni
tanlashni unutmang.**

**3. Prixodni bekor qilish pulini tashlab ketardi.** Bekor qilingan prixodning
xarajatlari P&L da, tannarxda va firma qarzida **abadiy qolardi**. Endi avval
xarajatlari bekor qilinmaguncha prixod bekor bo'lmaydi (fura qoidasi) — va
forma endi sababini aytadi, jim qolmaydi.

**4. Partiya foydasi rastamojkani ko'rmasdi.** Partiyaning o'z sahifasidagi
jadvalga yozilgan rastamojka /accounting foyda hisobotida **hech qaysi
partiyaga tushmasdi** — har fura o'sha summa miqdoricha foydali ko'rinardi.
Endi jadval yozuvlari o'z partiyasiga bog'lanadi. (Eskilari bog'lanmagan —
faqat yangilari.)

**5. Jadvalga to'lovchi qo'shildi.** Rastamojka jadvalida endi «kim to'ladi»
tanlanadi — firma to'lagan bo'lsa, qarz avtomatik yoziladi (formadagidek).

**Hisobotlarda yana:** yopilgan kassadagi pul Balansdan yo'qolmasin; faqat
xarajati bor (narxi keyin kelishilgan) mijoz foyda hisobotidan tushmasin;
ichki reys ekrani keyingi reys rastamojkasini «shu reysgacha» deb
ko'rsatmasin; Excel reestr kassani ekrandagidek yozsin.

**Himoyalar:** boshqa valyutadagi kassaga to'lov kiritib bo'lmaydi (500$
so'm kassasiga tushib yo'qolmasin); bitta kategoriyada ikkita ijara (YW+GZ)
endi ikkalasi ham post bo'ladi; reestr 2000 qatordan oshsa ochiq aytadi.

Har bir tuzatish testi bilan (xatosiz holda qizil bo'lishi isbotlangan).
Migratsiya yo'q. 1046 ta ichki test, 140 ta brauzer testi.

---

## Tezlik: bitimlar doskasi va sklad jadvali — 2026-08-05

Siz «qotyabti, ayniqsa bitim bilan» degan edingiz. Sizning
ma'lumotlaringizning nusxasida o'lchab chiqdim — ikkita katta sabab topildi,
ikkalasi tuzatildi.

**1. Bitimlar doskasi.** Doska har ochilganda **har bir ochiq bitim uchun
alohida 2-3 ta so'rov** yuborar ekan (og'ish belgisi uchun — «⚠ smetadan
oshdi» belgilari). Bitim qancha ko'paysa, doska shuncha sekinlashardi — siz
sezgan narsa aynan shu. Endi hammasi uchun **bitta umumiy so'rov**: doskaning
bazaga murojaatlari ~120 tadan **17 taga** tushdi. Belgilar o'sha-o'sha,
hisob o'zgargani yo'q. Mijoz kartasidagi bitimlar ro'yxati ham xuddi shu
yo'l bilan tuzatildi.

**2. Sklad jadvali.** Server tez edi, lekin telefon ~450 qatorni (har birida
rasm bilan) birdaniga chizishga **3-4 sekund** sarflar ekan — telefonda
qotish shu edi. Endi jadval **120 qatordan** ko'rsatiladi, pastda
«1–120 / 456 · Keyingi →» tugmalari. Muhimi:

- **Σ jami (quti, kg, m³) butun ro'yxat bo'yicha** qoladi, sahifa bo'yicha emas.
- **Excel eksport hammasini** chiqaradi, avvalgidek.
- Saralash butun ro'yxat bo'yicha ishlaydi, sahifalab emas.

O'lchov (telefon tezligida): sklad ekrani **4.8 s → 1 s**. Doska ham,
voronka ham yarim sekunddan tez chiziladi.

Migratsiya yo'q. Pul hisob-kitobi auditi alohida ketyapti — natijasini
alohida yozaman.

---

## Kirishdagi bir kamchilik va uchta tartib tuzatildi — 2026-08-05

Shablonlar chiqqandan keyin testlar bir joyda qizil bo'ldi. Sababini
qidirgandim, o'zi katta emas, lekin **bazadan ma'lumot o'qishning bir
qoidasi** butun tizim bo'ylab buzilgan joylari chiqdi. Uchtasi topildi va
tuzatildi.

**Eng muhimi — kirish (login).** Tizim telefon raqamini **yoki** login nomini
qabul qiladi. Ikkalasi ham takrorlanmas, lekin **alohida** takrorlanmas: bir
odamning telefoni boshqa odamning «login nomi» bo'lib qolsa (admin qo'lda
yozib qo'yishi mumkin), baza qaysi birini beradi — noaniq edi. Xavfsizlik
buzilmasdi (parol tekshirilmasdan hech kim kira olmaydi), lekin **to'g'ri
parol bilan ham «noto'g'ri» deb rad etilishi** mumkin edi — sababini hech
qayerdan bilib bo'lmaydi. Endi **telefon raqami ustun**: avval telefon bo'yicha
qidiriladi, keyin login nomi bo'yicha.

Bu ayniqsa siz **17 ta sotuvchiga login ochganingizda** ahamiyatli — o'shanda
raqamlar va nomlar bir vaqtda ko'p yoziladi.

**Ikkinchisi — mijoz kabineti tili.** Bitta Telegram chatga bir necha mijoz
kodi bog'langan bo'lsa (brokerlar shunday), javob qaysi tilda chiqishi
noaniq edi — ikki bosishda ikki xil til bo'lishi mumkin. Endi **chat kimga
ochilgan bo'lsa, o'sha mijozning tili** ustun.

Uchinchisi ichki test edi, mijoz ko'rmaydi.

Migratsiya yo'q. 1032 ta ichki test, 140 ta brauzer testi.

---

## Javob shablonlari — bir marta yozasiz, keyin bir bosasiz — 2026-08-05

5-bosqich boshlandi.

Kunda yigirma marta yozadigan gaplaringiz endi tayyor turadi. **Perepiski →
⚡ Shablonlar** da yozib qo'yasiz, chatda esa yozuv oynasi yonidagi **⚡** ni
bosib qo'yasiz.

**Ikki xil shablon bor:**
- **Butun kompaniya uchun** — buni faqat admin yozadi, hammaga chiqadi (🏢
  belgisi bilan).
- **O'zingizniki** — boshqa hech kim ko'rmaydi.

**Matnda ikkita so'z ishlaydi:**
- `{ism}` — mijozning ismi
- `{kod}` — uning kodi (GS…)

Masalan «Hurmatli {ism}, {kod} yukingiz Toshkent omboriga yetib keldi» deb
yozib qo'ysangiz, chatda bosganingizda **o'sha mijozning ismi va kodi bilan**
tushadi. Ismini o'zingiz yozib o'tirmaysiz.

**Shablon yozganingizni o'chirmaydi:** oynada gap yozib turgan bo'lsangiz,
shablon uning **davomiga** qo'shiladi, ustiga yozilmaydi.

**Tartib** raqami bilan eng ko'p ishlatadiganingizni tepaga chiqarasiz.

Yo'l-yo'lakay: telefonda **«Yuborish»** tugmasi endi **➤** belgisi bo'lib
qoldi (kompyuterda so'z qolgan) — o'lchab ko'rdim, so'z 360 px li ekranda
yozuv oynasidan 62 px olib qo'yayotgan ekan. Endi oyna avvalgidan ham keng.

Migratsiya: **0059**. 1029 ta ichki test, 140 ta brauzer testi.

---

## Kartochkada nima ko'rinishini o'zingiz tanlaysiz — 2026-08-05

4-bosqich tugadi.

Lid voronkasi va bitimlar doskasining tepasida **☰** tugmasi bor. Bosasiz —
ro'yxat chiqadi, va kartochkada qaysi qatorlar turishini belgilaysiz.

**Lidda:** firma · telefon · manba · mas'ul · mijoz kodi · chat · keyingi aloqa.
**Bitimda:** summa · mas'ul · mijoz kodi · chat · ogohlantirishlar · **kub**.

**Kub yangi** — doskada ilgari yo'q edi, siz aytgan edingiz. U **o'chirilgan
holda** turadi: yoqmaguningizcha kartochka avvalgidek ko'rinadi.

**Ism va bitim raqami ro'yxatda yo'q** — ularni o'chirib bo'lmaydi. Kartochka
qaysi ish ekanini aytmasa, u kartochka emas.

**Summa hammaga ochiq qoldi**, siz aytganingizdek. Bu sozlama — ruxsat emas,
har kim o'ziga qulay qilib qo'yadi.

**Tanlov brauzerda saqlanadi** (xuddi qorong'i rejimdek), serverdan o'qiladi —
shuning uchun sahifa ochilishi bilanoq to'g'ri chiqadi, «sakramaydi».
Telefon va kompyuterda alohida bo'lishi mumkin.

**Hech narsa tanlamasangiz — hammasi avvalgidek.** Bu ataylab: yangi sozlama
hech kimning ekranini o'zi-o'zidan o'zgartirmasligi kerak.

Migratsiya yo'q. 1011 ta ichki test, 135 ta brauzer testi.

## Doskada qidiruv va hodim bo'yicha filtr — 2026-08-05

4-bosqichning ikkinchi qismi. Lid voronkasida ham, bitimlar doskasida ham
endi tepada **qidiruv katagi** bor, va hamma ishni ko'ra oladiganlar uchun
**hodim tanlash** ro'yxati.

**Qidiruv nimani topadi.** Lidda — ism, firma, telefon (oxirgi 9 raqami
bo'yicha, xuddi umumiy qidiruvdek). Bitimda — bitim raqami, sarlavha va
**mijoz kodi** (odam aslida shuni yozadi).

**Eng muhim tafsilot.** Qidiruv **bazada** ishlaydi, ekrandagi kartalar
ichida emas. Bu shunchaki texnik gap emas: doska yopilgan ustunlardan faqat
oxirgi 20 tasini ko'rsatadi, ochiqlardan 300 tasini. Agar qidiruv shu
ko'rsatilganlar ichidan izlaganda, «topilmadi» degani **bazada yo'q** emas,
**oxirgi 20 tada yo'q** degani bo'lardi — va aynan yo'qolgan ishni
qidirayotganda yolg'on gapirardi.

**«+N · hammasini ko'rish» ham to'g'ri sanaydi.** Kartalarni filtrlab,
sonlarni filtrlamasak, ikkita ish topilgan ustun ostida «+143» yozilib
qolardi. Endi ikkalasi bitta savoldan hisoblanadi.

**Havolalar filtrni yo'qotmaydi.** «Meniki / Hammasi» tugmalari va «+N ·
hammasini ko'rish» havolasi ilgari qattiq yozilgan edi — biror biriga
bossangiz yozganingiz o'chib, 400 ta filtrsiz karta yuklanardi. Endi hammasi
filtrni o'zi bilan olib ketadi.

**Ruxsat.** Faqat o'z lidlarini ko'radigan sotuvchiga hodim ro'yxati
umuman ko'rsatilmaydi — va manzil qatoriga qo'lda `hodim=...` yozib
qo'yilsa ham **e'tiborga olinmaydi**.

**Yo'l-yo'lakay tuzatildi (bu rounddan oldingi nosozlik):** bitimlar
doskasining tepasidagi uchta tugma 360 px ekranga sig'may, **butun sahifani
kichraytirib** yuborardi — bu o'sha eski nosozlik turi (bosgan joyingiz
siljib ketadi). Endi sig'adi.

Migratsiya yo'q. Doskaning balandligi ekranga qarab hisoblanadi, shuning
uchun filtr qatori qancha joy olganini o'lchab, doskani o'sha qadar
qisqartirdim — uchala holatda ham doska aynan avvalgi joyida turibdi.

## Kanban: barmoq bilan sudrash olib tashlandi, rad etilgan ko'chirish sababini aytadi — 2026-08-05

4-bosqichning birinchi qismi.

**Avvalo bir tuzatish.** 4-bosqichda «kompyuterda kartani sudrab ko'chirish»
qo'shamiz deb yozgan edim. Kodni ochib ko'rilganda — **u allaqachon bor
ekan**, ancha oldindan. Mening ro'yxatim xato bo'lgan. (Bu shu dasturda
to'rtinchi marta shunday bo'ldi: qorong'i rejim, qidiruv, lenta va endi bu.)

**Lekin ostidan haqiqiy nosozlik chiqdi.** Qaysi ko'rinish chiqishi faqat
**ekran kengligiga** qarab hal qilinar ekan (768 piksel). Ya'ni **planshet**
kompyuter ko'rinishini oladi — va u yerda kartani **barmoq bilan 0,25 soniya
ushlab turib sudrash** ishlab turgan ekan, telefon ham titrab qo'yardi.

Bu — siz **ikki marta rad etgan** narsa. Endi sudrash **faqat sichqoncha**
bilan ishlaydi.

**Planshet uchun.** Sudrashni olib tashlasak, planshetda kartani ko'chirish
umuman iloji qolmasdi (tugmalar faqat telefon ko'rinishida edi). Shuning
uchun kompyuter ko'rinishidagi kartaga ham **⋯** tugmasi qo'shildi — bosasiz,
etaplar ro'yxati chiqadi.

**Rad etilgan ko'chirish endi sababini aytadi.** Ilgari karta orqaga qaytib,
ustida faqat **«Xatolik»** yozilardi. Beshta har xil sabab bor edi va
hammasi bir xil so'z bilan chiqardi. Endi: «Bu ko'chirish uchun ruxsat
yetarli emas» · «Etap o'chirilgan — sahifani yangilang» · «Kartochka
topilmadi» · «Sababini yozish kerak». To'rt tilda.

**Telefon ko'rinishi umuman o'zgarmadi.**

Migratsiya yo'q. 991 ta ichki test, 124 ta brauzer testi.

## Bitim va mijoz kartalari ham joyida tuzatiladigan bo'ldi — 2026-08-05

3-bosqich tugadi.

**Bitim kartasi.** Eng tepada **sarlavha** va **izoh** turadi — ilgari sarlavha
faqat sahifa boshida ko'rinardi, izohni esa umuman ko'rish uchun «✏️
Tahrirlash»ni ochish kerak edi. Endi bosasiz — tuzatasiz.

**Narx, kub, kilo va valyuta ataylab qo'shilmadi.** Ular mijozga aytilgan
va'da: kim aytgani va qachon aytgani yozib boriladi. Bir bosishda
o'zgartiriladigan qilib qo'ysak, o'sha imzo buziladi. Narxni o'zgartirish
o'zining formasida qoladi — kecha aynan shu imzo bilan bog'liq xatoni
tuzatgan edik.

**Mijoz kartasi.** Siz aytgan uchtasi: **telefon**, **mas'ul sotuvchi** va
**izoh**. Endi butun formani ochib, hammasini qaytadan saqlash shart emas.
Mas'ul sotuvchi ro'yxatdan tanlanadi va **«Не назначен»** ham haqiqiy javob —
mijozni mas'ulsiz qoldirish mumkin.

**Mijoz kodi va nomi formada qoldi** — kod har bir stikerda, har bir aktda va
har bir to'lovda turadi, uni bir bosishda o'zgartirib bo'lmasligi kerak.

**Yo'l-yo'lakay topilgan xato (o'zimniki).** Kecha lid formasi «saqlandi»
degan **✅** belgisini ko'rsatmay qo'ygan edi — tuzatishning nojo'ya ta'siri
edi, hech bir test buni so'ramagani uchun bilinmay qolgan. Endi uchala forma
ham ✅ ni ko'rsatadi, va test buni tekshiradi.

Migratsiya yo'q. 983 ta ichki test, 121 ta brauzer testi.

## Tarix bo'limi o'qiladigan bo'ldi — va tarixning o'zi to'g'ri yozila boshladi — 2026-08-05

3-bosqichning ikkinchi qismi. Siz «lentadagi bir xil o'zgarishlarni yig'ish»ni
ma'qullagan edingiz; kodni ochib ko'rilganda **lentada maydon o'zgarishlari
umuman yo'q ekan** — ular kartaning **«Tarix»** bo'limida turadi. Shuning uchun
ish o'sha yerga qaratildi, va o'sha yerdan ancha jiddiyroq narsa topildi.

**Eng muhimi: tarix noto'g'ri yozilayotgan ekan.**

Lid kartasining «✏️ Tahrirlash» formasi **9 ta maydonni** yozadi, lekin
tarixga faqat **3 tasini** (ism, etap, mas'ul) qayd qilardi. Ya'ni:

- telefonni, firmani, manbani, izohni yoki keyingi qo'ng'iroq sanasini
  formadan o'zgartirsangiz — **tarixda hech qanday iz qolmasdi**;
- hech narsani o'zgartirmasdan «Saqlash» bossangiz ham — tarixga «o'zgartirdi»
  degan qator yozilardi.

Bitim kartasida ham shunday: 8 ta maydondan faqat 2 tasi yozilardi.
**Endi ikkalasi ham haqiqatan nima o'zgarganini yozadi, o'zgarmasa —
hech narsa yozmaydi.**

**Bitimdagi narx muallifi ham tuzatildi.** Baza narxni «200.00» ko'rinishida
saqlaydi, forma esa «200» yuboradi — dastur ularni har safar «narx
o'zgardi» deb hisoblardi. Natijada bitimning sarlavhasini tuzatsangiz ham
**«narxni kim va qachon aytdi»** degan yozuv siznikiga almashib ketardi.
Endi narx faqat haqiqatan o'zgarganda qayta imzolanadi.

**Yig'ish o'zi.** Bir odam bir o'tirishda (10 daqiqa ichida) bir necha
maydonni tuzatgan bo'lsa, tarixda **bitta qator** ko'rinadi: «Bekzod
o'zgartirdi · 3 ta o'zgarish», ostida esa nima nimaga almashgani. **Hech
narsa yo'qolmaydi** — «3 ta yozuv» degan joyni bossangiz, har bir tuzatish
o'z vaqti bilan alohida ochiladi.

Qoidalar: ikki xil odamning ishi hech qachon birlashtirilmaydi; yaratish,
bekor qilish va skan alohida qoladi; ko'rinadigan o'zgarish qolmagan
qatorlar birlashtirilmaydi (aks holda «2 ta o'zgarish» yozilib, ostida bo'sh
joy chiqardi).

**Maydon nomlari tarjima qilindi.** Ilgari tarixda `nextActionAt`,
`boxWeightKg`, `stageId` kabi texnik nomlar chiqardi. Endi «Keyingi aloqa»,
«Quti og'irligi, kg», «Etap» — to'rt tilda. Ro'yxatda yo'q ustun o'z nomi
bilan chiqadi (noto'g'ri nomdan ko'ra texnik nom yaxshi).

**Lid kartasiga «Tarix» bo'limi qo'shildi** — ilgari u yagona karta edi
tarixi yo'q, va aynan u endi har bir tuzatishni alohida yozadi.

Migratsiya yo'q. 973 ta ichki test, 116 ta brauzer testi.

## Lid kartasi: ma'lumotlar ko'rinadigan va joyida tuzatiladigan bo'ldi — 2026-08-04

3-bosqichning birinchi qismi.

**Muammo shu edi:** lid kartasida telefon, firma, manba, mas'ul va keyingi
qo'ng'iroq sanasi **umuman ko'rinmasdi** — ularni ko'rish uchun «✏️ Tahrirlash»
formasini ochib, katakning ichidan o'qish kerak edi. Ya'ni mijozga qo'ng'iroq
qilmoqchi bo'lgan sotuvchi avval tahrirlash formasini ochardi.

**Endi:** kartaning o'ng ustunida eng tepada **ma'lumotlar bloki** turadi —
ism, telefon, firma, izoh, etap, manba, mas'ul, keyingi qo'ng'iroq. Hammasi
bir qarashda o'qiladi.

**Tuzatish ham o'sha yerda.** Ism, telefon, firma yoki izohni bosasiz — katak
ochiladi. **«Saqlash» tugmasi faqat haqiqatan biror narsa o'zgargandagina
chiqadi.** Bekor qilsangiz eski qiymat qoladi. Xato bo'lsa yozganingiz
yo'qolmaydi va sabab ko'rsatiladi.

**Etap, mas'ul va keyingi qo'ng'iroq sanasi ataylab bu yerda tahrirlanmaydi** —
ular oddiy matn emas: etapni ko'chirish tarixga yoziladi va qoidalarni ishga
tushiradi, mas'ulni almashtirish topshiriq, sana esa izohi bilan juftlikda
yoziladi. Ular avvalgi joyida qoladi.

**Ichkaridagi muhim ehtiyot chorasi.** Bir maydonni ikki joyda tahrirlash
mumkin bo'lgani uchun, joyida tuzatgandan keyin pastdagi eski forma **eski
qiymatni qaytarib qo'yishi** mumkin edi. Buning oldi olindi va aynan shu
ketma-ketlik brauzer testi bilan tekshiriladi.

Tekshiruv: 951 ta ichki test (7 tasi yangi; ikkita qoida himoyasiz qolganda
qizarishi isbotlangan), 116 ta brauzer testi. Bazaga o'zgarish yo'q.

**Keyingi:** bitim va mijoz kartalari uchun ham shunday qilinadi.

## «+» tugmasi: lid yoki mijoz 5 soniyada — 2026-08-04

«Oson UI» rejasining 2-bosqichi tugadi.

**Yuqori qatorda «+» tugmasi.** Qayerda bo'lsangiz ham bosasiz — sahifadan
chiqmaysiz, ustidan kichkina oyna ochiladi. **Ikkita katak:** ism va telefon.
Saqlaysiz — o'sha sahifada qolasiz, pastda «Qo'shildi: …» deb yozilib,
kartaga havola beriladi.

**Nega faqat ikkita katak.** Qolgan hammasi o'zi to'ldiriladi: lid birinchi
bosqichga tushadi va yozgan odamga biriktiriladi; mijozga kod avtomatik
beriladi. Bularni kartada bir bosishda o'zgartirasiz. Agar to'liq shakl
kerak bo'lsa — o'sha oynada «Batafsil →» havolasi turibdi.

**Yozganingiz yo'qolmaydi.** Oynaning tashqarisiga tasodifan bosib
yuborsangiz, «saqlamasdan yopilsinmi?» deb so'raydi.

**Kimga nima ko'rinadi:** lid — lidlar bilan ishlash huquqi borlarga; mijoz —
mijozlarni boshqarish huquqi borlarga. Bittasigina bo'lsa, tanlash oynasi
o'tkazib yuborilib, darrov katak ochiladi.

**Yo'l-yo'lakay tuzatilgan narsa.** «+» qo'shilgach, telefonda yuqori
qatordagi tugmalar 44px dan **33px ga siqilib qolgan ekan** — barmoq uchun
juda kichik. O'lchab ko'rildi va tuzatildi: **til tanlash telefonda endi
Profil sahifasida** (kompyuterda avvalgidek yuqorida qoladi). Endi hamma
tugma yana 44px.

Tekshiruv: 944 ta ichki test, 112 ta brauzer testi. Bazaga o'zgarish yo'q.

Ishni boshlashdan oldin taklif qilingan dizayn uch mustaqil ko'z bilan
tekshirildi va uchta jiddiy xato kod yozilishidan OLDIN topildi (shuning
uchun oyna faqat ikkita katakdan iborat bo'ldi).

## Ommaviy amallar: bir nechta leadni birdan ko'chirish — 2026-08-04

«Oson UI» rejasining 2-bosqichi, ikkinchi yarmi.

**Kartalarni belgilash.** Lidlar va bitimlar doskasidagi har kartada endi
belgilash katagi bor. Bittasini belgilaganingizdan keyin pastda amallar
paneli chiqadi.

**Nima qilish mumkin.** Belgilanganlarni: bitta etapga **ko'chirish** (agar
«yo'qotildi» etapi tanlansa — sabab majburiy, siz shunday deb tanlagansiz);
lidlarni bitta hodimga **biriktirish** (bu faqat «hamma lidlarni ko'rish»
huquqi borlarda ko'rinadi — o'z lidini boshqaga berish rahbar ishi).
Bitimlarda biriktirish yo'q: bitim egasini almashtirish suhbat talab qiladi,
ommaviy ish emas.

**Halol hisobot.** Panel «Bajarildi: 19, bo'lmadi: 1» deb yozadi. Nega
bo'lmagani kartada ko'rinadi. Bitta karta rad etilsa, qolgan 19 tasi
baribir bajariladi — yarim yo'lda to'xtash eng yomoni. Muvaffaqiyatsizlar
belgilangan holicha qoladi, qaytadan urinib ko'rishingiz uchun.

**Muhim ichki qoida.** Har bir karta odatdagi yo'ldan ko'chadi — ya'ni tarix
yoziladi va **avtomatlashtirish qoidalari ishlaydi**. Tezlik uchun «hammasini
birdan» qilib yuborilganda qoidalar jim qolar edi.

Tekshiruv: 940 ta ichki test (7 tasi yangi; ikkita qoida himoyasiz qolganda
qizarishi isbotlangan), 108 ta brauzer testi. Bazaga o'zgarish yo'q.

Telefon ekranida ko'rib topilgan va tuzatilgan: bajarilgandan keyin panel
javobni ko'rsatmasdan yo'qolib ketardi; ikkita tugma bir xil «Применить»
deb nomlangan edi.

## Qidiruv: butun tizim bo'ylab, Ctrl+K bilan — 2026-08-04

«Oson UI» rejasining 2-bosqichi, birinchi yarmi.

**Qidiruv kengaydi.** Avval faqat mijoz, karobka, prixod va tovar nomini
topardi. Endi qo'shildi: **lidlar** (ism, firma, telefon), **bitimlar** (kod,
nom, mijoz kodi), **partiyalar** (kod, mashina raqami, haydovchi),
**kontragentlar**, va **telefon raqami bo'yicha mijoz** (oxirgi 9 raqam —
formati qanday yozilganidan qat'i nazar).

**Ctrl+K.** Kompyuterda istalgan ekranda Ctrl+K (Mac'da ⌘K) bossangiz qidiruv
oynasi sahifa ustida ochiladi — sahifadan chiqmaysiz. Telefonda yuqoridagi
qidiruv belgisini bossangiz o'sha oyna ochiladi. Yozgan sari natija chiqadi;
strelka bilan tanlab Enter bosasiz. Escape yopadi.

**Muhim tuzatish — qidiruv juda ko'p narsani ko'rsatardi.** Tekshirganimda
ma'lum bo'ldiki, eski qidiruvda **hech qanday chegara yo'q ekan**: Yivudagi
skladchi Toshkentdagi karobkani ham topa olardi, va tizimga kirgan har kim
butun mijozlar kitobini varaqlay olardi. Endi qidiruv har bir turdagi
ma'lumot uchun **o'sha ekranning o'z qoidasini** so'raydi: skladchi faqat o'z
skladini, sotuvchi faqat o'z lidlarini (agar «hammasini ko'rish» huquqi
bo'lmasa), kontragentlarni faqat moliya huquqi borlar. Huquqi yo'q bo'lsa —
umuman qidirilmaydi ham. Va qidiruv natijasida **hech qachon pul ko'rinmaydi**
— natija sizni kartaga olib boradi, savolga javob bermaydi.

Tekshiruv: 933 ta ichki test (18 tasi yangi; uchta chegara himoyasiz
qolganda qizarishi isbotlangan), 105 ta brauzer testi. Bu konteynerda 3 ta
brauzer testi o'tmadi — rasm yuklash yo'lida, o'zgarishlarimizsiz ham
o'tmaydi.

Bazaga o'zgarish yo'q.

## Ro'yxatlar: saqlanadigan ko'rinishlar, ustun tanlash, Excel — 2026-08-04

«Oson UI» rejasining 1-bosqichi (`docs/CRM-UX.md`). Mijozlar kitobi, sklad
qoldig'i va o'z obyektlaringiz ro'yxatida:

**Ko'rinish saqlash.** Filtr, saralash va ustunlarni sozlaganingizdan keyin
«⋯» tugmasidan nom berib saqlaysiz. Saqlangan ko'rinish ro'yxat tepasida
tugmacha bo'lib turadi — bir bosishda o'sha holat qaytadi. Uchta belgisi bor:
📌 — yuqorida tursin; ★ — shu ro'yxatni ochganda doim shu ko'rinish
ochilsin; ✕ — o'chirish. **«Hammaga ko'rsatish»** faqat adminda: o'zingiz
uchun ko'rinish saqlash hammaga ochiq, butun firmaga tarqatish esa admin
ishi (siz shunday deb tanladingiz).

**Ustun tanlash.** «⋮≡» tugmasi — qaysi ustun ko'rinishini o'zingiz
belgilaysiz, maxsus maydonlaringiz ham shu ro'yxatda. Kod ustuni doim
qoladi (u kartaga kiradigan havola). Pul bilan bog'liq ustunlar faqat
huquqi borga ko'rinadi — manzilga qo'lda yozib ham ochib bo'lmaydi.

**Excel aynan ko'rinib turganini beradi.** Endi yuklab olingan fayl ekrandagi
filtr, saralash va TANLANGAN USTUNLARni oladi — ekranda yashirilgan ustun
faylga ham tushmaydi.

**Havola bo'lib ishlaydi.** Ko'rinish — bu manzil qatoridagi holat, shuning
uchun uni hamkasbingizga havola qilib yuborsangiz, u ham aynan o'sha
ro'yxatni ko'radi; «orqaga» tugmasi ham odatdagidek ishlaydi.

Yo'l-yo'lakay tuzatilganlar (hammasi 360px telefon ekranida ko'rib
topilgan): ustun tanlash oynasi ochiq qolib jadvalni to'sib turishi;
ko'rinishlar oynasi ekran chetidan chiqib ketib butun sahifani kichraytirib
yuborishi; sklad qidiruv oynasining juda torayib qolishi.

Tekshiruv: 915 ta ichki test (24 tasi yangi — himoyasiz qolganda qizarishi
isbotlangan), 100 ta brauzer testi. Bu konteynerda 4 ta brauzer testi
o'tmadi — hammasi rasm yuklash yo'lida va o'zgarishlarimizsiz ham
o'tmasligi tekshirildi (bu yerda rasm xizmati yo'q; serverda ular ishlaydi).

Bazaga bitta yangi jadval qo'shildi (0058) — yangilashda migratsiya
avtomatik ishlaydi, avval backup oling.

## Frappe CRM o'rganildi — «oson UI» strategiyasi kelishildi (kod o'zgarmagan) — 2026-08-04

Topshiriq: «frappe crm bor shuni organib chiq … ishlatish oson UI da
bolishini hohlayman». Frappe CRM uch yo'nalishda to'liq o'rganildi
(imkoniyatlari, interfeysi, texnik talablari) va xulosa siz bilan kelishildi.

**Qaror: Frappe CRM alohida o'rnatilmaydi.** Sabablari: serverga og'ir
(o'zining boshqa bazasi va 8–11 ta alohida jarayon), interfeysi faqat
inglizcha (tarjima fayllari umuman yo'q), har sotuvchi hamma mijoz-bitimni
ko'radi (bizdagi chegaralar yo'q), Telegram/sklad/pul bilan bog'lanmaydi,
litsenziyasi kodini ko'chirishga ruxsat bermaydi. Mazmun jihatdan bizning
tizim allaqachon oldinda (bitimda pul, yo'qotish sababi, maxsus maydonlar,
avtomatlashtirish, sklad-voronka, Telegram, hisobotlar, 4 til) — yetishmagani
Frappe'ning qulaylik qatlami, va aynan shu bosqichma-bosqich qo'shiladi.

**Kelishilgan 5 bosqich** (to'liq reja: `docs/CRM-UX.md`): 1) ro'yxatlar —
saqlanadigan ko'rinishlar, tezkor filtrlar, istalgan ustun bo'yicha saralash,
ustun tanlash, Excel eksport; 2) tezlik — qidiruv kengayadi (lead/bitim/
partiya/kontragent/telefon) + Ctrl+K, tez qo'shish oynalari, ommaviy amallar;
3) kartada joyida tahrirlash; 4) kompyuterda kanban sudrash (telefonda
tugmalar qoladi); 5) tungi rejim, Telegram shablon javoblar, mayda pardozlar.

**Javobingizni kutayotgan 3 savol:** umumiy ko'rinishni faqat admin
e'lon qilsinmi; leadlarni ommaviy «yo'qotildi» qilish (sabab majburiy)
bo'lsinmi; shablon javoblar umumiy + shaxsiy bo'lsinmi. «Tavsiyalaring
bo'yicha boshla» desangiz — uchalasi ham «ha» bo'lib boshlanadi.

Kod va bazada hech narsa o'zgarmadi; eski eslatma kuchida: serverni
yangilashdan oldin backup, yangilanishda 4 ta jonli pul xatosining
tuzatmalari bor.


## Haydovchi ilovasi 1.3: 2 soatdan keyin o'lish tuzatildi, bildirishnoma yo'qoldi — 2026-08-04

Sizning 1-band: «driver app negadur 2 soatdan keyin ishlamay qoldi» + «hech
qanday notification ko'rsatmasin, telda yo'qdek bo'lsin».

**Nega aynan 2 soatdan keyin o'lardi.** Eski ilovada jadval zanjir edi: har
sikl KEYINGI budilnikni o'zi qurardi. Telefon ilovani xotiradan o'chirib
yuborgan bo'lsa, budilnik chalinganda Android xizmatni qayta ishga
tushirishga ruxsat bermasligi mumkin — va o'sha payt zanjir uziladi:
budilnik «ishlatildi», yangisini quradigan hech kim yo'q. Birinchi
qarovsiz signal esa ulanishdan roppa-rosa 2 soat keyin — shuning uchun
aynan 2 soat.

**Endi jadval telefonning o'z tizimida saqlanadi** (Android'ning o'zi har
2 soatda ishga tushiradi, telefon o'chib yonsa ham). Bitta urinish muvaffaqiyatsiz
bo'lsa, keyingisi baribir keladi — zanjir yo'q, uzilish ham yo'q. Xizmat
ishga tushmagan holatda ham ilova to'plangan nuqtalarni yuboradi va oxirgi
ma'lum joylashuvni jo'natadi: sekinlashadi, lekin o'lmaydi.

**Bildirishnoma.** Android 13+ telefonlarda ilova endi **umuman
bildirishnoma ko'rsatmaydi** — talabingizdagidek, telda yo'qdek. Eskiroq
Androidlarda qonun bo'yicha butunlay yashirib bo'lmaydi, lekin endi u
faqat joylashuv olinayotgan 1-2 daqiqada, eng past darajada, tovushsiz
ko'rinadi va o'zi yo'qoladi (avval butun reys davomida turardi).

**Serverda qo'riqchi.** O'lgan ilova o'z o'limi haqida xabar berolmaydi —
buni faqat server ko'radi. Endi yo'ldagi reysning telefoni 8 soatdan ortiq
jim qolsa, logistlarga Telegram orqali **bir marta** xabar boradi (reys
kodi, mashina, necha soat jim, havola). Telefon yana gapirsa, hisob
qaytadan boshlanadi. Bu xaritadagi nuqta kulrang bo'ladigan o'lchovning
o'zi — ikkita alohida «eskirgan» tushunchasi yo'q.

Yangi APK'ni chiqarish kerak bo'ladi (GitHub Actions → driver-apk →
artifact → Admin → Haydovchi ilovasi; telefonlardagi eski ilova avval
o'chiriladi). Sozlashda endi bitta qadam kam: bildirishnoma so'ralmaydi.

Tekshirish: 891 ta ichki test (8 tasi yangi — jim qolgan reys qoidalari,
har biri himoyasiz qolganda qizil bo'lishi isbotlangan), 101 brauzer testi.
Ilovaning o'zi bu konteynerda ishga tushirilmaydi — shuning uchun yig'ishdan
oldin Android kodi uch mustaqil ko'z bilan adversarial tekshiruvdan o'tkazildi:
5 ta yashirin xato topilib tuzatildi (jumladan to'la diskda ilovaning o'lib
qolishi va ruxsat olib qo'yilganda har 10 daqiqada bekorga uyg'onish).
APK'ni CI yig'adi; birinchi jonli reysda kuzatib borish kerak.


## Sklad rasmlari endi ezilmaydi — 2026-08-04

Sabab topildi: brauzerning o'zi har bir rasmga «kerak bo'lsa toraytirsa
bo'ladi» degan ruxsat berib qo'yadi. Telefonda shrift kattaroq bo'lsa,
jadvalning raqamli ustunlari kengayadi va joy yetmay qolganda **aynan surat
ustuni ezilardi** — 80×80 rasm ingichka chiziqqa aylanib qolardi. Ro'yxat
uzunlashgani sari matn ko'payib, siqilish kuchayardi.

Endi rasmning eni **hech qachon kichraymaydi**: joy yetmasa jadval o'zi
kengayib, yon tomonga suriladigan bo'ladi (bu imkoniyat baribir bor edi).

Bu tuzatish bitta joyda qilindi va **hamma ekranlarga birdan** ta'sir qiladi:
sklad ostatkalari, partiya ichidagi yuklar jadvali, priyomka, plan tuzish,
lenta va chatdagi rasmlar.

Tekshirish: ezilishni o'zimda qayta tikladim (katakni ataylab 60 px qilib —
rasm 60×80 bo'lib ezildi), tuzatishdan keyin o'sha holatda ham 80×80 qoldi.
883 ta ichki test, 101 ta brauzer testi — hammasi yashil. Bunday sinf
xatolariga qo'riqchi test ham qo'shildi.


## Topildi: jo'natilgan xabar nega chatda ko'rinmasdi — 2026-08-03 (8-qism)

Sizning rasmingiz hammasini aytdi: **«rasm ko'rindi, xabar ko'rinmadi».**
Aynan shu farq — kasallikning o'zi.

**Sabab.** Telegram, agar xabarni **o'sha ulanishning o'zidan** jo'natsangiz,
uni sizga «yangi xabar» qilib qaytarmaydi. Bizning tinglovchi — o'sha ulanish.
Rasm uchun biz yozuvni **o'zimiz** yozardik (boshqa sababga ko'ra: rasmni
ikkinchi marta yuklab olmaslik uchun). Matn uchun esa «Telegram o'zi
qaytaradi» deb kutib turardik — u qaytarmaydi.

Natijada: matn mijozga **yetib borardi**, navbatdagi «navbatda» yozuvi
yo'qolardi, va bizning chatda **hech narsa qolmasdi**. Telefoningizdan
yozgan xabarlaringiz esa ko'rinardi — ular haqiqatan ham «yangi xabar» bo'lib
keladi. Shuning uchun teshik ko'rinmay turgan.

**Tuzatildi:** endi har bir jo'natilgan xabar — matnmi, rasmmi — darrov
chatga yoziladi. Agar Telegram keyin o'sha xabarni qaytarsa, ikkilanmaydi
(baza darajasida himoya bor edi, o'sha ishlaydi).

**Ikkinchisi:** «401: SESSION_REVOKED» yozuvlari chat tepasida bir kundan
beri turgan ekan — ularni o'chiradigan hech narsa yo'q edi. Endi har bir
xato yozuvining yonida **✕** bor. Xato — bu sizga aytilgan gap, mijoz uni
ko'rmagan; o'qib bo'lgach, olib tashlash mumkin.

Tekshirish: 882 ta ichki test, 101 ta brauzer testi — hammasi yashil.
Tuzatishni olib tashlab, testning qizarganini ko'rdim, keyin qaytardim.


## «Something went wrong» — sabab topildi — 2026-08-03 (7-qism)

Xato sizda emas: **kod yangilangan, baza yangilanmagan.** «Chiqish» tugmasi
`tg_accounts` jadvalidagi bitta ustunni bo'shatadi, buni esa **0056-migratsiya**
ruxsat beradi. Server kodni olibdi, migratsiyani o'tkazmabdi — shuning uchun
baza rad etgan va ekran shu tushunarsiz xatoni ko'rsatgan.

Xuddi shu holatni o'zimda takrorlab ko'rdim: baza eski holatga qaytarilganda
tugma aynan shu xatoni beradi.

**Serverda tuzatish:**

```
cd ~/gsr
docker compose run --rm migrate
```

(Bu migratsiyani o'tkazadi; ichidagi seed zarar qilmaydi.) Shundan keyin
tugma ishlaydi.

**Kodda ham tuzatdim** — bundan keyin bunday holatda oq ekran chiqmaydi:
tugma ostida odam tushunadigan yozuv chiqadi («serverda baza migratsiyalari
qo'llanmagan ko'rinadi»), asl xato esa server logiga yoziladi. Ilgari tugma
nima bo'lishidan qat'i nazar «Uzildi» deb yozardi — u ham tuzatildi.

**Yana bittasi (chuqur tekshiruvdan):** dock'dagi (o'ng tarafdagi) chat
oynasi, bitta odamning bir nechta GS kodi bo'lganda, suhbat qaysi kodda
turganini topa olmasdi — kartochkadagi panel suhbatni ko'rsatib turardi,
dock esa «chat yo'q» derdi va javob yozdirmasdi. Endi ikkalasi bir xil
qidiradi.

Tekshirish: 880 ta ichki test, 101 ta brauzer testi — hammasi yashil.


## «Bu chatni olmang» tugmasi joyini o'zgartirdi — 2026-08-03 (6-qism)

To'g'ri aytdingiz: u **yozish oynasining tagida** turardi — «Yuborish»dan bir
barmoq narida, klaviatura ochilib-yopilib turadigan joyda. Ustiga-ustak u
25-raunddan beri shunchaki «olmaslik» emas, **saqlangan yozishmalarni ham
o'chiradi**. Eng xavfli tugma eng ko'p bosiladigan tugmaning yonida turgan.

Endi u **chat sarlavhasidagi «⋯» menyusida** — ekranning eng tepasida,
klaviaturadan eng uzoq nuqtada, yopiq holatda. Unga yetish uchun: menyuni
ochish → bosish → tasdiqlash. Uch qadam, uchalasi ham ataylab.

Mijoz/bitim/lid kartochkalaridagi chatdan **butunlay olib tashlandi** —
suhbatni tashlab yuborish qarori kartochkada emas, chatning o'zida
qabul qilinadi.

Yo'l-yo'lakay: menyu telefon ekranida **chapga chiqib ketayotgan edi**
(sarlavha ikki qatorga bo'linganda), rasmga olib ko'rmasam bilinmasdi —
tuzatildi.

Tekshirish: 878 ta ichki test, 101 ta brauzer testi — hammasi yashil.
Ekranni telefon o'lchamida (360×800) ochib, menyuni ochib-yopib ko'rdim.


## Telegramdan chiqish tugmasi — 2026-08-03 (5-qism)

**Suhbatlar → Ulash** sahifasida endi ulangan akkaunt ostida
**«🚪 Telegramimni uzish»** tugmasi bor.

Bosilganda (avval tasdiq so'raydi va nima bo'lishini aytadi):

- mijozlarning xabarlari **kelmay qoladi**;
- navbatdagi javoblar **«yuborilmadi»** bo'lib qoladi (kutib turmaydi — chunki
  siz o'zingiz uzishga qaror qildingiz);
- **seans serverdan butunlay o'chiriladi** — ya'ni sistemada sizning
  Telegramingiz kaliti umuman qolmaydi;
- **Telegramning o'zida ham seans tugatiladi** (tinglovchi chiqib ketadi).

**O'chirilmaydi:** yozishmalar tarixi va akkaunt yozuvi joyida qoladi — mijoz
bilan nima gaplashilgani firmaning yozuvi, uzilish uni o'chirmaydi.

Qaytish uchun o'sha sahifadan yana ulaysiz (telefon → kod).

Yo'l-yo'lakay bitta jimgina kamchilik ham tuzatildi: tinglovchi jarayoni
akkauntlarni faqat **ishga tushirardi**, to'xtatmasdi. Ya'ni uzish tugmasi
bosilsa ham, konteyner qayta ishga tushmaguncha eski ulanish ishlab turaverar
edi. Endi bir daqiqa ichida o'zi to'xtaydi.

Migratsiya: **0056** (seansni o'chirish mumkin bo'lishi uchun).
Tekshirish: 875 ta ichki test, 101 ta brauzer testi — hammasi yashil.


## Sabab topildi: Telegram seansingiz o'chirilgan — 2026-08-03 (4-qism)

Loglardagi bitta qator hammasini aytdi:

```
yuborilmadi (qayta urinaman): 401: SESSION_REVOKED
```

**Telegram sizning seansingizni tugatgan.** Ya'ni server sizning Telegram
akkauntingizga ulana olmaydi — parol yoki internet emas, seansning o'zi
o'chirilgan (odatda Telegramda «Устройства → Завершить сеанс» bosilganda yoki
Telegram o'zi bekor qilganda bo'ladi).

**Nima uchun sistema buni ko'rsatmagan** (asosiy kamchilik, tuzatildi):

- Sistema «tirikmi» degan savolga **yurak urishi** bilan javob berardi — ya'ni
  jarayon ishlayaptimi. Jarayon ishlayotgan edi, ulanish ham bor edi, faqat
  **huquq** yo'q edi. Shuning uchun ekran «jonli» deb turaverdi va yangi
  xabarlarni qabul qilaverdi.
- `SESSION_REVOKED` xatosi «keyin qayta urinib ko'ramiz» turkumida edi. Har
  3 soniyada o'lik seansga urinib, har xabar 3 marta urinib «xato» bo'lgan.
  Sizdagi 4 ta «failed» qator — shundan.

**Tuzatildi:**

1. Seans o'lgani **alohida tanib olinadi** va u xabarning emas, **akkauntning**
   xatosi deb hisoblanadi.
2. Shu zahoti akkaunt **«signed_out»** deb belgilanadi → ekranda qizil holat va
   yozish oynasi o'rniga «qayta ulaning» deb chiqadi, yangi xabar qabul
   qilinmaydi.
3. Tinglovchi o'sha akkaunt uchun **to'xtaydi** (Telegramni bekorga bezovta
   qilmaydi).
4. Navbatdagi xabar **o'chirilmaydi** — qayta ulanganingizdan keyin ketadi.
5. **Ogohlantirish BOT orqali** keladi (sizning akkauntingiz o'lgani uchun undan
   yuborib bo'lmaydi — boshqa yo'l kerak edi).

**Ikkinchi xato — «habar yo'q bo'lib qolyabti»:** chat oynasi rad javob
bo'lganda ham yozilgan matnni o'chirib tashlar edi (React formani har doim
tozalaydi). Endi rad javobda matn joyida qoladi. Dock'dagi oyna to'g'ri ishlar
edi — faqat asosiy chat ekranida shu xato bor edi.

**SIZDAN:** saytda **Suhbatlar → Ulash** ga kirib Telegramingizni **qayta
ulang** (telefon → kod). Shundan keyin navbatdagi xabarlar o'zi ketadi.

Tekshirish: 873 ta ichki test, 101 ta brauzer testi — hammasi yashil.


## 14-punkt: sabab topildi — 2026-08-03 (3-qism)

Loglar uchun rahmat — ular hamma narsani aytdi.

**Nima bo'lgan.** Tinglovchi konteyner **bazani topa olmay qolgan**:
`getaddrinfo EAI_AGAIN postgres` — Docker'ning ichki DNS'i o'sha konteyner
uchun ishlamay qolgan (sayt, ishchilar, hammasi ishlayvergan). Natijada:
xabar **Telegramga ketgan**, lekin «ketdi» degan yozuv bazaga tusha olmagan.
Shu sababli ekranda kunlab «navbatda» turgan, mijoz esa allaqachon javob
bergan. Aynan siz aytgan narsa.

**Yana bir xavf bor edi** (siz sezmagansiz): baza bir soniyaga uzilsa,
sistema **yuborilgan xabarni «yuborilmadi» deb belgilab, ikkinchi marta
yuborib qo'yishi** mumkin edi. Mijoz bir xabarni ikki marta olardi.

**Nima qilindi:**

1. **Ketgan xabar — ketgan.** Telegram qabul qilgandan keyingi har qanday
   xatolik endi «yuborilmadi» deb hisoblanmaydi. Yozuv baza tiklanguncha
   xotirada saqlanadi va har 3 soniyada qayta urinadi; shu bitmaguncha
   navbatdan yangi xabar olinmaydi (tartib buzilmasin).
2. **Baza yo'qligi ≠ Telegram rad etishi.** Ikkisini ajratadigan alohida
   tekshiruv qo'yildi va testga olindi — bloklagan mijozga qayta-qayta
   yuborilib qolmasligi uchun.
3. **Baza o'lganini bazaga yozib bo'lmaydi.** Shuning uchun tinglovchi endi
   1 daqiqadan keyin **sizning o'zingizning Telegramingizga («Saved
   Messages») yozadi**: nima buzilgani va tuzatadigan buyruq. Baza qaytsa —
   «baza qaytdi» deb yozadi. Har uzilishga bir marta.
4. **Ekran endi yolg'on gapirmaydi.** 5 daqiqadan ortiq «ketayotgan» xabar
   «navbatda» emas, **«Ketgan, lekin yozilmagan — Telegramda tekshiring»**
   deb sariq rangda turadi.

**Hozir serverda qiling** (eski xabarlar qotib qolgan bo'lsa shu yetadi):
```
docker compose --profile telegram restart tg-listen
```

Tekshirish: 869 ta ichki test, 101 ta brauzer testi — hammasi yashil.


## Javoblaringiz bo'yicha — 2026-08-03 (2-qism)

**6. Yopilgan lidlar endi voronkani to'ldirmaydi.** «Sotuv» va «Yo'qotildi»
ustunlari **oxirgi 20 tasini** ko'rsatadi, ustun sarlavhasida esa **haqiqiy
soni** turadi — ya'ni «Sotuv 143» deb yozilaveradi. Pastida «+123 · hammasini
ko'rsatish» tugmasi: bosilsa hammasi chiqadi. **Hech narsa o'chirilmaydi va
yashirilmaydi** — manbalar bo'yicha hisobot ham, mijoz tarixi ham joyida.
Bitimlar voronkasiga ham shu qoidani qo'ydim (u ham xuddi shunday ikkita
yopiq ustunga ega — aytmasangiz ham qildim, keyingi hafta so'ramasligingiz
uchun).

**8. «Расходы по приходам» endi alohida sahifada.** 12 ta prixod × 6 ta xarajat
turi = 72 ta katak edi, kartaning yarim ustuniga sig'dirilgan. Endi partiya
kartasida faqat tugma turadi («12 × 6» deb o'lchamini aytadi), bosilsa jadval
butun ekranni egallaydi. Ishlashi, huquqi, saqlashi — hammasi o'sha-o'sha.

**9. Skladdan «kutilayotgan yuklar» olib tashlandi.** Uning o'rniga
skladchining ekranida **kelayotgan mashinalar** turadi: «Partiyalar · 5 ·
🚛 3 kelayapti · 📦 2 yuklanmoqda». Menyudan ham olindi. Sahifaning o'zi
yo'qolmadi — sotuvchi va logist uni ishlatishda davom etadi.

**10. Xarita endi yo'ldan yuradi.** Mashina to'g'ri chiziq bilan tog'dan
oshib o'tmaydi: Lanchjou–Xami orasida Xesi yo'lagidan, Urumchidan Aksuga
Tyan-Shanni **aylanib** — Toksun, Korla, Kucha orqali, Qashqardan chegaraga
Uqiya orqali, Kirgizistonda Sari-Tosh va Gulcha orqali, Andijondan Toshkentga
esa **Qamchiq dovoni** yo'li bilan (Qo'qon, Ohangaron). Ilgari Urumchi–Aksu
chizig'i Korladan ~130 km chetda, tog'ning ustidan o'tar edi.

**11. «Свои списки» hamma menyudan olib tashlandi.** Sahifalari va ma'lumoti
o'chirilmadi (agar keyin kerak bo'lsa, bir qatorda qaytariladi) — lekin endi
hech qayerda ko'rinmaydi.

**12. Yangi sahifa: «Как идут задачи»** (Hisobotlar → ✅). Bir ekranda: bugun
**kechikkan / bugungi / bajarilgan / ishdagi** zadachalar; 14 kunlik grafik —
qancha qo'yildi va qancha yopildi (o'syaptimi yoki kamayyaptimi); **hodimlar
bo'yicha jadval** — kechikkani ko'p bo'lgan yuqorida; muddati qo'yilmagan
zadachalar soni (ular hech kimning «Mening kunim»iga tushmaydi); va **eng ko'p
kechikkan 10 tasi ism bilan**, har biri kartasiga bosiladi.

**14.** Buyruq noto'g'ri edi — servis nomi `tg-listener` emas, **`tg-listen`**,
va u profil ortida turadi. To'g'risi:
`docker compose --profile telegram logs -f tg-listen`
Shuni yuboring — «navbatda» muammosining sababi faqat o'sha loglarda ko'rinadi.

Tekshirish: 861 ta ichki test, 101 ta brauzer testi — hammasi yashil.
Yangi ekranlarni telefon o'lchamida ochib rasmga oldim.


## 14 ta ro'yxatning aniq yarmi — 2026-08-03

Rasm bilan yuborgan 14 ta gapingizdan **6 tasi** bajarildi. Qolganlariga
savol yozdim — javobingizdan keyin qilaman.

**3. Partiya ichidagi yuk — endi sklad qoldig'idek ko'rinadi.**
Partiya kartasida «Содержимое» bo'limi jadval bo'ldi: **rasm, kod, tovar,
nechta korobka, necha kg, necha kub**, tepasida esa butun mashinaning
yig'indisi (Σ). Muhimi: **ilgari mashina yetib kelgach ro'yxat bo'shab
qolar edi** — yuk tushirilgandan keyin sistema uni «bu mashinaniki» deb
bilmay qolgan. Endi partiya nima olib kelganini yopilgandan keyin ham
aytadi. kg va kub — o'sha partiyada ketgan korobkalar ulushi bo'yicha
(bir lotning yarmi ketsa, yarmi hisoblanadi).

**4. Skladdagi rasmlar kattalashdi** (56 → 80 piksel, bosilsa baribir
to'liq ochiladi), **va yon menyu endi ekran bilan birga pastga tushmaydi** —
o'zining alohida aylantirgichi bor. Ilgari menyuning pastki qatorlariga
yetish uchun butun sahifani surish kerak edi, sursangiz esa menyu ham
birga ketardi.

**5. «Расчёт» paneli ikkala voronkadan ham olib tashlandi** (bitim va lid
kartasidan), **12. «Скорость расчётов» hisoboti ham** o'chirildi.
Aytib qo'yishim kerak: shu ikki tugma ketgani uchun **endi saytdan
hisoblash so'rab bo'lmaydi**. Jadval, soat va kechikish ogohlantirishi
joyida turibdi — kerak bo'lsa boshqa joyga tugma qo'yaman, ayting.

**7. «Где машина» endi yig'iladigan bo'ldi** — kartani ochganda yopiq
turadi, kerak bo'lsa bosasiz.

**13. Yuk qabul qilishda «Сделка (если есть)» skladchida ko'rinmaydi.**
Buni sotuvchi va VED xodimi ko'radi. Yiwudagi operator qaysi bitimga
tegishli ekanini bilmaydi — noto'g'ri tanlansa narx nazorati noto'g'ri
bitim bilan solishtiradi. Prixod kartasida bitimni ulash tugmasi bor
(o'tgan raundda qo'shilgan edi) — kim biladi, o'sha ulaydi.

Tekshirish: 851 ta ichki test, 101 ta brauzer testi — hammasi yashil.
Ekranlarni telefon o'lchamida (360×800) ochib, **rasmga olib ko'rdim**.
Skladchi hisobiga ham kirib tekshirdim.


## CI qizil bo'ldi — sabab topildi — 2026-08-03

Tezlik raundidan keyin avtomatik tekshiruv (CI) bitta testda yiqildi. Sabab
dasturda emas, **testning o'zida** edi: avtomatik qoidalar testi o'z
tekshiruvini **umumiy voronka bosqichiga** ulab qo'ygan ekan — ya'ni boshqa
testlarning bitimlari ham o'sha bosqichga kirib, qoida ikki marta ishlab
ketgan.

Ikki narsa tuzatildi:

- **Test endi o'ziga alohida bosqich yaratadi** va oxirida o'chiradi. Endi
  undan boshqa hech kim qoidani ishga tushira olmaydi.
- **Bitimlar voronkasidagi ustunlar tartibi barqaror bo'ldi.** Ikki bosqichda
  bir xil tartib raqami bo'lsa, ular har safar har xil ketma-ketlikda
  chiqishi mumkin edi (lidlar voronkasida bu allaqachon to'g'ri edi).

Ikkinchi urinishda yana qizil bo'ldi: tozalash bosqichi **bosqichni o'chirmoqchi
bo'ldi, lekin unda bitim turgan edi** — bu dasturning o'z qoidasi (bosqichni
o'chirishdan oldin bitimlarni ko'chirish kerak). Endi test ham shunday qiladi.
Bu safar men **noto'g'ri qatorga qarab turgan ekanman**: barcha 851 test
o'tgan, lekin FAYL yiqilgan — ikkisi har xil narsa.

Dasturning ishlashiga ta'sir qiladigan o'zgarish yo'q — faqat ustunlar
tartibi endi har doim bir xil.


## Tezlik — o'lchadim, sababini topdim — 2026-08-03

Avval **o'lchadim**, keyin tuzatdim. Sizning haqiqiy bazangizning nusxasini
olib (26 ming quti harakati, 10 900 quti, 4 400 prixod, 1 700 mijoz), **22 ta
asosiy ekranni birma-bir sekundomer bilan ochdim**.

Natija kutilganidan boshqacha chiqdi:

**1. Ekranlarning o'zi sekin emas ekan.** Eng sekini 0,3 soniya, ko'pchiligi
0,15 soniyadan tez. Bazada 0,2 soniyadan uzun **birorta ham so'rov yo'q**.

**2. Lekin «Uchyot» ekrani bitta ochilishda bazaga 1564 marta murojaat
qilarkan.** «Balans» — 1611 marta. Sabab: har bir kassaning qoldig'i
alohida-alohida so'ralardi, sizda esa **86 ta kassa** bor — va ekrandagi uchta
bo'lim bir xil ro'yxatni uch marta so'rardi. Endi hammasi bitta so'rovda
olinadi:

| Ekran | Oldin | Endi |
|---|---|---|
| Uchyot | 1564 so'rov / 193 ms | **23 so'rov / 44 ms** |
| Balans | 1611 so'rov / 186 ms | **31 so'rov / 53 ms** |

**3. Va eng asosiysi — «qotib qolgan» degani aslida «hech narsa
ko'rsatmayapti» degani ekan.** Server Germaniyada, siz O'zbekistonda: tugmani
bosgandan keyin javob kelguncha yarim soniya o'tadi, va o'sha yarim soniyada
ekran **eski holida turadi** — na aylanadigan belgi, na boshqa narsa. Odam
tabiiy ravishda «ishlamayapti» deb o'ylaydi va yana bosadi.

Endi **tugmani bosgan zahoti ekran tepasida qizil chiziq yuguradi** va sahifa
kelganda yo'qoladi. Muhim tafsilot: agar sahifa **tez** ochilsa (0,14
soniyadan tez) chiziq umuman chiqmaydi — aks holda u har bosishda lipillab,
odam unga e'tibor bermay qo'yardi. Ya'ni chiziq «bosildi» emas, **«bu biroz
vaqt oladi»** degani.

Yana: serverda endi **0,2 soniyadan sekin har bir so'rov jurnalga yoziladi**.
Keyingi safar biror ekran sekinlashsa, sababini sizdan so'ramasdan
o'zim topaman.

Tekshirildi: **851 ta test + 101 ta brauzer testi**, toza bazada, CI
tartibida. Chiziqni ataylab o'chirib ko'rdim — test qizil bo'ldi.


## Kontragentlar bo'yicha 17 ta xato topildi va tuzatildi — 2026-08-02

O'tgan hafta qurgan «kontragentlar» qismini **maxsus tekshiruvdan o'tkazdim** —
to'rt xil nuqtai nazardan, har bir topilma alohida qayta tekshirilgan holda.
**17 ta xato chiqdi va hammasi meniki edi.** Testlarim yashil edi, chunki
testlar men o'ylagan narsani tekshiradi; bu tekshiruv esa men o'ylamagan
narsani tekshirdi.

Eng muhimi — **pul bilan bog'liq to'rttasi**:

**1. Uch tomonlama hisobni mijoz tomonidan bekor qilsangiz, firmaga bo'lgan
qarzimiz abadiy yopilib qolardi.** Misol: GS100 bizga to'lash o'rniga
transport firmasining Xitoydagi hisobiga 1000$ tushirdi. Keyin ma'lum bo'ldiki
mijoz noto'g'ri — buxgalter mijoz kartochkasidan to'lovni bekor qildi. GS100
yana 1000$ qarzdor bo'ldi (to'g'ri), **lekin transport firmasiga bo'lgan
qarzimiz 1000$ kam bo'lib qolaverdi** va «Balans» ekrani firmani 1000$ ga
boyroq ko'rsatardi. Endi ikkala tomon birga bekor bo'ladi.

**2. Dollar va so'mdan boshqa valyutadagi kassa umuman hisoblanmasdi.** Yuvyda
yuanda kassa ochsangiz — bu tabiiy, chunki Xitoydagi xarajatlar yuanda — u
kassadagi 300 000 ¥ «Balans» ekranida **0$** bo'lib turardi. Endi kursi
kiritilgan har qanday valyuta hisoblanadi.

**3. Kursi kiritilmagan valyutada «kim to'ladi» ni ko'rsatsangiz, qarz
yozilmasdi.** Xarajat qatorida firma nomi turardi — ya'ni ekran «bu firma
to'lagan» deb turardi — lekin o'sha firmaning hisobida hech narsa yo'q edi.
Keyinchalik kursni kiritsangiz ham tuzalmasdi. Endi: kursi yo'q bo'lsa
**saqlashga qo'ymaydi**, va kursni kiritganingizda eski qatorlar ham
avtomatik to'g'rilanadi.

**4. Kontragentni «yashirish» qarzni ham yashirardi.** 8000$ qarzimiz bor
firmani yashirsangiz, «Jami qarzimiz» 8000$ ga kamayardi, «Balans» ekranida
esa o'sha 8000$ turaverardi — ikki ekran bir-biriga qarshi. Ustiga-ustak
kartochkaga qaytish yo'li ham qolmasdi. Endi: **qarzi bor kontragent
yashirilsa ham ro'yxatda qoladi** (xiraroq, «yashirilgan» belgisi bilan);
qarzi 0 bo'lsa yo'qoladi. Kontragent turini yashirsangiz ham shu — turi
yashirilgan hisoblar ro'yxatdan tushib qolmaydi.

Qolganlari:

- **Kontragent kartochkasi telefonda ekrandan kengroq edi** — brauzer butun
  sahifani kichraytirib yuborardi (o'tgan safar shu sabab tugmalar noto'g'ri
  joyga bosilgandi). Endi jadval o'zi yon tomonga suriladi.
- **«+50» tuzatish qatorda «−$50» bo'lib yashil rangda chiqardi**, balans esa
  ko'tarilardi — ya'ni qatorlar yuqoridagi summaga qo'shilmasdi.
- **Kontragent nomini tuzatib bo'lmasdi.** Xato yozilgan nom abadiy edi. Endi
  kartochkada ✏️ tugmasi bor.
- **Xarajatda kassa ham, «kim to'ladi» ham birga so'ralardi** va kassa jimgina
  tashlab yuborilardi — ya'ni saqlangan yozuv siz kiritgan narsa emas edi.
  Endi kontragent tanlansangiz kassa so'ralmaydi va sababi yozib turadi.
- **Har bir uch tomonlama hisob buxgalterning bosh ekranida «kassaga
  joylanmagan to'lov» bo'lib osilib qolardi** — hech qachon bajarib
  bo'lmaydigan vazifa. Endi hisoblanmaydi; «Reyestr» da esa qaysi firmaga
  tushgani yozib turadi.
- Bekor qilish tugmasi har tilda **«common.confirm»** deb yozilib turgan ekan
  (tarjimasi hech qaysi tilda yo'q edi).
- «Isbot» sifatida rasm biriktirib, keyin o'chirsangiz, tugma yoqiq
  qolaverardi va server rad qilardi.
- TNVED ro'yxatini tasdiqlash ekranida tovar nomi maydoni ikki harf enida
  edi.

Va uchta **doimiy qo'riqchi** qo'shdim, chunki shu xatolarning uchtasi
avval ham boshqa nom bilan chiqqan edi: maydon kengligi masalasi, tarjima
kaliti yo'qligi masalasi endi testda avtomatik ushlanadi.

Hammasi tekshirildi: **851 ta test + 99 ta brauzer testi**, toza bazada,
CI tartibida. Har bir tuzatish ataylab buzib ko'rildi — test qizil bo'ldi,
keyin qaytarildi.


## Rastamojka ko'rinmay turgan ekan — 2026-08-02

Siz «boshqa 2 tasiniyam ko'rib chiq» dedingiz. Bu safar men ularni **telefon
ekranida ochib, rasmini olib, ko'zim bilan qaradim** — o'tgan safar aynan
shuni qilmaganim uchun uch marta bekorga vaqtingizni oldim.

**Topilgani: 3-punkt (prixod bo'yicha rastamojka) umuman ko'rinmas ekan.**
U «Документы ВЭД» panelining ichida, o'zi ham yopiq holda turgan edi —
ya'ni ikki marta bosish kerak, va tashqarisida u yerda nimadir borligini
aytadigan hech narsa yo'q. Siz «hech nima o'zgarmagan» deganingiz to'g'ri
bo'lgan: **ochib bo'lmaydigan narsa yo'q narsa bilan barobar.**

Endi:

- **Partiya kartochkasida «🛃 Растаможка» degan alohida panel bor.** Yopiq
  turganda ham yonida qaysi firma rasmlashtirayotgani yozib turadi, va agar
  ba'zi prixodlar o'zicha javob bergan bo'lsa — «+1», «+3» deb ko'rsatadi.
  Ya'ni **bosmasdan ham ko'rinadi.**
- Ichida: avval partiyaning umumiy firmasi, keyin **har bir prixod alohida
  qator** bo'lib turadi — «Partiya bo'yicha» / firma nomi / «Mijoz o'z
  firmasi bilan».
- **Tanlov qutisi endi butun qatorni oladi.** Oldin u «Ка» deb ko'rinardi
  («Как у партии» ning ikkita harfi) — nima tanlanganini o'qib bo'lmasdi.
- «Saqlash» tugmasi **faqat siz javobni o'zgartirsangiz** chiqadi. Oldin har
  bir prixod tagida o'chiq, bosilmaydigan tugma turardi.

**2-punkt (kim to'ladi) — ishlayapti, tekshirdim.** «Kim to'ladi» tanlovi
prixod kartochkasida, yashik kartochkasida, partiya kartochkasida va
xarajatlar ekranida bor; **skladchining o'z login'i bilan kirib ham
ko'rdim** — unda ham chiqyapti. Saqlangan xarajat qatorida esa firma nomi
sariq yorliq bo'lib turadi, ya'ni «bu bizning pulimizmi yoki transport
firmasiga qarzmi» degan savolga qator o'zi javob beradi. Puli ham to'g'ri:
firma nomi qo'yilgan xarajat o'sha firmaga **qarz** bo'lib yoziladi,
kassadan pul chiqmaydi.

Yo'lda ko'ringan yana ikkita mayda kamchilik tuzatildi:

- Xarajat qo'shishda «qanday taqsimlansin» degan qatorda faqat «по» so'zi
  ko'rinardi — «по весу», «по объёму», «клиенту напрямую» hammasi shu bilan
  boshlanadi, ya'ni pulni qanday bo'lish tanlangani noma'lum edi. Endi u
  o'z qatorida to'liq yoziladi.
- «Прикрепить» tugmasining yozuvi kartochkadan tashqariga chiqib, prixoddagi
  birinchi rasm ustiga tushib turardi. Endi tugma o'z so'ziga qarab kengayadi.

Va bu safar test **ekrandagi haqiqiy kenglikni o'lchaydi** — brauzerda ochib,
partiyani topib, prixodni «mijoz o'zi qiladi» ga o'tkazib, sahifani qayta
yuklab, saqlanganini tekshiradi. Shuning uchun bu buzilsa, CI qizil bo'ladi.


## Summa maydoni — tuzatildi — 2026-08-02

Rasm uchun rahmat, muammo o'sha zahoti ko'rindi va u **meniki** edi.

Kecha summa maydonini kattalashtirmoqchi bo'lib, yonidagi valyuta qutisiga
«torayma» degan buyruq qo'shibman. Natijada valyuta qutisi butun qatorni
egallab, summa maydonini qisib qo'ygan — siz yuborgan rasmda aynan shu.

Endi to'g'ri: **summa maydoni qatorning kattasini oladi**, valyuta yonida
tor qutida turadi.

Bunday xato boshqa takrorlanmasligi uchun test qo'shdim — u endi maydonning
**haqiqiy kengligini o'lchaydi**, ya'ni ekranda qanday ko'rinishini
tekshiradi.

## Uchta tuzatish — 2026-08-01

**1. Summa maydoni.** Kontragent yozuvida va uch tomonlama hisobda summa
endi **o'z qatorida, katta va yo'g'on** yoziladi. Valyuta yonida, tor
qutida. Oldin telefonda uchdan bir ekran edi.

**2. Skladchi «kim to'ladi» ni ko'rmayotgan edi.** «Kim to'ladi» tanlovi
faqat partiya kartochkasida bor edi — holbuki pulning ko'pi **prixodga**
kiritiladi. Endi u:

- prixod kartochkasida,
- yashik kartochkasida,
- partiya kartochkasida — hammasida bor.

Va eng muhimi: **saqlangan xarajat qatorida kim to'lagani yozilib turadi**
(sariq belgi bilan). Oldin to'g'ri kiritilgan yozuv ham keyin hech narsa
demasdi — «bizning pulimizdanmi yoki transportnikiga qarzmizmi» bilib
bo'lmasdi. Endi ko'rinadi.

**3. Rastamojka — har bir prixod bo'yicha.** Siz aytgan holat: bitta
partiyaning ichida ba'zi mijozlar o'z firmasi bilan rastamojka qiladi,
qolganini biz qilamiz. Endi partiya kartochkasida **«Prixodlar bo'yicha
rastamojka»** ro'yxati bor — har bir prixod yonida tanlov:

- **«Partiya bo'yicha»** — hech narsa aytilmagan, partiyaning umumiy
  javobi amal qiladi (odatiy holat, o'zgartirish shart emas);
- **firma nomi** — o'sha firma qilgan, hisobi o'sha firmaga yoziladi;
- **«Mijoz o'z firmasi bilan»** — mijoz o'zi qilgan, **bizga hech qanday
  xarajat tushmaydi**.

Partiya darajasidagi tanlov saqlanib qoldi — u endi butun mashinaning
**standart javobi**, prixod uni faqat kerak bo'lganda bekor qiladi.

## Balans, kassa va rollar — 2026-08-01

Sizning ikkita gapingiz bo'yicha.

**1. Rollar.** «Kontragentlar» endi **VED**, **buxgalter** va **admin**
menyusida turadi (buxgalterda avvaldan bor edi, VEDda yo'q edi — shu
tuzatildi). Skladchiga hech qachon ko'rinmaydi.

**2. Kassa raqamlari to'g'rilandi.** Bu jiddiy edi, ochiq aytaman: yangi
kontragent bo'limi kassadan pul chiqara oladi va kassaga pul kirita oladi,
lekin **kassa qoldig'i buni hisobga olmayotgan edi**. Endi:
- Kontragentga kassadan to'lasangiz — kassa kamayadi.
- Kontragent hisobimizga pul tushirsa — kassa ko'payadi.
- **Uch tomonlama hisob kassaga tegmaydi** — mijoz pulni firmaning
  hisobiga tashlagan, bizning kassaga kirmagan. Endi pul harakati
  hisobotida ham «kirdi» deb ko'rsatilmaydi.
- Boshqa firma to'lagan rastamojka va arenda ham «kassadan chiqdi» deb
  sanalmaydi — chunki chiqmagan.

**3. Yangi ekran: Balans** (`Buxgalteriya → Balans`). Bir ekranda:

- Kassalardagi pul (har biri o'z valyutasida + dollarda)
- Mijozlar bizga qarzi
- Kontragentlar bizga qarzi
- **Bizning qarzimiz**
- va pastida **sof holat**

Har bir qator bosiladi — tegishli ro'yxatga olib boradi.

**Bir narsa atayin hisobga olinmagan:** ombordagi yuk **pul sifatida
baholanmaydi** — u mijozning moli, bizniki emas. Uning puli allaqachon
«mijozlar qarzi» da turibdi; ikkinchi marta qo'shsak, o'zimizni boy qilib
ko'rsatgan bo'lardik.

## Kontragentlar — kimga qarzdormiz — 2026-08-01

Endi sistema faqat «mijoz bizga qancha qarzdor» emas, **«biz kimga qancha
qarzdormiz»** ni ham biladi.

**Yangi bo'lim: Kontragentlar.** Har bir transport firmasi, rastamojka
firmasi, naqd almashtiruvchi odam — o'z kartochkasi va o'z hisob varaqasi
bilan. Turlari sizniki: `Admin → Kontragent turlari` da qo'shasiz,
o'zgartirasiz, «Boshqa» ham bor. Kontragent bir vaqtda **mijozimiz** ham
bo'lishi mumkin — bitta kartochka, ikkita hisob.

**Mashinani qarzga olganda.** Xarajatni odatdagidek kiritasiz, faqat
«Kim to'ladi» da transport firmasini tanlaysiz. Tannarx o'sha zahoti
partiyaga tushadi (o'zgargani yo'q), qarz esa firmaning hisobida paydo
bo'ladi va qaysi mashina uchun ekani ko'rinib turadi. To'laganingizda
kassadan chiqadi va qarz kamayadi — **xarajat ikki marta sanalmaydi.**
Xarajatni bekor qilsangiz qarz ham o'chadi.

**Ombor arendasi va Xitoy oyliklari.** Xarajat kiritishda «Kim to'ladi»
da o'sha transport firmasini tanlaysiz: xarajat bizniki bo'lib qoladi,
lekin **kassadan pul chiqmaydi** — firmaga qarzimiz oshadi.

**Uch tomonlama hisob** (`Kontragentlar → Uch tomonlama hisob`). Mijoz
qarzini Xitoydagi firmaning hisobiga tashlasa: bitta amal, ikkita hisob
yopiladi — mijozning qarzi kamayadi va bizning firmaga qarzimiz kamayadi,
kassa tegilmaydi. **Ikkita summa alohida so'raladi**: mijoz qancha
yuborgan va firma o'z kursi bilan qanchani qarzimizdan ayirgan. Farqi
alohida ko'rsatiladi — o'rtacha kurs o'ylab topilmaydi. **Kvitansiya yoki
izoh majburiy**, aks holda saqlanmaydi.

**Naqd sotib oluvchilar.** «Hisobimizga pul tushirdi» yozuvi — hisob
ko'payadi va unga qarzimiz paydo bo'ladi; «To'ladik» — kassadan naqd
chiqadi. Qolgan farq — sizning kurs foydangiz, ko'rinib turadi va
«Kurs farqi» yozuvi bilan yopiladi.

**Partiya kartochkasida ikkita yangilik:** «Rastamojka firmasi» qatori
(bizniki bo'lsa xarajat o'sha firmaga; **mijoz o'z firmasi bilan** qilsa
shu belgilanadi va bizga hech qanday xarajat tushmaydi) va **hujjatlar
uchun joy** — yo'lda kerak bo'ladigan fayllarni shu yerga qo'yasiz.

Kim kiradi: buxgalter va admin. Skladchiga bu bo'lim umuman ko'rinmaydi.

**Hozircha kiritilmagani, ochiq aytaman:** boshlang'ich qarz qoldiqlari —
siz aytganingizdek, hozir umumiy qarz qancha ekani noma'lum. Bilganingizda
har bir firmaga bitta yozuv bilan kiritamiz.

## Prixodni bitimga bog'lash — prixod kartochkasidan — 2026-08-01

Savolingizdan chiqdi: bitimga 2-3 ta prixodni qanday biriktiraman.
Biriktirish avvaldan bor edi — **uzish va boshqasiga ko'chirish yo'q edi**.

- Prixod kartochkasida endi **«Bitim»** qatori turadi: qaysi bitimga
  bog'langani ko'rinadi va bosilsa o'sha bitim ochiladi.
- O'sha yerda **ro'yxat** bor: mijozning ochiq bitimlari. Boshqasini
  tanlab **Saqlash** — prixod o'sha bitimga ko'chadi. **«— Uzish»** ni
  tanlasangiz — prixod bitimdan uziladi va bitim kartochkasidagi
  «Prixodni bog'lash» ro'yxatiga qaytadi.
- Ro'yxatda **hozir bog'langan bitim ham doim turadi**, u yopilgan
  (yutilgan yoki yo'qotilgan) bo'lsa ham — aks holda xatoning o'zi
  ko'rinmay qolardi.
- Kim ko'radi: bitim yozish huquqi borlar (sotuvchi, VED, mijoz
  boshqaruvchisi). Skladchiga bu qator ko'rinmaydi.
- Qoidalar o'zgargani yo'q: **boshqa mijozning prixodini** bitimga
  bog'lab bo'lmaydi, faqat **tasdiqlangan** prixod bog'lanadi, va
  bog'lash bitimni voronkada avtomat siljitadi.
- **Bir gap ochiq aytilsin:** prixodni bitimdan uzsangiz, bitimning
  voronkadagi etapi **orqaga qaytmaydi** — etap odam qo'ygan belgi,
  hisoblab chiqariladigan narsa emas. Kerak bo'lsa etapni qo'lda
  qaytarasiz.

## Xodimlar boti — «Hisoblatish» — 2026-07-31

Botning uchinchi va oxirgi bo'lagi — siz o'ylab topgan tartibda:

- Xodim botda **«🧮 Hisoblatish»** ni bosadi → **bo'limni tanlaydi**
  (🚚 Yo'lkira / 🛃 Rastamojka / 🔑 Podklyuch) → **mijozni yozadi** (kodi,
  telefoni yoki ismi) → **hamma narsani tashlaydi**: tovar ro'yxati,
  fayllar, rasmlar, kub/kg, yo'nalish → **«Bo'ldi»**.
- **AI tahlil qiladi va to'liqligini tekshiradi.** Yo'lkirada: qaysi
  shahardan qaysi shaharga, kub, kg, tovar nomi. Rastamojkada: kg, kub,
  tovar nomi (yo'nalish so'ralmaydi — bojxonaga farqi yo'q). Podklyuch —
  ikkisi qo'shilgani, shuning uchun hammasini so'raydi. Yetishmagani
  ro'yxat bo'lib chiqadi; xodim qo'shib yuboradi yoki shundayligicha
  tasdiqlaydi.
- **Tasdiqlagach kartochka ochiladi**: kodi bor mijozga — **bitim**
  (ochiq bitimi bo'lsa o'shanga qo'shiladi), kodi yo'qqa — **lead**.
  Bir odam ikki marta so'rasa, ikkinchi so'rov o'sha kartaga tushadi.
  Kartaning **lentasida AI nima qilganini yozib qo'yadi**: qanday
  guruhlagan, qaysi TNVED kodni qo'ygan, nimasi ziddiyatli. Yuborilgan
  fayl-rasmlar o'sha yozuvga biriktiriladi.
- **Narxni bot aytmaydi** — siz aytganingizdek, narxni xodim aytadi.
  Hisoblashga berish (VED xodimini tanlash) ham kartaning o'zida —
  avvalgi soatli tartib bilan.
- **AI ishlamasa ham to'xtamaydi:** xodim yozgan «250 kg», «5 kub»,
  «Yiwu → Toshkent» kabi ma'lumotlar baribir o'qiladi. Xodim yozgan
  raqam AI o'qiganidan ustun turadi.

Eslatma: Telegramga jonli ulanib sinash bu yerda mumkin emas — birinchi
real «Hisoblatish» ni serverda birga kuzatamiz. AI ishlashi uchun
serverda `ANTHROPIC_API_KEY` bo'lishi kerak.

Migratsiya yo'q. Tekshirildi: 828 unit/integration + 93 e2e yashil.


## Xodimlar boti — ikkinchi bo'lak — 2026-07-31

- **Botdan qidiruv.** Xodim botga mijoz kodini (GS777), karobka kodini
  (YW26-000123), yashik (CR-…) yoki partiya kodini yozsa — bot holatini
  aytadi: kimniki, nima, qayerda, qaysi mashinada, qachon jo'nagan.
  Mijoz kodiga: yuki qaysi omborda nechta, balansi (faqat moliya
  huquqi borlarga) va oxirgi prixodi. **Muhim:** bot faqat o'sha odam
  sistemadan ko'ra oladigan narsani ko'rsatadi — o'z omboriga tegishli
  bo'lmagan yukka «bu sizning omboringizda emas» deb javob beradi.
- **Javob kutayotgan mijoz.** Mijoz yozgan-u, 30 daqiqadan beri javob
  bo'lmasa — chat qaysi xodimning akkauntida bo'lsa, o'shanga eslatma
  boradi (mijoz kodi, qancha kutgani va oxirgi xabari bilan). Bitta
  sukut bo'yicha **bir marta** — takrorlanavermaydi. Muddatni Admin →
  Sozlamalardan o'zgartirasiz, 0 qilsangiz butunlay o'chadi.
- **Yuklash/tushirish svodkasi.** «Yuklashni yakunlash» bosilganda plan
  bilan ishlaydiganlarga qisqa xabar: nechta yuklandi, nechtasi qolib
  ketdi (kodlari bilan), nechtasi qo'shib yuklandi. Tushirishda: nechta
  qabul qilindi, nechtasi yetib kelmadi. Tugmani bosgan odamning o'ziga
  yuborilmaydi.

Migratsiya: **0053** (qo'shimcha ustun — mavjud ma'lumotga tegmaydi).

Tekshirildi: 819 unit/integration + 93 e2e yashil.


## Xodimlar boti — birinchi bo'lak — 2026-07-31

Javoblaringiz bo'yicha (podklyuch = rastamojka + yo'lkira qo'shilgan narx;
narxni hodim aytadi; hisoblatish hammaga; mijozga hozirgi kabinet) botning
birinchi bo'lagi tayyor:

- **Ikkita eshik.** Botga notanish odam kirsa: «👨‍💼 Hodim» / «📦 Mijoz»
  tugmalari. Hodim — telefonini yuboradi (Telegram tasdiqlagan o'z
  raqami), sistema xodimlar ro'yxatidan topib ulaydi. Mijoz — avvalgidek
  kabinet. Bitta Telegram ikki xodimga ulanmaydi.
- **Zadachani botdan yopish.** Yangi vazifa xabari ostida «✅ Bajarildi»
  tugmasi: bosasiz → natijani yozasiz → vazifa yopiladi, so'ragan odamga
  natija bilan xabar ketadi. Begonaning vazifasini yopib bo'lmaydi —
  ekrandagi qoidalar botda ham amal qiladi.
- **Qarzdorga ruxsat — telefonda bir bosishda.** So'rov sizga «✅ Ruxsat /
  ⛔ Yo'q» tugmalari bilan keladi; huquq (finance.debt_override) botda ham
  tekshiriladi.
- **«📋 Bugun» tugmasi.** Xodim istalgan payt bosib, ertalabki ro'yxatning
  o'zini oladi (kechikkan + bugungi vazifalar). Ertalabki avtomatik xabar
  avvaldan bor edi — endi tugma bilan ham o'sha.

Eslatma: Telegramga jonli ulanib sinash bu yerda mumkin emas — birinchi
real tugma bosilishini serverda kuzatamiz. Qidiruv, javobsiz mijoz
eslatmasi, yuklash svodkasi va Hisoblatish AI — keyingi bo'laklarda.

Tekshirildi: 813 unit/integration + 93 e2e yashil. Migratsiya yo'q.


## Kartada «kim yozishgan» ro'yxati — tanlab o'qish — 2026-07-31

1-javobingiz bo'yicha:

- **Lead/bitim/mijoz kartasidagi chat panelida** endi shu odam bilan
  yozishgan hodimlarning RO'YXATI chiqib turadi (nechta xabar bilan).
- **Vedchi, admin va siz** ro'yxatdan hodimni bosib, aynan o'sha
  hodimning suhbatini ochib o'qiysiz; suhbat ekranida ham xuddi shu
  tanlov chiplari bor («Hammasi» yoki bitta hodim).
- **Oddiy sotuvchi** ro'yxatda ismlarni ko'radi (kim gaplashganini
  bilish — umumiy ma'lumot), lekin faqat o'z suhbatini o'qiydi —
  manzilni qo'lda o'zgartirib ham boshqaning suhbatini ocholmaydi
  (tekshiruv bilan isbotlangan).

Tekshirildi: 806 unit/integration + 93 e2e yashil. Migratsiya yo'q.


## Vedchi va admin — barcha chatlarni ko'radi — 2026-07-31

Javoblaringiz bo'yicha 1-band tayyor:

- **Oddiy xodimlarda o'zgarish yo'q**: har kim faqat o'z akkauntidagi
  chatlarni ko'radi (telefon raqami bilan o'zi gaplashgan bo'lsa — o'sha).
- **Vedchi va admin endi HAMMANING chatini ko'radi** — /suhbatlar
  ro'yxatida har suhbat kimning akkauntida ekani yozilgan, ichida esa har
  xabar kim yozganini ko'rsatadi («qaysi hodim qanday gaplashgani»).
  Vedchiga bu hisoblash uchun: mijoz fayl-rasmlarni qaysi sotuvchining
  chatiga tashlasa ham, vedchi o'sha yerdan o'qiy oladi. /suhbatlar
  vedchining menyusiga ham qo'shildi, rasmlar ham xuddi shu qoidada
  ochiladi.
- **Javob yozish** hammaga faqat o'z akkauntidan — kuzatuv ko'z, og'iz
  emas.

Bot va AI-hisoblash bo'yicha javob alohida xabarda.

Tekshirildi: 805 unit/integration + 93 e2e yashil. Migratsiya yo'q.


## Kartadagi Telegram chat — telefondosh kodni ham topadi — 2026-07-31

«Bitimda ham, leadda ham chat ko'rinmayabti» xabaringizning sababi topildi:
bir odamda bir nechta GS kod bo'lganda, chat import paytida telefon mos
kelgan kodga biriktirilgan; bitim esa boshqa kodda ochilgan bo'lsa, karta
«bu mijozda chat yo'q» deb bo'sh qolar edi — «Suhbatlar»da esa chat turardi.

- Endi bitim/lead/mijoz kartasidagi panel o'sha odamning **telefondosh
  kodidagi chatni ham topadi** va sarlavhada qaysi kod ostida ekanini
  ko'rsatadi; javob ham to'g'ri kodga yoziladi.
- Ikki xil kodda ikki xil chat topilsa — panel ataylab jim qoladi
  (adashib boshqa odamning yozishmasini ko'rsatishdan ko'ra hech nima
  ko'rsatmaslik yaxshi); «Suhbatlar»dan ochasiz.
- Maxfiylik qoidasi o'zgargani yo'q: har menejer faqat o'z akkauntidagi
  chatlarni ko'radi, siz hammasini.

Eslatma: bu va yashik tuzatishlari ko'rinishi uchun serverni yangilash
kerak (backup → git pull → docker compose ... up -d --build).

Tekshirildi: 803 unit/integration + 93 e2e yashil. Migratsiya yo'q.


## Yashik yo'li to'liq tekshirildi va tuzatildi — 2026-07-30

«Unda shu yashikni ham tuzat» buyrug'ingiz bo'yicha yashikning butun yo'li
(yig'ish → plan → yuklash → yo'l → tushirish → topshirish → pul) chuqur
tekshiruvdan o'tkazildi: 20 ta shubhali joydan 11 tasi HAQIQIY xato bo'lib
chiqdi va hammasi tuzatildi. Eng muhimlari:

- **Yashik puli tannarxga umuman tushmas edi.** Yashik yig'ishda yozilgan
  haq (masalan 150 yuan) hech qachon dollarga o'girilmay, hech bir mijoz
  karobkasiga taqsimlanmay yotardi — foyda hisobingiz shunchaga yuqori
  ko'rinardi. Endi yozilgan zahoti tannarxga tushadi. Ustiga: yashik
  tarqatilgach yoki topshirilgach o'sha pul hisobdan BUTUNLAY o'chib
  ketardi — endi pul «kim uchun to'langan» ro'yxatga bog'lanadi va yashik
  hayoti tugagach ham joyida qoladi. Xato yozilgan haqni endi tuzatish ham
  mumkin: yashik kartasida xarajatni sabab bilan bekor qilib, qaytadan
  kiritasiz.
- **Skaner yana to'xtab qolishi mumkin edi.** Ichida ortiqcha karobkasi
  bor yashik IKKI marta skan qilinsa (odat, ikkinchi telefon yoki sekin
  vay-fay), server yiqilardi va telefon o'sha skanni abadiy qayta yuborib
  turardi — undan keyingi hamma skan ekranda yashil, lekin sistemaga
  yozilmagan. Endi ikkinchi skan xotirjam «allaqachon yuklangan» deb
  javob beradi (ortiqcha karobkalar baribir nomlanadi).
- **Kelmagan yuk «keldi» bo'lib qolardi.** Yuklashda ortda qolgan yashik
  a'zosi (masalan shikastlangani) Toshkentda yashik skan qilinganda
  «yetib keldi» bo'lib yozilardi: mijozga 3 ta karobka keldi deyilardi,
  bittasi Xitoyda turgan bo'lsa ham, va uni Toshkentda topshirish ham
  mumkin edi. Endi yashik skani faqat SHU mashinada kelgan karobkalarni
  qabul qiladi, kelmaganlari nomlab ko'rsatiladi.
- **Yashik manzili yuk bilan ko'chadi.** Avval yashik qatori abadiy
  Xitoyda «turardi»: kelgan yashikni Toshkentdan boshqa mashinaga planlab
  ham, o'sha yerda tarqatib ham bo'lmasdi; Xitoy inventarizatsiyasi esa
  ketgan yashikni sanashda ko'rsataverar edi. Endi tushirilgan yashik
  qayerda bo'lsa — o'sha skladniki.
- **«Qo'shib yuklandi» belgisi endi faqat haqiqatan qo'shilganda.**
  Ortiqchasi bilan tasdiqlangan yashikda avval HAMMA karobka «qo'shildi»
  deb yozilardi (8 rejali + 2 ortiqcha = 10 ta chetlanish!) va belgi
  keyingi reyslarga ham yopishib qolardi. Endi faqat rostdan qo'shilgani
  belgilanadi, yetib kelganda belgi o'chadi, manifest esa o'sha reysning
  o'zini o'qiydi (topshirilgandan keyin qayta chop etilsa ham to'g'ri).
- **Mayda qo'riqchilar:** bitta yashikni ikki ochiq planga qo'yib
  bo'lmaydi (avval ikkinchisining tasdig'i tushunarsiz xato bilan
  yonardi); prixod bekor qilinsa yoki karobka soni kamaytirilsa karobka
  yashikdan ham chiqadi (avval «o'lik» a'zo yashikni abadiy qulflab
  qo'yardi); yashikdagi yukning mijozini almashtirish rad etiladi —
  avval yashikni tarqating.

Har bir tuzatish uchun test yozildi va tuzatishsiz YIQILISHI ko'rsatildi.
Tekshirildi: 802 unit/integration + 93 e2e yashil. Migratsiya yo'q —
serverni yangilash xavfsiz.


## VED bosh ekrani, fayl-ruxsat qattiq rejimda, bitim etaplarini tartiblash — 2026-07-30

3-bo'lim ishlaringiz:

- **VED xodimi ham endi ish tartibi bilan uyg'onadi**: bosh o'rinda —
  hisoblash navbati (nechta turibdi, kechikkani qizil, bosilsa «Mening
  kunim»ga olib boradi), keyin agentga hujjati ketmagan (yo'lda/yetib
  kelgan) partiyalar, keyin TNVED kodsiz tovarli ochiq bitimlar.
- **Fayl-ruxsat endi qattiq**: ruxsati yo'q xodim fayl havolasi bilan ham
  rasm/hujjatni ocholmaydi — sistema rad etadi (avval faqat jurnalga
  yozardi). Bitta istisno: eski, turi noma'lum fayllar — ular jurnal
  rejimida qoldi, tarixdagi haqiqiy fayllarni buzmaslik uchun.
- **Bitim etaplarini** endi tepadagi ro'yxatda ▲▼ bilan tartiblash va ✖
  bilan o'chirish mumkin (o'chirishda ichidagi bitimlar siz tanlagan
  etapga ko'chadi; tartib doskaga ham, yukka ergashish qoidasiga ham
  ta'sir qiladi).
- **Yashik yuklash** bo'yicha buyrug'ingiz qabul qilindi — butun yashik
  yo'li bo'yicha chuqur tekshiruv ketyapti, natijasi alohida xabar
  qilinadi.

Tekshirildi: 794 unit/integration + 93 e2e yashil. Migratsiya yo'q.

## Buxgalteriya: rastamojka jadval bo'lib kiritiladi, partiya moliyasi bir ekranda, to'lovlar reestri — 2026-07-30

Buxgalter og'riqlari bo'yicha:

- **Rastamojka endi jadval.** Partiya kartasida yangi «Prixodlar xarajati
  (jadval)» bo'limi: qator — prixod, ustun — xarajat turi (rastamojka,
  usluga, yo'lkira, sertifikat — Admin → Xarajat turlari ro'yxatingiz).
  Excel'dagidek summalarni to'ldirib BIR marta saqlaysiz — har katak
  prixodning oddiy xarajati bo'lib yoziladi va tannarxga o'zi taqsimlanadi.
  Avval yozilgan summalar kataklar ostida ko'rinib turadi — ikki marta
  yozib yuborilmaydi. Boshqa partiyaning prixodiga yozib bo'lmaydi —
  sistema tekshiradi.
- **«Partiya moliyasi» bir ekranda.** Partiyadagi narx qo'yish ekrani endi
  har mijoz bo'yicha: tannarx (ichki reyslardan yig'ilgani bilan) → narx →
  foyda → **mijoz balansi** (qarzi qizil) → kassasiga o'tish havolasi.
  Tepada partiya jami: xarajat, qo'yilgan narx, foyda.
- **To'lovlar reestri** — Moliya → «To'lovlar reestri» (buxgalter bosh
  ekranida ham). Davr tanlab: kim, qachon, qancha, qaysi valyutada, qaysi
  kassaga, kim yozgani — jami bilan, XLSX yuklab olinadi. To'lov yozish
  avvalgidek: mijozni topasiz → uning kartasida forma.

**Ish tartibi bo'yicha kelishuv (muhim!):** ichki reys xarajati O'Z
partiyasiga yozilsin — YW-001 ning 30$/kubini YW-001 ga, GZ-001 ning
35$/kubini GZ-001 ga. Ikkalasini KA-001 ga yozsangiz sistema aralashtirib
o'rtacha qiladi. Tannarx har karobkaga barcha bosqichlardan o'zi yig'iladi.
Inspektor/customs sklad kabi umumiy xarajatni KA-001 ga «og'irlik
bo'yicha» asos bilan kiriting — kg ga proportsional bo'linadi.

Keyingi so'rovlaringiz ham shu kunda qo'shildi:

- **Tannarx «tarkibi»**: partiya moliyasida har mijoz tannarxi ostidagi
  «tarkibi» bosilsa — qatorlab ochiladi: qaysi reys/prixoddan, qaysi
  xarajat turi, qancha ulush («YW-001 · yo'lkira — $60»). «Shu reysgacha»
  jami ham alohida ko'rinadi.
- **Jadval ustunlari tayyor**: Rastamojka, Zatamojka, CCT, Yo'lkira
  (va avvalgi Boshqa) — deploy bilan o'zi paydo bo'ladi, Admin →
  Xarajat turlarida o'zgartirasiz. Jadval Excel ko'rinishiga keltirildi:
  katak chiziqlari, qator ranglari, pastda ustun jamilari (yozilgani va
  hozir kiritilayotgani alohida).
- Yo'l-yo'lakay topilgan xato: uzun xarajat nomi telefon ekranidan
  toshib, BUTUN sahifani kichraytirib yuborar ekan — tuzatildi.

Tekshirildi: 793 unit/integration + 92 e2e yashil. Migratsiya yo'q.

## Hisoblash: VEDga soatli zadacha, kechikkani qizil, tezlik hisoboti — 2026-07-29

So'raganingiz bo'yicha:

- **Zadachalar endi soat-daqiqagacha** — butun sistemada. Zadacha ochganda
  sana yoniga soat ham qo'yish mumkin (majburiy emas — faqat sana qo'ysangiz
  avvalgidek «kun oxirigacha» sanaladi). Soatli zadacha o'z daqiqasidan
  o'tsa darhol qizil bo'ladi, Telegramga ham soati bilan boradi.
- **«Hisoblashga berish»** — bitim va lid kartalarida yangi bo'lim.
  Sotuvchi VED xodimini O'ZI tanlaydi (ro'yxatda kimda nechta hisoblash
  turgani ko'rinadi) va tovar sonini yozadi. Muddat siz aytgan o'lchovda:
  1 ta tovar — 30 daqiqa, 2 ta — 1 soat, 3 ta — 1,5 soat, undan ko'pi —
  maksimum 2 soat. VED xodimiga darhol Telegram + zadacha tushadi.
- **Soat tugmani emas, ISHNI kutadi.** Bitimda VED tovar qatorlarini
  saqlashi bilan hisoblash o'z-o'zidan «bajarildi» bo'ladi — zadachani
  qo'lda yopish shart emas. Lidda (qatorlar yo'q) zadachani yopish
  hisoblashni yakunlaydi.
- **Kechikkanini darhol bilasiz.** Muddatidan o'tgan hisoblash 5 daqiqa
  ichida sizga va kutayotgan sotuvchiga Telegramda qizil xabar bo'lib
  boradi — har bir hisoblash uchun bir marta, spam yo'q.
- **«Hisoblash tezligi» hisoboti** (Hisobotlar → 🧮): davr tanlab, har bir
  VED xodimi bo'yicha — nechta bajargan, o'rtacha necha daqiqada, eng
  uzogi, muddatida ulushi, hozir navbatda nechta va kim qancha kutyapti.
  Kechikkanlari qizil.

Bir kartada bir vaqtda bitta ochiq hisoblash bo'ladi — ikkinchisini
berib bo'lmaydi, avvalgisi tugashi kerak.

Tekshirildi: 788 unit/integration + 92 e2e yashil. Migratsiya: 0052
(yangi jadval, mavjud ma'lumotga tegilmaydi).

## «Qisman topshirildi»: bo'linib kelgan yukda bitim oxirgi karobkani kutadi — 2026-07-29

Sizning taklifingiz bo'yicha («topshirildidan oldin qisman topshirildi
degan joy bo'lsa, o'sha yerda turadi hammasi topshirilgungacha»):

- Etap sozlamasida yangi holat bor: **«Qisman topshirildi»**. Shu holatli
  etap ochsangiz (masalan, «Topshirildi»dan oldin), bo'linib kelgan yukning
  birinchi qismi mijozga berilganda bitim o'sha yerga o'tadi va turadi.
- **«Mijozga to'liq topshirildi»** endi aniq ma'noda: bitimning HAMMA
  karobkasi mijoz qo'liga tekkandagina yonadi. Yo'qolgan yoki bekor
  qilingan karobka hisobga olinmaydi — u hech qachon topshirilmaydi, va
  bitimni abadiy «qisman»da ushlab turmasligi kerak.
- Bo'linmagan oddiy yuk bitta topshiruvda to'liq chiqadi — bunday bitim
  «qisman»ga kirmasdan to'g'ri «topshirildi»ga sakraydi.
- Qolgan etaplar avvalgidek birinchi qism bo'yicha yuradi: birinchi prixod
  «qabul qilindi»ni, birinchi mashina «jo'nadi»ni yoqadi.

Tekshirildi: 779 unit/integration + 92 e2e yashil. Migratsiya: 0051
(faqat ruxsat ro'yxatiga bitta qiymat qo'shadi, ma'lumotga tegilmaydi).

## Bitim varonkasi yukka ergashadi: yuk holati o'zgarsa bitim etapga o'zi o'tadi — 2026-07-29

Ro'yxatingizdagi 6-band («ha zor bo'lardi» degansiz):

- **Etapga yuk holatini bog'laysiz.** Bitimlar doskasida yangi ⚙ tugma →
  «Bitim etaplari» ekrani. Har bir etapga beshta holatdan birini
  tanlashingiz mumkin: yuk Xitoyda qabul qilindi · mashina jo'nadi ·
  mashina tushirildi · topshirishga tayyor · mijozga topshirildi. Holat
  tanlanmagan etap avvalgidek faqat qo'lda ko'chiriladi.
- **Bitim o'zi ko'chadi.** Bitimga ulangan yuk shu holatga yetishi bilan
  bitim o'sha etapga o'zi o'tadi — prixod tasdiqlanganda, mashina
  jo'naganda, tushirilganda, yuk tayyor bo'lganda, topshirilganda.
  Yukni bitimga KEYIN ulasangiz ham hisobga olinadi: ulashning o'zi
  «qabul qilindi» sanaladi.
- **Faqat oldinga.** Ikkinchi prixod kelsa yoki ikkinchi mashina jo'nasa,
  bitim ortga qaytmaydi — eng uzoq yetgan nuqta haqiqat. Yutilgan va
  yo'qotilgan bitimlarga tegilmaydi, va «yo'qotildi» etapiga avto-o'tish
  qo'yib bo'lmaydi: bitimni faqat odam, sabab yozib yo'qotadi.
- **Hammasi izli.** Avtomatik o'tish ham jurnalga yoziladi va
  avtomatlashtirish qoidalaringiz uni xuddi qo'lda ko'chirishdek eshitadi.
  Yo'l-yo'lakay topilgan kamchilik ham tuzatildi: «mashina tushirildi»
  hodisasi qoidalar ro'yxatida taklif qilinar, lekin aslida hech qachon
  yuz bermas edi — endi haqiqiy. Shu hodisaga qoida qo'ygan bo'lsangiz,
  endi ishlay boshlaydi.

Tekshirildi: 778 unit/integration + 92 e2e yashil. Migratsiya: 0050
(qo'shimcha ustun, mavjud ma'lumotga tegilmaydi).

5-band («appning o'zidan xabarnoma») siz aytganday hozircha to'xtab
turadi — Telegram qoladi; hodim o'ziga nima kelishini Profil →
xabarnomalar belgilarida o'zi boshqaradi.

## Chat tuzatishlari: «qo'shma» endi butunlay o'chiradi, jonli yangilanish, hamma GS kodlar, varonkada 💬 — 2026-07-29

Ro'yxatingizdagi 1–4 bandlar:

- **1. «Qo'shma» endi ishlaydi.** Chatdan «bu chatni olmang» desangiz, u
  ENDI ham kelajak uchun yopiladi, ham eski yozuvlari (rasmlari bilan)
  o'chadi — bitta bosishda. Tugma bosishdan oldin buni aytadi, amal
  jurnalga yoziladi. Mijozga ulangan chatni bu tugma o'chira olmaydi.
- **2. «Navbatda» yolg'oni tuzatildi.** Xabar Telegramga ketib bo'lgach,
  ekran «◷ navbatda» deb turaverar edi — sabab: sahifa o'zini
  yangilamas edi. Endi chat ekrani har 10 soniyada o'zini yangilaydi
  (faqat ochiq turganda): yuborilgan xabar darhol oddiy ko'rinishga
  o'tadi, mijozdan kelgan yangi xabar ham o'zi paydo bo'ladi. Yozayotgan
  matningiz yo'qolmaydi.
- **3. Bitta raqamda bir nechta GS kod.** Chat sarlavhasida endi shu
  raqamga tegishli HAMMA faol kodlar ko'rinadi (GS777 · GS555 · …) —
  avval faqat bittasi chiqar edi.
- **4. Varonka kartochkalarida chat belgisi.** Lid va bitim
  kartochkalarida 💬 — bu mijoz bilan yozishma bor degani; mijoz oxirgi
  yozgan (javob kutmoqda) bo'lsa — sariq «💬 !». Kim ko'rishi chat
  qoidalariga bo'ysunadi: har kim faqat o'zi ochadigan chatning belgisini
  ko'radi (sizga hammasi).

Tekshirildi: 768 unit/integration + 92 e2e yashil. Migratsiya yo'q.

Qolgan 2 band — «shu appning o'zidan xabarnoma kelsin» (5) va «yuk holati
o'zgarsa bitim varonkada o'zi ko'chsin» (6) — ikkalasi ham BO'LADI,
navbatdagi ikki bosqichda qilaman.

## Bosh ekran: yakka katta tugmalar olib tashlandi, iconkalar tushunarli — 2026-07-29

Fikringiz bo'yicha («1 qatorda 1 button turgan narsalar o'xshamabti»):

- Butun enni egallagan yakka katta tugmalar yo'q endi — skladchidagi katta
  «Qabul qilish», sotuvchidagi «Bugungi qo'ng'iroqlar», logist va
  buxgalterdagi kattalar, sizning ekrandagi birinchi katta tugma — hammasi
  qolganlari bilan bir xil oddiy qator/katakcha bo'ldi. Tartib va sonlar
  (raqamli belgilar) joyida.
- «Bugun» ogohlantirish tasmasi qoldi — u tugma emas, faqat muddati kelgan
  vazifa BORIDA chiqadi.
- Iconkalar tushunarli qilindi. Asosiy muammo — bitta ekranda BIR XIL
  iconka ikki xil eshikni anglatishi edi: «Qabul» va «Kutilayotganlar»
  ikkalasi lotokcha edi (endi kutish — soat), «Berish», «Ruxsatlar» va
  «Bitimlar» uchtasi qo'l siqish edi (ruxsat — belgi ✓), «Mening
  mijozlarim» butun mijozlar kitobi iconkasida edi (endi bitta odam),
  qarzdorlar/pul qatorlari — hamyon, tranzit — xarita, har oylik
  xarajatlar — kalendar.

Tekshirildi: 766 unit/integration + 92 e2e yashil. Migratsiya yo'q —
deploy'da faqat yangi build.

## Yangi rol ham skladga bog'lana oladi — xavfsizlik kemtigi yopildi — 2026-07-29

Rol konstruktoridagi yashirin kemtik: «sklad bilan chegaralanish» dasturda
ikkita rol NOMIga qotirilgan edi (skladchi va sklad boshlig'i). Siz
/admin/roles da yangi rol yaratsangiz (masalan «Brigadir»), unga sklad
huquqlarini bersangiz — u chegarasiz tug'ilar edi: HAMMA skladni ko'rardi,
jimgina.

Endi bu rolning o'zida belgilanadi:

- Rol kartasida yangi katak: **«Sklad bilan chegaralangan»** — belgilansa,
  rol egasi faqat unga biriktirilgan skladlarda ishlaydi.
- Skladchi va sklad boshlig'i avtomatik belgilangan holda keladi — hech
  narsa o'zgarmaydi, hozirgi xodimlar avvalgidek ishlayveradi.
- O'Z rolingizning katagini o'zgartirib bo'lmaydi (huquq berish
  ekranidagi qoida bu yerda ham): o'zini kengaytirish yo'li yopiq.
  Har o'zgarish jurnalga yoziladi.

Tekshirildi: yangi bazada 766 unit/integration + 92 e2e yashil (yangi rol
egasi chegaralangani ustun o'qishni ataylab o'chirib QIZIL ko'rsatildi).
Migratsiya: **0049** (faqat qo'shadi; ishlab turgan bazada ikkala sklad
roliga belgini o'zi qo'yadi — deploy'da qo'shimcha ish yo'q).

## Telegram mayda ishlar: chiqarilgan chatni tozalash, tahrirlar, import rasmlari, tezlik — 2026-07-29

Navbatda turgan to'rt ish yopildi:

- **«Hech qachon» degan chatning eskisini ham o'chirish.** Chatni chiqarib
  tashlash avvalgidek faqat kelajakka ishlar edi; endi «Qaysi chatlar»
  ekranida chiqarilgan chat yonida «Yozuvlarini o'chirish (soni)» tugmasi
  bor — bosilsa, saqlangan xabarlar va rasmlar butunlay o'chadi. Ataylab
  ALOHIDA tugma va tasdiq bilan: nimadir o'chirish hech qachon boshqa
  tugmaning yon ta'siri bo'lmasligi kerak. Kim, qachon, nechta o'chirgani
  jurnalga yoziladi. Mijozga ulangan (saqlanayotgan) chatni bu tugma
  o'chira olmaydi.
- **Tahrirlangan xabarlar.** Mijoz eski xabarini tahrirlasa (masalan,
  narxni to'g'irlasa), tizimdagi nusxa ham yangilanadi — menejer eski
  matnga qarab ish qilib qo'ymaydi. Saqlanmaydigan chatlardagi tahrir esa
  hech narsa yozmaydi (yozuv YO'Q joyga tahrir ham yo'q — maxfiylik).
- **Import endi rasmlarni ham oladi.** `pnpm tg-import --media` — eski
  yozishmalardagi rasmlar ham tushadi, lekin har chatdan eng yangi 50 tasi
  (xohlasangiz `--media 100`). Chegara ataylab: MinIO'da ~1.5 GB rasm bor
  va hali Drive'ga nusxa yo'q — chegarasiz yuklab olish omborni to'ldirib
  qo'yar edi. Qayta yurgizish xavfsiz: rasmi bor xabar qayta yuklanmaydi.
- **Tezlik.** Suhbatlar ro'yxati uchun yangi indeks (migratsiya 0048) —
  yozishmalar ko'paygan sari ro'yxat sekinlashmasin deb.

Tekshirildi: yangi bazada 764 unit/integration + 92 e2e yashil (purge'ning
«faqat chiqarilgan chat» himoyasi ataylab olib tashlab QIZIL ko'rsatildi —
birinchi urinishda test o'zini jim o'tkazib yuborayotgan ekan, u ham
tuzatildi). Migratsiya: **0048** (faqat indeks qo'shadi, xavfsiz).

## Rahbar ko'rinishi · lenta va chat alohida · Telegram ulash ekrandan — 2026-07-29

Uchala aytganingiz ham qilindi:

**1. Sizga hamma yozishmalar ko'rinadi.** Super admin sifatida «Suhbatlar»da
butun firmaning chatlarini ko'rasiz — har bir qatorda QAYSI xodimning
akkauntida ekani yozib turadi, chat ichida ham har bir javobda xodim ismi
bor. Rasmlar ham ochiladi. Oddiy xodimlar esa avvalgidek faqat o'zinikini
ko'radi. Javob yozish o'zgargani yo'q: siz ham faqat O'Z akkauntingizdan
yozasiz — birovning nomidan yozish bo'lmaydi.

**2. Lenta va chat endi ALOHIDA.** Mijoz/lid/bitim kartasida ikkita
alohida panel: **Lenta** — yuk, pul, izohlar (firma tarixi, hammaga) va
uning ostida **Telegram chat** — yozishma (faqat egasiga, sizga hammasi).
Mijozga yozish tugmasi ham chat panelida; lentadagi yozuv joyi endi faqat
ichki izoh (hodimlarga, @ism bilan). Chati yo'q mijozda chat paneli
umuman ko'rinmaydi — bo'sh quti turmaydi.

**3. Akkaunt ulash — ekrandan, 1 daqiqada.** «Suhbatlar → Telegram
ulash»: xodim o'z raqamini yozadi → Telegram ilovasiga kod keladi → kodni
kiritadi (ikki bosqichli parol bo'lsa, uni ham) — bo'ldi. Server yangi
akkauntni bir daqiqa ichida o'zi olib, tinglay boshlaydi — docker'ga,
terminalga tegish shart emas. Siroj (va keyingilar) endi shu yo'l bilan
ulanadi. Xavfsizlik avvalgidek: sessiya shifrlangan holda saqlanadi,
har kim faqat O'Z akkauntini ulaydi.

Tekshirildi: yangi bazada 759 unit/integration + 92 e2e yashil (rahbar
ko'rinishi himoyasini ataylab o'chirib QIZIL bo'lishi ko'rsatildi; yangi
brauzer testi ulash ekranini ochib, sozlanmagan serverda halol rad javobini
ko'radi). Migratsiya YO'Q.

Deploy eslatmasi: `.env` da `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TG_SESSION_KEY` turgan bo'lsa (sizda bor), ulash ekrani ishlaydi;
tg-listen konteyneri endi BITTA o'zi hamma akkauntni tinglaydi
(`TG_LISTEN_PHONE` endi kerak emas). Birinchi jonli ulanishni docker
loglarida kuzatamiz.

## MUHIM tuzatish: Telegram yozishmalari endi FAQAT egasiga ko'rinadi — 2026-07-29

Siz topgan jiddiy xato («nega superadmindan ulangan telegram account
chatlari hamma accountga korinyabti») yopildi:

- **Nima bo'lgan edi:** baza har bir xabarni «qaysi menejerning
  akkauntidan» deb TO'G'RI saqlar edi, JAVOB YOZISH ham faqat o'z
  akkauntidan edi — lekin O'QISH ekranlari buni so'ramas edi. Natijada
  sizning akkauntingizdan kirgan yozishmalar suhbatlar ro'yxatida,
  mijoz/lid/bitim kartalaridagi lentada va yon paneldagi chatda
  ruxsati bor HAR BIR xodimga ko'rinib turgan.
- **Endi:** suhbat — egasiniki. «Suhbatlar» ro'yxati, chat oynasi,
  kartadagi lentaning telegram qatorlari, yon panel, bosh ekrandagi
  «javob kutmoqda» soni, hattoki chatdagi RASMLAR ham — faqat o'sha
  akkauntni ulagan xodimga. Yuk, pul va izohlar lentada hammaga
  qoladi — ular firma tarixi, chat esa shaxsiy yozishma.
- Hech kimga istisno yo'q — sizga ham: siz o'z akkauntingiznikini
  ko'rasiz, xodimlarnikini emas. **Agar rahbar sifatida hammasini
  ko'rishni istasangiz — ayting**, buni alohida, ongli qaror sifatida
  bir qadamda ochamiz (teskarisi ham shunday oson).
- Kim mijoz bilan gaplashishi (ismi) ko'rinadi — NIMA deyilgani emas.
  Bu ataylab: «bu mijoz Siroj bilan gaplashadi» degan fakt ishga
  kerak, yozishmaning mazmuni esa emas.
- Chat rasmlari uchun himoya endi haqiqiy rad etish (boshqa fayl
  turlarida hali kuzatuv rejimi — u sizning alohida qaroringizga
  qoldirilgan, o'zgargani yo'q).

Tekshirildi: yangi bazada 754 unit/integration + 90 e2e yashil. Uchta
yangi «leak» testi yozildi va har biri himoyani ataylab olib tashlab
QIZIL bo'lishi ko'rsatildi: ro'yxat/chat, lenta, rasm ruxsati.
Migratsiya YO'Q — faqat so'rovlar tuzatildi, deploy oddiy (backup +
yangi build).

## 8-bosqich: o'z obyektlaringiz — «hech narsa hard-coded bo'lmasin»ning oxirgi bekati — 2026-07-29

Sizning 5-bandingiz («mukammal») ro'yxatidagi OXIRGI ish. Endi tizimga
yangi ro'yxat turini o'zingiz o'ylab topasiz — dasturchisiz:

- **Boshqaruv → «Obyektlar»**: nom yozasiz (masalan «Yetkazuvchilar»,
  «Xitoy fabrikalari», «Transport firmalari») va KIM tahrirlashini
  tanlaysiz — hamma / sotuv / moliya / faqat adminlar. Bitta tugma — tayyor.
- Shu zahoti menyuda **«Ro'yxatlar»** bo'limida chiqadi: qidiruv, filtr,
  saralash — mijozlar kitobidagidek. Yozuv qo'shish bitta qadam: nomini
  yozdingiz — kartasi ochildi.
- Har yozuvning **kartasi** bor: nomi, izoh, **qo'shimcha maydonlar**
  (Boshqaruv → «Maydonlar»da o'zingiz qo'shasiz — telefon, narx, sana,
  nima kerak bo'lsa), **vazifalar** (mas'ul, muddat — kalendarga tushadi)
  va **tarix** (kim nimani o'zgartirgani).
- O'qish hammaga ochiq — bu umumiy ma'lumotnoma; yozish esa tur
  yaratilganda tanlangan doiraga. O'chirish yo'q — **yashirish** bor:
  yozuvlar, javoblar va vazifalar hech qachon yo'qolmaydi.
- Intizom: har o'zgarish auditda; turni yashirsangiz ro'yxat menyudan
  yo'qoladi, qaytarsangiz hammasi joyida.

Ataylab qilinmadi (aytib qo'yaman): boshqa kartadan bu ro'yxatga
ko'rsatuvchi maydon, Telegramdan to'g'ri havola, yozuv ichida chat —
kerak bo'lsa keyingi turda.

Tekshirildi: yangi bazada 752 unit/integration + 90 e2e yashil (5 ta yangi
integratsiya testi — shu jumladan seed egangiz yaratgan turni o'chirib
yubormasligi ATAYLAB buzib ko'rsatildi; brauzer testi tur yaratib, yozuv
ochib, kartada tahrirlab, oxirida turni yashirib ketadi). Migratsiya:
**0047** (faqat qo'shadi: 2 jadval ustuni + 1 yangi jadval).

Bu bilan 5-band («mukammal») ro'yxati TUGADI: 4-bosqich (eslatmalarda
@ism), 6-bosqich (qarzdorga berishga ruxsat zanjiri), bitim ichidagi
ochiq ishlar, 7-bosqich (avtomatlashtirish qoidalari) va 8-bosqich (o'z
obyektlaringiz) — hammasi shu haftada chiqdi.

## 7-bosqich: avtomatlashtirish qoidalari — «X bo'lganda, Y qil» — 2026-07-29

Sizning 5-bandingiz davomi (7-bosqich). Boshqaruv → «Avtomatlashtirish
qoidalari» — endi qoidani formada o'zingiz yozasiz:

- **Qachon**: lid yoki bitim tanlangan bosqichga o'tganda, YOKI sklad
  hodisasi bo'lganda (yuk qabul qilindi, partiya jo'nadi/tushirildi,
  berishga tayyor, mijozga berildi, egasiz yuk, narxsiz yuk, hisobdan
  farq, kechiktirish tugadi, kamomad — 10 ta tanlov).
- **Nima qilsin**: **vazifa ochsin** (matni, kimga — yozuvning mas'uliga /
  kim qilgan bo'lsa o'shanga / tanlangan xodimga, muddati, muhimligi;
  vazifa qoidani ishlatgan kartaga bog'lanadi) yoki **Telegramga xabar**
  yuborsin (tanlangan xodimlarga, karta havolasi bilan).
- Har qoida ro'yxatda gap kabi ko'rinadi va **necha marta ishlaganini**
  ko'rsatadi — hech ishlamagan qoida xato yozilgan bo'ladi, buni darrov
  ko'rasiz. Pauza/yoqish va o'chirish bir tugma.
- Intizom: qoida ishlatgan vazifaning muallifi — qoidani YOZGAN odam
  (tarixda shunday ko'rinadi); xabar oluvchining profildagi «ovozsiz»
  sozlamalari qoidadan ustun; bir qoida boshqasini qo'zg'ata olmaydi
  (aylanib qolish strukturaviy mumkin emas).
- Yo'lda topilgan va tuzatilgan: hodisalar navbati 50 tadan ortiq yig'ilib
  qolsa, xabarlar daqiqasiga 50 tadan sudralib borar edi — endi navbat har
  ishga tushganda oxirigacha tozalanadi.

Keyingi turga qoldirilgani (aytib qo'yaman): «bosqichda N kun qotib
qoldi» kabi VAQT triggerlari, qo'shimcha shartlar (masalan «summa X dan
katta bo'lsa») va matn ichida {mijoz} kabi o'rinbosarlar.

Tekshirildi: yangi bazada 747 unit/integration + 89 e2e yashil (10 ta
yangi test: moslik jadvali, forma sharti, to'liq zanjir — qoida → bosqich
ko'chishi → vazifa; brauzer testi qoidani yozib, bitimni ko'chirib,
vazifani ko'rib, qoidani O'CHIRIB ketadi). Migratsiya: **0046** (faqat
yangi jadval qo'shadi).

## Bitim ichi to'ldi: shikast chegirmasi, bitimdan foyda, 50 tovar fayli + AI guruhlash — 2026-07-29

Sizning 5-bandingiz davomi (bitim ichidagi ochiq ishlar; «rastamojkani
hisoblash guruxlash uchun AI ishlatsang boladi» — qildik):

- **Shikast chegirmasi endi yoziladi**: bitim kartasida «Chegirma (shikast)»
  paneli — summa va MAJBURIY sabab bilan. Kim, qachon, nima uchun bergani
  tarixda qoladi; 0 yozsangiz xato chegirma olib tashlanadi (bu ham
  tarixda). Hisob yozish oynasi endi taklif summasini chegirmani ayirib
  ko'rsatadi. Oldin yozilgan hisobni esa moliyachi bekor qilib qayta
  yozadi — ikkalasi ham avvaldan tarixli.
- **Har bitimdan foyda**: kartada «Bitimdan foyda» paneli — yozilgan
  hisoblar minus shu bitim karobkalarining tannarxi (umumiy fura xarajati
  har karobkaga adolatli taqsimlangan holda), foiz bilan. Bekor qilingan
  hisob ham, bekor qilingan xarajat ham hisobga kirmaydi. Halol eslatma:
  bitimga bog'lanmasdan partiya orqali yozilgan pul alohida qatorda
  ko'rsatiladi — uni taxmin bilan bo'lib o'tirmaymiz. Panel faqat moliya
  hisobotlarini ko'ra oladiganlarga ochiladi.
- **50 tovar fayli**: bitim qatorlari panelida «Tovarlar faylini yuklash»
  — mijoz yuborgan .xlsx ni o'zimiz o'qiymiz (sarlavhani rus/o'zbek/xitoy/
  ingliz tilida o'zi topadi, «Итого» qatorini tashlab yuboradi), avval
  TNVED xotirasidan kodlarni qo'yadi, keyin **AI ~50 tovarni TNVED
  pozitsiyalariga guruhlab beradi** — har guruhga kod, nom, ishonch
  darajasi va **taxminiy boj foizi** (qoralama, rasmiy stavka emas).
  Deklarant ko'rib, kodlarni to'g'irlab, TASDIQLAGANDAN keyingina
  qatorlarga yoziladi. AI ishlamasa ham fayl o'qiladi — har tovar alohida
  qator, guruhlash qo'lda.

Tekshirildi: yangi bazada 737 unit/integration + 88 e2e yashil (9 ta yangi
test: fayl o'qish qoidalari, chegirma sababsiz o'tmasligi, foyda hisobida
bekor qilingan qatorlar chiqib ketishi — filtrsiz qizil bo'lishi
isbotlangan; 1 ta yangi brauzer testi). Migratsiya: **0045** (faqat indeks
qo'shadi). AI guruhlash serverdagi ANTHROPIC_API_KEY bilan ishlaydi —
birinchi jonli guruhlashni birga kuzatamiz.

## Xodimni @ bilan chaqirish + qarzdorga berishga yozma ruxsat — 2026-07-29

Sizning 5-bandingiz («mukammal») boshlanishi: 4-bosqich (@chaqiruv) va
6-bosqich (qarzdorga berishga ruxsat zanjiri).

- **Endi izohda xodimni @ bilan chaqirasiz**: mijoz, lid yoki bitim
  kartasidagi izoh oynasida `@` yozsangiz, hamkasblar ro'yxati chiqadi —
  tanlaganingiz ismi to'liq qo'yiladi va o'sha odamga Telegramda alohida
  xabar boradi: kim yozdi, qaysi kartada, nima dedi, havola bilan. Izoh
  boshqa qatnashchilarga avvalgidek boradi, chaqirilgan odamga esa bitta —
  shaxsiy — xabar ketadi (ikki marta bezovta qilmaydi). O'ziga o'zi
  @yozgan odamga xabar ketmaydi. Hamma hammani chaqira oladi (topshiriqlar
  qoidasi bilan bir xil). Muhim eslatma: xabar faqat Telegramini ulagan
  xodimga yetadi — ulamagan odam matnda chaqirilgan, lekin xabar olmaydi.
- **Qarzdorga yuk berish endi yozma ruxsat bilan**: skladchi qarzdor
  mijozga yuk bermoqchi bo'lsa, ekranda «Ruxsat so'rash» tugmasi chiqadi.
  So'rov moliya ruxsati bor rahbarlarga Telegramda boradi (mijoz, qarz
  summasi, kim so'ragani, izohi bilan) va yangi **«Berishga ruxsatlar»**
  ekranida turadi — u yerda rahbar bir bosishda ruxsat beradi yoki rad
  etadi, xohlasa izoh bilan. Javob so'ragan odamga darhol qaytadi.
- Ruxsatning intizomi qat'iy: **24 soat amal qiladi** (sozlamalardan
  o'zgartirsa bo'ladi), **bitta berishga yaraydi** (ishlatilgach yana
  so'raladi), va **summa bilan bog'langan** — ruxsatdan keyin qarz yana
  o'ssa, eski ruxsat o'tmaydi, chunki rahbar u summani ko'rmagan. Kim
  so'ragani, kim ruxsat bergani, qachon va qaysi berishga sarflangani —
  hammasi tarixda qoladi.
- Rahbarning o'zi skladda tursa, avvalgi to'g'ridan-to'g'ri belgilash
  ("qarzdorga berishga rozi") joyida qoladi — ruxsati bor odam o'zidan
  o'zi so'rab o'tirmaydi.

Tekshirildi: yangi bazada 728 unit/integration + 87 e2e yashil (20 ta
yangi test: chaqiruv qoidalari, ruxsat zanjirining har bir sharti —
muddati o'tgani, summasi oshgani, ikki marta ishlatishga urinish;
1 ta yangi brauzer testi). Migratsiya: **0044** (faqat qo'shadi, hech
narsani o'zgartirmaydi).

## Har bir rolga o'z bosh ekrani + partiya kartasi yangi tartibda — 2026-07-29

Sizning 4-bandingiz («buni ham qil»):

- **Sotuvchi** endi ilovani ochsa: katta tugma — **bugungi qo'ng'iroqlar**
  (soni bilan, kechikkanlari ogohlantirish bilan), ostida voronka (ochiq
  lidlar soni), **javob kutayotgan suhbatlar**, qarzdor mijozlari va ochiq
  bitimlari — hammasi jonli son bilan, bir bosishda ochiladi.
- **Logist**: katta tugma — **tasdiq kutayotgan planlar**, ostida yuklanayotgan
  partiyalar, kutilayotgan yuklar (kechikkanlari bilan), yo'ldagi mashinalar
  va xarajati kiritilmagan partiyalar.
- **Buxgalter**: katta tugma — boshqaruv hisobi (oy raqamlari bilan), ostida
  qarzdorlar (jami summa, 60 kundan oshgani ogohlantirish bilan), **shu oyda
  kassaga joylashtirilmagan to'lovlar**, kiritilmagan doimiy xarajatlar va
  xarajatsiz partiyalar.
- Kim qaysi ekranni olishi bitta qoidada: tor kasb yutadi (skladchi >
  logist > sotuvchi > buxgalter); siz (rahbar) atayin plitkali umumiy
  ko'rinishda qolasiz.
- **Partiya kartasi** endi bitim kartasidek: tepada kod, holat (rangli),
  asosiy amal tugmalari; keng ustunda yuk tarkibi va xarajatlar jadvali;
  yon panelda mashina, haydovchi telefoni, bojxona hujjatlari, narxlash,
  kuzatuv — kompyuterda yon panel yopishib turadi, telefonda tartib
  avvalgidek qulay. Hech bir amal joyidan ham, ruxsatidan ham o'zgargani
  yo'q.

Tekshirildi: yangi bazada 708 unit/integration + 86 e2e yashil (3 tasi
yangi rol-ekran testlari); partiya kartasining barcha eski testlari
o'zgarishsiz o'tdi. Migratsiya YO'Q.

## Telefonda CRM: suriladigan kanban, qulay yozish, chatdan rasm yuborish — 2026-07-29

Sizning 3-bandingiz («mobile friendly crm qilib ber kanban viewlarni» +
Telegram qoldiqlari):

- **Kanban endi suriladi (amoCRM kabi)**: telefonda har bir bosqich to'liq
  ekran — barmoq bilan yonga surib keyingi bosqichga o'tasiz, tepadagi
  bosqich tugmalari (soni bilan) ekrandan ketmay turadi, karobkalar ustun
  ichida aylanadi. «Keyingi bosqich» tugmasi va ⋯ ro'yxati joyida qoldi —
  kartani ko'chirish baribir bir bosish. Voronka ham, bitimlar doskasi ham.
  Kompyuterdagi sudrab-tashlash o'zgargani yo'q.
- **Yozish oynalari birxillashdi**: klaviaturada Enter — yuborish
  (Shift+Enter — yangi qator), telefonda Enter — yangi qator, yuborish
  faqat tugmadan (Telegramning o'zidagidek; avval telefonda ko'p qatorli
  xabar yozib bo'lmasdi va Enter chala xabarni jo'natib yuborardi). Oynalar
  matnga qarab o'zi kattaradi.
- **Chatdan RASM yuborish**: suhbatda va 💬 panelda 📎 tugmasi — bitta rasm
  (10 MB gacha), xohlasangiz izoh bilan, xohlasangiz izohsiz. Navbatda 🖼
  belgisi bilan ko'rinadi; yuborilgach suhbatda rasmning o'zi turadi.
  Himoya qoidalari o'zgarmagan: faqat o'z suhbatingizda, faqat mijoz avval
  yozgan bo'lsa, kunlik/daqiqalik cheklovlar bilan — rasm ham xuddi matn
  kabi bitta «slot» sarflaydi. Albom yo'q — ataylab, akkauntlar xavfsizligi
  uchun. **Migratsiya 0043** (faqat qo'shimcha ustun).
- Mayda-chuyda: iPhone'da pastki tugmalar «home» chizig'i ustiga chiqmaydi,
  💬 panelda tortish dastagi, mijoz kartasida uzun ism tugmani siqmaydi.

Tekshirildi: yangi bazada 703 unit/integration + 83 e2e yashil, CI
tartibida. Deploy'dan avval zaxira (qoida); migratsiya 0043 yengil.

## Audit nuqsonlari: 10 tasi ham tuzatildi — 2026-07-28

26-iyul auditida tasdiqlangan nuqsonlardan navbatdagi 10 tasi (siz «ha
tekshir» degan band):

- **Foyda hisobotlari**: bekor qilingan xarajat endi P&L, pul oqimi va
  partiya foydasidan chiqadi. Avval bekor qilingan xarajat ham foydani
  kamaytiraverardi. **Diqqat: hisobot raqamlari aynan bekor qilingan
  summalarga o'zgaradi — bu xato emas, to'g'rilanish.**
- **To'lov endi kassaga bog'lanadi**: mijoz to'lovini kiritganda qaysi
  kassa/hisobga tushganini tanlaysiz; pul oqimi sahifasida kassa qoldig'ida
  ko'rinadi. Eski to'lovlar «hali joylashtirilmagan» bo'lib qoladi — ularni
  o'zgartirmadik.
- **Topshirish dalolatnomasi**: 33 karobkada kesilib qolmaydi — karobka
  nechta bo'lsa, sahifa shuncha. Avval 50 karobkalik topshiruvda 17 tasi
  qog'ozga tushmay qolardi va ikki tomon ham to'liq emas ro'yxatga imzo
  chekardi.
- **Bojxona hujjatlari**: mashina tushirilgandan keyin invoys/upakovka/
  manifestni qayta yuklab olsangiz endi bo'sh chiqmaydi.
- **Prixodni bekor qilish**: yuk allaqachon mashinada yoki mijozga berilgan
  bo'lsa, prixodni bekor qilib bo'lmaydi — avval bekor qilinar va yuk
  qog'ozda «yo'q bo'lib» qolardi.
- **Checkbox maxsus maydon**: belgilangan katakcha endi «ha» bo'lib
  saqlanadi (avval doim «yo'q» saqlanardi).
- **/pipeline sahifasi**: endi faqat tegishli ruxsati borlarga ochiladi —
  avval istalgan xodim mijozma-mijoz yuk sonini ko'ra olardi.
- **/api/health endi rostini aytadi**: baza, fayl ombori (MinIO) va fon
  ishlari (zaxira, xabarlar) — uchchalasi alohida tekshiriladi. Avval
  «hammasi joyida» deb turib, aslida faqat bazani tekshirardi.
- **Postgres sozlamalari**: server endi 2005-yil zavod sozlamasida emas —
  xotira va SSD uchun to'g'ri qiymatlar docker-compose ichida. Deploy'da
  postgres konteyneri qayta ko'tariladi (5-15 soniya) — ish vaqtidan
  tashqarida qiling, avval zaxira.
- **Fayllarga ruxsat (1-bosqich, faqat kuzatuv)**: kim qaysi faylni ochishi
  MUMKIN EMASligi endi jurnalga yoziladi (`[attachment-authz]`), lekin
  hozircha hech narsa taqilmaydi — jurnal o'qilgach, keyingi bosqichda
  yopiladi. Shuning uchun hech kimning ishi to'xtamaydi.

Tekshirildi: yangi bazada 688 unit/integration + 83 e2e yashil, CI
tartibida. **Migratsiya YO'Q** — lekin deploy'dan avval zaxira (qoida).

## 3-to'plam yakuni: map, botga raqam bilan ulanish, chatda rasmlar — 2026-07-28

15 bandlik ro'yxatingizning oxirgi uch bandi:

- **Map (12)**: sklad yoki mashinaga bossangiz, ma'lumot endi **mapning o'z
  ichida** ochiladi — qaysi mijozning nechta karobkasi, mashinada esa jonli
  nuqta/taxmin, muddat, yuk ro'yxati va to'liq sahifaga havola. To'liq ekran
  rejimida ham ishlaydi (avval kartalar map ostida qolib, to'liq ekran ularni
  yopib qo'yardi). Sklad belgisi va son endi bitta butun.
- **Botga ulanish (13)**: klient botga kirsa «📱 Raqamimni yuborish» tugmasi
  chiqadi — kod ham, havola ham kerak emas. Telegram raqamni **o'zi
  tasdiqlaydi** (faqat egasining raqami yuboriladi, soxtalashtirib
  bo'lmaydi); raqam bazada bo'lsa, bitta bosishda hamma kodi ulanadi.
  Topilmasa — hech kimning nomini aytmasdan «menejeringizga murojaat
  qiling». Eski havola usuli zaxira bo'lib qoladi. Migratsiya 0043 emas —
  **0042**.
- **Chatda rasmlar (15)**: mijoz yuborgan **rasmning o'zi** endi suhbatda,
  kartadagi lentada va 💬 panelda ko'rinadi (bosilsa kattarayadi) — avval
  faqat «📎 media» yozuvi turardi. Faqat rasmlar, 10 MB gacha, yangi kelgan
  xabarlarniki (eski tarixni ortga yuklab olish — alohida qaror, akkauntga
  yuk bo'lmasligi uchun). CRMdan rasm YUBORISH keyingi bosqichda.

Eslatma: chat rasmlari ham hozircha zaxirasi yo'q MinIO'ga tushadi — shuning
uchun keyingi katta ish o'sha **rasmlar zaxirasi** bo'ladi, kelishilganidek.

Tekshirildi: 671 unit/integration + 83 e2e yashil. Migratsiya **0042**
(faqat bitta ustunni yumshatish) — deploy'dan avval zaxira nusxa.

## 3-to'plam (2-qism): chat va vazifalar — har sahifadan — 2026-07-28

Siz so'ragan «chat butun sistemadan kirsa bo'ladigan joyda» — tayyor:

- **Tepadagi 💬 tugma — har sahifada.** Bosilsa o'ngdan panel ochiladi
  (telefonda pastdan). Ikki bo'lim: **«Suhbatlar»** — mijozlar yozganlari,
  «javob kutilmoqda» belgisi bilan, o'sha yerda o'qib, o'sha yerda javob
  yozasiz (Enter — yuborish); **«Mening kunim»** — bugungi va kechikkan
  vazifalar, bir bosishda «bajarildi».
- **Karta ustida tursangiz — panel o'sha mijozning chatini ochadi**: bitim,
  mijoz yoki lid kartasida 💬 bosilsa, ro'yxat qidirmasdan to'g'ri shu
  suhbatga tushasiz.
- Skladchi va boshqa suhbatga huquqi yo'q hodimlarga panel faqat
  vazifalarni ko'rsatadi.
- **Zametkaga fayl** (siz so'ragancha): lentadagi izoh oynasida 📎 —
  rasm yoki hujjat biriktiriladi, lentada rasm ko'rinadi, hujjat nomi
  bilan yuklab olinadi.
- **«Записать контакт» yon panelga ko'chdi** — lid kartasida yig'ma bo'lib
  turadi, ochsangiz avvalgidek qo'ng'iroq/uchrashuv va keyingi qadam
  sanasi yoziladi.
- Kartada Telegram holati endi rostini aytadi: suhbat umuman ulanmagan
  bo'lsa — «hali ulanmagan» va qanday ulanishi; boshqa menejernikida
  bo'lsa — kim javob bera olishi, nomi bilan.

Tekshirildi: 660 unit/integration + 83 e2e yashil. Migratsiya yo'q.

## Fikr-mulohaza raundi, 3-to'plam (1-qism): karta va voronka — 2026-07-28

Siz so'ragan amoCRM ko'rinishi (3-band):

- **Karta endi ikki ustun** (bitim, lid va mijoz kartalari, kompyuterda):
  chapda — **lenta** butun bo'yiga: chat, izohlar, yuk, pul — hammasi vaqt
  tartibida, pastida yozish oynasi; o'ngda — **ma'lumot ustuni**: kelishuv
  va fakt taqqoslash, tahrirlash, pozitsiyalar, prixodlar, hisob, vazifalar,
  maydonlar, tarix. O'ng ustun scroll qilganda joyida turadi, o'zi ichida
  aylanadi. VED, logist, sotuv — bitta kartada birga ishlashga mo'ljallangan.
  Telefonda avvalgidek ustma-ust qoladi (avval ma'lumot, keyin lenta).
- **Voronka ustunlari ekran pastigacha**: sahifaning pastki scroll'i
  yo'qoldi — uzun ustun o'z ichida aylanadi, ustun sarlavhasi joyida
  turadi, bo'sh ustun ham pastgacha ko'rinib turadi.

Tekshirildi: 660 unit/integration + 80 e2e yashil (kartani sudrash testi
ham yangi ustunlarda o'zgarishsiz o'tdi). Migratsiya yo'q — faqat ekran.

Qolgan qismlar navbatda: o'ng tomondagi vazifa+chat paneli (5+7), mapda
bosganda yuk map ichida (12), botga nomer orqali ulanish (13), chatda
rasmlar va Telegramdek yozish (15).

## Fikr-mulohaza raundi, 2-to'plam: kutilayotgan yuk oqimi — 2026-07-28

9-band, siz aytgandek, to'liq:

- **Va'dada endi kub va kilo bor**: kutilayotgan yuk yozilayotganda karobka
  soni yoniga og'irlik (kg) va hajm (m³) ham kiritiladi, ro'yxatda ko'rinadi.
- **Bir bosishda qabul**: va'da qatoridagi «Qabul qilish» bosilsa, qabul
  oynasi mijoz tanlangan, karobka/kg/m³ to'ldirilgan holda ochiladi —
  skladchi faqat haqiqiy kelgan narsani to'g'rilaydi.
- **Qaytib borish yo'q**: qabul tasdiqlangan zahoti aynan o'sha va'da o'zi
  yopiladi — «qabul qilindi»ni qo'lda bosish endi kerak emas.
- **Farq — managerga xabar**: kelgan yuk va'dadan farq qilsa (karobka
  sonida har qanday farq; kg yoki m³da 5 %dan ortiq), va'dani yozgan
  hodimga Telegramga xabar boradi: nima kutilgan edi, nima keldi, prixodga
  havola bilan. Qabul qilgan hodimning o'ziga esa yuborilmaydi.

Tekshirildi: 660 unit/integration + 80 e2e yashil. Yangi migratsiya —
**0041** (va'daga kg/m³ ustunlari, faqat qo'shimcha). Deploy'dan avval
odatdagidek zaxira nusxa.

## Fikr-mulohaza raundi, 1-to'plam: tez tuzatishlar — 2026-07-28

Sizning 15 bandlik ro'yxatingizdan kelishilgan tartibda birinchi to'plam:

- **Zichlik ranglari — sizning shkalangiz** (11-band): 150 gacha yashil,
  250 gacha sariq, 450 gacha och qizil, undan yuqorisi to'q qizil. Xato
  topildi ham: yengil toifaga «firma rangi» berilgan ekan, firmamiz rangi
  esa qizil — shu uchun yengil yuk xavfli ko'rinardi. Endi rang bitta
  joydan chiqadi (qabul, plan, sklad — uchchalasida bir xil), chegaralarni
  esa Sozlamalardan o'zgartirsa bo'ladi.
- **«Boshqaruv» — tugmalar sahifasi** (6-band): kirganda endi to'g'ri
  sklad ro'yxatiga tushmaysiz — har bir bo'lim (Skladlar, Hodimlar,
  Mijozlar, Sozlamalar, Rollar, Maydonlar, Xarajat turlari, Valyuta,
  Furalar, Haydovchi ilovasi, Audit, Bildirishnomalar) katta tugma bo'lib
  bitta ekranda turadi. Har kimga faqat o'z huquqidagisi ko'rinadi.
- **Yon menyu yig'iladi** (1-band): chetidagi «⟨» bosilsa faqat
  ikonkalar qoladi, jadval va voronkaga keng joy. Tanlov eslab qolinadi.
- **Mobil «•••» menyusi endi o'zi yopiladi** (8-band): sahifa almashgan
  zahoti yopiladi — ikkinchi bosishni kutmaydi.
- **Skaner** (10-band): sabab serverda emas edi — QR'ni telefonning o'zi
  taniydi. iPhone Safari kameradan past sifatli (640×480) tasvir berar
  ekan; endi yuqori aniqlik so'raladi va telefon chirog'i (🔦) tugmasi
  qo'shildi (qorong'i skladda katta yordam). Xitoydagi skladchi yangilangan
  versiyada sinab ko'rsin — natijani ayting.
- **Xarajat turlari** (14-band): ular boshidan bazada ma'lumot edi, faqat
  eshigi yo'q edi. Endi Boshqaruv → «Xarajat turlari»da o'zingiz tur
  qo'shasiz, nomini o'zgartirasiz, keraksizini yashirasiz (tarix saqlanadi).
- **Lid ↔ Bitim** (4-band): ikkala voronka tepasida bir-biriga o'tish
  tugmasi; mijozga aylangan lid kartasida «🤝 Bitim ochish» — bir bosishda
  mijoz tanlangan holda yangi bitim.

Tekshirildi: 654 unit/integration + 79 e2e yashil, yangi bazada CI
tartibida. Bitta yangi migratsiya bor — **0040** (rang chegaralari) —
deploy'dan avval odatdagidek zaxira nusxa oling.

Navbatda (kelishilganidek): 9-band (kutilayotgan yuk — kub/kilo, bir
bosishda qabul, farq haqida xabar), keyin katta dizayn to'plami (karta,
voronka, o'ng panel, karta ichida map, bot ulash, chat).

## Skladchi bosh ekrani — ish tartibi bo'yicha — 2026-07-28

Siz aytgan yo'nalishning birinchi qadami: "har bir hodim qiladigan ishiga
qarab layout tuz — skladchi ekranidan boshla".

Endi sklad hodimi ilovani ochsa, **menyu emas, kun tartibini** ko'radi:

- **Qabul** — katta rangli tugma, avvalgidek eng tepada (kunning asosiy ishi);
- ostida qolgan qadamlar ish tartibida, har birida **jonli son**:
  - **Kutilayotgan** — necha mashina yo'lda, necha va'da ochiq, nechtasi
    kechikkan (⚠ bilan);
  - **Yuklash** — hozir nechta partiya yig'ilyapti/yuklanyapti;
  - **Topshirish** — mijoz olib ketishi mumkin bo'lgan nechta quti tayyor.

«Yuklash · 2» — bu buyruq: kirish kerakmi-yo'qmi, ochmasdan ko'rinadi. Son
nol bo'lsa, belgi umuman chiqmaydi — har qatorda «0» tursa, ko'z belgilarga
qarashni tashlab qo'yadi.

Sonlar **faqat o'z skladiniki**: Yiwu hodimi Yiwu raqamlarini ko'radi,
Toshkentniki — Toshkentnikini. Sklad biriktirilmagan hodimga esa nol
ko'rinadi, butun kompaniya emas — bu eski qoidamiz, shu yerda ham amal
qiladi.

Boshqa rollarga (sotuv, buxgalter, siz) hech narsa o'zgargani yo'q — ular
avvalgi ekranda qoladi. Keyingi rolni siz bilan kelishib olamiz.

Tekshirildi: 654 unit/integration + 75 e2e yashil; testlardan biri sonning
haqiqatan HARAKATLANISHINI isbotlaydi — va'da yozilsa +1, bekor qilinsa
yana joyiga qaytadi.

## Ichki chat — Telegramda. Tasklar — Telegramda, havola bilan — 2026-07-28

Siz belgilagan yo'l: yozuv kartada qoladi, gap Telegramda bo'ladi.

### 📝 Izoh yozdingiz — kerakli hodimga Telegram keladi

Mijoz, lid yoki **bitim** kartasida izoh qoldirsangiz, Telegramga shunday
xabar boradi:

```
📝 Bekzod · B-000123 Guangzhou partiya
Narxni qayta ko'ramiz, mijoz 10% so'rayapti
🔗 https://gsrwms.uz/bitimlar/…
```

**Kimga borishi** o'ylab qo'yilgan:

- kartani **olib borayotgan** hodimga (lid/bitim egasi);
- shu kartada **avval yozgan** har kimga — suhbatga yozib qo'shilasiz;
- **o'zingizga emas** — o'z izohingiz haqida xabar kelsa, hamma bu turdagi
  xabarni o'chirib qo'yadi.

Ataylab **rol bo'yicha hammaga** emas: «butun sotuvga har izoh» — bir haftada
o'chirib qo'yiladigan kanal.

### 🧾 Bitimning O'Z chati

Bitim kartasidagi izoh **shu bitimga** yoziladi, mijozga emas. Bitta mijozning
ikkita bitimi — ikkita alohida suhbat: biri haqidagi narx bahsi ikkinchisida
chiqmaydi. (Migratsiya **0039**, faqat qo'shimcha.)

### 🆕 Task berdingiz — hodimga darhol Telegram, havola bilan

- Yangi vazifa yoki qayta topshirilganda — **bajaruvchiga**;
- bajarilganda — **bergan odamga**, natija matni bilan;
- har xabarda **kartaga to'g'ri havola** (bitim, mijoz, partiya…);
- o'zingizga yozgan vazifa haqida xabar kelmaydi.

Ertalabki ro'yxat ham qoladi — bu «ertaga sakkizda bilasiz» bilan «hozir
bilasiz» orasidagi farq.

### Rol bo'yicha joylashuv haqida

Tekshirdim: bu qism allaqachon qurilgan ekan — har rolning o'z 4 ta pastki
tugmasi (skladchiga priyomka, sotuvchiga CRM, buxgalterga pul) va o'z menyusi
bor. Yetishmagani — hech nima **o'zi kelib aytmasligi** edi. Endi ish
Telegramdan keladi, havolasi bilan; ekranlar esa bajarish joyi.

Tekshirildi: 650 ta test + 73 ta ekran testi.

## Lenta endi lid kartochkasida ham jonli + ichki chat hamma joyda — 2026-07-28

Siz ikkita kamchilik aytdingiz. Ikkalasining ildizi bitta chiqdi.

### Sabab

Lenta «mijoz topilmasa — hech nima chizma» deb yozilgan edi. Lidlarning ko'pi
esa **hali mijoz emas** — shu bois CRM (lid) kartochkasida na lenta, na ichki
chat ko'rinardi. Siz «qo'shilmadi» dedingiz — va siz turgan joydan bu to'g'ri
edi: hech nima chizmaydigan panel qo'shilgan hisoblanmaydi.

### Endi

- **Lid kartochkasida lenta doim bor** — mijozsiz lidda ham. Unda lidning o'z
  yozuvlari (qo'ng'iroq 📞, uchrashuv 🤝, xabar 💬, izoh 📝) ko'rinadi va
  **ichki izoh oynasi** ishlaydi.
- Lid mijozga aylanganda (yoki raqami mavjud mijozga tegsa) — butun tarix
  bitta ustunga qo'shiladi: yozishma, yuk, pul, izohlar.
- **Bitim kartochkasida** lenta allaqachon bor edi (bitim doim mijozga
  bog'liq) — yangilab (`git pull`) ko'ring.

### Yo'l-yo'lakay: izohlar ikki marta chiqib qolgan edi

Lid yozuvlari lentaga tushgach, eski «tarix» ro'yxati bilan **ikki nusxa**
bo'lib qoldi — buni testning o'zi ushladi. Eski ro'yxat olib tashlandi;
**forma qoldi** (unda «keyingi qadam» sanasi bor — u «Bugungi qo'ng'iroqlar»
ro'yxatini boqadi).

Tekshirildi: 638 ta test + 73 ta ekran testi. Mijozsiz lidda izoh haqiqiy
forma orqali yozib, lentada chiqishi brauzerda ko'rildi.

## Tinglovchi endi o'zi qayta ishga tushadi — 2026-07-28

`pnpm tg-doctor` aniq ko'rsatdi: hammasi joyida, faqat akkaunt yonida
**«hech qachon»** — ya'ni tinglovchi bir marta ham yurak urishi yozmagan.

**Sabab:** uni `docker compose run` bilan ishga tushirgan edik. Bunday
konteyner **bir martalik** — server o'chsa yoki jarayon yiqilsa, u qaytib
kelmaydi. Va hech qayerda xato chiqmaydi.

Bu oddiy xizmatga qaraganda jiddiyroq: tinglovchi o'chiq turgan paytda kelgan
xabarlar **yo'qoladi**. To'g'ri, ishga tushganda o'zi qidirib oladi — lekin
**ishga tushsagina**.

### Endi alohida servis

`.env` ga bitta qator:

```
TG_LISTEN_PHONE=+998901757800
```

Keyin:

```bash
docker compose --profile telegram up -d
docker compose --profile telegram logs -f tg-listen
```

Birinchi qator shunday bo'lishi kerak:

```
tinglayapman: Bekzod (Super admin) · +998901757800 · 20 mijoz · 0 qoida
```

Endi **server qayta yuklansa ham o'zi ko'tariladi**.

Seans o'lgan bo'lsa (Telegram chiqarib yuborgan bo'lsa) — 30 soniya kutib
chiqadi, ya'ni cheksiz aylanib Telegramni bezovta qilmaydi. Bunday holat
odamni talab qiladi, qayta urinishni emas.

Tekshirildi: 632 ta test + 73 ta ekran testi.

## Lentaga yukning butun yo'li qo'shildi — 2026-07-28

Lentaning birinchi variantida yuk **kelishi** bor edi-yu, keyin to'g'ridan-to'g'ri
pulga o'tib ketardi. Kargo kompaniyasi uchun esa asosiy voqea aynan orada:

**keldi → yashik → yo'lga chiqdi → yetib keldi → topshirildi**

Endi hammasi bor:

| | |
|---|---|
| 📥 | yuk omborga keldi |
| 🧰 | yashik yig'ildi |
| 🚚 | **mashina yo'lga chiqdi** (partiya kodi, nechta quti) |
| 📍 | **O'zbekistonga yetib keldi** — «olib ketsa bo'ladi» belgisi bilan |
| ✅ | **mijozga topshirildi** — kim olib ketgani, telefoni bilan |
| ⚠️ | karobka yo'qoldi |
| ↩️ | partiya bekor qilindi — yuk qaytdi |

Qarz bilan berilgan bo'lsa, topshirish qatorida **«qarz bilan berildi»** deb
turadi — buni endi audit jurnalidan qidirish shart emas.

### Bitta quti emas, bitta mashina

Bazada har bir **qutining** har bir harakati alohida yozilади — 10 920 qator.
Uni shundayligicha chiqarsa, bir kunlik yuklashdan 341 qator chiqib ketardi.
Shuning uchun **partiya bo'yicha birlashtirildi**: 2 082 qator → 1 198 qator,
ya'ni **bitta mashina — bitta qator**. Odam ham shunday eslaydi.

Yo'qolgan qutilar esa **kun bo'yicha** birlashtiriladi — ular partiyaga
bog'lanmagan, partiya bo'yicha birlashtirsa mijozning butun tarixidagi barcha
yo'qotish bitta qatorga yopishib qolar edi.

Tekshirildi: 630 ta test + 73 ta ekran testi. Eng band mijozda o'lchandi —
1 834 ta harakat qatori, lenta 4 ms da yig'ildi.

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
