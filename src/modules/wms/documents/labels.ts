/**
 * Labels for the paperwork that LEAVES the company.
 *
 * Deliberately bilingual RU/EN and NOT tied to the reader's language, unlike
 * the report exports. These files are read by an Uzbek customs officer and a
 * Chinese forwarding agent — never by whoever happened to click the download
 * button. Making them follow the interface language would let someone working
 * in English hand customs a paper they cannot process, and someone working in
 * Chinese hand the agent one nobody at the border reads.
 *
 * The invoice already carried a few of these pairs ("Отправитель/Sender:");
 * this finishes the pattern across every document.
 */
export const DOC = {
  barcode: 'Штрих-код / Barcode',
  boxes: 'Коробок / Boxes',
  code: 'Код / Code',
  crate: 'Ящик / Crate',
  date: 'Дата прихода / Received',
  density: 'кг/м³ · kg/m³',
  grossWeight: 'Вес брутто (кг) / Gross weight (kg)',
  handedBy: 'Сдал (склад) / Handed over: ____________________',
  handoverTitle: 'АКТ ПРИЁМА-ПЕРЕДАЧИ ГРУЗА / YUK TOPSHIRISH DALOLATNOMASI / CARGO HANDOVER ACT',
  hsCode: 'Код ТНВЭД / HS code',
  kg: 'кг / kg',
  m3: 'м³ / m³',
  netWeight: 'Вес нетто (кг) / Net weight (kg)',
  offPlan: 'Вне плана / Off-plan',
  packaging: 'Упаковка / Packaging',
  photo: 'Фото / Photo',
  places: 'кол-во мест / Places',
  price: 'Цена за ед $ / Unit price $',
  product: 'Товар / Product',
  productName: 'Наименование / Description',
  quantity: 'Количество / Quantity',
  receivedBy: 'Принял / Received by: ____________________',
  /**
   * Sheet TAB names, not column headers: Excel rejects \ / ? * [ ] : in a
   * worksheet name, so these use a middle dot. (Slipping "Сводка / Summary"
   * in here made every manifest download fail with a 500.)
   */
  sheetSummary: 'Сводка · Summary',
  sheetBoxes: 'Коробки · Boxes',
  total: 'ИТОГО / TOTAL',
  totalAmount: 'Общая сумма $ / Total amount $',
  unit: 'Ед.изм / Unit',
  weightKg: 'Вес, кг / Weight, kg',
} as const;
