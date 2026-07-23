import { z } from 'zod';
import { requireActor, AuthError } from '@/modules/platform/rbac/authorize';
import { FileValidationError, saveAttachment } from '@/modules/platform/files/service';

const metaSchema = z.object({
  entityType: z.string().min(1).max(50),
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
