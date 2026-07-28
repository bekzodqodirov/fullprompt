'use client';

import { useActionState, useRef } from 'react';
import { sendReplyAction, type ReplyState } from './reply-actions';

/**
 * The compose box — the first thing in this system that speaks to a customer
 * in a manager's own name.
 *
 * It is shown ONLY when the reply can actually go: the switch is on, the
 * bridge is live, the client has written to us, and the conversation is on
 * this person's own account. When it cannot, the box is replaced by the
 * reason — never by a disabled box with no explanation, because "why can't I
 * type" is a question somebody will answer by restarting a server.
 */
export function ReplyBox({
  clientId,
  labels,
}: {
  clientId: string;
  labels: { placeholder: string; send: string; sending: string; errors: Record<string, string> };
}) {
  const [state, submit, pending] = useActionState<ReplyState, FormData>(sendReplyAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (data) => {
        await submit(data);
        // Cleared after the round trip rather than optimistically: the queue
        // can refuse, and a box that empties on a refusal has thrown away
        // what somebody typed.
        formRef.current?.reset();
      }}
      className="card flex shrink-0 items-end gap-2 !p-2"
      data-testid="reply-box"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <textarea
        name="body"
        rows={1}
        required
        placeholder={labels.placeholder}
        className="input-sm max-h-32 min-h-9 flex-1 resize-y py-2"
        data-testid="reply-body"
      />
      <button type="submit" className="btn-primary !min-h-9 shrink-0" disabled={pending}>
        {pending ? labels.sending : labels.send}
      </button>
      {state.error && (
        <p className="w-full text-sm font-semibold text-bad" data-testid="reply-error">
          {labels.errors[state.error] ?? state.error}
        </p>
      )}
    </form>
  );
}
