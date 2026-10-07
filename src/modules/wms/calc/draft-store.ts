import { isBazaBasis, type BazaBasis } from './pricing';
import {
  baseFieldsFor,
  ghostDirty,
  ghostToItemDraft,
  q3,
  q4,
  sameNumber,
  syncBase,
  type BaseField,
  type DraftItem,
  type ItemDraft,
  type NewRow,
  type RowBase,
} from './row-draft';

/**
 * His B5 a — «yopsangiz yoki sahifa yangilansa ham saqlanmagan o'zgarishlar
 * qoladi: qayta ochganda "Saqlanmagan o'zgarishlar bor — tiklaymi?"».
 *
 * localStorage and not sessionStorage: his words are «close OR refresh», and a
 * closed tab takes sessionStorage with it. The house precedent is the receive
 * wizard and the lot-composition panel — every access in try/catch (a private
 * window throws) and a restore that waits for mount (hydration).
 *
 * The key carries the VIEWER and the request and NOT the rev: the rev moves on
 * every ✅, certificate and save (and the machine's own sweep after landing),
 * so a rev in the key would refuse almost every restore — the per-field base
 * comparison below is the real guard. The viewer keeps another login on the
 * same browser from ever seeing, or posting under its own name, somebody
 * else's half-typed price.
 *
 * Nothing here is ever applied by itself: `planRestore` says what COULD come
 * back, and a person answers «Tiklash» or «Yo'q».
 */

export const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

export const draftStorageKey = (viewerId: string, requestId: string) =>
  `gsr.calc-draft.v1:${viewerId}:${requestId}`;

export interface StoredDrafts {
  v: 1;
  savedAt: string;
  rows: Record<string, { draft: ItemDraft; base: RowBase }>;
  /** Dirty ghosts only, WITH their client id and note. */
  ghosts: NewRow[];
}

export interface LiveDrafts {
  drafts: Record<string, ItemDraft>;
  bases: Record<string, RowBase>;
  newRows: NewRow[];
}

/** The live state as it is stored — null when there is nothing to keep. */
export function serializeDrafts(live: LiveDrafts, now: Date): StoredDrafts | null {
  const rows: StoredDrafts['rows'] = {};
  for (const [id, draft] of Object.entries(live.drafts)) {
    if (Object.keys(draft).length === 0) continue;
    rows[id] = { draft, base: live.bases[id] ?? {} };
  }
  const ghosts = live.newRows.filter(ghostDirty);
  if (Object.keys(rows).length === 0 && ghosts.length === 0) return null;
  return { v: 1, savedAt: now.toISOString(), rows, ghosts };
}

const DRAFT_STRING_KEYS = [
  'name',
  'quantity',
  'weightKg',
  'volumeM3',
  'tnvedCode',
  'note',
  'measure',
  'bazaValue',
  'importRowId',
] as const;
const BASE_NUMBER_KEYS = ['quantity', 'weightKg', 'volumeM3', 'measureQty', 'bazaUsd'] as const;
const BASE_TEXT_KEYS = ['label', 'tnvedCode', 'note', 'measureUnit'] as const;
const GHOST_STRING_KEYS = [
  'name',
  'quantity',
  'unit',
  'weightKg',
  'volumeM3',
  'tnvedCode',
  'measure',
  'bazaValue',
  'note',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseDraft(raw: unknown): ItemDraft | null {
  if (!isRecord(raw)) return null;
  const out: ItemDraft = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'bazaBasis') {
      if (typeof v !== 'string' || !isBazaBasis(v)) return null;
      out.bazaBasis = v;
    } else if ((DRAFT_STRING_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'string') return null;
      (out as Record<string, string>)[k] = v;
    } else return null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseBase(raw: unknown): RowBase | null {
  if (!isRecord(raw)) return null;
  const out: RowBase = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((BASE_NUMBER_KEYS as readonly string[]).includes(k)) {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return null;
    } else if ((BASE_TEXT_KEYS as readonly string[]).includes(k)) {
      if (v !== null && typeof v !== 'string') return null;
    } else if (k === 'bazaBasis') {
      if (v !== null && (typeof v !== 'string' || !isBazaBasis(v))) return null;
    } else return null;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function parseGhost(raw: unknown): NewRow | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.key !== 'number' || !Number.isFinite(raw.key)) return null;
  if (raw.clientId !== null && typeof raw.clientId !== 'string') return null;
  const basis = raw.bazaBasis;
  if (basis !== null && (typeof basis !== 'string' || !isBazaBasis(basis))) return null;
  const row = {
    key: raw.key,
    clientId: raw.clientId as string | null,
    bazaBasis: basis as BazaBasis | null,
  } as NewRow;
  for (const k of GHOST_STRING_KEYS) {
    const v = raw[k] ?? '';
    if (typeof v !== 'string') return null;
    (row as unknown as Record<string, string>)[k] = v;
  }
  return row;
}

/**
 * Read a stored entry back — shape-validated, so a blob written by an older
 * build, edited by hand or truncated is NOTHING rather than a throw or a draft
 * the screen cannot render. Older than 72 hours: nothing. A row whose base
 * lacks a field its draft stands on is dropped — without a base there is no
 * way to tell a colleague's change from the VED's own.
 */
export function parseStoredDrafts(raw: string | null, now: number): StoredDrafts | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.v !== 1 || typeof data.savedAt !== 'string') return null;
  const savedAt = Date.parse(data.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt > DRAFT_TTL_MS || savedAt - now > DRAFT_TTL_MS)
    return null;
  if (!isRecord(data.rows) || !Array.isArray(data.ghosts)) return null;
  const rows: StoredDrafts['rows'] = {};
  for (const [id, entry] of Object.entries(data.rows)) {
    if (!isRecord(entry)) continue;
    const draft = parseDraft(entry.draft);
    const base = parseBase(entry.base);
    if (!draft || !base) continue;
    const needed = (Object.keys(draft) as (keyof ItemDraft)[]).flatMap((k) => baseFieldsFor(k));
    if (needed.some((f) => !(f in base))) continue;
    rows[id] = { draft, base };
  }
  const ghosts = data.ghosts
    .map(parseGhost)
    .filter((g): g is NewRow => g !== null && ghostDirty(g));
  if (Object.keys(rows).length === 0 && ghosts.length === 0) return null;
  return { v: 1, savedAt: data.savedAt, rows, ghosts };
}

/**
 * What to WRITE while the restore question stands (D7's ref-gated write): the
 * stored entry is not thrown away by the first empty render, and new typing
 * is kept even if he never answers. A live draft on a row replaces the stored
 * one for that row; a live ghost replaces a stored ghost with its client id.
 */
export function mergeForStorage(
  stored: StoredDrafts | null,
  live: StoredDrafts | null,
): StoredDrafts | null {
  if (!stored) return live;
  if (!live) return stored;
  const liveIds = new Set(
    live.ghosts.map((g) => g.clientId).filter((v): v is string => v !== null),
  );
  return {
    v: 1,
    savedAt: live.savedAt,
    rows: { ...stored.rows, ...live.rows },
    ghosts: [
      ...stored.ghosts.filter((g) => g.clientId === null || !liveIds.has(g.clientId)),
      ...live.ghosts,
    ],
  };
}

/** Storage-like, so the tests can hand in one that throws. */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readStored(storage: StorageLike | null, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Writes the entry (null removes it); true only when the storage took it. */
export function writeStored(
  storage: StorageLike | null,
  key: string,
  value: StoredDrafts | null,
): boolean {
  try {
    if (!storage) return false;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function forgetStored(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* nothing to forget */
  }
}

/* ------------------------------------------------------------------ */
/* What can come back                                                  */
/* ------------------------------------------------------------------ */

/** The draft field groups a restore judges as one thing each. */
type Group =
  'name' | 'tnvedCode' | 'quantity' | 'weightKg' | 'volumeM3' | 'note' | 'measure' | 'baza';
const GROUP_KEYS: Record<Group, (keyof ItemDraft)[]> = {
  name: ['name'],
  tnvedCode: ['tnvedCode'],
  quantity: ['quantity'],
  weightKg: ['weightKg'],
  volumeM3: ['volumeM3'],
  note: ['note'],
  measure: ['measure'],
  baza: ['bazaValue', 'bazaBasis', 'importRowId'],
};
const GROUP_FIELD: Record<Group, SkippedField> = {
  name: 'name',
  tnvedCode: 'code',
  quantity: 'qty',
  weightKg: 'kg',
  volumeM3: 'm3',
  note: 'note',
  measure: 'measure',
  baza: 'baza',
};
export type SkippedField = 'name' | 'code' | 'qty' | 'kg' | 'm3' | 'note' | 'measure' | 'baza';

export interface SkippedRow {
  seq: number;
  field: SkippedField;
  before: string;
  after: string;
}

export interface RestorePlan {
  rows: Record<string, { draft: ItemDraft; base: RowBase }>;
  ghosts: NewRow[];
  skipped: SkippedRow[];
  /** Rows and ghosts whose every drafted cell the server already holds —
   * his own save landed before the tab died, never «boshqa kishi». */
  alreadySaved: number;
  /** Rows that are gone (deleted meanwhile). */
  dropped: number;
}

export const restorableCount = (plan: RestorePlan | null) =>
  plan ? Object.keys(plan.rows).length + plan.ghosts.length : 0;

/** Restore needs the screen's unit for a row — the caller's `screenRowOf`. */
export type ScreenBasisOf<I extends DraftItem = DraftItem> = (item: I) => BazaBasis | null;

const showValue = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

function groupsOf(draft: ItemDraft): Group[] {
  return (Object.keys(GROUP_KEYS) as Group[]).filter((g) =>
    GROUP_KEYS[g].some((k) => draft[k] !== undefined),
  );
}

/** Does the server hold what this group of the draft says? */
function draftHeld<I extends DraftItem>(
  group: Group,
  draft: ItemDraft,
  item: I,
  screenBasis: ScreenBasisOf<I>,
): boolean {
  switch (group) {
    case 'name':
      return draft.name!.trim() === item.label.trim();
    case 'tnvedCode':
      return draft.tnvedCode!.trim() === (item.tnvedCode ?? '');
    case 'note':
      return draft.note!.trim() === (item.note ?? '');
    case 'quantity':
    case 'weightKg':
    case 'volumeM3':
      return sameNumber(draft[group]!, item[group], q3);
    case 'measure':
      return sameNumber(draft.measure!, item.measureQty, q4);
    case 'baza': {
      const value = draft.bazaValue ?? (item.bazaUsd === null ? '' : String(item.bazaUsd));
      if (!sameNumber(value, item.bazaUsd, q4)) return false;
      return draft.bazaBasis === undefined || draft.bazaBasis === screenBasis(item);
    }
  }
}

/** Did the stored row move under this group since it was typed over? */
function baseMoved(group: Group, base: RowBase, item: DraftItem): boolean {
  const fields = GROUP_KEYS[group].flatMap((k) => baseFieldsFor(k));
  return [...new Set(fields)].some((f: BaseField) => {
    const a = (base as Record<string, unknown>)[f] ?? null;
    const b = item[f] ?? null;
    if (typeof a === 'string' || typeof b === 'string')
      return String(a ?? '').trim() !== String(b ?? '').trim();
    return a !== b;
  });
}

/** What the VED typed over, as a person reads it. */
function baseText(group: Group, base: RowBase): string {
  switch (group) {
    case 'name':
      return showValue(base.label);
    case 'measure':
      return showValue(base.measureQty);
    case 'baza':
      return showValue(base.bazaUsd);
    default:
      return showValue(base[group]);
  }
}

function serverText(group: Group, item: DraftItem): string {
  switch (group) {
    case 'name':
      return showValue(item.label);
    case 'tnvedCode':
      return showValue(item.tnvedCode);
    case 'measure':
      return showValue(item.measureQty);
    case 'baza':
      return showValue(item.bazaUsd);
    default:
      return showValue(item[group]);
  }
}

/**
 * Judge a stored entry against the workspace as it is NOW — never applied by
 * itself. Per stored row:
 *  - its item is gone → dropped;
 *  - every drafted cell already equals the stored value → alreadySaved (his
 *    own save landed; nothing to blame on anybody);
 *  - a drafted cell whose stored value differs from BOTH what it was typed
 *    over and what was typed → the whole row is skipped and NAMED — a
 *    colleague changed it, and restoring would overwrite them unseen;
 *  - otherwise restorable, carrying only the cells the server still lacks,
 *    with the bases they were typed over.
 * Ghosts: one whose client id is not a row comes back as it was, SAME id —
 * a retry is then still an edit of whatever a lost save wrote; one whose id
 * IS a row becomes that row's draft of what differs (stored mode), or is
 * already saved.
 */
export function planRestore<I extends DraftItem>(
  stored: StoredDrafts,
  items: Map<string, I>,
  screenBasis: ScreenBasisOf<I>,
): RestorePlan {
  const plan: RestorePlan = { rows: {}, ghosts: [], skipped: [], alreadySaved: 0, dropped: 0 };
  for (const [id, { draft, base }] of Object.entries(stored.rows)) {
    const item = items.get(id);
    if (!item) {
      plan.dropped += 1;
      continue;
    }
    const groups = groupsOf(draft);
    const held = groups.filter((g) => draftHeld(g, draft, item, screenBasis));
    if (held.length === groups.length) {
      plan.alreadySaved += 1;
      continue;
    }
    const moved = groups.filter((g) => !held.includes(g) && baseMoved(g, base, item));
    if (moved.length > 0) {
      for (const g of moved) {
        plan.skipped.push({
          seq: item.seq,
          field: GROUP_FIELD[g],
          before: baseText(g, base),
          after: serverText(g, item),
        });
      }
      continue;
    }
    const kept: ItemDraft = {};
    for (const g of groups) {
      if (held.includes(g)) continue;
      for (const k of GROUP_KEYS[g])
        if (draft[k] !== undefined) (kept as Record<string, unknown>)[k] = draft[k];
    }
    const keptBase: RowBase = {};
    for (const k of Object.keys(kept) as (keyof ItemDraft)[]) {
      for (const f of baseFieldsFor(k))
        (keptBase as Record<string, unknown>)[f] = (base as Record<string, unknown>)[f];
    }
    plan.rows[id] = { draft: kept, base: keptBase };
  }
  for (const ghost of stored.ghosts) {
    const item = ghost.clientId !== null ? items.get(ghost.clientId) : undefined;
    if (!item) {
      plan.ghosts.push(ghost);
      continue;
    }
    const draft = ghostToItemDraft(ghost, item, 'stored');
    if (Object.keys(draft).length === 0) {
      plan.alreadySaved += 1;
      continue;
    }
    const existing = plan.rows[item.id];
    const merged: ItemDraft = { ...draft, ...(existing?.draft ?? {}) };
    // The new cells stand on what the row holds NOW (D3 rule 2).
    plan.rows[item.id] = { draft: merged, base: syncBase(existing?.base, merged, item) ?? {} };
  }
  return plan;
}
