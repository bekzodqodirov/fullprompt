'use client';

import { useActionState, useState } from 'react';
import { excludeChatAction, type ReplyState } from '@/modules/wms/crm/reply-actions';

/**
 * «Bu chatni olmang» — the exclude half, reachable from the chat itself.
 *
 * It was unreachable before: the scan only ever asks about chats the phone
 * rule does NOT match, so a matched conversation could never be given an
 * exclude rule. «Qo'shish» worked and «qo'shmaslik» did not.
 *
 * Deliberately behind a confirm, and deliberately quiet — a small text link,
 * not a button competing with «Yuborish». It is a rare, considered action,
 * and it changes what the company keeps.
 */
export function TelegramStopTaking({
  clientId,
  labels,
}: {
  clientId: string;
  labels: { stop: string; hint: string; cancel: string };
}) {
  const [state, submit, pending] = useActionState<ReplyState, FormData>(excludeChatAction, {});
  const [asking, setAsking] = useState(false);

  if (state.ok) return null;

  if (!asking) {
    return (
      <button
        type="button"
        className="text-xs text-ink-500 underline"
        onClick={() => setAsking(true)}
        data-testid="chat-stop-taking"
      >
        {labels.stop}
      </button>
    );
  }

  return (
    <form action={submit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      {/* The consequence, before the press — not after it. */}
      <span className="text-xs text-ink-500">{labels.hint}</span>
      <button type="submit" className="btn-secondary !min-h-8 text-xs" disabled={pending}>
        {labels.stop}
      </button>
      <button type="button" className="btn-ghost !min-h-8 text-xs" onClick={() => setAsking(false)}>
        {labels.cancel}
      </button>
    </form>
  );
}
