'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setReceiptCustomsAction } from '../batch-actions-server';
import type { CustomsRow } from '@/modules/wms/partners/customs';

/**
 * Rastamojka per PRIXOD (owner: «1 ta partiyaning ichidan ba'zi yuklarni
 * o'zini rastamojkasini klientlar o'zi qiladi, qolganini biz qilamiz»).
 *
 * Each row starts on «truck's answer» and says so, because that is the honest
 * default and the state most rows will stay in. Changing one is a decision
 * about one client's cargo, so it saves on its own and nothing else moves.
 *
 * The list is NOT a fold of its own. It shipped inside one — nested in the
 * collapsed VED panel — and the owner reported the whole feature as missing
 * (round 43): two taps deep with nothing on the outside to say it was there.
 * The panel above is the only fold; what is inside it is simply visible.
 */
export function CustomsPerReceipt({
  batchId,
  rows,
  partners,
  canEdit,
}: {
  batchId: string;
  rows: CustomsRow[];
  partners: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations('batches');
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-line pt-2">
      <p className="section-title">
        {t('customsPerReceipt')} <span className="text-ink-500">({rows.length})</span>
      </p>
      <div className="mt-1 space-y-1.5">
        {rows.map((row) => (
          <Row key={row.receiptId} batchId={batchId} row={row} partners={partners} canEdit={canEdit} />
        ))}
      </div>
    </div>
  );
}

function Row({
  batchId,
  row,
  partners,
  canEdit,
}: {
  batchId: string;
  row: CustomsRow;
  partners: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const current = row.fromBatch ? '' : row.byClient ? 'client' : (row.partnerId ?? '');
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-lg bg-surface-sunken p-2">
      {/* Whose prixod, on its own line. Sharing the row with the picker left
          the picker two characters wide on a phone — «Ка» for «Как у партии»,
          which is not a choice anybody can read back (round 43). */}
      <p className="truncate text-sm">
        <span className="font-mono font-bold text-brand-700">{row.clientCode ?? '—'}</span>{' '}
        <span className="font-mono text-xs text-ink-500">{row.number}</span>
      </p>
      {canEdit ? (
        <>
          <select
            className="input mt-1 !py-1 text-sm"
            aria-label={t('customsFirm')}
            data-testid="receipt-customs-pick"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            {/* The truck's answer, named — so nobody has to remember what an
                empty option means on a screen full of them. */}
            <option value="">
              {t('customsFromBatch')}
              {row.fromBatch && (row.byClient || row.partnerName)
                ? `: ${row.byClient ? t('customsByClient') : row.partnerName}`
                : ''}
            </option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
            <option value="client">{t('customsByClient')}</option>
          </select>
          {/* Only once something has actually been changed. A pale disabled
              button under every prixod is a wall of buttons that say nothing. */}
          {value !== current && (
            <button
              type="button"
              className="btn-primary mt-1 w-full !py-1 text-sm"
              data-testid="receipt-customs-save"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await setReceiptCustomsAction(batchId, row.receiptId, value);
                  router.refresh();
                })
              }
            >
              {pending ? tc('loading') : tc('save')}
            </button>
          )}
        </>
      ) : (
        <p className="text-sm">
          {row.byClient ? t('customsByClient') : (row.partnerName ?? '—')}
          {row.fromBatch && <span className="ml-1 text-xs text-ink-500">({t('customsFromBatch')})</span>}
        </p>
      )}
    </div>
  );
}
