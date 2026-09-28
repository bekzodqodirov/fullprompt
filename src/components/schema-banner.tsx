import { getTranslations } from 'next-intl/server';
import { schemaLedger } from '@/modules/platform/db/ledger';
import { logger } from '@/modules/platform/logger';

/**
 * «The database is not the one this code was built for» — said on every page
 * to the people who can do something about it (B9).
 *
 * CLAUDE.md's deploy oracle is counting `drizzle.__drizzle_migrations`
 * against the journal by hand; the code knows both numbers. With `migrate` a
 * `service_completed_successfully` dependency of the app, a FAILED migration
 * never lets the app start — so the «behind» this banner can actually see is
 * deploy trap 2, a stale `migrate` IMAGE re-running yesterday's migrations
 * successfully, and the command it prints REBUILDS that image first
 * (`docker compose run --rm migrate` alone would re-run the stale one).
 *
 * Rendered in the layout, i.e. on every page: the read is cached a minute
 * on the side connection, and the reads are caught — there is no
 * global-error.tsx, and a throw here would take every screen down on exactly
 * the morning the schema is wrong (#472). The words are decided inside the
 * catch and the markup outside it (JSX is not rendered where it is written).
 */
export async function SchemaBanner() {
  let text: string | null = null;
  try {
    const ledger = await schemaLedger();
    if (ledger.state !== 'ok') {
      const t = await getTranslations('kuzatuv');
      text =
        ledger.state === 'behind'
          ? t('schemaBehind', { applied: ledger.applied, expected: ledger.expected })
          : t('schemaAhead', { applied: ledger.applied, expected: ledger.expected });
    }
  } catch (err) {
    logger.warn({ err }, '[schema-banner] ledger unavailable');
    text = null;
  }
  if (!text) return null;
  return (
    <div
      role="alert"
      className="border-b border-bad/40 bg-bad/10 px-3 py-2 text-center text-xs font-semibold text-bad [overflow-wrap:anywhere]"
      data-testid="schema-banner"
    >
      {text}
    </div>
  );
}
