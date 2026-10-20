'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * «Yuk turi» on the lead and deal ✏️ forms (0135, the owner's 1a 2a).
 *
 * Drawn OUTSIDE the quote-lock ternary: a sealed price does not lock the
 * mode. The office (admin, logist, accountant — `mayRevertFtl`) gets the
 * plain choice. Everybody else may turn LTL into FTL and never back, so on an
 * FTL record they get a chip and a HIDDEN input carrying it — a disabled
 * select posts nothing, and on this replace-all form «nothing» would be read
 * as a change (#171). The service asks the door again on what it is about to
 * write (#531); this component only decides what to draw.
 *
 * `null` = the server is one migration behind (0135 not applied): nothing is
 * drawn and nothing posted, which the service reads as «unchanged».
 */
export function LoadModeField({ load }: { load: { initial: 'ltl' | 'ftl'; office: boolean } | null }) {
  const t = useTranslations('ftl');
  const [mode, setMode] = useState(load?.initial ?? 'ltl');
  if (!load) return null;

  if (load.initial === 'ftl' && !load.office) {
    return (
      <div className="block" data-testid="load-mode-locked">
        <span className="label">{t('label')}</span>
        <p className="text-sm">
          <span className="chip chip-neutral">🚛 {t('ftlLong')}</span>
        </p>
        <p className="mt-1 text-2xs text-ink-500">{t('officeOnly')}</p>
        <input type="hidden" name="loadMode" value="ftl" />
      </div>
    );
  }

  return (
    <label className="block">
      <span className="label">{t('label')}</span>
      <select
        name="loadMode"
        value={mode}
        onChange={(event) => setMode(event.target.value === 'ftl' ? 'ftl' : 'ltl')}
        className="input"
        data-testid="load-mode"
      >
        <option value="ltl">{t('ltlLong')}</option>
        <option value="ftl">{t('ftlLong')}</option>
      </select>
      {!load.office && mode === 'ftl' && load.initial === 'ltl' ? (
        <span className="mt-1 block text-2xs text-warn" data-testid="load-mode-warn">
          {t('sellerWarn')}
        </span>
      ) : null}
    </label>
  );
}
