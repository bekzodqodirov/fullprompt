import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  dealStages,
  deals,
  leadStages,
  leads,
  partners,
  receiptLots,
  receipts,
} from '../../platform/db/schema';
import { inScope, warehouseScope, warehouseScopeEither } from '../../platform/rbac/scope';
import { canWriteDeal } from '../deals/service';
import { likeNeedle, parseQuery } from './query';
import { mayReadBatches } from '../batches/read-door';

/**
 * One search box for the whole system.
 *
 * THE RULE, inherited from the staff bot (`wms/bot/lookup.ts`): a search that
 * finds more than the screens do is a back door. Every group below asks the
 * same question its own screen asks — the warehouse fence for cargo, the
 * funnel's own ownership rule for leads and deals, `finance.view` for
 * counterparties — and a group the actor may not have is not queried at all
 * rather than queried and hidden.
 *
 * What this deliberately never returns is MONEY. A balance, a quote and a
 * debt each live behind their own permission on their own screen; a result
 * row exists to get somebody to a card, not to answer a question about it.
 */

export type SearchKind =
  | 'client'
  | 'lead'
  | 'deal'
  | 'batch'
  | 'partner'
  | 'box'
  | 'receipt'
  | 'lot';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** The bold part: a code, a number, the thing somebody typed. */
  code: string;
  /** The quiet part: a name, a product, a status. */
  label?: string;
  href: string;
}

export interface SearchActor {
  id: string;
  permissions: Set<string>;
  warehouseScoped: boolean;
  warehouseIds: string[];
}

/** Per group, so one crowded group cannot crowd the others out. */
const PER_GROUP = 6;

export async function globalSearch(actor: SearchActor, raw: string): Promise<SearchHit[]> {
  const parsed = parseQuery(raw);
  if (!parsed.ok) return [];
  const like = likeNeedle(parsed.text);

  // The lot form is unambiguous, so it answers alone — `GS777-A` is not a
  // client whose name happens to contain a dash.
  if (parsed.lot) {
    const rows = await db
      .select({
        id: receiptLots.id,
        letter: receiptLots.letter,
        zh: receiptLots.productNameZh,
        ru: receiptLots.productNameRu,
        clientCode: clients.clientCode,
      })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .innerJoin(clients, eq(receipts.clientId, clients.id))
      .where(
        and(
          eq(clients.clientCode, parsed.lot.clientCode),
          eq(receiptLots.letter, parsed.lot.letter),
          ...scopeOf(warehouseScope(actor, receipts.warehouseId)),
        ),
      )
      .limit(PER_GROUP);
    return rows.map((row) => ({
      kind: 'lot' as const,
      id: row.id,
      code: `${row.clientCode}-${row.letter}`,
      label: [row.zh, row.ru].filter(Boolean).join(' · '),
      href: `/stock?lot=${row.id}`,
    }));
  }

  const [clientHits, leadHits, dealHits, batchHits, partnerHits, boxHits, receiptHits, lotHits] =
    await Promise.all([
      searchClients(actor, like, parsed.phone),
      searchLeads(actor, like, parsed.phone),
      searchDeals(actor, like),
      searchBatches(actor, like),
      searchPartners(actor, like, parsed.phone),
      searchBoxes(actor, like),
      searchReceipts(actor, like),
      searchLots(actor, like),
    ]);

  // Order is a judgement about what people look for: a person or a job first,
  // the physical cargo after it.
  return [
    ...clientHits,
    ...leadHits,
    ...dealHits,
    ...batchHits,
    ...partnerHits,
    ...lotHits,
    ...boxHits,
    ...receiptHits,
  ];
}

/** `warehouseScope` returns undefined for an unscoped actor; drop it then. */
function scopeOf(filter: SQL | undefined): SQL[] {
  return filter ? [filter] : [];
}

/**
 * Clients stay open to anyone signed in, as they have been since the screen
 * shipped: a warehouse operator with a box in his hand needs the code, and
 * narrowing that is an access decision for the owner, not a side effect of
 * this round. No balance is selected, so the row says who, never how much.
 */
async function searchClients(
  actor: SearchActor,
  like: string,
  phone?: string,
): Promise<SearchHit[]> {
  const byPhone = phone
    ? sql` OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${clients.phones}) AS p
        WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), 9) = ${phone}
      )`
    : sql``;
  const rows = await db
    .select({ id: clients.id, code: clients.clientCode, name: clients.name })
    .from(clients)
    .where(sql`(${clients.clientCode} ILIKE ${like} OR ${clients.name} ILIKE ${like}${byPhone})`)
    .orderBy(asc(clients.clientCode))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'client' as const,
    id: row.id,
    code: row.code,
    label: row.name,
    href: canOpenClientCard(actor) ? `/admin/clients/${row.id}` : `/stock?client=${row.id}`,
  }));
}

function canOpenClientCard(actor: SearchActor): boolean {
  return actor.permissions.has('clients.manage');
}

/**
 * The funnel's own rule, restated: you see your own leads unless you hold
 * `crm.leads.view_all`. The board starts on «mine» even for the owner, and a
 * search that ignored that would be the wider read the bot's comment warns of.
 */
async function searchLeads(
  actor: SearchActor,
  like: string,
  phone?: string,
): Promise<SearchHit[]> {
  if (!actor.permissions.has('crm.leads')) return [];
  const own = actor.permissions.has('crm.leads.view_all')
    ? []
    : [eq(leads.ownerId, actor.id)];
  const match = phone
    ? sql`(${leads.name} ILIKE ${like} OR ${leads.company} ILIKE ${like} OR right(regexp_replace(coalesce(${leads.phone}, ''), '[^0-9]', '', 'g'), 9) = ${phone})`
    : sql`(${leads.name} ILIKE ${like} OR ${leads.company} ILIKE ${like})`;
  const rows = await db
    .select({ id: leads.id, name: leads.name, company: leads.company, stage: leadStages.name })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(and(match, ...own))
    .orderBy(desc(leads.createdAt))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'lead' as const,
    id: row.id,
    code: row.name,
    label: [row.company, row.stage].filter(Boolean).join(' · '),
    href: `/crm/leads/${row.id}`,
  }));
}

async function searchDeals(actor: SearchActor, like: string): Promise<SearchHit[]> {
  if (!canWriteDeal(actor.permissions)) return [];
  const own = actor.permissions.has('crm.leads.view_all') ? [] : [eq(deals.ownerId, actor.id)];
  const rows = await db
    .select({
      id: deals.id,
      code: deals.code,
      title: deals.title,
      clientCode: clients.clientCode,
      stage: dealStages.name,
    })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .innerJoin(clients, eq(deals.clientId, clients.id))
    .where(
      and(
        sql`(${deals.code} ILIKE ${like} OR ${deals.title} ILIKE ${like} OR ${clients.clientCode} ILIKE ${like})`,
        ...own,
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'deal' as const,
    id: row.id,
    code: row.code,
    label: [row.clientCode, row.title, row.stage].filter(Boolean).join(' · '),
    href: `/bitimlar/${row.id}`,
  }));
}

async function searchBatches(actor: SearchActor, like: string): Promise<SearchHit[]> {
  // The batches screen's own door, shared with /transit, /trucks and /map —
  // it was copied here first and restated twice more before it became one
  // list (wms/batches/read-door.ts).
  if (!mayReadBatches(actor.permissions)) return [];
  const scope = warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId);
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      plate: batches.vehiclePlate,
      status: batches.status,
    })
    .from(batches)
    .where(
      and(
        sql`(${batches.code} ILIKE ${like} OR ${batches.vehiclePlate} ILIKE ${like} OR ${batches.driverName} ILIKE ${like})`,
        ...scopeOf(scope),
      ),
    )
    .orderBy(desc(batches.createdAt))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'batch' as const,
    id: row.id,
    code: row.code,
    label: [row.plate, row.status].filter(Boolean).join(' · '),
    href: `/batches/${row.id}`,
  }));
}

/** Counterparties are money, so the money gate decides they exist at all. */
async function searchPartners(
  actor: SearchActor,
  like: string,
  phone?: string,
): Promise<SearchHit[]> {
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
    return [];
  }
  const match = phone
    ? sql`(${partners.name} ILIKE ${like} OR right(regexp_replace(coalesce(${partners.phone}, ''), '[^0-9]', '', 'g'), 9) = ${phone})`
    : sql`${partners.name} ILIKE ${like}`;
  const rows = await db
    .select({ id: partners.id, name: partners.name, active: partners.active })
    .from(partners)
    .where(match)
    .orderBy(desc(partners.active), asc(partners.name))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'partner' as const,
    id: row.id,
    code: row.name,
    href: `/kontragentlar/${row.id}`,
  }));
}

/**
 * A box in transit belongs to no warehouse, so it is judged by its batch's
 * TWO ends — the same rule the bot's box branch uses. Fetching wider and
 * filtering here keeps that rule in one readable place; the codes are near
 * enough unique that the over-fetch is a handful of rows.
 */
async function searchBoxes(actor: SearchActor, like: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: boxes.id,
      code: boxes.shortCode,
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      origin: batches.originWarehouseId,
      dest: batches.destWarehouseId,
    })
    .from(boxes)
    .leftJoin(batches, eq(boxes.currentBatchId, batches.id))
    .where(sql`${boxes.shortCode} ILIKE ${like}`)
    .orderBy(asc(boxes.shortCode))
    .limit(PER_GROUP * 5);

  return rows
    .filter(
      (row) =>
        inScope(actor, row.warehouseId) ||
        inScope(actor, row.origin) ||
        inScope(actor, row.dest),
    )
    .slice(0, PER_GROUP)
    .map((row) => ({
      kind: 'box' as const,
      id: row.id,
      code: row.code,
      label: row.status,
      href: `/boxes/${row.id}`,
    }));
}

async function searchReceipts(actor: SearchActor, like: string): Promise<SearchHit[]> {
  const rows = await db
    .select({ id: receipts.id, number: receipts.number, code: clients.clientCode })
    .from(receipts)
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        sql`${receipts.number} ILIKE ${like}`,
        ...scopeOf(warehouseScope(actor, receipts.warehouseId)),
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'receipt' as const,
    id: row.id,
    code: row.number ?? '—',
    label: row.code ?? undefined,
    href: `/receipts/${row.id}`,
  }));
}

async function searchLots(actor: SearchActor, like: string): Promise<SearchHit[]> {
  const rows = await db
    .select({
      id: receiptLots.id,
      letter: receiptLots.letter,
      zh: receiptLots.productNameZh,
      ru: receiptLots.productNameRu,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        sql`(${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like})`,
        ...scopeOf(warehouseScope(actor, receipts.warehouseId)),
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(PER_GROUP);
  return rows.map((row) => ({
    kind: 'lot' as const,
    id: row.id,
    code: `${row.clientCode ?? row.marking ?? '❓'}-${row.letter ?? ''}`,
    label: [row.zh, row.ru].filter(Boolean).join(' · '),
    href: `/stock?lot=${row.id}`,
  }));
}
