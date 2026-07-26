import ExcelJS from 'exceljs';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { listFields } from '@/modules/platform/fields/service';
import {
  decorateRows,
  fieldFilterSql,
  listColumns,
  readFilters,
} from '@/modules/platform/fields/filter';

/**
 * The client book as a spreadsheet, custom columns included.
 *
 * Takes the SAME query string as the screen, so what downloads is what is on
 * the page — a filtered list that exports unfiltered is how people end up
 * sending the wrong file to a customer. The row cap is higher here because a
 * spreadsheet is read at a desk rather than scrolled on a phone.
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await authorize('admin.warehouses.manage');
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const q = params.q;

  const fields = await listFields('client');
  const columns = listColumns(fields);
  const filters = readFilters(params, fields);

  const conditions: SQL[] = [];
  if (q) {
    conditions.push(
      sql`(${clients.clientCode} ILIKE ${'%' + q + '%'} OR ${clients.name} ILIKE ${'%' + q + '%'})`,
    );
  }
  const custom = fieldFilterSql('client', clients.id, fields, filters);
  if (custom) conditions.push(custom);

  const found = await db
    .select({ client: clients, managerName: users.fullName })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(clients.clientCode))
    .limit(5000);

  const rows = await decorateRows(
    'client',
    found.map((row) => ({
      id: row.client.id,
      code: row.client.clientCode,
      name: row.client.name,
      phones: (Array.isArray(row.client.phones) ? row.client.phones : []).join(', '),
      manager: row.managerName ?? '',
      active: row.client.active,
    })),
    columns,
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Clients');
  const head = sheet.addRow([
    'Code',
    'Name',
    'Phones',
    'Manager',
    'Active',
    ...columns.map((field) => field.label),
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 },
    { width: 32 },
    { width: 22 },
    { width: 22 },
    { width: 8 },
    ...columns.map(() => ({ width: 18 })),
  ];
  for (const row of rows) {
    sheet.addRow([
      row.code,
      row.name,
      row.phones,
      row.manager,
      row.active ? '✓' : '',
      ...columns.map((field) => row[`cf_${field.id}`] ?? ''),
    ]);
  }

  await writeAudit(
    db,
    { actorId: actor.id, ...(await requestMeta()) },
    {
      entityType: 'export',
      entityId: actor.id,
      action: 'export',
      after: { kind: 'clients', rows: rows.length, filters: filters.length, q: q ?? null },
    },
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
