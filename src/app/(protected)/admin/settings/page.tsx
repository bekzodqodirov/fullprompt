import { getTranslations } from 'next-intl/server';
import { getAllSettings, SETTING_DEFAULTS, type SettingKey } from '@/modules/platform/settings/service';
import { updateSettingAction } from './actions';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { pressToday, type PressKind, type PressToday } from '@/modules/wms/calc/ai-press';
import { companyMoneySight } from '@/modules/wms/finance/scope';

/**
 * The refusal's words, per setting. `badValue` was written for the
 * unpriced-cargo ban and asks for a DATE — under the agent's reason list that
 * sentence would send the owner looking for a calendar.
 */
const BAD_VALUE_TEXT: Partial<Record<SettingKey, 'badValueReasons' | 'badValueWhole' | 'badValueOrigins'>> = {
  agent_no_contact_reasons: 'badValueReasons',
  // A list of web addresses refused with «write a date» (the as-built review
  // found it on this door; it predates the round).
  lead_assign_origins: 'badValueOrigins',
  tnved_ai_daily_limit: 'badValueWhole',
  tarkib_ai_daily_limit: 'badValueWhole',
};

/** The two pressed-AI ceilings and the kind each one caps (0144). */
const PRESS_KIND: Partial<Record<SettingKey, PressKind>> = {
  tnved_ai_daily_limit: 'tnved',
  tarkib_ai_daily_limit: 'tarkib',
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ bad?: string }>;
}) {
  const { bad } = await searchParams;
  // Own gate, not just the layout's: the section is now reachable by roles
  // that only hold FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) redirect('/');
  const t = await getTranslations('settings');
  const tc = await getTranslations('common');
  const values = await getAllSettings();
  // «Xarajat hisobi» where the limit is CHANGED (0144): the count for whoever
  // opens this page, the dollars only through the company's money sight. On
  // the Bojxona tab the same line reaches the VED and the logist — who see
  // no dollars — so without this one the people who can move the limit had
  // nowhere to see what it costs, and a document reading's spend was shown
  // nowhere at all (the design judge). Caught per kind: a ledger one
  // migration behind draws no line (#472), never an error page.
  const sight = companyMoneySight(actor);
  const spent = new Map<SettingKey, PressToday>();
  for (const [key, kind] of Object.entries(PRESS_KIND) as [SettingKey, PressKind][]) {
    const today = await pressToday(kind, sight).catch(() => null);
    if (today) spent.set(key, today);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <div className="space-y-3">
        {(Object.keys(SETTING_DEFAULTS) as (keyof typeof SETTING_DEFAULTS)[]).map((key) => {
          const value = values[key];
          const defaultValue = SETTING_DEFAULTS[key];
          const isBool = typeof defaultValue === 'boolean';
          const isObject = typeof defaultValue === 'object';
          return (
            <form key={key} action={updateSettingAction} className="card">
              <input type="hidden" name="key" value={key} />
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-64 flex-1">
                  <label className="label font-mono" htmlFor={`setting-${key}`}>
                    {key}
                  </label>
                  <p className="mb-2 text-xs text-ink-500">{t(`descriptions.${key}`)}</p>
                  {isBool ? (
                    <select
                      id={`setting-${key}`}
                      name="value"
                      className="input"
                      defaultValue={String(value)}
                    >
                      <option value="true">{tc('yes')}</option>
                      <option value="false">{tc('no')}</option>
                    </select>
                  ) : (
                    <input
                      id={`setting-${key}`}
                      name="value"
                      className="input font-mono"
                      defaultValue={isObject ? JSON.stringify(value) : String(value)}
                    />
                  )}
                  {bad === key && (
                    <p role="alert" className="mt-1 text-sm font-semibold text-bad" data-testid="setting-bad">
                      {t(BAD_VALUE_TEXT[key] ?? 'badValue')}
                    </p>
                  )}
                  {spent.has(key) && (
                    <p className="mt-1 text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid={`setting-spent-${key}`}>
                      {(() => {
                        const today = spent.get(key)!;
                        return (
                          <>
                            {t('aiSpentToday', { used: today.used, limit: today.limit })}
                            {today.usd !== null && <> · {t('aiSpentUsd', { usd: today.usd.toFixed(2) })}</>}
                            {today.usd30 !== null && <> · {t('aiSpentMonth', { usd: today.usd30.toFixed(2) })}</>}
                            {today.unpriced !== null && today.unpriced > 0 && <> · {t('aiSpentUnpriced', { n: today.unpriced })}</>}
                          </>
                        );
                      })()}
                    </p>
                  )}
                </div>
                <button type="submit" className="btn-primary">
                  {tc('save')}
                </button>
              </div>
            </form>
          );
        })}
      </div>
    </div>
  );
}
