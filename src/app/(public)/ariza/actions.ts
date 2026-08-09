'use server';

import { landInboundLead } from '@/modules/wms/crm/inbound';
import { logger } from '@/modules/platform/logger';

/**
 * The public enquiry form's one action.
 *
 * TWO kinds of answer, and the difference is the whole security of this file.
 *
 * A complaint about the INPUT is honest and specific — «write the whole phone
 * number» tells the sender about the box they just typed in and nothing about
 * us. An answer about the OUTCOME is one constant string, always, whether we
 * created a lead, joined it onto yesterday's enquiry, recognised the number as
 * a customer's, or dropped it at the cap. Anything else turns this page into a
 * way to walk a list of numbers and learn which ones are in our client book —
 * the same fence `ingestCalls` keeps for the calls app, and the reason the
 * whole of `landInboundLead` returns its outcome to the SERVER only.
 */

export interface ArizaState {
  ok?: true;
  /** A key the page turns into words; never a sentence from the server. */
  error?: 'phone' | 'name';
}

export async function submitArizaAction(_prev: ArizaState, form: FormData): Promise<ArizaState> {
  const name = String(form.get('ism') ?? '').trim();
  const phone = String(form.get('telefon') ?? '').trim();
  const note = String(form.get('izoh') ?? '').trim();
  const sourceKey = String(form.get('manba') ?? '').trim() || 'sayt';

  if (name.length < 2) return { error: 'name' };
  if (phone.replace(/[^0-9]/g, '').length < 9) return { error: 'phone' };

  // ONE silent filter: a box no human can see, which only a robot filling
  // every field would ever put anything in. It ends the same way a real
  // enquiry does, with the same words — telling a bot it was caught is telling
  // whoever wrote it what to change.
  //
  // A «filled it too fast to be a person» timer was built here and then TAKEN
  // OUT, because the e2e caught it eating a real submission at three seconds.
  // The trade is not symmetrical: a junk lead is visible on the funnel and one
  // tap from being lost, while an enquiry we paid an advert for and dropped in
  // silence is invisible for ever — and a serious robot adds a delay in one
  // line. The flood defence that actually holds is the pair of caps in
  // `landInboundLead`, which count what arrived rather than guessing at who
  // sent it.
  if (String(form.get('kompaniya') ?? '').trim()) return { ok: true };

  try {
    await landInboundLead({
      channel: 'form',
      sourceKey,
      ref: refFrom(form),
      name,
      phone,
      note,
    });
  } catch (err) {
    // A form that answers «something went wrong» teaches a sender to press the
    // button again, and the second press is the one that duplicates. It says
    // the same thing either way; the failure goes to the log, where somebody
    // whose job it is can see it.
    logger.error({ err }, '[ariza] landing failed');
  }
  return { ok: true };
}

/** Whatever the advert put in the URL, kept verbatim and believed about nothing. */
function refFrom(form: FormData): Record<string, string> {
  const ref: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const) {
    const value = String(form.get(key) ?? '').trim();
    if (value) ref[key] = value.slice(0, 120);
  }
  return ref;
}
