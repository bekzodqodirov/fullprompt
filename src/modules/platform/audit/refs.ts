import { inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  clients,
  dealStages,
  deals,
  leadSources,
  leadStages,
  partners,
  users,
  warehouses,
} from '../db/schema';
import type { AuditRefKind } from './fields';

/**
 * The names behind the ids an audit trail recorded (round 100, item 4).
 *
 * One `inArray` select per domain the page actually touches — a history of
 * pure note edits asks nothing. The answer is one flat uuid → label map,
 * which is safe because uuids do not collide across tables; a miss stays out
 * of the map and the caller prints the raw value (a deleted stage's id is
 * still the truth about what happened).
 *
 * `stage` reads BOTH funnels' tables: the audit row does not say which board
 * it came from, and an id can only match in one of them.
 */
export async function resolveAuditRefs(
  wanted: Map<AuditRefKind, Set<string>>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (kind: AuditRefKind) => [...(wanted.get(kind) ?? [])];

  const jobs: Promise<void>[] = [];
  const stageIds = ids('stage');
  if (stageIds.length) {
    jobs.push(
      db
        .select({ id: leadStages.id, name: leadStages.name })
        .from(leadStages)
        .where(inArray(leadStages.id, stageIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.name))),
      db
        .select({ id: dealStages.id, name: dealStages.name })
        .from(dealStages)
        .where(inArray(dealStages.id, stageIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.name))),
    );
  }
  const userIds = ids('user');
  if (userIds.length) {
    jobs.push(
      db
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, userIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.name))),
    );
  }
  const clientIds = ids('client');
  if (clientIds.length) {
    jobs.push(
      db
        .select({ id: clients.id, code: clients.clientCode, name: clients.name })
        .from(clients)
        .where(inArray(clients.id, clientIds))
        // The code is the identity everywhere else; the name says who.
        .then((rows) => rows.forEach((row) => out.set(row.id, `${row.code} · ${row.name}`))),
    );
  }
  const warehouseIds = ids('warehouse');
  if (warehouseIds.length) {
    jobs.push(
      db
        .select({ id: warehouses.id, code: warehouses.code })
        .from(warehouses)
        .where(inArray(warehouses.id, warehouseIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.code))),
    );
  }
  const sourceIds = ids('source');
  if (sourceIds.length) {
    jobs.push(
      db
        .select({ id: leadSources.id, name: leadSources.name })
        .from(leadSources)
        .where(inArray(leadSources.id, sourceIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.name))),
    );
  }
  const dealIds = ids('deal');
  if (dealIds.length) {
    jobs.push(
      db
        .select({ id: deals.id, code: deals.code })
        .from(deals)
        .where(inArray(deals.id, dealIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.code))),
    );
  }
  const partnerIds = ids('partner');
  if (partnerIds.length) {
    jobs.push(
      db
        .select({ id: partners.id, name: partners.name })
        .from(partners)
        .where(inArray(partners.id, partnerIds))
        .then((rows) => rows.forEach((row) => out.set(row.id, row.name))),
    );
  }
  await Promise.all(jobs);
  return out;
}
