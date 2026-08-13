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

  /*
   * --- the journey, in the owner's own words (round 98) ---
   *
   * These REPLACED a set of raw box statuses («skladda», «jo'natishga
   * tayyorlandi») which is warehouse vocabulary answering a question no
   * customer asked. He wrote the ladder out himself — «htoyda qabul → htoy
   * sklatdan yolga chiqdi → htoy qirgiz chegara sklatda → sklatdan yuklandi
   * eksport bolti → transitda → ozbga kirdi → rastamojka → olib
   * ketishingizga tayyor → olib ketdingiz» — and this is that list.
   *
   * The keys come from `wms/client-cabinet/stages.ts`; a test outside the
   * bundles anchors them, since `platform` may not import `wms` (#163).
   *
   * Note `stgHub` names no city. The rung is derived from a warehouse of type
   * `hub`, so the wording has to be true of the second one he opens.
   */
  stgCn_warehouse: {
    uz: 'Xitoydagi omborimizda qabul qilindi',
    ru: 'Принят на наш склад в Китае',
    en: 'Received at our warehouse in China',
  },
  stgCn_loading: {
    uz: 'Xitoyda mashinaga yuklanmoqda',
    ru: 'Грузится в машину в Китае',
    en: 'Being loaded in China',
  },
  stgCn_transit: { uz: 'Xitoy ichida yo‘lda 🚛', ru: 'В пути по Китаю 🚛', en: 'In transit inside China 🚛' },
  stgHub: {
    uz: 'Chegara oldidagi omborimizda',
    ru: 'На нашем складе у границы',
    en: 'At our warehouse near the border',
  },
  stgHub_loading: {
    uz: 'Eksportga yuklanmoqda',
    ru: 'Грузится на экспорт',
    en: 'Being loaded for export',
  },
  stgExport_transit: { uz: 'Yo‘lda 🚛', ru: 'В пути 🚛', en: 'In transit 🚛' },
  stgIn_uz: {
    uz: 'O‘zbekistonga kirdi — rasmiylashtirilmoqda',
    ru: 'Прибыл в Узбекистан — оформление',
    en: 'Arrived in Uzbekistan — customs clearance',
  },
  stgCustoms_done: {
    uz: 'Rastamojka tugadi',
    ru: 'Растаможен',
    en: 'Customs cleared',
  },
  stgReady: {
    uz: 'Olib ketishga tayyor ✅',
    ru: 'Готов к выдаче ✅',
    en: 'Ready for pickup ✅',
  },
  stgIssued: { uz: 'Olib ketildi 🤝', ru: 'Выдан 🤝', en: 'Handed over 🤝' },

  /** Always beside a date, never without it — the schedule is an estimate. */
  etaAbout: { uz: 'taxminan', ru: 'примерно', en: 'about' },
  journey: { uz: 'Yukingiz yo‘li', ru: 'Путь вашего груза', en: 'Your cargo’s journey' },

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
  /** The self-service door (item 13): no link needed if the number matches. */
  linkByPhone: {
    uz: 'Yoki pastdagi tugma bilan raqamingizni yuboring — kod kerak emas: raqamingiz bizda bo‘lsa, kabinet o‘zi ulanadi.',
    ru: 'Или отправьте свой номер кнопкой ниже — код не нужен: если номер есть у нас, кабинет подключится сам.',
    en: 'Or share your number with the button below — no code needed: if we have your number, the cabinet connects by itself.',
  },
  /**
   * The advert door's one answer (round 82). It says the same thing whether a
   * lead was created, joined onto an open one, or dropped at the cap — a
   * public surface that answers differently for a number it recognises is a
   * way to walk a list and learn who our customers are.
   */
  adThanks: {
    uz: 'Rahmat! Arizangiz qabul qilindi — menejerimiz tez orada qo‘ng‘iroq qiladi.',
    ru: 'Спасибо! Заявка принята — наш менеджер скоро вам позвонит.',
    en: 'Thank you! We have your enquiry — a manager will call you shortly.',
  },
  phoneNotFound: {
    uz: 'Bu raqam bazamizda topilmadi. Menejeringizga murojaat qiling — raqamingizni kartangizga qo‘shib, sizni ulab qo‘yadi.',
    ru: 'Этот номер у нас не найден. Обратитесь к вашему менеджеру — он добавит номер в вашу карточку и подключит вас.',
    en: 'We could not find this number. Please contact your manager — they will add it to your card and connect you.',
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

  // --- cargo landed in Uzbekistan (round 98) ---
  //
  // The Uzbek-side arrival used to be ONE hardcoded Uzbek sentence carrying a
  // box count and nothing else — no kilos, no cubic metres, no goods, and no
  // translation, so a Russian-reading customer got Uzbek. It says what the
  // Chinese-side arrival says, in the customer's own language, because it is
  // the same question asked at the other end of the road.
  readyTitle: {
    uz: '🇺🇿 Yukingiz yetib keldi',
    ru: '🇺🇿 Ваш груз прибыл',
    en: '🇺🇿 Your cargo has arrived',
  },
  readyNote: {
    uz: 'Rasmiylashtiruv tugagach olib ketish vaqtini kelishamiz.',
    ru: 'Согласуем выдачу после оформления.',
    en: 'We will agree a pickup time once the paperwork is done.',
  },
  issuedTitle: {
    uz: '🤝 Yukingiz berildi',
    ru: '🤝 Груз выдан',
    en: '🤝 Your cargo has been handed over',
  },
  issuedTo: { uz: 'Oluvchi', ru: 'Получатель', en: 'Received by' },
  issuedLeft: { uz: 'Omborda qoldi', ru: 'Осталось на складе', en: 'Left in stock' },

  // --- the Mini App ---
  appTitle: { uz: 'Mening yuklarim', ru: 'Мои грузы', en: 'My cargo' },
  /**
   * The big button, as opposed to `appTitle` in the corner.
   *
   * The owner asked for the app to be reachable from something that reads as
   * the main action rather than an icon nobody notices, so this wording is a
   * verb — it says what happens when you press it.
   */
  openApp: {
    uz: '📱 Yuklarimni ochish',
    ru: '📱 Открыть мои грузы',
    en: '📱 Open my cargo',
  },
  openAppPrompt: {
    uz: 'Yuklaringiz, rasmlari va balansingiz — bitta oynada 👇',
    ru: 'Ваши грузы, фотографии и баланс — в одном окне 👇',
    en: 'Your cargo, photos and balance — all in one place 👇',
  },
  perBox: { uz: 'har quti', ru: 'за коробку', en: 'per box' },
  close: { uz: 'Yopish', ru: 'Закрыть', en: 'Close' },
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

/** The rung's sentence, in the client's language. */
export function stageLabel(stage: string, labels: ClientLabels): string {
  const key = `stg${stage.charAt(0).toUpperCase()}${stage.slice(1)}` as keyof ClientLabels;
  return (labels[key] as string | undefined) ?? stage;
}

/**
 * «14.08 – 16.08» — the estimated arrival, as two dates and never one.
 *
 * The schedule itself is a range, and printing its midpoint turns an estimate
 * into a promise the office then has to explain. Same day at both ends prints
 * once.
 *
 * NUMERIC on purpose, and this was found by looking rather than by a test:
 * `Intl` with a month NAME renders Uzbek as «M08 14» — Chromium ships no
 * Uzbek month names and falls back to a machine format — which is the main
 * language this app's customers read. dd.MM needs no locale data at all, is
 * the same in all three languages, and is the house convention every printed
 * document here already uses.
 *
 * The zone is Tashkent, so a truck landing at 02:00 local is not announced for
 * the day before.
 */
export function formatEtaRange(fromIso: string, toIso: string, _locale?: string | null): string {
  const day = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'Asia/Tashkent',
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}.${get('month')}`;
  };
  const from = day(fromIso);
  const to = day(toIso);
  return from === to ? from : `${from} – ${to}`;
}
