'use client';

import { useActionState, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { addFeedNoteAction, type ReplyState } from '@/modules/wms/crm/reply-actions';

/**
 * An internal note on the timeline — the other half of the composer.
 *
 * Separate from the Telegram box on purpose, and visibly so. In amoCRM the
 * two live behind one control with a mode switch, and the accident that
 * follows is somebody typing an internal remark about a client and sending it
 * TO the client. Two boxes, each labelled, cannot make that mistake.
 *
 * Files ride along (owner: "zametkaga fayllar qo'shish"): uploaded against a
 * client-generated note id BEFORE the note exists — the receipt wizard's
 * pre-binding pattern — and the save then claims that id, so the files are
 * the note's own. An abandoned upload is an orphan row, which is the price
 * every pre-binding flow here already pays.
 */
interface Pending {
  id: string;
  name: string;
}

export function FeedNoteBox({
  entityType,
  entityId,
  labels,
}: {
  /** Where the note lands: the deal on a deal card, else the client, else the lead. */
  entityType: 'client' | 'lead' | 'deal';
  entityId: string;
  labels: { placeholder: string; save: string; saving: string; attach: string };
}) {
  const [state, submit, pending] = useActionState<ReplyState, FormData>(addFeedNoteAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Minted lazily on the first attachment; the note claims it on save.
  const [activityId, setActivityId] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    let noteId = activityId;
    if (!noteId) {
      noteId = uuidv4();
      setActivityId(noteId);
    }
    setUploading(true);
    for (const file of Array.from(list)) {
      const data = new FormData();
      data.set('file', file);
      data.set('entityType', 'crm_activity');
      data.set('entityId', noteId);
      const res = await fetch('/api/files/upload', { method: 'POST', body: data });
      if (res.ok) {
        const { id } = (await res.json()) as { id: string };
        setFiles((prev) => [...prev, { id, name: file.name }]);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <form
      ref={formRef}
      action={async (data) => {
        await submit(data);
        formRef.current?.reset();
        setFiles([]);
        setActivityId('');
      }}
      className="space-y-1.5"
      data-testid="feed-note-box"
    >
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      {files.length > 0 && <input type="hidden" name="activityId" value={activityId} />}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file) => (
            <span
              key={file.id}
              className="max-w-48 truncate rounded-lg bg-surface-sunken px-2 py-1 text-xs font-semibold"
            >
              📎 {file.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => void attach(event.target.files)}
        />
        <button
          type="button"
          aria-label={labels.attach}
          title={labels.attach}
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="btn-secondary btn-icon !min-h-9 shrink-0 disabled:opacity-50"
          data-testid="feed-note-attach"
        >
          {uploading ? '…' : '📎'}
        </button>
        <textarea
          name="note"
          rows={1}
          required
          placeholder={labels.placeholder}
          className="input-sm max-h-32 min-h-9 flex-1 resize-y py-2"
          data-testid="feed-note-body"
        />
        <button
          type="submit"
          className="btn-secondary !min-h-9 shrink-0"
          disabled={pending || uploading}
        >
          {pending ? labels.saving : labels.save}
        </button>
      </div>
      {state.error && <p className="w-full text-sm font-semibold text-bad">{state.error}</p>}
    </form>
  );
}
