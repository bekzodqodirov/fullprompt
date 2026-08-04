import { z } from 'zod';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { suggestProducts, translateZh } from '@/modules/platform/translation/service';

const querySchema = z.object({
  zh: z.string().max(300).optional(),
  suggest: z.string().max(300).optional(),
});

export async function GET(request: Request) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const url = new URL(request.url);
  const params = querySchema.safeParse({
    zh: url.searchParams.get('zh') ?? undefined,
    suggest: url.searchParams.get('suggest') ?? undefined,
  });
  if (!params.success) return Response.json({ error: 'validation' }, { status: 400 });

  if (params.data.suggest !== undefined) {
    return Response.json({ suggestions: await suggestProducts(params.data.suggest) });
  }
  if (params.data.zh !== undefined) {
    return Response.json(await translateZh(params.data.zh));
  }
  return Response.json({ error: 'validation' }, { status: 400 });
}
