import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: 'ok', db: 'up' });
  } catch {
    return Response.json({ status: 'degraded', db: 'down' }, { status: 503 });
  }
}
