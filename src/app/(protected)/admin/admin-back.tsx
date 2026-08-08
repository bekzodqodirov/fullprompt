'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isAdminSectionPage } from '@/components/ui/nav-active';

/**
 * The way back to the hub — and the ONLY admin navigation on a section page.
 * The tab strip that used to sit here duplicated the hub's buttons (owner:
 * "adminstratsiyada buttonlar qo'yildi, lekin tepadagi menyu turibdi — u
 * kerak emas"). Client-side because the hub itself must not show a link to
 * itself, and only the browser knows which page this is.
 *
 * The hub itself gets no link to itself, and neither does a page that only
 * LIVES under /admin — the client book is a Sotuv screen and this link was
 * the loudest of the three things telling its reader otherwise (round 75).
 */
export function AdminBack({ label }: { label: string }) {
  const pathname = usePathname();
  if (pathname === '/admin' || !isAdminSectionPage(pathname)) return null;
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
