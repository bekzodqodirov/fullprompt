'use client';

import { useActionState, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { autogrow, sendOnEnter, useCoarsePointer } from '@/components/composer';
import { sendReplyAction, type ReplyState } from '@/modules/wms/crm/reply-actions';

/**
 * The compose box — the first thing in this system that speaks to a customer
 * in a manager's own name.
 *
 * It is shown ONLY when the reply can actually go: the switch is on, the
 * bridge is live, the client has written to us, and the conversation is on
 * this person's own account. When it cannot, the box is replaced by the
 * reason — never by a disabled box with no explanation, because "why can't I
 * type" is a question somebody will answer by restarting a server.
 *
 * ONE photo may ride along (item 15, the sending half): uploaded against a
 * minted `tg_outbox` group id before the queue row exists — the same
 * pre-binding as note files — and `queueReply` claims it. One, not an album:
 * every photo is a rate-limit slot on a personal account.
 */
export function TelegramReplyBox({
  clientId,
  labels,
  compact = false,
}: {
  clientId: string;
  labels: {
    placeholder: string;
    send: string;
    sending: string;
    attach: string;
    errors: Record<string, string>;
  };
  /** On a card the box sits inside a panel and needs no card frame of its own. */
  compact?: boolean;
}) {
  const [state, submit, pending] = useActionState<ReplyState, FormData>(sendReplyAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  async function attach(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUploading(true);
    const data = new FormData();
    data.set('file', file);
    data.set('entityType', 'tg_outbox');
    data.set('entityId', uuidv4());
    const res = await fetch('/api/files/upload', { method: 'POST', body: data });
    if (res.ok) {
      const { id } = (await res.json()) as { id: string };
      setPhoto({ id, name: file.name });
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <form
      ref={formRef}
      action={async (data) => {
        await submit(data);
        // Cleared after the round trip rather than optimistically: the queue
        // can refuse, and a box that empties on a refusal has thrown away
        // what somebody typed.
        formRef.current?.reset();
        setPhoto(null);
        if (bodyRef.current) bodyRef.current.style.height = '';
      }}
      className={compact ? 'shrink-0 space-y-1 pt-1' : 'card shrink-0 space-y-1 !p-2'}
      data-testid="reply-box"
    >
      <input type="hidden" name="clientId" value={clientId} />
      {photo && <input type="hidden" name="attachmentId" value={photo.id} />}
      {photo && (
        <div className="flex items-center gap-1.5">
          <span className="max-w-48 truncate rounded-lg bg-surface-sunken px-2 py-1 text-xs font-semibold">
            🖼 {photo.name}
          </span>
          <button
            type="button"
            aria-label="✕"
            onClick={() => setPhoto(null)}
            className="btn-ghost btn-icon !min-h-7 text-xs"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void attach(event.target.files)}
        />
        <button
          type="button"
          aria-label={labels.attach}
          title={labels.attach}
          disabled={uploading || photo !== null}
          onClick={() => fileRef.current?.click()}
          className="btn-secondary btn-icon !min-h-9 shrink-0 disabled:opacity-50"
          data-testid="reply-attach"
        >
          {uploading ? '…' : '📎'}
        </button>
        <textarea
          ref={bodyRef}
          name="body"
          rows={1}
          // A photo with no caption is a real message.
          required={photo === null}
          placeholder={labels.placeholder}
          onChange={(event) => autogrow(event.target)}
          onKeyDown={(event) => sendOnEnter(event, coarse, () => formRef.current?.requestSubmit())}
          className="input-sm max-h-32 min-h-9 flex-1 resize-none py-2"
          data-testid="reply-body"
        />
        <button
          type="submit"
          className="btn-primary !min-h-9 shrink-0"
          disabled={pending || uploading}
        >
          {pending ? labels.sending : labels.send}
        </button>
      </div>
      {state.error && (
        <p className="w-full text-sm font-semibold text-bad" data-testid="reply-error">
          {labels.errors[state.error] ?? state.error}
        </p>
      )}
    </form>
  );
}
