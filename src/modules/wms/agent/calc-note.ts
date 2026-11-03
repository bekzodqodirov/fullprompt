import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { crmActivities } from '../../platform/db/schema';

/**
 * Was this draft's intake note already written — the landing re-run after a
 * crash finds its own note (build-6) instead of a second one. A file of its
 * own: a module that names `crm_activities` must reach the 0127 columns
 * through `to_jsonb` (thread-wire's fence), and this one reads only the id.
 */
export async function intakeNoteExists(noteId: string): Promise<boolean> {
  const [row] = await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteId));
  return row !== undefined;
}
