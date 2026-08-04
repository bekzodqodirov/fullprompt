import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { listViews } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { canPublishViews } from './query';

/**
 * Saved list views.
 *
 * The whole engine is this table plus a link: a view stores the screen's own
 * query string and applying it is a navigation, so nothing here knows what a
 * filter means or how any list is queried. That is deliberate — see
 * `fields/filter.ts` for the same decision taken about custom fields.
 */

export class ListViewError extends Error {
  constructor(
    public code:
      | 'unauthenticated'
      | 'not_found'
      | 'forbidden'
      | 'name_required'
      | 'duplicate_name',
  ) {
    super(code);
    this.name = 'ListViewError';
  }
}

export interface SavedView {
  id: string;
  screen: string;
  name: string;
  query: string;
  /** False for a published view somebody else owns. */
  mine: boolean;
  isDefault: boolean;
  pinned: boolean;
}

/**
 * My views and the published ones, mine first.
 *
 * One query, not two: a screen renders this on every load and the index is on
 * (screen, user_id).
 */
export async function listViewsFor(screen: string, userId: string): Promise<SavedView[]> {
  const rows = await db
    .select()
    .from(listViews)
    .where(
      and(
        eq(listViews.screen, screen),
        or(eq(listViews.userId, userId), isNull(listViews.userId)),
      ),
    )
    .orderBy(desc(listViews.pinned), asc(listViews.name));

  return rows
    .map((row) => ({
      id: row.id,
      screen: row.screen,
      name: row.name,
      query: row.query,
      mine: row.userId === userId,
      isDefault: row.isDefault,
      pinned: row.pinned,
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine));
}

/** The view to open the screen with when nobody asked for one. */
export async function defaultViewFor(screen: string, userId: string): Promise<SavedView | null> {
  const [row] = await db
    .select()
    .from(listViews)
    .where(
      and(
        eq(listViews.screen, screen),
        eq(listViews.userId, userId),
        eq(listViews.isDefault, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    screen: row.screen,
    name: row.name,
    query: row.query,
    mine: true,
    isDefault: true,
    pinned: row.pinned,
  };
}

export interface SaveViewInput {
  screen: string;
  name: string;
  query: string;
  /** Publish to everyone — admin only, the owner's answer of 2026-08-04. */
  makePublic?: boolean;
  /** Open the screen with this view from now on (personal). */
  makeDefault?: boolean;
  pinned?: boolean;
}

export async function saveView(
  input: SaveViewInput,
  actor: { id: string; permissions: Set<string> },
  ctx: AuditContext,
): Promise<SavedView> {
  const name = input.name.trim();
  if (!name) throw new ListViewError('name_required');
  // A published view decides what a colleague's screen looks like the moment
  // they open it, which is why it is the admin's to create and not everyone's.
  if (input.makePublic && !canPublishViews(actor.permissions)) {
    throw new ListViewError('forbidden');
  }
  // Publishing and "my default" are different scopes and the CHECK says so;
  // asking for both silently dropped one, so it is refused in words instead.
  const makeDefault = input.makePublic ? false : (input.makeDefault ?? false);

  return db.transaction(async (tx) => {
    if (makeDefault) {
      // The partial unique index would refuse a second default; clear the old
      // one first so pressing the box on a new view means what it says.
      await tx
        .update(listViews)
        .set({ isDefault: false })
        .where(
          and(
            eq(listViews.screen, input.screen),
            eq(listViews.userId, actor.id),
            eq(listViews.isDefault, true),
          ),
        );
    }

    let row;
    try {
      [row] = await tx
        .insert(listViews)
        .values({
          screen: input.screen,
          name,
          query: input.query,
          userId: input.makePublic ? null : actor.id,
          isDefault: makeDefault,
          pinned: input.pinned ?? false,
          createdBy: actor.id,
        })
        .returning();
    } catch (err) {
      // The unique index is the authority on duplicate names; a pre-check
      // would still race two presses of the same button.
      if (isUniqueViolation(err)) throw new ListViewError('duplicate_name');
      throw err;
    }

    await writeAudit(tx, ctx, {
      entityType: 'list_view',
      entityId: row!.id,
      action: 'create',
      after: { screen: input.screen, name, query: input.query, public: !!input.makePublic },
    });
    return {
      id: row!.id,
      screen: row!.screen,
      name: row!.name,
      query: row!.query,
      mine: !input.makePublic,
      isDefault: row!.isDefault,
      pinned: row!.pinned,
    };
  });
}

/**
 * Delete a view.
 *
 * Mine, always. Somebody else's only if it is published AND the actor may
 * publish — the same gate both ways, so the person who can create a
 * company-wide view is the person who can take it away again.
 */
export async function deleteView(
  id: string,
  actor: { id: string; permissions: Set<string> },
  ctx: AuditContext,
): Promise<void> {
  const [row] = await db.select().from(listViews).where(eq(listViews.id, id)).limit(1);
  if (!row) throw new ListViewError('not_found');
  const own = row.userId === actor.id;
  const publicView = row.userId === null;
  if (!own && !(publicView && canPublishViews(actor.permissions))) {
    throw new ListViewError('forbidden');
  }
  await db.delete(listViews).where(eq(listViews.id, id));
  await writeAudit(db, ctx, {
    entityType: 'list_view',
    entityId: id,
    action: 'delete',
    before: { screen: row.screen, name: row.name, query: row.query, public: publicView },
  });
}

/**
 * Pin a view to the sidebar, or make it the one this screen opens with.
 *
 * A published view can be pinned by anyone who sees it — pinning is a
 * preference about where a link sits. It cannot be made anyone's default,
 * because `is_default` lives on the row and the row belongs to everybody.
 */
export async function updateView(
  id: string,
  patch: { pinned?: boolean; isDefault?: boolean },
  actor: { id: string; permissions: Set<string> },
): Promise<void> {
  const [row] = await db.select().from(listViews).where(eq(listViews.id, id)).limit(1);
  if (!row) throw new ListViewError('not_found');
  const own = row.userId === actor.id;
  const publicView = row.userId === null;
  if (!own && !publicView) throw new ListViewError('forbidden');
  if (patch.isDefault !== undefined && !own) throw new ListViewError('forbidden');
  if (patch.pinned !== undefined && publicView && !canPublishViews(actor.permissions)) {
    throw new ListViewError('forbidden');
  }

  await db.transaction(async (tx) => {
    if (patch.isDefault) {
      await tx
        .update(listViews)
        .set({ isDefault: false })
        .where(
          and(
            eq(listViews.screen, row.screen),
            eq(listViews.userId, actor.id),
            eq(listViews.isDefault, true),
          ),
        );
    }
    await tx
      .update(listViews)
      .set({
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
      })
      .where(eq(listViews.id, id));
  });
}

/** Postgres says 23505 for a unique violation; postgres.js keeps the code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

/** How many views exist for a screen — the admin screen's counter. */
export async function viewCount(screen: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(listViews)
    .where(eq(listViews.screen, screen));
  return Number(row?.n ?? 0);
}
