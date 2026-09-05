'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  NoteError,
  canShareNotes,
  deleteNote,
  removeNotePart,
  saveNote,
  setNoteShared,
  setPartSendAs,
  type NoteCtx,
} from '@/modules/platform/notes/service';

export interface NoteFormState {
  ok?: boolean;
  error?: string;
}

/**
 * The wide door is a login: every staff member keeps their own zametkalar, the
 * way every staff member keeps their own canned replies. Publishing to the
 * COMPANY is the second, narrower check and it lives INSIDE the service, so
 * the checkbox is a request rather than a permission (#170: no new code — the
 * seed skips a role the admin has edited, and a fresh code would be
 * ungrantable on the owner's live database).
 */
async function run(work: (ctx: NoteCtx) => Promise<unknown>): Promise<NoteFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await work({
      actorId: actor.id,
      canShare: canShareNotes(actor.permissions),
      ...meta,
    });
  } catch (err) {
    if (err instanceof NoteError) return { error: err.code };
    throw err;
  }
  revalidatePath('/zametkalar');
  return { ok: true };
}

export async function saveNoteAction(
  _prev: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const id = String(formData.get('id') ?? '');
  if (!id) return { error: 'validation' };
  return run((ctx) =>
    saveNote(
      {
        id,
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
        location: String(formData.get('location') ?? ''),
        placeTitle: String(formData.get('placeTitle') ?? ''),
        placeAddress: String(formData.get('placeAddress') ?? ''),
        shared: formData.get('shared') === 'on',
        sortOrder: Number(formData.get('sortOrder') ?? 100) || 100,
      },
      ctx,
    ),
  );
}

export async function deleteNoteAction(id: string): Promise<NoteFormState> {
  return run((ctx) => deleteNote(id, ctx));
}

/**
 * Moving a note between the company's list and its author's own is its own
 * act — never a side effect of correcting a typo on the address sheet twenty
 * colleagues send out.
 */
export async function setNoteSharedAction(id: string, shared: boolean): Promise<NoteFormState> {
  return run((ctx) => setNoteShared(id, shared, ctx));
}

export async function removeNotePartAction(partId: string): Promise<NoteFormState> {
  return run((ctx) => removeNotePart(partId, ctx));
}

export async function setPartSendAsAction(
  partId: string,
  sendAs: 'photo' | 'document',
): Promise<NoteFormState> {
  return run((ctx) => setPartSendAs(partId, sendAs, ctx));
}
