import { and, desc, eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { auditLog, users } from '@/modules/platform/db/schema';

/**
 * Reusable "History" tab (spec 4.3): human-readable audit timeline for one
 * entity — "Aziz changed weight 25 → 28 kg, 14:32".
 */
export async function HistoryTab({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string;
}) {
  const t = await getTranslations('audit');
  const format = await getFormatter();

  const rows = await db
    .select({ entry: auditLog, actorName: users.fullName })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  if (rows.length === 0) {
    return <p className="text-sm text-gray-500">—</p>;
  }

  return (
    <ol className="space-y-3">
      {rows.map(({ entry, actorName }) => {
        const before = (entry.before ?? {}) as Record<string, unknown>;
        const after = (entry.after ?? {}) as Record<string, unknown>;
        const changedKeys = Object.keys(after);
        return (
          <li key={String(entry.id)} className="card !p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{actorName ?? t('system')}</span>
              <span>{t(`actions.${entry.action}`)}</span>
              <span className="ml-auto text-xs text-gray-500">
                {format.dateTime(entry.createdAt, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </span>
            </div>
            {entry.action === 'update' && changedKeys.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                {changedKeys.map((key) => (
                  <li key={key} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-xs text-gray-500">{key}:</span>
                    <span className="text-red-700 line-through">{formatValue(before[key])}</span>
                    <span aria-hidden>→</span>
                    <span className="font-semibold text-green-700">{formatValue(after[key])}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
