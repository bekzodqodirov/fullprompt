import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { customRecords } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, EmptyState } from '@/components/ui/page';
import { SortTh, sortRows } from '@/components/sort-th';
import { canWriteEntity, resolveEntity } from '@/modules/platform/entities/service';
import { listFields } from '@/modules/platform/fields/service';
import {
  decorateRows,
  displayValue,
  fieldFilterSql,
  listColumns,
  readFilters,
} from '@/modules/platform/fields/filter';
import { CustomFilters } from '../../admin/clients/custom-filters';
import { NewRecordForm } from './new-record';

const LIST_CAP = 200;

/**
 * The generic list — the owner's own object, with the same custom-field
 * columns and filters the client book earned in phase 2, reused rather than
 * re-invented: filter in SQL before the cap, sort in memory after it.
 */
export default async function CustomListPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { code } = await params;
  const entity = await resolveEntity(code);
  if (!entity?.custom) notFound();

  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const sort = typeof query.sort === 'string' ? query.sort : 'name';
  const dir = query.dir === 'desc' ? 'desc' : 'asc';

  const t = await getTranslations('objects');
  const fields = await listFields(code);
  const columns = listColumns(fields);
  const filters = readFilters(query, fields);

  const conditions: SQL[] = [
    eq(customRecords.entityCode, code),
    eq(customRecords.active, true),
  ];
  if (q) conditions.push(ilike(customRecords.name, `%${q}%`));
  const fieldCondition = fieldFilterSql(code, customRecords.id, fields, filters);
  if (fieldCondition) conditions.push(fieldCondition);

  const rows = await db
    .select()
    .from(customRecords)
    .where(and(...conditions))
    .orderBy(asc(customRecords.name))
    .limit(LIST_CAP);
  const [countRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(customRecords)
    .where(and(...conditions));
  const total = Number(countRow?.total ?? 0);

  const decorated = await decorateRows(code, rows, columns);
  const sortable = ['name', ...columns.map((f) => `cf_${f.id}`)];
  const sorted = sortRows(decorated, sort, dir, sortable);
  const carried: Record<string, string> = {};
  if (q) carried.q = q;
  for (const filter of filters) carried[`cf_${filter.fieldId}`] = filter.value;

  const writable = canWriteEntity(entity, actor.permissions);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <PageHeader
        icon="boxes"
        back={{ href: '/o', label: t('title') }}
        title={entity.label ?? code}
        subtitle={<span className="num">{total}</span>}
      />

      {writable && <NewRecordForm entityCode={code} />}

      <form method="get" className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t('search')}
          aria-label={t('search')}
          className="input flex-1"
        />
        <CustomFilters
          fields={fields
            .filter((f) => f.active)
            .map((f) => ({
              id: f.id,
              label: f.label,
              type: f.type,
              options: Array.isArray(f.options) ? (f.options as string[]) : [],
              value: filters.find((x) => x.fieldId === f.id)?.value ?? '',
            }))}
        />
        <button type="submit" className="btn-secondary">
          🔍
        </button>
      </form>

      {sorted.length === 0 ? (
        <EmptyState title={t('noRecords')} hint={writable ? t('noRecordsHint') : undefined} />
      ) : columns.length > 0 ? (
        <div className="card overflow-x-auto !p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-500">
                <SortTh label={t('name')} field="name" sort={sort} dir={dir} params={carried} />
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
              {sorted.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="p-2">
                    <Link
                      href={`/o/${code}/${row.id}`}
                      data-testid="object-row"
                      className="font-semibold text-good hover:underline"
                    >
                      {row.name}
                    </Link>
                  </td>
                  {columns.map((field) => (
                    <td key={field.id} className="p-2">
                      {String(
                        displayValue(
                          field,
                          (row as Record<string, unknown>)[`cf_${field.id}`] ?? null,
                        ) ?? '—',
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {sorted.map((row) => (
            <Link
              key={row.id}
              href={`/o/${code}/${row.id}`}
              data-testid="object-row"
              className="card-tap !p-3 text-sm font-semibold"
            >
              {row.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
