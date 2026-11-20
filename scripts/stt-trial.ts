import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { attachments, tgMessageFlags, tgMessages } from '../src/modules/platform/db/schema';
import { getStorage } from '../src/modules/platform/files/storage';

/**
 * The speech trial's reader (his answer 13 a; docs/ai-toliq/qurish/STAGE-0-1A.md
 * §4.0 (c); the protocol is docs/ai-toliq/critic-stt.md §4, unchanged). It sends
 * customers' stored voice notes to ONE speech service and prints what came back,
 * so the trial is measured on his own notes and not on a vendor's benchmark:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/stt-trial.ts --ids <file.json> --provider <name> [--out <file>]
 *
 * and in practice, from the folder that holds docker-compose.yml ON THE
 * PRODUCTION SERVER — reachability from there (a German address) is one of the
 * things the trial tests, so a laptop in Tashkent proves nothing:
 *
 *   mkdir -p .data/stt    # the lead's ids.json goes in here
 *   docker compose run --rm -v "$PWD/.data/stt:/stt" migrate \
 *     pnpm exec tsx scripts/stt-trial.ts --ids /stt/ids.json --provider elevenlabs --out /stt/elevenlabs.json
 *   …  --provider openai --out /stt/openai.json
 *   …  --provider uz     --out /stt/uz.json
 *   …  --provider elevenlabs --lang uz --out /stt/elevenlabs-uz.json   # a pinned run, §4 «Run»
 *
 * The `-v` is not decoration: `migrate` mounts nothing and `--rm` throws the
 * container away with every file it wrote, so the ids must come in and the
 * results must go out through a folder of the host (docs/SAKKIZ-R5.md's
 * precedent) — under `.data/`, which is gitignored and already holds the
 * server's own data, so customers' transcripts never sit untracked in the
 * checkout. `migrate` has `.env`, the storage and `tsx`; never a
 * package.json command (#1228).
 *
 * READ-ONLY. The attachment rows are read in ONE transaction opened READ ONLY
 * and closed before the first byte goes out — a provider may take a minute,
 * and a transaction held across it would meet compose's
 * `idle_in_transaction_session_timeout=60s` and pin a snapshot on the live
 * database. Storage is only read. The one thing written is `--out`, a file in
 * the mounted folder, never the database or the object store.
 *
 * WHAT LEAVES, and nothing else: an INCOMING customer voice note — a
 * `tg_message` attachment, `audio/*`, named `voice_<msgId>.<ext>` (the name the
 * listener gives a voice note and nothing else), on a message whose direction
 * is 'in' and that the customer has not deleted. His permission (16.1) is for
 * customers' voice notes; a photo id pasted by mistake, an audio FILE the
 * customer sent (a forwarded call recording, an mp3), a call recording or our
 * own side's note is refused by name and never sent. Every provider gets the SAME bytes,
 * untranscoded (the image has no ffmpeg, critic §2); the one change is the NAME
 * — Telegram stores `voice_<id>.oga` and OpenAI decides the format by the
 * extension and lists `.ogg`, not `.oga` [critic §2, m], so the file goes as
 * `.ogg`, which is the same Ogg container. A sha256 prefix is printed per note
 * so the three result files can be shown to have scored the same bytes.
 *
 * KEYS come only from the environment — `.env` on the server, typed by HIM,
 * never in chat, the repo or a commit. A missing one is named and the run
 * stops (exit 2) before anything is read or sent; there is no default.
 *   elevenlabs  ELEVENLABS_API_KEY
 *   openai      OPENAI_API_KEY
 *   uz          STT_UZ_URL + STT_UZ_KEY, optional STT_UZ_HEADER and STT_UZ_FIELD
 * No key is ever printed; an error text a provider sends back is redacted
 * before it is shown or written (some echo the key they refused).
 *
 * «uz» is GENERIC on purpose. critic-stt.md §3 names Aisha first and Muxlisa
 * beside it, and pins no endpoint: neither docs page was reachable from the
 * session that wrote it. So the endpoint, the header and the form field are
 * read off the chosen service's own page when HE mints the key, and go into
 * `.env`: STT_UZ_URL (https; plain http only to a loopback address — a
 * customer's voice in clear text over the internet is not a trial), STT_UZ_KEY,
 * STT_UZ_HEADER (the header that carries the key as it is, e.g. x-api-key;
 * unset = `Authorization: Bearer <key>`), STT_UZ_FIELD (the multipart field
 * the audio goes in; unset = `file`). The answer is read by looking for a
 * `text` / `transcript` / `transcription` string, at the top or inside
 * `result` / `data`; a service that answers with a job id to poll is not
 * followed — its raw answer is printed so the lead sees its shape.
 *
 * UNVERIFIED: every endpoint, header, field and model name below is the
 * provider's own as read from critic-stt.md §2 (search extracts) and from
 * memory; this container cannot reach any provider, so none was called.
 * `--model` swaps a model name a provider has retired or renamed (OpenAI has
 * announced removals for 2027-02-26) without a deploy.
 *
 * One note at a time: the time per note is a MEASUREMENT (M8), and requests in
 * parallel would measure the provider's queue instead. One failure never stops
 * the rest; a note whose bytes cannot be read is «not sent», never counted
 * against the provider.
 */

const USAGE =
  'usage: pnpm exec tsx scripts/stt-trial.ts --ids <file.json> --provider elevenlabs|openai|uz ' +
  '[--lang auto|uz|ru] [--model <id>] [--out <file.json>]';

// ── the providers' own names (UNVERIFIED — see the header) ────────────────────

/** ElevenLabs Scribe — `xi-api-key` header, multipart `model_id` + `file`, optional `language_code`. */
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
/** critic §3's trial #1 is «Scribe v2»; a later model carries the mixed-language option (critic §2). */
const ELEVENLABS_MODEL = 'scribe_v2';
/** OpenAI — Bearer key, multipart `file` + `model`, optional `language`, `response_format=json`. */
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
/** critic §3's baseline; `whisper-1` / `gpt-4o-transcribe` are listed for removal (critic §2). */
const OPENAI_MODEL = 'gpt-transcribe';

/**
 * One round trip — the upload and the whole answer. M8's bar is 10 s for a
 * 60-s note; at 60 s a provider is no longer slow but absent, and the run moves on.
 */
const REQUEST_MS = 60_000;
/** The storage read has a deadline of its own: the S3 client has none (files/read-within.ts). */
const STORAGE_READ_MS = 30_000;
/**
 * The files service's cap on a non-photo (MAX_DOC_BYTES); a voice note is under
 * 20 MiB by `MAX_TG_AUDIO_BYTES`. A bigger object is not a voice note and is not held whole.
 */
const MAX_NOTE_BYTES = 25 * 1024 * 1024;
/** The protocol is 25 notes + 4 traps; a mistyped list of thousands must not be billed. */
const MAX_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A voice note's stored name, and only a voice note's: it carries no filename
 * attribute, so `tgMediaPlan` (crm/telegram-import.ts) names it
 * `voice_<msgId>.<ext>`, while an audio FILE keeps its sender's own name or
 * becomes `audio_<msgId>.<ext>`. The kind is not stored, so this name is the one
 * line between his permission (customers' voice notes) and a forwarded call
 * recording or an mp3 under the same `audio/*` — the same thing `mediaOf`
 * (agent/context.ts) reads it by.
 */
const VOICE_NOTE_NAME = /^voice_\d+\.[a-z0-9]+$/iu;

type ProviderName = 'elevenlabs' | 'openai' | 'uz';
type Lang = 'auto' | 'uz' | 'ru';

interface Args {
  ids: string;
  provider: ProviderName;
  lang: Lang;
  model: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args | null {
  let ids: string | null = null;
  let provider: ProviderName | null = null;
  let lang: Lang = 'auto';
  let model: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return null;
    i++;
    if (a === '--ids') ids = v;
    else if (a === '--out') out = v;
    else if (a === '--provider' && (v === 'elevenlabs' || v === 'openai' || v === 'uz')) provider = v;
    else if (a === '--lang' && (v === 'auto' || v === 'uz' || v === 'ru')) lang = v;
    // A model name goes into a form field and a printed line — nothing shaped like a path or a header.
    else if (a === '--model' && /^[A-Za-z0-9._:-]{1,80}$/u.test(v)) model = v;
    else return null;
  }
  if (!ids || !provider) return null;
  return { ids, provider, lang, model, out };
}

// ── keys and their redaction ──────────────────────────────────────────────────

const KEY_VARS = ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'STT_UZ_KEY'] as const;

/** Trimmed: a key typed into `.env` with a trailing space is still the key, and a header refuses the space. */
function envKey(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/** The exact keys out of any text — a provider may echo the one it refused. */
function redactKeys(s: string): string {
  let out = s;
  for (const name of KEY_VARS) {
    const k = envKey(name);
    if (k && k.length >= 6) out = out.split(k).join('[key]');
  }
  return out;
}

/**
 * STT_UZ_URL as a secret: whole (as typed and as normalised) and by each query
 * value — a service may take its token as `?key=…` under any name, and an error
 * text (undici's among them) may quote the address it was given. Longest first,
 * so the whole address goes before its pieces.
 */
function urlSecrets(): { whole: string[]; parts: string[] } {
  const raw = process.env.STT_UZ_URL?.trim();
  if (!raw) return { whole: [], parts: [] };
  const whole = [raw];
  const parts: string[] = [];
  try {
    const u = new URL(raw);
    whole.push(u.href);
    if (u.search.length > 1) parts.push(u.search.slice(1));
    for (const piece of u.search.slice(1).split('&')) {
      // No «=» → indexOf is −1 and the whole piece is the value: a bare `?<token>`.
      const v = piece.slice(piece.indexOf('=') + 1);
      parts.push(v);
      try {
        parts.push(decodeURIComponent(v.replace(/\+/gu, ' ')));
      } catch {
        // a malformed escape — the raw form above is the one an error would quote
      }
    }
  } catch {
    // not a URL — buildProvider refuses it before anything is read or sent
  }
  const byLength = (list: string[]) => [...new Set(list.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
  return { whole: byLength(whole), parts: byLength(parts) };
}

/**
 * Every text this script prints or writes about a FAILURE passes here: the exact
 * keys and STT_UZ_URL's secrets, then the shapes a key takes in somebody else's
 * error text. A transcript gets the exact keys only — it is the thing being
 * measured, and neither a pattern nor a query value that happens to be a word
 * may rewrite what a customer said.
 */
function redact(s: string): string {
  let out = redactKeys(s);
  const { whole, parts } = urlSecrets();
  for (const v of whole) out = out.split(v).join('[STT_UZ_URL]');
  for (const v of parts) out = out.split(v).join('[…]');
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gu, 'sk-[…]')
    .replace(/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 […]')
    .replace(/((?:api[_-]?key|xi-api-key|x-api-key|token|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/giu, '$1[…]');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A URL as printed: no user, no password, no query — STT_UZ_URL may carry a token in any of them. */
function shownUrl(u: URL): string {
  return `${u.origin}${u.pathname}`;
}

// ── the three providers behind one shape ─────────────────────────────────────

interface Heard {
  text: string;
  language: string | null;
}

interface Provider {
  name: ProviderName;
  url: URL;
  model: string | null;
  headers: Record<string, string>;
  form(file: Blob, fileName: string, lang: Lang): FormData;
  /** The transcript out of a 2xx answer; null = it answered, and nothing in it is a transcript. */
  read(answer: unknown): Heard | null;
}

const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The generic reader's transcript: a text key at this level, else inside a result/data object. */
function findText(v: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  for (const k of ['text', 'transcript', 'transcription']) {
    const s = str(field(v, k));
    if (s !== null) return s;
  }
  for (const k of ['result', 'data', 'response']) {
    const inner = field(v, k);
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const s = findText(inner, depth + 1);
      if (s !== null) return s;
    }
  }
  return null;
}

type Built = { ok: true; provider: Provider } | { ok: false; message: string };

function buildProvider(name: ProviderName, model: string | null): Built {
  const missing = (v: string): Built => ({
    ok: false,
    message: `.env da yo'q / missing: ${v} — the server's .env must carry it (typed there by the owner); nothing was read or sent.`,
  });

  if (name === 'elevenlabs') {
    const key = envKey('ELEVENLABS_API_KEY');
    if (!key) return missing('ELEVENLABS_API_KEY');
    const m = model ?? ELEVENLABS_MODEL;
    return {
      ok: true,
      provider: {
        name,
        url: new URL(ELEVENLABS_URL),
        model: m,
        headers: { 'xi-api-key': key },
        form(file, fileName, lang) {
          const f = new FormData();
          f.append('model_id', m);
          f.append('file', file, fileName);
          // Left out on «auto»: the protocol runs auto first and pins uz / ru as SEPARATE runs (critic §4 «Run»).
          if (lang !== 'auto') f.append('language_code', lang);
          return f;
        },
        read(answer) {
          const text = str(field(answer, 'text'));
          if (text === null) return null;
          const code = str(field(answer, 'language_code'));
          const p = field(answer, 'language_probability');
          return { text, language: code ? (typeof p === 'number' ? `${code} ${p.toFixed(2)}` : code) : null };
        },
      },
    };
  }

  if (name === 'openai') {
    const key = envKey('OPENAI_API_KEY');
    if (!key) return missing('OPENAI_API_KEY');
    const m = model ?? OPENAI_MODEL;
    return {
      ok: true,
      provider: {
        name,
        url: new URL(OPENAI_URL),
        model: m,
        headers: { Authorization: `Bearer ${key}` },
        form(file, fileName, lang) {
          const f = new FormData();
          f.append('file', file, fileName);
          f.append('model', m);
          f.append('response_format', 'json');
          if (lang !== 'auto') f.append('language', lang);
          return f;
        },
        read(answer) {
          const text = str(field(answer, 'text'));
          return text === null ? null : { text, language: str(field(answer, 'language')) };
        },
      },
    };
  }

  const rawUrl = process.env.STT_UZ_URL?.trim();
  if (!rawUrl) return missing('STT_UZ_URL');
  const key = envKey('STT_UZ_KEY');
  if (!key) return missing('STT_UZ_KEY');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: 'STT_UZ_URL is not a URL (its value is not printed — it may carry a token).' };
  }
  // fetch refuses an address with credentials and quotes it WHOLE in its refusal — a password printed and
  // written to --out. The secret has its own two variables; the address carries none.
  if (url.username || url.password) {
    return {
      ok: false,
      message: 'STT_UZ_URL carries a user or password — put the secret in STT_UZ_KEY (and its header in STT_UZ_HEADER); nothing was read or sent.',
    };
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, message: 'STT_UZ_URL must be https (plain http only to a loopback address) — a voice note is not sent in clear text.' };
  }
  const header = process.env.STT_UZ_HEADER?.trim() || null;
  if (header && !/^[A-Za-z0-9-]{1,64}$/u.test(header)) {
    return { ok: false, message: 'STT_UZ_HEADER must be a bare header name, e.g. x-api-key.' };
  }
  const fieldName = process.env.STT_UZ_FIELD?.trim() || 'file';
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(fieldName)) {
    return { ok: false, message: 'STT_UZ_FIELD must be a bare form-field name, e.g. audio.' };
  }
  return {
    ok: true,
    provider: {
      name,
      url,
      model,
      headers: header ? { [header]: key } : { Authorization: `Bearer ${key}` },
      form(file, fileName, lang) {
        const f = new FormData();
        f.append(fieldName, file, fileName);
        if (lang !== 'auto') f.append('language', lang);
        // Only when asked: a generic service may have no model field at all.
        if (model) f.append('model', model);
        return f;
      },
      read(answer) {
        const text = findText(answer);
        if (text === null) return null;
        return { text, language: str(field(answer, 'language')) ?? str(field(answer, 'language_code')) };
      },
    },
  };
}

// ── the note itself ──────────────────────────────────────────────────────────

/**
 * Collect one object from storage, bounded in bytes and in time. A stream and
 * not `get()`: the cap is enforced while reading, so an object that is not what
 * its row says is never held whole.
 */
async function readNote(storageKey: string): Promise<Buffer> {
  const held: { stream: Readable | null } = { stream: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`storage read took longer than ${STORAGE_READ_MS / 1000} s`)), STORAGE_READ_MS);
  });
  const read = (async () => {
    const stream = await getStorage().getStream(storageKey);
    held.stream = stream;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += b.length;
      if (total > MAX_NOTE_BYTES) throw new Error(`storage object is over ${MAX_NOTE_BYTES} bytes`);
      chunks.push(b);
    }
    return Buffer.concat(chunks, total);
  })();
  read.catch(() => undefined);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
    held.stream?.destroy();
  }
}

/**
 * RFC 7845's identification-header magic, spelled as bytes on purpose: the
 * codec shares its name with a model family, and no model name is written in
 * a pushed file (CLAUDE.md).
 */
const VOICE_HEAD_MAGIC = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);

/**
 * A voice note's length, read off its own Ogg pages — the duration is known at
 * download and NOT stored (`tgMediaPlan durationSec`, critic §5.6), and M8/M10
 * need a minute to divide by. Telegram's voice codec (RFC 7845) counts the
 * granule at 48 kHz from the start, less the head's pre-skip (§4); Vorbis at the
 * rate its head names.
 * The last page is the one that ends the file EXACTLY — an «OggS» that happens to
 * sit inside the audio cannot — and a page that finishes no packet (granule −1)
 * hands over to the page before it. Anything else answers null: «not known»
 * beats a guess.
 */
function oggDurationSec(buf: Buffer): number | null {
  if (buf.length < 28 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  let rate: number;
  let preSkip = 0;
  const head = buf.indexOf(VOICE_HEAD_MAGIC);
  if (head >= 0 && head < 512 && head + 12 <= buf.length) {
    rate = 48_000;
    preSkip = buf.readUInt16LE(head + 10);
  } else {
    const vorbis = buf.indexOf('\x01vorbis', 0, 'latin1');
    if (vorbis < 0 || vorbis > 512 || vorbis + 16 > buf.length) return null;
    rate = buf.readUInt32LE(vorbis + 12);
    if (rate <= 0) return null;
  }
  let end = buf.length;
  for (let pages = 0; pages < 16 && end > 27; pages++) {
    let at = buf.lastIndexOf('OggS', end - 27, 'latin1');
    let found = -1;
    while (at >= 0) {
      if (buf[at + 4] === 0 && at + 27 <= end) {
        const segments = buf[at + 26]!;
        if (at + 27 + segments <= end) {
          let body = 0;
          for (let s = 0; s < segments; s++) body += buf[at + 27 + s]!;
          if (at + 27 + segments + body === end) {
            found = at;
            break;
          }
        }
      }
      at = at > 0 ? buf.lastIndexOf('OggS', at - 1, 'latin1') : -1;
    }
    if (found < 0) return null;
    const granule = buf.readBigInt64LE(found + 6);
    if (granule !== -1n) {
      const sec = Number(granule - BigInt(preSkip)) / rate;
      return Number.isFinite(sec) && sec > 0 && sec < 86_400 ? Math.round(sec * 10) / 10 : null;
    }
    end = found;
  }
  return null;
}

/** What a provider sent back on a refusal, as one redacted line. */
function errorOf(raw: string): string {
  try {
    const j: unknown = JSON.parse(raw);
    const detail = field(j, 'detail');
    const m =
      str(field(field(j, 'error'), 'message')) ??
      str(field(detail, 'message')) ??
      str(detail) ??
      str(field(j, 'message')) ??
      str(field(j, 'error'));
    if (m) return clip(redact(m), 300);
  } catch {
    // not JSON — the raw text below
  }
  return clip(redact(raw.trim()), 300) || '(empty answer)';
}

/** No answer at all: the timeout, or what the network said (ENOTFOUND, ECONNREFUSED…) — reachability is under test. */
function netErrorOf(err: unknown, timedOut: boolean): string {
  if (timedOut) return `no answer within ${REQUEST_MS / 1000} s (timeout)`;
  const cause = field(err, 'cause');
  const code = str(field(cause, 'code'));
  const msg = str(field(cause, 'message')) ?? str(field(err, 'message')) ?? String(err);
  return clip(redact(code ? `${code}: ${msg}` : msg), 300);
}

interface NoteResult {
  attachmentId: string;
  fileName: string | null;
  contentType: string | null;
  bytes: number | null;
  /** First 16 hex of sha256 over the bytes sent — the same note in two result files carries the same value. */
  sha256: string | null;
  durationSec: number | null;
  provider: ProviderName;
  model: string | null;
  lang: Lang;
  /** The provider's round trip, upload to last byte; null when nothing was sent. */
  ms: number | null;
  /** HTTP status; null = no answer (network, timeout) or never sent. */
  status: number | null;
  /** No answer within REQUEST_MS — counted apart, so a dropped long note is not a fast one. */
  timedOut: boolean;
  ok: boolean;
  /** «» is an answer: silence and noise SHOULD come back empty (M6). */
  text: string | null;
  detectedLanguage: string | null;
  error: string | null;
  /** Why it was never sent (not counted against the provider). */
  notSent: string | null;
}

async function send(provider: Provider, bytes: Buffer, contentType: string, fileName: string, lang: Lang) {
  // A copy into a plain ArrayBuffer view: a Node Buffer may sit on a shared pool the Blob must not see.
  const file = new Blob([new Uint8Array(bytes)], { type: contentType });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: provider.headers,
      body: provider.form(file, fileName, lang),
      signal: controller.signal,
      // Never followed: across origins fetch drops only Authorization, so `xi-api-key` / STT_UZ_HEADER and the
      // note itself would be re-sent to whatever host the answer names — and an https → http hop would undo the
      // clear-text fence above. A redirect is reported as the failure it is.
      redirect: 'manual',
    });
    const raw = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let where = '(no Location)';
      if (location) {
        try {
          where = shownUrl(new URL(location, provider.url));
        } catch {
          where = '(an unreadable Location)';
        }
      }
      return {
        ms,
        status: res.status,
        heard: null,
        timedOut: false,
        error: redact(`redirected to ${where} — not followed (the key and the note would go along); if that is the service's own address, its endpoint has moved`),
      };
    }
    if (!res.ok) return { ms, status: res.status, heard: null, timedOut: false, error: errorOf(raw) };
    let answer: unknown = raw;
    try {
      answer = JSON.parse(raw);
    } catch {
      // A plain-text answer is the transcript itself when the service says it is text.
      if (/^text\/plain\b/iu.test(res.headers.get('content-type') ?? '')) {
        return { ms, status: res.status, heard: { text: redactKeys(raw.trim()), language: null }, timedOut: false, error: null };
      }
    }
    const heard = provider.read(answer);
    if (!heard) {
      return {
        ms,
        status: res.status,
        heard: null,
        timedOut: false,
        error: `answered, but no transcript in it: ${clip(redact(raw.trim()), 300)}`,
      };
    }
    return { ms, status: res.status, heard: { text: redactKeys(heard.text), language: heard.language }, timedOut: false, error: null };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return { ms: Math.round(performance.now() - t0), status: null, heard: null, timedOut, error: netErrorOf(err, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

function readIds(file: string): string[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return `cannot read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return `${file} must be a JSON list of attachment ids, e.g. ["0190…", "0191…"]`;
  const bad = parsed.find((v) => typeof v !== 'string' || !UUID.test(v));
  if (bad !== undefined) return `${file}: not an attachment id: ${clip(JSON.stringify(bad), 60)}`;
  // Once each, in the file's order: a repeated id would be billed twice and counted twice.
  const ids = [...new Set((parsed as string[]).map((s) => s.toLowerCase()))];
  if (ids.length > MAX_IDS) return `${file} holds ${ids.length} ids; the trial is 25 notes + 4 traps, at most ${MAX_IDS} at once`;
  return ids;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summarize(notes: NoteResult[]) {
  const sent = notes.filter((n) => n.notSent === null);
  const okMs = sent.filter((n) => n.ok && n.ms !== null).map((n) => n.ms!).sort((a, b) => a - b);
  const timeouts = sent.filter((n) => n.timedOut).length;
  const timed = sent.filter((n) => n.durationSec !== null);
  return {
    notes: notes.length,
    sent: sent.length,
    ok: sent.filter((n) => n.ok).length,
    failed: sent.filter((n) => !n.ok).length,
    timeouts,
    notSent: notes.length - sent.length,
    // Over the answers that came back: a timeout's 60 s is an absence, not a speed.
    medianMs: percentile(okMs, 50),
    p95Ms: percentile(okMs, 95),
    maxMs: okMs.length ? okMs[okMs.length - 1]! : null,
    // …and the same p95 with every timeout counted as the full REQUEST_MS beside it: a provider that drops the
    // long notes must not read faster on M8 than one that answers them slowly.
    p95WithTimeoutsMs: timeouts ? percentile([...okMs, ...Array<number>(timeouts).fill(REQUEST_MS)].sort((a, b) => a - b), 95) : null,
    audioSecKnown: Math.round(timed.reduce((s, n) => s + n.durationSec!, 0) * 10) / 10,
    notesWithDuration: timed.length,
    bytesSent: sent.reduce((s, n) => s + (n.bytes ?? 0), 0),
  };
}

function printNote(i: number, total: number, n: NoteResult): void {
  const head = `[${i}/${total}] ${n.attachmentId}`;
  if (n.notSent !== null) {
    console.log(`${head}  NOT SENT — ${n.notSent}`);
    return;
  }
  const dur = n.durationSec === null ? 'duration ?' : `${n.durationSec} s`;
  console.log(`${head}  ${n.fileName}  ${n.bytes} B  ${dur}  sha256 ${n.sha256}`);
  const answer = n.status === null ? 'no answer' : `HTTP ${n.status}`;
  const language = n.detectedLanguage ? `  (language ${n.detectedLanguage})` : '';
  console.log(`    ${n.provider}${n.model ? ` ${n.model}` : ''} → ${answer} in ${n.ms} ms${language}`);
  if (n.ok) console.log(n.text ? `    «${n.text.replace(/\s*\n\s*/gu, ' / ')}»` : '    «» (empty — silence or noise should come back exactly so)');
  else console.log(`    FAILED: ${n.error}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  // The key first: a missing one stops the run before the database or storage is touched.
  const built = buildProvider(args.provider, args.model);
  if (!built.ok) {
    console.error(built.message);
    return 2;
  }
  const provider = built.provider;

  const ids = readIds(args.ids);
  if (typeof ids === 'string') {
    console.error(ids);
    console.error(USAGE);
    return 2;
  }

  const outPath = args.out ? path.resolve(args.out) : null;
  if (outPath) {
    // Never over a file: a paid run's results are not overwritten by a typo in the next command.
    if (existsSync(outPath)) {
      console.error(`--out ${outPath} already exists — choose another name; nothing was sent.`);
      return 2;
    }
    const dir = path.dirname(outPath);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`--out: folder ${dir} does not exist (inside docker it must be the mounted one, e.g. /stt); nothing was sent.`);
      return 2;
    }
  }

  console.log(`READ-ONLY — bazaga ham, fayllar omboriga ham hech narsa yozilmaydi; ovozli xabarlar faqat «${provider.name}» ga yuboriladi.`);
  console.log(
    `provider ${provider.name}${provider.model ? ` · model ${provider.model}` : ''} · language ${args.lang} · ` +
      `${shownUrl(provider.url)} · ${ids.length} note(s), one at a time, ${REQUEST_MS / 1000} s each at most\n`,
  );

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return tx
      .select({
        id: attachments.id,
        entityType: attachments.entityType,
        storageKey: attachments.storageKey,
        fileName: attachments.fileName,
        contentType: attachments.contentType,
        sizeBytes: attachments.sizeBytes,
        direction: tgMessages.direction,
        deletedAt: tgMessageFlags.deletedAt,
      })
      .from(attachments)
      .leftJoin(tgMessages, and(eq(attachments.entityType, 'tg_message'), eq(tgMessages.id, attachments.entityId)))
      .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
      .where(inArray(attachments.id, ids));
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const startedAt = new Date().toISOString();
  const notes: NoteResult[] = [];
  const write = (finishedAt: string | null) => {
    if (!outPath) return;
    const doc = {
      trial: 'stt',
      provider: provider.name,
      model: provider.model,
      lang: args.lang,
      endpoint: shownUrl(provider.url),
      startedAt,
      finishedAt,
      summary: summarize(notes),
      notes,
    };
    // Rewritten after every note (created by this run, `wx` the first time), so a run cut short keeps what it heard.
    writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, { flag: finishedAt === null && notes.length === 0 ? 'wx' : 'w' });
  };
  write(null);

  for (const [i, id] of ids.entries()) {
    const row = byId.get(id);
    const base: NoteResult = {
      attachmentId: id,
      fileName: row?.fileName ?? null,
      contentType: row?.contentType ?? null,
      bytes: row?.sizeBytes ?? null,
      sha256: null,
      durationSec: null,
      provider: provider.name,
      model: provider.model,
      lang: args.lang,
      ms: null,
      status: null,
      timedOut: false,
      ok: false,
      text: null,
      detectedLanguage: null,
      error: null,
      notSent: null,
    };
    const refuse = (why: string): NoteResult => ({ ...base, notSent: why });

    let note: NoteResult;
    if (!row) note = refuse('no attachment with this id');
    else if (row.entityType !== 'tg_message') note = refuse(`not a Telegram message's file (it belongs to «${row.entityType}»)`);
    else if (!row.contentType.toLowerCase().startsWith('audio/')) note = refuse(`not audio (${row.contentType})`);
    else if (!VOICE_NOTE_NAME.test(row.fileName)) note = refuse(`an audio file («${clip(row.fileName, 60)}»), not a voice note`);
    else if (row.direction === null) note = refuse('its message row is gone');
    else if (row.direction !== 'in') note = refuse("our side's note, not a customer's");
    else if (row.deletedAt !== null) note = refuse('the customer deleted this message');
    else if (row.sizeBytes > MAX_NOTE_BYTES) note = refuse(`${row.sizeBytes} bytes — larger than any voice note`);
    else {
      let bytes: Buffer | null = null;
      let readError: string | null = null;
      try {
        bytes = await readNote(row.storageKey);
      } catch (err) {
        readError = clip(err instanceof Error ? err.message : String(err), 200);
      }
      if (!bytes) note = refuse(`storage: ${readError}`);
      // A cut object scored against the fact sheet would blame the provider for our missing bytes.
      else if (bytes.length !== row.sizeBytes) note = refuse(`storage returned ${bytes.length} bytes, the row says ${row.sizeBytes}`);
      else {
        const sendName = row.fileName.replace(/\.oga$/iu, '.ogg');
        const r = await send(provider, bytes, row.contentType, sendName, args.lang);
        note = {
          ...base,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
          durationSec: oggDurationSec(bytes),
          ms: r.ms,
          status: r.status,
          timedOut: r.timedOut,
          ok: r.heard !== null,
          text: r.heard?.text ?? null,
          detectedLanguage: r.heard?.language ?? null,
          error: r.error,
        };
      }
    }
    notes.push(note);
    printNote(i + 1, ids.length, note);
    write(null);
  }

  const s = summarize(notes);
  write(new Date().toISOString());
  console.log(`\n== ${provider.name}${provider.model ? ` (${provider.model})` : ''}, language ${args.lang}`);
  console.log(`   sent ${s.sent} · ok ${s.ok} · failed ${s.failed} · not sent ${s.notSent}`);
  const late = s.timeouts ? ` · ${s.timeouts} timeout(s); p95 counting them as ${REQUEST_MS} ms: ${s.p95WithTimeoutsMs} ms` : ' · 0 timeouts';
  console.log(
    s.medianMs === null
      ? `   time: no answer came back${late}`
      : `   time over the ${s.ok} answers: median ${s.medianMs} ms · p95 ${s.p95Ms} ms · max ${s.maxMs} ms${late}`,
  );
  console.log(`   audio: ${s.audioSecKnown} s known over ${s.notesWithDuration} of ${s.sent} sent note(s); ${s.bytesSent} bytes sent`);
  if (outPath) console.log(`   written: ${outPath}`);
  // 1 when nothing at all came back, so a run against an unreachable provider does not read as a pass.
  return s.ok > 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(redact(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  // An exit, not a drained event loop: a storage read past its deadline cannot be cancelled (the S3 driver's
  // getStream takes no signal), and its pending request would hold the process — and `docker compose run` — open
  // for ever after the summary. Everything is already out: stdout to a pipe or file is synchronous on Linux, --out
  // is written with writeFileSync, and exit() keeps the exitCode set above.
  .finally(() => void pgClient.end().finally(() => process.exit()));
