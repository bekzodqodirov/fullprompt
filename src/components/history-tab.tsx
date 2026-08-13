import { and, desc, eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { auditLog, users } from '@/modules/platform/db/schema';
import {
  AUDIT_FIELD_LABELS,
  collectAuditRefs,
  isUuidShaped,
  AUDIT_FIELD_REFS,
} from '@/modules/platform/audit/fields';
import { resolveAuditRefs } from '@/modules/platform/audit/refs';
import {
  groupHistory,
  visibleChanges,
  type HistoryChange,
} from '@/modules/platform/audit/history';

/**
 * Reusable "History" tab (spec 4.3): human-readable audit timeline for one
 * entity — "Aziz changed weight 25 → 28 kg, 14:32".
 *
 * A run of edits by one person in one sitting reads as one entry with the net
 * change per field, and the individual rows stay one press away — nothing is
 * dropped, only folded. `groupHistory` holds the rules.
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
    return <p className="text-sm text-ink-500">—</p>;
  }

  const groups = groupHistory(
    rows.map(({ entry, actorName }) => ({
      id: String(entry.id),
      actorId: entry.actorId,
      actorName,
      action: entry.action,
      before: (entry.before ?? null) as Record<string, unknown> | null,
      after: (entry.after ?? null) as Record<string, unknown> | null,
      createdAt: entry.createdAt,
    })),
  );

  const when = (at: Date) => format.dateTime(at, { dateStyle: 'short', timeStyle: 'short' });
  // A column with no entry in the map prints its own name — a technical label
  // beats a wrong one, and this list covers what the cards actually record.
  const fieldLabel = (key: string) =>
    AUDIT_FIELD_LABELS[key] ? t(`fields.${AUDIT_FIELD_LABELS[key]}`) : key;

  // The NAMES behind the recorded ids (round 100, owner's item 4: «qandaydur
  // codelar emas odam tushunadgan nomlar bilan»). Collected over the folded
  // rows too, so opening a fold shows the same words as the summary line.
  const refIds = collectAuditRefs([
    ...groups.flatMap((group) => group.changes),
    ...groups.flatMap((group) => group.rows.flatMap((row) => visibleChanges(row.before, row.after))),
  ]);
  const refNames = await resolveAuditRefs(refIds);

  return (
    <ol className="space-y-3" data-testid="history-list">
      {groups.map((group) => (
        <li key={group.id} className="card !p-3 text-sm" data-testid="history-entry">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{group.actorName ?? t('system')}</span>
            <span>{t(`actions.${group.action}`)}</span>
            {group.rows.length > 1 && (
              <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700">
                {t('changeCount', { n: group.changes.length })}
              </span>
            )}
            <span className="ml-auto text-xs text-ink-500">{when(group.at)}</span>
          </div>

          {group.changes.length > 0 && (
            <ChangeList changes={group.changes} label={fieldLabel} names={refNames} />
          )}

          {/* Merged rows keep their own times and their own fields, because a
              net is a summary and an audit trail may not only be summarised. */}
          {group.rows.length > 1 && (
            <details className="mt-2 border-t border-line pt-2">
              <summary className="cursor-pointer text-xs font-semibold text-ink-500">
                {t('entryCount', { n: group.rows.length })}
              </summary>
              <ol className="mt-2 space-y-2">
                {group.rows.map((row) => (
                  <li key={row.id} data-testid="history-row" className="border-l-2 border-line pl-2">
                    <p className="text-xs text-ink-500">{when(row.createdAt)}</p>
                    <ChangeList
                      changes={visibleChanges(row.before, row.after)}
                      label={fieldLabel}
                      names={refNames}
                      bare
                    />
                  </li>
                ))}
              </ol>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The field lines.
 *
 * `[overflow-wrap:anywhere] min-w-0` is not decoration: a note is 4000
 * characters wide, and one row wider than the phone rescales the WHOLE page
 * (#400). The admin audit table has clamped the same payload since it shipped.
 */
function ChangeList({
  changes,
  label,
  names,
  bare = false,
}: {
  changes: HistoryChange[];
  label: (key: string) => string;
  /** uuid → the thing's name, resolved once for the whole page. */
  names: Map<string, string>;
  bare?: boolean;
}) {
  if (changes.length === 0) return null;
  // A resolved reference prints its NAME and keeps the id in the tooltip; a
  // uuid the lookup could not name stays on screen as it is — a raw id is
  // honest, a wrong name is not.
  const shown = (key: string, value: unknown) => {
    if (AUDIT_FIELD_REFS[key] && isUuidShaped(value)) {
      const name = names.get(value);
      if (name) return { text: name, title: value };
    }
    return { text: formatValue(value), title: undefined };
  };
  return (
    <ul className={bare ? 'space-y-1' : 'mt-2 space-y-1 border-t border-line pt-2'}>
      {changes.map((change) => {
        const before = shown(change.key, change.before);
        const after = shown(change.key, change.after);
        return (
          <li key={change.key} className="flex flex-wrap gap-x-2">
            <span className="text-xs text-ink-500">{label(change.key)}:</span>
            <span
              className="min-w-0 text-bad line-through [overflow-wrap:anywhere]"
              title={before.title}
            >
              {before.text}
            </span>
            <span aria-hidden>→</span>
            <span
              className="min-w-0 font-semibold text-good [overflow-wrap:anywhere]"
              title={after.title}
            >
              {after.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
