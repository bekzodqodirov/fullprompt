'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  threadCalcAnalyzeAction,
  threadCalcSendAction,
} from '@/app/(protected)/hisoblash/actions';
import type { ThreadCalcEntity, ThreadCalcPreview } from '@/modules/wms/calc/from-thread';
import type { CalcSection } from '@/modules/wms/calc/intake';

/**
 * «Hisoblatishga yuborish» — select messages, one tap, a calc request
 * (owner, 2026-08-25). Rendered ONCE per thread, the share sheet's shape:
 * the bubbles are plain server markup carrying `data-msg-id`, and this
 * island finds them by delegation — five hundred messages cost one listener.
 *
 * While select mode is ON, the capture-phase listener claims EVERY click
 * inside a bubble before the lightbox, the audio player, the file anchor or
 * the reply/share buttons can see it — those attach at the React root or on
 * the element, i.e. AFTER a document-capture listener — and toggles the
 * bubble instead. Off, it touches nothing. The selected set lives HERE, not
 * in per-bubble React state: the toggle is a class on the DOM node.
 *
 * The bar lives OUTSIDE the scroll box (a bar inside `max-h-96` scrolls
 * away with the history) and wraps at 360 px: chips row, then count + the
 * two buttons.
 */
const RING = ['ring-2', 'ring-brand-500', 'rounded-lg'];

export function ThreadCalc({ entity }: { entity: ThreadCalcEntity }) {
  const t = useTranslations('calc');
  const [on, setOn] = useState(false);
  const [count, setCount] = useState(0);
  const [section, setSection] = useState<CalcSection>('podklyuch');
  const [preview, setPreview] = useState<ThreadCalcPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: 'deal' | 'lead'; id: string } | null>(null);
  const [pending, start] = useTransition();
  const picked = useRef(new Set<string>());
  // Minted once per select session: `openCalcRequest`'s note_taken fence
  // then turns a retried confirm into a coded refusal instead of a second
  // request in the queue.
  const noteId = useRef<string>('');

  useEffect(() => {
    if (!on) return;
    const onClick = (event: MouseEvent) => {
      const bubble = (event.target as HTMLElement | null)?.closest?.('[data-msg-id]');
      if (!(bubble instanceof HTMLElement) || !bubble.dataset.msgId) return;
      // Selection owns the tap: nothing under the bubble may fire.
      event.preventDefault();
      event.stopPropagation();
      const id = bubble.dataset.msgId;
      if (picked.current.has(id)) {
        picked.current.delete(id);
        bubble.classList.remove(...RING);
      } else {
        picked.current.add(id);
        bubble.classList.add(...RING);
      }
      setPreview(null);
      setCount(picked.current.size);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [on]);

  const reset = () => {
    for (const id of picked.current) {
      document
        .querySelector(`[data-msg-id="${CSS.escape(id)}"]`)
        ?.classList.remove(...RING);
    }
    picked.current.clear();
    setCount(0);
    setPreview(null);
    setError(null);
    setOn(false);
  };

  if (done) {
    return (
      <p className="text-sm text-good" data-testid="thread-calc-done">
        ✅ {t('threadSent')}{' '}
        <Link
          className="underline"
          href={done.kind === 'deal' ? `/bitimlar/${done.id}` : `/crm/leads/${done.id}`}
        >
          {t('threadOpenCard')} →
        </Link>
      </p>
    );
  }

  if (!on) {
    return (
      <button
        type="button"
        className="btn-secondary"
        data-testid="thread-calc-start"
        onClick={() => {
          noteId.current = crypto.randomUUID();
          setOn(true);
        }}
      >
        🧮 {t('threadStart')}
      </button>
    );
  }

  const ids = () => [...picked.current];
  const act = (work: () => Promise<void>) => {
    setError(null);
    start(work);
  };

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-sunken p-2" data-testid="thread-calc-bar">
      <p className="text-2xs text-ink-500">{t('threadPickHint')}</p>
      <div className="flex flex-wrap gap-1.5">
        {(['podklyuch', 'rastamojka', 'yolkira'] as const).map((s) => (
          <label key={s} className={`chip cursor-pointer ${section === s ? 'chip-brand' : ''}`}>
            <input
              type="radio"
              name="thread-calc-section"
              className="sr-only"
              checked={section === s}
              onChange={() => {
                setSection(s);
                setPreview(null);
              }}
            />
            {t(`sections.${s}`)}
          </label>
        ))}
      </div>
      {preview ? (
        <div className="space-y-1 text-xs" data-testid="thread-calc-preview">
          <p>
            {t('threadRead', { lines: preview.lines, files: preview.fileCount })}
            {preview.facts.weightKg !== null ? ` · ${preview.facts.weightKg} kg` : ''}
            {preview.facts.volumeM3 !== null ? ` · ${preview.facts.volumeM3} m³` : ''}
            {(preview.facts.goods?.length ?? 0) > 0 ? ` · ${preview.facts.goods!.length} ${t('items')}` : ''}
          </p>
          {preview.missing.length > 0 ? (
            <p className="text-warn">⚠ {t('threadMissing')}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tabular-nums" data-testid="thread-calc-count">
          {t('threadPicked', { n: count })}
        </span>
        {preview === null ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={pending || count === 0}
            data-testid="thread-calc-analyze"
            onClick={() =>
              act(async () => {
                const res = await threadCalcAnalyzeAction({ entity, section, messageIds: ids() });
                if (res.error) setError(res.error);
                else setPreview(res.preview ?? null);
              })
            }
          >
            {pending ? t('threadReading') : t('threadAnalyze')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            data-testid="thread-calc-send"
            onClick={() =>
              act(async () => {
                const res = await threadCalcSendAction({
                  entity,
                  section,
                  messageIds: ids(),
                  noteId: noteId.current,
                  facts: preview.facts,
                  steps: preview.steps,
                });
                if (res.error) setError(res.error);
                else if (res.landed) {
                  reset();
                  setDone(res.landed);
                }
              })
            }
          >
            {pending ? '…' : t('threadSendBtn')}
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={pending} onClick={reset}>
          {t('threadCancel')}
        </button>
      </div>
      {/* A supervisor selecting a colleague's thread publishes it knowingly:
          the note lands on the card's shared lenta. */}
      <p className="text-2xs text-ink-500">{t('threadLands')}</p>
      {error ? (
        <p className="text-xs text-bad" data-testid="thread-calc-error">
          {t(`threadErrors.${error}` as 'threadErrors.not_yours')}
        </p>
      ) : null}
    </div>
  );
}
