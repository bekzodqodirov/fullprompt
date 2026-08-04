import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The PMTiles reader fetches byte ranges — the serving route must implement
 * HTTP Range correctly or the real map silently fails to render.
 */

const dir = mkdtempSync(join(tmpdir(), 'basemap-'));
const file = join(dir, 'corridor.pmtiles');
const BYTES = Buffer.from('0123456789abcdef'); // 16 bytes

let GET: (req: Request) => Promise<Response>;

beforeAll(async () => {
  writeFileSync(file, BYTES);
  process.env.BASEMAP_PATH = file;
  ({ GET } = await import('@/app/api/basemap/corridor.pmtiles/route'));
});

afterAll(() => {
  delete process.env.BASEMAP_PATH;
});

describe('basemap range serving', () => {
  it('serves the whole file without a Range header', async () => {
    const res = await GET(new Request('http://x/api/basemap/corridor.pmtiles'));
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('0123456789abcdef');
  });

  it('serves a middle range with 206 + content-range', async () => {
    const res = await GET(
      new Request('http://x/api/basemap/corridor.pmtiles', { headers: { range: 'bytes=4-7' } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 4-7/16');
    expect(res.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('4567');
  });

  it('clamps an open-ended range to the file end', async () => {
    const res = await GET(
      new Request('http://x/api/basemap/corridor.pmtiles', { headers: { range: 'bytes=10-' } }),
    );
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('abcdef');
  });

  it('rejects an out-of-bounds range with 416', async () => {
    const res = await GET(
      new Request('http://x/api/basemap/corridor.pmtiles', { headers: { range: 'bytes=99-120' } }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */16');
  });

  it('404s when the basemap is not installed', async () => {
    process.env.BASEMAP_PATH = join(dir, 'missing.pmtiles');
    const res = await GET(new Request('http://x/api/basemap/corridor.pmtiles'));
    expect(res.status).toBe(404);
    process.env.BASEMAP_PATH = file;
  });
});
