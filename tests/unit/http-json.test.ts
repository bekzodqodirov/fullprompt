import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { json } from '@/modules/platform/http/json';

/**
 * The wire this helper exists for is China → Europe (round 110): the scan
 * screens re-read their snapshot every 15 seconds, Next does not compress a
 * Route Handler's own response, and nothing asked whether the answer had
 * even changed.
 */

const req = (headers: Record<string, string> = {}) =>
  new Request('http://x/api/thing', { headers });

/** A body over MIN_GZIP that a real payload's repetition resembles. */
const big = { boxes: Array.from({ length: 200 }, (_, i) => ({ code: `YW26-${i}`, status: 'planned' })) };

describe('json()', () => {
  it('gzips when the caller accepts it, and the bytes decode to the same JSON', async () => {
    const res = await json(req({ 'accept-encoding': 'gzip, deflate, br' }), big);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    const packed = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(gunzipSync(packed).toString())).toEqual(big);
    // The saving is the whole point — assert it is real, not just present.
    expect(packed.byteLength).toBeLessThan(JSON.stringify(big).length / 5);
    expect(Number(res.headers.get('content-length'))).toBe(packed.byteLength);
  });

  it('sends plain JSON to a caller that did not ask for gzip', async () => {
    const cases: Record<string, string>[] = [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'br' }];
    for (const h of cases) {
      const res = await json(req(h), big);
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.json()).toEqual(big);
    }
  });

  it('leaves a small body alone — the header would cost more than the saving', async () => {
    const res = await json(req({ 'accept-encoding': 'gzip' }), { ok: true });
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('answers 304 with no body when the caller already has this exact payload', async () => {
    const first = await json(req({ 'accept-encoding': 'gzip' }), big);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    const again = await json(req({ 'accept-encoding': 'gzip', 'if-none-match': etag }), big);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('a changed payload is a changed tag, and gets a body', async () => {
    const first = await json(req(), big);
    const changed = await json(req({ 'if-none-match': first.headers.get('etag')! }), {
      ...big,
      boxes: [...big.boxes, { code: 'YW26-new', status: 'loading' }],
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });

  it('matches a tag a proxy has rewritten, and one inside a list', async () => {
    const first = await json(req(), big);
    const etag = first.headers.get('etag')!;
    // Apache and several CDNs append `-gzip` to a tag they re-encoded; a bare
    // string compare then says "changed" about a body that did not.
    const suffixed = etag.replace(/"$/, '-gzip"');
    expect((await json(req({ 'if-none-match': suffixed }), big)).status).toBe(304);
    expect((await json(req({ 'if-none-match': `W/"other", ${etag}` }), big)).status).toBe(304);
    expect((await json(req({ 'if-none-match': '*' }), big)).status).toBe(304);
    expect((await json(req({ 'if-none-match': 'W/"stale"' }), big)).status).toBe(200);
  });
});
