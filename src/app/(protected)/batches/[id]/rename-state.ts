/**
 * Which refusal the truck-rename form shows — pure, so the rule is proven
 * without a browser (tests/unit/batch-rename-form-state.test.ts), the
 * `connect-state.ts` shape.
 *
 * The server's answer lives in `useActionState` and changes only on the NEXT
 * post, so on its own it outlives the situation it describes: «bu nom band»
 * would still stand after «Bekor qilish» and ✏️ again — under the truck's own
 * name — and under a different, free name typed afterwards, beside a Save
 * greyed for an unrelated reason, reading as if THAT name were taken. So an
 * answer the person has moved past is DISMISSED — opening the form, or typing
 * in either box, remembers the answer that stood at that moment — and only a
 * fresh answer (a new object: every post returns one, even the same refusal
 * twice) is shown. What was typed is never touched here.
 *
 * Order: the browser's own pre-check of what was just pressed, then a fresh
 * server answer, then the live Cyrillic warning while typing — the newest
 * event first.
 */
export type Refusal = { error: string; detail?: string };

export interface ServerAnswer {
  ok?: boolean;
  error?: string;
  detail?: string;
  changed?: boolean;
}

/** Is this the server's answer still standing, or one the person moved past? */
export function freshAnswer<S extends ServerAnswer>(state: S, dismissed: S | null): S | null {
  return state === dismissed ? null : state;
}

export function shownRefusal<S extends ServerAnswer>(
  local: Refusal | null,
  state: S,
  dismissed: S | null,
  live: Refusal | null,
): Refusal | null {
  if (local) return local;
  const fresh = freshAnswer(state, dismissed);
  if (fresh?.error) return { error: fresh.error, detail: fresh.detail };
  return live;
}
