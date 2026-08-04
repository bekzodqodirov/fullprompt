'use client';

import { useState } from 'react';

export interface GalleryPhoto {
  id: string;
  fileName: string;
}

/**
 * Thumbnails-first photo gallery with tap-to-zoom (spec 4.8). Thumbnails are
 * 200px; tapping opens the 800px variant in a full-screen overlay. With
 * `deletable`, each thumb gets a ✕ badge that removes a wrongly-added photo.
 */
export function PhotoGallery({
  photos,
  deletable = false,
}: {
  photos: GalleryPhoto[];
  deletable?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const visible = photos.filter((photo) => !removed.has(photo.id));
  if (visible.length === 0) return null;

  async function remove(id: string) {
    const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setRemoved((prev) => new Set(prev).add(id));
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {visible.map((photo) => (
          <span key={photo.id} className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/attachments/${photo.id}?variant=thumb200`}
              alt={photo.fileName}
              className="h-20 w-20 cursor-zoom-in rounded-lg object-cover"
              loading="lazy"
              onClick={() => setOpenId(photo.id)}
            />
            {deletable && (
              <button
                type="button"
                aria-label="✕"
                className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-xs font-bold leading-none text-white shadow"
                onClick={() => remove(photo.id)}
              >
                ✕
              </button>
            )}
          </span>
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
