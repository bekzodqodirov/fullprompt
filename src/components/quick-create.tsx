'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import { Overlay } from '@/components/ui/overlay';
import { quickCreateLeadAction } from '@/app/(protected)/crm/actions';
import { quickCreateClientAction } from '@/app/(protected)/admin/clients/actions';

/**
 * «+» — a lead or a client in five seconds, from wherever you are.
 *
 * TWO BOXES, and nothing else. Every other field the full form asks for is
 * already defaulted by the service — a lead lands on the first stage and
 * belongs to whoever typed it, a client's code is minted — so asking for them
 * here would mean loading four option lists into the app bar on every page
 * render for every user, to save an edit that takes one tap on the card.
 * «Batafsil» is one link away for the times that is not enough.
 *
 * The form deliberately has no `<form>` element and no action prop: React
 * resets an uncontrolled form when its action returns, so a refusal would eat
 * what was typed. Controlled state, verdict read first, cleared only on
 * success — the dock's composer, which is the shape this codebase arrived at
 * after getting it wrong three times (#377, #419, #466).
 */

export type QuickKind = 'lead' | 'client';

/** Literal keys, so the i18n tripwire can see them (the STAGE_CLASS pattern). */
const KIND_LABEL: Record<QuickKind, 'newLead' | 'newClient'> = {
  lead: 'newLead',
  client: 'newClient',
};

const FULL_FORM: Record<QuickKind, string> = {
  lead: '/crm/leads/new',
  client: '/admin/clients/new',
};

export function QuickCreate({ kinds }: { kinds: QuickKind[] }) {
  const t = useTranslations('quick');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // With one kind available there is nothing to choose: pressing «+» should
  // show a text box, not a menu of one.
  const [kind, setKind] = useState<QuickKind | null>(kinds.length === 1 ? kinds[0]! : null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; name: string; kind: QuickKind } | null>(null);

  if (kinds.length === 0) return null;

  const dirty = name.trim().length > 0 || phone.trim().length > 0;

  function reset() {
    setName('');
    setPhone('');
    setError(null);
    setBusy(false);
    setKind(kinds.length === 1 ? kinds[0]! : null);
  }

  function close(reason: 'backdrop' | 'escape' | 'route'): boolean {
    // A thumb finds a full-screen backdrop very easily, and half a lead is
    // exactly the thing this codebase has three decisions about losing. A
    // NAVIGATION is never refused: the page underneath is already gone, and a
    // confirm dialog there would be a trap rather than a safeguard.
    if (reason !== 'route' && dirty && !window.confirm(t('discard'))) return false;
    setOpen(false);
    reset();
    return true;
  }

  async function save() {
    if (!kind) return;
    setBusy(true);
    setError(null);
    const result =
      kind === 'lead'
        ? await quickCreateLeadAction({ name, phone })
        : await quickCreateClientAction({ name, phones: phone });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'failed');
      return;
    }
    // Stay put. The person is on a call looking at a board; jumping them to
    // the new card is the interruption this button exists to avoid. The link
    // in the confirmation is there for when they do want it.
    setMade({ id: result.id!, name: result.name!, kind });
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        aria-label={t('title')}
        data-testid="quick-create"
        onClick={() => {
          setMade(null);
          setOpen(true);
        }}
        className="btn-ghost btn-icon text-ink-700"
      >
        <Icon name="plus" />
      </button>

      <Overlay
        open={open}
        onClose={close}
        closeLabel={t('close')}
        testId="quick-panel"
        className="absolute inset-x-3 top-3 space-y-3 rounded-2xl bg-surface-raised p-3 shadow-pop md:inset-x-auto md:left-1/2 md:w-[26rem] md:-translate-x-1/2"
      >
        {kind === null ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink-700">{t('title')}</p>
            {kinds.map((one) => (
              <button
                key={one}
                type="button"
                data-testid={`quick-kind-${one}`}
                onClick={() => setKind(one)}
                className="btn-secondary w-full !justify-start"
              >
                {t(KIND_LABEL[one])}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink-700">{t(KIND_LABEL[kind])}</p>
            <input
              className="input"
              autoFocus
              value={name}
              data-testid="quick-name"
              aria-label={t('name')}
              placeholder={t('name')}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="input"
              value={phone}
              data-testid="quick-phone"
              aria-label={t('phone')}
              placeholder={t('phone')}
              onChange={(event) => setPhone(event.target.value)}
            />
            <p className="text-xs text-ink-500">{t(`hint.${kind}` as 'hint.lead')}</p>

            {error && (
              <p className="text-sm text-bad" data-testid="quick-error">
                {t(`error.${error}` as 'error.failed')}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || name.trim().length < 2}
                data-testid="quick-save"
                onClick={() => void save()}
                className="btn-primary !min-h-10 flex-1"
              >
                {t('save')}
              </button>
              <Link
                href={FULL_FORM[kind]}
                data-testid="quick-full"
                className="btn-ghost !min-h-10 text-xs"
              >
                {t('full')}
              </Link>
            </div>
          </div>
        )}
      </Overlay>

      {/* What was made, once, until it is dismissed — the answer the modal
          would have taken away with it when it closed. */}
      {made && (
        <span
          data-testid="quick-made"
          className="fixed inset-x-3 bottom-24 z-40 flex items-center gap-2 rounded-xl bg-surface-raised p-2 text-sm shadow-pop md:inset-x-auto md:right-4 md:w-80"
        >
          <span className="flex-1 truncate text-good">{t('created')}</span>
          <Link
            href={made.kind === 'lead' ? `/crm/leads/${made.id}` : `/admin/clients/${made.id}`}
            className="truncate font-semibold underline"
          >
            {made.name}
          </Link>
          <button
            type="button"
            aria-label={t('close')}
            onClick={() => setMade(null)}
            className="btn-ghost btn-icon !min-h-8 shrink-0"
          >
            ✕
          </button>
        </span>
      )}
    </>
  );
}
