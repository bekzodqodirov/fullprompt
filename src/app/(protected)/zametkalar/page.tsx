import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { and, eq } from 'drizzle-orm';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { telegramLinks } from '@/modules/platform/db/schema';
import {
  MAX_NOTE_PARTS,
  canShareNotes,
  filesForNote,
  listNotes,
} from '@/modules/platform/notes/service';
import { PageHeader } from '@/components/ui/page';
import { NoteList } from './note-list';

/**
 * Zametkalar — the library the staff bot re-sends from.
 *
 * NOT under /admin: that layout bounces every non-admin, and the people who
 * most need the warehouse address sheet are the ones the bot serves. The door
 * is a login, like the canned replies at /suhbatlar/shablonlar; publishing to
 * the COMPANY is the narrower check, and it lives in the service.
 */
export const dynamic = 'force-dynamic';

export default async function NotesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');

  const t = await getTranslations('notes');
  const rows = await listNotes(actor.id);
  // The parts, per drawn note. One query each is #432's shape on a list, so
  // they are read together and joined in JS.
  const parts = await Promise.all(rows.map((row) => filesForNote(row.id)));
  // A library nobody can open is a library nobody will fill: the notes are
  // SENT from the bot, so a staff member with no linked chat is told here
  // rather than finding out by never seeing the button (#780's lesson).
  const [link] = await db
    .select({ id: telegramLinks.id })
    .from(telegramLinks)
    .where(and(eq(telegramLinks.userId, actor.id), eq(telegramLinks.status, 'linked')))
    .limit(1);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <PageHeader icon="clipboard" title={`📌 ${t('title')}`} />
      <p className="text-sm text-ink-500" data-testid="notes-hint">
        {t('hint')}
      </p>
      {!link && (
        <p className="card text-sm text-warn" data-testid="notes-no-telegram">
          {t('noTelegram')}
        </p>
      )}

      <NoteList
        canShare={canShareNotes(actor.permissions)}
        maxParts={MAX_NOTE_PARTS}
        notes={rows.map((row, index) => ({
          id: row.id,
          title: row.title,
          body: row.body ?? '',
          shared: row.shared,
          parts: (parts[index] ?? []).map((file) => ({
            id: file.partId,
            attachmentId: file.attachmentId,
            fileName: file.fileName,
            sendAs: file.sendAs,
          })),
        }))}
      />
    </div>
  );
}
