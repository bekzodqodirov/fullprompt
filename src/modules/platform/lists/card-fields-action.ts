'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  CARD_FIELDS,
  CARD_FIELDS_COOKIE,
  parseCardFields,
  serializeCardFields,
} from './card-fields';

/**
 * Remember which lines this browser wants on a board's cards.
 *
 * A replace-all form: an unchecked box posts nothing, and here that reads as
 * «off», which is what it means. The trap DECISIONS #171 records — a control
 * that posts nothing being read as «remove» — is a trap only where some of the
 * boxes are LOCKED and therefore absent; nothing on this form is locked, so
 * what the person sees is exactly what is saved.
 *
 * The other board's choice is preserved rather than rewritten, because one
 * cookie carries both and saving the funnel's must not silently reset the
 * deal board's.
 */
export async function saveCardFieldsAction(board: string, formData: FormData): Promise<void> {
  if (!(board in CARD_FIELDS)) return;
  const known = new Set(CARD_FIELDS[board]!.map((spec) => spec.key));
  const picked = formData
    .getAll('field')
    .map(String)
    .filter((key) => known.has(key));

  const store = await cookies();
  const next = { ...parseCardFields(store.get(CARD_FIELDS_COOKIE)?.value), [board]: picked };
  store.set(CARD_FIELDS_COOKIE, serializeCardFields(next), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  // The board is a server component reading the cookie, so it has to be told
  // to render again — a cookie set inside an action does not by itself change
  // what is already on screen.
  revalidatePath('/', 'layout');
}
