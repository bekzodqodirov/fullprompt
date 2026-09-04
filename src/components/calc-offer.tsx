'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { makeOfferAction, type OfferFormState } from '@/app/(protected)/hisoblash/actions';

/**
 * «Mijozga taklif» — the seller's one tap from a sealed price to a message
 * they can forward.
 *
 * The price box is the SELLER's, prefilled with the sealed total. The sealed
 * number is what the calculation cost and, by the owner's law 4, the FLOOR a
 * client price sits above — so it is a starting point here, not the answer.
 * Quoting below it is allowed and flagged; phase D turns the flag into a lock.
 *
 * Controlled inputs and no `<form action>` (#377 and its four repeats): the
 * commonest refusal is a mistyped price, and a refusal that empties the box
 * makes the seller retype everything they got right.
 */
export function CalcOfferForm({
  versionId,
  sealedTotal,
  defaultLocale,
  clientName,
  entityType,
  entityId,
  mayApprove,
  revalidate,
  discountUsd,
}: {
  versionId: string;
  sealedTotal: number;
  defaultLocale: 'uz' | 'ru' | 'en';
  clientName: string | null;
  entityType: 'deal' | 'lead';
  entityId: string;
  /** May THIS person allow a below-floor promise? Law 4: admin-only. */
  mayApprove: boolean;
  revalidate: string;
  /** The seal's own concession. Above the discounted floor is refused (round 112). */
  discountUsd: number;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [price, setPrice] = useState(sealedTotal.toFixed(2));
  const [locale, setLocale] = useState<'uz' | 'ru' | 'en'>(defaultLocale);
  const [result, setResult] = useState<OfferFormState>({});
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);

  const typed = Number(price.replace(',', '.'));
  const below = Number.isFinite(typed) && typed < sealedTotal;
  // A concession is the customer's: once the VED has lowered the floor the
  // seller may not sell above it and keep the difference. The box stays
  // editable — BELOW is still the approver's door — but the button will not
  // press, and the sentence says why in the seller's own language, or a
  // locked price is a bug report (round 112, his «VED xodimi skidka bersa
  // sotuvchi upsale qilish huquqi bo'lmasin»).
  const discounted = discountUsd > 0;
  const aboveDiscounted = discounted && Number.isFinite(typed) && typed > sealedTotal + 0.009;

  return (
    <div className="space-y-2" data-testid="calc-offer">
      {discounted ? (
        <p className="text-xs font-semibold text-warn" data-testid="offer-discounted-floor">
          {t('discountedFloor')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs">
          <span className="label">{t('clientPrice')} $</span>
          <input
            className="input input-sm !w-28 font-mono tabular-nums"
            data-testid="offer-price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('offerLanguage')}</span>
          <select
            className="input input-sm !w-32"
            aria-label={t('offerLanguage')}
            data-testid="offer-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as 'uz' | 'ru' | 'en')}
          >
            <option value="uz">O‘zbekcha</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={
            pending || price.trim() === '' || (below && reason.trim() === '') || aboveDiscounted
          }
          data-testid="offer-make"
          onClick={() =>
            startTransition(async () => {
              const res = await makeOfferAction(versionId, {
                clientPriceUsd: typed,
                locale,
                clientName,
                belowFloorReason: reason,
                entityType,
                entityId,
                revalidate,
              });
              setResult(res);
              setCopied(false);
              if (!res.error) router.refresh();
            })
          }
        >
          {t('makeOffer')}
        </button>
      </div>

      {/* What the seller earns, live, as they type. It is the number the
          whole screen is actually about, and reading it only after pressing
          would be reading it after the decision. */}
      {!below && Number.isFinite(typed) && typed > sealedTotal ? (
        <p className="text-2xs text-good" data-testid="offer-upsale">
          {t('yourShare')}: <span className="font-mono font-semibold">
            ${(Math.round((typed - sealedTotal) * 100) / 100).toFixed(2)}
          </span>
        </p>
      ) : null}

      {/* The floor is stated BEFORE the press, not after: the seller is
          choosing a number, and a warning that arrives with the result is a
          warning about a decision already made. */}
      {below ? (
        <div className="space-y-1" data-testid="offer-below-floor">
          <p className="text-2xs text-warn">
            ⚠ {t('belowFloor', { floor: sealedTotal.toFixed(2) })}
          </p>
          <p className="text-2xs text-ink-500">
            {mayApprove ? t('belowFloorYouAllow') : t('belowFloorNeedsApproval')}
          </p>
          <label className="block text-2xs">
            <span className="label">{t('belowFloorReason')}</span>
            <input
              className="input input-sm w-full"
              data-testid="offer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      {result.error ? (
        <p className="chip chip-warn" data-testid="offer-error">
          {t.has(`errors.${result.error}`) ? t(`errors.${result.error}` as 'errors.not_found') : result.error}
        </p>
      ) : null}

      {/* A pending promise hands back nothing to forward — that is the whole
          of the lock. Saying so is better than an empty box. */}
      {result.pending ? (
        <p className="chip chip-warn" data-testid="offer-pending">
          {t('offerPending')}
        </p>
      ) : null}

      {result.text ? (
        <div className="space-y-1" data-testid="offer-result">
          {/* Honest about delivery: notifyStaffTelegram queues a row whether or
              not the person has a linked chat, and an unlinked one is settled
              `muted` minutes later where nobody looks (#719's shape). */}
          <p className="text-2xs text-ink-600">
            {result.delivered ? `✅ ${t('offerSent')}` : `⚠ ${t('offerNoTelegram')}`}
          </p>
          <textarea
            className="input h-56 font-mono text-2xs"
            aria-label={t('offerText')}
            data-testid="offer-text"
            readOnly
            value={result.text}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              data-testid="offer-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(result.text ?? '');
                setCopied(true);
              }}
            >
              {copied ? tc('saved') : tc('copy')}
            </button>
            <a
              className="btn-secondary"
              href={`/api/calc/${versionId}/offer.pdf?til=${locale}`}
              target="_blank"
              rel="noreferrer"
              data-testid="offer-pdf"
            >
              PDF
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
