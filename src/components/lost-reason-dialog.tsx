'use client';

import { Overlay } from './ui/overlay';

/**
 * «Nega yo'qotdik?» as a LIST, not a prompt (round 98, owner: «yopilish
 * sababini listdan belgilaydigan qilishimiz kerak»).
 *
 * Rendered only when the dictionary has rows — an empty list keeps the old
 * free-text `window.prompt`, so day one (and every e2e fixture written before
 * the dictionary existed) behaves exactly as before. One button per reason:
 * on a phone mid-drag the last thing anybody wants is a select inside a
 * dialog inside a gesture.
 *
 * The caller holds the pending move and calls `onPick` with the chosen
 * LABEL — the service stores the text, not the row id, so a later rename
 * never rewrites what was recorded.
 */
export function LostReasonDialog({
  open,
  reasons,
  title,
  closeLabel,
  onPick,
  onCancel,
}: {
  /**
   * Kept MOUNTED and toggled, never conditionally rendered: `Overlay`'s
   * close-on-navigation effect runs once on mount, so a dialog that mounts
   * already open closes itself on the same frame it appears — found by the
   * screenshot, invisible to every locator that only waits for it.
   */
  open: boolean;
  reasons: string[];
  title: string;
  closeLabel: string;
  onPick: (reason: string) => void;
  onCancel: () => void;
}) {
  return (
    <Overlay
      open={open}
      onClose={() => {
        onCancel();
      }}
      closeLabel={closeLabel}
      testId="lost-reason-dialog"
      className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-96 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
    >
      <p className="pb-2 text-sm font-bold">{title}</p>
      <div className="space-y-1.5">
        {reasons.map((reason) => (
          <button
            key={reason}
            type="button"
            data-testid="lost-reason-option"
            className="btn-secondary w-full !justify-start"
            onClick={() => onPick(reason)}
          >
            {reason}
          </button>
        ))}
      </div>
      <button type="button" className="btn-ghost mt-3 w-full" onClick={onCancel}>
        {closeLabel}
      </button>
    </Overlay>
  );
}
