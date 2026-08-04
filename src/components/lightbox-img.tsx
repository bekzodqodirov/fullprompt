'use client';

import { useState } from 'react';

/**
 * Attachment thumbnail that opens a full-screen overlay on tap instead of
 * navigating anywhere (owner's request: photos must open in a popup, not
 * jump to another page). Falls back to the original file if a thumbnail
 * variant is missing.
 */
export function LightboxImg({
  attachmentId,
  testId,
  alt = '',
  className = 'h-12 w-12 rounded object-cover',
  onDelete,
}: {
  attachmentId: string;
  /** Stable hook for tests; styling classes are not a contract. */
  testId?: string;
  alt?: string;
  className?: string;
  /** When set, a small ✕ badge removes the wrongly-added photo. */
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/attachments/${attachmentId}?variant=thumb200`}
        alt={alt}
        loading="lazy"
        data-testid={testId}
        // `max-w-none` and the wrapper's `shrink-0` are what keep a thumbnail
        // SQUARE (round 54, owner: «spiska uzunlashgani sari rasimlar
        // cho'zinchoq bo'lib ko'rinmay qolyabti»). The browser's own stylesheet
        // gives every img `max-width: 100%`, which quietly grants any table
        // column or flex row permission to squeeze the picture to a sliver —
        // its minimal width becomes zero, so when large phone fonts push the
        // nowrap columns past the table's width, the photo column is the one
        // that pays, and a 80×80 photo renders as a 18px strip. With the cap
        // off, the photo's width IS its minimum: the table must grow and
        // scroll sideways instead, which is what its overflow container is
        // for. Every caller passes a fixed square, so nothing relied on the
        // shrinking.
        className={`max-w-none cursor-zoom-in ${className}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        onError={(e) => {
          const img = e.currentTarget;
          if (!img.dataset.retried) {
            img.dataset.retried = '1';
            img.src = `/api/attachments/${attachmentId}?variant=original`;
          }
        }}
      />
      {onDelete && (
        <button
          type="button"
          aria-label="✕"
          className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-xs font-bold leading-none text-white shadow"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      )}
      {open && (
        <button
          type="button"
          aria-label="Close"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/attachments/${attachmentId}?variant=thumb800`}
            alt={alt}
            className="max-h-full max-w-full rounded-lg"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.retried) {
                img.dataset.retried = '1';
                img.src = `/api/attachments/${attachmentId}?variant=original`;
              }
            }}
          />
        </button>
      )}
    </span>
  );
}
