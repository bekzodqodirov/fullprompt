'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { dismissDisputesAction } from './client-ask-actions';
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
 * The CLIENT's own answer in Telegram (0144) is a third line. Their ✅ is
 * drawn like a colleague's. Their ❌ is a veto, and while it is the reason the
 * lot reads ❓ (`client.vetoes`, the sentence's own word — never re-derived
 * here) it LEADS in the bad colour and every ✅ line under it is history: a
 * disputed lot must not show green on the one screen that explains the
 * dispute. The ways out are on the same panel: the tick (a colleague who has
 * heard the client) and «E'tirozni yopish» — which stays wherever the cargo
 * stands, so a dispute raised in China does not vanish when the truck unloads.
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
  /** The client's own ✅ / ❌ in Telegram (0144); null = none, or a server without 0144. */
  client: {
    verdict: 'yes' | 'no';
    day: string;
    /** `answered_at::text` — posted back by the tick and by «E'tirozni yopish». */
    token: string;
    /** The answer is about what the lists still show. */
    holds: boolean;
    /** This ❌ is why the lot reads ❓ right now. */
    vetoes: boolean;
    /** The prixod's CURRENT owner's answer — a previous owner's is drawn nowhere. */
    ofOwner: boolean;
    askedBy: string | null;
  } | null;
}

export function LotCheckPanel({
  receiptId,
  lotId,
  face,
  seen,
  canWrite,
  canRename,
  phones,
}: {
  receiptId: string;
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
  // A previous owner's answer is nobody's: the sentence ignores it, so does the card.
  const client = face.client?.ofOwner ? face.client : null;
  const vetoed = client?.vetoes === true;
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
  // Undo only where the tick can be given again: on cargo already in
  // Uzbekistan the person's row stays as history (4a asks nothing there).
  const offerUndo = canWrite && person !== null && face.askable;

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
        // Whatever answer the table holds for this lot, as this page drew it:
        // a ❌ that arrived since must not be lifted by a tick that never saw it.
        seenClientAt: face.client?.token ?? null,
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

  async function closeDispute() {
    if (!client || !window.confirm(t('disputeCloseConfirm'))) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await dismissDisputesAction({ receiptId, seen: [{ lotId, token: client.token }], note: note.trim() || undefined });
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

  const lines: React.ReactNode[] = [];
  const asked = client ? (client.askedBy ? t('clientAskedBy', { by: client.askedBy }) : t('clientViaPush')) : '';
  if (client && vetoed) {
    lines.push(
      <p key="client-no" className="font-semibold text-bad [overflow-wrap:anywhere]" data-testid="lot-check-face-client-no">
        ❌ {t('clientNo')} · {client.day}
        <span className="block text-xs font-normal text-ink-500">
          {asked}
          {!client.holds && ` · ${t('clientMovedSince')}`}
        </span>
      </p>,
    );
  }
  if (face.byDocument) {
    lines.push(
      vetoed ? (
        <p key="doc-held" className="text-xs text-ink-500" data-testid="lot-check-face-document-held">
          {t('documentHeld')}
        </p>
      ) : (
        <p key="doc" className="font-semibold text-good" data-testid="lot-check-face-document">
          ✅ {t('byDocument')}
        </p>
      ),
    );
  }
  if (person?.holds) {
    lines.push(
      vetoed ? (
        <p key="person-held" className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="lot-check-face-person-held">
          {t('personHeld', { by: person.by ?? '—', day: person.day })}
        </p>
      ) : (
        <p key="person" className="font-semibold text-good [overflow-wrap:anywhere]" data-testid="lot-check-face-person">
          ✅ {t('byClient')} · {person.by ?? '—'} · {person.day}
          {person.note && <span className="block text-xs font-normal italic text-ink-500">«{person.note}»</span>}
        </p>
      ),
    );
  }
  if (client?.verdict === 'yes' && client.holds) {
    lines.push(
      <p key="client-yes" className="font-semibold text-good [overflow-wrap:anywhere]" data-testid="lot-check-face-client-yes">
        ✅ {t('clientYes')} · {client.day}
        <span className="block text-xs font-normal text-ink-500">{asked}</span>
      </p>,
    );
  }
  if (client?.verdict === 'yes' && !client.holds) {
    lines.push(
      asking ? (
        <p key="client-stale" className="font-semibold text-warn [overflow-wrap:anywhere]" data-testid="lot-check-face-client-stale">
          ⚠️ {t('clientStale', { day: client.day })}
        </p>
      ) : (
        <p key="client-old" className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="lot-check-face-client-old">
          {t('clientYesOld', { day: client.day })}
        </p>
      ),
    );
  }
  if (client?.verdict === 'no' && !vetoed) {
    lines.push(
      <p key="client-no-old" className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="lot-check-face-client-no-old">
        {t('clientNoOld', { day: client.day })}
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
  // Under a veto the ❌ line above IS the reason — a second «❓ tekshirilmagan» would say it twice.
  if (face.state === 'none' && face.askable && !vetoed) {
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
  // «E'tirozni yopish»: for every ❌ of this owner still on record — the one
  // that vetoes, and one a later tick or a changed tarkib has outranked (it
  // would veto again the day that basis goes stale).
  const offerClose = canWrite && client?.verdict === 'no';
  // Cargo already in Uzbekistan that nobody checked says nothing (his 4a).
  if (lines.length === 0 && !offerUndo && !offerClose && !done && !error) return null;

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-line p-2 text-sm"
      data-testid="lot-check"
      data-state={face.state}
      data-askable={face.askable ? 'true' : 'false'}
    >
      {lines}

      {(offerConfirm || offerUndo || offerClose) && (
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
                  `receipts.edit` alone, so the VED writes a one-line 🧩 for
                  the papers and asks the logist to rename the lot itself
                  (his 2026-10-27: a tarkib may be ONE line). While a tarkib
                  is WRITTEN the ✏️ is no cure for anybody: the card prints
                  the tarkib's name and the ✅ records it (2026-11-10), so a
                  rename there changes neither — the person who followed the
                  hint would tick «Мышь» the client had just denied. Both
                  roles are sent to the 🧩 then (the review of the built round). */}
              <p className="text-xs text-ink-500" data-testid="lot-check-other">
                {canRename && !face.documentStale ? t('otherAnswers') : t('otherAnswersAskLogist')}
              </p>
            </>
          )}
          {offerClose && (
            <>
              {vetoed && (
                <p className="text-xs text-ink-500" data-testid="lot-check-dispute-hint">
                  {t('disputeHint')}
                </p>
              )}
              <button
                type="button"
                className="btn-secondary w-full"
                data-testid="lot-check-dispute-close"
                disabled={busy}
                onClick={closeDispute}
              >
                {t('disputeClose')}
              </button>
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
