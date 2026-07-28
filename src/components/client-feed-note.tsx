'use client';

import { useActionState, useRef } from 'react';
import { addFeedNoteAction, type ReplyState } from '@/modules/wms/crm/reply-actions';

/**
 * An internal note on the timeline — the other half of the composer.
 *
 * Separate from the Telegram box on purpose, and visibly so. In amoCRM the
 * two live behind one control with a mode switch, and the accident that
 * follows is somebody typing an internal remark about a client and sending it
 * TO the client. Two boxes, each labelled, cannot make that mistake.
 */
export function FeedNoteBox({
  entityType,
  entityId,
  labels,
}: {
  /** Where the note lands: the client, or — before one exists — the lead. */
  entityType: 'client' | 'lead';
  entityId: string;
  labels: { placeholder: string; save: string; saving: string };
}) {
  const [state, submit, pending] = useActionState<ReplyState, FormData>(addFeedNoteAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (data) => {
        await submit(data);
        formRef.current?.reset();
      }}
      className="flex items-end gap-2"
      data-testid="feed-note-box"
    >
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <textarea
        name="note"
        rows={1}
        required
        placeholder={labels.placeholder}
        className="input-sm max-h-32 min-h-9 flex-1 resize-y py-2"
        data-testid="feed-note-body"
      />
      <button type="submit" className="btn-secondary !min-h-9 shrink-0" disabled={pending}>
        {pending ? labels.saving : labels.save}
      </button>
      {state.error && <p className="w-full text-sm font-semibold text-bad">{state.error}</p>}
    </form>
  );
}
