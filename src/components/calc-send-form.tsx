'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { CALC_SECTIONS, type CalcSection } from '@/modules/wms/calc/intake';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { submitCalcAction } from '@/app/(protected)/hisoblash/actions';

/**
 * The desk half of «Hisoblatishga yuborish».
 *
 * Controlled inputs and no `<form action>`: this form holds seven fields and
 * an upload the person has already paid real time for, and the commonest
 * refusal — «forgot the section», «typed the kg in the m³ box» — must not
 * also empty it (#377/#419/#463). The reset is gated on success for the same
 * reason: clearing before reading the verdict is how uploads get orphaned.
 *
 * Files are pre-bound to a note id minted HERE (#180's pattern, the same one
 * the bot and the receive wizard use), so photos can be attached before the
 * request exists; the id travels to the action, which mints the note under it
 * and refuses an id that is already taken.
 */
export function CalcSendForm({
  entityType,
  entityId,
  revalidate,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const [noteId, setNoteId] = useState(() => uuidv4());
  const [section, setSection] = useState<CalcSection>('podklyuch');
  const [fromCity, setFromCity] = useState('');
  const [toCity, setToCity] = useState('');
  const [weight, setWeight] = useState('');
  const [volume, setVolume] = useState('');
  const [goodsText, setGoodsText] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState(0);
  const [uploading, setUploading] = useState(false);

  const num = (raw: string) => {
    const value = raw.trim().replace(',', '.');
    return value ? Number(value) : null;
  };

  /** One product per line: «name, quantity» — the shape a paste from a
   * spreadsheet already has. A line with no name is not a product. */
  const parseGoods = () =>
    goodsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[,;\t]/).map((part) => part.trim());
        const quantity = parts.length > 1 ? Number(parts[1]!.replace(',', '.')) : NaN;
        return {
          name: parts[0]!,
          quantity: Number.isFinite(quantity) ? quantity : null,
          unit: parts[2] || null,
        };
      });

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append('file', file);
        body.append('entityType', 'crm_activity');
        body.append('entityId', noteId);
        const res = await fetch('/api/files/upload', {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(String(res.status));
        setFiles((n) => n + 1);
      }
      setError(null);
    } catch {
      setError('failed');
    } finally {
      setUploading(false);
    }
  }

  function send() {
    startTransition(async () => {
      const result = await submitCalcAction({
        entityType,
        entityId,
        section,
        fromCity,
        toCity,
        weightKg: num(weight),
        volumeM3: num(volume),
        goods: parseGoods(),
        // A note is written only when there is something to say — text, or
        // files already uploaded against this id.
        noteId: note.trim() || files > 0 ? noteId : '',
        noteText: note.trim() || t('panelTitle'),
        revalidate,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setSent(true);
      setGoodsText('');
      setNote('');
      setFiles(0);
      // The next request is a NEW one — its files must not join this one.
      setNoteId(uuidv4());
      router.refresh();
    });
  }

  return (
    <div className="space-y-2" data-testid="calc-send-form">
      <div>
        <span className="label">{t('sectionLabel')}</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {CALC_SECTIONS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`calc-section-${value}`}
              aria-pressed={section === value}
              className={section === value ? 'chip chip-brand' : 'chip chip-neutral'}
              onClick={() => setSection(value)}
            >
              {t(SECTION_LABELS[value] as 'sections.podklyuch')}
            </button>
          ))}
        </div>
      </div>

      {section !== 'rastamojka' ? (
        <div className="flex flex-wrap gap-2">
          <input
            className="input !w-36"
            placeholder={t('fields.fromCity')}
            data-testid="calc-from-city"
            value={fromCity}
            onChange={(event) => setFromCity(event.target.value)}
          />
          <input
            className="input !w-36"
            placeholder={t('fields.toCity')}
            data-testid="calc-to-city"
            value={toCity}
            onChange={(event) => setToCity(event.target.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          className="input !w-28"
          inputMode="decimal"
          placeholder={t('fields.weightKg')}
          data-testid="calc-weight"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
        />
        <input
          className="input !w-28"
          inputMode="decimal"
          placeholder={t('fields.volumeM3')}
          data-testid="calc-volume"
          value={volume}
          onChange={(event) => setVolume(event.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="calc-goods">
          {t('goods')}
        </label>
        <textarea
          id="calc-goods"
          data-testid="calc-goods"
          className="input h-28"
          placeholder={t('goodsHint')}
          value={goodsText}
          onChange={(event) => setGoodsText(event.target.value)}
        />
      </div>

      <textarea
        data-testid="calc-note"
        className="input h-16"
        placeholder={t('answerNote')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-secondary cursor-pointer !min-h-9">
          📎
          <input
            type="file"
            multiple
            className="hidden"
            data-testid="calc-files"
            onChange={(event) => addFiles(event.target.files)}
          />
        </label>
        {files > 0 ? <span className="text-2xs text-ink-500">{files}</span> : null}
        {uploading ? <span className="text-2xs text-ink-500">{tc('loading')}</span> : null}
      </div>

      <button
        type="button"
        disabled={pending || uploading}
        data-testid="calc-send"
        className="btn-primary w-full"
        onClick={send}
      >
        {pending ? tc('loading') : sent ? '✅' : t('send')}
      </button>

      {error ? (
        <p role="alert" data-testid="calc-send-error" className="text-sm font-semibold text-bad">
          {t(`errors.${error}` as 'errors.failed')}
        </p>
      ) : null}
      <p className="text-2xs text-ink-500">{t('deadlineHint')}</p>
    </div>
  );
}
