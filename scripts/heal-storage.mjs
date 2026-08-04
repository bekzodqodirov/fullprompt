/**
 * One-shot repair: photos uploaded while the standalone-server storage bug
 * was live landed inside .next/standalone/.data — merge them back into the
 * real storage dir (never overwrites). Safe to run on every start.
 */
import 'dotenv/config';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.env.STORAGE_LOCAL_DIR ?? '.data/files');
const stranded = path.resolve('.next/standalone/.data/files');
if (existsSync(stranded) && stranded !== target) {
  cpSync(stranded, target, { recursive: true, force: false });
}
