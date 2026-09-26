import { getTranslations } from 'next-intl/server';
import { daysUntil } from '@/modules/wms/partners/terms';
import type { TermState } from '@/modules/wms/partners/terms-service';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * What the terms say today (0108), in one line for the list and the card:
 * the next due day (red once passed, amber within three days) and the share
 * of the limit (amber from 80 %). Nothing when the firm has no terms or owes
 * nothing — a quiet list is a list with nothing to chase.
 */
export async function TermsStatus({ state, compact = false }: { state: TermState | undefined; compact?: boolean }) {
  if (!state) return null;
  const t = await getTranslations('partners');
  const today = tashkentDay();
  const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const parts: { key: string; text: string; tone: string }[] = [];
  if (state.due.dueDate) {
    const days = daysUntil(state.due.dueDate, today);
    parts.push(
      days < 0
        ? { key: 'due', text: `⚠️ ${t('termsOverdue', { date: state.due.dueDate, usd: usd(state.due.overdueUsd) })}`, tone: 'text-bad font-semibold' }
        : {
            key: 'due',
            text: `⏰ ${t('termsDue', { date: state.due.dueDate, usd: usd(state.due.dueUsd), days })}`,
            tone: days <= 3 ? 'text-warn font-semibold' : 'text-ink-600',
          },
    );
  }
  if (state.limitPct !== null && state.debtLimitUsd !== null && state.balanceUsd > 0.009) {
    parts.push({
      key: 'limit',
      text: `💳 ${t('termsLimit', { pct: state.limitPct, limit: usd(state.debtLimitUsd) })}`,
      tone: state.limitPct >= 80 ? 'text-warn font-semibold' : 'text-ink-600',
    });
  }
  if (parts.length === 0) return null;
  return (
    <p className={`${compact ? 'text-2xs' : 'text-xs'} flex flex-wrap gap-x-3`} data-testid="partner-terms-status">
      {parts.map((part) => (
        <span key={part.key} className={part.tone}>
          {part.text}
        </span>
      ))}
    </p>
  );
}
