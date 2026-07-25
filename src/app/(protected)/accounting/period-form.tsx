import { getTranslations } from 'next-intl/server';

/** From/to picker + the XLSX button, shared by every accounting report. */
export async function PeriodForm({
  from,
  to,
  exportHref,
  extra,
}: {
  from: string;
  to: string;
  exportHref: string;
  extra?: React.ReactNode;
}) {
  const t = await getTranslations('accounting');
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-xs text-gray-500">{t('from')}</span>
        <input type="date" name="from" defaultValue={from} className="input !w-40" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-gray-500">{t('to')}</span>
        <input type="date" name="to" defaultValue={to} className="input !w-40" />
      </label>
      {extra}
      <button type="submit" className="btn-primary px-4">
        🔍
      </button>
      {/* A file download, not a page — deliberately a plain anchor. */}
      <a
        href={`${exportHref}${exportHref.includes('?') ? '&' : '?'}from=${from}&to=${to}`}
        className="btn-secondary whitespace-nowrap px-3"
      >
        ⬇️ XLSX
      </a>
    </form>
  );
}
