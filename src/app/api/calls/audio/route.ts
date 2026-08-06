import { z } from 'zod';
import {
  attachCallAudio,
  callDeviceForToken,
  CallsError,
  findCallForAudio,
} from '@/modules/wms/calls/service';
import { FileValidationError, saveAttachment } from '@/modules/platform/files/service';

/**
 * The recording, minutes after the call: the phone's own recorder closes the
 * file when the call ends and the app finds it on its next sweep. A route
 * handler, not an action — the body is megabytes (#291).
 *
 * The CALL must already exist (the log batch travels first) and it must
 * belong to THIS device — so an unmatched call, which was never stored, has
 * nothing to hang audio on and the bytes are refused rather than parked:
 * the storage never holds audio the database cannot name. Content is
 * validated by MAGIC, not by name — an upload endpoint with a bearer token
 * is still an upload endpoint.
 */
const metaSchema = z.object({
  phone: z.string().trim().min(5).max(30),
  startedAt: z.coerce.number().int().positive(),
});

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** The first bytes of everything a phone call recorder actually writes. */
function looksLikeAudio(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const head = buffer.subarray(0, 12);
  if (head.subarray(0, 5).toString('latin1') === '#!AMR') return true; // AMR
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return true; // OGG/Opus
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return true; // MP3 tagged
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return true; // MP3/AAC frame
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return true; // WAV
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return true; // M4A/3GP
  return false;
}

export async function POST(request: Request) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let device;
  try {
    device = await callDeviceForToken(token);
  } catch (err) {
    if (err instanceof CallsError) return Response.json({ error: 'revoked' }, { status: 410 });
    throw err;
  }

  const formData = await request.formData();
  const file = formData.get('audio');
  const meta = metaSchema.safeParse({
    phone: formData.get('phone'),
    startedAt: formData.get('startedAt'),
  });
  if (!meta.success || !(file instanceof File)) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'too_large' }, { status: 413 });
  }

  const call = await findCallForAudio(device, meta.data);
  if (!call) return Response.json({ error: 'no_call' }, { status: 404 });
  // A replay after a lost response: the audio is already on the call, and
  // telling the app «done» is what stops it re-sending megabytes for ever.
  if (call.attachmentId) return Response.json({ ok: true, already: true });

  const body = Buffer.from(await file.arrayBuffer());
  if (!looksLikeAudio(body)) {
    return Response.json({ error: 'not_audio' }, { status: 415 });
  }

  let attachmentId: string;
  try {
    const saved = await saveAttachment({
      entityType: 'call_log',
      entityId: call.id,
      fileName: file.name || `call-${meta.data.startedAt}.m4a`,
      contentType: file.type || '',
      body,
      uploadedBy: call.userId,
    });
    attachmentId = saved.id;
  } catch (err) {
    if (err instanceof FileValidationError) {
      return Response.json({ error: err.code }, { status: 415 });
    }
    throw err;
  }

  const claimed = await attachCallAudio(call.id, attachmentId);
  // Two uploads raced; the first one won and this file is an orphan the
  // sweep may reap — the app is still told «done».
  return Response.json({ ok: true, already: !claimed });
}
