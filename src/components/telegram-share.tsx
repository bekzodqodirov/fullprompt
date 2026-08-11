'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Overlay } from '@/components/ui/overlay';
import { shareMessageAction } from '@/modules/wms/crm/share-actions';

/**
 * «Hamkasbga ko'rsatish» — one client message handed to one colleague
 * (owner's item 4, narrowed by his own answer «boshqa mijozga jonatilmaydi»).
 *
 * Rendered ONCE per thread, not once per bubble: the ➦ buttons are plain
 * server-rendered markup carrying `data-share-msg`, and this sheet finds them
 * by delegation. Five hundred messages therefore cost one listener rather
 * than five hundred React islands.
 *
 * The browser is told nothing it does not already have on screen. It posts a
 * message id and a user id; everything else — may this person read that
 * message, is that colleague still employed, what does the text say — is
 * re-derived on the server, because the button was drawn by a page and a
 * page is not an authorisation.
 */
export function TelegramShare({
  people,
  labels,
}: {
  people: { id: string; name: string }[];
  labels: {
    title: string;
    who: string;
    note: string;
    send: string;
    sent: string;
    cancel: string;
    close: string;
    errors: Record<string, string>;
  };
}) {
  const [messageId, setMessageId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const pick = (event.target as HTMLElement | null)?.closest?.('[data-share-msg]');
      if (!(pick instanceof HTMLElement)) return;
      event.preventDefault();
      setError(null);
      setDone(false);
      setMessageId(pick.dataset.shareMsg ?? null);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  if (people.length === 0) return null;

  return (
    <Overlay
      open={messageId !== null}
      onClose={() => setMessageId(null)}
      closeLabel={labels.close}
      testId="tg-share"
      // The scaffold owns the backdrop and nothing else — the panel's own
      // surface, inset and shadow are the caller's, and quick-create's line
      // is the one this codebase already uses for a sheet on a phone.
      className="absolute inset-x-3 top-3 space-y-3 rounded-2xl bg-surface-raised p-3 shadow-pop md:inset-x-auto md:left-1/2 md:w-[26rem] md:-translate-x-1/2"
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          const form = formRef.current;
          if (!form || pending) return;
          const data = new FormData(form);
          start(async () => {
            const result = await shareMessageAction({}, data);
            setError(result.error ?? null);
            if (!result.ok) return;
            setDone(true);
          });
        }}
        className="space-y-2"
        data-testid="tg-share-form"
      >
        <h2 className="text-base font-bold">
          ➦ {labels.title}
        </h2>
        <input type="hidden" name="messageId" value={messageId ?? ''} />
        <label className="block text-sm font-semibold">
          {labels.who}
          <select name="toUserId" className="input mt-1" data-testid="tg-share-who" required>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold">
          {labels.note}
          <textarea name="note" rows={2} className="input mt-1 h-20 resize-none" />
        </label>
        {/* The verdict stays on screen and the sheet stays open: «sent» is the
            only evidence there is, since what it produced is a message in
            somebody else's Telegram. */}
        {done && (
          <p className="text-sm font-semibold text-good" data-testid="tg-share-done">
            ✅ {labels.sent}
          </p>
        )}
        {error && (
          <p className="text-sm font-semibold text-bad" data-testid="tg-share-error">
            {labels.errors[error] ?? error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setMessageId(null)}>
            {labels.cancel}
          </button>
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? '…' : labels.send}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
