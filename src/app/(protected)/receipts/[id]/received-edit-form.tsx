'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setReceivedAction } from './edit-actions';

/** Who physically received it: a colleague from the picker, a typed name, or not yet said. */
export type ReceiverChoice = { kind: 'user'; userId: string } | { kind: 'name'; name: string } | null;

export interface ReceiverOption {
  id: string;
  name: string;
}

/** What the service is posted, or null while the choice is incomplete. */
export function receiverPayload(choice: ReceiverChoice): { userId: string } | { name: string } | null {
  if (!choice) return null;
  if (choice.kind === 'user') return choice.userId ? { userId: choice.userId } : null;
  const name = choice.name.trim();
  return name.length >= 2 ? { name } : null;
}

const OTHER = '__name';

/**
 * The office receipt's two facts (0112, the owner's Q9 b), as ONE control
 * shared by the receive wizard and the prixod card's correction form: the
 * REAL day, bounded to [entry − 7, entry] in the warehouse's zone, and WHO
 * physically received the cartons — «Men o'zim», a colleague assigned to that
 * warehouse, or a typed name for somebody with no login (the driver, the
 * factory's loader).
 *
 * «Men o'zim» is ALWAYS the first real option, so it is one tap for the
 * common case of the logist standing in the warehouse himself. Controlled
 * inputs: a refused save keeps what was typed (#377).
 */
export function OfficeReceivedFields({
  day,
  bounds,
  onDay,
  choice,
  onChoice,
  me,
  receivers,
  disabled = false,
}: {
  day: string;
  bounds: { min: string; max: string } | null;
  onDay: (day: string) => void;
  choice: ReceiverChoice;
  onChoice: (choice: ReceiverChoice) => void;
  me: ReceiverOption;
  receivers: ReceiverOption[];
  disabled?: boolean;
}) {
  const t = useTranslations('ofis');
  const others = receivers.filter((person) => person.id !== me.id);
  const selectValue = !choice ? '' : choice.kind === 'name' ? OTHER : `u:${choice.userId}`;
  return (
    <div className="space-y-2" data-testid="receive-office">
      <p className="text-xs font-semibold text-ink-500">🏢 {t('officeHint')}</p>
      <div className="flex flex-wrap gap-2">
        <label className="flex shrink-0 flex-col">
          <span className="text-[11px] font-semibold text-ink-500">{t('receivedDate')}</span>
          <input
            type="date"
            data-testid="receive-date"
            className="input !w-40 shrink-0"
            disabled={disabled || !bounds}
            min={bounds?.min}
            max={bounds?.max}
            value={day}
            onChange={(e) => onDay(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11px] font-semibold text-ink-500">{t('receivedBy')}</span>
          <select
            data-testid="receive-receiver"
            className="input min-w-0"
            disabled={disabled}
            value={selectValue}
            onChange={(e) => {
              const value = e.target.value;
              if (!value) onChoice(null);
              else if (value === OTHER) onChoice({ kind: 'name', name: '' });
              else onChoice({ kind: 'user', userId: value.slice(2) });
            }}
          >
            <option value="">{t('receiverPick')}</option>
            <option value={`u:${me.id}`}>{t('receiverSelf', { name: me.name })}</option>
            {others.map((person) => (
              <option key={person.id} value={`u:${person.id}`}>
                {person.name}
              </option>
            ))}
            <option value={OTHER}>✍️ {t('receiverOther')}</option>
          </select>
        </label>
      </div>
      {choice?.kind === 'name' && (
        <input
          data-testid="receive-receiver-name"
          className="input"
          disabled={disabled}
          maxLength={120}
          placeholder={t('receiverOtherPlaceholder')}
          value={choice.name}
          onChange={(e) => onChoice({ kind: 'name', name: e.target.value })}
        />
      )}
    </div>
  );
}

/**
 * The correction door on the prixod card: the same two facts, on the day the
 * prixod was typed, for the office (`mayCorrectReceived` decides whether the
 * page renders this at all; the service asks again).
 */
export function ReceivedEditForm({
  receiptId,
  day: initialDay,
  bounds,
  receiver,
  me,
  receivers,
}: {
  receiptId: string;
  day: string;
  bounds: { min: string; max: string };
  receiver: ReceiverChoice;
  me: ReceiverOption;
  receivers: ReceiverOption[];
}) {
  const t = useTranslations('ofis');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(initialDay);
  const [choice, setChoice] = useState<ReceiverChoice>(receiver);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const payload = receiverPayload(choice);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="receipt-received-edit"
          className="btn-secondary !min-h-9 px-2 text-sm"
          onClick={() => {
            setSaved(false);
            setOpen(true);
          }}
        >
          ✏️ {t('receivedEdit')}
        </button>
        {saved && <span className="text-xs font-semibold text-good">✅ {tc('saved')}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg bg-surface-sunken p-3">
      <OfficeReceivedFields
        day={day}
        bounds={bounds}
        onDay={setDay}
        choice={choice}
        onChoice={setChoice}
        me={me}
        receivers={receivers}
        disabled={pending}
      />
      {error && (
        <p role="alert" data-testid="receipt-received-error" className="text-sm font-semibold text-bad">
          {receivedErrorText(error, t, tc)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="receipt-received-save"
          className="btn-primary flex-1 disabled:opacity-60"
          disabled={pending || !payload || !day}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await setReceivedAction({ receiptId, receivedDay: day, receivedBy: payload });
              if (res.ok) {
                setSaved(true);
                setOpen(false);
              } else setError(res.error ?? 'error');
            })
          }
        >
          {tc('save')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * The office receipt's refusals in words — ONE literal switch for the wizard
 * and the card (a code without a key fails at render, footgun 1). Unknown
 * codes fall back to the generic sentence rather than printing the code.
 */
export function receivedErrorText(
  code: string,
  t: (key: string, values?: Record<string, string>) => string,
  tc: (key: string) => string,
  detail?: string,
): string {
  const lot = detail ?? '';
  switch (code) {
    case 'on_behalf_forbidden':
      return t('errors.on_behalf_forbidden');
    case 'receiver_required':
      return t('errors.receiver_required');
    case 'receiver_invalid':
      return t('errors.receiver_invalid');
    case 'received_day_invalid':
      return t('errors.received_day_invalid');
    case 'received_in_future':
      return t('errors.received_in_future');
    case 'received_too_old':
      return t('errors.received_too_old');
    case 'received_locked':
      return t('errors.received_locked');
    case 'barcode_invalid':
      return t('errors.barcode_invalid', { lot });
    case 'barcode_is_ours':
      return t('errors.barcode_is_ours', { lot });
    case 'server_behind':
      return t('errors.server_behind');
    case 'forbidden':
      return t('errors.forbidden');
    default:
      return tc('error');
  }
}
