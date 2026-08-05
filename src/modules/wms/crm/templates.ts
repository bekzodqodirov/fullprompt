import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { replyTemplates } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * The sentences a manager types twenty times a day.
 *
 * Two kinds, which is the owner's own answer: the COMPANY's, written by an
 * admin and offered to everybody, and a person's own, which nobody else sees.
 * The ownership column is `list_views`'s exactly — NULL means shared — and so
 * is the gate on writing a shared one, for the same reason: deciding what
 * every colleague is offered is a different and larger power than keeping a
 * note for yourself.
 */

export class TemplateError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Publishing to the company. No new permission code (#170). */
export const SHARE_TEMPLATES_PERMISSION = 'admin.settings.manage';

export const templateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  // Telegram's own caption cap is 1024 and a message is longer, but a canned
  // reply that runs past a screen is not a canned reply.
  body: z.string().trim().min(1).max(1000),
  /** True asks for the company's list; refused without the permission. */
  shared: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});
export type TemplateInput = z.infer<typeof templateSchema>;

/**
 * `{ism}` and `{kod}`, and nothing else.
 *
 * A placeholder nobody defined is LEFT ALONE rather than blanked: a body that
 * happens to contain braces is somebody's text, and quietly deleting part of a
 * message on its way to a customer is worse than printing it. An empty client
 * name blanks its own placeholder — greeting «Hurmatli {ism}» to a client with
 * no name on file would send the braces to the customer.
 */
export function fillTemplate(body: string, values: { ism?: string; kod?: string }): string {
  return body.replace(/\{(ism|kod)\}/g, (whole, key: 'ism' | 'kod') => {
    const value = values[key];
    return value === undefined ? whole : value;
  });
}

/** The company's, plus this person's own. Ordered as they were arranged. */
export async function listTemplates(userId: string) {
  return db
    .select()
    .from(replyTemplates)
    .where(or(isNull(replyTemplates.userId), eq(replyTemplates.userId, userId)))
    .orderBy(asc(replyTemplates.sortOrder), asc(replyTemplates.title));
}

/** What a composer offers: already filled for the client in front of you. */
export async function templatesFor(
  userId: string,
  client: { name?: string | null; code?: string | null },
): Promise<{ id: string; title: string; body: string; shared: boolean }[]> {
  const rows = await listTemplates(userId);
  const values = { ism: client.name ?? '', kod: client.code ?? '' };
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: fillTemplate(row.body, values),
    shared: row.userId === null,
  }));
}

export async function saveTemplate(
  input: TemplateInput & { id?: string },
  ctx: AuditContext & { canShare: boolean },
) {
  if (!ctx.actorId) throw new TemplateError('unauthenticated');
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) throw new TemplateError('validation');
  const data = parsed.data;
  if (data.shared && !ctx.canShare) throw new TemplateError('forbidden');

  const values = {
    title: data.title,
    body: data.body,
    sortOrder: data.sortOrder,
    userId: data.shared ? null : ctx.actorId,
  };

  if (input.id) {
    // Editing somebody else's is not a mistake to correct, it is a refusal:
    // a personal template belongs to one person, and the company's belongs to
    // whoever may publish.
    const before = await db.query.replyTemplates.findFirst({
      where: eq(replyTemplates.id, input.id),
    });
    if (!before) throw new TemplateError('not_found');
    if (before.userId === null ? !ctx.canShare : before.userId !== ctx.actorId) {
      throw new TemplateError('forbidden');
    }
    await db
      .update(replyTemplates)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(replyTemplates.id, input.id));
    await writeAudit(db, ctx, {
      entityType: 'reply_template',
      entityId: input.id,
      action: 'update',
      after: values,
    });
    return input.id;
  }

  const [row] = await db
    .insert(replyTemplates)
    .values({ ...values, createdBy: ctx.actorId })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'reply_template',
    entityId: row!.id,
    action: 'create',
    after: values,
  });
  return row!.id;
}

export async function deleteTemplate(id: string, ctx: AuditContext & { canShare: boolean }) {
  if (!ctx.actorId) throw new TemplateError('unauthenticated');
  const before = await db.query.replyTemplates.findFirst({ where: eq(replyTemplates.id, id) });
  if (!before) throw new TemplateError('not_found');
  if (before.userId === null ? !ctx.canShare : before.userId !== ctx.actorId) {
    throw new TemplateError('forbidden');
  }
  await db
    .delete(replyTemplates)
    .where(and(eq(replyTemplates.id, id)));
  await writeAudit(db, ctx, {
    entityType: 'reply_template',
    entityId: id,
    action: 'delete',
    before: { title: before.title },
  });
}
