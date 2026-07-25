import { getTranslations } from 'next-intl/server';
import { getAllSettings, SETTING_DEFAULTS } from '@/modules/platform/settings/service';
import { updateSettingAction } from './actions';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function SettingsPage() {
  // Own gate, not just the layout's: the section is now reachable by roles
  // that only hold FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.warehouses.manage')) redirect('/');
  const t = await getTranslations('settings');
  const tc = await getTranslations('common');
  const values = await getAllSettings();

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
                  <p className="mb-2 text-xs text-gray-500">{t(`descriptions.${key}`)}</p>
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
