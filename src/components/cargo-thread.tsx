import { getLocale, getTranslations } from 'next-intl/server';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { notificationLabels } from '@/modules/platform/notifications/labels';
import type { CargoKind } from '@/modules/platform/notifications/thread-ref';
import { cargoArms, cargoFramingOf, cargoNowLine } from '@/modules/wms/crm/cargo-thread';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { threadMessages } from '@/modules/wms/crm/thread';
import { threadFacts, type ThreadReader } from '@/modules/wms/crm/thread-door';
import { CargoThreadBox } from './cargo-thread-box';
import { ThreadBubbles } from './thread-bubbles';

/**
 * «❓ Savol-javob» on a prixod or a truck card (round 2, 0129 — the owner's
 * E6 c warehouse half, E7 b, Q4 a). The card's own untagged notes, read by
 * the office and the staff of the warehouse where the cargo stands NOW; the
 * page asked the door (`mayReadThread`) before mounting this, and the box is
 * for whoever reached it.
 *
 * Above the list, two lines say what the reader is about to talk to: WHERE
 * the cargo stands — the SAME formatter and dictionary the Telegram frame
 * prints (`cargoNowLine` over labels.ts, so the two cannot drift) — and WHO a
 * message from this reader would reach, from the SAME `cargoArms` the
 * announce asks (a preview of the arm before the door: a scoped logist
 * elsewhere may be counted here and dropped at send — stated, harmless).
 *
 * Text only (E10 a): no 📎. Its OWN catch: a database a release behind
 * renders one muted line and the rest of the card stands.
 */
export async function CargoThread({
  threadRef,
  viewer,
}: {
  threadRef: { kind: CargoKind; id: string };
  viewer: ThreadReader;
}) {
  const t = await getTranslations('threads');
  let messages: Awaited<ReturnType<typeof threadMessages>>;
  let facts: Awaited<ReturnType<typeof threadFacts>>;
  try {
    [messages, facts] = await Promise.all([threadMessages(threadRef), threadFacts(threadRef)]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.warn({ err, ...threadRef }, '[thread] cargo thread: server behind');
    return (
      <p className="text-xs text-ink-500" data-testid="cargo-thread-behind">
        {t('cargo.errors.server_behind')}
      </p>
    );
  }
  const framing = await cargoFramingOf(facts);
  const stand = framing?.stand ?? { warehouseIds: [], places: [] };
  const codes = framing?.codes ?? new Map<string, string>();
  const [arms, people] = await Promise.all([cargoArms(viewer, stand), mentionablePeople()]);
  const now = cargoNowLine(stand, codes, notificationLabels(await getLocale()));
  const code = (id: string) => codes.get(id) ?? '—';

  const staffed: string[] = [];
  const unstaffed: string[] = [];
  if (arms.to === 'staff') {
    for (const [warehouseId, ids] of arms.byWarehouse) {
      const n = ids.filter((id) => id !== viewer.id).length;
      if (n > 0) staffed.push(t('cargo.staffCount', { code: code(warehouseId), n }));
      else unstaffed.push(code(warehouseId));
    }
  }

  return (
    <section id="ichki" data-testid="cargo-thread" className="card scroll-mt-20 space-y-2">
      <h2 className="text-lg font-bold" data-testid="cargo-thread-title">
        {t('cargo.title', { n: messages.length })}
      </h2>
      {now ? (
        <p className="text-sm text-ink-700" data-testid="cargo-thread-now">
          {now}
        </p>
      ) : null}
      <div className="space-y-0.5 text-xs text-ink-500" data-testid="cargo-thread-audience">
        {arms.to === 'office' ? (
          <p>{t('cargo.toOffice')}</p>
        ) : (
          <>
            {staffed.length > 0 ? <p>{t('cargo.toStaff', { list: staffed.join(' · ') })}</p> : null}
            {unstaffed.map((c) => (
              <p key={c} className="text-warn">
                {t('cargo.staffNone', { code: c })}
              </p>
            ))}
          </>
        )}
      </div>
      <ThreadBubbles messages={messages} viewerId={viewer.id} prefix="cargo-thread" emptyText={t('cargo.empty')} />
      <CargoThreadBox threadRef={threadRef} people={people} />
    </section>
  );
}
