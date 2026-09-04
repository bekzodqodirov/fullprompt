/**
 * «Hisoblatish» — what the bot COLLECTS before anybody quotes a price.
 *
 * The owner's design, and it is better than the one I proposed: rather than
 * having the AI read a whole client conversation and guess which parts are a
 * quote request — «hato ishlash extimoli yuqori» — a member of staff opens
 * the bot, presses «Hisoblatish», and sends exactly the files, photos and
 * facts that belong to this job. What is sent is what is analysed; nothing
 * is inferred from a chat nobody pointed at.
 *
 * Three sections, his words: **yo'lkira** (freight), **rastamojka**
 * (customs clearance) and **podklyuch** — which is not a third service but
 * the two added together, so it asks for both sets of facts.
 *
 * The bot never quotes. It collects, checks that the facts a quote needs are
 * actually there, and lands a card; the price is the staff member's to say
 * (his answer 2). Everything in this file is a pure decision so the whole of
 * it can be tested without a Telegram or a model.
 */

export type CalcSection = 'yolkira' | 'rastamojka' | 'podklyuch';

export const CALC_SECTIONS: CalcSection[] = ['yolkira', 'rastamojka', 'podklyuch'];

export const SECTION_LABEL: Record<CalcSection, string> = {
  yolkira: '🚚 Yo‘lkira',
  rastamojka: '🛃 Rastamojka',
  podklyuch: '🔑 Podklyuch (yo‘lkira + rastamojka)',
};

/**
 * What a section cannot be quoted without.
 *
 * Cargo facts (weight, volume, what it actually IS) are what customs needs;
 * freight additionally needs the two ends of the road. Podklyuch is the sum
 * of both, so it asks for everything — that is the whole meaning of the word
 * here.
 */
export const REQUIRED_FIELDS: Record<CalcSection, CalcField[]> = {
  yolkira: ['fromCity', 'toCity', 'weightKg', 'volumeM3', 'goods'],
  rastamojka: ['weightKg', 'volumeM3', 'goods', 'itemQuantity', 'itemWeight'],
  podklyuch: [
    'fromCity',
    'toCity',
    'weightKg',
    'volumeM3',
    'goods',
    'itemQuantity',
    'itemWeight',
  ],
};

export type CalcField =
  | 'fromCity'
  | 'toCity'
  | 'weightKg'
  | 'volumeM3'
  | 'goods'
  /**
   * PER-ITEM, and only where customs is being calculated (sub-round B).
   *
   * A total weight prices a truck; it cannot price a declaration. The baza is
   * per kg or per dona or per m², chosen per ROW, so `unitsForRow` needs to
   * know what THIS line states a figure for — and the customs file is 74 %
   * per-kg while an ordinary advalor code asks per-dona. A line stating
   * neither a count nor a weight can be valued at all only by guessing, which
   * is the one thing the module may not do. Freight asks for neither: it is
   * priced on the totals.
   */
  | 'itemQuantity'
  | 'itemWeight';

export const FIELD_LABEL: Record<CalcField, string> = {
  fromCity: 'qaysi shahardan',
  toCity: 'qaysi shaharga',
  weightKg: 'og‘irligi (kg)',
  volumeM3: 'hajmi (kub)',
  goods: 'tovar nomi',
  itemQuantity: 'har bir tovarning soni',
  itemWeight: 'har bir tovarning og‘irligi (kg)',
};

/** What the AI (or a human) managed to read out of the sent material. */
export interface CalcFacts {
  fromCity?: string | null;
  toCity?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  goods?: {
    name: string;
    quantity?: number | null;
    /** What THIS line weighs, in kg — see `CalcField`'s `itemWeight`. */
    weightKg?: number | null;
    tnvedCode?: string | null;
    note?: string | null;
  }[];
}

/** One line as the rest of the system should read it. */
export interface CalcItemFact {
  name: string;
  quantity: number | null;
  weightKg: number | null;
  tnvedCode: string | null;
  note: string | null;
}

/**
 * The one weight a single-line job never has to be asked for.
 *
 * Split out from `itemFacts` because three doors land a calculation and only
 * one of them carries `CalcFacts`: the bot and the thread hand over what was
 * READ, the seller's card form hands over what was TYPED. The shape differs;
 * the RULE must not, or the same job lands a different row depending on which
 * door it came through — which is the asymmetry a derived fence found here on
 * its first run.
 */
export function loneWeightKg(
  itemCount: number,
  totalKg: number | null | undefined,
): number | null {
  const total = Number(totalKg);
  return itemCount === 1 && total > 0 ? total : null;
}

/**
 * The goods, with the one weight that can be DERIVED rather than asked for.
 *
 * With a single line, the shipment's weight IS that line's weight — that is
 * arithmetic, not a guess, and asking a person to retype a number they have
 * already given reads as a broken form. With two or more lines nothing can be
 * split without inventing a ratio, so those stay empty and the checklist asks.
 *
 * ONE home (#513): the checklist, the summary, the note and the landing all
 * read the goods through here, so «what does this line weigh» has a single
 * answer everywhere it is asked.
 */
export function itemFacts(facts: CalcFacts): CalcItemFact[] {
  const goods = facts.goods ?? [];
  const lone = loneWeightKg(goods.length, facts.weightKg);
  return goods.map((g) => ({
    name: g.name,
    quantity: Number(g.quantity) > 0 ? Number(g.quantity) : null,
    weightKg: Number(g.weightKg) > 0 ? Number(g.weightKg) : lone,
    tnvedCode: g.tnvedCode ?? null,
    note: g.note ?? null,
  }));
}

/**
 * Which required facts are still missing. A number that is present but zero
 * or negative counts as missing: «0 kg» is not a weight, it is a blank
 * somebody typed over.
 */
export function missingFields(section: CalcSection, facts: CalcFacts): CalcField[] {
  const items = itemFacts(facts);
  return REQUIRED_FIELDS[section].filter((field) => {
    if (field === 'goods') return items.length === 0;
    // With no goods at all these stay silent — `[].some()` is false — and
    // that is deliberate, not incidental: «tovar nomi» already names that
    // absence, and one hole reported three times is how a checklist stops
    // being read. Pinned behaviourally, because the mechanism is subtle
    // enough that a later `!items.length ||` would look like an improvement.
    if (field === 'itemQuantity') return items.some((i) => i.quantity === null);
    if (field === 'itemWeight') return items.some((i) => i.weightKg === null);
    if (field === 'weightKg') return !(Number(facts.weightKg) > 0);
    if (field === 'volumeM3') return !(Number(facts.volumeM3) > 0);
    return !String(facts[field] ?? '').trim();
  });
}

/** Ready to be handed over for pricing? */
export function isComplete(section: CalcSection, facts: CalcFacts): boolean {
  return missingFields(section, facts).length === 0;
}

const num = (n: number | null | undefined, unit: string) =>
  Number(n) > 0 ? `${Math.round(Number(n) * 1000) / 1000} ${unit}` : '—';

/**
 * The message the staff member reads before pressing confirm — the facts as
 * the system understood them, and, in red, what a quote still needs.
 *
 * Deliberately shows what is THERE as well as what is missing: a checklist
 * of absences alone gives no way to catch the commonest error, which is not
 * a missing number but a misread one.
 */
export function intakeSummaryText(input: {
  section: CalcSection;
  facts: CalcFacts;
  clientLabel: string | null;
  fileCount: number;
}): string {
  const missing = missingFields(input.section, input.facts);
  const goods = itemFacts(input.facts);
  const goodsLines = goods
    .slice(0, 15)
    .map(
      (g) =>
        `· ${g.name}${g.quantity ? ` — ${g.quantity} dona` : ''}` +
        `${g.weightKg ? ` · ${g.weightKg} kg` : ''}${g.tnvedCode ? ` · ${g.tnvedCode}` : ''}`,
    )
    .join('\n');

  return (
    `${SECTION_LABEL[input.section]}\n` +
    `Mijoz: ${input.clientLabel ?? '— (yangi)'}\n` +
    (input.section === 'rastamojka'
      ? ''
      : `Yo‘nalish: ${input.facts.fromCity?.trim() || '—'} → ${input.facts.toCity?.trim() || '—'}\n`) +
    `Og‘irlik: ${num(input.facts.weightKg, 'kg')} · Hajm: ${num(input.facts.volumeM3, 'kub')}\n` +
    (goods.length
      ? `Tovarlar (${goods.length}):\n${goodsLines}${goods.length > 15 ? '\n…' : ''}\n`
      : 'Tovarlar: —\n') +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (missing.length
      ? `\n⚠️ Yetishmayapti: ${missing.map((f) => FIELD_LABEL[f]).join(', ')}\n` +
        'Yetishmaganini yozib yuboring yoki shundayligicha tasdiqlang.'
      : '\n✅ Ma’lumot to‘liq. Tasdiqlaysizmi?')
  );
}

/**
 * The note that lands on the card's lenta — the AI's working shown, which is
 * what the owner asked for: «kartochkani ichida lenta bor, AI tartib bilan
 * qanday TNVED kod qo'ygan, qanday guruhlagan yozib ketsin».
 */
/**
 * Law 11's cap. The note column is unbounded, but a forwarded dump has no
 * ceiling either — 20 000 characters is the same slice the model reads, and
 * past it the note says it was cut rather than cutting in silence.
 */
export const MATERIAL_NOTE_CAP = 20_000;

export function intakeNoteText(input: {
  section: CalcSection;
  facts: CalcFacts;
  steps: string[];
  collectedBy: string;
  /** Which door collected it — the note names its own provenance. */
  via?: string;
  fileCount: number;
  /**
   * The seller's own words, verbatim (law 11: «everything the seller
   * submitted is shown to the VED AS-IS — forwarded messages, unabridged»).
   * The whole-module audit found the bot path persisted only the parsed
   * digest: the typed and forwarded TEXT lived in a 30-minute in-memory
   * state whose sole consumer was the model, so the VED read a summary of a
   * submission nobody could reopen.
   */
  material?: string[];
}): string {
  const goods = itemFacts(input.facts);
  const goodsLines = goods
    .map(
      (g) =>
        `· ${g.name}${g.quantity ? ` — ${g.quantity} dona` : ''}` +
        `${g.weightKg ? ` · ${g.weightKg} kg` : ''}` +
        `${g.tnvedCode ? `\n   TNVED: ${g.tnvedCode}` : ''}` +
        `${g.note ? `\n   ${g.note}` : ''}`,
    )
    .join('\n');
  const missing = missingFields(input.section, input.facts);
  const raw = (input.material ?? []).map((m) => m.trim()).filter(Boolean).join('\n');
  const material =
    raw.length === 0
      ? null
      : raw.length > MATERIAL_NOTE_CAP
        ? raw.slice(0, MATERIAL_NOTE_CAP) + '\n… (qisqartirildi)'
        : raw;

  return (
    `🧮 Hisoblatish — ${SECTION_LABEL[input.section]}\n` +
    `Yig‘di: ${input.collectedBy} (${input.via ?? 'Telegram bot'})\n` +
    (input.section === 'rastamojka'
      ? ''
      : `Yo‘nalish: ${input.facts.fromCity?.trim() || '—'} → ${input.facts.toCity?.trim() || '—'}\n`) +
    `Og‘irlik: ${num(input.facts.weightKg, 'kg')} · Hajm: ${num(input.facts.volumeM3, 'kub')}\n` +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (goods.length ? `\nTovarlar:\n${goodsLines}\n` : '') +
    (input.steps.length ? `\nAI izohi:\n${input.steps.map((s) => `— ${s}`).join('\n')}\n` : '') +
    (material ? `\nSotuvchi yuborgani (asl matn):\n${material}\n` : '') +
    (missing.length
      ? `\n⚠️ Yetishmayotgan ma’lumot: ${missing.map((f) => FIELD_LABEL[f]).join(', ')}`
      : '')
  );
}

/**
 * A phone or a client code typed into the collection — the two ways staff
 * name a customer. Neither is validated here beyond shape: WHICH client it
 * is gets resolved against the book, where the honest answer lives.
 */
export function parseClientHint(raw: string): { code?: string; phone?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 7) return { phone: text };
  if (/^[A-Za-z]{1,4}\d{1,8}$/.test(text)) return { code: text.toUpperCase() };
  return null;
}
