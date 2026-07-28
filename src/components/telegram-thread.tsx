import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { tgMessages, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { TelegramBubble } from './telegram-bubble';

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
 * Read in the order it happened, and opening on the LAST message. The first
 * cut showed it newest-first, on the theory that a card is a reference rather
 * than a conversation; the owner read it as simply upside-down, and he is
 * right — nobody reads a chat backwards. `flex-col-reverse` over a
 * newest-first list gives both: reading order on screen, and a scroll box
 * whose first painted frame is already at the bottom, with no jump.
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
      <div className="flex max-h-96 flex-col-reverse gap-1.5 overflow-y-auto">
        {rows.map((row) => (
          <TelegramBubble
            key={row.id}
            message={row}
            clientLabel={t('telegramClient')}
            mediaLabel={t('telegramMedia')}
          />
        ))}
      </div>
    </section>
  );
}
