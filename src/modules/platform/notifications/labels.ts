import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n/locales';

/**
 * Staff Telegram message wording.
 *
 * Sent per RECIPIENT, so it follows each person's own `users.locale` — the
 * same language they see the app in. That is why these live here rather than
 * in next-intl messages: the sender is a background worker with no request to
 * resolve a locale from, and it renders the same event once per reader.
 *
 * The client-facing drafts inside ReadyForPickup are NOT translated — they are
 * text the manager copies and forwards to the client, and the client's
 * language has nothing to do with the manager's.
 */
const DICT = {
  boxesShort: { ru: 'кор.', uz: 'kor.', 'zh-CN': '箱', en: 'boxes' },
  kg: { ru: 'кг', uz: 'kg', 'zh-CN': '公斤', en: 'kg' },
  m3: { ru: 'м³', uz: 'm³', 'zh-CN': '立方米', en: 'm³' },
  warehouse: { ru: 'Склад', uz: 'Sklad', 'zh-CN': '仓库', en: 'Warehouse' },
  client: { ru: 'Клиент', uz: 'Mijoz', 'zh-CN': '客户', en: 'Client' },
  boxesLine: { ru: 'Коробки', uz: 'Karobkalar', 'zh-CN': '箱号', en: 'Boxes' },
  reason: { ru: 'Причина', uz: 'Sabab', 'zh-CN': '原因', en: 'Reason' },
  marking: { ru: 'Маркировка', uz: 'Markirovka', 'zh-CN': '标记', en: 'Marking' },
  comment: { ru: 'Комментарий', uz: 'Izoh', 'zh-CN': '备注', en: 'Comment' },

  receiptConfirmed: { ru: 'Приёмка', uz: 'Prixod', 'zh-CN': '入库', en: 'Receipt' },
  unknownCargo: {
    ru: 'Неопознанный груз',
    uz: 'Egasiz yuk',
    'zh-CN': '无主货物',
    en: 'Unidentified cargo',
  },
  planApproved: {
    ru: 'План одобрен агентом — партия',
    uz: 'Reja agent tomonidan tasdiqlandi — partiya',
    'zh-CN': '代理已批准计划 — 批次',
    en: 'The agent approved the plan — batch',
  },
  planChanges: {
    ru: 'Агент просит изменить план',
    uz: 'Agent rejani o‘zgartirishni so‘rayapti',
    'zh-CN': '代理要求修改计划',
    en: 'The agent asks for changes to the plan',
  },
  offPlanLoaded: {
    ru: 'Груз вне плана погружен в',
    uz: 'Rejadan tashqari yuk yuklandi:',
    'zh-CN': '计划外货物已装车：',
    en: 'Off-plan cargo loaded into',
  },
  undocumented: {
    ru: 'Недокументированный груз выгружен из',
    uz: 'Hujjatsiz yuk tushirildi:',
    'zh-CN': '无单据货物已卸车：',
    en: 'Undocumented cargo unloaded from',
  },
  missingInTransit: {
    ru: 'Не выгружены (потеряны в пути?) из',
    uz: 'Tushirilmadi (yo‘lda yo‘qolganmi?):',
    'zh-CN': '未卸货（途中丢失？）：',
    en: 'Not unloaded (lost in transit?) from',
  },
  inventoryAt: {
    ru: 'Инвентаризация на складе',
    uz: 'Inventarizatsiya, sklad',
    'zh-CN': '盘点，仓库',
    en: 'Stocktake at warehouse',
  },
  scanned: { ru: 'Отсканировано', uz: 'Skanlandi', 'zh-CN': '已扫描', en: 'Scanned' },
  movedHere: {
    ru: 'Перемещено сюда (нашлись тут)',
    uz: 'Shu yerga o‘tkazildi (shu yerdan topildi)',
    'zh-CN': '已移入本仓库（在此找到）',
    en: 'Moved here (found here)',
  },
  markedLost: {
    ru: 'Помечены потерянными',
    uz: 'Yo‘qolgan deb belgilandi',
    'zh-CN': '已标记为丢失',
    en: 'Marked as lost',
  },
  noDiscrepancies: {
    ru: 'Расхождений нет',
    uz: 'Farq yo‘q',
    'zh-CN': '无差异',
    en: 'No discrepancies',
  },
  cargoArrived: {
    ru: 'Груз клиента',
    uz: 'Mijoz yuki',
    'zh-CN': '客户货物',
    en: "Client's cargo",
  },
  arrivedWord: { ru: 'прибыл', uz: 'yetib keldi', 'zh-CN': '已到达', en: 'has arrived' },
  batchWord: { ru: 'партия', uz: 'partiya', 'zh-CN': '批次', en: 'batch' },
  issuedTo: {
    ru: 'Выдано клиенту',
    uz: 'Mijozga berildi',
    'zh-CN': '已交付客户',
    en: 'Handed over to client',
  },
  receivedBy: { ru: 'Получил', uz: 'Oldi', 'zh-CN': '领取人', en: 'Received by' },
  // Phase 6: the debtor-issue approval chain.
  debtApprovalRequested: {
    ru: 'Запрос: выдать груз должнику',
    uz: 'So‘rov: qarzdorga yuk berish',
    'zh-CN': '请求：向欠款客户放货',
    en: 'Request: issue cargo to a debtor',
  },
  debtLine: { ru: 'Долг', uz: 'Qarz', 'zh-CN': '欠款', en: 'Debt' },
  requestedByWord: { ru: 'Просит', uz: 'So‘ramoqda', 'zh-CN': '请求人', en: 'Requested by' },
  debtApprovalYes: {
    ru: 'Выдача должнику РАЗРЕШЕНА',
    uz: 'Qarzdorga berishga RUXSAT berildi',
    'zh-CN': '已批准向欠款客户放货',
    en: 'Issuing to the debtor was APPROVED',
  },
  debtApprovalNo: {
    ru: 'Выдача должнику ОТКЛОНЕНА',
    uz: 'Qarzdorga berish RAD etildi',
    'zh-CN': '已拒绝向欠款客户放货',
    en: 'Issuing to the debtor was REFUSED',
  },
  decidedByWord: { ru: 'Решил(а)', uz: 'Qaror qildi', 'zh-CN': '决定人', en: 'Decided by' },
  leftInStock: {
    ru: 'Осталось на складе',
    uz: 'Skladda qoldi',
    'zh-CN': '仓库剩余',
    en: 'Left in the warehouse',
  },
  forTheClient: { ru: 'Клиенту', uz: 'Mijozga', 'zh-CN': '给客户', en: 'For the client' },
  restoreFailed: {
    ru: 'Тест восстановления бэкапа НЕ ПРОШЁЛ!',
    uz: 'Zaxiradan tiklash testi O‘TMADI!',
    'zh-CN': '备份恢复测试未通过！',
    en: 'The backup restore test FAILED!',
  },
  backupFailed: {
    ru: 'НОЧНОЙ БЭКАП НЕ СДЕЛАН!',
    uz: 'KECHASI ZAXIRA OLINMADI!',
    'zh-CN': '夜间备份未完成！',
    en: 'THE NIGHTLY BACKUP DID NOT HAPPEN!',
  },
  backupCheck: {
    ru: 'База сегодня НЕ сохранена. Разберитесь сейчас, а не завтра.',
    uz: 'Baza bugun saqlanmadi. Ertaga emas, hozir tekshiring.',
    'zh-CN': '数据库今天没有备份。请立即处理，不要拖到明天。',
    en: 'The database was NOT saved today. Deal with it now, not tomorrow.',
  },
  restoreCheck: {
    ru: 'Проверьте бэкапы на сервере (BACKUP_DIR).',
    uz: 'Serverdagi zaxiralarni tekshiring (BACKUP_DIR).',
    'zh-CN': '请检查服务器上的备份（BACKUP_DIR）。',
    en: 'Check the backups on the server (BACKUP_DIR).',
  },

  // Rasxod xabari (round 107)
  expenseRequested: {
    ru: 'Расход со склада — нужно провести',
    uz: 'Skladdan rasxod xabari — kiritish kerak',
    'zh-CN': '仓库支出报告——需要入账',
    en: 'Warehouse expense reported — needs entering',
  },
  expenseEntered: {
    ru: 'Ваш расход проведён',
    uz: 'Rasxodingiz kiritildi',
    'zh-CN': '您的支出已入账',
    en: 'Your expense was entered',
  },
  expenseRejected: {
    ru: 'Ваш расход отклонён',
    uz: 'Rasxodingiz rad etildi',
    'zh-CN': '您的支出被拒绝',
    en: 'Your expense was rejected',
  },

  // Price control (docs/DEALS.md)
  unquotedCargo: {
    ru: 'Груз без цены',
    uz: 'Narxi kelishilmagan yuk',
    'zh-CN': '未报价货物',
    en: 'Unpriced cargo',
  },
  setPrice: {
    ru: 'Назначьте цену, пока груз ещё в Китае.',
    uz: 'Yuk hali Xitoyda turganida narx qo‘ying.',
    'zh-CN': '货物仍在中国时请先定价。',
    en: 'Set a price while the cargo is still in China.',
  },
  // Round 107, item 3: the split of «no deal» into its two honest halves.
  unlinkedCargo: {
    ru: 'Груз не привязан к сделке',
    uz: 'Yuk bitimga biriktirilmagan',
    'zh-CN': '货物未关联交易',
    en: 'Cargo not linked to a deal',
  },
  attachDeal: {
    ru: 'Привяжите приход к сделке на карточке прихода.',
    uz: 'Prixodni bitimga biriktirib qo‘ying (prixod kartasida).',
    'zh-CN': '请在入库单卡片上将其关联到交易。',
    en: 'Attach the receipt to the deal on the receipt card.',
  },
  openDealsWord: {
    ru: 'Открытые сделки',
    uz: 'Ochiq bitimlar',
    'zh-CN': '进行中的交易',
    en: 'Open deals',
  },
  unlinkedMark: {
    ru: 'Не привязан к сделке — привяжите',
    uz: 'Bitimga biriktirilmagan — biriktirib qo‘ying',
    'zh-CN': '未关联交易——请关联',
    en: 'Not linked to a deal — attach it',
  },
  noDealMark: {
    ru: 'Сделки нет — назначьте цену',
    uz: 'Bitimi yo‘q — narxlatib qo‘ying',
    'zh-CN': '没有交易——请定价',
    en: 'No deal — set a price',
  },
  dealDeviation: {
    ru: 'Груз не совпал с расчётом',
    uz: 'Yuk hisob-kitobga to‘g‘ri kelmadi',
    'zh-CN': '货物与报价不符',
    en: 'The cargo differs from the quote',
  },
  quoted: { ru: 'Договорено', uz: 'Kelishilgan', 'zh-CN': '报价', en: 'Quoted' },
  actual: { ru: 'Фактически', uz: 'Haqiqatda', 'zh-CN': '实际', en: 'Actual' },
  suggested: {
    ru: 'Пересчёт по факту',
    uz: 'Fakt bo‘yicha qayta hisob',
    'zh-CN': '按实际重算',
    en: 'Recalculated on the actual figures',
  },
  deferralEnded: {
    ru: 'Отсрочка платежа закончилась',
    uz: 'To‘lov muddati tugadi',
    'zh-CN': '付款延期已结束',
    en: 'The payment deferral has ended',
  },
  allBoxesArrived: {
    ru: 'весь груз доехал',
    uz: 'yukning hammasi yetib keldi',
    'zh-CN': '货物已全部到达',
    en: 'every box has arrived',
  },
  datePassed: {
    ru: 'срок вышел',
    uz: 'muddat o‘tdi',
    'zh-CN': '期限已过',
    en: 'the date has passed',
  },
  deal: { ru: 'Сделка', uz: 'Bitim', 'zh-CN': '交易', en: 'Deal' },
} satisfies Record<string, Record<Locale, string>>;

export type NotificationLabels = { [K in keyof typeof DICT]: string };

/** Wording in the recipient's own language; unknown locales fall back. */
export function notificationLabels(locale?: string | null): NotificationLabels {
  const key = (LOCALES as readonly string[]).includes(locale ?? '')
    ? (locale as Locale)
    : DEFAULT_LOCALE;
  return Object.fromEntries(
    Object.entries(DICT).map(([name, values]) => [name, values[key]]),
  ) as NotificationLabels;
}
