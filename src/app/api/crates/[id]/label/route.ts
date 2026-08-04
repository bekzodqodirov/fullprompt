import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, crates, warehouses } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { crateContents } from '@/modules/wms/crates/service';
import { renderCrateLabel } from '@/modules/wms/labels/renderer';
import { warehouseLocalDate } from '@/modules/wms/codes';

/** 100×100 mm crate label PDF (spec 6.2). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db
    .select({ crate: crates, clientCode: clients.clientCode, wh: warehouses })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(eq(crates.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) return new Response('Not found', { status: 404 });

  let actor;
  try {
    actor = await authorize('crates.manage', { warehouseId: hit.crate.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const contents = await crateContents(id);
  const boxCount = contents.reduce((acc, c) => acc + c.count, 0);
  const { yy, mm, dd } = warehouseLocalDate(hit.crate.createdAt, hit.wh.timezone);
  const dims =
    hit.crate.lengthCm && hit.crate.widthCm && hit.crate.heightCm
      ? `${hit.crate.lengthCm}×${hit.crate.widthCm}×${hit.crate.heightCm} cm`
      : null;

  const pdf = await renderCrateLabel({
    warehouseCode: hit.wh.code,
    dateLocal: `${dd}.${mm}.20${yy}`,
    code: hit.crate.code,
    clientCode: hit.clientCode,
    kind: hit.crate.kind,
    boxCount,
    contents: contents.map((c) => `${c.letter}×${c.count}`).join(', '),
    weightKg: hit.crate.weightKg,
    dimsCm: dims,
  });

  const meta = await requestMeta();
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: hit.crate.warehouseId }, {
    entityType: 'crate',
    entityId: id,
    action: 'label_print',
    after: { code: hit.crate.code },
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${hit.crate.code}.pdf"`,
    },
  });
}
