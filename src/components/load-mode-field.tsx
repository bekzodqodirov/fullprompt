'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * «Yuk turi» on the lead and deal ✏️ forms (0135, the owner's 1a 2a).
 *
 * Drawn OUTSIDE the quote-lock ternary: a sealed price does not lock the
 * mode. The office (admin, logist, accountant — `mayRevertFtl`) gets the
 * plain choice. Everybody else may turn LTL into FTL and never back, so on a
 * STORED FTL record they get a chip and post NOTHING: the services read an
 * absent mode as «unchanged» and an owner change on an FTL record with no
 * mode fails closed. A hidden `ftl` here would undo an office revert made
 * while the card stood open — the next unrelated save would re-mark the job
 * (or be refused for a mode its author never touched). The service asks the
 * door again on what it is about to write (#531); this component only
 * decides what to draw.
 *
 * `creating`: a NEW record has nothing stored to protect, so a prefill (a won
 * FTL lead's «Bitim ochish») is a preselected value in the plain choice,
 * never a lock — the seller may still pick LTL for the client's next,
 * ordinary shipment.
 *
 * The select is UNCONTROLLED with `defaultValue`: React resets a form after
 * its action, and a controlled select snaps back to the mode the page first
 * rendered — the next save would then post the stale mode. The caller keys
 * the field on the stored mode, so a saved change remounts it.
 *
 * `null` = the server is one migration behind (0135 not applied): nothing is
 * drawn and nothing posted, which the service reads as «unchanged».
 */
export function LoadModeField({
  load,
}: {
  load: { initial: 'ltl' | 'ftl'; office: boolean; creating?: boolean } | null;
}) {
  const t = useTranslations('ftl');
  const [mode, setMode] = useState(load?.initial ?? 'ltl');
  if (!load) return null;

  if (load.initial === 'ftl' && !load.office && !load.creating) {
    return (
      <div className="block" data-testid="load-mode-locked">
        <span className="label">{t('label')}</span>
        <p className="text-sm">
          <span className="chip chip-neutral">🚛 {t('ftlLong')}</span>
        </p>
        <p className="mt-1 text-2xs text-ink-500">{t('officeOnly')}</p>
      </div>
    );
  }

  return (
    <label className="block">
      <span className="label">{t('label')}</span>
      <select
        name="loadMode"
        defaultValue={load.initial}
        onChange={(event) => setMode(event.target.value === 'ftl' ? 'ftl' : 'ltl')}
        className="input"
        data-testid="load-mode"
      >
        <option value="ltl">{t('ltlLong')}</option>
        <option value="ftl">{t('ftlLong')}</option>
      </select>
      {!load.office && mode === 'ftl' && (load.initial === 'ltl' || load.creating) ? (
        <span className="mt-1 block text-2xs text-warn" data-testid="load-mode-warn">
          {t('sellerWarn')}
        </span>
      ) : null}
    </label>
  );
}
