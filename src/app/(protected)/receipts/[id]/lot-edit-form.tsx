'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { editLotAction, type EditLotState } from './edit-actions';

export interface LotEditValues {
  lotId: string;
  dimsMode: string;
  productNameZh: string;
  productNameRu: string;
  boxCount: number;
  boxLengthCm: number | null;
  boxWidthCm: number | null;
  boxHeightCm: number | null;
  boxWeightKg: string | null;
  totalWeightKg: string;
  totalVolumeM3: string;
  note: string | null;
}

/**
 * Inline lot editor on the receipt detail (spec 4.4 — audited edits).
 *
 * A member of the lot's row of actions (docs/PRIXOD-KARTA.md §7.2), so it
 * returns a FRAGMENT: the ✏️ opener is one flex item of that row and is
 * ALWAYS drawn; the form and the «saved» line are siblings that take a line
 * of their own under the row (`order-last basis-full`). It used to return the
 * button OR the form — fine while it stood alone, but in a row the opener
 * left and every button after it slid into the place the thumb had just
 * pressed (the next one is a LINK to the pallet builder).
 */
export function LotEditForm({
  lot,
  hasComposition = false,
  vouched = false,
  shownName = null,
}: {
  lot: LotEditValues;
  hasComposition?: boolean;
  /**
   * A colleague's tick or the client's own ✅ vouches for this lot NOW: a
   * change of its kilos or cubic metres turns it «o'zgardi» (0146/0147) and,
   * where the client holds a question about it, asks them again by itself
   * (the owner's «1 b» / «2 b» of 2026-11-12). Said BEFORE the press.
   */
  vouched?: boolean;
  /** The tarkib's name the lists show in place of the Russian name below, when a tarkib stands. */
  shownName?: string | null;
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const tk = useTranslations('tarkib');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<EditLotState, FormData>(editLotAction, {});
  // The form opens UNDER the row, which on a lot with many buttons is a few
  // lines below the press — brought into view, never focused (a focus would
  // raise the phone's keyboard over the thing being shown).
  const panel = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (open) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  // On success the form used to just sit there with no sign anything happened
  // (owner's bug report) — collapse it so the green "saved" badge is visible.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.ok) setOpen(false);
  }, [state]);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        className={`btn-secondary btn-sm${open ? ' bg-surface-sunken' : ''}`}
        onClick={() => setOpen((was) => !was)}
      >
        ✏️ {tc('edit')}
      </button>
      {!open && state.ok && (
        <p className="order-last basis-full text-xs font-semibold text-good [overflow-wrap:anywhere]" data-testid="lot-edit-saved">
          ✅ {tc('saved')}
          {(state.reconciliation?.labelsToPrint ?? 0) > 0 &&
            ` · 🖨 ${t('labelsToPrint', { n: state.reconciliation!.labelsToPrint })}`}
          {(state.reconciliation?.labelsToDestroy.length ?? 0) > 0 &&
            ` · 🗑 ${t('labelsToDestroy', {
              codes: state.reconciliation!.labelsToDestroy.join(', '),
            })}`}
        </p>
      )}
      {open && (
        <form ref={panel} action={formAction} className="order-last basis-full space-y-2 rounded-lg bg-surface-sunken p-3">
          <input type="hidden" name="lotId" value={lot.lotId} />
          {/* Lot tarkibi: the composition was stated against THESE totals — a
              change here leaves it stale (⚠ on the panel, «taxminiy» on the
              papers) until somebody states it again. */}
          {hasComposition && (
            <p className="text-xs font-semibold text-warn" data-testid="lot-edit-tarkib-warning">
              ⚠ {tk('staleOnLotForm')}
            </p>
          )}
          {vouched && (
            <p className="text-xs font-semibold text-warn [overflow-wrap:anywhere]" data-testid="lot-edit-measure-warning">
              ⚠ {tk('measureOnLotForm')}
            </p>
          )}
          <input
            name="productNameZh"
            className="input"
            defaultValue={lot.productNameZh}
            aria-label="zh"
            required
          />
          <input
            name="productNameRu"
            className="input"
            defaultValue={lot.productNameRu}
            aria-label="ru"
          />
          {/* The lists print the tarkib's name while one stands; THIS box stays
              the warehouse's own word (the customs papers of a sent truck, the
              sticker and the TNVED memory read it) and stays editable — said
              here, or the name on the list and the name in the form look like
              two answers to one question. */}
          {shownName && (
            <p className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="lot-edit-shown-name">
              🧩 {tk('lotFormShown', { name: shownName })}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <input
              name="boxCount"
              className="input !min-h-10 w-0 flex-1 !px-2 text-center"
              inputMode="numeric"
              defaultValue={lot.boxCount}
              aria-label="boxes"
              required
            />
            <span className="text-xs">📦</span>
          </div>
          <input
            name="note"
            className="input"
            defaultValue={lot.note ?? ''}
            aria-label="note"
            placeholder={t('note')}
          />
          {lot.dimsMode === 'uniform' ? (
            <div className="flex items-center gap-1.5">
              <input name="boxLengthCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxLengthCm ?? ''} placeholder="L" aria-label="L" required />
              <input name="boxWidthCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxWidthCm ?? ''} placeholder="W" aria-label="W" required />
              <input name="boxHeightCm" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxHeightCm ?? ''} placeholder="H" aria-label="H" required />
              <input name="boxWeightKg" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.boxWeightKg ?? ''} placeholder="kg" aria-label="kg" required />
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input name="totalWeightKg" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.totalWeightKg} placeholder="kg" aria-label="total kg" required />
              <input name="totalVolumeM3" className="input !min-h-10 w-0 flex-1 !px-2 text-center" inputMode="decimal" defaultValue={lot.totalVolumeM3} placeholder="m³" aria-label="total m3" required />
            </div>
          )}
          {state.error && (
            <p role="alert" className="text-sm font-semibold text-bad">
              {state.error === 'edit_window_closed'
                ? t('editWindowClosed')
                : state.error === 'structural_locked' || state.error === 'boxes_not_editable'
                  ? t('structuralLocked')
                  : state.error === 'shared_cost_orphaned'
                    ? t('lotShrinkOrphan')
                    : state.error === 'lot_changed'
                      ? t('lotChanged')
                      : tc('error')}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="btn-primary flex-1 disabled:opacity-60">
              {tc('save')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
