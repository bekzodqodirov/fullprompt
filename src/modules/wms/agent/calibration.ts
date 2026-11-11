import { agentStats, type StatsDraftRow } from './stats';

/**
 * «80 % ishonchi bo'lsa o'zi yozsin» (his words, 2026-11-10) as a number he
 * can trust (docs/AI-SOTUVCHI.md §18, DECISIONS #1625). The model's own
 * `confidence` is a self-report and is never the gate alone; the MEASURED
 * part is his presses — how often a reply of this kind, at this confidence,
 * left exactly as the machine wrote it. «80 %» is then the one-sided 95 %
 * Wilson LOWER bound of that rate, not the rate itself: 40 of 50 is a rate
 * of 80 % and is just as consistent with a true 70 %, so it does not open;
 * 45 of 50 (87 of 100, 170 of 200) does.
 *
 * The rate is `agentStats`' own (stats.ts — the page's «O'zgarishsiz ketdi»):
 * a ✏️ rewrite, a ❌, a 🙋 and his own reply are all «the machine was not
 * right»; superseded and expired rows say nothing and stay out. One rule, so
 * the page and this table can never disagree about what «unchanged» means.
 *
 * Pure: the script reads the rows (`scripts/agent-calibration.ts`), this
 * groups and bounds them, a unit test pins the numbers.
 */

/** The z of a one-sided 95 % bound. */
const Z95 = 1.645;

/** The one-sided 95 % Wilson lower bound of k successes in n, or null when n is 0. */
export function wilsonLower(k: number, n: number, z: number = Z95): number | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (centre - margin) / (1 + z2 / n);
}

/** What «proven» means for a kind of reply: at least this many decided, and the lower bound at least this. */
export const AUTO_PROOF = { minDecided: 50, minLower: 0.8 } as const;

/** The categories the auto-send design may ever open (§18.3) — never price, complaint or other. */
export const AUTO_CATEGORIES = ['greeting', 'status', 'faq', 'qualification'] as const;

export const CONFIDENCE_BANDS = ['none', '<0.50', '0.50-0.69', '0.70-0.79', '0.80-0.89', '0.90+'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** The band a stored confidence falls in; a missing one is its own band, never «low». */
export function bandOf(confidence: number | null): ConfidenceBand {
  if (confidence === null || !Number.isFinite(confidence)) return 'none';
  if (confidence < 0.5) return '<0.50';
  if (confidence < 0.7) return '0.50-0.69';
  if (confidence < 0.8) return '0.70-0.79';
  if (confidence < 0.9) return '0.80-0.89';
  return '0.90+';
}

export interface CalibrationDraftRow extends StatsDraftRow {
  confidence: number | null;
  blocked: boolean;
  needsOwner: boolean;
  /** How many policy warnings the draft was written with. */
  warnings: number;
  /** How many card notes (a dropped action, the rail line, …). */
  notes: number;
  /** A money figure in its ledger, or a tool estimate behind it. */
  money: boolean;
  /** Its action types. */
  actions: string[];
}

/**
 * The part of the auto-send conditions a stored row can answer (§18.3): a
 * plain reply in an allowed category, nothing blocked, nothing for him to
 * answer, no warning, no note, no money, no action but a follow-up date.
 * The rest — the account, the chat, the hour, the photos in the burst —
 * the gate asks live; this is the backtest's honest subset.
 */
export function cleanForAuto(r: Pick<CalibrationDraftRow, 'kind' | 'category' | 'blocked' | 'needsOwner' | 'warnings' | 'notes' | 'money' | 'actions'>): boolean {
  return (
    r.kind === 'reply' &&
    (AUTO_CATEGORIES as readonly string[]).includes(r.category ?? '') &&
    !r.blocked &&
    !r.needsOwner &&
    r.warnings === 0 &&
    r.notes === 0 &&
    !r.money &&
    r.actions.every((a) => a === 'set_followup')
  );
}

export interface CalibrationCell {
  category: string;
  band: ConfidenceBand;
  clean: boolean;
  decided: number;
  unchanged: number;
  rate: number | null;
  lower: number | null;
}

export interface CategoryVerdict {
  category: string;
  /** Clean drafts the model put at 0.80 or more — the design's candidates. */
  decided: number;
  unchanged: number;
  rate: number | null;
  lower: number | null;
  /** Enough decided and the lower bound high enough. */
  proven: boolean;
  /** Decided rows still needed at today's rate before it could open, or null when it cannot at that rate. */
  stillNeeded: number | null;
}

/** Every (category × confidence band × clean) cell, counted by `agentStats`. */
export function calibrationCells(rows: readonly CalibrationDraftRow[]): CalibrationCell[] {
  const groups = new Map<string, CalibrationDraftRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.category ?? 'other', bandOf(r.confidence), cleanForAuto(r)]);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: CalibrationCell[] = [];
  for (const [key, list] of groups) {
    const [category, band, clean] = JSON.parse(key) as [string, ConfidenceBand, boolean];
    const s = agentStats(list);
    if (s.decided === 0) continue;
    out.push({ category, band, clean, decided: s.decided, unchanged: s.sentUnchanged, rate: s.rate, lower: wilsonLower(s.sentUnchanged, s.decided) });
  }
  return out.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      CONFIDENCE_BANDS.indexOf(a.band) - CONFIDENCE_BANDS.indexOf(b.band) ||
      Number(b.clean) - Number(a.clean),
  );
}

/** Per allowed category: the clean drafts at confidence ≥ 0.80 — would the design open it today? */
export function categoryVerdicts(rows: readonly CalibrationDraftRow[]): CategoryVerdict[] {
  return AUTO_CATEGORIES.map((category) => {
    const s = agentStats(rows.filter((r) => r.category === category && cleanForAuto(r) && r.confidence !== null && r.confidence >= 0.8));
    const lower = wilsonLower(s.sentUnchanged, s.decided);
    const proven = s.decided >= AUTO_PROOF.minDecided && lower !== null && lower >= AUTO_PROOF.minLower;
    return { category, decided: s.decided, unchanged: s.sentUnchanged, rate: s.rate, lower, proven, stillNeeded: proven ? 0 : rowsNeeded(s.sentUnchanged, s.decided) };
  });
}

/** How many more decided rows, at the same rate, until the bound clears — null when the rate itself is too low. */
function rowsNeeded(k: number, n: number): number | null {
  const rate = n > 0 ? k / n : null;
  if (rate === null || rate <= AUTO_PROOF.minLower) return null;
  for (let m = Math.max(n, AUTO_PROOF.minDecided); m <= 5_000; m++) {
    const lower = wilsonLower(Math.round(rate * m), m);
    if (lower !== null && lower >= AUTO_PROOF.minLower) return m - n;
  }
  return null;
}
