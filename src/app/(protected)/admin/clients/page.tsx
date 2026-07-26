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
import { CustomFilters } from './custom-filters';

/**
 * The client book, filterable and sortable by the owner's own fields.
 *
 * Filtering happens in SQL and sorting in memory, which is not an oversight:
 * the list is capped at 200 rows, so filtering after the cap would search the
 * first 200 clients rather than all of them, while sorting after it orders
 * exactly the rows being shown. This is the same `sortRows` every other table
 * in the app uses — a custom column is just another allowed sort key.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Own gate, not just the layout's: the section is now reachable by roles
  // that only hold FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const t = await getTranslations('clients');
  const tf = await getTranslations('fields');
  const tc = await getTranslations('common');
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const sort = typeof params.sort === 'string' ? params.sort : undefined;
  const dir = typeof params.dir === 'string' ? params.dir : undefined;

  const fields = await listFields('client');
  const columns = listColumns(fields);
  const filters = readFilters(params, fields);

  const conditions: SQL[] = [];
  if (q) {
    // Trigram-accelerated fuzzy match on code and name (spec §12 groundwork).
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
    .limit(200);

  const decorated = await decorateRows(
    'client',
    found.map((row) => ({
      id: row.client.id,
      code: row.client.clientCode,
      name: row.client.name,
      active: row.client.active,
      manager: row.managerName ?? '',
    })),
    columns,
  );
  const sortable = ['code', 'name', 'manager', ...columns.map((field) => `cf_${field.id}`)];
  const rows = sortRows(decorated, sort, dir, sortable);

  // Carry every filter through a sort click, and vice versa.
  const carried: Record<string, string | undefined> = { q };
  for (const filter of filters) carried[`cf_${filter.fieldId}`] = filter.value;
  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(carried)) if (value) exportQuery.set(key, value);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/admin/clients/new" className="btn-primary">
          {t('new')}
        </Link>
      </div>

      <form method="get" className="space-y-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={tc('search')}
          className="input max-w-md"
        />
        {columns.length > 0 && (
          <CustomFilters
            fields={columns.map((field) => ({
              id: field.id,
              label: field.label,
              type: field.type,
              options: Array.isArray(field.options) ? (field.options as string[]) : [],
              value: filters.find((filter) => filter.fieldId === field.id)?.value ?? '',
            }))}
          />
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="num font-semibold">{rows.length}</span>
        <a
          href={`/api/clients/xlsx?${exportQuery.toString()}`}
          data-testid="clients-xlsx"
          className="btn-secondary !min-h-9 px-3"
        >
          ⬇ XLSX
        </a>
      </div>

      {/* A table only once there is something to line up: with no custom
          columns the cards read better on a phone. */}
      {columns.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="border-b border-line text-left">
              <tr>
                <SortTh label={t('code')} field="code" sort={sort} dir={dir} params={carried} />
                <SortTh label={t('name')} field="name" sort={sort} dir={dir} params={carried} />
                <SortTh
                  label={t('salesManager')}
                  field="manager"
                  sort={sort}
                  dir={dir}
                  params={carried}
                />
                {columns.map((field) => (
                  <SortTh
                    key={field.id}
                    label={field.label}
                    field={`cf_${field.id}`}
                    sort={sort}
                    dir={dir}
                    params={carried}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={`border-b border-line ${row.active ? '' : 'opacity-50'}`}>
                  <td className="p-2">
                    <Link
                      href={`/admin/clients/${row.id}`}
                      className="font-mono font-extrabold text-brand-700"
                    >
                      {row.code}
                    </Link>
                  </td>
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-ink-700">{row.manager || t('noManager')}</td>
                  {columns.map((field) => (
                    <td key={field.id} className="p-2">
                      {cell(row[`cf_${field.id}`])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/admin/clients/${row.id}`}
              className={`card block hover:bg-surface-sunken ${row.active ? '' : 'opacity-50'}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg font-extrabold text-brand-700">{row.code}</span>
                <span className="font-semibold">{row.name}</span>
              </div>
              <div className="mt-1 text-sm text-ink-700">
                {t('salesManager')}: {row.manager || t('noManager')}
              </div>
            </Link>
          ))}
        </div>
      )}
      {rows.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
      {columns.length === 0 && (
        <p className="text-xs text-ink-400">
          {tf('noColumnsHint')}{' '}
          <Link href="/admin/fields" className="underline">
            /admin/fields
          </Link>
        </p>
      )}
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}
