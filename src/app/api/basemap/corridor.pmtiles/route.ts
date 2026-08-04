import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { basemapPath } from '@/modules/wms/tracking/basemap';

/**
 * Serves the self-hosted OSM basemap (PMTiles). The pmtiles reader fetches
 * small byte ranges, so Range support is mandatory — Next's static /public
 * serving doesn't guarantee it, hence this route. Public OSM data → no auth,
 * long cache.
 */
export async function GET(request: Request) {
  const path = basemapPath();
  if (!existsSync(path)) return new Response('basemap not installed', { status: 404 });
  const size = statSync(path).size;

  const range = request.headers.get('range');
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': 'application/octet-stream',
    'cache-control': 'public, max-age=86400',
  };

  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start <= end && start < size) {
        const stream = createReadStream(path, { start, end });
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            ...headers,
            'content-range': `bytes ${start}-${end}/${size}`,
            'content-length': String(end - start + 1),
          },
        });
      }
    }
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }

  const stream = createReadStream(path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, 'content-length': String(size) },
  });
}
