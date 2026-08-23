'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { makeOfferAction, type CalcFormState } from '@/app/(protected)/hisoblash/actions';

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
  revalidate,
}: {
  versionId: string;
  sealedTotal: number;
  defaultLocale: 'uz' | 'ru' | 'en';
  clientName: string | null;
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [price, setPrice] = useState(sealedTotal.toFixed(2));
  const [locale, setLocale] = useState<'uz' | 'ru' | 'en'>(defaultLocale);
  const [result, setResult] = useState<CalcFormState & { text?: string; belowFloor?: boolean; delivered?: boolean }>({});
  const [copied, setCopied] = useState(false);

  const typed = Number(price.replace(',', '.'));
  const below = Number.isFinite(typed) && typed < sealedTotal;

  return (
    <div className="space-y-2" data-testid="calc-offer">
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
          disabled={pending || price.trim() === ''}
          data-testid="offer-make"
          onClick={() =>
            startTransition(async () => {
              const res = await makeOfferAction(versionId, {
                clientPriceUsd: typed,
                locale,
                clientName,
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

      {/* The floor is stated BEFORE the press, not after: the seller is
          choosing a number, and a warning that arrives with the result is a
          warning about a decision already made. */}
      {below ? (
        <p className="text-2xs text-warn" data-testid="offer-below-floor">
          ⚠ {t('belowFloor', { floor: sealedTotal.toFixed(2) })}
        </p>
      ) : null}

      {result.error ? (
        <p className="chip chip-warn" data-testid="offer-error">
          {t.has(`errors.${result.error}`) ? t(`errors.${result.error}` as 'errors.not_found') : result.error}
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
            className="input h-40 font-mono text-2xs"
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
