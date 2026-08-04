import Link from 'next/link';

/** Consistent "← back to list" link for detail pages (UX audit: dead-ends). */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-9 items-center text-sm font-semibold text-brand-700">
      ← {label}
    </Link>
  );
}
