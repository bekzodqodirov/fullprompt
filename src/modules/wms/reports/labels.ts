import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../platform/i18n/request';

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
  usdPerBox: { ru: '$ / коробка', uz: '$ / karobka', 'zh-CN': '$ / 箱', en: '$ / box' },
  usdPerKg: { ru: '$/кг', uz: '$/kg', 'zh-CN': '$/公斤', en: '$/kg' },
  usdPerM3: { ru: '$/м³', uz: '$/m³', 'zh-CN': '$/立方米', en: '$/m³' },
  warehouse: { ru: 'Склад', uz: 'Sklad', 'zh-CN': '仓库', en: 'Warehouse' },
  when: { ru: 'Когда', uz: 'Qachon', 'zh-CN': '时间', en: 'When' },
  who: { ru: 'Кто', uz: 'Kim', 'zh-CN': '操作人', en: 'Who' },

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
