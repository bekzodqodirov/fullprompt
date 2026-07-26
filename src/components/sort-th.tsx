import Link from 'next/link';

/**
 * Sortable table header (owner's request, M6 #13): a server-rendered link
 * that toggles ?sort=field&dir=asc|desc while keeping other params — sorting
 * composes with filters and survives reloads.
 */
export function SortTh({
  label,
  field,
  sort,
  dir,
  params = {},
  className = 'p-2',
}: {
  label: string;
  field: string;
  sort?: string;
  dir?: string;
  /** Other query params to preserve (clientId, days, …). */
  params?: Record<string, string | undefined>;
  className?: string;
}) {
  const active = sort === field;
  const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  query.set('sort', field);
  query.set('dir', nextDir);
  return (
    <th className={className}>
      <Link href={`?${query.toString()}`} className={active ? 'text-brand-700' : ''}>
        {label}
        {active && (dir === 'desc' ? ' ↓' : ' ↑')}
      </Link>
    </th>
  );
}

/** Sort rows client-agnostically by a field, numbers and dates before strings. */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: string | undefined,
  dir: string | undefined,
  allowed: readonly string[],
): T[] {
  if (!sort || !allowed.includes(sort)) return rows;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * mul;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}
