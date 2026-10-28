import type { JobState } from '@/modules/platform/jobs/boss';
import type { IntakeReadJob } from '@/modules/platform/telegram/calc-read';

/**
 * The ONE way a collector test presses «Bo‘ldi» since the reading is a pg-boss
 * job (docs/SAKKIZ-R3.md §7.1, regression-10): the press only enqueues, so a
 * drive that waited for `stage: 'review'` or `analysing: null` would wait for
 * ever — and an unmocked `enqueue` would reach `ensureListening()` /
 * `boss.start` against the test database.
 *
 * Wiring, in the test file (the factory imports this module lazily, so its
 * order among the imports does not matter, and nothing here imports the bot
 * at load time — the mocked module is not yet built when the factory runs):
 *
 *   vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
 *     (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
 *   );
 *
 * then `await driveReading(chatId, ctx)` runs the job the press enqueued —
 * `runIntakeRead` with the captured payload — and hands every message the job
 * sends to `ctx.reply`, so a test reads the table where it always read the
 * summary. The job sends through the one Bot-API sender (send.ts); the drive
 * stands in for Telegram there (`__setTelegramTransport`), so the real
 * delivery path — the brief retry, the fallbacks, the message id — runs.
 */

type Enqueued = { name: string; data: unknown; options: Record<string, unknown> };
type Sink = { reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }> };
/** What one drive sent: the messages, and the edits (the notice's «✅ O‘qildi»). */
export interface Driven {
  sent: { text: string; replyMarkup: unknown }[];
  edits: { messageId: number; text: string }[];
}

const READ_QUEUE = 'calc.intake-read';

const drive = {
  enqueued: [] as Enqueued[],
  /** Ids already handed to a drive — not handed again. */
  driven: new Set<string>(),
  states: new Map<string, JobState | null>(),
  refuseEnqueue: 0,
  messageId: 1_000_000,
};

/**
 * `platform/jobs/boss` with `enqueue` captured (never a pg-boss start) and
 * `jobState` answered from what this file was told: a captured job is
 * `created` until a test says otherwise (`setReadJobState`).
 */
export function bossForReading<T extends object>(original: T): T {
  return {
    ...original,
    async enqueue(name: string, data: unknown, options: Record<string, unknown> = {}): Promise<string | null> {
      if (drive.refuseEnqueue > 0) {
        drive.refuseEnqueue -= 1;
        throw new Error('pg-boss refused the send (test)');
      }
      const id = typeof options.id === 'string' ? options.id : `job-${drive.enqueued.length + 1}`;
      drive.enqueued.push({ name, data, options: { ...options, id } });
      return id;
    },
    async jobState(_queue: string, id: string): Promise<JobState | null> {
      if (drive.states.has(id)) return drive.states.get(id) ?? null;
      return drive.enqueued.some((e) => e.options.id === id) ? 'created' : null;
    },
  };
}

/** The next `n` sends are refused, as pg-boss refuses one on a database blip. */
export function refuseNextEnqueue(n = 1): void {
  drive.refuseEnqueue = n;
}

/** What `jobState` answers for this job id from now on. */
export function setReadJobState(id: string, state: JobState | null): void {
  drive.states.set(id, state);
}

/** Every reading job captured so far (the press's and any delivery-only follow-up), oldest first. */
export function readingsEnqueued(chatId?: bigint): { data: IntakeReadJob; options: Record<string, unknown> }[] {
  return drive.enqueued
    .filter((e) => e.name === READ_QUEUE)
    .filter((e) => chatId === undefined || (e.data as IntakeReadJob).chatId === String(chatId))
    .map((e) => ({ data: e.data as IntakeReadJob, options: e.options }));
}

/** Forget every capture (between tests). */
export function resetReadingDrive(): void {
  drive.enqueued.length = 0;
  drive.driven.clear();
  drive.states.clear();
  drive.refuseEnqueue = 0;
}

/**
 * Run the newest reading job enqueued for this chat that no drive has run yet
 * — `runIntakeRead(captured, retryCount)` — with Telegram stood in for: every
 * `sendMessage` goes to `sink.reply` (its message id answered back), every
 * edit is recorded. Throws when nothing was enqueued: a drive that runs
 * nothing proves nothing.
 */
export async function driveReading(
  chatId: bigint,
  sink?: Sink,
  opts: { retryCount?: number; job?: IntakeReadJob } = {},
): Promise<Driven> {
  const job = opts.job ?? takeNext(chatId);
  const out: Driven = { sent: [], edits: [] };
  const { __setTelegramTransport } = await import('@/modules/platform/telegram/send');
  const { runIntakeRead } = await import('@/modules/platform/telegram/calc-read');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) process.env.TELEGRAM_BOT_TOKEN = 'calc-read-drive';
  __setTelegramTransport(async (url, init) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    const method = url.slice(url.lastIndexOf('/') + 1);
    if (method === 'sendMessage') {
      const text = String(body.text ?? '');
      out.sent.push({ text, replyMarkup: body.reply_markup ?? null });
      let messageId = (drive.messageId += 1);
      if (sink) {
        try {
          const sent = await sink.reply(text, body.reply_markup ? { reply_markup: body.reply_markup } : undefined);
          if (typeof sent?.message_id === 'number') messageId = sent.message_id;
        } catch {
          return answer(500, { ok: false, description: 'Internal Server Error (test sink refused)' });
        }
      }
      return answer(200, { ok: true, result: { message_id: messageId } });
    }
    if (method === 'editMessageText') {
      out.edits.push({ messageId: Number(body.message_id), text: String(body.text ?? '') });
      return answer(200, { ok: true, result: true });
    }
    return answer(200, { ok: true, result: true });
  });
  try {
    await runIntakeRead(job, opts.retryCount ?? 0);
  } finally {
    __setTelegramTransport(null);
    if (!token) delete process.env.TELEGRAM_BOT_TOKEN;
  }
  return out;
}

function takeNext(chatId: bigint): IntakeReadJob {
  const next = [...readingsEnqueued(chatId)].reverse().find((e) => !drive.driven.has(String(e.options.id)));
  if (!next) throw new Error(`no reading was enqueued for chat ${chatId} — «Bo‘ldi» was refused before the job`);
  drive.driven.add(String(next.options.id));
  return next.data;
}

function answer(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}
