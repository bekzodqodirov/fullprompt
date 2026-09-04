'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setCargoFactsAction } from '../actions';

/**
 * The shipment's own facts, typed by the VED.
 *
 * The owner's report: «agar AI kub kilolarni bermagan bo'lsa lekin
 * materiallarda bo'lsa, ularni VED hodimi o'zi kirgiza olmayabti». The
 * screen printed «⚠ Yetishmayapti: og'irlik, hajm» and offered no way to
 * answer it — so a photograph the model could not read left a job nobody
 * could price at all.
 *
 * OPEN when something is missing, folded when it is not (#420/#43: a
 * control two taps deep is a control nobody finds — and the whole point of
 * this one is that it is reachable exactly when the ⚠ is on screen).
 * Controlled inputs, because a refusal must not eat what was typed (#463).
 */
export function CargoFactsForm({
  id,
  hasFreight,
  initial,
  incomplete,
}: {
  id: string;
  hasFreight: boolean;
  initial: {
    fromCity: string | null;
    toCity: string | null;
    weightKg: number | null;
    volumeM3: number | null;
  };
  incomplete: boolean;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    fromCity: initial.fromCity ?? '',
    toCity: initial.toCity ?? '',
    weightKg: initial.weightKg === null ? '' : String(initial.weightKg),
    volumeM3: initial.volumeM3 === null ? '' : String(initial.volumeM3),
  });

  const set = (k: keyof typeof form, v: string) => {
    setSaved(false);
    setError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const parse = (raw: string): number | null => {
    const v = raw.trim().replace(/\s/g, '').replace(',', '.');
    return v === '' ? null : Number(v);
  };

  const save = () => {
    const weightKg = parse(form.weightKg);
    const volumeM3 = parse(form.volumeM3);
    if ((weightKg !== null && !Number.isFinite(weightKg)) || (volumeM3 !== null && !Number.isFinite(volumeM3))) {
      setError('bad_number');
      return;
    }
    startTransition(async () => {
      const res = await setCargoFactsAction(id, {
        fromCity: form.fromCity.trim() || null,
        toCity: form.toCity.trim() || null,
        weightKg,
        volumeM3,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  const body = (
    <div className="mt-2 flex flex-wrap items-end gap-2" data-testid="calc-facts-form">
      {hasFreight ? (
        <>
          <label className="text-2xs">
            <span className="label">{t('fields.fromCity')}</span>
            <input
              className="input input-sm !w-32"
              data-testid="calc-fact-from"
              value={form.fromCity}
              disabled={pending}
              onChange={(e) => set('fromCity', e.target.value)}
            />
          </label>
          <label className="text-2xs">
            <span className="label">{t('fields.toCity')}</span>
            <input
              className="input input-sm !w-32"
              data-testid="calc-fact-to"
              value={form.toCity}
              disabled={pending}
              onChange={(e) => set('toCity', e.target.value)}
            />
          </label>
        </>
      ) : null}
      <label className="text-2xs">
        <span className="label">{t('fields.weightKg')}</span>
        <input
          className="input input-sm !w-24 text-right font-mono tabular-nums"
          inputMode="decimal"
          data-testid="calc-fact-weight"
          value={form.weightKg}
          disabled={pending}
          onChange={(e) => set('weightKg', e.target.value)}
        />
      </label>
      <label className="text-2xs">
        <span className="label">{t('fields.volumeM3')}</span>
        <input
          className="input input-sm !w-24 text-right font-mono tabular-nums"
          inputMode="decimal"
          data-testid="calc-fact-volume"
          value={form.volumeM3}
          disabled={pending}
          onChange={(e) => set('volumeM3', e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn-primary !min-h-8"
        disabled={pending}
        data-testid="calc-facts-save"
        onClick={save}
      >
        {tc('save')}
      </button>
      {saved ? <span className="chip chip-good">✅</span> : null}
      {error ? (
        <span className="chip chip-warn" data-testid="calc-facts-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_ready') : error}
        </span>
      ) : null}
    </div>
  );

  // Missing facts: the form is already open, beside the ⚠ that named them.
  if (incomplete) return body;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-2xs text-ink-500" data-testid="calc-facts-edit">
        ✏️ {t('editCargoFacts')}
      </summary>
      {body}
    </details>
  );
}
