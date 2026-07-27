# GSRDriver (Android)

Haydovchi telefoniga o'rnatiladigan kuzatuv ilovasi. Sklad xodimi yuklash
paytida telefonni qo'liga olib o'rnatadi, reys kodini kiritadi va ruxsatlarni
o'zi beradi — haydovchidan hech narsa talab qilinmaydi.

## APK'ni qayerdan olaman

**Haydovchi uchun — bitta havola:**

```
https://gsrwms.uz/driver
```

Login talab qilinmaydi. Sahifada yuklab olish tugmasi, o'rnatish yo'riqnomasi
va QR kod bor — sklad xodimi sahifani ekranda ochadi, haydovchi kamerasi bilan
skanerlaydi.

**Yangi versiyani chiqarish (egasi yoki administrator):**

1. GitHub → **Actions** → **driver-apk** → oxirgi ✅ yashil ish → **Artifacts**
   dan `GSRDriver-apk` ni yuklab oling, zipdan `.apk` ni chiqaring.
2. Saytda **Admin → Haydovchi ilovasi** ni oching.
3. Versiya nomini yozing (masalan `1.2`), APK faylni tanlang, **Chiqarish**.

Shu zahoti `https://gsrwms.uz/driver` yangi faylni beradi. Havola o'zgarmaydi —
haydovchilarga har safar yangi manzil yuborish kerak emas.

O'rnatishda Android "noma'lum manbadan" deb ogohlantiradi — bu normal, ilova
do'konda emas, o'zimizniki. "Baribir o'rnatish" ni tanlang.

> **Telefonda eski GSRDriver bo'lsa — avval o'chirib tashlang.** Har bir CI
> yig'ilishi APK'ni yangi kalit bilan imzolaydi, shuning uchun yangi versiya
> eskisining ustiga o'rnatilmaydi ("imzo mos kelmadi"). Ustiga-ustma
> yangilash kerak bo'lsa, doimiy imzo kalitini GitHub secret sifatida qo'shish
> kerak.

## Domen o'zgarsa — diqqat

Ilova server manzilini **yig'ilish paytida** ichiga oladi
(`DEFAULT_SERVER`). 2026-07-27 da server o'z domeniga ko'chganda eski manzil
xizmat qilishdan to'xtadi va **ulangan hamma telefon bir vaqtda jim bo'lib
qoldi** — haydovchida buni bildiradigan hech narsa yo'q.

Shuning uchun domen ko'chirishda **uchalasi ham** kerak:

1. Caddy'da **eski nomni ham** xizmat qilishda qoldiring (o'tish davri uchun);
2. yangi APK chiqaring (`DEFAULT_SERVER` yangilangan holda);
3. hamma telefon yangilangandan keyingina eski nomni olib tashlang.

Ulangan telefonni qo'lda ham tuzatish mumkin: ilovadagi **Server manzili**
maydonini yangi domenga o'zgartirish yetarli, qayta ulash shart emas.

## Telefonni sozlash (sklad xodimi, 1 daqiqa)

1. Ilovani oching. **Server manzili** allaqachon to'ldirilgan bo'ladi (domen
   o'zgarsa shu yerdan tahrirlanadi).
2. Saytda partiya sahifasidagi **📲 Haydovchi telefoni → Kod yaratish** ni
   bosing va chiqqan 6 belgili kodni ilovaga kiriting → **Ulash**.
3. Ilova **ketma-ket** so'raydi — hammasiga rozilik bering:
   joylashuv → bildirishnomalar → **«Doim ruxsat berish»** → **batareya
   cheklovini olib tashlash** → **avtoishga tushirish** ro'yxati.
   Avtoishga tushirish oynasida GSRDriver'ni yoqib, ilovadagi **«Bajarildi»**
   tugmasini bosing (bu qadamni telefon o'zi aytmaydi, shuning uchun qo'lda
   tasdiqlanadi).
4. Ekranda **✅ Kuzatuv ishlayapti** chiqsa — tayyor. **⚠️ Sozlash
   tugallanmagan** tursa, ro'yxatdagi qizil qatorlar qolgan qadamlarni
   ko'rsatadi; ularning yonidagi tugma o'sha sozlamani ochadi.

Shundan keyin telefonni haydovchiga qaytarasiz.

> Bildirishnoma sohasida ilova jim turadi — faqat reys nomi ko'rinadi.
> Muammo bo'lsa (ruxsat olinmagan, internetsiz uzoq qolib ketgan) o'shanda
> yozuv chiqadi. Android foydali ish bajarayotgan ilovadan bildirishnomani
> olib tashlashga ruxsat bermaydi, shuning uchun uni butunlay yashirib
> bo'lmaydi.

## Qanday ishlaydi

- **Har 2 soatda** bitta joylashuv olinadi (ilovada 1 / 2 / 3 soat qilib
  o'zgartirsa bo'ladi). Oraliqlar orasida GPS **butunlay o'chib turadi** —
  batareya shuning uchun kam sarflanadi.
- Joylashuv olinmasa (tunnel, garaj, yopiq osmon) ilova 10 daqiqadan keyin
  qayta urinadi, 2 soat kutmaydi.
- Nuqtalar avval telefonda saqlanadi, keyin serverga yuboriladi; internet
  yo'q joyda (chegara, tog'lar) navbatda turadi va aloqa paydo bo'lishi bilan
  birdan ketadi. Ekranda «Yuborilmagan nuqtalar» soni ko'rinadi.
- Telefon o'chirilib yoqilsa, kuzatuv o'zi qayta ishga tushadi.
- **Partiya yopilganda kuzatuv avtomatik o'chadi** va ilova reys ma'lumotini
  o'zidan o'chiradi — haydovchi reysdan tashqarida kuzatilmaydi.
- Ekran haydovchining telefoni tilida ko'rinadi: o'zbekcha, **xitoycha** yoki
  ruscha.

Texnik izohlar:

- Google Play xizmatlari **ishlatilmaydi** (Xitoy telefonlarining ko'pida u
  yo'q) — joylashuv Android'ning o'z `LocationManager`i orqali olinadi,
  shuning uchun ilova har qanday Android telefonda ishlaydi.
- Oraliqni `AlarmManager` yuritadi (`setAndAllowWhileIdle`), shuning uchun
  telefon uxlab yotganda ham signal keladi. Aynan shu sababdan **batareya
  cheklovini olib tashlash majburiy**: aks holda Android signalni kechiktiradi
  va nuqtalar 2 soatda emas, tasodifiy kelib turadi.

## Ishlab chiquvchi uchun

```bash
cd apps/driver-android
./gradlew assembleRelease      # app/build/outputs/apk/release/
```

Android SDK kerak (Android Studio yoki `ANDROID_HOME`). Server manzilining
standart qiymati `app/build.gradle.kts` dagi `DEFAULT_SERVER` da.

Serverdagi mos sozlama: `FRESH_MINUTES` (`src/modules/wms/tracking/devices.ts`)
— xaritada nuqta qachongacha "haqiqiy" hisoblanishi. Oraliqni jiddiy
o'zgartirsangiz, uni ham moslang.
