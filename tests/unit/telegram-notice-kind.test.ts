import { describe, expect, it } from 'vitest';
import { telegramNoticeKind } from '@/modules/wms/agent/listener-hooks';

/**
 * What a line from Telegram's own service account (777000) is: his LOGIN traffic, or a NOTICE about the account
 * (`telegramNoticeKind`, listener-hooks). A notice switches the AI sotuvchi off at once (crm account-alarm
 * `agentTelegramNotice`) and costs every approved reply still waiting and every live draft — so a login read as a
 * notice is the 2026-11-19 outage (two of his own sign-ins, the AI off for two and a half days), and a warning read
 * as a login is the machine talking through the warning that comes before a ban.
 *
 * The texts are Telegram's own wording as its apps show it, reconstructed per language — the server never stores
 * the line (it may be a login code) and logs only its redacted shape (`redactNotice`, «[agent] 777000 …»), which is
 * where the real ones are to be read. The digits, dates and addresses are made up.
 */

/** His own sign-ins: the code in every phrasing Telegram uses, and the «new login» alert that follows one. */
const LOGIN: readonly (readonly [string, string])[] = [
  [
    'en, the current code',
    'Login code: 52814. Do not give this code to anyone, even if they say they are from Telegram!\n\n' +
      '❗️This code can be used to log in to your Telegram account. We never ask it for anything else.\n\n' +
      "If you didn't request this code by trying to log in on another device, simply ignore this message.",
  ],
  [
    'en, the older code',
    'Your login code: 52814\n\nThis code can be used to log in to your Telegram account. We never ask it for anything else. ' +
      "Do not give it to anyone, even if they say they're from Telegram!\n\n" +
      "If you didn't request this code by trying to log in on another device, simply ignore this message.",
  ],
  ['en, the code first', '52814 is your Telegram login code. Do not give it to anyone, even if they say they are from Telegram!'],
  ['en, «Your code:»', 'Your code: 52814\n\nDo not give this code to anyone, even if they say they are from Telegram!'],
  ['en, a space inside the code', 'Login code: 52 814. Do not give this code to anyone, even if they say they are from Telegram!'],
  ['en, a dash inside a six-digit code', 'Login code: 528-140. Do not give this code to anyone, even if they say they are from Telegram!'],
  ['en, six digits', 'Login code: 528140. Do not give this code to anyone, even if they say they are from Telegram!'],
  ['en, a greeting first', 'Dear Aziz,\n\nYour login code: 52814\n\nDo not give this code to anyone.'],
  ['en, the code on its own line', 'Login code:\n52814\n\nDo not give this code to anyone, even if they say they are from Telegram!'],
  ['en, «Login code for …» (Telegram Desktop)', 'Login code for Telegram Desktop: 52814. Do not give this code to anyone!'],
  ['en, the Telegram Web code', 'Login code for Telegram Web: 52 814.\n\nDo not give this code to anyone, even if they say they are from Telegram!'],
  ['en, «Telegram code» and the link', 'Telegram code 52814\n\nYou can also tap on this link to log in:\nhttps://t.me/login/52814'],
  ['en, an invisible mark beside the code', 'Login code: ​52814‎. Do not give this code to anyone!'],
  [
    'ru, the current code',
    'Код для входа в Telegram: 52814. Не давайте код никому, даже если его требуют от имени Telegram!\n\n' +
      '❗️Этот код используется для входа в Ваш аккаунт в Telegram. Он никогда не нужен для чего-то ещё.\n\n' +
      'Если Вы не запрашивали код для входа, проигнорируйте это сообщение.',
  ],
  ['ru, no colon', 'Код для входа в Telegram 52814. Не давайте код никому, даже если его требуют от имени Telegram!'],
  ['ru, a space inside the code', 'Ваш код для входа: 52 814'],
  ['ru, the code first', '52814 — код для входа в Telegram. Не сообщайте его никому.'],
  ['ru, a greeting first', 'Здравствуйте, Aziz!\nВаш код подтверждения: 52814'],
  ['uk', 'Код для входу в Telegram: 52814. Нікому не повідомляйте цей код, навіть якщо його вимагають від імені Telegram!'],
  [
    'uz (Latin), the code',
    'Kirish kodi: 52814. Bu kodni hech kimga bermang, hatto ular Telegramdan ekanliklarini aytishsa ham!\n\n' +
      '❗️Bu kod Telegram hisobingizga kirish uchun ishlatiladi. Biz uni boshqa hech narsa uchun so‘ramaymiz.\n\n' +
      'Agar bu kodni boshqa qurilmadan kirishga urinib so‘ramagan bo‘lsangiz, bu xabarni e’tiborsiz qoldiring.',
  ],
  ['uz (Latin), no colon', 'Telegramga kirish kodi 52814. Uni hech kimga bermang!'],
  ['uz (Latin), the code first', '52814 — Telegramga kirish kodingiz.'],
  ['uz (Latin), «Sizning kodingiz» with a dash', 'Sizning kodingiz: 52-814'],
  ['uz (Cyrillic), the code', 'Кириш коди: 52814. Бу кодни ҳеч кимга берманг, ҳатто улар Telegram’дан эканини айтса ҳам!'],
  ['uz (Cyrillic), the code on its own line', 'Telegram’га кириш учун код:\n52814'],
  ['kk', 'Кіру коды: 52814. Бұл кодты ешкімге бермеңіз, тіпті олар өздерін Telegram қызметкері деп айтса да!'],
  ['tr', 'Giriş kodu: 52814. Bu kodu Telegram’dan olduklarını söyleseler bile kimseyle paylaşmayın!'],
  ['zh', '登录代码：52814。请勿将此代码告诉任何人，即使对方自称来自 Telegram！'],
  ['fa', 'کد ورود: 52814. این کد را به هیچ‌کس ندهید، حتی اگر بگویند از طرف تلگرام هستند!'],
  ['ar', 'رمز تسجيل الدخول: 52814. لا تعطِ هذا الرمز لأي شخص، حتى لو قالوا إنهم من تيليجرام!'],
  ['de', 'Login-Code: 52814. Gib diesen Code niemandem, auch wenn behauptet wird, er sei von Telegram!'],
  [
    'es',
    'Código de inicio de sesión: 52814. ¡No lo compartas con nadie, ni siquiera si dicen ser de Telegram!\n\n' +
      '❗️Este código puede usarse para iniciar sesión en tu cuenta de Telegram. Nunca lo pedimos para nada más.\n\n' +
      'Si no solicitaste este código al intentar iniciar sesión en otro dispositivo, ignora este mensaje.',
  ],
  [
    'en, the new-login alert WITHOUT an IP (current Telegram)',
    'New login. Dear Aziz, we detected a login into your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
      'Device: Telegram Desktop, 5.8.1, Windows 11\nLocation: Tashkent, Uzbekistan\n\n' +
      "If this wasn't you, you can terminate that session in Settings > Devices (or Privacy & Security > Active Sessions).\n\n" +
      'If you think that somebody logged in to your account against your will, you can enable Two-Step Verification in ' +
      'Privacy and Security settings.\n\nSincerely,\nThe Telegram Team',
  ],
  [
    'en, the alert with its fields inline',
    'We detected a login to your account from a new device on Wednesday, 19 Nov at 12:16. Device: Telegram Desktop. ' +
      "Location: Tashkent, Uzbekistan If this wasn't you, you can go to Settings > Devices and terminate that session.",
  ],
  [
    'en, a QR login’s alert',
    'New login. Dear Aziz, we detected a login into your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
      'Device: Telegram Web A 10.9, Chrome, Windows (QR code)\nLocation: Tashkent, Uzbekistan',
  ],
  [
    'en, the older alert with a compact IP',
    'Aziz, we detected a login into your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
      'Device: Telegram Desktop\nLocation: Tashkent, Uzbekistan (IP=213.230.80.11)',
  ],
  [
    'ru, the alert without an IP',
    'Новый вход в аккаунт. Aziz, мы обнаружили вход в Ваш аккаунт с нового устройства 19/11/2026 в 07:16:02 UTC.\n\n' +
      'Устройство: Telegram Desktop, 5.8.1, Windows 11\nМестоположение: Ташкент, Узбекистан\n\n' +
      'Если это были не Вы, Вы можете завершить этот сеанс в разделе «Настройки» > «Устройства».',
  ],
  [
    'ru, the older alert',
    'Aziz, мы зарегистрировали вход в Ваш аккаунт с нового устройства 19/11/2026 в 07:16:02 UTC.\n\n' +
      'Устройство: Telegram Web\nМестоположение: Ташкент, Узбекистан',
  ],
  [
    'uz (Latin), the alert',
    'Yangi kirish. Hurmatli Aziz, hisobingizga yangi qurilmadan kirilganini aniqladik: 19/11/2026, 07:16:02 UTC.\n\n' +
      'Qurilma: Telegram Desktop, Windows 11\nJoylashuv: Toshkent, O‘zbekiston\n\n' +
      'Agar bu siz bo‘lmasangiz, Sozlamalar > Qurilmalar bo‘limida bu seansni tugatishingiz mumkin.',
  ],
  [
    'uz (Cyrillic), the alert',
    'Янги кириш. Ҳурматли Aziz, ҳисобингизга янги қурилмадан кирилганини аниқладик.\n\nҚурилма: Telegram Desktop\nЖойлашув: Тошкент, Ўзбекистон',
  ],
  [
    'tr, the alert',
    'Yeni giriş. Sayın Aziz, hesabınıza yeni bir cihazdan giriş yapıldığını tespit ettik.\n\nCihaz: Telegram Desktop\nKonum: Taşkent, Özbekistan',
  ],
  [
    'kk, the alert',
    'Жаңа кіру. Құрметті Aziz, аккаунтыңызға жаңа құрылғыдан кіру анықталды.\n\nҚұрылғы: Telegram Desktop\nОрналасқан жері: Ташкент, Өзбекстан',
  ],
];

/** Lines that WARN about the account — every one of them must switch the AI off, whatever else it carries. */
const WARNING: readonly (readonly [string, string])[] = [
  ['empty', ''],
  ['en, limited', 'Your account has been limited. Until 25.11.2026 you can only send messages to your mutual contacts.'],
  ['en, spam reports', 'We received reports of spam from your account. Until 25.11.2026 you can only message mutual contacts.'],
  [
    'en, the terms of service',
    'Your account was limited for violating the Telegram Terms of Service (section 1.5). Until 25.10.2026 you can only…',
  ],
  ['en, deletion', 'Your account will be deleted in 7 days because a deletion request was made. If it wasn’t you, log in to cancel it.'],
  ['en, frozen', 'Your account is frozen for violating the Terms of Service. You can submit an appeal via @SpamBot.'],
  ['en, «Someone tried to log in» — a security alert', 'Someone tried to log in to your account. They entered the correct code, but not your password.'],
  [
    'en, an attempt shaped like the new-login alert',
    'New login attempt. Someone tried to log in to your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
      'Device: Telegram Web\nLocation: Lagos, Nigeria (IP = 102.89.0.1)',
  ],
  ['en, a code beside a limitation', 'Your code: 52814. Your account was limited for spam — enter it at telegram.org/support to appeal.'],
  ['en, a deletion request with its own code', 'Someone has requested to delete your Telegram account. Your confirmation code: 52814.'],
  ['en, a code beside a restriction', 'Login code: 52814. We detected suspicious activity: your account is restricted until 25.11.2026.'],
  ['en, an unofficial app', 'Important: your account was used in an unofficial app.\nTicket: 52814.'],
  ['en, suspicious activity and an IP', 'We detected suspicious activity from IP 213.230.80.11 using a third-party app.'],
  ['en, Telegram’s IP shape on a warning', 'Your account was limited after unusual activity (IP = 213.230.80.11).'],
  [
    'en, the my.telegram.org code — a code that can delete the account',
    'Web login code. Dear Aziz, we received a request from your account to log in on my.telegram.org. This is your login code:\n' +
      'AbCdEfGh123\n\nDo not give this code to anyone, even if they say they’re from Telegram! This code can be used to delete ' +
      'your Telegram account. We never ask to send it anywhere.',
  ],
  ['en, an appeal number', 'Appeal number: 1234567.'],
  ['ru, limited', 'Аккаунт ограничен. Мы получили жалобы на спам с Вашего аккаунта. До 25.11.2026 Вы можете писать только взаимным контактам.'],
  ['ru, deletion', 'Ваш аккаунт будет удалён через 7 дней по запросу на удаление.'],
  [
    'ru, an attempt',
    'Новая попытка входа. Кто-то пытался войти в Ваш аккаунт с нового устройства.\n\nУстройство: Telegram Web\nМестоположение: Лагос, Нигерия',
  ],
  ['uz (Latin), limited', 'Hisobingiz cheklandi. Murojaat raqami: 2026\nBatafsil: telegram.org/faq_spam'],
  ['uz (Latin), an attempt', 'Hisobingizga kimdir kirishga urindi.\n\nQurilma: Telegram Web\nJoylashuv: Lagos, Nigeriya'],
  ['uz (Latin), a code beside spam reports', 'Kirish kodi: 52814. Hisobingizdan spam yuborilgani haqida shikoyatlar keldi.'],
  ['uz (Cyrillic), limited', 'Ҳисобингиз чекланди. Спам ҳақида шикоятлар келди.'],
  ['kk, limited', 'Аккаунтыңыз шектелді. Спам туралы шағымдар келді.'],
  ['tr, limited', 'Hesabınız kısıtlandı. Spam şikayetleri aldık.'],
  ['zh, limited', '您的账户因违反服务条款已被限制。'],
];

/**
 * The safety review of the widened rule (U1). Logins first: every language's own «ignore this if you did not ask by
 * TRYING to log in» sentence — the gerund the rule must never read as a warning, in zh, zh-Hant, ar and kk exactly as
 * in en, ru and uz (main read all four as login; the first widening's whole-text list carried their «trying»).
 */
const LOGIN_REVIEWED: readonly (readonly [string, string])[] = [
  [
    'zh, the whole code text',
    '登录代码：52814。请勿将此代码告诉任何人，即使对方自称来自 Telegram！\n\n❗️此代码可用于登录您的 Telegram 账户。我们绝不会因其他用途向您索要此代码。\n\n' +
      '如果您没有在其他设备上尝试登录并请求此代码，请忽略此消息。',
  ],
  ['zh, «by trying» in another order', '登录代码：52814。请勿将此代码告诉任何人！\n\n如果您并未通过尝试在其他设备上登录来请求此代码，请忽略此消息。'],
  ['zh-Hant, the whole code text', '登入代碼：52814。請勿將此代碼告訴任何人！\n\n如果您沒有在其他裝置上嘗試登入並要求此代碼，請忽略此訊息。'],
  [
    'ar, the whole code text',
    'رمز تسجيل الدخول: 52814. لا تعطِ هذا الرمز لأي شخص، حتى لو قالوا إنهم من تيليجرام!\n\nإذا لم تطلب هذا الرمز بمحاولة تسجيل الدخول على جهاز آخر، فتجاهل هذه الرسالة.',
  ],
  ['kk, the whole code text', 'Кіру коды: 52814. Бұл кодты ешкімге бермеңіз!\n\nЕгер бұл кодты басқа құрылғыда кіруге тырысу арқылы сұрамаған болсаңыз, бұл хабарды елемеңіз.'],
  ['uk, the whole code text', 'Код для входу в Telegram: 52814. Нікому не повідомляйте цей код!\n\nЯкщо ви не запитували код, намагаючись увійти з іншого пристрою, просто проігноруйте це повідомлення.'],
  ['tr, the whole code text', 'Giriş kodu: 52814. Bu kodu kimseyle paylaşmayın!\n\nBu kodu başka bir cihazda giriş yapmaya çalışarak istemediyseniz, bu mesajı yok sayın.'],
  [
    'fa, the whole code text',
    'کد ورود: 52814. این کد را به هیچ‌کس ندهید، حتی اگر بگویند از طرف تلگرام هستند!\n\nاگر این کد را با تلاش برای ورود در دستگاه دیگری درخواست نکرده‌اید، این پیام را نادیده بگیرید.',
  ],
];

/**
 * …then warnings it read as login. An alert whose TITLE qualifies the login — an attempt, refused, blocked, not
 * confirmed — carries the same «Device:» and «Location:» fields as his own sign-in's and is another message; and a
 * code beside a deletion request, a compromised account or a refusal is not his sign-in either.
 */
const WARNING_REVIEWED: readonly (readonly [string, string])[] = [
  ['ru, a new login not confirmed', 'Новый вход не подтверждён. Aziz, кто-то ввёл правильный код для входа в Ваш аккаунт, но не ввёл пароль двухэтапной проверки.\n\nУстройство: Telegram Web\nМестоположение: Лагос, Нигерия'],
  ['ru, a new login denied', 'Новый вход запрещён. Мы не пустили в Ваш аккаунт новое устройство.\n\nУстройство: Telegram Web\nМестоположение: Лагос, Нигерия'],
  ['uz, a new login attempt', 'Yangi kirish urinishi. Hurmatli Aziz, 19/11/2026 kuni kimdir hisobingizga yangi qurilmadan kirmoqchi bo‘ldi.\n\nQurilma: Telegram Web\nJoylashuv: Lagos, Nigeriya'],
  ['uz, an attempt to log in', 'Yangi kirishga urinish. Hisobingizga yangi qurilmadan kirishga harakat qilindi.\n\nQurilma: Telegram Web\nJoylashuv: Lagos, Nigeriya'],
  ['uz, a login not finished', 'Yangi kirish yakunlanmadi. Kimdir to‘g‘ri kodni kiritdi, lekin ikki bosqichli tasdiqlash parolini kiritmadi.\n\nQurilma: Telegram Web\nJoylashuv: Lagos, Nigeriya'],
  ['uz, a login forbidden', 'Yangi kirish taqiqlandi.\n\nQurilma: Telegram Web\nJoylashuv: Lagos, Nigeriya'],
  ['uz (Cyrillic), a new login attempt', 'Янги кириш уриниши. Ҳурматли Aziz, кимдир ҳисобингизга янги қурилмадан кирмоқчи бўлди.\n\nҚурилма: Telegram Web\nЖойлашув: Лагос, Нигерия'],
  ['uz (Cyrillic), an attempt to log in', 'Янги киришга уриниш. Ҳисобингизга янги қурилмадан киришга ҳаракат қилинди.\n\nҚурилма: Telegram Web\nЖойлашув: Лагос, Нигерия'],
  ['fa, a new login attempt', 'تلاش ورود جدید. کسی تلاش کرد از یک دستگاه جدید وارد حساب شما شود.\n\nدستگاه: Telegram Web\nمکان: لاگوس، نیجریه'],
  ['fa, a new login failed', 'ورود جدید ناموفق. کسی کد درست را وارد کرد اما رمز تأیید دو مرحله‌ای را نداشت.\n\nدستگاه: Telegram Web\nمکان: لاگوس، نیجریه'],
  ['zh, a new login attempt', '新登录尝试。有人试图从新设备登录您的账户。\n\n设备：Telegram Web\n位置：尼日利亚 拉各斯'],
  ['zh, a new login blocked', '新登录已被阻止。有人输入了正确的登录代码，但没有输入两步验证密码。\n\n设备：Telegram Web\n位置：尼日利亚 拉各斯'],
  ['tr, a new login attempt', 'Yeni giriş denemesi. Birisi hesabınıza yeni bir cihazdan giriş yapmaya çalıştı.\n\nCihaz: Telegram Web\nKonum: Lagos, Nijerya'],
  ['kk, a new login attempt', 'Жаңа кіру әрекеті. Біреу аккаунтыңызға жаңа құрылғыдан кірмек болды.\n\nҚұрылғы: Telegram Web\nОрналасқан жері: Лагос, Нигерия'],
  ['de, a new login blocked', 'Neue Anmeldung blockiert. Jemand hat versucht, sich mit einem neuen Gerät anzumelden.\n\nGerät: Telegram Web\nStandort: Lagos, Nigeria'],
  ['en, a new login prevented', 'New login prevented.\n\nDevice: Telegram Web\nLocation: Lagos, Nigeria\n\nSomeone entered your login code but the session was not confirmed from your other devices.'],
  ['en, a new login denied', 'New login denied.\n\nDevice: Telegram Web\nLocation: Lagos, Nigeria'],
  ['en, a new login left unconfirmed', 'New login. Someone entered the correct login code on a new device, but the session is unconfirmed and cannot read your chats.\n\nDevice: Telegram Web\nLocation: Lagos, Nigeria'],
  ['en, a code beside a compromised account', 'Warning! Your account may be compromised.\nLogin code: 52814. Change your two-step verification password now.'],
  ['ru, a code beside a compromised account', 'Внимание! Ваш аккаунт мог быть скомпрометирован.\nКод для входа: 52814.'],
  ['uz, a deletion request’s code', 'Hisobingizni o‘chirish so‘rovi.\nTasdiqlash kodi: 52814. Agar bu siz bo‘lmasangiz, bu kodni hech kimga bermang.'],
  ['uz (Cyrillic), a deletion request’s code', 'Ҳисобингизни ўчириш сўрови.\nТасдиқлаш коди: 52814.'],
  ['zh, a deletion request’s code', '注销账户请求。\n验证码：52814。'],
  ['tr, a deletion request’s code', 'Hesap silme talebi.\nOnay kodu: 52814.'],
  ['en, a code beside a refused login', 'Login code: 52814. ⚠️ This code was shared with another user, so the login was refused. Never send your login code to anyone.'],
];

describe('a line from 777000: his login, or a warning about the account', () => {
  it('holds at least the shapes it was asked to', () => {
    expect(LOGIN.length).toBeGreaterThanOrEqual(25);
    expect(WARNING.length).toBeGreaterThanOrEqual(15);
  });

  it.each(LOGIN)('login — %s', (_label, text) => {
    expect(telegramNoticeKind(text)).toBe('login');
  });

  it.each(WARNING)('notice — %s', (_label, text) => {
    expect(telegramNoticeKind(text)).toBe('notice');
  });

  it.each(LOGIN_REVIEWED)('login (review) — %s', (_label, text) => {
    expect(telegramNoticeKind(text)).toBe('login');
  });

  it.each(WARNING_REVIEWED)('notice (review) — %s', (_label, text) => {
    expect(telegramNoticeKind(text)).toBe('notice');
  });

  // Persian and Arabic-Indic digits are no code (the final check's R5): read as digits, a Persian or Arabic warning's
  // own tracking or request number beside a code word made it his login — and no warning word the list holds said
  // «deactivated» in those languages — so the AI talked through it. His login code in those digits is a notice too:
  // a morning's queue, the direction a guess must take.
  it('a number in Persian or Arabic-Indic digits is no code — a warning beside it stays a notice', () => {
    for (const text of [
      'حساب شما غیرفعال شد.\nکد پیگیری: ۵۲۸۱۴۰',
      'تم تعطيل حسابك.\nرمز الطلب: ٥٢٨١٤٠',
      'کد ورود: ۵۲۸۱۴. این کد را به هیچ‌کس ندهید!',
      'رمز تسجيل الدخول: ٥٢٨١٤. لا تعطِ هذا الرمز لأي شخص!',
    ]) {
      expect(telegramNoticeKind(text), text).toBe('notice');
    }
  });

  it('the code must stand in the first two lines — a number further down is a ticket, not his sign-in', () => {
    expect(telegramNoticeKind('Telegram\n\nImportant notice about your account.\n\nLogin code: 52814')).toBe('notice');
  });

  it('a number of the wrong size, or glued to letters, is no code', () => {
    for (const text of ['Login code: 1234.', 'Login code: 1234567.', 'Login code: GS52814.', 'Login code: 52814GS.', 'Login code: 1.52814']) {
      expect(telegramNoticeKind(text), text).toBe('notice');
    }
  });

  it('a code-shaped number with no code word beside it is no code — a request number, an order', () => {
    for (const text of ['Your request 52814 has been received. We will reply within 24 hours.', 'Telegram Premium: order 528140 confirmed.']) {
      expect(telegramNoticeKind(text), text).toBe('notice');
    }
  });

  it('a phone number beside the word «code» is no code', () => {
    expect(telegramNoticeKind('Your code was sent to +998 90 123 45 67.')).toBe('notice');
  });

  it('the new-login header alone, with no device or location field, is a notice', () => {
    expect(telegramNoticeKind('New login. Dear Aziz, we detected a login into your account.')).toBe('notice');
  });

  it('a device field with no new-login header is a notice', () => {
    expect(telegramNoticeKind('Your session was terminated.\n\nDevice: Telegram Desktop\nLocation: Tashkent, Uzbekistan')).toBe('notice');
  });
});
