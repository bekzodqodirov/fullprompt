import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { notifyStaffTelegram } from '../notifications/staff';
import { usersWithRoles } from '../notifications/service';
import { tashkentDay } from '../time/tashkent';

/**
 * The client's birthday (0109, the owner's 6c/6d): the contact person's day,
 * reminded to the admins and to the client's own seller, in Telegram and on
 * the home screen, with a link that opens the broadcast on that one client.
 *
 * «Today» is Tashkent's (R5). A 29 February birthday is kept on 28 February
 * in a year that has none — a person born then still has a birthday.
 */
export function birthdayMatchSql(day: string) {
  const md = day.slice(5);
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const alsoFeb29 = md === '02-28' && !leap(Number(day.slice(0, 4)));
  return alsoFeb29
    ? sql`to_char(${clients.birthday}, 'MM-DD') IN ('02-28', '02-29')`
    : sql`to_char(${clients.birthday}, 'MM-DD') = ${md}`;
}

export interface BirthdayClient {
  id: string;
  clientCode: string;
  name: string;
  salesManagerId: string | null;
  birthday: string;
}

/** Today's birthdays — all of them, or one seller's own clients. */
export async function birthdaysOn(day = tashkentDay(), sellerId?: string): Promise<BirthdayClient[]> {
  const rows = await db
    .select({
      id: clients.id,
      clientCode: clients.clientCode,
      name: clients.name,
      salesManagerId: clients.salesManagerId,
      birthday: sql<string>`${clients.birthday}::text`,
    })
    .from(clients)
    .where(
      and(
        eq(clients.active, true),
        sql`${clients.birthday} IS NOT NULL`,
        birthdayMatchSql(day),
        sellerId ? eq(clients.salesManagerId, sellerId) : undefined,
      ),
    )
    .orderBy(clients.clientCode);
  return rows;
}

/** Whole years on `day` — «35 yoshga to'ldi» — or null when the year is unknown/odd. */
export function ageOn(birthday: string, day: string): number | null {
  const years = Number(day.slice(0, 4)) - Number(birthday.slice(0, 4));
  return years > 0 && years < 120 ? years : null;
}

/**
 * The morning reminder, once per client per day: every admin and super admin
 * (his «admin va sotuv manageriga»), and the client's seller.
 */
export async function alertBirthdays(day = tashkentDay()): Promise<number> {
  const due = (await birthdaysOn(day)).filter(Boolean);
  if (due.length === 0) return 0;
  const pending = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        sql`${clients.id} IN (${sql.join(
          due.map((c) => sql`${c.id}::uuid`),
          sql`, `,
        )})`,
        or(isNull(clients.birthdayAlertedOn), ne(clients.birthdayAlertedOn, day)),
      ),
    );
  const open = new Set(pending.map((r) => r.id));
  const admins = await usersWithRoles(['super_admin', 'admin']);
  const appUrl = process.env.APP_URL ?? '';
  let sent = 0;
  for (const client of due) {
    if (!open.has(client.id)) continue;
    const age = ageOn(client.birthday, day);
    await notifyStaffTelegram({
      userIds: [...admins, ...(client.salesManagerId ? [client.salesManagerId] : [])],
      type: 'ClientBirthday',
      text:
        `🎂 Bugun ${client.clientCode} — ${client.name} tug'ilgan kuni${age ? ` (${age} yosh)` : ''}. Tabriklab qo'ying!\n` +
        `${appUrl}/xabarlar?kod=${encodeURIComponent(client.clientCode)}`,
    });
    await db.update(clients).set({ birthdayAlertedOn: day }).where(eq(clients.id, client.id));
    sent += 1;
  }
  return sent;
}
