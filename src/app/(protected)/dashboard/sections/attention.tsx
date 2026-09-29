import { getTranslations } from 'next-intl/server';
import type { CompanyMoneySight } from '@/modules/wms/finance/scope';
import { loadWindows } from '@/modules/wms/reports/dashboard';
import { rankAttention, type AttentionLevel } from '@/modules/wms/reports/dashboard-math';
import { attentionFacts, attentionGates, factText } from '@/modules/wms/reports/attention';
import { readAttentionSources } from '@/modules/wms/reports/attention-sources';
import { AttentionCards, AttentionList, type AttentionRow } from '@/components/charts/attention-list';
import { m3, num, usd } from '@/components/charts/format';

/**
 * «E'tibor kerak» (spec «B»): ONE ranked list of what a person must do today,
 * and of the gaps that would make the P&L, the cash flow or the Balans read
 * wrong — bad before warn, then by the money at stake. Each row is a sentence
 * with its numbers in it and a link to the screen where it is fixed, and each
 * is built only for a viewer who may open that screen (a row that bounces is
 * worse than no row). Every count is the destination's own (#513).
 *
 * The rows are `wms/reports/attention.ts`'s: this section reads their sources
 * through the page's cached loaders and draws the sentences, and the owner's
 * evening Telegram builds the SAME rows from the same function — so the two
 * cannot list different trouble. The money rows need the page's
 * `CompanyMoneySight`, which only `companyMoneySight(actor)` can mint.
 */
export async function AttentionSection({
  sight,
  scoped,
  company,
  scopeKey,
  perms,
  viewerId,
}: {
  /** Null for a viewer who may not read the company's money (`companyMoneySight`). */
  sight: CompanyMoneySight | null;
  /** A warehouse-scoped viewer (`reportScope`'s `scoped`). */
  scoped: boolean;
  /** A warehouse is chosen on the page. */
  company: boolean;
  scopeKey: string;
  perms: Set<string>;
  /**
   * Who is reading (0114): the approvals count is the requests THIS person may
   * decide (the owner's 2a), so it needs the viewer, not the permission set.
   */
  viewerId: string;
}) {
  const t = await getTranslations('dashboard');
  const w = loadWindows();
  // The batch door and the cost-missing condition are the gates' own
  // (`mayReadBatches`, the page's `seesCostMissing` sentence) — asked there
  // once, for this page and for the evening Telegram alike.
  const gates = attentionGates(perms, { sight, scoped, company });
  const sources = await readAttentionSources(gates, scopeKey, new Date(), { id: viewerId, permissions: perms });
  const fmt = { usd, m3, num };
  const items = attentionFacts(gates, sources, w).map((fact) => ({
    ...fact,
    text: factText(fact, (key, values) => t(`att.${key}`, values), fmt),
  }));

  // Every live row is ranked; the first four become cards at the top of the
  // page (the canvas), the rest wait one tap away under them.
  const ranked = rankAttention(items, CARDS);
  const toRow = (item: (typeof items)[number]): AttentionRow => ({
    kind: item.kind,
    level: item.level,
    text: item.text,
    href: item.href,
  });
  const LEVEL: Record<AttentionLevel, string> = {
    bad: t('level.bad'),
    warn: t('level.warn'),
    info: t('level.info'),
  };

  return (
    <section id="diqqat" data-testid="section-attention" className="scroll-mt-20 space-y-2">
      <div className="flex items-baseline gap-2">
        <p className="section-title">⚠️ {t('attentionTitle')}</p>
        {ranked.visibleCount > 0 && (
          <span className={ranked.worst === 'bad' ? 'chip-bad' : 'chip-warn'} data-testid="attention-chip">
            {t('attentionChip', { n: ranked.visibleCount })}
          </span>
        )}
      </div>
      <AttentionCards
        rows={ranked.visible.map(toRow)}
        levelLabel={LEVEL}
        emptyLabel={t('allClear')}
        testid="dash-alerts"
      />
      {ranked.hidden.length > 0 && (
        <details className="card" data-testid="dash-alerts-more">
          <summary className="cursor-pointer text-xs font-semibold text-brand-700">
            {t('moreRows', { n: ranked.hidden.length })}
          </summary>
          <div className="mt-2">
            <AttentionList visible={ranked.hidden.map(toRow)} hidden={[]} moreLabel="" emptyLabel={t('allClear')} />
          </div>
        </details>
      )}
    </section>
  );
}

/** How many rows are cards; the canvas has four across at desktop width. */
const CARDS = 4;
