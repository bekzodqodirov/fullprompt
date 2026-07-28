import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { tgMessages, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * The Telegram conversation with this client, as a panel on a card.
 *
 * Owner: "bitim va crm bo'limida telefon raqamli kartochkalar bor u yerda ham
 * tursin chat." It goes on the client card, the deal card and the lead card —
 * anywhere the person is the subject of the screen.
 *
 * It CARRIES ITS OWN PERMISSION CHECK, and that is the design rather than a
 * detail. The deal card is open to `ved.docs` as well as sales
 * (`DEAL_WRITE_PERMISSIONS`), so an ungated panel dropped onto it would quietly
 * hand the customs manager every private sales conversation in the company.
 * A component meant to sit on any card has to be safe on any card, so the
 * check travels with it instead of living in whichever page remembers.
 *
 * Newest FIRST, unlike the `/suhbatlar` thread. This is not a conversation
 * being had; it is a record glanced at beside the cargo and the money, and the
 * question is almost always "what did we last say to them".
 */
export async function TelegramThread({
  clientId,
  limit = 200,
}: {
  clientId: string | null;
  limit?: number;
}) {
  // A lead that is nobody's client yet has no thread, and that is correct: the
  // import only ever keeps conversations matching the client book.
  if (!clientId) return null;

  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads') && !actor?.permissions.has('clients.manage')) {
    return null;
  }

  const t = await getTranslations('crm');
  const rows = await db
    .select({
      id: tgMessages.id,
      direction: tgMessages.direction,
      body: tgMessages.body,
      hasMedia: tgMessages.hasMedia,
      sentAt: tgMessages.sentAt,
      manager: users.fullName,
    })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .where(eq(tgMessages.clientId, clientId))
    .orderBy(desc(tgMessages.sentAt))
    .limit(limit);

  // Nothing imported for this client — say nothing rather than show an empty
  // box on every card in the system.
  if (rows.length === 0) return null;

  return (
    <section className="card space-y-2" data-testid="tg-thread">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">✈️ {t('telegramThread')}</h2>
        {/* The panel is a glance; the whole conversation is one tap away. */}
        <Link href={`/suhbatlar/${clientId}`} className="text-sm text-ink-500 underline">
          {t('conversations')} →
        </Link>
      </div>
      <div className="max-h-96 space-y-1.5 overflow-y-auto">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              row.direction === 'out' ? 'ml-8 bg-brand-50' : 'mr-8 bg-surface-200'
            }`}
          >
            <div className="mb-0.5 flex justify-between gap-2 text-xs text-ink-500">
              <span>{row.direction === 'out' ? row.manager : t('telegramClient')}</span>
              <span className="whitespace-nowrap">
                {new Date(row.sentAt).toLocaleString('ru-RU', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </span>
            </div>
            {row.body ? (
              <p className="whitespace-pre-wrap break-words">{row.body}</p>
            ) : (
              <p className="text-ink-500">📎 {t('telegramMedia')}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
