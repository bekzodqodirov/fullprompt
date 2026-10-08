import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { cardLink } from '../../platform/notifications/links';
import { fillVars, type NotificationLabels } from '../../platform/notifications/labels';
import { usersWithRoles, warehouseStaff } from '../../platform/notifications/service';
import type { CargoKind } from '../../platform/notifications/thread-ref';
import { roadWordOf, truckWordOf, type CargoPlace, type CargoStand } from '../inventory/stands';
import { CALC_THREAD_ERRORS, type CalcThreadError, type UnreachableReason } from './thread';
import type { ThreadFacts, ThreadReader } from './thread-door';

/**
 * The prixod's and the truck's staff thread (round 2, 0129 — the owner's E6
 * c warehouse half, E7 b, Q4 a): who it reaches, what its «📍» line says, and
 * where its ping links. The door is thread-door.ts's cargo arm; WHERE the
 * cargo stands is inventory/stands.ts; this module is the rest.
 *
 * Who hears a message (at SEND time, asked on EVERY send):
 *   - a writer who is NOT staff of a standing warehouse — a logist, an admin,
 *     a seller who was @-named and answers — asks the WAREHOUSE: the staff of
 *     every warehouse where the cargo stands (E6 c);
 *   - a writer who IS such staff asks the OFFICE: the logists, by role (the
 *     house way to reach the office — `usersWithRoles(['logist'])`). Not his
 *     colleagues at the same warehouse and not every admin: admins hear when
 *     they wrote in the thread or are @-named.
 * Past authors and mentions are internal-chat.ts's, and every candidate then
 * passes the door — so an operator who answered while the cargo stood at YW
 * stops hearing it the moment it stands only at TAS1 (Q4 a).
 */

/** Does this person write FROM the cargo — staff of a warehouse where it stands? Pure. */
export function writesFromStanding(author: ThreadReader | null, stand: CargoStand): boolean {
  return (
    author !== null && author.warehouseScoped && stand.warehouseIds.some((w) => author.warehouseIds.includes(w))
  );
}

export type CargoArms =
  /** E6 c: the office asks the warehouse — the staff of each standing warehouse (empty list = nobody assigned there). */
  | { to: 'staff'; byWarehouse: Map<string, string[]> }
  /** The warehouse asks the office — the logists by role. */
  | { to: 'office'; ids: string[] };

/** Whom a message from this author reaches by the cargo's own arm — before any door is asked. */
export async function cargoArms(author: ThreadReader | null, stand: CargoStand): Promise<CargoArms> {
  if (writesFromStanding(author, stand)) return { to: 'office', ids: await usersWithRoles(['logist']) };
  const byWarehouse = new Map<string, string[]>(stand.warehouseIds.map((w) => [w, []]));
  for (const row of await warehouseStaff(stand.warehouseIds)) byWarehouse.get(row.warehouseId)?.push(row.userId);
  return { to: 'staff', byWarehouse };
}

/** Every warehouse a stand's places name — its warehouses AND both ends of every truck (for the words). */
function namedWarehouses(stand: CargoStand): string[] {
  const out = new Set(stand.warehouseIds);
  for (const place of stand.places) {
    if ('originWarehouseId' in place) {
      out.add(place.originWarehouseId);
      out.add(place.destWarehouseId);
    }
  }
  return [...out];
}

/** The warehouses' short codes (TAS1, YW) — what every line about cargo prints. One statement. */
export async function warehouseCodes(ids: readonly string[]): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db.execute<{ id: string; code: string }>(sql`
    SELECT w.id::text AS id, w.code FROM warehouses w
     WHERE w.id IN (${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  return new Map(rows.map((row) => [row.id, row.code] as const));
}

/** What a cargo ping's frame needs, loaded ONCE per note by `announceNote`. */
export type CargoFraming = { stand: CargoStand; codes: ReadonlyMap<string, string> };

/** The frame of a cargo thread's pings, from its loaded facts — null for the CRM kinds. */
export async function cargoFramingOf(facts: ThreadFacts | null): Promise<CargoFraming | null> {
  if (!facts) return null;
  switch (facts.kind) {
    case 'receipt':
    case 'batch':
      return { stand: facts.stand, codes: await warehouseCodes(namedWarehouses(facts.stand)) };
    case 'lead':
    case 'deal':
    case 'client':
    case 'calc':
      return null;
    default: {
      const never: never = facts;
      void never;
      return null;
    }
  }
}

/**
 * THE place line — «📍 Yuk hozir: TAS1 — 12 kor. · yo‘lda YW → TAS1 — 5 kor.»
 * — the ONE formatter, asked by the web panel (in the page's language) and
 * the ping (in each recipient's), so the two cannot drift (cargo-thread-wire
 * K11). Pure; the words are labels.ts's. Nothing live is NEVER printed under
 * «Yuk hozir:» — that would read as a location. A warehouse with no code
 * prints «—»; an empty stand has no line.
 */
export function cargoNowLine(
  stand: CargoStand,
  codes: ReadonlyMap<string, string>,
  L: NotificationLabels,
): string | null {
  const code = (id: string) => codes.get(id) ?? '—';
  const live: string[] = [];
  const issued: string[] = [];
  const lost: string[] = [];
  let received: Extract<CargoPlace, { kind: 'received' }> | null = null;
  let truck: Extract<CargoPlace, { kind: 'truck' }> | null = null;
  for (const place of stand.places) {
    switch (place.kind) {
      case 'shelf':
        live.push(fillVars(L.cargoShelf, { code: code(place.warehouseId), n: place.boxes }));
        break;
      case 'road': {
        const vars = { from: code(place.originWarehouseId), to: code(place.destWarehouseId), n: place.boxes };
        const word = roadWordOf(place.truckStatus);
        live.push(
          fillVars(word === 'unloading' ? L.cargoUnloading : word === 'missing' ? L.cargoMissing : L.cargoRoad, vars),
        );
        break;
      }
      case 'issued':
        if (!issued.includes(code(place.warehouseId))) issued.push(code(place.warehouseId));
        break;
      case 'lost':
        if (!lost.includes(code(place.warehouseId))) lost.push(code(place.warehouseId));
        break;
      case 'received':
        received = place;
        break;
      case 'truck':
        truck = place;
        break;
      default: {
        const never: never = place;
        void never;
      }
    }
  }
  if (truck) return truckLine(truck, code, L);
  if (live.length > 0) return underNow(L, live.join(' · '));
  if (issued.length > 0 || lost.length > 0) {
    const parts = [
      ...(issued.length > 0 ? [fillVars(L.cargoIssuedAt, { codes: issued.join(', ') })] : []),
      ...(lost.length > 0 ? [fillVars(L.cargoLostAt, { codes: lost.join(', ') })] : []),
    ];
    return `${L.cargoNoneLive} — ${parts.join(' · ')}`;
  }
  if (received) {
    const at = code(received.warehouseId);
    switch (received.receiptStatus) {
      case 'draft':
        return fillVars(L.cargoDraft, { code: at });
      case 'voided':
        return fillVars(L.cargoVoided, { code: at });
      case 'confirmed':
        return `${L.cargoNoneLive} — ${fillVars(L.cargoReceivedAt, { code: at })}`;
      default: {
        const never: never = received.receiptStatus;
        void never;
        return null;
      }
    }
  }
  return null;
}

/**
 * «📍 Yuk hozir: …» — the label carries its own colon (`:` / `：`). A
 * full-width colon already holds its space, so zh-CN takes none after it
 * («📍 货物现在：TAS1», never «：␣TAS1»); every other language takes one.
 */
function underNow(L: NotificationLabels, text: string): string {
  return L.cargoNow.endsWith('：') ? `${L.cargoNow}${text}` : `${L.cargoNow} ${text}`;
}

/** The truck card's line, by `truckWordOf` — its own state, never the audience stage. */
function truckLine(
  truck: Extract<CargoPlace, { kind: 'truck' }>,
  code: (id: string) => string,
  L: NotificationLabels,
): string | null {
  const from = code(truck.originWarehouseId);
  const to = code(truck.destWarehouseId);
  const word = truckWordOf(truck.status, truck.aboard);
  switch (word) {
    case 'loading':
      return underNow(L, fillVars(L.truckLoading, { code: from }));
    case 'road':
      return underNow(L, fillVars(L.truckRoad, { from, to }));
    case 'unloading':
      return underNow(L, fillVars(L.truckUnloading, { code: to, n: truck.aboard }));
    case 'missing':
      return underNow(L, fillVars(L.truckMissing, { code: to, n: truck.aboard }));
    case 'arrived':
      return underNow(L, fillVars(L.truckArrived, { code: to }));
    case 'cancelled':
      return fillVars(L.truckCancelled, { code: from });
    case null:
      return null;
    default: {
      const never: never = word;
      void never;
      return null;
    }
  }
}

/**
 * A cargo ping's link: the card, at its «❓ Savol-javob» (`#ichki`) — the
 * truck's is its «Ichidagilar» tab, where the thread sits. Built HERE and not
 * in internal-chat.ts, which is fenced against `cardLink(` so every note link
 * there stays chosen per recipient (calc-card-door.test). Right AT SEND TIME
 * (inventory/stands.ts's subset property); once the cargo moves on, an older
 * ping to a warehouse the card no longer admits opens a 404 — stated.
 */
export function cargoThreadLink(ref: { kind: CargoKind; id: string }): string | null {
  const card = cardLink(ref.kind, ref.id);
  return card ? `${card}#ichki` : null;
}

/**
 * What the cargo box is told — here and not in the `'use server'` action
 * file, which may export async functions only. The writer's codes stay round
 * 1's; `cargo_moved` is the cargo's own (the scoped writer whose cargo left
 * between the render and the press). Every code is a `threads.cargo.errors.*`
 * key in all four bundles (cargo-thread-wire K10).
 */
export type CargoThreadError = CalcThreadError | 'cargo_moved';
export const CARGO_THREAD_ERRORS: readonly CargoThreadError[] = [...CALC_THREAD_ERRORS, 'cargo_moved'];

/** How many «won't hear it» rows the box lists before «… yana N kishi». */
export const CARGO_UNREACHABLE_CAP = 5;

export interface CargoThreadState {
  ok?: boolean;
  error?: CargoThreadError;
  /** The arm's people who will not hear it in Telegram, and why (round 1's reasons). */
  unreachable?: { name: string; reason: UnreachableReason }[];
  unreachableMore?: number;
  /** Standing warehouses with NOBODY assigned — «the message did not go THERE» (codes). */
  noStaffAt?: string[];
  /** A warehouse writer's message reached no logist. */
  noOffice?: boolean;
  /** Nobody at all was sent it in Telegram — it is on the card only. */
  nobody?: boolean;
  /** The check of who will hear it failed after the save: the lists above are empty because nobody looked. */
  reachUnknown?: boolean;
  /** A fresh value on every success, so the box clears exactly once per send. */
  sent?: number;
}
