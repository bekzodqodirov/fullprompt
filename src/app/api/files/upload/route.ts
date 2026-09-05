import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireActor, AuthError } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { staffNotes } from '@/modules/platform/db/schema';
import { FileValidationError, saveAttachment } from '@/modules/platform/files/service';
import { NOTE_ENTITY_TYPE, canShareNotes } from '@/modules/platform/notes/service';

/**
 * The only things anything in this app attaches a file to.
 *
 * `entityType` used to be `z.string().max(50)` straight from the browser, and
 * it becomes both the attachment's identity and the storage key prefix
 * (`${entityType}/${entityId}/…`) — so a caller could invent a type, write
 * objects into a namespace no screen ever lists and no cleanup ever reaches.
 * An allowlist costs nothing and the list is five entries long.
 *
 * `custom_field` is the odd one: its entityId is not a record but a GROUP id
 * minted per (file field, record) and stored in that answer's `value_ref`, so
 * a document attached to a custom field cannot appear in — or be deleted from
 * — the receipt's own attachment panel.
 *
 * NOT a substitute for per-record authorization: this says WHAT kind of thing
 * may carry a file, not WHICH one this user may touch. That check needs the
 * policy layer and lands with it.
 */
// 'crm_activity': files on an internal note (owner: "zametkaga fayllar
// qo'shish") — uploaded against a client-generated note id before the note
// exists, the same pre-binding the receipt wizard uses for lot photos.
// 'tg_outbox': the photo of an outgoing Telegram reply, pre-bound the same
// way; queueReply claims it onto the queue row, the sender re-binds it to
// the echoed tg_message once it is really out.
const ATTACHABLE = [
  'receipt',
  'receipt_lot',
  'crate',
  'handover',
  'custom_field',
  'crm_activity',
  'tg_outbox',
  // 'batch': the papers that travel with the truck — invoice, declaration,
  // whatever the road asks for (owner, round 39). 'partner_transaction': the
  // proof behind a three-cornered settlement, pre-bound to the id the form
  // mints so a receipt photo can be attached before the entry is saved.
  'batch',
  'partner_transaction',
  // 'expense_request': the chek behind a rasxod xabari (round 107), pre-bound
  // to the id the fold mints before the request is saved.
  'expense_request',
  // 'staff_note': a part of a zametka — the photo, the address sheet, the
  // price list the office re-sends from the bot. Pre-bound to the id the form
  // mints, like every other entry here, and the ONE type on this list that
  // also gets a per-record check below.
  'staff_note',
] as const;

const metaSchema = z.object({
  entityType: z.enum(ATTACHABLE),
  entityId: z.string().uuid(),
});

export async function POST(request: Request) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const meta = metaSchema.safeParse({
    entityType: formData.get('entityType'),
    entityId: formData.get('entityId'),
  });
  if (!meta.success || !(file instanceof File)) {
    return Response.json({ error: 'validation' }, { status: 400 });
  }

  // The per-record half this route's own comment says it does not do.
  //
  // It is not done for the other ten types and that is not changed here; it is
  // done for THIS one because a company note is a one-tap broadcast that
  // colleagues forward to CUSTOMERS, and a note's id is not a secret — it
  // rides in the bot's callback payload and in every href on the screen. So a
  // colleague could otherwise push bytes into the note everybody sends out,
  // read them back through `decide()`'s uploader short-circuit, and leave the
  // note's owner unable to remove them.
  if (meta.data.entityType === NOTE_ENTITY_TYPE) {
    const note = await db.query.staffNotes.findFirst({
      where: eq(staffNotes.id, meta.data.entityId),
    });
    // No note yet = the form is pre-binding its first upload against an id it
    // has just minted. That is the house pattern (#180) and must keep working.
    if (note) {
      const mine =
        note.userId === null ? canShareNotes(actor.permissions) : note.userId === actor.id;
      if (!mine) return Response.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  try {
    const result = await saveAttachment({
      entityType: meta.data.entityType,
      entityId: meta.data.entityId,
      fileName: file.name,
      contentType: file.type,
      body: Buffer.from(await file.arrayBuffer()),
      uploadedBy: actor.id,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof FileValidationError) {
      return Response.json({ error: err.code, detail: err.message }, { status: 400 });
    }
    throw err;
  }
}
