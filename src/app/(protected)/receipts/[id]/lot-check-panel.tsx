'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { checkLotAction, uncheckLotAction } from './lot-check-actions';

/**
 * «Yuk ma'lumoti tekshirildi» on one lot of the prixod card
 * (docs/YUK-TEKSHIRUV.md §6). The FACE is for everyone who opens the card;
 * the buttons, the client's phones and the note are for whoever may tick
 * (`mayCheckLot`, asked by the page and again by the service — #531).
 *
 * No `router.refresh()` after the action: the action revalidates the page,
 * and a refresh on top of that can leave the transition pending for ever
 * (#1242).
 */

export interface LotCheckFace {
  state: 'checked' | 'unclaimed' | 'stale' | 'none';
  byDocument: boolean;
  documentStale: boolean;
  person: {
    by: string | null;
    day: string;
    note: string | null;
    holds: boolean;
    moved: { name: boolean; count: boolean; client: boolean };
  } | null;
}

export function LotCheckPanel({
  lotId,
  face,
  seen,
  canWrite,
  phones,
}: {
  lotId: string;
  face: LotCheckFace;
  /** The lot as this page drew it — the service compares it with the locked row. */
  seen: { nameZh: string; nameRu: string; boxCount: number; clientId: string | null };
  /** `mayCheckLot` AND a confirmed prixod. */
  canWrite: boolean;
  /** The client's phones (📞 + 💬), for the person who rings. */
  phones: { tel: string; telegram: string | null }[];
}) {
  const t = useTranslations('lotCheck');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const person = face.person;
  const movedWords = person
    ? [
        person.moved.name && t('movedName'),
        person.moved.count && t('movedCount'),
        person.moved.client && t('movedClient'),
      ]
        .filter((w): w is string => Boolean(w))
        .join(', ')
    : '';

  async function confirm() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await checkLotAction({
        lotId,
        seen: {
          nameZh: seen.nameZh,
          nameRu: seen.nameRu,
          boxCount: seen.boxCount,
          clientId: seen.clientId ?? '',
        },
        note: note.trim() || undefined,
      });
      if (res.ok) {
        setDone(true);
        setNote('');
      } else setError(res.error);
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!window.confirm(t('undoConfirm'))) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await uncheckLotAction({ lotId });
      if (!res.ok) setError(res.error);
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-line p-2 text-sm"
      data-testid="lot-check"
      data-state={face.state}
    >
      {/* The face — what the lists say about this lot, in words. */}
      {face.byDocument && (
        <p className="font-semibold text-good" data-testid="lot-check-face-document">
          ✅ {t('byDocument')}
        </p>
      )}
      {person?.holds && (
        <p className="font-semibold text-good" data-testid="lot-check-face-person">
          ✅ {t('byClient')} · {person.by ?? '—'} · {person.day}
          {person.note && (
            <span className="block text-xs font-normal italic text-ink-500">«{person.note}»</span>
          )}
        </p>
      )}
      {person && !person.holds && (
        <p className="font-semibold text-warn" data-testid="lot-check-face-stale">
          ⚠️ {t('stalePerson', { what: movedWords })}
          <span className="block text-xs font-normal text-ink-500">
            {t('staleWas', { by: person.by ?? '—', day: person.day })}
          </span>
        </p>
      )}
      {face.documentStale && !face.byDocument && (
        <p className="font-semibold text-warn" data-testid="lot-check-face-document-stale">
          ⚠️ {t('staleDocument')}
        </p>
      )}
      {face.state === 'none' && (
        <p className="font-semibold text-ink-700" data-testid="lot-check-face-none">
          ❓ {t('none')}
        </p>
      )}
      {face.state === 'unclaimed' && (
        <p className="font-semibold text-ink-500" data-testid="lot-check-face-unclaimed">
          {t('unclaimed')}
        </p>
      )}

      {canWrite && face.state !== 'unclaimed' && seen.clientId && (
        <div className="space-y-1.5 border-t border-line pt-1.5">
          {phones.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-1" data-testid="lot-check-phones">
              {phones.map((phone) => (
                <span key={phone.tel} className="whitespace-nowrap">
                  <a href={`tel:${phone.tel}`} className="text-brand-700 underline">
                    📞 {phone.tel}
                  </a>
                  {phone.telegram && (
                    <a
                      href={phone.telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-brand-700 underline"
                      aria-label={t('telegram')}
                    >
                      💬
                    </a>
                  )}
                </span>
              ))}
            </p>
          )}
          {/* Only a person's tick that STILL HOLDS needs no button; a stale
              one, a document, or nothing at all can be confirmed now. */}
          {!person?.holds && (
            <>
              <input
                className="input"
                data-testid="lot-check-note"
                maxLength={500}
                value={note}
                placeholder={t('notePlaceholder')}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn-primary w-full"
                data-testid="lot-check-yes"
                disabled={busy}
                onClick={confirm}
              >
                ✅ {t('confirm')}
              </button>
            </>
          )}
          {person && (
            <button
              type="button"
              className="text-xs text-ink-500 underline"
              data-testid="lot-check-undo"
              disabled={busy}
              onClick={undo}
            >
              {t('undo')}
            </button>
          )}
          <p className="text-xs text-ink-500">{t('otherAnswers')}</p>
        </div>
      )}

      {done && (
        <p className="text-xs font-semibold text-good" role="status" data-testid="lot-check-done">
          {t('done')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-bad" data-testid="lot-check-error">
          {t(`errors.${errorKey(error)}`)}
        </p>
      )}
    </div>
  );
}

const KNOWN = [
  'forbidden',
  'receipt_not_confirmed',
  'no_client',
  'lot_changed',
  'busy',
  'server_behind',
  'validation',
] as const;
function errorKey(code: string): (typeof KNOWN)[number] | 'other' {
  return (KNOWN as readonly string[]).includes(code) ? (code as (typeof KNOWN)[number]) : 'other';
}
