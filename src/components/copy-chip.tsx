'use client';

import { useState } from 'react';

/**
 * One tap = the code is on the clipboard (round 107, owner's item 1).
 *
 * The client code is what gets written on cartons and pasted into Telegram a
 * dozen times a day, and until now the only way to «copy» it was to select a
 * mono span by hand on a phone. Takes its words as props so the server page
 * translates them — a client component this small should not carry its own
 * i18n hook for two strings.
 */
export function CopyChip({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="copy-chip"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // No clipboard permission (an old WebView) — the code is printed
          // right beside this button, selectable like any other text.
        }
      }}
      className="chip shrink-0"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
