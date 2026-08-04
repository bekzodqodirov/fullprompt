import ExcelJS from 'exceljs';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { listFields } from '@/modules/platform/fields/service';
import { CLIENT_COLUMNS, CLIENT_EXPORT_CAP } from '@/modules/platform/clients/list';
import { parseCols, visibleColumns, type ColumnDef } from '@/modules/platform/lists/columns';
import { sortRows } from '@/components/sort-th';
import { phoneNeedle } from '@/modules/platform/clients/phone';
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
 *
 * Round 57: it takes the screen's `cols` and `sort` too, so what downloads is
 * the VIEW — the columns the person chose, in the order they were reading
 * them. A saved view exports as itself.
 */
export async function GET(request: Request) {
  let actor;
  try {
    // Same gate as the screen it downloads: an export that asks for a
    // different permission is either a hole or a dead button.
    actor = await authorize('clients.manage');
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
    // The same three-way match as the screen — code, name, phone. A download
    // that searches differently from the page above it is a file nobody can
    // explain.
    const needle = phoneNeedle(q);
    const byPhone = needle
      ? sql` OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${clients.phones}) AS p
          WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), 9) LIKE ${'%' + needle + '%'}
        )`
      : sql``;
    conditions.push(
      sql`(${clients.clientCode} ILIKE ${'%' + q + '%'} OR ${clients.name} ILIKE ${'%' + q + '%'}${byPhone})`,
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
    .limit(CLIENT_EXPORT_CAP);

  const decorated = await decorateRows(
    'client',
    found.map((row) => ({
      id: row.client.id,
      code: row.client.clientCode,
      name: row.client.name,
      phone: (Array.isArray(row.client.phones) ? row.client.phones : []).join(', '),
      manager: row.managerName ?? '',
      active: row.client.active,
    })),
    columns,
  );

  // The screen's column set, resolved the same way and by the same helper —
  // an export that shows a column the page hides is a leak with a filename.
  const allColumns: ColumnDef[] = [
    ...CLIENT_COLUMNS,
    { key: 'active', labelKey: 'common.active' },
    ...columns.map((field) => ({ key: `cf_${field.id}`, label: field.label })),
  ];
  const visible = visibleColumns(allColumns, parseCols(params.cols), (permission) =>
    actor.permissions.has(permission),
  );
  const rows = sortRows(
    decorated,
    params.sort,
    params.dir,
    allColumns.map((column) => column.key),
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Clients');
  const head = sheet.addRow(visible.map(columnTitle));
  head.font = { bold: true };
  sheet.columns = visible.map((column) => ({ width: column.key === 'name' ? 32 : 18 }));
  for (const row of rows) {
    sheet.addRow(
      visible.map((column) => {
        if (column.key === 'active') return row.active ? '✓' : '';
        const value = row[column.key];
        return value === null || value === undefined ? '' : value;
      }),
    );
  }

  await writeAudit(
    db,
    { actorId: actor.id, ...(await requestMeta()) },
    {
      entityType: 'export',
      entityId: actor.id,
      action: 'export',
      after: {
        kind: 'clients',
        rows: rows.length,
        filters: filters.length,
        q: q ?? null,
        cols: visible.map((column) => column.key).join(','),
      },
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

/**
 * A column's spreadsheet heading.
 *
 * Custom fields carry the owner's own label. The core ones keep the English
 * headings this file has always written — the sheet is opened in Excel next
 * to files from other systems, and renaming its columns would silently break
 * whatever anybody has built on top of them.
 */
const CORE_TITLES: Record<string, string> = {
  code: 'Code',
  name: 'Name',
  manager: 'Manager',
  phone: 'Phones',
  active: 'Active',
};

function columnTitle(column: ColumnDef): string {
  return column.label ?? CORE_TITLES[column.key] ?? column.key;
}
