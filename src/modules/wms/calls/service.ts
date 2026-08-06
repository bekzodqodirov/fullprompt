import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { attachments, callLogs, callRecorderDevices, clients, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { phoneBelongsToClient, phonesOverlap } from '../client-cabinet/service';
import { seesAllTg, type TgViewer } from '../crm/conversations';

/**
 * Qo'ng'iroq yozuvlari CRM'da (owner's round: «telefonlarni zapisini
 * yozadigan qilsak ... zapis lentada korinsa»).
 *
 * The recording happens on the PHONE — Android hands no app the call audio,
 * so the phone's own recorder writes the file and our APK ships it. This
 * module is the server half, and its two rules are the owner's two answers:
 *
 *  · **Only the client book.** A call whose number no active client holds is
 *    answered `matched: false` and NEVER stored — the tg-import rule: a
 *    hodim's personal calls are not the company's data. `call_logs.client_id
 *    NOT NULL` makes the rule structural.
 *  · **Read like Telegram.** A call is the taker's record: `callsFor` shows a
 *    manager their own calls, and the supervision set (round 33's `seesAllTg`)
 *    everything — the same eyes that read the chats.
 */

export class CallsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Ambiguous characters (0/O, 1/I) are out — the code is read off a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newPairCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Mint a pairing code for the ACTOR's own phone. Own on purpose: the code
 * binds the device to a user, and handing out codes for colleagues would be
 * signing their name onto whatever a phone later sends.
 */
export async function createCallDevice(input: { label?: string | null }, ctx: AuditContext) {
  if (!ctx.actorId) throw new CallsError('unauthenticated');
  const [row] = await db
    .insert(callRecorderDevices)
    .values({
      userId: ctx.actorId,
      label: input.label || null,
      pairCode: newPairCode(),
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'call_recorder_device',
    entityId: row!.id,
    action: 'create',
    after: { label: input.label ?? null },
  });
  return row!;
}

/** Own device only — revoking a colleague's phone is not a mistake to allow. */
export async function revokeCallDevice(deviceId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CallsError('unauthenticated');
  const device = await db.query.callRecorderDevices.findFirst({
    where: eq(callRecorderDevices.id, deviceId),
  });
  if (!device || device.revokedAt) return;
  if (device.userId !== ctx.actorId) throw new CallsError('forbidden');
  // The pair code goes; the token hash stays so the phone can be TOLD it is
  // over (410) instead of a 401 it retries for ever (#289).
  await db
    .update(callRecorderDevices)
    .set({ revokedAt: new Date(), pairCode: null })
    .where(eq(callRecorderDevices.id, deviceId));
  await writeAudit(db, ctx, {
    entityType: 'call_recorder_device',
    entityId: deviceId,
    action: 'void',
    after: {},
  });
}

/** The app exchanges the single-use code for a long-lived token. */
export async function pairCallDevice(pairCode: string, platform: 'android' | 'other' = 'android') {
  const code = pairCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new CallsError('bad_code');
  const device = await db.query.callRecorderDevices.findFirst({
    where: eq(callRecorderDevices.pairCode, code),
  });
  if (!device || device.revokedAt) throw new CallsError('bad_code');
  const [user] = await db.select({ active: users.active }).from(users).where(eq(users.id, device.userId));
  if (!user?.active) throw new CallsError('bad_code');

  const token = randomBytes(32).toString('base64url');
  await db
    .update(callRecorderDevices)
    .set({ tokenHash: hashToken(token), pairCode: null, pairedAt: new Date(), platform })
    .where(eq(callRecorderDevices.id, device.id));
  return { deviceId: device.id, token };
}

/**
 * Token → device, with the driver app's revocation contract: a revoked or
 * unknown token is `revoked` (the route answers 410, the app stops), never a
 * retryable refusal.
 */
export async function callDeviceForToken(token: string) {
  if (!token) throw new CallsError('revoked');
  const device = await db.query.callRecorderDevices.findFirst({
    where: eq(callRecorderDevices.tokenHash, hashToken(token)),
  });
  if (!device || device.revokedAt) throw new CallsError('revoked');
  return device;
}

export const callBatchSchema = z.object({
  calls: z
    .array(
      z.object({
        phone: z.string().trim().min(5).max(30),
        direction: z.enum(['in', 'out']),
        /** Epoch ms from the phone's call log. */
        startedAt: z.number().int().positive(),
        durationSec: z.number().int().min(0).max(24 * 3600),
      }),
    )
    .min(1)
    .max(200),
});
export type CallBatchInput = z.infer<typeof callBatchSchema>;

export interface CallVerdict {
  phone: string;
  startedAt: number;
  /** True = the client book knows this number and the call is stored. */
  matched: boolean;
}

/**
 * The phone's call log, filtered by the client book AT the door.
 *
 * `matched: false` means the number was looked at and DROPPED — nothing is
 * written, which is the whole privacy design: the server hears the number
 * once to answer the question and keeps only the company's calls. The app
 * uses the verdict to know which calls deserve an audio upload.
 */
export async function ingestCalls(
  device: { id: string; userId: string },
  input: CallBatchInput,
): Promise<CallVerdict[]> {
  // The client book ONCE per batch, not per call (#432's rule — a batch is
  // 200 calls). Ordered because the answer is used first-match: one person
  // holds several codes on one number, and without an ORDER BY the same call
  // could land on a different sibling code between two cycles (round 67b).
  // The OLDEST code wins — clientsForChat's rule, restated for phones.
  const book = await db
    .select({ id: clients.id, phones: clients.phones })
    .from(clients)
    .where(eq(clients.active, true))
    .orderBy(asc(clients.createdAt), asc(clients.clientCode));
  const verdicts: CallVerdict[] = [];
  for (const call of input.calls) {
    const client = book.find((c) => phoneBelongsToClient(call.phone, c.phones));
    if (!client) {
      verdicts.push({ phone: call.phone, startedAt: call.startedAt, matched: false });
      continue;
    }
    await db
      .insert(callLogs)
      .values({
        userId: device.userId,
        clientId: client.id,
        deviceId: device.id,
        direction: call.direction,
        phone: call.phone,
        startedAt: new Date(call.startedAt),
        durationSec: call.durationSec,
      })
      // The phone re-sends its recent log every cycle so a missed upload
      // heals; the dedup key makes the replay a no-op.
      .onConflictDoNothing();
    verdicts.push({ phone: call.phone, startedAt: call.startedAt, matched: true });
  }
  await db
    .update(callRecorderDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(callRecorderDevices.id, device.id));
  return verdicts;
}

/**
 * The call an uploaded recording belongs to — found by its dedup identity
 * and ONLY among this USER's calls: a token must not be able to hang audio
 * on a colleague's call. User, not device (0061's lesson): after a revoke +
 * re-pair the call row keeps the FIRST pairing's device id, and a
 * device-scoped find would 404 the new pairing's audio for ever.
 */
export async function findCallForAudio(
  device: { userId: string },
  input: { phone: string; startedAt: number },
) {
  const [call] = await db
    .select()
    .from(callLogs)
    .where(
      and(
        eq(callLogs.userId, device.userId),
        eq(callLogs.phone, input.phone),
        eq(callLogs.startedAt, new Date(input.startedAt)),
      ),
    )
    .limit(1);
  return call ?? null;
}

/** Claim stored audio onto its call. First write wins; a replay is told so. */
export async function attachCallAudio(callId: string, attachmentId: string): Promise<boolean> {
  const rows = await db
    .update(callLogs)
    .set({ attachmentId })
    .where(and(eq(callLogs.id, callId), isNull(callLogs.attachmentId)))
    .returning({ id: callLogs.id });
  return rows.length > 0;
}

export interface CallRow {
  id: string;
  clientId: string;
  clientCode: string;
  direction: string;
  phone: string;
  startedAt: Date;
  durationSec: number;
  attachmentId: string | null;
  takerName: string | null;
}

/**
 * One client's calls for the card panel — the TELEGRAM rule (round 20/33):
 * a manager reads their own, the supervision set reads everything. NOT the
 * lenta: the lenta is the company-wide record (round 21's split), and these
 * rows are scoped, so they get their own panel beside the chat's.
 */
export async function callsFor(clientId: string, viewer: TgViewer, limit = 50): Promise<CallRow[]> {
  return callsForClients([clientId], viewer, limit);
}

async function callsForClients(
  clientIds: string[],
  viewer: TgViewer,
  limit: number,
): Promise<CallRow[]> {
  if (clientIds.length === 0) return [];
  return db
    .select({
      id: callLogs.id,
      clientId: callLogs.clientId,
      clientCode: clients.clientCode,
      direction: callLogs.direction,
      phone: callLogs.phone,
      startedAt: callLogs.startedAt,
      durationSec: callLogs.durationSec,
      attachmentId: callLogs.attachmentId,
      takerName: users.fullName,
    })
    .from(callLogs)
    .innerJoin(users, eq(callLogs.userId, users.id))
    .innerJoin(clients, eq(callLogs.clientId, clients.id))
    .where(
      and(
        inArray(callLogs.clientId, clientIds),
        viewer.all ? undefined : eq(callLogs.userId, viewer.id),
      ),
    )
    .orderBy(desc(callLogs.startedAt))
    .limit(limit);
}

/**
 * The card's calls, widened to the PERSON: one owner of several GS codes
 * shares one phone, `ingestCalls` lands a call on the OLDEST code, and the
 * owner's first real call sat invisible on a sibling while he read the deal
 * card of the newer one — round 32's empty-card shape, on calls. The rows
 * carry their code so the panel can say which sibling took the call; the
 * viewer scoping is untouched.
 */
export async function callsForCard(
  clientId: string,
  viewer: TgViewer,
  limit = 50,
): Promise<CallRow[]> {
  const self = await db.query.clients.findFirst({
    columns: { id: true, phones: true },
    where: eq(clients.id, clientId),
  });
  if (!self) return [];
  const ids = [clientId];
  if (Array.isArray(self.phones) && self.phones.length > 0) {
    const book = await db
      .select({ id: clients.id, phones: clients.phones })
      .from(clients)
      .where(eq(clients.active, true));
    for (const c of book) {
      if (c.id !== clientId && phonesOverlap(self.phones, c.phones)) ids.push(c.id);
    }
  }
  return callsForClients(ids, viewer, limit);
}

/**
 * May this person read this call's AUDIO? The attachment route asks per
 * file; the answer is the panel's own rule restated for one row.
 */
export async function canReadCallAudio(
  attachmentId: string,
  actor: { id: string; roles?: readonly string[]; permissions?: ReadonlySet<string> },
): Promise<boolean> {
  const [call] = await db
    .select({ userId: callLogs.userId })
    .from(callLogs)
    .where(eq(callLogs.attachmentId, attachmentId))
    .limit(1);
  if (!call) return false;
  return call.userId === actor.id || seesAllTg(actor);
}

/** The actor's own devices for the /profile section (never the token). */
export async function callDevicesFor(userId: string) {
  return db
    .select({
      id: callRecorderDevices.id,
      label: callRecorderDevices.label,
      pairCode: callRecorderDevices.pairCode,
      pairedAt: callRecorderDevices.pairedAt,
      lastSeenAt: callRecorderDevices.lastSeenAt,
      calls: sql<number>`(
        SELECT count(*) FROM call_logs cl WHERE cl.device_id = ${callRecorderDevices.id}
      )`,
    })
    .from(callRecorderDevices)
    .where(and(eq(callRecorderDevices.userId, userId), isNull(callRecorderDevices.revokedAt)))
    .orderBy(desc(callRecorderDevices.createdAt));
}

/** Attachment ids of a client's calls this viewer may see (for cleanup/reads). */
export async function callAudioIdsFor(clientId: string, viewer: TgViewer): Promise<string[]> {
  const rows = await db
    .select({ attachmentId: callLogs.attachmentId })
    .from(callLogs)
    .where(
      and(
        eq(callLogs.clientId, clientId),
        viewer.all ? undefined : eq(callLogs.userId, viewer.id),
        sql`${callLogs.attachmentId} IS NOT NULL`,
      ),
    );
  return rows.map((r) => r.attachmentId!).filter(Boolean);
}

/** Keep the attachments table honest: audio uploaded but never claimed. */
export async function orphanCallAudio(olderThanHours = 24) {
  return db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'call_log'),
        sql`${attachments.createdAt} < now() - make_interval(hours => ${olderThanHours})`,
        sql`NOT EXISTS (SELECT 1 FROM call_logs cl WHERE cl.attachment_id = ${attachments.id})`,
      ),
    );
}
