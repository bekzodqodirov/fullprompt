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
 * The card says what the lists say (the review's two contradictions): ✅
 * wherever the lot stands; ❓ / ⚠ «qayta so'rang» and the button only while a
 * carton is still in China (his 4a); and a basis that went stale while the
 * OTHER one holds is a muted history line, never «ask again» about a lot every
 * list calls verified.
 *
 * No `router.refresh()` after the action: the action revalidates the page,
 * and a refresh on top of that can leave the transition pending for ever
 * (#1242).
 */

export interface LotCheckFace {
  state: 'checked' | 'unclaimed' | 'stale' | 'none';
  askable: boolean;
  byDocument: boolean;
  documentStale: boolean;
  person: {
    by: string | null;
    day: string;
    /** `checked_at::text` — posted back so a press never replaces a check it did not see. */
    token: string;
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
  canRename,
  phones,
}: {
  lotId: string;
  face: LotCheckFace;
  /** The lot as this page drew it — the service compares it with the locked row. */
  seen: { nameZh: string; nameRu: string; boxCount: number; clientId: string | null };
  /** `mayCheckLot` AND a confirmed prixod. */
  canWrite: boolean;
  /** The ✏️ lot form is drawn for this reader (`receipts.edit`) — the VED's is not. */
  canRename: boolean;
  /** The client's phones (📞 + 💬), for the person who rings. */
  phones: { tel: string; telegram: string | null }[];
}) {
  const t = useTranslations('lotCheck');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const person = face.person;
  const checked = face.state === 'checked';
  /** «Ask again» is said only where the lot is still asked about. */
  const asking = !checked && face.askable;
  const movedWords = person
    ? [person.moved.name && t('movedName'), person.moved.count && t('movedCount'), person.moved.client && t('movedClient')]
        .filter((w): w is string => Boolean(w))
        .join(', ')
    : '';
  const mayAct = canWrite && face.state !== 'unclaimed' && Boolean(seen.clientId);
  const offerConfirm = mayAct && asking;
  const offerUndo = canWrite && person !== null;

  async function confirm() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await checkLotAction({
        lotId,
        seen: { nameZh: seen.nameZh, nameRu: seen.nameRu, boxCount: seen.boxCount, clientId: seen.clientId ?? '' },
        note: note.trim() || undefined,
        seenCheckedAt: person?.token ?? null,
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
    if (!person || !window.confirm(t('undoConfirm'))) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await uncheckLotAction({ lotId, seenCheckedAt: person.token });
      if (!res.ok) setError(res.error);
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  const lines: React.ReactNode[] = [];
  if (face.byDocument) {
    lines.push(
      <p key="doc" className="font-semibold text-good" data-testid="lot-check-face-document">
        ✅ {t('byDocument')}
      </p>,
    );
  }
  if (person?.holds) {
    lines.push(
      <p key="person" className="font-semibold text-good [overflow-wrap:anywhere]" data-testid="lot-check-face-person">
        ✅ {t('byClient')} · {person.by ?? '—'} · {person.day}
        {person.note && <span className="block text-xs font-normal italic text-ink-500">«{person.note}»</span>}
      </p>,
    );
  }
  if (person && !person.holds) {
    lines.push(
      asking ? (
        <p key="stale" className="font-semibold text-warn [overflow-wrap:anywhere]" data-testid="lot-check-face-stale">
          ⚠️ {t('stalePerson', { what: movedWords })}
          <span className="block text-xs font-normal text-ink-500">
            {t('staleWas', { by: person.by ?? '—', day: person.day })}
          </span>
        </p>
      ) : (
        <p key="stale-old" className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="lot-check-face-person-old">
          {t('personOld', { by: person.by ?? '—', day: person.day, what: movedWords })}
        </p>
      ),
    );
  }
  if (face.documentStale && !face.byDocument) {
    lines.push(
      asking ? (
        <p key="doc-stale" className="font-semibold text-warn" data-testid="lot-check-face-document-stale">
          ⚠️ {t('staleDocument')}
        </p>
      ) : (
        <p key="doc-old" className="text-xs text-ink-500" data-testid="lot-check-face-document-old">
          {t('documentOld')}
        </p>
      ),
    );
  }
  if (face.state === 'none' && face.askable) {
    lines.push(
      <p key="none" className="font-semibold text-ink-700" data-testid="lot-check-face-none">
        ❓ {t('none')}
      </p>,
    );
  }
  if (face.state === 'unclaimed' && face.askable) {
    lines.push(
      <p key="unclaimed" className="font-semibold text-ink-500" data-testid="lot-check-face-unclaimed">
        {t('unclaimed')}
      </p>,
    );
  }
  // Cargo already in Uzbekistan that nobody checked says nothing (his 4a).
  if (lines.length === 0 && !offerUndo && !done && !error) return null;

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-line p-2 text-sm"
      data-testid="lot-check"
      data-state={face.state}
      data-askable={face.askable ? 'true' : 'false'}
    >
      {lines}

      {(offerConfirm || offerUndo) && (
        <div className="space-y-1.5 border-t border-line pt-1.5">
          {offerConfirm && phones.length > 0 && (
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
          {offerConfirm && (
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
              {/* Where the two other answers go — the ✏️ form is drawn for
                  `receipts.edit` alone, so the VED is sent to the logist
                  (the lot tarkibi's own `lines_count` sentence). */}
              <p className="text-xs text-ink-500" data-testid="lot-check-other">
                {canRename ? t('otherAnswers') : t('otherAnswersAskLogist')}
              </p>
            </>
          )}
          {offerUndo && (
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
  'check_changed',
  'busy',
  'server_behind',
  'validation',
] as const;
function errorKey(code: string): (typeof KNOWN)[number] | 'other' {
  return (KNOWN as readonly string[]).includes(code) ? (code as (typeof KNOWN)[number]) : 'other';
}
