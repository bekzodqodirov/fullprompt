'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import { Overlay } from '@/components/ui/overlay';
import { quickCreateLeadAction, type QuickCreateResult } from '@/app/(protected)/crm/actions';
import {
  quickCreateClientAction,
  type QuickClientResult,
} from '@/app/(protected)/admin/clients/actions';

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
  // Open leads that look like the one being typed. Held in state rather than
  // shown and forgotten, because the SECOND press has to mean «yes, anyway» —
  // and clearing them on any edit is what stops that second press applying to
  // a name the person has since changed.
  const [dupes, setDupes] = useState<
    { id: string; name: string; phone: string | null; ownerName: string | null }[]
  >([]);
  const [made, setMade] = useState<{ id: string; name: string; kind: QuickKind } | null>(null);
  // A NEW CLIENT keeps the panel open on a code banner instead of closing to
  // a toast (round 107, owner's 1B): the code goes on cartons in Yiwu the same
  // day, and «GS527» folded into one grey toast line was being missed. Held
  // separately from `made` because the toast's job — survive the close — is
  // exactly what this state must not do.
  const [madeClient, setMadeClient] = useState<{ id: string; code: string; name: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  if (kinds.length === 0) return null;

  const dirty = name.trim().length > 0 || phone.trim().length > 0;

  function reset() {
    setName('');
    setPhone('');
    setError(null);
    setDupes([]);
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
    setMadeClient(null);
    reset();
    return true;
  }

  async function save() {
    if (!kind) return;
    setBusy(true);
    setError(null);
    const result =
      kind === 'lead'
        ? await quickCreateLeadAction({ name, phone, anyway: dupes.length > 0 })
        : await quickCreateClientAction({ name, phones: phone });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'failed');
      setDupes(kind === 'lead' ? ((result as QuickCreateResult).duplicates ?? []) : []);
      return;
    }
    if (kind === 'client') {
      // The panel STAYS OPEN on the minted code, big and copyable — the one
      // thing the person came for and the one thing the old toast buried.
      setMadeClient({
        id: result.id!,
        code: (result as QuickClientResult).code ?? '',
        name: result.name!,
      });
      reset();
      router.refresh();
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

  async function copyCode() {
    if (!madeClient) return;
    try {
      await navigator.clipboard.writeText(madeClient.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permission (an old WebView): selecting the code is the
      // honest fallback — the person long-presses it like any other text.
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={t('title')}
        data-testid="quick-create"
        onClick={() => {
          setMade(null);
          setMadeClient(null);
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
        {madeClient ? (
          <div className="space-y-3" data-testid="quick-client-made">
            <p className="text-sm font-semibold text-ink-700">{t('codeTitle')}</p>
            <div className="rounded-2xl border-2 border-good bg-good/10 p-4 text-center">
              <p
                className="font-mono text-3xl font-bold tracking-widest text-good"
                data-testid="quick-client-code"
              >
                {madeClient.code}
              </p>
              <p className="mt-1 truncate text-sm text-ink-500">{madeClient.name}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="quick-copy-code"
                onClick={() => void copyCode()}
                className="btn-secondary !min-h-10 flex-1"
              >
                {copied ? t('copied') : t('copy')}
              </button>
              <Link
                href={`/admin/clients/${madeClient.id}`}
                data-testid="quick-to-card"
                className="btn-ghost !min-h-10 text-xs"
              >
                {t('toCard')}
              </Link>
            </div>
            <button
              type="button"
              data-testid="quick-done"
              onClick={() => {
                setMadeClient(null);
                setOpen(false);
              }}
              className="btn-primary w-full"
            >
              {t('done')}
            </button>
          </div>
        ) : kind === null ? (
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
              onChange={(event) => {
                setName(event.target.value);
                setDupes([]);
              }}
            />
            <input
              className="input"
              value={phone}
              data-testid="quick-phone"
              aria-label={t('phone')}
              placeholder={t('phone')}
              onChange={(event) => {
                setPhone(event.target.value);
                setDupes([]);
              }}
            />
            <p className="text-xs text-ink-500">{t(`hint.${kind}` as 'hint.lead')}</p>

            {error && (
              <p
                className={`text-sm ${dupes.length > 0 ? 'text-warn' : 'text-bad'}`}
                data-testid="quick-error"
              >
                {t(`error.${error}` as 'error.failed')}
              </p>
            )}

            {/* Named, and linked. «There is already one» is a shrug; «Aziz
                Karimov, +998…, Dilnoza's» is what stops the second call. The
                same press again creates it anyway — the warning is there to be
                read, not to be argued with. */}
            {dupes.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-warn/30 bg-warn/10 p-2" data-testid="quick-dupes">
                {dupes.map((dupe) => (
                  <li key={dupe.id} className="text-xs">
                    <a href={`/crm/leads/${dupe.id}`} className="font-semibold text-brand-700 underline">
                      {dupe.name}
                    </a>
                    <span className="text-ink-500">
                      {[dupe.phone, dupe.ownerName].filter(Boolean).map((part) => ` · ${part}`)}
                    </span>
                  </li>
                ))}
              </ul>
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
