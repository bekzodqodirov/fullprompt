import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { customFields, leadFieldMap, leadIntakes } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { CrmError } from './service';

/**
 * The tarjimon (round 97): an advert form's own questions → lead fields.
 *
 * The form asks whatever its builder typed — «bazada yukingiz bormi», «necha
 * kub», or a key nobody here has seen. One decision per question KEY, made
 * once on the taqsimot screen, applied to every later arrival. Everything
 * that can be decided without the database is pure and unit-tested here.
 *
 * The rule the adversarial review made structural: **nothing on this path may
 * throw on a stranger's input.** A throwing structured write on the landing
 * would abort the arrival BEFORE its ledger row and open the replay fence —
 * so parsing refuses quietly (the answer stays a note line), ranges are
 * clamped below the numeric columns' capacity, and the landing wraps its
 * structured writes in a catch of their own.
 */

export interface FieldPair {
  key: string;
  value: string;
}

export interface MapRow {
  id: string;
  key: string;
  target: 'kub' | 'kg' | 'field' | 'note';
  fieldId: string | null;
}

/** What the map turned one arrival's answers into. Never throws. */
export interface MappedAnswers {
  volumeM3: number | null;
  weightKg: number | null;
  /** Raw answers for custom-field targets; coercion happens at the write. */
  custom: { fieldId: string; value: string }[];
}

/**
 * The capture caps. `lead_intakes.fields` is written for EVERY arrival on a
 * public door, so an unbounded body must not become unbounded storage.
 */
export const MAX_PAIRS = 30;
const MAX_KEY = 80;
const MAX_VALUE = 300;

/** The names a shared secret travels under — never stored, never mapped. */
const SECRET_KEYS = new Set(['google_key', 'key', 'secret', 'token']);

/** One spelling per question: the map and the arrivals must agree. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().slice(0, MAX_KEY);
}

/**
 * What of a stranger's pairs is worth keeping: capped, normalized, secrets
 * dropped by NAME (defense in depth beside the parsers' own filter).
 */
export function capturePairs(pairs: FieldPair[] | null | undefined): FieldPair[] | null {
  if (!pairs?.length) return null;
  const out: FieldPair[] = [];
  for (const pair of pairs) {
    const key = normalizeKey(String(pair.key ?? ''));
    const value = String(pair.value ?? '').trim().slice(0, MAX_VALUE);
    if (!key || !value) continue;
    if (SECRET_KEYS.has(key)) continue;
    out.push({ key, value });
    if (out.length >= MAX_PAIRS) break;
  }
  return out.length ? out : null;
}

/**
 * A measure out of a human answer: «5 kub» → 5, «10,5» → 10.5, «5-10» → 5.
 *
 * The ceiling is not politeness — `numeric(12,3)` holds nine integer digits,
 * and a customer pasting their PHONE into the kub box would otherwise abort
 * the whole landing with a database overflow. Out of range = no answer; the
 * text stays on the note where a person can read it.
 */
export const MAX_MEASURE = 100_000;

export function parseMeasure(raw: string | null | undefined): number | null {
  const text = (raw ?? '').replace(',', '.');
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value <= 0 || value >= MAX_MEASURE) return null;
  return value;
}

/** «Ha» / «yo'q» in the four languages the forms actually arrive in. */
const YES = new Set(['ha', 'bor', 'yes', 'да', 'есть', 'true', '1', '是', '有']);
const NO = new Set(['yo`q', "yo'q", 'yoq', 'net', 'no', 'нет', 'false', '0', '否', '没有']);

export function parseYesNo(raw: string | null | undefined): boolean | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (YES.has(text)) return true;
  if (NO.has(text)) return false;
  return null;
}

/**
 * A volume read from FREE TEXT — the routing fallback, so the /ariza door
 * («25 kub yuk bor» typed into the note box) is not structurally deaf to a
 * volume rule. Deliberately NOT used to fill the card's quote: a guess is
 * good enough to pick whose phone rings, not good enough to print on the
 * card as a fact.
 */
export function textVolume(...texts: (string | null | undefined)[]): number | null {
  const haystack = texts.filter(Boolean).join('\n');
  const match = haystack.match(/(\d+(?:[.,]\d+)?)\s*(?:kub|куб|m3|м3|m³|м³)/iu);
  return match ? parseMeasure(match[1]) : null;
}

/**
 * Apply the map to one arrival's pairs. Pure, never throws.
 *
 * `activeFieldIds` is the fence against a deactivated target: the write path
 * would store a value no card renders, silently, for ever — a mapping whose
 * field left the screen degrades to note-only instead.
 */
export function applyFieldMap(
  pairs: FieldPair[] | null,
  map: MapRow[],
  activeFieldIds: Set<string>,
): MappedAnswers {
  const out: MappedAnswers = { volumeM3: null, weightKg: null, custom: [] };
  if (!pairs?.length || !map.length) return out;
  const byKey = new Map(map.map((row) => [row.key, row]));
  for (const pair of pairs) {
    const rule = byKey.get(normalizeKey(pair.key));
    if (!rule) continue;
    if (rule.target === 'kub') out.volumeM3 ??= parseMeasure(pair.value);
    else if (rule.target === 'kg') out.weightKg ??= parseMeasure(pair.value);
    else if (rule.target === 'field' && rule.fieldId && activeFieldIds.has(rule.fieldId)) {
      out.custom.push({ fieldId: rule.fieldId, value: pair.value });
    }
    // 'note' is a stored decision with today's behavior: the line stays on
    // the lenta and the key stops nagging the unmapped list.
  }
  return out;
}

/** Every mapping, normalized for the pure half. */
export async function listFieldMap(): Promise<MapRow[]> {
  const rows = await db.select().from(leadFieldMap).orderBy(leadFieldMap.key);
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    target: row.target as MapRow['target'],
    fieldId: row.fieldId,
  }));
}

/**
 * Decide a key. Upsert by key — re-deciding is the ordinary move when an
 * agency reworded a form. A 'field' target must name an ACTIVE lead field of
 * a kind the mapper can write (text family or checkbox); re-derived here, not
 * trusted from the form (#531).
 */
export async function saveMapping(
  input: { key: string; target: MapRow['target']; fieldId?: string | null },
  ctx: AuditContext,
): Promise<void> {
  const key = normalizeKey(input.key);
  if (!key) throw new CrmError('key_required');
  let fieldId: string | null = null;
  if (input.target === 'field') {
    const [field] = await db
      .select({ id: customFields.id, type: customFields.type, active: customFields.active })
      .from(customFields)
      .where(and(eq(customFields.id, input.fieldId ?? ''), eq(customFields.entityType, 'lead')))
      .limit(1);
    if (!field || !field.active || !MAPPABLE_FIELD_TYPES.has(field.type)) {
      throw new CrmError('field_invalid');
    }
    fieldId = field.id;
  }
  const [row] = await db
    .insert(leadFieldMap)
    .values({ key, target: input.target, fieldId, createdBy: ctx.actorId ?? null })
    .onConflictDoUpdate({
      target: leadFieldMap.key,
      set: { target: input.target, fieldId, updatedAt: new Date() },
    })
    .returning({ id: leadFieldMap.id });
  // audit_log.entity_id is a uuid (round 19's lesson) — the ROW carries the
  // identity, the KEY goes in the payload where a person reads it.
  await writeAudit(db, ctx, {
    entityType: 'lead_field_map',
    entityId: row!.id,
    action: 'update',
    after: { key, target: input.target, fieldId },
  });
}

export async function deleteMapping(key: string, ctx: AuditContext): Promise<void> {
  const [row] = await db
    .delete(leadFieldMap)
    .where(eq(leadFieldMap.key, normalizeKey(key)))
    .returning({ id: leadFieldMap.id });
  if (!row) throw new CrmError('mapping_not_found');
  await writeAudit(db, ctx, {
    entityType: 'lead_field_map',
    entityId: row.id,
    action: 'delete',
    after: { key: normalizeKey(key) },
  });
}

/** The field kinds the mapper can honestly write from a text answer. */
export const MAPPABLE_FIELD_TYPES = new Set(['text', 'textarea', 'checkbox']);

export interface SeenKey {
  key: string;
  /** How many arrivals carried it in the window. */
  n: number;
  /** The newest answer, as the owner's reading aid. */
  sample: string;
}

/**
 * The question keys the adverts actually sent, newest sample per key, over
 * one grouped query (#432) — the screen's discovery list. The caller splits
 * mapped from unmapped; a MAPPED key's count doubles as the decay hint (a
 * mapping whose key stopped arriving is a mapping an agency's form edit
 * quietly retired — #12 of the design review).
 */
export async function seenKeys(sinceDays = 30): Promise<SeenKey[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await db
    .select({
      key: sql<string>`pair->>'key'`,
      n: sql<number>`count(*)`,
      sample: sql<string>`(array_agg(pair->>'value' ORDER BY ${leadIntakes.createdAt} DESC))[1]`,
    })
    .from(leadIntakes)
    .innerJoin(sql`LATERAL jsonb_array_elements(${leadIntakes.fields}) AS pair`, sql`true`)
    .where(and(gt(leadIntakes.createdAt, since), sql`${leadIntakes.fields} IS NOT NULL`))
    .groupBy(sql`pair->>'key'`)
    .orderBy(desc(sql`count(*)`));
  return rows
    .filter((row) => row.key)
    .map((row) => ({ key: row.key, n: Number(row.n), sample: row.sample ?? '' }));
}
