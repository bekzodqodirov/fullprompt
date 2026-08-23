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

/**
 * `fullForms` is the subset of `kinds` whose «Batafsil →» page this person can
 * actually open — decided in the layout, because this component holds no
 * permission knowledge (the nav's own rule). `/admin/clients/new` is gated on
 * `clients.manage` at the page AND at its action, so for the seller round 111
 * opened the quick client door to, the link would have bounced them to the
 * home screen and eaten what they had typed.
 */
export function QuickCreate({
  kinds,
  fullForms,
}: {
  kinds: QuickKind[];
  fullForms: QuickKind[];
}) {
  const t = useTranslations('quick');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The panel ALWAYS opens on a text box — round 60's rule, kept now that
  // there can be two kinds: the chip strip switches between them in place
  // rather than standing in front of them. The first kind is the default
  // because the layout lists them in the order this company uses them (a lead
  // is raised many times a day, a client code weekly).
  const [kind, setKind] = useState<QuickKind>(kinds[0] ?? 'lead');
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
  // The client door's own warning: codes this phone already carries. Kept
  // apart from `dupes` because a lead duplicate and a sibling CODE are
  // different facts and link to different cards — one person legitimately
  // holds several codes in this business, so this can never be a refusal.
  const [codeDupes, setCodeDupes] = useState<{ id: string; code: string; name: string }[]>([]);
  const [made, setMade] = useState<{ id: string; name: string; kind: QuickKind } | null>(null);
  // A NEW CLIENT keeps the panel open on a code banner instead of closing to
  // a toast (round 107, owner's 1B): the code goes on cartons in Yiwu the same
  // day, and «GS527» folded into one grey toast line was being missed. Held
  // separately from `made` because the toast's job — survive the close — is
  // exactly what this state must not do.
  const [madeClient, setMadeClient] = useState<{
    id: string;
    code: string;
    name: string;
    dealId: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  if (kinds.length === 0) return null;

  const dirty = name.trim().length > 0 || phone.trim().length > 0;

  function reset() {
    setName('');
    setPhone('');
    setError(null);
    setDupes([]);
    setCodeDupes([]);
    setBusy(false);
    // The KIND deliberately survives a reset: somebody opening two client
    // codes in a row should not have to pick the chip again. `close()` puts it
    // back to the default, so the next «+» starts where it always did.
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
    setKind(kinds[0] ?? 'lead');
    return true;
  }

  async function save() {
    setBusy(true);
    setError(null);
    const result =
      kind === 'lead'
        ? await quickCreateLeadAction({ name, phone, anyway: dupes.length > 0 })
        : await quickCreateClientAction({ name, phones: phone, anyway: codeDupes.length > 0 });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'failed');
      setDupes(kind === 'lead' ? ((result as QuickCreateResult).duplicates ?? []) : []);
      setCodeDupes(kind === 'client' ? ((result as QuickClientResult).duplicates ?? []) : []);
      return;
    }
    if (kind === 'client') {
      // The panel STAYS OPEN on the minted code, big and copyable — the one
      // thing the person came for and the one thing the old toast buried.
      setMadeClient({
        id: result.id!,
        code: (result as QuickClientResult).code ?? '',
        name: result.name!,
        dealId: (result as QuickClientResult).dealId ?? null,
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
            {/* Its OWN row, not a third control beside copy and the card
                link: measured in ru at 360 px, three `.btn` controls overflow
                the panel's 312 px row by 20-58 px even after every label has
                wrapped, and the third paints outside the panel over the
                backdrop (#421/#471/#522). Absent when the funnel refused the
                deal — the panel never claims one that does not exist. */}
            {madeClient.dealId && (
              <Link
                href={`/bitimlar/${madeClient.dealId}`}
                data-testid="quick-to-deal"
                className="btn-secondary !min-h-10 w-full"
              >
                {t('toDeal')}
              </Link>
            )}
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
        ) : (
          <div className="space-y-2">
            {/* The kinds are CHIPS above the boxes, not a menu in front of
                them. Round 60 opened straight into the text box because there
                was one kind; adding the client door for sellers would
                otherwise have charged the whole sales team an extra tap on the
                thing they do most, to reach a door they use weekly. With one
                kind the strip does not render at all, so nothing changes for
                anybody who has only one. Plain buttons, not peer-checked
                radios: this panel deliberately has no <form> (#377/#419/#466). */}
            {kinds.length > 1 ? (
              <div className="flex gap-1.5" data-testid="quick-kinds">
                {kinds.map((one) => (
                  <button
                    key={one}
                    type="button"
                    data-testid={`quick-kind-${one}`}
                    aria-pressed={kind === one}
                    onClick={() => {
                      setKind(one);
                      setError(null);
                      setDupes([]);
                      setCodeDupes([]);
                    }}
                    className={
                      kind === one
                        ? 'chip flex-1 justify-center !bg-brand-500 !text-white'
                        : 'chip flex-1 justify-center'
                    }
                  >
                    {t(KIND_LABEL[one])}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm font-semibold text-ink-700">{t(KIND_LABEL[kind])}</p>
            )}
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
                setCodeDupes([]);
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
                setCodeDupes([]);
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

            {/* The codes this number already holds. NOT a refusal: one person
                carrying 444, 555 and 777 is this company's normal shape, and
                the seller who cannot open the client book has no other way to
                find out. The same press again mints the new code. */}
            {codeDupes.length > 0 && (
              <ul
                className="space-y-1 rounded-xl border border-warn/30 bg-warn/10 p-2"
                data-testid="quick-code-dupes"
              >
                {codeDupes.map((one) => (
                  <li key={one.id} className="text-xs">
                    <span className="font-mono font-semibold text-brand-700">{one.code}</span>
                    <span className="text-ink-500"> · {one.name}</span>
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
              {fullForms.includes(kind) && (
                <Link
                  href={FULL_FORM[kind]}
                  data-testid="quick-full"
                  className="btn-ghost !min-h-10 text-xs"
                >
                  {t('full')}
                </Link>
              )}
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
