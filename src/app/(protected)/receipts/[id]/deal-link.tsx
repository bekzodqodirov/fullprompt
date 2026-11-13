'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { dealOptionLabel } from '@/modules/wms/deals/cargo-label';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { linkReceiptAction } from '../../bitimlar/actions';

/**
 * Which job this cargo belongs to, seen and corrected FROM THE CARGO.
 *
 * Until now the link only ever existed on the deal's side: the receiving
 * wizard offered a deal, and the deal card offered the client's *unlinked*
 * receipts. That left the commonest mistake with no way back — a receipt
 * attached to the wrong job disappeared from the deal card's picker (it is no
 * longer unlinked) and the receipt card said nothing about a deal at all, so
 * the owner could see the error and not undo it.
 *
 * The picker offers the client's OPEN deals plus, always, the one this receipt
 * is on even when that deal has since been won or lost — otherwise correcting
 * a mistake would first hide what the mistake was. The empty option detaches.
 *
 * Gated on the deal-write list, the same one the action enforces: this is
 * re-filing a job's cargo, which is the sales/VED power, not a warehouse one.
 */
export function DealLink({
  receiptId,
  current,
  options,
  hasCompensation = false,
  newDealHref = null,
  foreign = null,
  voided = false,
}: {
  /** The prixod is voided: said in the block's own first line (the button that opens it outlives the prixod). */
  voided?: boolean;
  /**
   * The prixod still carries a deal of ANOTHER client (a client correction
   * leaves `deal_id` on the old client's job). It is no deal of this
   * prixod's — the seller's message said «no deal» — so the block must not
   * print it as linked: it is named in one muted line under the control
   * row, and while it stands «Saqlash» is drawn whatever the select holds —
   * a deal of this client replaces it, the empty option takes the prixod
   * off it, and a new deal replaces it too.
   */
  foreign?: { code: string } | null;
  receiptId: string;
  current: { id: string; code: string } | null;
  options: { id: string; code: string; title: string | null; cargo: string }[];
  /** 0105: a live compensation names this prixod — it follows the cargo. */
  hasCompensation?: boolean;
  /**
   * «+ Yangi bitim ochish» (0146): the deal form with this prixod's client
   * preset AND this prixod riding along, so the new deal is born with the
   * cargo on it. Null for a reader who may not open a deal (the VED), and
   * for a prixod that already has one.
   */
  newDealHref?: string | null;
}) {
  const t = useTranslations('receipts');
  const td = useTranslations('deals');
  const tc = useTranslations('common');
  const router = useRouter();
  const [dealId, setDealId] = useState(current?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Arrived from the new-deal form (`?bitim=1`): a server action's redirect
  // cannot carry `#bitim`, so the block brings itself into view and wears
  // the same frame the anchor gives it. Done on the element, not through
  // state: it is the page's scroll being synchronised, not something to render.
  const block = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('bitim') !== '1') return;
    const el = block.current;
    if (!el) return;
    el.classList.add('outline', 'outline-2', 'outline-offset-4', 'outline-brand-500');
    el.scrollIntoView({ block: 'start' });
  }, []);

  // One cell of the card's «ties» (docs/PRIXOD-KARTA.md §7.1) — the anatomy
  // all four share: a small label, ONE line saying what it is tied to now,
  // one row to change it. «Saqlash» is drawn only once the answer differs
  // (#422): four always-drawn primary buttons in one card were four things
  // asking to be pressed.
  return (
    // `id` = RECEIPT_DEAL_ANCHOR: the seller's «🔗 Bitim biriktirish» button
    // (Telegram, «Prixod keldi») opens the card HERE, not at the top of a
    // long page; the scroll margin clears the sticky app bar and the frame
    // says which cell was meant. An OUTLINE with an offset, not a ring: the
    // cell has no card of its own since the «ties» card, and a ring would
    // sit on its letters. An outline takes no room, so nothing moves.
    <div
      ref={block}
      id="bitim"
      data-testid="receipt-deal-block"
      className="scroll-mt-20 space-y-1.5 rounded-sm target:outline target:outline-2 target:outline-offset-4 target:outline-brand-500"
    >
      <p className="section-title">{t('deal')}</p>
      <p className="text-sm [overflow-wrap:anywhere]">
        {current ? (
          <Link
            href={`/bitimlar/${current.id}`}
            className="font-mono font-bold text-brand-700 underline"
          >
            {current.code}
          </Link>
        ) : (
          <span className="text-ink-500">{t('dealNone')}</span>
        )}
      </p>
      {voided && (
        <p className="text-sm font-semibold text-bad" data-testid="receipt-deal-voided">
          {t('dealVoided')}
        </p>
      )}
      <div className="flex gap-2">
        <select
          value={dealId}
          onChange={(event) => setDealId(event.target.value)}
          aria-label={t('deal')}
          data-testid="receipt-deal-pick"
          className="input-sm min-w-0 flex-1"
        >
          <option value="">— {td('unlink')}</option>
          {options.map((deal) => (
            <option key={deal.id} value={deal.id}>
              {dealOptionLabel(deal)}
            </option>
          ))}
        </select>
        {/* …or while a deal of ANOTHER client still stands on the prixod: then
            «current» is null and the select opens on its empty option, so
            «differs» alone would never draw the button for it — and the one
            answer that needs no deal at all, «take it off that job», had no
            door anywhere (the deal card only attaches). The press sends what
            the select holds; empty detaches. */}
        {(dealId !== (current?.id ?? '') || foreign !== null) && (
          <button
            type="button"
            disabled={pending}
            data-testid="receipt-deal-save"
            className="btn-primary btn-sm shrink-0 disabled:opacity-50"
            onClick={() =>
              startTransition(async () => {
                const result = await linkReceiptAction(receiptId, dealId || null);
                setError(result.ok ? null : (result.error ?? 'error'));
                if (result.ok) router.refresh();
              })
            }
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        )}
      </div>
      {/* Under the control row, with the cell's other sentences: between the
          value line and the select it pushed «Bitim»'s select below «Zavod
          reysi»'s on a VED's desktop card — the very gap the ties' one
          anatomy closed (docs/PRIXOD-KARTA.md §7.1). The sentence offers only
          what this reader is offered: no «open a new one» without the link. */}
      {foreign && (
        <p className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="receipt-deal-foreign">
          {t(newDealHref ? 'dealForeign' : 'dealForeignPick', { code: foreign.code })}
        </p>
      )}
      {newDealHref && (
        <Link href={newDealHref} className="inline-block text-sm font-semibold text-brand-700 underline" data-testid="receipt-deal-new">
          + {t('dealNew')}
        </Link>
      )}
      {/* Said BEFORE the press (0105): re-filing the cargo re-files the money
          paid back for its lost cartons with it (`followCompensationDealTx`). */}
      {hasCompensation && (
        <p className="text-xs text-warn" data-testid="receipt-deal-compensation">
          {t('dealLinkCompensation')}
        </p>
      )}
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="receipt-deal-error">
          {error === 'upsale_paid' ? t('dealLinkUpsalePaid') : tc('error')}
        </p>
      )}
    </div>
  );
}
