import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isPermanentGraphError,
  leadgenEventsFrom,
  mapFieldData,
  metaConfig,
  verifyMetaSignature,
} from '@/modules/wms/crm/meta-leads';

/**
 * Everything about Meta's webhook that can be decided without a network.
 *
 * Which is nearly all of it, and that is the point: the route handler cannot
 * be exercised here — it needs Meta's own signature over Meta's own bytes —
 * so the parts that can be wrong live in a pure module and are asked directly.
 */

const SECRET = 'sekret';
const sign = (raw: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;

describe('the config fails CLOSED', () => {
  it('is null unless all three secrets are there', () => {
    expect(metaConfig({})).toBeNull();
    expect(metaConfig({ META_APP_SECRET: 'a', META_VERIFY_TOKEN: 'b' })).toBeNull();
    // Blank is not configured — an empty variable in a .env is the shape a
    // half-finished setup actually takes.
    expect(
      metaConfig({
        META_APP_SECRET: 'a',
        META_VERIFY_TOKEN: '  ',
        META_PAGE_TOKEN: 'c',
      }),
    ).toBeNull();
    expect(
      metaConfig({
        META_APP_SECRET: 'a',
        META_VERIFY_TOKEN: 'b',
        META_PAGE_TOKEN: 'c',
      }),
    ).toEqual({ appSecret: 'a', verifyToken: 'b', pageToken: 'c' });
  });

  it('never lets an unconfigured server say «yes, that is me»', () => {
    // The whole reason the route 404s on null: with no verify token, an
    // unguarded handler would compare `undefined === undefined` against a
    // caller who also sent nothing, agree, and hand over the subscription.
    const empty = metaConfig({});
    expect(empty?.verifyToken).toBeUndefined();
    expect(empty).toBeNull();
  });
});

describe('the signature', () => {
  const raw = '{"object":"page","entry":[]}';

  it('accepts what Meta actually signed', () => {
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it('refuses a body that was re-serialised on the way in', () => {
    // The trap this codebase is protected from by reading `request.text()`:
    // JSON.stringify picks its own spacing and key order, so a signature over
    // the original bytes cannot match a signature over the round-trip.
    const round = JSON.stringify(JSON.parse('{"object":"page",  "entry":[]}'));
    expect(verifyMetaSignature(round, sign('{"object":"page",  "entry":[]}'), SECRET)).toBe(false);
  });

  it('refuses another app’s secret, and says so without throwing', () => {
    expect(verifyMetaSignature(raw, sign(raw, 'boshqa'), SECRET)).toBe(false);
  });

  it('survives every malformed header instead of crashing', () => {
    // `timingSafeEqual` THROWS on a length mismatch, and an unhandled throw in
    // a webhook is a 500 — which Meta reads as «send it again».
    for (const header of [
      null,
      '',
      'sha256=',
      'sha1=abcd',
      'abcd',
      'sha256=zz',
      `sha256=${'a'.repeat(64)}`,
    ]) {
      expect(() => verifyMetaSignature(raw, header, SECRET)).not.toThrow();
      expect(verifyMetaSignature(raw, header, SECRET)).toBe(false);
    }
  });
});

describe('reading a webhook body', () => {
  it('finds every leadgen change in a batched delivery', () => {
    const events = leadgenEventsFrom({
      object: 'page',
      entry: [
        {
          id: '111',
          changes: [
            { field: 'leadgen', value: { leadgen_id: 'L1', form_id: 'F1', ad_id: 'A1' } },
            { field: 'messages', value: { mid: 'm1' } },
          ],
        },
        {
          id: '222',
          changes: [{ field: 'leadgen', value: { leadgen_id: 'L2', page_id: '999' } }],
        },
      ],
    });
    expect(events.map((e) => e.leadgenId)).toEqual(['L1', 'L2']);
    // The page id falls back to the entry's own id, which is where Meta puts
    // it when the change value does not repeat it.
    expect(events[0]!.pageId).toBe('111');
    expect(events[1]!.pageId).toBe('999');
  });

  it('answers with nothing rather than throwing on any shape', () => {
    // A webhook that throws is a webhook that gets retried for ever.
    for (const body of [null, undefined, 42, 'x', {}, { entry: 'no' }, { entry: [null] }]) {
      expect(leadgenEventsFrom(body)).toEqual([]);
    }
    expect(leadgenEventsFrom({ entry: [{ changes: [{ field: 'leadgen', value: {} }] }] })).toEqual(
      [],
    );
  });
});

describe('the advert form’s answers', () => {
  it('takes the name and the phone whatever the form called them', () => {
    const fields = mapFieldData([
      { name: 'full_name', values: ['Aziz Karimov'] },
      { name: 'phone_number', values: ['+998901234567'] },
    ]);
    expect(fields).toEqual({ name: 'Aziz Karimov', phone: '+998901234567', note: null });
  });

  it('joins a split name', () => {
    const fields = mapFieldData([
      { name: 'first_name', values: ['Aziz'] },
      { name: 'last_name', values: ['Karimov'] },
      { name: 'work_phone_number', values: ['998901234567'] },
    ]);
    expect(fields.name).toBe('Aziz Karimov');
    expect(fields.phone).toBe('998901234567');
  });

  it('keeps a question nobody here has heard of', () => {
    // The adverts are run by him AND by an agency, so the forms are not ours
    // to predict. «What did they ask for» is the first thing the seller wants.
    const fields = mapFieldData([
      { name: 'full_name', values: ['Dilnoza'] },
      { name: 'qanday_yuk', values: ['2 kub kiyim'] },
      { name: 'email', values: ['d@example.com'] },
    ]);
    expect(fields.note).toContain('qanday_yuk: 2 kub kiyim');
    expect(fields.note).toContain('email: d@example.com');
  });

  it('answers three nulls rather than throwing on rubbish', () => {
    expect(mapFieldData(null)).toEqual({ name: null, phone: null, note: null });
    expect(mapFieldData([{ name: 'phone', values: [] }])).toEqual({
      name: null,
      phone: null,
      note: null,
    });
  });
});

describe('when to stop asking Graph', () => {
  it('retries a rate limit and a bad day', () => {
    expect(isPermanentGraphError(429, {})).toBe(false);
    expect(isPermanentGraphError(500, {})).toBe(false);
    expect(isPermanentGraphError(400, { error: { code: 4 } })).toBe(false);
    expect(isPermanentGraphError(400, { error: { code: 613 } })).toBe(false);
  });

  it('gives up on a lead Meta will not hand over', () => {
    // A deleted lead and a revoked page token both need a person, not another
    // attempt every few minutes until somebody reads the log.
    expect(isPermanentGraphError(400, { error: { code: 100 } })).toBe(true);
    // 190 = the page token has expired or been revoked. It arrives as a 400,
    // and no number of retries will produce a new token.
    expect(isPermanentGraphError(400, { error: { code: 190 } })).toBe(true);
    expect(isPermanentGraphError(403, {})).toBe(true);
    expect(isPermanentGraphError(404, null)).toBe(true);
  });
});
