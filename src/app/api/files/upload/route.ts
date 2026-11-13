import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireActor, AuthError } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { broadcasts, pickupStops, receipts, staffNotes } from '@/modules/platform/db/schema';
import { mayReadReceipt } from '@/modules/wms/receipts/read-door';
import { mayAddReceiptFiles, recordReceiptFile } from '@/modules/wms/receipts/files-door';
import { BROADCAST_ENTITY_TYPE, mayBroadcast } from '@/modules/platform/broadcast/service';
import { PICKUP_WRITE } from '@/modules/wms/pickups/service';
import { FileValidationError, saveAttachment } from '@/modules/platform/files/service';
import { NOTE_ENTITY_TYPE, canShareNotes } from '@/modules/platform/notes/service';
import {
  STAFF_GROUP_MEDIA_ENTITY,
  STAFF_GROUP_MEDIA_MAX_BYTES,
  STAFF_GROUP_MEDIA_TYPE,
  STAFF_GROUP_MEDIA_TYPES,
} from '@/modules/platform/telegram/staff-group-media';

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
  // 'pickup_stop': the stamp at a factory (0100) — the signed loading paper,
  // photographed. Per-record below: the stop must exist and the uploader
  // must be the one who writes trips.
  'pickup_stop',
  // 'broadcast': a photo or a file the office sends to its clients (0109).
  // Per-record below: only the one who may broadcast, and only before the
  // message went — a file added to a sent broadcast would sit in its record
  // as sent when it never was.
  'broadcast',
  // 'staff_group_media': a GIF or photo the staff group's celebrations rotate
  // through (0134). Per-record below: only the settings admin, only against
  // the one fixed id the group's files live under, and only what the group
  // can play.
  'staff_group_media',
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

  // A prixod's files now back the customs papers (lot tarkibi: the client's
  // packing list a composition cites), and any login could add one to any
  // prixod. A receipt that EXISTS asks the receipt card's own read door; one
  // that does not exist yet is the wizard pre-binding to the id it minted
  // (#180) and passes, as the note's does above.
  let receiptTarget: { id: string; warehouseId: string; confirmed: boolean } | null = null;
  if (meta.data.entityType === 'receipt') {
    const receipt = await db.query.receipts.findFirst({
      where: eq(receipts.id, meta.data.entityId),
      columns: { id: true, warehouseId: true, status: true, voidedAt: true },
    });
    if (receipt && !(await mayReadReceipt(actor, receipt))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    // A voided prixod is off every shelf and its papers back nothing — the
    // bot's own refusal («Bu prixod bekor qilingan»), and the card draws no 📎
    // there; this is a stale page or a forged post (docs/PRIXOD-JAVOBLAR.md §3.4).
    if (receipt && (receipt.voidedAt || receipt.status === 'voided')) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    // On a CONFIRMED prixod a file is added by the people who work prixods —
    // the card's tile and the bot's door ask the same (§8, the owner lens O7);
    // the wizard's pre-binding (no prixod, or its draft) is the warehouse's.
    if (receipt && receipt.status === 'confirmed' && !mayAddReceiptFiles(actor)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (receipt) receiptTarget = { id: receipt.id, warehouseId: receipt.warehouseId, confirmed: receipt.status === 'confirmed' };
  }
  // A picture added to a CONFIRMED prixod by somebody who does not edit its
  // cargo is a PAPER — an invoice, a packing list a seller photographed — the
  // bot's own rule (0146): a prixod's `photo` attachments are its CARTON
  // photos (the loader's list, /stock, the Ostatka Excel draw the first one
  // where the cargo should be), and an invoice must never stand there. The
  // warehouse (`receipts.edit`) goes on adding a missed carton photo as a
  // photo (§3.3, the owner's «4 b»).
  const asPaper = receiptTarget?.confirmed === true && !actor.permissions.has('receipts.edit');

  if (meta.data.entityType === 'pickup_stop') {
    const stop = await db.query.pickupStops.findFirst({
      where: eq(pickupStops.id, meta.data.entityId),
    });
    if (!stop || !actor.permissions.has(PICKUP_WRITE)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  if (meta.data.entityType === BROADCAST_ENTITY_TYPE) {
    const sent = await db.query.broadcasts.findFirst({ where: eq(broadcasts.id, meta.data.entityId) });
    if (!mayBroadcast(actor) || sent) return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  if (meta.data.entityType === STAFF_GROUP_MEDIA_TYPE) {
    if (!actor.permissions.has('admin.settings.manage') || meta.data.entityId !== STAFF_GROUP_MEDIA_ENTITY) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (!STAFF_GROUP_MEDIA_TYPES[file.type]) return Response.json({ error: 'validation' }, { status: 400 });
    if (file.size > STAFF_GROUP_MEDIA_MAX_BYTES) return Response.json({ error: 'too_large' }, { status: 400 });
  }

  try {
    const result = await saveAttachment(
      {
        entityType: meta.data.entityType,
        entityId: meta.data.entityId,
        fileName: file.name,
        contentType: file.type,
        body: Buffer.from(await file.arrayBuffer()),
        uploadedBy: actor.id,
      },
      { asPaper },
    );
    // The History line every file added to a confirmed prixod gets (5a's ⭐ —
    // «kartada va tarixda ko'rinadi»; until now only the bot's did). Never on
    // the wizard's pre-binding (no prixod yet), never failing the upload.
    if (receiptTarget?.confirmed) {
      await recordReceiptFile({
        actorId: actor.id,
        receipt: receiptTarget,
        item: result.id,
        fileName: file.name,
        via: 'site',
      });
    }
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof FileValidationError) {
      return Response.json({ error: err.code, detail: err.message }, { status: 400 });
    }
    throw err;
  }
}
