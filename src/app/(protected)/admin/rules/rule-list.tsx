'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { deleteRuleAction, toggleRuleAction } from './actions';

export interface RuleView {
  id: string;
  name: string;
  active: boolean;
  triggerLabel: string;
  actionLabel: string;
  fireCount: number;
  lastFiredAt: string | null;
}

export function RuleList({ rules }: { rules: RuleView[] }) {
  const t = useTranslations('automation');
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const act = (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    startTransition(async () => {
      await work();
      setBusyId(null);
      router.refresh();
    });
  };

  if (rules.length === 0) {
    return <p className="card text-center text-sm text-ink-500">{t('noRules')}</p>;
  }
  return (
    <div className="space-y-2">
      {rules.map((rule) => (
        <div key={rule.id} className="card space-y-1 !p-3" data-testid="rule-row">
          <div className="flex items-center justify-between gap-2">
            <p className={`font-bold ${rule.active ? '' : 'text-ink-400 line-through'}`}>
              {rule.name}
            </p>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => act(rule.id, () => toggleRuleAction(rule.id, !rule.active))}
                disabled={busyId === rule.id}
                data-testid="rule-toggle"
                className="btn-secondary !px-2 !py-1 text-xs"
              >
                {rule.active ? t('pause') : t('resume')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t('deleteConfirm'))) {
                    act(rule.id, () => deleteRuleAction(rule.id));
                  }
                }}
                disabled={busyId === rule.id}
                data-testid="rule-delete"
                className="btn-secondary !px-2 !py-1 text-xs text-bad"
              >
                ✕
              </button>
            </div>
          </div>
          <p className="text-sm text-ink-700">
            {rule.triggerLabel} → {rule.actionLabel}
          </p>
          <p className="text-xs text-ink-500">
            {rule.fireCount > 0
              ? t('fired', { n: rule.fireCount, at: rule.lastFiredAt ?? '' })
              : t('neverFired')}
          </p>
        </div>
      ))}
    </div>
  );
}
