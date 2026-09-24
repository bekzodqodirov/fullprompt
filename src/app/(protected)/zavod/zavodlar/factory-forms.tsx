'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  confirmFactoryPointAction,
  saveFactoryAction,
  setFactoryActiveAction,
  setFactoryPointAction,
} from '../actions';
import { useErrorText } from '../pickup-forms';

export interface FactoryDraft {
  id?: string;
  name: string;
  address: string;
  phone: string;
  wechat: string;
  goodsNote: string;
  note: string;
}

const EMPTY: FactoryDraft = { name: '', address: '', phone: '', wechat: '', goodsNote: '', note: '' };

/** Create or edit a factory. Saving an address asks the geocoder for a pin, and says what it answered. */
export function FactoryForm({ initial }: { initial?: FactoryDraft }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [draft, setDraft] = useState<FactoryDraft>(initial ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<FactoryDraft>) => setDraft({ ...draft, ...patch });
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await saveFactoryAction(draft);
      if (!res.ok) {
        setMsg(`⚠ ${errorText(res.error)}`);
        return;
      }
      setMsg(
        res.geocoded === 'found'
          ? `✅ ${t('geoFound')}`
          : res.geocoded === 'not_found'
            ? `⚠ ${t('geoNotFound')}`
            : `✅ ${t('saved')}`,
      );
      if (!initial) setDraft(EMPTY);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2" data-testid="factory-form">
      <input data-testid="factory-name" className="input" placeholder={t('factoryName')} aria-label={t('factoryName')} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      <input className="input" placeholder={t('phone')} aria-label={t('phone')} inputMode="tel" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />
      <textarea data-testid="factory-address" className="input h-20 sm:col-span-2" placeholder={t('addressZh')} aria-label={t('addressZh')} value={draft.address} onChange={(e) => set({ address: e.target.value })} />
      <input className="input" placeholder="WeChat" aria-label="WeChat" value={draft.wechat} onChange={(e) => set({ wechat: e.target.value })} />
      <input className="input" placeholder={t('goodsNote')} aria-label={t('goodsNote')} value={draft.goodsNote} onChange={(e) => set({ goodsNote: e.target.value })} />
      <input className="input sm:col-span-2" placeholder={t('note')} aria-label={t('note')} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="button" data-testid="factory-save" className="btn-primary" disabled={busy || !draft.name.trim()} onClick={save}>
          {t('save')}
        </button>
        {msg && <span className="text-xs" data-testid="factory-msg">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * The pin by hand: «lat, lon» or a map link pasted from a phone. A Chinese
 * map (Amap/Gaode, Tencent) is offset by law (GCJ-02) and the box asks
 * which one it came from, because drawn raw that pin lands beside the road.
 */
export function FactoryPointForm({ id, hasPoint, confirmed }: { id: string; hasPoint: boolean; confirmed: boolean }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [text, setText] = useState('');
  const [datum, setDatum] = useState<'gcj02' | 'wgs84'>('gcj02');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-2 text-sm">
      {hasPoint && !confirmed && (
        <button
          type="button"
          data-testid="factory-confirm-point"
          className="btn-secondary"
          onClick={async () => {
            const res = await confirmFactoryPointAction(id);
            setMsg(res.ok ? null : `⚠ ${errorText(res.error)}`);
            if (res.ok) router.refresh();
          }}
        >
          ✓ {t('pointCorrect')}
        </button>
      )}
      <input
        data-testid="factory-point-text"
        className="input"
        placeholder={t('pointPaste')}
        aria-label={t('pointPaste')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {/* Own row, and allowed to shrink: the longest option is ~330 px, and
          beside a button it pushed a 360 px screen to 363 — which makes
          mobile Chrome zoom the whole page out (#400). Measured. */}
      <div className="flex gap-2">
        <select
          aria-label={t('pointDatum')}
          className="input min-w-0 flex-1"
          value={datum}
          onChange={(e) => setDatum(e.target.value as 'gcj02' | 'wgs84')}
        >
          <option value="gcj02">{t('datumChina')}</option>
          <option value="wgs84">{t('datumWorld')}</option>
        </select>
        <button
          type="button"
          data-testid="factory-point-save"
          className="btn-secondary shrink-0"
          disabled={!text.trim()}
          onClick={async () => {
            const res = await setFactoryPointAction({ id, text, datum });
            setMsg(res.ok ? `✅ ${t('saved')}` : `⚠ ${errorText(res.error)}`);
            if (res.ok) {
              setText('');
              router.refresh();
            }
          }}
        >
          📍 {t('pointSet')}
        </button>
      </div>
      {msg && <p className="text-xs">{msg}</p>}
    </div>
  );
}

export function FactoryActiveToggle({ id, active }: { id: string; active: boolean }) {
  const t = useTranslations('pickups');
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-ghost text-xs text-ink-500"
      onClick={async () => {
        const res = await setFactoryActiveAction(id, !active);
        if (res.ok) router.refresh();
      }}
    >
      {active ? t('deactivate') : t('activate')}
    </button>
  );
}
