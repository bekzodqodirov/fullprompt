'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteRoleAction,
  saveGrantsAction,
  setRoleScopedAction,
  type RoleFormState,
} from './actions';

export interface RoleCardProps {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  grantsCustomised: boolean;
  warehouseScoped: boolean;
  userCount: number;
  grants: string[];
  /** Areas and their permission codes, already grouped by the server. */
  groups: { area: string; codes: string[] }[];
  /** Codes this editor may tick; anything else renders locked. */
  grantable: string[];
  /** True when the editor holds this role — the whole card is then read-only. */
  isOwnRole: boolean;
}

/**
 * One role, with every permission as a checkbox.
 *
 * The list is folded by default: nine roles × thirty-eight permissions open
 * at once is a wall nobody reads. A permission the editor does not hold is
 * shown, disabled, and labelled — hiding it would make the role look like it
 * has fewer powers than it does, which is the opposite of what this screen is
 * for.
 */
export function RoleCard(props: RoleCardProps) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RoleFormState, FormData>(
    saveGrantsAction,
    {},
  );
  const [open, setOpen] = useState(false);
  const grantable = new Set(props.grantable);
  const locked = props.isOwnRole;

  return (
    <div className="card space-y-2" data-testid={`role-${props.code}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono font-extrabold text-brand-700">{props.code}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{props.name}</span>
        <span className="chip-neutral">{t('holders', { n: props.userCount })}</span>
        {props.isSystem ? (
          <span className="chip-neutral">{t('system')}</span>
        ) : (
          <span className="chip-brand">{t('custom')}</span>
        )}
      </div>
      {props.description && <p className="text-xs text-ink-500">{props.description}</p>}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="num font-semibold" data-testid={`grants-${props.code}`}>
          {t('grantCount', { n: props.grants.length })}
        </span>
        {props.grantsCustomised && <span className="text-warn">✏️ {t('edited')}</span>}
        {props.warehouseScoped && (
          <span className="chip-neutral" data-testid={`scoped-${props.code}`}>
            🏠 {t('scoped')}
          </span>
        )}
        <button
          type="button"
          data-testid={`toggle-${props.code}`}
          className="btn-secondary !min-h-9 ml-auto px-3"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? tc('cancel') : `⚙️ ${tc('edit')}`}
        </button>
      </div>

      {locked && open && (
        <p className="rounded-lg bg-warn/10 p-2 text-sm font-semibold text-warn">
          ⚠️ {t('ownRole')}
        </p>
      )}

      {open && (
        <form action={formAction} className="space-y-3 border-t border-line pt-3">
          <input type="hidden" name="roleId" value={props.id} />

          {/* Whether the role's powers stop at the holder's own warehouses
              (migration 0049). Its own small form: it must not ride the
              grants submit, whose replace-all semantics have nothing to do
              with it. Own-role locked like everything else here. */}
          <label className={`flex items-start gap-2 text-sm ${locked ? 'opacity-50' : ''}`}>
            <input
              type="checkbox"
              checked={props.warehouseScoped}
              disabled={locked}
              data-testid={`scope-toggle-${props.code}`}
              onChange={(e) => {
                const form = new FormData();
                form.set('roleId', props.id);
                form.set('scoped', e.target.checked ? 'true' : 'false');
                void setRoleScopedAction(form);
              }}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            <span>
              <span className="font-semibold">{t('scoped')}</span>
              <span className="block text-xs text-ink-500">{t('scopedHint')}</span>
            </span>
          </label>

          {/* The inbound-lead rota left this card in round 96: the queue is
              made of PEOPLE now («hamma sotuvchi, lekin hamma lead bilan
              ishlamaydi»), picked on /admin/taqsimot. */}
          {props.groups.map((group) => (
            <fieldset key={group.area} className="space-y-1">
              <legend className="section-title">{group.area}</legend>
              {group.codes.map((code) => {
                const disabled = locked || !grantable.has(code);
                return (
                  <label
                    key={code}
                    className={`flex items-start gap-2 py-0.5 text-sm ${
                      disabled ? 'opacity-50' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="grant"
                      value={code}
                      defaultChecked={props.grants.includes(code)}
                      disabled={disabled}
                      className="mt-0.5 h-5 w-5 shrink-0"
                    />
                    <span className="font-mono text-xs">{code}</span>
                    {!locked && !grantable.has(code) && (
                      <span className="text-xs text-ink-400">🔒 {t('notYours')}</span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          ))}

          {/* A disabled checkbox posts nothing, so a permission the editor
              cannot grant would be silently REMOVED on save. Re-post the ones
              that are already granted and locked. */}
          {props.grants
            .filter((code) => locked || !grantable.has(code))
            .map((code) => (
              <input key={code} type="hidden" name="grant" value={code} />
            ))}

          {state.error && (
            <p role="alert" className="text-sm font-semibold text-bad">
              {t(`errors.${state.error}` as 'errors.own_role')}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid={`save-${props.code}`}
              disabled={pending || locked}
              className="btn-primary flex-1 disabled:opacity-50"
            >
              {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
            </button>
            {!props.isSystem && props.userCount === 0 && (
              <button
                type="submit"
                formAction={deleteRoleAction}
                data-testid={`delete-${props.code}`}
                className="btn-secondary text-bad"
                title={tc('delete')}
              >
                🗑
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
