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
  rastamojka: ['weightKg', 'volumeM3', 'goods'],
  podklyuch: ['fromCity', 'toCity', 'weightKg', 'volumeM3', 'goods'],
};

export type CalcField = 'fromCity' | 'toCity' | 'weightKg' | 'volumeM3' | 'goods';

export const FIELD_LABEL: Record<CalcField, string> = {
  fromCity: 'qaysi shahardan',
  toCity: 'qaysi shaharga',
  weightKg: 'og‘irligi (kg)',
  volumeM3: 'hajmi (kub)',
  goods: 'tovar nomi',
};

/** What the AI (or a human) managed to read out of the sent material. */
export interface CalcFacts {
  fromCity?: string | null;
  toCity?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  goods?: { name: string; quantity?: number | null; tnvedCode?: string | null; note?: string | null }[];
}

/**
 * Which required facts are still missing. A number that is present but zero
 * or negative counts as missing: «0 kg» is not a weight, it is a blank
 * somebody typed over.
 */
export function missingFields(section: CalcSection, facts: CalcFacts): CalcField[] {
  return REQUIRED_FIELDS[section].filter((field) => {
    if (field === 'goods') return !facts.goods || facts.goods.length === 0;
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
  const goods = input.facts.goods ?? [];
  const goodsLines = goods
    .slice(0, 15)
    .map(
      (g) =>
        `· ${g.name}${g.quantity ? ` — ${g.quantity}` : ''}${g.tnvedCode ? ` · ${g.tnvedCode}` : ''}`,
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
  const goods = input.facts.goods ?? [];
  const goodsLines = goods
    .map(
      (g) =>
        `· ${g.name}${g.quantity ? ` — ${g.quantity}` : ''}` +
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
    `Yig‘di: ${input.collectedBy} (Telegram bot)\n` +
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
