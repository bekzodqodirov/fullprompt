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
  // 0104: the same approval chain asking about cargo with no price.
  unpricedApprovalRequested: {
    ru: 'Запрос: выдать груз без цены',
    uz: 'So‘rov: narxsiz yukni berish',
    'zh-CN': '请求：交付未定价货物',
    en: 'Request: hand over unpriced cargo',
  },
  issueApprovalRequested: {
    ru: 'Запрос: разрешение на выдачу (долг + груз без цены)',
    uz: 'So‘rov: yuk berishga ruxsat (qarz + narxsiz yuk)',
    'zh-CN': '请求：交付许可（欠款 + 未定价货物）',
    en: 'Request: permission to hand over (debt + unpriced cargo)',
  },
  unpricedLine: { ru: 'Без цены', uz: 'Narx qo‘yilmagan', 'zh-CN': '未定价', en: 'No price' },
  priceApprovalYes: {
    ru: 'Выдача груза без цены РАЗРЕШЕНА',
    uz: 'Narxsiz yukni berishga RUXSAT berildi',
    'zh-CN': '已批准交付未定价货物',
    en: 'Handing over unpriced cargo was APPROVED',
  },
  priceApprovalNo: {
    ru: 'Выдача груза без цены ОТКЛОНЕНА',
    uz: 'Narxsiz yukni berish RAD etildi',
    'zh-CN': '已拒绝交付未定价货物',
    en: 'Handing over unpriced cargo was REFUSED',
  },
  issueApprovalYes: {
    ru: 'Выдача РАЗРЕШЕНА',
    uz: 'Yuk berishga RUXSAT berildi',
    'zh-CN': '已批准交付',
    en: 'The handover was APPROVED',
  },
  issueApprovalNo: {
    ru: 'Выдача ОТКЛОНЕНА',
    uz: 'Yuk berish RAD etildi',
    'zh-CN': '已拒绝交付',
    en: 'The handover was REFUSED',
  },
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
  expenseRequestedStaff: {
    ru: 'Расход сотрудника — нужно провести',
    uz: 'Hodimdan rasxod xabari — kiritish kerak',
    'zh-CN': '员工支出报告——需要入账',
    en: 'Staff expense reported — needs entering',
  },
  expensePaidBySelf: {
    ru: 'из своих денег',
    uz: 'o‘z pulidan',
    'zh-CN': '自己垫付',
    en: 'out of own pocket',
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
  // The reroute round: a truck on the road now goes to another receiving
  // warehouse. Worded per READER (the new warehouse, the one it no longer
  // comes to, the logists), and never with an arrow between the two
  // warehouses — this app's «A → B» is origin → destination everywhere, and
  // «TAS1 → AND» read at AND as «a truck FROM Tashkent».
  rerouteComingToYou: {
    ru: 'теперь едет к вам',
    uz: 'endi sizga keladi',
    'zh-CN': '现改为发往贵仓',
    en: 'is now coming to you',
  },
  rerouteNotComing: {
    ru: 'к вам больше не едет',
    uz: 'endi sizga kelmaydi',
    'zh-CN': '不再发往贵仓',
    en: 'is no longer coming to you',
  },
  rerouteChanged: {
    ru: 'изменён склад назначения',
    uz: 'qabul skladi o‘zgartirildi',
    'zh-CN': '目的仓库已更改',
    en: 'destination warehouse changed',
  },
  rerouteNow: { ru: 'Теперь', uz: 'Endi', 'zh-CN': '现为', en: 'Now' },
  rerouteBefore: { ru: 'Было', uz: 'Avval', 'zh-CN': '原为', en: 'Was' },
  route: { ru: 'Маршрут', uz: 'Yo‘l', 'zh-CN': '路线', en: 'Route' },
  changedBy: { ru: 'Изменил', uz: 'O‘zgartirdi', 'zh-CN': '修改人', en: 'Changed by' },
  // Round C: a list of box codes is capped where a message would otherwise
  // run past Telegram's 4096 and be refused WHOLE — the tail is counted, not
  // dropped in silence. `{n}` is filled by `fillCount`.
  andMore: { ru: '… и ещё {n}', uz: '… yana {n} ta', 'zh-CN': '… 另有 {n} 个', en: '… and {n} more' },
  // Round C: the card link at the foot of a staff message becomes a BUTTON
  // (the drain moves it; the stored text keeps the link).
  openInApp: { ru: '↗️ Открыть', uz: '↗️ Ochish', 'zh-CN': '↗️ 打开', en: '↗️ Open' },
  // Round 2 of the staff threads (0129): a prixod's or a truck's question
  // reaches a Chinese warehouse, so its FRAME — the reply hint, the reply
  // button and the «📍» place line — follows the recipient's language
  // (`payload.textLocale`, `textLocaleOf`). The colleague's own text is never
  // translated. The uz values of the two reply words are round 1's literals
  // (internal-chat.ts, staff-bot.ts `THREAD_REPLY_BUTTON`) — a unit test pins
  // both, so a round-1 ping reads exactly as it did.
  threadReplyHint: {
    ru: '↩️ Чтобы ответить, сделайте reply на это сообщение',
    uz: '↩️ Javob uchun shu xabarga reply qiling',
    'zh-CN': '↩️ 回复（reply）此消息即可作答',
    en: '↩️ Reply to this message to answer',
  },
  threadReplyButton: { ru: '💬 Ответить', uz: '💬 Javob yozish', 'zh-CN': '💬 回复', en: '💬 Reply' },
  // The place line — ONE formatter (`cargoNowLine`, wms/crm/cargo-thread.ts)
  // over these words, read by the web panel AND the ping, so the two cannot
  // drift. `{code}` `{codes}` `{from}` `{to}` `{n}` are filled by `fillVars`;
  // the separator after `cargoNow` is part of the label (`:` / `：`), and
  // the count rides inside each template, where word order differs.
  cargoNow: { ru: '📍 Груз сейчас:', uz: '📍 Yuk hozir:', 'zh-CN': '📍 货物现在：', en: '📍 Cargo now:' },
  cargoShelf: { ru: '{code} — {n} кор.', uz: '{code} — {n} kor.', 'zh-CN': '{code} — {n} 箱', en: '{code} — {n} boxes' },
  cargoRoad: {
    ru: 'в пути {from} → {to} — {n} кор.',
    uz: 'yo‘lda {from} → {to} — {n} kor.',
    'zh-CN': '在途 {from} → {to} — {n} 箱',
    en: 'on the road {from} → {to} — {n} boxes',
  },
  cargoUnloading: {
    ru: 'разгружается на {to} — {n} кор.',
    uz: '{to} da tushirilmoqda — {n} kor.',
    'zh-CN': '正在 {to} 卸货 — {n} 箱',
    en: 'being unloaded at {to} — {n} boxes',
  },
  cargoMissing: {
    ru: 'не найдено на {to} ({from} → {to}) — {n} кор.',
    uz: '{to} da topilmagan ({from} → {to}) — {n} kor.',
    'zh-CN': '在 {to} 未找到（{from} → {to}）— {n} 箱',
    en: 'not found at {to} ({from} → {to}) — {n} boxes',
  },
  cargoNoneLive: { ru: '📍 Груза в работе нет', uz: '📍 Faol yuk yo‘q', 'zh-CN': '📍 暂无在库或在途货物', en: '📍 No live cargo' },
  cargoIssuedAt: {
    ru: 'выдал склад: {codes}',
    uz: 'topshirgan sklad: {codes}',
    'zh-CN': '交付仓库：{codes}',
    en: 'handed over by: {codes}',
  },
  cargoLostAt: {
    ru: 'списан как утерянный: {codes}',
    uz: 'yo‘qolgan deb yozilgan: {codes}',
    'zh-CN': '登记为丢失：{codes}',
    en: 'written off as lost: {codes}',
  },
  cargoReceivedAt: {
    ru: 'принял склад: {code}',
    uz: 'qabul qilgan sklad: {code}',
    'zh-CN': '收货仓库：{code}',
    en: 'received by: {code}',
  },
  cargoDraft: {
    ru: '📍 Черновик, ещё не подтверждён — склад: {code}',
    uz: '📍 Qoralama, hali tasdiqlanmagan — sklad: {code}',
    'zh-CN': '📍 草稿，尚未确认——仓库：{code}',
    en: '📍 Draft, not confirmed yet — warehouse: {code}',
  },
  cargoVoided: {
    ru: '📍 Приёмка аннулирована — принял склад: {code}',
    uz: '📍 Bekor qilingan prixod — qabul qilgan sklad: {code}',
    'zh-CN': '📍 入库单已作废——收货仓库：{code}',
    en: '📍 Receipt voided — received by: {code}',
  },
  truckLoading: { ru: '{code} — загружается', uz: '{code} — yuklanmoqda', 'zh-CN': '{code} — 装车中', en: '{code} — loading' },
  truckRoad: { ru: 'в пути {from} → {to}', uz: 'yo‘lda {from} → {to}', 'zh-CN': '在途 {from} → {to}', en: 'on the road {from} → {to}' },
  truckUnloading: {
    ru: '{code} — разгружается, осталось {n} кор.',
    uz: '{code} — tushirilmoqda, {n} kor. qoldi',
    'zh-CN': '{code} — 卸货中，剩余 {n} 箱',
    en: '{code} — unloading, {n} boxes left',
  },
  truckMissing: {
    ru: '{code} — разгружен, не найдено {n} кор.',
    uz: '{code} — tushirildi, {n} kor. topilmagan',
    'zh-CN': '{code} — 已卸货，{n} 箱未找到',
    en: '{code} — unloaded, {n} boxes not found',
  },
  truckArrived: { ru: '{code} — прибыл', uz: '{code} — yetib kelgan', 'zh-CN': '{code} — 已到达', en: '{code} — arrived' },
  truckCancelled: {
    ru: '📍 Рейс отменён — груз на складе {code}',
    uz: '📍 Mashina bekor qilingan — yuk {code} da',
    'zh-CN': '📍 车次已取消——货物在 {code}',
    en: '📍 Truck cancelled — cargo at {code}',
  },
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

/**
 * The language a PRE-RENDERED text was written in — `payload.textLocale` when
 * the writer said one (a cargo ping's frame, 0129), else Uzbek: every
 * pre-rendered text before round 2 was written in Uzbek by its caller, so it
 * keeps «↗️ Ochish» and «💬 Javob yozish». Read by the drain's open button
 * (`composeStaffMessage`) and the reply button (`buttonsFor`) — HERE, beside
 * the dictionary both already import, so neither grows an edge to the other.
 */
export function textLocaleOf(payload: Record<string, unknown> | null | undefined): Locale {
  const value = payload?.textLocale;
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'uz';
}

/**
 * `{name}` placeholders filled from `vars` — every occurrence (`cargoMissing`
 * names `{to}` twice); a var the caller did not give is left as written.
 */
export function fillVars(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}

/** «… yana 12 ta» — a count spliced into its sentence. */
export function fillCount(template: string, n: number): string {
  return template.replace('{n}', String(n));
}

/**
 * The line that closes a debtor/unpriced request — «✅ Qarzdorga berishga
 * RUXSAT berildi — Aziz» — in the reader's language.
 *
 * The same words the requester's own DebtApprovalDecided message opens with,
 * so the deciders' copies and the answer say one thing. Round C writes it
 * under every decider's copy once the question is settled, which is what
 * stops a second person pressing a button on a question that is already
 * answered.
 */
export function approvalVerdictLine(
  input: { verdict: 'approved' | 'refused'; reasons?: string | null; decidedByName?: string | null },
  locale?: string | null,
): string {
  const L = notificationLabels(locale);
  const [yes, no] =
    input.reasons === 'price'
      ? [L.priceApprovalYes, L.priceApprovalNo]
      : input.reasons === 'both'
        ? [L.issueApprovalYes, L.issueApprovalNo]
        : [L.debtApprovalYes, L.debtApprovalNo];
  const head = input.verdict === 'approved' ? `✅ ${yes}` : `⛔ ${no}`;
  const who = input.decidedByName?.trim();
  return who ? `${head} — ${who}` : head;
}
