import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/modules/platform/db/client';
import { clients, crates, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { crateContents } from '@/modules/wms/crates/service';
import { qrSvg } from '@/modules/wms/labels/sheet';
import { warehouseLocalDate } from '@/modules/wms/codes';
import { CrateLabelSvg } from '@/components/label-svg';
import { PrintSheet } from '@/components/print-sheet';

/**
 * The crate sticker, as a page the phone can print.
 *
 * The crate screen was the one label link that never got the share sheet
 * (#224) — it stayed a plain `<a href=…pdf>`, which in the installed app is
 * still the viewer with no buttons. It gets both routes now, like the boxes.
 */
export default async function PrintCrateLabelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');

  const rows = await db
    .select({ crate: crates, clientCode: clients.clientCode, wh: warehouses })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(eq(crates.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) notFound();
  if (!actor.permissions.has('crates.manage')) redirect('/');
  if (!inScope(actor, hit.crate.warehouseId)) notFound();

  const contents = await crateContents(id);
  const { yy, mm, dd } = warehouseLocalDate(hit.crate.createdAt, hit.wh.timezone);
  const dims =
    hit.crate.lengthCm && hit.crate.widthCm && hit.crate.heightCm
      ? `${hit.crate.lengthCm}×${hit.crate.widthCm}×${hit.crate.heightCm} cm`
      : null;

  const label = {
    warehouseCode: hit.wh.code,
    dateLocal: `${dd}.${mm}.20${yy}`,
    code: hit.crate.code,
    clientCode: hit.clientCode,
    kind: hit.crate.kind,
    boxCount: contents.reduce((acc, c) => acc + c.count, 0),
    contents: contents.map((c) => `${c.letter}×${c.count}`).join(', '),
    weightKg: hit.crate.weightKg,
    dimsCm: dims,
  };
  const qr = await qrSvg(hit.crate.code);

  return (
    <>
      <PrintSheet
        pdfHref={`/api/crates/${id}/label`}
        recordHref={`/api/crates/${id}/label/printed`}
        backHref={`/crates/${id}`}
        fileName={hit.crate.code}
        count={1}
      />
      <div className="label-frame">
        <CrateLabelSvg label={label} qr={qr} />
      </div>
    </>
  );
}
