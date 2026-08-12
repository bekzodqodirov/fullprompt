import { timingSafeEqual } from 'node:crypto';

/**
 * Every other advertising platform, one door (round 86b).
 *
 * Round 83 shipped Meta's own webhook, the public form and the bot. What was
 * left is the platforms whose lead form posts to a URL WE choose: Google Ads
 * lead form extensions (which is also how a YouTube lead form arrives, since
 * YouTube adverts are Google Ads adverts), TikTok through a connector, and the
 * owner's own website. They differ in exactly two ways — where they put the
 * shared secret, and what they call the fields — so they get one endpoint with
 * two readers rather than an integration each.
 *
 * Everything decidable without the network is decided HERE, pure and
 * unit-tested; the route is a thin shell, the way `meta-leads.ts` is to its.
 *
 * NOTE ON THE UNIVERSAL DOOR: none of this is needed to advertise on a
 * platform. `/ariza?manba=tiktok` works the day it deploys and needs no
 * account, approval or key from anybody. This exists for the case where the
 * customer never leaves the app — the platform's own in-feed form.
 */

export interface InboundFields {
  name: string | null;
  phone: string | null;
  note: string | null;
  /** The sender's own id for this lead, when it has one — the retry fence. */
  externalId: string | null;
  /** The unrecognised questions as PAIRS — the tarjimon's raw material. */
  fields: { key: string; value: string }[];
}

/**
 * Google's own field ids. Their lead form posts
 * `user_column_data: [{column_id, string_value}]`, and the ids are Google's,
 * not the advertiser's — unlike Meta, where the question names come from
 * whoever built the form.
 */
const GOOGLE_NAME = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME'];

/**
 * A stranger's JSON → the three things we need.
 *
 * Two shapes, tried in order, because a platform sends what it sends:
 *
 *  - **Google Ads** (`user_column_data`), which also covers YouTube.
 *  - **Plain** `{name, phone, note}` — what a website's own backend, Zapier,
 *    Make or a hand-written curl will send, and the shape documented for
 *    anybody else.
 *
 * Nothing here may throw on any input. A question we do not recognise is kept
 * in the note rather than dropped: «what did they actually ask for» is the
 * first thing the seller wants, and the second thing the form was for.
 */
export function parseInboundPayload(body: unknown): InboundFields {
  const google = asArray(pick(body, 'user_column_data'));
  if (google.length > 0) return fromGoogle(google, body);
  return fromPlain(body);
}

function fromGoogle(columns: unknown[], body: unknown): InboundFields {
  let full: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let phone: string | null = null;
  const extras: string[] = [];
  const fields: { key: string; value: string }[] = [];

  for (const column of columns) {
    const id = (str(pick(column, 'column_id')) ?? '').toUpperCase();
    const value = str(pick(column, 'string_value'));
    if (!value) continue;
    if (id === 'FULL_NAME') full ??= value;
    else if (id === 'FIRST_NAME') first ??= value;
    else if (id === 'LAST_NAME') last ??= value;
    else if (id.includes('PHONE')) phone ??= value;
    else if (!GOOGLE_NAME.includes(id)) {
      extras.push(`${id.toLowerCase()}: ${value}`);
      fields.push({ key: id.toLowerCase(), value });
    }
  }

  const joined = [first, last].filter(Boolean).join(' ').trim();
  return {
    name: full ?? (joined || null),
    phone,
    note: extras.length ? extras.join('\n') : null,
    // Google's own lead id, so its retries land on one lead.
    externalId: str(pick(body, 'lead_id')),
    fields,
  };
}

/**
 * The names a shared secret travels under. They are in `known` because
 * `secretFrom` READS the secret from these very body keys — so until round 97
 * a sender authenticating in the body had its key copied into the lead's
 * lenta note as «key: …», where `refWithoutSecret`'s fence never reaches.
 * The same names, the same case-insensitivity, in both fences.
 */
const SECRET_BODY_KEYS = ['google_key', 'key', 'secret', 'token'];

function fromPlain(body: unknown): InboundFields {
  const extras: string[] = [];
  const fields: { key: string; value: string }[] = [];
  // Anything the sender added beyond the three we name is kept, exactly as the
  // Meta reader keeps an unrecognised question — EXCEPT the secret's own keys.
  const known = new Set([
    'name',
    'ism',
    'phone',
    'telefon',
    'note',
    'izoh',
    'id',
    'external_id',
    ...SECRET_BODY_KEYS,
  ]);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (known.has(key.toLowerCase())) continue;
      const text = str(value);
      if (text) {
        extras.push(`${key}: ${text}`);
        fields.push({ key, value: text });
      }
    }
  }
  const note = str(pick(body, 'note')) ?? str(pick(body, 'izoh'));
  return {
    name: str(pick(body, 'name')) ?? str(pick(body, 'ism')),
    phone: str(pick(body, 'phone')) ?? str(pick(body, 'telefon')),
    note: [note, extras.join('\n')].filter(Boolean).join('\n') || null,
    externalId: str(pick(body, 'external_id')) ?? str(pick(body, 'id')),
    fields,
  };
}

/**
 * Where the sender put the secret.
 *
 * Google Ads puts `google_key` IN THE BODY — its lead form extension has no
 * way to set a header — while everything else can send one, so both are
 * accepted. Reading the body is not a weakness here: the whole endpoint is a
 * shared secret over TLS either way, and refusing Google's shape would mean
 * refusing Google.
 */
export function secretFrom(body: unknown, header: string | null): string | null {
  const fromHeader = (header ?? '').trim();
  if (fromHeader) return fromHeader;
  return str(pick(body, 'google_key')) ?? str(pick(body, 'key'));
}

/**
 * Constant-time compare that cannot throw.
 *
 * `timingSafeEqual` THROWS on a length mismatch, and an unhandled throw in a
 * webhook is a 500 — which every platform here reads as «send it again»
 * (#602). Length is checked first and every early return is a plain false.
 * An absent expected secret is false, never «matches nothing»: the caller
 * 404s on an unconfigured door, and this is the second fence behind it.
 */
export function secretMatches(sent: string | null, expected: string | null): boolean {
  if (!sent || !expected) return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The payload, minus the secret, for `lead_intakes.ref`.
 *
 * Keeping the whole body is right — a platform we have never seen still leaves
 * a trail somebody can follow — but Google puts the KEY in that body, so
 * storing it verbatim would write the shared secret into a table the arrivals
 * screen reads and into every nightly backup, where it can never be taken
 * back. The names are dropped case-insensitively, because the sender chooses
 * the spelling and a secret that survives on a capital letter is not dropped.
 */
export function refWithoutSecret(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (['google_key', 'key', 'secret', 'token'].includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Meta's advert surface → one of our source keys.
 *
 * Round 83 recorded every Meta lead as `meta` because the WEBHOOK payload does
 * not say which surface the advert ran on — and stated that telling them apart
 * needs the Graph. It does not: the lead object itself carries `platform`, so
 * the read that already happens can ask for it. Instagram and Facebook are
 * different adverts with different money behind them, and `funnelReport` is
 * the one screen that answers which is worth paying for.
 *
 * Unrecognised or absent stays `meta` — the honest answer is still «a Meta
 * advert», and guessing would put a lie into that same report.
 */
export function metaSourceKey(platform: unknown): 'instagram' | 'facebook' | 'meta' {
  const value = (str(platform) ?? '').toLowerCase();
  if (value === 'ig' || value === 'instagram') return 'instagram';
  if (value === 'fb' || value === 'facebook') return 'facebook';
  return 'meta';
}

// --- the smallest possible shape readers ------------------------------------

function pick(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}
