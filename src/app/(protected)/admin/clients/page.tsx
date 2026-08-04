import Link from 'next/link';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listFields } from '@/modules/platform/fields/service';
import {
  decorateRows,
  fieldFilterSql,
  listColumns,
  readFilters,
} from '@/modules/platform/fields/filter';
import { sortRows, SortTh } from '@/components/sort-th';
import { parseCols, visibleColumns, type ColumnDef } from '@/modules/platform/lists/columns';
import { canPublishViews, normalizeQuery } from '@/modules/platform/lists/query';
import { defaultViewFor, listViewsFor } from '@/modules/platform/lists/service';
import { ViewBar } from '@/components/list/view-bar';
import { ColumnPicker } from '@/components/list/column-picker';
import { CustomFilters } from './custom-filters';
import { phoneNeedle } from '@/modules/platform/clients/phone';
import { CLIENT_COLUMNS, CLIENT_LIST_CAP } from '@/modules/platform/clients/list';

/**
 * The client book, filterable and sortable by the owner's own fields.
 *
 * Filtering happens in SQL and sorting in memory, which is not an oversight:
 * the list is capped at 200 rows, so filtering after the cap would search the
 * first 200 clients rather than all of them, while sorting after it orders
 * exactly the rows being shown. This is the same `sortRows` every other table
 * in the app uses — a custom column is just another allowed sort key.
 *
 * Round 57 made this the first screen on the shared list engine: the columns
 * are data rather than JSX, so they can be chosen, and everything the screen
 * reads out of the URL can be saved under a name (`ViewBar`).
 */

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The CLIENT permission, not the warehouse one. This page asked for
  // `admin.warehouses.manage` while the menu entry, the create page and all
  // three mutations ask for `clients.manage` — so the logist could create a
  // client, edit the card and mint a cabinet link, and could not open the
  // list at all: the menu showed «Mijozlar» and the page bounced him home.
  const actor = await getActor();
  if (!actor?.permissions.has('clients.manage')) redirect('/');
  const t = await getTranslations('clients');
  const tf = await getTranslations('fields');
  const tc = await getTranslations('common');
  const tl = await getTranslations('lists');
  // No namespace: a ColumnDef carries its FULL key, so one call resolves both
  // the core columns here and the ones any other screen declares.
  const tAny = await getTranslations();
  const params = await searchParams;

  // A personal default view is applied on a BARE visit only, and by
  // redirecting rather than rendering: the address bar then matches what is
  // on screen, so every sort link, filter and export carries the same state.
  if (Object.keys(params).length === 0) {
    const preset = await defaultViewFor('clients', actor.id);
    if (preset?.query) redirect(`/admin/clients?${preset.query}`);
  }

  const q = typeof params.q === 'string' ? params.q : undefined;
  const sort = typeof params.sort === 'string' ? params.sort : undefined;
  const dir = typeof params.dir === 'string' ? params.dir : undefined;

  const fields = await listFields('client');
  const customColumns = listColumns(fields);
  const filters = readFilters(params, fields);

  // Core and custom columns go through ONE picker: the custom ones are added
  // to the same descriptor list rather than living in a second mechanism.
  const allColumns: ColumnDef[] = [
    ...CLIENT_COLUMNS,
    ...customColumns.map((field) => ({ key: `cf_${field.id}`, label: field.label })),
  ];
  const chosen = parseCols(params.cols);
  const columns = visibleColumns(allColumns, chosen, (permission) =>
    actor.permissions.has(permission),
  );
  const label = (column: ColumnDef) => column.label ?? tAny(column.labelKey!);

  const conditions: SQL[] = [];
  if (q) {
    // Code, name — and the PHONE, because the commonest reason to search the
    // book is that the client is on the line. Last nine digits, formatting
    // stripped on both sides, exactly as the cabinet check does (#111).
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

  const where = conditions.length ? and(...conditions) : undefined;
  const found = await db
    .select({ client: clients, managerName: users.fullName })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(where)
    .orderBy(asc(clients.clientCode))
    .limit(CLIENT_LIST_CAP);

  // The list stops at CLIENT_LIST_CAP and used to print that number as the total, so
  // the screen told the owner he had 200 clients. A cap that does not say it
  // is a cap is a screen quietly lying about the size of the business.
  const [totals] = await db
    .select({ n: sql<number>`count(*)` })
    .from(clients)
    .where(where);
  const total = Number(totals?.n ?? 0);

  const decorated = await decorateRows(
    'client',
    found.map((row) => ({
      id: row.client.id,
      code: row.client.clientCode,
      name: row.client.name,
      active: row.client.active,
      manager: row.managerName ?? '',
      phone: Array.isArray(row.client.phones) ? (row.client.phones as string[]).join(', ') : '',
    })),
    customColumns,
  );
  const sortable = allColumns.map((column) => column.key);
  const rows = sortRows(decorated, sort, dir, sortable);

  // Carry every filter through a sort click, and vice versa.
  const carried: Record<string, string | undefined> = { q };
  for (const filter of filters) carried[`cf_${filter.fieldId}`] = filter.value;
  if (chosen !== null) carried.cols = chosen.join(',');
  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(carried)) if (value) exportQuery.set(key, value);
  if (sort) exportQuery.set('sort', sort);
  if (dir) exportQuery.set('dir', dir);

  const currentQuery = normalizeQuery(params);
  const views = await listViewsFor('clients', actor.id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/admin/clients/new" className="btn-primary">
          {t('new')}
        </Link>
      </div>

      <ViewBar
        screen="clients"
        path="/admin/clients"
        views={views}
        currentQuery={currentQuery}
        canPublish={canPublishViews(actor.permissions)}
      />

      <form method="get" className="space-y-2">
        {/* The column choice rides the same GET form so typing a filter does
            not silently drop it. */}
        {chosen !== null && <input type="hidden" name="cols" value={chosen.join(',')} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={tc('search')}
          className="input max-w-md"
        />
        {customColumns.length > 0 && (
          <CustomFilters
            fields={customColumns.map((field) => ({
              id: field.id,
              label: field.label,
              type: field.type,
              options: Array.isArray(field.options) ? (field.options as string[]) : [],
              value: filters.find((filter) => filter.fieldId === field.id)?.value ?? '',
            }))}
          />
        )}
      </form>

      <div className="relative flex flex-wrap items-center gap-2 text-sm">
        <ColumnPicker
          columns={allColumns.map((column) => ({
            key: column.key,
            label: label(column),
            always: column.always,
          }))}
          visible={columns.map((column) => column.key)}
          query={currentQuery}
        />
        <span className="num font-semibold">
          {rows.length < total ? t('shownOf', { shown: rows.length, total }) : total}
        </span>
        {rows.length < total && <span className="text-xs text-warn">{t('refineSearch')}</span>}
        <a
          href={`/api/clients/xlsx?${exportQuery.toString()}`}
          data-testid="clients-xlsx"
          className="btn-secondary !min-h-9 px-3"
        >
          ⬇ XLSX
        </a>
      </div>

      {/* One table, always: with a column picker beside it the card grid was
          a second layout that could not show what the picker had chosen. */}
      <div className="table-wrap">
        <table className="table" data-testid="clients-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <SortTh
                  key={column.key}
                  label={label(column)}
                  field={column.key}
                  sort={sort}
                  dir={dir}
                  params={carried}
                  className=""
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.active ? '' : 'opacity-50'}>
                {columns.map((column) =>
                  column.key === 'code' ? (
                    <td key={column.key}>
                      <Link
                        href={`/admin/clients/${row.id}`}
                        className="font-mono font-extrabold text-brand-700"
                      >
                        {row.code}
                      </Link>
                    </td>
                  ) : column.key === 'manager' ? (
                    <td key={column.key} className="text-ink-700">
                      {row.manager || t('noManager')}
                    </td>
                  ) : (
                    <td key={column.key}>{cell(row[column.key])}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
      {customColumns.length === 0 && (
        <p className="text-xs text-ink-400">
          {tf('noColumnsHint')}{' '}
          <Link href="/admin/fields" className="underline">
            /admin/fields
          </Link>
        </p>
      )}
      <p className="text-xs text-ink-400">{tl('viewsHint')}</p>
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}
