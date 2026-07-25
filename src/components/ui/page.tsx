import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon';

/**
 * The page shapes every screen shares.
 *
 * The owner's complaint was that everything felt scattered — which it was:
 * 67 screens each invented their own title size, their own spacing and their
 * own idea of where the buttons go. These three components are the answer, so
 * that moving between receiving, finance and CRM feels like one product.
 */

/** Title row: icon, title, optional subtitle, actions pinned right. */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  back,
}: {
  icon?: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** href for a "← back to the list" link above the title. */
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-4 space-y-1.5">
      {back && (
        <Link
          href={back.href}
          className="-ml-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:text-brand-800"
        >
          <Icon name="chevronLeft" className="h-4 w-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-[11rem] flex-1 items-center gap-2.5">
          {icon && (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <Icon name={icon} className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            {/* Wraps rather than truncates: a wide action button used to eat
                the title down to "Segodnya…". */}
            <h1 className="line-clamp-2 text-xl leading-tight">{title}</h1>
            {subtitle && <p className="truncate text-sm text-ink-500">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A labelled group of cards. */
export function Section({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-2 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2">
          {title && <h2 className="section-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * What a list says when it has nothing to say.
 *
 * An empty screen that only shows "—" reads as broken; this one says what
 * would be here and, where there is one, offers the action that fills it.
 */
export function EmptyState({
  icon = 'inbox',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 py-8 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-sunken text-ink-400">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <p className="font-semibold text-ink-700">{title}</p>
      {hint && <p className="max-w-xs text-sm text-ink-500">{hint}</p>}
      {action}
    </div>
  );
}

/** One number with its label — the building block of every summary row. */
export function Stat({
  label,
  value,
  tone = 'neutral',
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'neutral' | 'brand' | 'good' | 'warn' | 'bad';
  href?: string;
}) {
  const toneClass = {
    neutral: 'text-ink-900',
    brand: 'text-brand-700',
    good: 'text-emerald-700',
    warn: 'text-amber-600',
    bad: 'text-red-600',
  }[tone];

  const body = (
    <>
      <div className={`text-2xl font-extrabold tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs font-medium text-ink-500">{label}</div>
    </>
  );

  return href ? (
    <Link href={href} className="card-tap block px-3 py-3 text-center">
      {body}
    </Link>
  ) : (
    <div className="card px-3 py-3 text-center">{body}</div>
  );
}
