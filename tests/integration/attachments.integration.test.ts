import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, users } from '@/modules/platform/db/schema';
import {
  AttachmentDeleteError,
  deleteAttachment,
  FileValidationError,
  saveAttachment,
} from '@/modules/platform/files/service';
import { getStorage } from '@/modules/platform/files/storage';

/**
 * Attachment lifecycle (owner's bug reports #1/#2): extension fallback for
 * uploads the browser mislabels, and delete for wrongly-added files —
 * uploader may remove their own, strangers without receipts.edit may not.
 */

let uploaderId: string;
let strangerId: string;

beforeAll(async () => {
  const mkUser = async (phone: string) => {
    const [row] = await db
      .insert(users)
      .values({ phone, fullName: `itest ${phone}`, passwordHash: 'x', active: true })
      .onConflictDoUpdate({ target: users.phone, set: { active: true } })
      .returning({ id: users.id });
    return row!.id;
  };
  uploaderId = await mkUser('+998911110001');
  strangerId = await mkUser('+998911110002');
});

afterAll(async () => {
  await pgClient.end();
});

describe('saveAttachment / deleteAttachment', () => {
  it('accepts an .xlsx with an empty content type via extension fallback', async () => {
    const { id } = await saveAttachment({
      entityType: 'receipt',
      entityId: randomUUID(),
      fileName: 'invoice.xlsx',
      contentType: '',
      body: Buffer.from('itest bytes'),
      uploadedBy: uploaderId,
    });
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
    expect(row?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await deleteAttachment(id, { id: uploaderId, permissions: new Set() });
  });

  it('rejects an unknown type with a machine-readable code', async () => {
    await expect(
      saveAttachment({
        entityType: 'receipt',
        entityId: randomUUID(),
        fileName: 'tool.exe',
        contentType: '',
        body: Buffer.from('x'),
        uploadedBy: uploaderId,
      }),
    ).rejects.toSatisfy(
      (err) => err instanceof FileValidationError && err.code === 'unsupported_type',
    );
  });

  it('uploader can delete own file (row + bytes gone); stranger cannot', async () => {
    const { id } = await saveAttachment({
      entityType: 'receipt',
      entityId: randomUUID(),
      fileName: 'note.txt',
      contentType: 'text/plain',
      body: Buffer.from('to be deleted'),
      uploadedBy: uploaderId,
    });
    const row = (await db.query.attachments.findFirst({ where: eq(attachments.id, id) }))!;

    await expect(
      deleteAttachment(id, { id: strangerId, permissions: new Set() }),
    ).rejects.toSatisfy((err) => err instanceof AttachmentDeleteError && err.code === 'forbidden');

    await deleteAttachment(id, { id: uploaderId, permissions: new Set() });
    expect(await db.query.attachments.findFirst({ where: eq(attachments.id, id) })).toBeUndefined();
    await expect(getStorage().get(row.storageKey)).rejects.toThrow();
  });
});
