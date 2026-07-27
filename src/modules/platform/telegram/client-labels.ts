import { DEFAULT_LOCALE, type Locale } from '../i18n/locales';

/**
 * What the CLIENT reads.
 *
 * Separate from the staff wording (`notifications/labels.ts`) because the two
 * audiences are different people with different languages: a Yiwu operator's
 * app may be Chinese while the client waiting for that cargo reads Uzbek.
 * Same shape and same reason, though — a bot handler and a pg-boss worker
 * have no request to resolve a locale from, so next-intl cannot serve them
 * (and worse, `i18n/request.ts` ignores an explicit locale override, so
 * asking it from a worker would silently return Russian).
 *
 * `satisfies` makes a missing translation a COMPILE error, which four JSON
 * bundles cannot do — the failure mode DECISIONS #163 was written about.
 *
 * Clients get three languages, not the staff four: nobody's customer here
 * reads the app in Chinese. `zh-CN` maps to Russian rather than being absent,
 * so a client whose Telegram is Chinese still gets a sentence.
 */
export const CLIENT_LOCALES = ['uz', 'ru', 'en'] as const;
export type ClientLocale = (typeof CLIENT_LOCALES)[number];

const DICT = {
  // --- the three cabinet buttons ---
  btnCargo: { uz: '📦 Yuklarim', ru: '📦 Мои грузы', en: '📦 My cargo' },
  btnBalance: { uz: '💰 Balans', ru: '💰 Баланс', en: '💰 Balance' },
  btnHistory: { uz: '🗄 Tarix', ru: '🗄 История', en: '🗄 History' },
  btnLanguage: { uz: '🌐 Til', ru: '🌐 Язык', en: '🌐 Language' },

  // --- box statuses, as a client should understand them ---
  stIn_stock: { uz: 'skladda', ru: 'на складе', en: 'at the warehouse' },
  stPlanned: { uz: 'jo‘natishga tayyorlandi', ru: 'готов к отправке', en: 'ready to ship' },
  stLoading: { uz: 'mashinaga yuklanmoqda', ru: 'грузится в машину', en: 'being loaded' },
  stIn_transit: { uz: 'yo‘lda 🚛', ru: 'в пути 🚛', en: 'in transit 🚛' },
  stReady_for_pickup: {
    uz: 'olib ketishga tayyor ✅',
    ru: 'готов к выдаче ✅',
    en: 'ready for pickup ✅',
  },

  pieces: { uz: 'dona', ru: 'шт', en: 'pcs' },
  kg: { uz: 'kg', ru: 'кг', en: 'kg' },
  m3: { uz: 'm³', ru: 'м³', en: 'm³' },

  // --- linking ---
  askPhone: {
    uz: 'Assalomu alaykum! Xavfsizlik uchun telefon raqamingizni tasdiqlang — pastdagi tugmani bosing.',
    ru: 'Здравствуйте! Для безопасности подтвердите свой номер телефона — нажмите кнопку ниже.',
    en: 'Hello! For security, confirm your phone number — tap the button below.',
  },
  sharePhone: {
    uz: '📱 Telefon raqamimni yuborish',
    ru: '📱 Отправить мой номер',
    en: '📱 Share my phone number',
  },
  phoneMismatch: {
    uz: '❌ Telefon raqamingiz bu havolaga mos kelmadi. Havola bekor qilindi — menejeringizga murojaat qiling.',
    ru: '❌ Ваш номер не совпал с этой ссылкой. Ссылка аннулирована — обратитесь к вашему менеджеру.',
    en: '❌ Your number did not match this link. The link has been cancelled — please contact your manager.',
  },
  linkExpired: {
    uz: 'Havola eskirgan. Menejeringizdan yangisini so‘rang.',
    ru: 'Ссылка устарела. Попросите у менеджера новую.',
    en: 'This link has expired. Ask your manager for a new one.',
  },
  linkUnverifiable: {
    uz: 'Bu havolani tasdiqlab bo‘lmadi — menejeringizga murojaat qiling.',
    ru: 'Эту ссылку не удалось подтвердить — обратитесь к вашему менеджеру.',
    en: 'This link could not be confirmed — please contact your manager.',
  },
  welcome: {
    uz: 'Bu yerda yuklaringiz holati, rasmlari va balansingizni ko‘rasiz.',
    ru: 'Здесь вы видите статус ваших грузов, фотографии и баланс.',
    en: 'Here you can see your cargo status, photos and balance.',
  },
  yourCodes: { uz: 'Ulangan kodlaringiz', ru: 'Ваши коды', en: 'Your codes' },
  codeAdded: {
    uz: '🔗 Kabinetingizga yangi kod qo‘shildi',
    ru: '🔗 В ваш кабинет добавлен новый код',
    en: '🔗 A new code has been added to your cabinet',
  },
  /**
   * Shown when somebody opens the bot with no link code at all. It used to be
   * a RUSSIAN staff sentence about the profile screen — a message for
   * employees, shown to customers, in a language the cabinet does not even
   * use.
   */
  notLinked: {
    uz: 'GSR LOGISTICS. Kabinetga ulanish uchun menejeringizdan havola so‘rang.',
    ru: 'GSR LOGISTICS. Чтобы подключить кабинет, попросите ссылку у вашего менеджера.',
    en: 'GSR LOGISTICS. To connect your cabinet, ask your manager for a link.',
  },

  // --- the three screens ---
  noCargo: {
    uz: 'hozir yo‘lda yoki skladda yukingiz yo‘q.',
    ru: 'сейчас в пути или на складе грузов нет.',
    en: 'you have no cargo in transit or at a warehouse right now.',
  },
  noHistory: {
    uz: 'hali berilgan yuklar yo‘q.',
    ru: 'выданных грузов пока нет.',
    en: 'no cargo has been handed over yet.',
  },
  issued: { uz: 'berilgan yuklar', ru: 'выданные грузы', en: 'cargo handed over' },
  debtYes: { uz: 'qarzingiz', ru: 'ваш долг', en: 'you owe' },
  debtNo: { uz: 'qarzingiz yo‘q', ru: 'долга нет', en: 'nothing owing' },
  credit: { uz: 'hisobingizda ortiqcha', ru: 'на счету переплата', en: 'in credit' },
  recentMoves: { uz: 'So‘nggi amallar', ru: 'Последние операции', en: 'Recent entries' },
  charged: { uz: '🧾 hisoblandi', ru: '🧾 начислено', en: '🧾 charged' },
  paid: { uz: '➕ to‘lov', ru: '➕ оплата', en: '➕ payment' },
  noPhotos: { uz: 'Bu yuk uchun rasm topilmadi.', ru: 'Фото для этого груза нет.', en: 'No photos for this cargo.' },
  photoError: {
    uz: 'Rasm yuborishda xatolik. Birozdan so‘ng qayta urinib ko‘ring.',
    ru: 'Ошибка при отправке фото. Попробуйте чуть позже.',
    en: 'Could not send the photos. Please try again shortly.',
  },

  // --- cargo arrived at the Chinese warehouse (the owner's first ask) ---
  arrivedTitle: {
    uz: '📥 Yukingiz omborimizga qabul qilindi',
    ru: '📥 Ваш груз принят на наш склад',
    en: '📥 Your cargo has arrived at our warehouse',
  },
  arrivedWarehouse: { uz: 'Ombor', ru: 'Склад', en: 'Warehouse' },
  arrivedTotal: { uz: 'Jami', ru: 'Итого', en: 'Total' },
  seeDetails: {
    uz: 'Batafsil: 📦 Yuklarim',
    ru: 'Подробнее: 📦 Мои грузы',
    en: 'Details: 📦 My cargo',
  },

  // --- the Mini App ---
  appTitle: { uz: 'Mening yuklarim', ru: 'Мои грузы', en: 'My cargo' },
  totalBoxes: { uz: 'quti', ru: 'коробок', en: 'boxes' },
  photos: { uz: 'rasm', ru: 'фото', en: 'photos' },
  loading: { uz: 'Yuklanmoqda…', ru: 'Загрузка…', en: 'Loading…' },
  openInTelegram: {
    uz: 'Bu sahifa Telegram ilovasi ichida ochiladi.',
    ru: 'Эта страница открывается внутри Telegram.',
    en: 'This page opens inside Telegram.',
  },
  notLinkedApp: {
    uz: 'Bu chat hech qanday mijoz kodiga ulanmagan. Menejeringizdan havola so‘rang.',
    ru: 'Этот чат не подключён ни к одному коду клиента. Попросите ссылку у менеджера.',
    en: 'This chat is not linked to any client code. Ask your manager for a link.',
  },
  loadError: {
    uz: 'Ma’lumot yuklanmadi. Qayta urinib ko‘ring.',
    ru: 'Не удалось загрузить данные. Попробуйте ещё раз.',
    en: 'Could not load your data. Please try again.',
  },
  retry: { uz: 'Qayta urinish', ru: 'Повторить', en: 'Try again' },
  nothingHere: { uz: 'Bo‘sh', ru: 'Пусто', en: 'Nothing here' },

  // --- language switch ---
  chooseLanguage: { uz: 'Tilni tanlang:', ru: 'Выберите язык:', en: 'Choose a language:' },
  languageSet: { uz: '✅ Til o‘zgartirildi', ru: '✅ Язык изменён', en: '✅ Language changed' },
} satisfies Record<string, Record<ClientLocale, string>>;

export type ClientLabels = { [K in keyof typeof DICT]: string };

/** Is this a language the cabinet speaks? */
export function isClientLocale(value: unknown): value is ClientLocale {
  return typeof value === 'string' && (CLIENT_LOCALES as readonly string[]).includes(value);
}

/**
 * Telegram's `language_code` is an IETF tag — `ru`, `en-GB`, `uz-Latn`. Take
 * the primary subtag and keep it only if the cabinet speaks it. Used to SEED
 * a client's language the first time, never to override a choice they made.
 */
export function localeFromTelegram(languageCode?: string | null): ClientLocale | null {
  const primary = (languageCode ?? '').split('-')[0]?.toLowerCase();
  return isClientLocale(primary) ? primary : null;
}

/** Wording in the client's own language; anything unknown falls back. */
export function clientLabels(locale?: string | null): ClientLabels {
  const key = isClientLocale(locale) ? locale : fallback(locale);
  return Object.fromEntries(
    Object.entries(DICT).map(([name, values]) => [name, values[key]]),
  ) as ClientLabels;
}

function fallback(locale?: string | null): ClientLocale {
  // A client whose Telegram is Chinese still gets a sentence, in the language
  // the office actually writes to customers in.
  if (locale === 'zh-CN') return 'ru';
  return (DEFAULT_LOCALE as Locale) === 'ru' ? 'ru' : 'uz';
}

/**
 * Every translation of the three menu buttons, in every language.
 *
 * The button labels ARE the bot's router (`bot.hears(BTN_CARGO)`), so the
 * moment they became translatable the matcher had to widen with them — a
 * client who switches to Russian taps «📦 Мои грузы» and the handler listening
 * for «📦 Yuklarim» never fires, leaving a cabinet whose buttons do nothing.
 * No test would have caught it: nothing in the suite asserts a cabinet string.
 *
 * Deriving the matcher from the same dictionary means adding a language
 * cannot forget to add its buttons.
 */
export function allLabelVariants(key: 'btnCargo' | 'btnBalance' | 'btnHistory' | 'btnLanguage'): string[] {
  return CLIENT_LOCALES.map((locale) => DICT[key][locale]);
}

/** Status word for a box state, in the client's language. */
export function statusLabel(status: string, labels: ClientLabels): string {
  const key = `st${status.charAt(0).toUpperCase()}${status.slice(1)}` as keyof ClientLabels;
  return (labels[key] as string | undefined) ?? status;
}
