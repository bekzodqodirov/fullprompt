'use client';

import { useRef, useState, useTransition } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { autogrow, sendOnEnter, useCoarsePointer } from '@/components/composer';
import { ReplyTemplates, type ReplyTemplate } from '@/components/reply-templates';
import { sendReplyAction } from '@/modules/wms/crm/reply-actions';

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
  templates = [],
  compact = false,
}: {
  clientId: string;
  /** Canned replies, already filled for THIS client on the server. */
  templates?: ReplyTemplate[];
  labels: {
    placeholder: string;
    send: string;
    sending: string;
    attach: string;
    errors: Record<string, string>;
    templates: string;
  };
  /** On a card the box sits inside a panel and needs no card frame of its own. */
  compact?: boolean;
}) {
  // NOT `useActionState` with the action on the form (round 49). React runs a
  // form Action and then resets the form's uncontrolled fields — on success
  // AND on refusal — so a message the queue turned down took the manager's
  // words with it, which is exactly the «habar yo'q bo'lib qolyabti» the owner
  // reported. The old code even called `reset()` itself, under a comment
  // claiming it only cleared after a successful round trip. Submitting by
  // hand is the only way to see the verdict before deciding, and it is what
  // the dock's composer has always done.
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  function submit() {
    const form = formRef.current;
    if (!form || pending || uploading) return;
    const data = new FormData(form);
    start(async () => {
      const result = await sendReplyAction({}, data);
      setError(result.error ?? null);
      // A refusal keeps what was typed. There is nowhere else it exists.
      if (!result.ok) return;
      form.reset();
      setPhoto(null);
      if (bodyRef.current) bodyRef.current.style.height = '';
    });
  }

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
      onSubmit={(event) => {
        // `preventDefault` and no `action` prop: both halves matter. The
        // action prop is what makes React reset the fields afterwards.
        event.preventDefault();
        submit();
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
        <ReplyTemplates
          templates={templates}
          label={labels.templates}
          className="btn-secondary btn-icon !min-h-9 shrink-0"
          onPick={(body) => {
            const box = bodyRef.current;
            if (!box) return;
            // INSERT, never replace: half a typed sentence plus a template is
            // «and this too», and eating those words is the mistake #377,
            // #419 and #463 each paid for once.
            box.value = box.value ? `${box.value.replace(/\s*$/, '')} ${body}` : body;
            autogrow(box);
            box.focus();
          }}
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
        {/* The word costs 62 px of a 360 px row, and the ⚡ beside the 📎 has
            just spent 44 of them: measured, the typing box went 128 → 76 px,
            which is eight characters. Icon on a phone, word from `sm` up —
            the same trade round 60 made in the app bar, and the box comes
            back WIDER than it was before the picker (138 px). */}
        <button
          type="submit"
          aria-label={labels.send}
          title={labels.send}
          className="btn-primary !min-h-9 shrink-0 !px-3 sm:!px-4"
          disabled={pending || uploading}
        >
          {pending ? (
            '…'
          ) : (
            <>
              <span className="sm:hidden">➤</span>
              <span className="hidden sm:inline">{labels.send}</span>
            </>
          )}
        </button>
      </div>
      {error && (
        <p className="w-full text-sm font-semibold text-bad" data-testid="reply-error">
          {labels.errors[error] ?? error}
        </p>
      )}
    </form>
  );
}
