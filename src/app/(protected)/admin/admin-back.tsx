'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The way back to the hub — and the ONLY admin navigation on a section page.
 * The tab strip that used to sit here duplicated the hub's buttons (owner:
 * "adminstratsiyada buttonlar qo'yildi, lekin tepadagi menyu turibdi — u
 * kerak emas"). Client-side because the hub itself must not show a link to
 * itself, and only the browser knows which page this is.
 */
export function AdminBack({ label }: { label: string }) {
  const pathname = usePathname();
  if (pathname === '/admin') return null;
  return (
    <Link
      href="/admin"
      data-testid="admin-back"
      className="mb-3 inline-block text-sm font-semibold text-brand-700"
    >
      ← {label}
    </Link>
  );
}
