import { getTableColumns, getTableName } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * What the analyst model is told about the database.
 *
 * The INVENTORY is generated from the Drizzle schema at module load, so a
 * column added next month is in the card the same day and a hand-written list
 * can never rot into hallucinated columns. Only the TRAP PROSE is written by
 * hand — the house rules a correct-looking query silently breaks — and the
 * allowlist itself, which must match migration 0079's GRANT statement
 * word for word (`tests/unit/ai-schema-card.test.ts` reads the migration and
 * says so).
 */

/** Every table the role may read, keyed by its SQL name — 0079's allowlist. */
export const ANALYST_TABLES: Record<string, AnyPgTable> = Object.fromEntries(
  (
    [
      schema.warehouses, schema.clients, schema.receipts, schema.receiptLots,
      schema.boxes, schema.crates, schema.batches, schema.boxMovements,
      schema.scanEvents, schema.loadPlans, schema.loadPlanVersions,
      schema.loadPlanLines, schema.handovers, schema.expectedArrivals,
      schema.clientNotices, schema.attachments, schema.costTypes,
      schema.costEntries, schema.costAllocations, schema.expenses,
      schema.expenseCategories, schema.recurringExpenses, schema.moneyAccounts,
      schema.accountTransfers, schema.clientTransactions, schema.fxRates,
      schema.currencies, schema.partners, schema.partnerTypes,
      schema.partnerTransactions, schema.issueApprovals, schema.leads,
      schema.leadStages, schema.deals, schema.dealStages, schema.dealLines,
      schema.leadIntakes, schema.inboundRoutes, schema.leadFieldMap,
      schema.lostReasons, schema.crmActivities, schema.crmPeople, schema.tasks,
      schema.taskTypes, schema.tnvedAssignments, schema.productDictionary,
      schema.truckPresets, schema.driverPositions, schema.callLogs,
      schema.tgMessages, schema.tgChatRules, schema.customEntities,
      schema.customFields, schema.customFieldValues, schema.customRecords,
      schema.calcRequests, schema.automationRules, schema.automationFires,
    ] as AnyPgTable[]
  ).map((table) => [getTableName(table), table]),
);

/**
 * Tables that must NEVER be granted — credentials, session blobs, and the
 * blobs that may CONTAIN them (audit_log's before/after). The unit test
 * asserts none of these appears in 0079's GRANT and the integration test
 * asserts the live role holds zero privilege on them.
 */
export const EXCLUDED_TABLES = [
  'sessions', 'login_attempts', 'tg_accounts', 'telegram_links',
  'client_telegram_links', 'driver_devices', 'call_recorder_devices',
  'tg_peer_index', 'tg_outbox', 'audit_log', 'settings', 'ai_questions',
] as const;

/** Column-granted tables: the row is business data, one column is a secret. */
export const USERS_GRANTED_COLUMNS = [
  'id', 'phone', 'username', 'full_name', 'locale', 'active', 'created_at',
  'updated_at', 'muted_notification_types', 'inbound_rota',
] as const;
export const LEAD_SOURCES_GRANTED_COLUMNS = [
  'id', 'name', 'sort_order', 'active', 'created_at', 'key',
] as const;

const TRAPS = `Правила этой базы — запрос, который их нарушает, вернёт правдоподобную ЛОЖЬ:
- ДЕНЬГИ НЕ СКЛАДЫВАЮТ из сырых колонок. Долг клиента — только view v_client_balance_usd(client_id, balance_usd). Приход/расход денег и остатки касс — только инструменты cash_flow и company_balance. Отсрочки, партнёрские платежи, курсы и закрытые кассы делают ручную сумму неверной без единой ошибки SQL. Если вопрос о деньгах не решается этими тремя — скажи, что надёжного ответа нет.
- Аннулированные строки исключай ВСЕГДА: cost_entries.voided_at IS NULL, client_transactions.voided_at IS NULL, partner_transactions.voided_at IS NULL.
- Что ехало в машине (batches) — через box_movements (ref_type='batch', ref_id=batches.id, cause='batch_departed'), НИКОГДА через boxes.current_batch_id: разгрузка обнуляет его, у прибывшей машины он пуст.
- leads/deals: справочники стадий lead_stages/deal_stages несут kind ('open'/'won'/'lost'); created_at — когда обратился, closed_at — когда решили; месяц продаж считают по closed_at.
- numeric приходит СТРОКОЙ — приводи ::numeric при арифметике в выводе не нужно, но сравнивай числа в SQL, не в голове.
- users и lead_sources: выбирай ТОЛЬКО именованные колонки (SELECT * там запрещён правами).
- День компании — Asia/Tashkent: для «сегодня/за месяц» считай границы дня в этой зоне.
- Ответ обрезается на ${'{ROW_CAP}'} строках — агрегируй в SQL, не тяни сырьё.`;

/** The whole system-prompt block for the run_sql tool, generated + traps. */
export function schemaCard(rowCap: number): string {
  const lines: string[] = [];
  for (const [name, table] of Object.entries(ANALYST_TABLES)) {
    const cols = Object.values(getTableColumns(table)).map((c) => c.name);
    lines.push(`${name}(${cols.join(', ')})`);
  }
  // Column-granted tables and the view are described by hand: their granted
  // column set is narrower than the schema's, and the card must offer only
  // what the role can actually read.
  lines.push(`users(${USERS_GRANTED_COLUMNS.join(', ')})`);
  lines.push(`lead_sources(${LEAD_SOURCES_GRANTED_COLUMNS.join(', ')})`);
  lines.push(`v_client_balance_usd(client_id, balance_usd)  -- ЕДИНСТВЕННЫЙ источник долга клиента`);
  return `Таблицы (PostgreSQL 16, только SELECT):\n${lines.join('\n')}\n\n${TRAPS.replace('{ROW_CAP}', String(rowCap))}`;
}
