import type { ConnectStep } from '@/modules/wms/crm/telegram-connect';
import type { ConnectState } from './actions';

/**
 * What the connect screen shows after a refused press of «Ulash» — from
 * where the SERVER says the login now stands (`next`), never re-derived
 * here from the error's name: two copies of «is the login still alive»
 * would one day disagree, and the form would sit on a step whose login the
 * server had already dropped.
 *
 * «Kod qabul qilindi» is news the first time the password box appears, not
 * an error. A press on that box with nothing typed in it IS one — the screen
 * used to answer it with nothing at all, so the press looked broken and
 * `password_needed`'s own sentence was printed nowhere.
 */
export function afterFinish(
  prev: ConnectState,
  result: Extract<ConnectStep, { ok: false }>,
): ConnectState {
  if (result.next === 'password') {
    const firstAsk = result.error === 'password_needed' && !prev.needPassword;
    return { stage: 'code', needPassword: true, error: firstAsk ? undefined : result.error };
  }
  if (result.next === 'code') return { stage: 'code', error: result.error };
  // The attempt ended on the server — start again from the number, which is
  // still in its box.
  return { stage: 'phone', error: result.error, holder: result.holder };
}
