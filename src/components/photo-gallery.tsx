'use client';

import { useState } from 'react';

export interface GalleryPhoto {
  id: string;
  fileName: string;
}

/**
 * Thumbnails-first photo gallery with tap-to-zoom (spec 4.8). Thumbnails are
 * 200px; tapping opens the 800px variant in a full-screen overlay.
 */
export function PhotoGallery({ photos }: { photos: GalleryPhoto[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (photos.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {photos.map((photo) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photo.id}
            src={`/api/attachments/${photo.id}?variant=thumb200`}
            alt={photo.fileName}
            className="h-20 w-20 cursor-zoom-in rounded-lg object-cover"
            loading="lazy"
            onClick={() => setOpenId(photo.id)}
          />
        ))}
      </div>
      {openId && (
        <button
          type="button"
          aria-label="Close"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={() => setOpenId(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/attachments/${openId}?variant=thumb800`}
            alt=""
            className="max-h-full max-w-full rounded-lg"
          />
        </button>
      )}
    </>
  );
}
