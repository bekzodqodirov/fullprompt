import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../platform/i18n/locales';

/**
 * Column headers and sheet titles for the report exports.
 *
 * These files are internal — a manager downloads them to read, not to hand to
 * customs — so they follow the reader's own language, the same way the screens
 * do. The customs documents deliberately do NOT work this way: they stay
 * bilingual RU/EN whatever language the person clicking is using, because a
 * customs officer or a Chinese agent is the one who ends up reading them.
 *
 * Kept as a plain dictionary rather than next-intl messages: these builders
 * run in background jobs too, where there is no request to resolve a locale
 * from, and the ~50 labels here never appear on a screen.
 */
const DICT = {
  // Columns
  added: { ru: 'Добавлено', uz: 'Qo‘shilgan', 'zh-CN': '计划外', en: 'Added' },
  batch: { ru: 'Партия', uz: 'Partiya', 'zh-CN': '批次', en: 'Batch' },
  batches: { ru: 'Партии', uz: 'Partiyalar', 'zh-CN': '批次', en: 'Batches' },
  boxes: { ru: 'Коробок', uz: 'Karobka', 'zh-CN': '箱数', en: 'Boxes' },
  boxesShort: { ru: 'Кор.', uz: 'Kor.', 'zh-CN': '箱', en: 'Bx' },
  client: { ru: 'Клиент', uz: 'Mijoz', 'zh-CN': '客户', en: 'Client' },
  code: { ru: 'Код', uz: 'Kod', 'zh-CN': '代码', en: 'Code' },
  costsUsd: { ru: 'Расходы $', uz: 'Xarajat $', 'zh-CN': '费用 $', en: 'Costs $' },
  created: { ru: 'Создана', uz: 'Yaratilgan', 'zh-CN': '创建', en: 'Created' },
  date: { ru: 'Дата', uz: 'Sana', 'zh-CN': '日期', en: 'Date' },
  days: { ru: 'Дней', uz: 'Kun', 'zh-CN': '天数', en: 'Days' },
  daysInStock: { ru: 'Дней на складе', uz: 'Skladda (kun)', 'zh-CN': '在库天数', en: 'Days in stock' },
  density: { ru: 'кг/м³', uz: 'kg/m³', 'zh-CN': '公斤/立方米', en: 'kg/m³' },
  departed: { ru: 'Отправлена', uz: 'Jo‘natilgan', 'zh-CN': '发车', en: 'Departed' },
  edits: { ru: 'Правки', uz: 'Tahrirlar', 'zh-CN': '修改', en: 'Edits' },
  employee: { ru: 'Сотрудник', uz: 'Xodim', 'zh-CN': '员工', en: 'Employee' },
  exports: { ru: 'Экспорты', uz: 'Eksportlar', 'zh-CN': '导出', en: 'Exports' },
  inStock: { ru: 'На складе', uz: 'Skladda', 'zh-CN': '在库', en: 'In stock' },
  inTransit: { ru: 'В пути', uz: 'Yo‘lda', 'zh-CN': '在途', en: 'In transit' },
  issued: { ru: 'Выдано', uz: 'Berilgan', 'zh-CN': '已交付', en: 'Handed over' },
  kg: { ru: 'кг', uz: 'kg', 'zh-CN': '公斤', en: 'kg' },
  labelsCount: { ru: 'Этикеток', uz: 'Stiker', 'zh-CN': '标签数', en: 'Labels' },
  landedCostUsd: { ru: 'Себестоимость $', uz: 'Tannarx $', 'zh-CN': '成本 $', en: 'Landed cost $' },
  loaded: { ru: 'Загружено', uz: 'Yuklangan', 'zh-CN': '已装载', en: 'Loaded' },
  lostVoid: { ru: 'Потеряно/анн.', uz: 'Yo‘qolgan/bekor', 'zh-CN': '丢失/作废', en: 'Lost/voided' },
  kgPerBox: { ru: 'кг/кор', uz: 'kg/kor', 'zh-CN': '公斤/箱', en: 'kg/box' },
  note: { ru: 'Примечание', uz: 'Izoh', 'zh-CN': '备注', en: 'Note' },
  sumKg: { ru: 'Σ кг', uz: 'Σ kg', 'zh-CN': 'Σ 公斤', en: 'Σ kg' },
  lot: { ru: 'Лот', uz: 'Lot', 'zh-CN': '批号', en: 'Lot' },
  lots: { ru: 'Лотов', uz: 'Lotlar', 'zh-CN': '批号数', en: 'Lots' },
  m3: { ru: 'м³', uz: 'm³', 'zh-CN': '立方米', en: 'm³' },
  marking: { ru: 'Маркировка', uz: 'Markirovka', 'zh-CN': '标记', en: 'Marking' },
  name: { ru: 'Название', uz: 'Nomi', 'zh-CN': '名称', en: 'Name' },
  number: { ru: 'Номер', uz: 'Raqam', 'zh-CN': '编号', en: 'Number' },
  operator: { ru: 'Оператор', uz: 'Operator', 'zh-CN': '操作员', en: 'Operator' },
  labelPrints: { ru: 'Печать этикеток', uz: 'Stiker chiqarish', 'zh-CN': '标签打印', en: 'Label prints' },
  product: { ru: 'Товар', uz: 'Mahsulot', 'zh-CN': '商品', en: 'Product' },
  ready: { ru: 'Готово', uz: 'Tayyor', 'zh-CN': '待提货', en: 'Ready' },
  receipt: { ru: 'Приёмка', uz: 'Prixod', 'zh-CN': '入库', en: 'Receipt' },
  receipts: { ru: 'Приёмки', uz: 'Prixodlar', 'zh-CN': '入库数', en: 'Receipts' },
  receivedAt: { ru: 'Принят', uz: 'Qabul qilingan', 'zh-CN': '入库日期', en: 'Received' },
  route: { ru: 'Маршрут', uz: 'Yo‘nalish', 'zh-CN': '路线', en: 'Route' },
  scans: { ru: 'Сканы', uz: 'Skanlar', 'zh-CN': '扫描', en: 'Scans' },
  shortLoaded: { ru: 'Недогруз', uz: 'Yuklanmagan', 'zh-CN': '短装', en: 'Short-loaded' },
  status: { ru: 'Статус', uz: 'Holat', 'zh-CN': '状态', en: 'Status' },
  total: { ru: 'ИТОГО', uz: 'JAMI', 'zh-CN': '合计', en: 'TOTAL' },
  unclaimedCargo: {
    ru: 'Бесхозный груз (маркировка)',
    uz: 'Egasiz yuk (markirovka)',
    'zh-CN': '无主货物（标记）',
    en: 'Unclaimed cargo (marking)',
  },
  usdPerBox: { ru: '$ / коробка', uz: '$ / karobka', 'zh-CN': '$ / 箱', en: '$ / box' },
  usdPerKg: { ru: '$/кг', uz: '$/kg', 'zh-CN': '$/公斤', en: '$/kg' },
  usdPerM3: { ru: '$/м³', uz: '$/m³', 'zh-CN': '$/立方米', en: '$/m³' },
  warehouse: { ru: 'Склад', uz: 'Sklad', 'zh-CN': '仓库', en: 'Warehouse' },
  when: { ru: 'Когда', uz: 'Qachon', 'zh-CN': '时间', en: 'When' },
  who: { ru: 'Кто', uz: 'Kim', 'zh-CN': '操作人', en: 'Who' },
  /**
   * One box's measurements as the warehouse writes them: 40×30×25. Not three
   * columns — «XYZ» is one fact and the owner asked for it in the singular
   * («xyz qatori bosh qolsin»), and a lot either carries all three or none,
   * because the wizard derives the volume FROM them.
   */
  xyzCm: { ru: 'XYZ (см)', uz: 'XYZ (sm)', 'zh-CN': 'XYZ (厘米)', en: 'XYZ (cm)' },
  /**
   * The note on a capped 📷 header. Said only when the cap bites, so it
   * carries the count and not a standing warning. It counts PHOTOGRAPHS now
   * and not rows — a row can carry several and lose only its later ones.
   */
  /**
   * Said on the 📷 header of every photo sheet, because it is a property of
   * Excel and not of a particular download.
   */
  photoSortNote: {
    ru: 'При сортировке фото остаются на месте',
    uz: 'Saralashda rasmlar joyida qoladi',
    'zh-CN': '排序后照片不随行移动',
    en: 'Sorting does not move the pictures',
  },
  photosCapped: {
    ru: 'фото не поместилось',
    uz: 'ta rasm sig‘madi',
    'zh-CN': '张照片未放入',
    en: 'photos did not fit',
  },

  // What a money file cannot count, said in it (audit U22/U23/U24) — the
  // screen prints the same warnings, and a download that drops them is the
  // screen and its file disagreeing (#532d). Kept in step with
  // messages/*.json accounting.gap*, internalRowsNote, unallocatedNote,
  // unbatchedNote and the reconciliation keys.
  cargoQueued: {
    ru: 'из них без кассы (в очереди бухгалтера)',
    uz: 'shundan kassasi ko‘rsatilmagan (buxgalter navbatida)',
    'zh-CN': '其中未指定现金账户（会计待办）',
    en: 'of which with no cash box (the accountant’s queue)',
  },
  cargoKassaUnknown: {
    ru: 'из них касса неизвестна (история до касс — расход или его дубль)',
    uz: 'shundan kassasi noma’lum (kassalar so‘ralishidan oldingi tarix — xarajat yoki uning takrori)',
    'zh-CN': '其中账户未知（启用账户前的历史——费用或其重复记录）',
    en: 'of which the cash box is unknown (history before cash boxes — the cost or its duplicate)',
  },
  cashOpexNoKassa: {
    ru: 'Расходы без кассы и без плательщика',
    uz: 'Kassasi ko‘rsatilmagan xarajatlar',
    'zh-CN': '未指定账户和付款人的费用',
    en: 'Expenses with no cash box and no payer',
  },
  gapNoBox: {
    ru: 'Расходы, не распределённые ни на одну коробку, — нет в себестоимости',
    uz: 'Hech qaysi karobkaga taqsimlanmagan xarajatlar — tannarxda yo‘q',
    'zh-CN': '未分摊到任何箱子的费用——不在任何成本中',
    en: 'Costs split onto no box — in no landed cost',
  },
  gapManualCharges: {
    ru: 'Долги контрагентам, записанные вручную, — не вошли',
    uz: 'Kontragentlarga qo‘lda yozilgan qarzlar — kirmagan',
    'zh-CN': '手工录入的往来单位欠款——未计入',
    en: 'Counterparty debts typed by hand — not included',
  },
  lossesLost: {
    ru: 'Потеряно за период (коробок · м³ · уже потрачено на их перевозку)',
    uz: 'Davrda yo‘qolgan (karobka · m³ · tashishga sarflangan)',
    'zh-CN': '本期丢失（箱 · m³ · 已花费的运输成本）',
    en: 'Lost in the period (cartons · m³ · already spent carrying them)',
  },
  lossesMissing: {
    ru: 'Сейчас не доехали и пока не найдены, независимо от периода (коробок · м³ · потрачено)',
    uz: 'Bugun yo‘lda qolgan, hali topilmagan, davrdan qat’i nazar (karobka · m³ · sarflangan)',
    'zh-CN': '目前途中缺失、尚未找到，与期间无关（箱 · m³ · 已花费）',
    en: 'Missing in transit right now, not found yet, whatever the period (cartons · m³ · spent)',
  },
  lossesInCosts: {
    ru: 'Эти деньги уже внутри расходов на груз — в отчёте месяца, когда расход записан, — из прибыли повторно не вычитаются.',
    uz: 'Bu pul yuk xarajatlari ichida — xarajat yozilgan oyning hisobotida — bor, foydadan qayta ayrilmaydi.',
    'zh-CN': '这些金额已包含在货物成本中（在录入该成本的月份报表里），不再从利润中重复扣除。',
    en: 'This money is already inside the cargo costs — in the report of the month the cost was typed in — it is not subtracted from profit again.',
  },
  uzsAtRate: {
    ru: 'UZS по сегодняшнему курсу',
    uz: 'UZS bugungi kurs bo‘yicha',
    'zh-CN': 'UZS 按今日汇率',
    en: 'UZS at today’s rate',
  },
  internalCost: {
    ru: 'Внутренний рейс, расход $',
    uz: 'Ichki reys xarajati $',
    'zh-CN': '国内车次费用 $',
    en: 'Internal leg cost $',
  },
  prevLegs: {
    ru: 'из них до этого рейса $',
    uz: 'shundan shu reysgacha $',
    'zh-CN': '其中本车次之前 $',
    en: 'of which before this trip $',
  },
  unallocated: {
    ru: '⚠ не распределено $',
    uz: '⚠ taqsimlanmagan $',
    'zh-CN': '⚠ 未分摊 $',
    en: '⚠ not allocated $',
  },
  internalRowsNote: {
    ru: 'Внутренние рейсы (внутри Китая) — только расход: он уже в себестоимости машины, пересекающей границу, как «до этого рейса», поэтому стоит отдельной колонкой и в итог не входит.',
    uz: 'Ichki reyslar (Xitoy ichida) faqat xarajat: u chegaradan o‘tadigan mashina tannarxida «shu reysgacha» bo‘lib turibdi, shuning uchun alohida ustunda va jamiga kirmagan.',
    'zh-CN': '国内车次（中国境内）只有费用：已作为「本车次之前」计入跨境车辆成本，因此单列一栏，不计入合计。',
    en: 'Internal legs (inside China) are cost only: it is already inside the cross-border truck’s cost as «before this trip», so it has its own column and is left out of the total.',
  },
  unallocatedNote: {
    ru: 'Расходы на машинах, не распределённые ни на одну коробку (нет ни в одной себестоимости)',
    uz: 'Mashinalarga yozilgan, hech bir qutiga taqsimlanmagan xarajat (hech bir tannarxda yo‘q)',
    'zh-CN': '记在车辆上、未分摊到任何箱子的费用（不在任何成本中）',
    en: 'Truck costs that reached no box (in no cost figure)',
  },
  // 0104 (Q21 under his (a)): a PART of revenue, in its own column, and the
  // screen's note as a text row — accounting.noCargoCol / noCargoNote.
  noCargoCol: {
    ru: 'из них без груза $',
    uz: 'shundan yuki ketmagan $',
    'zh-CN': '其中无货 $',
    en: 'of which no cargo $',
  },
  noCargoNote: {
    ru: 'Цены клиентов, чей груз уехал не с этой машиной: входят в выручку; бухгалтер переносит их на нужную машину',
    uz: 'Yuki o‘sha mashinada ketmagan mijozlarga yozilgan narx: tushumga kirgan; buxgalter uni yuk ketgan mashinaga ko‘chiradi',
    'zh-CN': '货物未随该车的客户的价格：已计入收入；由会计将其转到正确车次',
    en: 'Prices of clients whose cargo did not ride the truck: in the revenue; the accountant moves them to the right truck',
  },
  unbatchedNote: {
    ru: 'Выручка без привязки к машине — в эту таблицу не вошла',
    uz: 'Mashinaga bog‘lanmagan tushum — bu jadvalga kirmagan',
    'zh-CN': '未关联车辆的收入——未计入本表',
    en: 'Revenue tied to no truck — not in this table',
  },
  // The cost half of «unbatched» and the client tab's reconciliation (audit
  // U37, U19) — in step with messages/*.json accounting.unbatchedCostNote,
  // clientUnallocatedNote and gapScope.*.
  unbatchedCostNote: {
    ru: 'Расходы на груз, не уехавший ни на одной машине с ценой (по дате расхода)',
    uz: 'Hech bir narxli mashinaga chiqmagan yuk ustidagi xarajat (xarajat sanasi bo‘yicha)',
    'zh-CN': '未随任何定价车辆出发的货物上的费用（按费用日期）',
    en: 'Cost on cargo that rode no priced truck (by cost date)',
  },
  noTruckLost: { ru: 'списано', uz: 'hisobdan chiqarilgan', 'zh-CN': '已核销', en: 'written off' },
  noTruckIssued: {
    ru: 'выдано или возвращено без машины',
    uz: 'mashinasiz topshirilgan yoki qaytarilgan',
    'zh-CN': '无车交付或退回',
    en: 'handed over or returned without a truck',
  },
  noTruckWaiting: {
    ru: 'ещё ждёт машину',
    uz: 'hali mashinani kutayotgan',
    'zh-CN': '仍在等车',
    en: 'still waiting for a truck',
  },
  clientUnallocatedNote: {
    ru: 'Расходы, не распределённые ни на одну коробку — их нет ни у одного клиента, это и есть разница с P&L',
    uz: 'Hech bir qutiga taqsimlanmagan xarajat — u hech bir mijozda yo‘q, P&L bilan farq shu summa',
    'zh-CN': '未分摊到任何箱子的费用——不在任何客户名下，这就是与损益表的差额',
    en: 'Cost that reached no box — it is on no client; that is the difference from the P&L',
  },
  gapScopeBatch: { ru: 'машина без груза', uz: 'yuki yo‘q mashina', 'zh-CN': '无货车辆', en: 'a truck with no cargo' },
  gapScopePickup: {
    ru: 'заводской рейс без привязанного прихода',
    uz: 'prixodi ulanmagan zavod reysi',
    'zh-CN': '未关联入库单的工厂提货',
    en: 'a factory pickup with no receipt linked',
  },
  gapScopeReceipt: {
    ru: 'не попало на коробки прихода',
    uz: 'prixod qutilariga tushmagan',
    'zh-CN': '未落到入库单箱子上',
    en: 'not on the receipt’s boxes',
  },
  gapScopeCrate: {
    ru: 'не попало на коробки ящика',
    uz: 'yashik qutilariga tushmagan',
    'zh-CN': '未落到木箱箱子上',
    en: 'not on the crate’s boxes',
  },
  reconTitle: {
    ru: 'Кассы: начало и конец периода',
    uz: 'Kassalar: davr boshi va oxiri',
    'zh-CN': '现金账户：期初与期末',
    en: 'Cash boxes: start and end of the period',
  },
  reconOpen: { ru: 'Начало периода', uz: 'Davr boshi', 'zh-CN': '期初', en: 'Opening' },
  reconClose: { ru: 'Конец периода', uz: 'Davr oxiri', 'zh-CN': '期末', en: 'Closing' },
  inflow: { ru: 'Приход', uz: 'Kirim', 'zh-CN': '收入', en: 'In' },
  outflow: { ru: 'Расход', uz: 'Chiqim', 'zh-CN': '支出', en: 'Out' },
  retiredTill: { ru: 'неактивна', uz: 'faol emas', 'zh-CN': '已停用', en: 'retired' },
  reconOpeningUsd: {
    ru: 'Деньги на начало периода',
    uz: 'Davr boshidagi pul',
    'zh-CN': '期初现金',
    en: 'Cash at the start',
  },
  reconClosingUsd: {
    ru: 'Деньги на конец периода',
    uz: 'Davr oxiridagi pul',
    'zh-CN': '期末现金',
    en: 'Cash at the end',
  },
  reconUnexplained: {
    ru: '⚠ Необъяснённая разница',
    uz: '⚠ Tushuntirilmagan farq',
    'zh-CN': '⚠ 未解释差额',
    en: '⚠ Unexplained difference',
  },
  reconCountedInPeriod: {
    ru: 'Касса пересчитана внутри периода',
    uz: 'Kassa davr ichida sanaldi',
    'zh-CN': '期内盘点的账户',
    en: 'A cash box counted inside the period',
  },
  reconNoKassaPayments: {
    ru: 'Платежи, не попавшие в кассу',
    uz: 'Kassaga tushmagan to‘lovlar',
    'zh-CN': '未进入账户的收款',
    en: 'Payments that reached no cash box',
  },
  reconQueuedCosts: {
    ru: 'Расходы по грузам без кассы (очередь)',
    uz: 'Kassasi ko‘rsatilmagan yuk xarajatlari (navbat)',
    'zh-CN': '未指定账户的货物费用（待办）',
    en: 'Cargo costs with no cash box (the queue)',
  },
  reconHistoryCosts: {
    ru: 'Расходы по грузам, касса неизвестна (история)',
    uz: 'Kassasi noma’lum yuk xarajatlari (tarix)',
    'zh-CN': '账户未知的货物费用（历史）',
    en: 'Cargo costs, cash box unknown (history)',
  },
  reconNoKassaExpenses: {
    ru: 'Расходы, записанные без кассы',
    uz: 'Kassasiz yozilgan xarajatlar',
    'zh-CN': '未指定账户的费用',
    en: 'Expenses entered with no cash box',
  },
  reconBeforeOpening: {
    ru: 'Записи с датой до пересчёта кассы',
    uz: 'Kassa sanog‘idan oldingi sanali yozuvlar',
    'zh-CN': '日期早于账户盘点的记录',
    en: 'Rows dated before their cash box was counted',
  },
  reconTillOnly: {
    ru: 'Из кассы, но не в движении денег (неденежная статья)',
    uz: 'Kassadan chiqqan, pul oqimiga kirmagan (naqdsiz tur)',
    'zh-CN': '从账户支出但不在现金流中（非现金类别）',
    en: 'Out of a cash box but not in the cash flow (non-cash category)',
  },
  reconOneSidedTransfers: {
    ru: 'Переводы, один конец которых вне учтённых касс',
    uz: 'Bir uchi sanoqdan tashqaridagi ko‘chirishlar',
    'zh-CN': '一端不在已计账户内的转账',
    en: 'Transfers with one end outside the counted cash boxes',
  },
  reconUnratedTills: {
    ru: 'Движение касс без курса',
    uz: 'Kursi yo‘q kassalar harakati',
    'zh-CN': '无汇率账户的变动',
    en: 'Movement through cash boxes with no rate',
  },
  reconTillUnconverted: {
    ru: 'Из кассы на расходы в валюте без курса (по курсу кассы)',
    uz: 'Kassadan kursi yo‘q valyutadagi xarajatlarga (kassa kursida)',
    'zh-CN': '从账户支付的无汇率币种费用（按账户汇率）',
    en: 'Paid from a cash box for costs in a currency with no rate (at the box’s rate)',
  },
  // 0103: the reconciliation's remainder holds REVALUATION only now — the
  // realised exchange difference moved into the cash flow and the P&L.
  reconFx: {
    ru: 'Переоценка валюты в кассах',
    uz: 'Kassadagi valyutaning qayta baholanishi',
    'zh-CN': '现金柜外币重估',
    en: 'Revaluation of currency held in tills',
  },
  // «Kurs farqi» (0103, the owner's Q12 A / Q13 A) — the P&L block and the
  // cash flow's exchange rows.
  fxTotal: { ru: 'Курсовая разница', uz: 'Kurs farqi', 'zh-CN': '汇兑差额', en: 'Exchange difference' },
  fxKassa: {
    ru: 'Курсовая разница (касса)',
    uz: 'Kurs farqi (kassa)',
    'zh-CN': '汇兑差额（现金柜）',
    en: 'Exchange difference (tills)',
  },
  fxSettlement: {
    ru: 'Оплата через фирму (трёхсторонний зачёт)',
    uz: 'Firma orqali to‘lov (uch tomonlama)',
    'zh-CN': '经公司代收结算（三方）',
    en: 'Paid through a firm (three-way settlement)',
  },
  fxAdjust: {
    ru: 'Курсовая разница, внесённая вручную',
    uz: 'Qo‘lda yozilgan kurs farqi',
    'zh-CN': '手工录入的汇兑差额',
    en: 'Exchange difference entered by hand',
  },
  fxClosing: {
    ru: 'При закрытии счёта в его валюте',
    uz: 'Hisob o‘z valyutasida yopilganda',
    'zh-CN': '账户按原币结清',
    en: 'Account settled in its own currency',
  },
  fxGain: { ru: 'Выигрыш на обмене валют', uz: 'Valyuta almashuvidan yutuq', 'zh-CN': '汇兑收益', en: 'Exchange gain' },
  fxLoss: {
    ru: 'Потеря на обмене валют',
    uz: 'Valyuta almashuvidagi yo‘qotish',
    'zh-CN': '汇兑损失',
    en: 'Exchange loss',
  },
  cargoUnrated: {
    ru: 'Расходы на груз — курса ещё нет (ушло из кассы)',
    uz: 'Yuk xarajatlari — kursi hali yo‘q (kassadan chiqqan)',
    'zh-CN': '货物费用——尚无汇率（已从现金柜支出）',
    en: 'Cargo costs — no rate yet (paid from a till)',
  },
  gapAdjustUnclassified: {
    ru: 'Корректировки фирм без указанного вида (в P&L не включены)',
    uz: 'Turi aytilmagan firma tuzatishlari (P&L ga qo‘shilmadi)',
    'zh-CN': '未注明类型的公司调整（未计入损益表）',
    en: 'Firm adjustments with no kind (not in the P&L)',
  },
  gapKassaUsdMissing: {
    ru: 'Расходы из кассы без курса её валюты (курсовая разница не посчитана)',
    uz: 'Kassa valyutasida kursi yo‘q xarajatlar (kurs farqi hisoblanmadi)',
    'zh-CN': '现金柜币种无汇率的费用（未计算汇兑差额）',
    en: 'Till-paid costs with no rate for the till’s currency (exchange difference not counted)',
  },
  gapTransferUsdMissing: {
    ru: 'Переводы без курса валюты кассы-получателя (курсовая разница не посчитана)',
    uz: 'Qabul qilgan kassa valyutasida kursi yo‘q o‘tkazmalar (kurs farqi hisoblanmadi)',
    'zh-CN': '收款现金柜币种无汇率的转账（未计算汇兑差额）',
    en: 'Transfers with no rate for the receiving till’s currency (exchange difference not counted)',
  },

  // Sheet titles
  tLandedCostByLot: {
    ru: 'Себестоимость по лотам',
    uz: 'Lotlar bo‘yicha tannarx',
    'zh-CN': '按批号成本',
    en: 'Landed cost by lot',
  },
  tLandedCostByClient: {
    ru: 'Себестоимость по клиентам',
    uz: 'Mijozlar bo‘yicha tannarx',
    'zh-CN': '按客户成本',
    en: 'Landed cost by client',
  },
  unconvertedCosts: {
    ru: 'Расходы без курса — не вошли',
    uz: 'Kursi yo‘q xarajatlar — kirmagan',
    'zh-CN': '无汇率的费用——未计入',
    en: 'Costs with no rate — not included',
  },
  tStockAging: {
    ru: 'Остатки со сроком хранения',
    uz: 'Qoldiq va saqlash muddati',
    'zh-CN': '库存与在库天数',
    en: 'Stock with storage age',
  },
  tBatchRegister: {
    ru: 'Реестр партий',
    uz: 'Partiyalar reestri',
    'zh-CN': '批次登记表',
    en: 'Batch register',
  },
  tReceiptsJournal: {
    ru: 'Журнал приёмок',
    uz: 'Prixodlar jurnali',
    'zh-CN': '入库日志',
    en: 'Receipts journal',
  },
  tUnclaimed: {
    ru: 'Грузы без владельца',
    uz: 'Egasiz yuklar',
    'zh-CN': '无主货物',
    en: 'Cargo without an owner',
  },
  tClientHistory: {
    ru: 'История грузов клиента',
    uz: 'Mijoz yuklari tarixi',
    'zh-CN': '客户货物历史',
    en: "Client's cargo history",
  },
  tStaffActivity: {
    ru: 'Активность сотрудников',
    uz: 'Xodimlar faolligi',
    'zh-CN': '员工活动',
    en: 'Employee activity',
  },
  tLabelPrintLog: {
    ru: 'Журнал печати этикеток',
    uz: 'Stiker chiqarish jurnali',
    'zh-CN': '标签打印日志',
    en: 'Label printing log',
  },
  tInTransit: {
    ru: 'Грузы в пути',
    uz: 'Yo‘ldagi yuklar',
    'zh-CN': '在途货物',
    en: 'Cargo in transit',
  },
  /** "(30 d.)" appended to the journal titles. */
  daysSuffix: { ru: 'дн.', uz: 'kun', 'zh-CN': '天', en: 'd.' },

  // Management accounting (Phase 2.4)
  account: { ru: 'Касса/счёт', uz: 'Kassa/hisob', 'zh-CN': '账户', en: 'Account' },
  amount: { ru: 'Сумма', uz: 'Summa', 'zh-CN': '金额', en: 'Amount' },
  balance: { ru: 'Баланс', uz: 'Balans', 'zh-CN': '余额', en: 'Balance' },
  cargoCosts: { ru: 'Расходы по грузам', uz: 'Yuk xarajatlari', 'zh-CN': '货物费用', en: 'Cargo costs' },
  category: { ru: 'Статья', uz: 'Turi', 'zh-CN': '类别', en: 'Category' },
  clientPayments: { ru: 'Оплаты клиентов', uz: 'Mijoz to‘lovlari', 'zh-CN': '客户付款', en: 'Client payments' },
  clientRefunds: { ru: 'Возвраты клиентам', uz: 'Mijozlarga qaytarilgan', 'zh-CN': '退还客户', en: 'Refunds to clients' },
  partnerIn: { ru: 'От контрагентов', uz: 'Kontragentlardan', 'zh-CN': '往来单位收款', en: 'From counterparties' },
  partnerOut: { ru: 'Контрагентам', uz: 'Kontragentlarga', 'zh-CN': '付往来单位', en: 'To counterparties' },
  cost: { ru: 'Расход', uz: 'Xarajat', 'zh-CN': '成本', en: 'Cost' },
  currency: { ru: 'Валюта', uz: 'Valyuta', 'zh-CN': '币种', en: 'Currency' },
  days0: { ru: '0–30 дн.', uz: '0–30 kun', 'zh-CN': '0–30 天', en: '0–30 d.' },
  days30: { ru: '31–60 дн.', uz: '31–60 kun', 'zh-CN': '31–60 天', en: '31–60 d.' },
  days60: { ru: '61–90 дн.', uz: '61–90 kun', 'zh-CN': '61–90 天', en: '61–90 d.' },
  days90: { ru: '90+ дн.', uz: '90+ kun', 'zh-CN': '90+ 天', en: '90+ d.' },
  debt: { ru: 'Долг', uz: 'Qarz', 'zh-CN': '欠款', en: 'Debt' },
  directCosts: { ru: 'Себестоимость грузов', uz: 'Yuk tannarxi', 'zh-CN': '货物成本', en: 'Direct cargo costs' },
  grossProfit: { ru: 'ВАЛОВАЯ ПРИБЫЛЬ', uz: 'YALPI FOYDA', 'zh-CN': '毛利', en: 'GROSS PROFIT' },
  margin: { ru: 'Маржа %', uz: 'Marja %', 'zh-CN': '毛利率 %', en: 'Margin %' },
  grossCharges: { ru: 'Выставленные цены', uz: 'Hisoblangan narxlar', 'zh-CN': '已开价格', en: 'Prices charged' },
  compensation: {
    ru: 'Компенсации (потерянный груз)',
    uz: 'Kompensatsiya (yo‘qolgan yuk)',
    'zh-CN': '赔偿（丢失货物）',
    en: 'Compensation (lost cargo)',
  },
  month: { ru: 'Месяц', uz: 'Oy', 'zh-CN': '月份', en: 'Month' },
  netFlow: { ru: 'Чистый поток', uz: 'Sof oqim', 'zh-CN': '净流量', en: 'Net flow' },
  netProfit: { ru: 'ЧИСТАЯ ПРИБЫЛЬ', uz: 'SOF FOYDA', 'zh-CN': '净利润', en: 'NET PROFIT' },
  opex: { ru: 'Операционные расходы', uz: 'Operatsion xarajatlar', 'zh-CN': '运营费用', en: 'Operating expenses' },
  profit: { ru: 'Прибыль', uz: 'Foyda', 'zh-CN': '利润', en: 'Profit' },
  revenue: { ru: 'Выручка', uz: 'Tushum', 'zh-CN': '收入', en: 'Revenue' },
  tCashFlow: {
    ru: 'Движение денежных средств',
    uz: 'Pul mablag‘lari harakati',
    'zh-CN': '现金流量表',
    en: 'Cash flow',
  },
  tExpenses: { ru: 'Расходы', uz: 'Xarajatlar', 'zh-CN': '费用明细', en: 'Expenses' },
  tPnl: {
    ru: 'Отчёт о прибылях и убытках',
    uz: 'Foyda va zarar hisoboti',
    'zh-CN': '损益表',
    en: 'Profit and loss',
  },
  tProfitBatch: {
    ru: 'Прибыль по партиям',
    uz: 'Partiyalar bo‘yicha foyda',
    'zh-CN': '按批次利润',
    en: 'Profit by batch',
  },
  tProfitClient: {
    ru: 'Прибыль по клиентам',
    uz: 'Mijozlar bo‘yicha foyda',
    'zh-CN': '按客户利润',
    en: 'Profit by client',
  },
  tProfitRoute: {
    ru: 'Прибыль по маршрутам',
    uz: 'Yo‘nalishlar bo‘yicha foyda',
    'zh-CN': '按路线利润',
    en: 'Profit by route',
  },
  tReceivables: {
    ru: 'Дебиторская задолженность',
    uz: 'Debitorlik qarzi',
    'zh-CN': '应收账款账龄',
    en: 'Accounts receivable ageing',
  },
} satisfies Record<string, Record<Locale, string>>;

export type ReportLabels = { [K in keyof typeof DICT]: string };

/** Labels in the reader's language; an unknown locale falls back to the default. */
export function reportLabels(locale?: string | null): ReportLabels {
  const key = (LOCALES as readonly string[]).includes(locale ?? '')
    ? (locale as Locale)
    : DEFAULT_LOCALE;
  return Object.fromEntries(
    Object.entries(DICT).map(([name, values]) => [name, values[key]]),
  ) as ReportLabels;
}
