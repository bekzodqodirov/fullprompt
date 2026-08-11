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
  /**
   * Which truck brought the cargo to the warehouse it is being loaded from —
   * the column header and the heading of the block it opens are the same
   * words, so they are the same key. Deliberately not «Arrived on», which an
   * English reader takes for a date when the cell holds a batch code, and
   * which sat one column away from a header that really is a date.
   */
  arrivalBatch: 'Партия прихода / Arrival batch',
  /** When it landed. `DOC.date` says «Received» and is the RECEIPT's date. */
  arrivalDate: 'Дата прихода / Arrival date',
  /** The heading over the cargo that reached this warehouse on no truck. */
  receivedHere: 'Принято на складе / Received here',
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

/**
 * A date on a document that leaves the company.
 *
 * dd.mm.yyyy, written as TEXT: it says the same thing at the border, in the
 * office and in a Chinese Excel, none of which agree about what a bare date
 * cell means. The packing-photo sheet has printed dates this way since it
 * shipped; the agent sheet needed the same rule, so it is stated once here
 * rather than typed a second time.
 *
 * `timeZone` is the WAREHOUSE the thing happened in, not the reader and not
 * the server. Every Chinese warehouse runs on UTC+8, so a truck unloaded at
 * 07:00 in Kashgar happened at 23:00 UTC the day before — printed in UTC it
 * carries yesterday's date, and the agent is being asked to approve cargo
 * against a sheet that says it arrived on a day nobody was working. UTC is
 * the default only because the older documents were written that way and a
 * date is better than a crash: an unknown zone falls back rather than
 * throwing in the middle of a document.
 */
export function docDate(value: Date, timeZone = 'UTC'): string {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(value);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(value);
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}`;
}
