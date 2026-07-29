'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { saveLinesAction } from './actions';

/**
 * The 50-goods file (DEALS.md answer 6): upload → parse → the assistant's
 * grouping proposal → the VED manager CONFIRMS. Nothing touches the deal's
 * lines until the confirm button — the proposal is a draft on screen, codes
 * editable in place. Without the AI key the file still parses and every row
 * becomes its own line for hand grouping.
 */

interface Good {
  description: string;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  amount: number | null;
  tnvedCode: string | null;
}

interface Group {
  tnved_code: string;
  name_ru: string;
  item_indexes: number[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  duty_rate_pct: number | null;
}

interface Proposal {
  goods: Good[];
  groups: Group[] | null;
  aiError: string | null;
}

interface DraftLine {
  description: string;
  tnvedCode: string;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  amount: number | null;
  /** The goods this line stands for, for the reviewer's eyes. */
  items: string[];
  dutyRatePct: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
}

const sum = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return Math.round(present.reduce((a, b) => a + b, 0) * 1000) / 1000;
};

function toDraft(proposal: Proposal): DraftLine[] {
  const { goods, groups } = proposal;
  if (!groups) {
    return goods.map((g) => ({
      description: g.description,
      tnvedCode: g.tnvedCode ?? '',
      quantity: g.quantity,
      unit: g.unit,
      weightKg: g.weightKg,
      volumeM3: g.volumeM3,
      amount: g.amount,
      items: [],
      dutyRatePct: null,
      confidence: null,
    }));
  }
  const grouped = new Set(groups.flatMap((g) => g.item_indexes));
  const lines: DraftLine[] = groups.map((group) => {
    const items = group.item_indexes.map((i) => goods[i]!).filter(Boolean);
    const units = new Set(items.map((i) => i.unit ?? ''));
    return {
      description: group.name_ru,
      tnvedCode: group.tnved_code,
      // Quantities only add up when they count the same thing.
      quantity: units.size === 1 ? sum(items.map((i) => i.quantity)) : null,
      unit: units.size === 1 ? (items[0]!.unit ?? null) : null,
      weightKg: sum(items.map((i) => i.weightKg)),
      volumeM3: sum(items.map((i) => i.volumeM3)),
      amount: sum(items.map((i) => i.amount)),
      items: items.map((i) => i.description),
      dutyRatePct: group.duty_rate_pct,
      confidence: group.confidence,
    };
  });
  // A good the AI left out is still cargo — it becomes its own line.
  goods.forEach((g, i) => {
    if (grouped.has(i)) return;
    lines.push({
      description: g.description,
      tnvedCode: g.tnvedCode ?? '',
      quantity: g.quantity,
      unit: g.unit,
      weightKg: g.weightKg,
      volumeM3: g.volumeM3,
      amount: g.amount,
      items: [],
      dutyRatePct: null,
      confidence: 'low',
    });
  });
  return lines;
}

const CONFIDENCE_CLASS = {
  high: 'text-good',
  medium: 'text-warn',
  low: 'text-bad',
} as const;

export function ImportLines({
  dealId,
  existingCount,
}: {
  dealId: string;
  existingCount: number;
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'parse' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  const [ai, setAi] = useState(false);

  async function upload(file: File) {
    setBusy('parse');
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/deals/${dealId}/lines/import`, { method: 'POST', body });
      const json = (await res.json()) as Proposal & { error?: string };
      if (!res.ok) {
        setError(json.error ?? 'failed');
        return;
      }
      setAi(Boolean(json.groups));
      setDraft(toDraft(json));
    } catch {
      setError('failed');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirm() {
    if (!draft) return;
    setBusy('save');
    setError(null);
    const form = new FormData();
    for (const line of draft) {
      form.append('lineDescription', line.description);
      form.append('lineTnved', line.tnvedCode);
      form.append('lineQuantity', line.quantity === null ? '' : String(line.quantity));
      form.append('lineUnit', line.unit ?? '');
      form.append('lineVolume', line.volumeM3 === null ? '' : String(line.volumeM3));
      form.append('lineWeight', line.weightKg === null ? '' : String(line.weightKg));
      form.append('lineAmount', line.amount === null ? '' : String(line.amount));
    }
    const state = await saveLinesAction(dealId, {}, form);
    setBusy(null);
    if (state.error) {
      setError(state.error);
      return;
    }
    setDraft(null);
    router.refresh();
  }

  const estimatedDuty = draft
    ? sum(
        draft.map((line) =>
          line.dutyRatePct !== null && line.amount !== null
            ? Math.round(line.amount * line.dutyRatePct) / 100
            : null,
        ),
      )
    : null;

  if (!draft) {
    return (
      <div className="mb-3 space-y-1.5 border-b border-line pb-3">
        <label className="btn-secondary block w-full cursor-pointer text-center">
          {busy === 'parse' ? tc('loading') : `📥 ${t('importFile')}`}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            data-testid="import-goods-file"
            className="hidden"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        <p className="text-xs text-ink-500">{t('importHint')}</p>
        {error && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {t('importFailed')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 space-y-2 border-b border-line pb-3" data-testid="import-review">
      <p className="text-sm font-bold">
        {ai ? t('importGrouped', { lines: draft.length }) : t('importManual', { lines: draft.length })}
      </p>
      {!ai && <p className="text-xs text-warn">{t('importNoAi')}</p>}

      <div className="max-h-80 space-y-1.5 overflow-y-auto">
        {draft.map((line, i) => (
          <div key={i} className="rounded-xl border border-line p-2" data-testid="import-line">
            <div className="flex items-center gap-1.5">
              <input
                value={line.tnvedCode}
                onChange={(e) =>
                  setDraft((d) =>
                    d!.map((l, j) => (j === i ? { ...l, tnvedCode: e.target.value } : l)),
                  )
                }
                placeholder={t('tnved')}
                aria-label={t('tnved')}
                className="input num w-32 shrink-0"
              />
              <input
                value={line.description}
                onChange={(e) =>
                  setDraft((d) =>
                    d!.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)),
                  )
                }
                aria-label={t('description')}
                className="input flex-1"
              />
            </div>
            <p className="mt-1 text-xs text-ink-500">
              {line.items.length > 1 && <span>{line.items.length} × · </span>}
              {line.quantity !== null && <span className="num">{line.quantity} {line.unit ?? ''} · </span>}
              {line.amount !== null && <span className="num">{line.amount} · </span>}
              {line.dutyRatePct !== null && (
                <span className="num">{t('importDuty')} ~{line.dutyRatePct}% · </span>
              )}
              {line.confidence && (
                <span className={`font-bold ${CONFIDENCE_CLASS[line.confidence]}`}>
                  {line.confidence}
                </span>
              )}
            </p>
            {line.items.length > 1 && (
              <p className="mt-0.5 truncate text-xs text-ink-400" title={line.items.join(', ')}>
                {line.items.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>

      {estimatedDuty !== null && (
        <p className="text-xs text-ink-500">
          {t('importDutyTotal', { amount: estimatedDuty })} — {t('importDutyNote')}
        </p>
      )}
      {existingCount > 0 && <p className="text-xs font-semibold text-warn">{t('importReplaceWarn')}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setDraft(null)}
          disabled={busy !== null}
          className="btn-secondary flex-1"
        >
          {tc('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy !== null}
          data-testid="import-confirm"
          className="btn-primary flex-1"
        >
          {busy === 'save' ? tc('loading') : t('importConfirm')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t('importFailed')}
        </p>
      )}
    </div>
  );
}
