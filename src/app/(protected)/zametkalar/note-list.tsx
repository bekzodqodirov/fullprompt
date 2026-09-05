'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  deleteNoteAction,
  removeNotePartAction,
  saveNoteAction,
  setNoteSharedAction,
  setPartSendAsAction,
  type NoteFormState,
} from './actions';

export interface NotePart {
  id: string;
  attachmentId: string;
  fileName: string;
  sendAs: 'photo' | 'document';
}

export interface NoteRowView {
  id: string;
  title: string;
  body: string;
  location: string;
  placeTitle: string;
  placeAddress: string;
  sortOrder: number;
  shared: boolean;
  parts: NotePart[];
}

/** The company's zametkalar plus this person's own, in the bot's own order. */
export function NoteList({
  notes,
  canShare,
  maxParts,
}: {
  notes: NoteRowView[];
  canShare: boolean;
  maxParts: number;
}) {
  const t = useTranslations('notes');
  const tc = useTranslations('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      {/* Add FIRST, list after — the templates and cost-types shape, and
          load-bearing on a phone: at the list's end the button slides under
          the fixed tab bar as soon as the list grows past a screenful. */}
      {adding ? (
        <NoteForm
          canShare={canShare}
          maxParts={maxParts}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          data-testid="add-note"
          className="btn-primary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('add')}
        </button>
      )}

      {notes.length === 0 && !adding && (
        <p className="card text-center text-sm text-ink-500" data-testid="notes-empty">
          {t('none')}
        </p>
      )}

      {notes.map((note) => (
        <div key={note.id} className="card scroll-mb-28 space-y-2 !p-3" data-testid="note-row">
          {/* flex-wrap, no shrink-0: a long title beside two buttons is the
              row that overflows 360 px and makes mobile Chrome zoom the whole
              page out (#400). */}
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="min-w-0 font-bold [overflow-wrap:anywhere]">
              {note.shared && <span title={t('shared')}>🏢 </span>}
              {note.title}
            </span>
            <span className="ml-auto flex gap-2">
              {canShare && (
                <button
                  type="button"
                  data-testid="note-scope"
                  disabled={pending}
                  className="btn-secondary !min-h-9 px-2 text-sm disabled:opacity-60"
                  onClick={() => {
                    if (note.shared && !window.confirm(t('confirmUnshare'))) return;
                    start(async () => {
                      await setNoteSharedAction(note.id, !note.shared);
                      router.refresh();
                    });
                  }}
                >
                  {note.shared ? t('makePrivate') : t('makeShared')}
                </button>
              )}
              <button
                type="button"
                data-testid="edit-note"
                className="btn-secondary !min-h-9 px-2 text-sm"
                onClick={() => setEditingId(editingId === note.id ? null : note.id)}
              >
                ✏️ {tc('edit')}
              </button>
              <button
                type="button"
                data-testid="delete-note"
                disabled={pending}
                className="btn-secondary !min-h-9 px-2 text-sm disabled:opacity-60"
                onClick={() => {
                  if (!window.confirm(t('confirmDelete'))) return;
                  start(async () => {
                    await deleteNoteAction(note.id);
                    router.refresh();
                  });
                }}
              >
                🗑️
              </button>
            </span>
          </div>

          {note.body && (
            <p className="whitespace-pre-wrap text-sm text-ink-500 [overflow-wrap:anywhere]">
              {note.body}
            </p>
          )}
          {note.placeAddress && (
            <p className="text-sm text-ink-500 [overflow-wrap:anywhere]">📍 {note.placeAddress}</p>
          )}

          {note.parts.length > 0 && (
            <ul className="space-y-1" data-testid="note-parts">
              {note.parts.map((part) => (
                <li key={part.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    {part.sendAs === 'photo' ? '🖼' : '📄'} {part.fileName}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button
                      type="button"
                      data-testid="part-send-as"
                      disabled={pending}
                      className="btn-secondary !min-h-9 px-2 text-xs disabled:opacity-60"
                      onClick={() =>
                        start(async () => {
                          await setPartSendAsAction(
                            part.id,
                            part.sendAs === 'photo' ? 'document' : 'photo',
                          );
                          router.refresh();
                        })
                      }
                    >
                      {part.sendAs === 'photo' ? t('asFile') : t('asPhoto')}
                    </button>
                    <button
                      type="button"
                      data-testid="delete-part"
                      disabled={pending}
                      className="btn-secondary !min-h-9 px-2 text-xs disabled:opacity-60"
                      onClick={() => {
                        if (!window.confirm(t('confirmDeletePart'))) return;
                        start(async () => {
                          await removeNotePartAction(part.id);
                          router.refresh();
                        });
                      }}
                    >
                      🗑️
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {editingId === note.id && (
            <NoteForm
              note={note}
              canShare={canShare}
              maxParts={maxParts}
              onDone={() => setEditingId(null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function NoteForm({
  note,
  canShare,
  maxParts,
  onDone,
}: {
  note?: NoteRowView;
  canShare: boolean;
  maxParts: number;
  onDone?: () => void;
}) {
  const t = useTranslations('notes');
  const tc = useTranslations('common');
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  // Minted once per form: uploads are pre-bound to it before the note exists,
  // and the save then claims them (#180 — a server action's body is capped at
  // 1 MB and cannot carry a file, #291).
  const [noteId] = useState(() => note?.id ?? uuidv4());
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [state, setState] = useState<NoteFormState>({});
  const [busy, setBusy] = useState(false);
  // Controlled, because a refused save must keep every typed value — React
  // resets an uncontrolled form after a form Action (#377/#419/#463).
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [location, setLocation] = useState(note?.location ?? '');
  const [placeTitle, setPlaceTitle] = useState(note?.placeTitle ?? '');
  const [placeAddress, setPlaceAddress] = useState(note?.placeAddress ?? '');
  const [sortOrder, setSortOrder] = useState(String(note?.sortOrder ?? 100));
  const [shared, setShared] = useState(note?.shared ?? false);

  const partsNow = (note?.parts.length ?? 0) + uploaded.length;

  useEffect(() => {
    if (state.ok) onDone?.();
  }, [state, onDone]);

  // Literal map — the i18n fence cannot see a key built at runtime (#163).
  const errors: Record<string, string> = {
    forbidden: t('errors.forbidden'),
    validation: t('errors.validation'),
    not_found: t('errors.notFound'),
    note_empty: t('errors.empty'),
    title_taken: t('errors.titleTaken'),
    too_many_parts: t('errors.tooManyParts'),
    bad_location: t('errors.badLocation'),
    unauthenticated: t('errors.forbidden'),
  };

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploadError(null);
    for (const file of Array.from(list)) {
      if (partsNow + uploaded.length >= maxParts) {
        setUploadError(t('errors.tooManyParts'));
        break;
      }
      setUploading((n) => n + 1);
      try {
        const data = new FormData();
        data.set('file', file);
        data.set('entityType', 'staff_note');
        data.set('entityId', noteId);
        const res = await fetch('/api/files/upload', {
          method: 'POST',
          body: data,
          // A stuck upload must say so, not spin for ever (round 97's rule).
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(String(res.status));
        setUploaded((prev) => [...prev, file.name]);
      } catch {
        setUploadError(t('errors.upload'));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    // AFTER the handler: clearing first empties input.files, and without the
    // clear re-picking the SAME file fires no change event at all (#762).
    if (fileRef.current) fileRef.current.value = '';
  }

  async function save() {
    setBusy(true);
    const data = new FormData();
    data.set('id', noteId);
    data.set('title', title);
    data.set('body', body);
    data.set('location', location);
    data.set('placeTitle', placeTitle);
    data.set('placeAddress', placeAddress);
    data.set('sortOrder', sortOrder);
    if (shared) data.set('shared', 'on');
    const result = await saveNoteAction({}, data);
    setBusy(false);
    setState(result);
    if (result.ok) router.refresh();
  }

  return (
    <div className="space-y-2 rounded-lg bg-surface-sunken p-3" data-testid="note-form">
      <input
        className="input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('fieldTitle')}
        aria-label={t('fieldTitle')}
        maxLength={64}
      />
      {/* `h-28`, never `min-h-28`: `.input` already sets `min-h-12` and wins on
          source order, so the taller box is asked for with a HEIGHT (#419). */}
      <textarea
        className="input h-28 py-2"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('fieldBody')}
        aria-label={t('fieldBody')}
        maxLength={3000}
      />
      {/* ONE box for the point: what a map app puts on the clipboard is
          «41.311081, 69.240562» or a link, and two decimal-degree inputs
          refuse both. */}
      <input
        className="input"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        placeholder={t('fieldLocation')}
        aria-label={t('fieldLocation')}
        maxLength={300}
      />
      <input
        className="input"
        value={placeTitle}
        onChange={(e) => setPlaceTitle(e.target.value)}
        placeholder={t('fieldPlaceTitle')}
        aria-label={t('fieldPlaceTitle')}
        maxLength={80}
      />
      <input
        className="input"
        value={placeAddress}
        onChange={(e) => setPlaceAddress(e.target.value)}
        placeholder={t('fieldPlaceAddress')}
        aria-label={t('fieldPlaceAddress')}
        maxLength={300}
      />

      <label className="flex items-center gap-2 text-sm">
        <span className="shrink-0">{t('fieldOrder')}</span>
        <input
          type="number"
          min={0}
          max={10000}
          className="input"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          aria-label={t('fieldOrder')}
        />
      </label>

      <div className="space-y-1">
        <input
          ref={fileRef}
          type="file"
          multiple
          data-testid="note-file"
          className="input py-2"
          aria-label={t('fieldFiles')}
          onChange={(e) => void attach(e.target.files)}
        />
        <p className="text-xs text-ink-500">{t('filesHint', { max: maxParts })}</p>
        {uploaded.length > 0 && (
          <p className="text-xs text-ink-500" data-testid="note-uploaded">
            📎 {uploaded.join(', ')}
          </p>
        )}
        {uploading > 0 && <p className="text-xs text-ink-500">{t('uploading')}</p>}
        {uploadError && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {uploadError}
          </p>
        )}
      </div>

      {/* Publishing to the company is a larger power than keeping a note: it
          is a one-tap broadcast every colleague can forward to a customer. */}
      {/* Only when CREATING: moving an existing note between the two lists is
          its own button on the row, so a typo fix can never take the
          company's address sheet away from everybody. */}
      {canShare && !note && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="note-shared"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="mt-0.5 size-5 shrink-0"
          />
          <span>{t('sharedHint')}</span>
        </label>
      )}

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid="note-error">
          {errors[state.error] ?? state.error}
        </p>
      )}

      <button
        type="button"
        data-testid="save-note"
        disabled={busy || uploading > 0}
        className="btn-primary w-full disabled:opacity-60"
        onClick={() => void save()}
      >
        {busy ? '…' : tc('save')}
      </button>
    </div>
  );
}
