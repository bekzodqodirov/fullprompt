'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { saveTnvedAction, suggestTnvedForLotAction } from './actions';

export interface TnvedRow {
  lotId: string;
  nameZh: string;
  nameRu: string | null;
  photoId: string | null;
  boxCount: number;
  /** From memory — pre-filled. */
  code: string;
  source: 'manual' | 'ai' | null;
}

/**
 * ТНВЭД editor (Phase 1.5): per-product code entry with an AI suggestion
 * button. Confirmed codes land in the shared memory, so a product is only
 * ever classified once — next batches pre-fill automatically.
 */
export function TnvedEditor({ rows: initial }: { rows: TnvedRow[] }) {
  const t = useTranslations('tnved');
  const tc = useTranslations('common');
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [reasonings, setReasonings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setCode(lotId: string, code: string, source: 'manual' | 'ai') {
    setRows((prev) => prev.map((r) => (r.lotId === lotId ? { ...r, code, source } : r)));
  }

  async function suggest(row: TnvedRow) {
    setBusy(row.lotId);
    setError(null);
    try {
      const res = await suggestTnvedForLotAction(row.lotId);
      if (res.ok && res.suggestion) {
        setCode(row.lotId, res.suggestion.tnved_code, 'ai');
        setReasonings((prev) => ({
          ...prev,
          [row.lotId]: `${t(`confidence.${res.suggestion!.confidence}`)} · ${res.suggestion!.reasoning}`,
        }));
      } else {
        setError(res.error === 'ai_not_configured' ? t('aiNotConfigured') : t('aiFailed'));
      }
    } finally {
      setBusy(null);
    }
  }

  async function suggestAllMissing() {
    for (const row of rows) {
      if (!row.code.trim()) {
        // Sequential on purpose — visible progress + no rate-limit bursts.
        await suggest(row);
      }
    }
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await saveTnvedAction(
        rows
          .filter((r) => r.code.trim())
          .map((r) => ({
            nameZh: r.nameZh,
            nameRu: r.nameRu,
            code: r.code,
            source: r.source ?? 'manual',
            aiReasoning: reasonings[r.lotId] ?? null,
          })),
      );
      if (res.ok) {
        setMessage(`✅ ${t('saved', { n: res.saved ?? 0 })}`);
        router.refresh();
      } else {
        setError(res.error === 'invalid_code' ? t('invalidCode') : (res.error ?? 'error'));
      }
    } finally {
      setSaving(false);
    }
  }

  const missing = rows.filter((r) => !r.code.trim()).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {missing > 0 && (
          <button
            type="button"
            className="btn-secondary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
            disabled={busy !== null || saving}
            onClick={() => void suggestAllMissing()}
          >
            🤖 {t('suggestAll', { n: missing })}
          </button>
        )}
        <button
          type="button"
          className="btn-primary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
          disabled={saving || busy !== null}
          onClick={() => void saveAll()}
        >
          💾 {saving ? tc('loading') : t('saveAll')}
        </button>
      </div>
      {message && <p className="rounded-lg bg-good/10 p-2 text-sm font-semibold text-good">{message}</p>}
      {error && <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad">{error}</p>}

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.lotId} className="card space-y-2 !p-3">
            <div className="flex items-center gap-3">
              {row.photoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/attachments/${row.photoId}?variant=thumb200`}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-2xl">📦</div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {row.nameZh}
                  {row.nameRu && <span className="text-ink-500"> ({row.nameRu})</span>}
                </p>
                <p className="text-xs text-ink-500">{row.boxCount} 📦</p>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono"
                placeholder="8471300000"
                inputMode="numeric"
                value={row.code}
                onChange={(e) => setCode(row.lotId, e.target.value.replace(/\D/g, ''), 'manual')}
              />
              <button
                type="button"
                className="btn-secondary whitespace-nowrap px-3 disabled:opacity-50"
                disabled={busy !== null || saving}
                onClick={() => void suggest(row)}
              >
                {busy === row.lotId ? '⏳' : '🤖'}
              </button>
            </div>
            {row.source === 'ai' && reasonings[row.lotId] && (
              <p className="rounded-lg bg-brand-50 p-2 text-xs text-brand-800">🤖 {reasonings[row.lotId]}</p>
            )}
            {row.source === 'manual' && initial.find((r) => r.lotId === row.lotId)?.code === row.code && row.code && (
              <p className="text-xs text-ink-500">💾 {t('fromMemory')}</p>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-400">{t('hint')}</p>
    </div>
  );
}
