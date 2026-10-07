import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { basisConflicts } from '@/modules/wms/calc/basis';
import { isBazaBasis, type BazaBasis } from '@/modules/wms/calc/pricing';
import { customsImportBatches } from '@/modules/platform/db/schema';
import { BASIS_FOR_UNIT, suggestImportBaza } from '@/modules/wms/customs/import-baza';
import { readPickerItem } from '@/modules/wms/customs/picker-item';

/**
 * «Bu kod uchun importda nima bor?» — the picker behind the 📥 chip.
 *
 * It takes an ITEM id and, since 0125, at most one more word: the basis the
 * VED has CHOSEN on the screen (drafted, not yet saved). The name, the code,
 * the count, the weight and the volume are still read off the row itself —
 * by `readPickerItem`, the one read this route shares with the statistics
 * route so the two can never describe different rows (#513). A browser that
 * could pass its own search terms would be a free text search over the whole
 * customs dump behind a calc-screen door. The basis is a validated enum and
 * can only REORDER and LABEL what this row's code already holds — the price
 * a pick lands with is re-read from the file by `saveTable`, never taken
 * from here.
 *
 * The door is the workspace's own grant (`ved.docs`); this app has no
 * middleware, so every /api route states it (#721-726).
 */
export async function GET(request: Request) {
  try {
    await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const params = new URL(request.url).searchParams;
  const itemId = params.get('item') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ error: 'bad_item' }, { status: 400 });
  // Anything off the list is simply not a choice — the row's own answers.
  const drafted = params.get('basis');
  const draftedBasis: BazaBasis | null = isBazaBasis(drafted) ? drafted : null;

  try {
    const item = await readPickerItem(itemId, draftedBasis);
    if (!item) return Response.json({ error: 'not_found' }, { status: 404 });
    // No code, no question: the file is keyed on the code and a name search
    // across every declaration is not what he asked for.
    // WHY there is nothing to show is four different sentences, and the
    // screen used to have to guess from a null batch id — so on deploy
    // morning it told the admin to go and upload a quarter file, which is
    // exactly what he cannot do until the migration has run.
    if (!item.code) return Response.json({ state: 'no_code', candidates: [], batchId: null, total: 0 });

    const sug = await suggestImportBaza(
      {
        tnvedCode: item.code,
        name: item.name,
        units: item.units,
        weightPerUnitKg: item.perPiece,
      },
      // The picker lists more than the auto-fill ranks, and answers even
      // when the typed name is too short to score — «Лак» is a real product.
      // `named` adds C1's name-matched series, riding the same scan (D4).
      { picker: true, named: true },
    );
    if (!sug.batchId) {
      return Response.json({ state: 'no_batch', candidates: [], batchId: null, total: 0 });
    }
    // Which quarter he is choosing from. A batch whose period never parsed
    // falls back to its file name — the column is NOT NULL.
    const [batch] = await db
      .select({
        fileName: customsImportBatches.fileName,
        periodFrom: customsImportBatches.periodFrom,
        periodTo: customsImportBatches.periodTo,
      })
      .from(customsImportBatches)
      .where(eq(customsImportBatches.id, sug.batchId))
      .limit(1);
    return Response.json(
      {
        state: 'ok',
        // A declaration in a unit this code's law cannot hold (a pair unit on
        // a juft/litr/m² code) is LISTED — the VED should see the file has it
        // — but cannot be picked: it would land the row in a conflict.
        candidates: sug.candidates.map((c) => ({
          ...c,
          pickable: !basisConflicts(item.dutyUnit, BASIS_FOR_UNIT[c.unit]),
        })),
        batchId: sug.batchId,
        total: sug.total,
        itemName: item.name,
        tnvedCode: item.code,
        lawUnit: item.dutyUnit,
        // What the row is looking for, in the basis vocabulary — the dialog
        // names it as an expectation, never as a fact about the row.
        wants: item.units.map((u) => BASIS_FOR_UNIT[u]),
        source:
          batch?.periodFrom && batch?.periodTo
            ? `${batch.periodFrom} … ${batch.periodTo}`
            : (batch?.fileName ?? null),
        // C1's second series. The dialog compares `batchId` with the stats
        // answer's and drops this series when a batch turned READY between
        // the two fetches (statsNamedStale).
        named: sug.named ?? null,
        namedState: sug.namedState ?? null,
        minSim: sug.minSim ?? null,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (err) {
    // Deploy morning: 0094's tables may not exist yet (#472). The picker
    // says «nothing», the screen keeps working, the number stays the VED's.
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] import-baza: server behind');
      return Response.json({ state: 'behind', candidates: [], batchId: null, total: 0 });
    }
    throw err;
  }
}
