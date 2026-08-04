/**
 * Storage doctor: verifies every attachment row actually has its file on
 * disk. Run with `pnpm check:files`. Prints the resolved storage dir, totals,
 * and which files are missing (grouped by upload date) so we can tell a
 * config problem apart from lost bytes.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const dir = path.resolve(process.env.STORAGE_LOCAL_DIR ?? '.data/files');
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev');

const filePath = (key) => {
  const safe = createHash('sha256').update(key).digest('hex');
  return path.join(dir, safe.slice(0, 2), safe);
};

const rows = await sql`
  select id, storage_key, thumb_200_key, file_name, entity_type, created_at
  from attachments order by created_at
`;

let okCount = 0;
const missing = [];
for (const row of rows) {
  if (existsSync(filePath(row.storage_key))) okCount += 1;
  else missing.push(row);
}

console.log(`Storage dir : ${dir} ${existsSync(dir) ? '(mavjud)' : '(YO‘Q!)'}`);
console.log(`Jami fayl   : ${rows.length}`);
console.log(`Joyida      : ${okCount}`);
console.log(`Yo‘qolgan   : ${missing.length}`);
if (missing.length) {
  const byDay = new Map();
  for (const row of missing) {
    const day = row.created_at.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  console.log('\nYo‘qolganlar kunlar bo‘yicha:');
  for (const [day, n] of byDay) console.log(`  ${day}: ${n} ta`);
  console.log('\nBirinchi 5 tasi:');
  for (const row of missing.slice(0, 5)) {
    console.log(`  ${row.created_at.toISOString().slice(0, 16)} ${row.entity_type} ${row.file_name}`);
  }
}
await sql.end();
