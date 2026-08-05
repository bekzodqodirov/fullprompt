'use client';

import { useState } from 'react';

export interface ReplyTemplate {
  id: string;
  title: string;
  /** Already filled: `{ism}` and `{kod}` were resolved on the server. */
  body: string;
  shared: boolean;
}

/**
 * The canned replies, offered where you are typing.
 *
 * The placeholders are filled BEFORE this component ever sees them — the
 * server knows which client the thread belongs to, and the browser has no
 * business being told a customer's name in order to write a greeting.
 *
 * It INSERTS rather than replaces: a manager who has typed half a sentence and
 * then reaches for a template means «and this too», and throwing their words
 * away is the mistake three rounds of this codebase have already paid for.
 */
export function ReplyTemplates({
  templates,
  onPick,
  label,
  // The composers are not the same height — the thread's controls are `!min-h-9`
  // and the dock's are the default — and a button that stands taller than the
  // 📎 beside it reads as a mistake. Each caller states its own row's size.
  className = 'btn-secondary btn-icon shrink-0',
}: {
  templates: ReplyTemplate[];
  onPick: (body: string) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        aria-label={label}
        data-testid="templates-open"
        onClick={() => setOpen((was) => !was)}
        className={className}
      >
        ⚡
      </button>
      {open && (
        <>
          {/* A backdrop, so a tap anywhere closes it — on a phone the panel
              covers the thread and there is nowhere obvious to press. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          {/* Anchored to this span, which is `relative`, and opening UPWARDS:
              the composer sits at the bottom of the screen and a panel below
              it would be off the bottom of the phone.
              LEFT, not right: the ⚡ is the SECOND control in the row, about
              110 px from the edge, so a 256 px panel hung off its right edge
              starts at −144 px and half of it is unreachable. That is #471's
              mistake and #491 repeated it — a popover anchors where there is
              room, and here the room is to the right. */}
          <div
            data-testid="templates-panel"
            className="absolute bottom-full left-0 z-40 mb-1 max-h-64 w-64 max-w-[calc(100vw-7rem)] space-y-1 overflow-y-auto rounded-xl border border-line bg-surface-raised p-2 shadow-card"
          >
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                data-testid="template-pick"
                onClick={() => {
                  onPick(template.body);
                  setOpen(false);
                }}
                className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-sunken"
              >
                <span className="block font-semibold [overflow-wrap:anywhere]">
                  {template.shared && '🏢 '}
                  {template.title}
                </span>
                <span className="block truncate text-xs text-ink-500">{template.body}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
