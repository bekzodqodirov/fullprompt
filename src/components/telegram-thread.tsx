import { desc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { tgMessages, users } from '@/modules/platform/db/schema';

/**
 * The manager's Telegram conversation with this client, on the client card.
 *
 * Owner: "biz clientlarimiz bn 95 foiz telegramda gaplashamiz." The whole
 * point of importing it is that it sits where the rest of the client's life
 * already is — beside their cargo, their balance and their deals — instead of
 * on one person's phone.
 *
 * Newest FIRST, unlike a chat app. This is not a conversation being had; it is
 * a record being consulted, and the question is almost always "what did we
 * last say to them".
 */
export async function TelegramThread({ clientId }: { clientId: string }) {
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
    .limit(200);

  // Nothing imported for this client — say nothing rather than show an empty
  // box on every card in the system.
  if (rows.length === 0) return null;

  return (
    <section className="card space-y-2" data-testid="tg-thread">
      <h2 className="text-lg font-bold">✈️ {t('telegramThread')}</h2>
      <div className="max-h-96 space-y-1.5 overflow-y-auto">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              row.direction === 'out'
                ? 'ml-8 bg-brand-50'
                : 'mr-8 bg-surface-200'
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
