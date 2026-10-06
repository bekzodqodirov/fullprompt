import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { calcRegistrySight } from '@/modules/wms/calc/control-scope';
import { isRegistryRequest } from '@/modules/wms/calc/chain';
import { calcSheetsForRequest, requestGoodsSheet } from '@/modules/wms/calc/sheet';

/**
 * «Tovarlar ▾» on a history row (the owner's 7a) — fetched on the first open
 * of the fold, never eagerly: 200 rows of sheets is ~8 000 hidden nodes on a
 * phone, round 68's /stock lesson.
 *
 * The door is the registry's own (`calcRegistrySight` — the accountant, the
 * admins, the VED), and the route answers ONLY for a request the registry
 * lists: a sealed version or a Готово answer (review access-money-21). An
 * open, handed-back or never-priced job is on no screen the accountant can
 * open, so a route that took any id would be the #514 back door into goods
 * and bazas no list of his shows. Not found and not a registry row read the
 * same 404.
 *
 * What it returns is the sheet projection, which structurally carries no
 * client price (law 4) and no internal note (9a):
 *   - a SEALED version — the snapshot's groups as sealed (`CalcSheet`);
 *   - an ANSWER — the request's own rows (`CalcGoodsSheet`), with no
 *     per-group rastamojka.
 *
 * This app has no middleware, so every /api route states its door
 * (#721-726); `private, no-store` because a sheet is a per-reader answer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const actor = await getActor();
  if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const sight = calcRegistrySight(actor);
  if (!sight) return Response.json({ error: 'forbidden' }, { status: 403 });

  const { requestId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return Response.json({ error: 'not_found' }, { status: 404 });

  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    if (!(await isRegistryRequest(requestId))) {
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    }
    const sealed = await calcSheetsForRequest(requestId, sight);
    if (sealed) return Response.json({ kind: 'sealed', sheet: sealed }, { headers });
    const goods = await requestGoodsSheet(requestId, sight);
    return Response.json({ kind: 'answer', sheet: goods }, { headers });
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, requestId }, '[calc-registry] goods: server behind');
    return Response.json({ error: 'server_behind' }, { status: 503, headers });
  }
}
