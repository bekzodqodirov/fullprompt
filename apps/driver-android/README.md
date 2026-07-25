# GSRDriver (Android)

Haydovchi telefoniga o'rnatiladigan kuzatuv ilovasi. Sklad xodimi yuklash
paytida telefonni qo'liga olib o'rnatadi, reys kodini kiritadi va ruxsatlarni
o'zi beradi — haydovchidan hech narsa talab qilinmaydi.

## APK'ni qayerdan olaman

GitHub har o'zgarishdan keyin APK'ni o'zi yig'adi:

1. GitHub'da reponi oching → yuqoridagi **Actions** → **driver-apk**.
2. Oxirgi ✅ yashil ishni bosing.
3. Pastdagi **Artifacts** bo'limidan `GSRDriver-apk` ni yuklab oling (zip).
4. Zip ichidagi `.apk` faylni haydovchi telefoniga o'tkazing (Telegram, USB,
   yoki telefondan to'g'ridan-to'g'ri yuklab oling).

O'rnatishda Android "noma'lum manbadan" deb ogohlantiradi — bu normal, ilova
do'konda emas, o'zimizniki. "Baribir o'rnatish" ni tanlang.

## Telefonni sozlash (sklad xodimi, 1 daqiqa)

1. Ilovani oching. **Server manzili** allaqachon to'ldirilgan bo'ladi (domen
   o'zgarsa shu yerdan tahrirlanadi).
2. Saytda partiya sahifasidagi **📲 Haydovchi telefoni → Kod yaratish** ni
   bosing va chiqqan 6 belgili kodni ilovaga kiriting → **Ulash**.
3. Ilova ruxsat so'raydi — hammasiga rozilik bering. Joylashuv so'ralganda
   **«Doim ruxsat berish»** ni tanlash shart (aks holda ekran o'chgach
   kuzatuv to'xtaydi).
4. **Batareya sozlamalari** tugmasini bosib, ilovani batareya cheklovidan
   chiqaring va avtoishga tushirishga ruxsat bering. Xitoy telefonlarida
   (Xiaomi, Huawei, Oppo, Vivo) bu qadam **majburiy** — aks holda tizim
   ilovani fonda o'ldiradi.

Shundan keyin telefonni haydovchiga qaytarasiz. Ekranda doimiy bildirishnoma
turadi ("Reys: PARTIYA-KODI") — bu ilova ishlayotganining belgisi.

## Qanday ishlaydi

- Har ~5 daqiqada (yoki 250 metr siljiganda) joylashuv olinadi va telefonda
  saqlanadi.
- Internet bo'lganda hammasi serverga yuboriladi; internet yo'q joyda (chegara,
  tog'lar) navbatda turadi va aloqa paydo bo'lishi bilan birdan ketadi.
- Telefon o'chirilib yoqilsa, kuzatuv o'zi qayta ishga tushadi.
- **Partiya yopilganda kuzatuv avtomatik o'chadi** va ilova reys ma'lumotini
  o'zidan o'chiradi — haydovchi reysdan tashqarida kuzatilmaydi.

Texnik izoh: Google Play xizmatlari **ishlatilmaydi** (Xitoy telefonlarining
ko'pida u yo'q) — joylashuv Android'ning o'z `LocationManager`i orqali
olinadi, shuning uchun ilova har qanday Android telefonda ishlaydi.

## Ishlab chiquvchi uchun

```bash
cd apps/driver-android
./gradlew assembleRelease      # app/build/outputs/apk/release/
```

Android SDK kerak (Android Studio yoki `ANDROID_HOME`). Server manzilining
standart qiymati `app/build.gradle.kts` dagi `DEFAULT_SERVER` da.
