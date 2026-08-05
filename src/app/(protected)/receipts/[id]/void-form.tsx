'use client';

import { useActionState } from 'react';
import { voidReceiptAction, type VoidReceiptState } from './actions';

/**
 * The void form, made able to say NO out loud.
 *
 * Its refusals used to be silent — press, nothing happens, and the operator
 * reads a broken button (the shape rounds 42 and 52 both paid for). The two
 * reasons a void is refused are different people's problems: a box that left
 * the shelf is the warehouse's to resolve, live costs are finance's to void
 * first — so the screen has to say WHICH.
 */
export function VoidReceiptForm({
  receiptId,
  labels,
}: {
  receiptId: string;
  labels: {
    reason: string;
    button: string;
    errors: Record<string, string>;
  };
}) {
  const [state, formAction, pending] = useActionState<VoidReceiptState, FormData>(
    voidReceiptAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-2">
      <input type="hidden" name="receiptId" value={receiptId} />
      <label className="label" htmlFor="void-reason">
        {labels.reason}
      </label>
      <input id="void-reason" name="reason" className="input" required minLength={3} />
      {state.error && (
        <p role="alert" data-testid="void-error" className="text-sm font-semibold text-bad">
          {labels.errors[state.error] ?? state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-danger w-full disabled:opacity-60">
        {pending ? '…' : labels.button}
      </button>
    </form>
  );
}
