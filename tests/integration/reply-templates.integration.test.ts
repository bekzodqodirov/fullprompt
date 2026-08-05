import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, replyTemplates, roles, userRoles, users } from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import {
  deleteTemplate,
  listTemplates,
  saveTemplate,
  templatesFor,
} from '@/modules/wms/crm/templates';

/**
 * The canned replies: who may write which list, and who is offered what.
 *
 * The two rules worth a test are the ones a screen cannot enforce: publishing
 * to the COMPANY needs the permission (a checkbox is a request), and a
 * personal template belongs to one person — editing or deleting somebody
 * else's is a refusal, not a mistake to correct.
 */

const SUFFIX = String(Date.now()).slice(-7);
let adminId = '';
let otherId = '';
let clientId = '';

const ctx = (actorId: string, canShare: boolean) => ({
  actorId,
  ip: null,
  userAgent: null,
  canShare,
});

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  adminId = admins[0]!.id;
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt));
  otherId = staff.find((row) => row.id !== adminId)!.id;

  const client = await createClient(
    { name: `Shablon mijoz ${SUFFIX}`, clientCode: `TPL${SUFFIX}`, phones: [] },
    { actorId: adminId, ip: null, userAgent: null },
  );
  clientId = client.id;
});

afterAll(async () => {
  // A template is CONFIGURATION while it exists (#183) — a shared one changes
  // what every colleague's composer offers, so nothing may be left behind.
  //
  // Swept by TITLE, not by the ids this file collected: half of these cases
  // assert a REFUSAL, and the whole point of red-proving one (#166) is to run
  // the file with the guard stripped — at which moment the call succeeds, the
  // id is never recorded, and the row it should have refused survives into
  // every later run. Three of them did exactly that before this sweep existed.
  //
  // The audit trail stays: `audit_log` refuses DELETE by database rule, and
  // the row it wrote is the record that these templates ever existed.
  await db.delete(replyTemplates).where(like(replyTemplates.title, `%${SUFFIX}%`));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('publishing to the company', () => {
  it('is refused without the permission', async () => {
    await expect(
      saveTemplate(
        { title: `Umumiy ${SUFFIX}`, body: 'Salom {ism}', shared: true, sortOrder: 100 },
        ctx(otherId, false),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('writes a row nobody owns when the permission is held', async () => {
    const id = await saveTemplate(
      { title: `Kompaniya ${SUFFIX}`, body: 'Hurmatli {ism}, {kod}', shared: true, sortOrder: 10 },
      ctx(adminId, true),
    );
    const [row] = await db.select().from(replyTemplates).where(eq(replyTemplates.id, id));
    expect(row!.userId).toBeNull();
    expect(row!.createdBy).toBe(adminId);
  });
});

describe('a personal template', () => {
  let mineId = '';

  it('belongs to whoever wrote it', async () => {
    mineId = await saveTemplate(
      { title: `Mening ${SUFFIX}`, body: 'Yukingiz yo‘lda', shared: false, sortOrder: 50 },
      ctx(otherId, false),
    );
    const [row] = await db.select().from(replyTemplates).where(eq(replyTemplates.id, mineId));
    expect(row!.userId).toBe(otherId);
  });

  it('is invisible to everybody else', async () => {
    const theirs = await listTemplates(adminId);
    expect(theirs.map((row) => row.id)).not.toContain(mineId);
    // …while the company's is offered to both.
    expect(theirs.map((row) => row.userId)).toContain(null);
  });

  it('refuses an edit by somebody else', async () => {
    await expect(
      saveTemplate(
        { id: mineId, title: `O‘g‘irlangan ${SUFFIX}`, body: 'x', shared: false, sortOrder: 1 },
        ctx(adminId, true),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a delete by somebody else', async () => {
    await expect(deleteTemplate(mineId, ctx(adminId, true))).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('what the composer is handed', () => {
  it('arrives already filled for the client in front of you', async () => {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const offered = await templatesFor(adminId, {
      name: client!.name,
      code: client!.clientCode,
    });
    const company = offered.find((row) => row.title === `Kompaniya ${SUFFIX}`)!;
    expect(company.body).toBe(`Hurmatli Shablon mijoz ${SUFFIX}, TPL${SUFFIX}`);
    expect(company.body).not.toContain('{');
    expect(company.shared).toBe(true);
  });
});

describe('deleting your own', () => {
  it('takes the row away', async () => {
    const id = await saveTemplate(
      { title: `O‘chiriladigan ${SUFFIX}`, body: 'x', shared: false, sortOrder: 100 },
      ctx(otherId, false),
    );
    await deleteTemplate(id, ctx(otherId, false));
    const rows = await db.select().from(replyTemplates).where(eq(replyTemplates.id, id));
    expect(rows).toHaveLength(0);
  });
});
