'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';
import { Scanner } from '@/components/scan/scanner';

/**
 * 📷 beside the /stock search (0112, Q10 c): read the factory's barcode off a
 * carton and the table narrows to its lot — the search box's own predicate
 * (`stockTextWhere`) matches the key exactly, so the camera is only a faster
 * way of typing it. An own QR read here searches by its code, which is what
 * typing it would do too.
 *
 * The Overlay stays mounted and is toggled (#684); the scanner inside it is
 * active only while it is open, so the camera is released on close.
 */
export function StockScanButton({ warehouseId }: { warehouseId?: string }) {
  const t = useTranslations('ofis');
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        data-testid="stock-scan"
        aria-label={t('barcodeScan')}
        title={t('barcodeScan')}
        className="btn-secondary px-3"
        onClick={() => setOpen(true)}
      >
        📷
      </button>
      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        closeLabel={t('close')}
        testId="stock-scan-overlay"
        className="absolute inset-x-0 bottom-0 space-y-3 rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-96 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <p className="text-sm font-bold">🏷 {t('barcodeScan')}</p>
        <Scanner
          active={open}
          mode="retail"
          onCode={(code) => {
            setOpen(false);
            const query = new URLSearchParams({ ...(warehouseId ? { wh: warehouseId } : {}), q: code });
            router.push(`/stock?${query.toString()}`);
          }}
        />
        <button type="button" className="btn-secondary w-full" onClick={() => setOpen(false)}>
          {t('close')}
        </button>
      </Overlay>
    </>
  );
}
