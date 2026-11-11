'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  checkSums,
  fillRest,
  fromUnits,
  KG_SCALE,
  M3_SCALE,
  MAX_LINES,
  MIN_LINES,
  parseDraft,
  prefillByCartons,
  remainderOf,
  scaleToLot,
  storedUnits,
  tarkibLabel,
  toCount,
  type DraftLine,
  type DraftRefusal,
  type LotTotals,
} from '@/modules/wms/receipts/composition-math';
import { uploadAttachmentFile } from '@/components/upload-attachment';
import { isProposalWarning, type ProposalWarning } from '@/modules/wms/receipts/tarkib-proposal';
import {
  clearLotCompositionAction,
  saveLotCompositionAction,
  type CompositionActionResult,
} from './composition-actions';
import {
  cachedRead,
  forgetRead,
  ReadTodayLine,
  requestTarkibRead,
  storeRead,
  TarkibReadDialog,
  useProposalWords,
  type ReadToday,
  type StoredRead,
} from './tarkib-read-dialog';

/**
 * Lot tarkibi on the receipt card (docs/LOT-TARKIBI.md §8): the lot keeps its
 * body — cartons, letter, stickers — and the VED or the logist states what
 * the client's papers say it holds, against a document on THIS prixod. Only
 * the customs invoice, the packing lists and the agent file read it.
 *
 * `CompositionPanel` is NOT keyed (it holds `open` and the last ✅);
 * `CompositionEditor` IS, on the revision token — a token never repeats, so
 * any new composition remounts a stale editor instead of letting it post
 * against a revision that is gone.
 */

export interface PanelLine {
  id: string;
  seq: number;
  name: string;
  pieces: number | null;
  cartons: number | null;
  kg: string;
  m3: string;
  tnvedCode: string | null;
}

/**
 * What «Bitta tovar» fills the one row with (his 8.x A+, 2026-10-21): the
 * lot's own name, the TNVED the memory holds for it — the invoice prints a
 * line's OWN code only (fence 4), so a one-line tarkib typed to add pieces
 * would otherwise erase the code from the paper — and the pieces of the
 * prixod's confirmed job when it counts exactly one good in dona. Passed only
 * to a composition writer; never a price.
 */
export interface PanelOneGood {
  name: string;
  tnved: string | null;
  pieces: number | null;
  /** The lot's own names — a ONE-line tarkib vouches only for its own good (8.6). */
  zh: string;
  ru: string | null;
}

export interface PanelComposition {
  rev: number;
  seenBoxCount: number;
  lines: PanelLine[];
  /** The client's document, when one is cited (optional since 0143). */
  attachment: { id: string; fileName: string } | null;
  savedBy: string | null;
  /** The Tashkent day of the save (`tashkentDay`), never an ISO instant's UTC date. */
  savedDay: string;
}

export interface PanelDocument {
  id: string;
  fileName: string;
  /** The person may remove it: their own upload that no composition cites. */
  removable: boolean;
}

type Mode = 'separate' | 'mixed';
type Refusal = {
  error: string;
  seq?: number;
  field?: string;
  sums?: { sum: string; lot: string };
  tnvedCode?: string;
  /** «🤖 Fayldan to'ldirish»: the model's own sentence (`read_no_goods`), and the day's count beside a refusal. */
  detail?: string;
  today?: ReadToday;
};

/**
 * The rows came from «🤖 Fayldan to'ldirish» and nobody has saved them yet:
 * the notice above the lines, and which reading to forget once they are
 * saved. Kept in the draft, so a phone that reloaded the page mid-check still
 * says the figures are a machine's reading.
 */
type FilledFrom = { attachmentId: string; single: boolean; warnings: ProposalWarning[] };

/**
 * A photographed packing list is read by the model afterwards: the warehouse
 * screens' 0.3 MB / 1600 px (the carton photo's size) crushes the small print
 * of a table, so the document uploaded from HERE keeps more of itself. Every
 * other caller of the uploader keeps the default.
 */
const DOCUMENT_PHOTO = { maxSizeMB: 1, maxWidthOrHeight: 2000 } as const;

const EMPTY_LINE: DraftLine = { name: '', pieces: '', cartons: '', kg: '', m3: '', tnved: '' };

function draftKey(lotId: string, rev: number): string {
  return `tarkib-draft:${lotId}:${rev}`;
}

/** Errors that name nothing a person can fix by typing — said apart from the field ones. */
function refusalOfDraft(r: DraftRefusal): Refusal {
  switch (r.code) {
    case 'bad_number':
      return { error: r.code, seq: r.seq, field: r.field };
    case 'bad_line':
    case 'bad_tnved':
    case 'duplicate_name':
      return { error: r.code, seq: r.seq };
    case 'cartons_sum':
      return { error: r.code, sums: { sum: String(r.sum), lot: String(r.lot) } };
    case 'kg_sum':
    case 'm3_sum':
      return { error: r.code, sums: { sum: r.sum, lot: r.lot } };
    default:
      return { error: r.code };
  }
}

/**
 * Every refusal of the panel and the editor in words — ONE map, so a
 * refusal outside the editor (the voided prixod's clear, a document's ✕) is
 * a sentence too, never nothing on screen (the review's nit).
 */
function useRefusalText(): (r: Refusal) => string {
  const t = useTranslations('tarkib');
  const tr = useTranslations('receipts');
  const tv = useTranslations('receive');
  return (r: Refusal): string => {
    const seq = r.seq ?? 0;
    switch (r.error) {
      case 'uploading':
        return t('uploading');
      case 'upload_failed':
        return tr('attachFailed');
      // The card's own «Hujjatlar» panel says which — a scanned PDF over the
      // cap and a file type nobody stores both read «Fayl yuklanmadi» here.
      case 'too_large':
        return tv('fileTooLarge');
      case 'unsupported_type':
        return tv('fileTypeUnsupported');
      case 'in_use':
        return tr('attachInUse');
      case 'remove_failed':
        return tr('attachFailed');
      case 'forbidden':
        return t('errors.forbidden');
      case 'receipt_not_confirmed':
        return t('errors.receipt_not_confirmed');
      case 'lines_count':
        return t('errors.lines_count');
      case 'bad_line':
        return t('errors.bad_line', { seq });
      case 'bad_number':
        return r.field === 'kg'
          ? t('errors.bad_number_kg', { seq })
          : r.field === 'm3'
            ? t('errors.bad_number_m3', { seq })
            : r.field === 'pieces'
              ? t('errors.bad_number_pieces', { seq })
              : t('errors.bad_number_cartons', { seq });
      case 'bad_tnved':
        return t('errors.bad_tnved', { seq });
      case 'duplicate_name':
        return t('errors.duplicate_name', { seq });
      case 'cartons_partial':
        return t('errors.cartons_partial');
      case 'cartons_sum':
        return t('errors.cartons_sum', { sum: r.sums?.sum ?? '', lot: r.sums?.lot ?? '' });
      case 'kg_sum':
        return t('errors.kg_sum', { sum: r.sums?.sum ?? '', lot: r.sums?.lot ?? '' });
      case 'm3_sum':
        return t('errors.m3_sum', { sum: r.sums?.sum ?? '', lot: r.sums?.lot ?? '' });
      case 'document_not_on_receipt':
        return t('errors.document_not_on_receipt');
      case 'document_is_photo':
        return t('errors.document_is_photo');
      case 'lot_changed':
        return t('errors.lot_changed');
      case 'tnved_would_vanish':
        return t('errors.tnved_would_vanish', { code: r.tnvedCode ?? '' });
      case 'composition_changed':
        return t('errors.composition_changed');
      case 'composition_changed_self':
        return t('errors.composition_changed_self');
      case 'busy':
        return t('errors.busy');
      case 'server_behind':
        return t('errors.server_behind');
      // «🤖 Fayldan to'ldirish» (docs/TARKIB-TAKLIFLAR.md §3). Every code a
      // reading can answer has its OWN sentence — the default below would
      // say «Ma'lumot to'liq emas» about a file that is merely too large, and
      // the upload's `too_large` / `unsupported_type` above are another
      // door's words. Held against the route's list by
      // tests/unit/tarkib-read-wire.test.ts.
      case 'unauthorized':
        return t('read.errors.unauthorized');
      case 'read_unsupported':
        return t('read.errors.read_unsupported');
      case 'read_too_large':
        return t('read.errors.read_too_large');
      case 'read_broken':
        return t('read.errors.read_broken');
      case 'read_old_format':
        return t('read.errors.read_old_format');
      case 'read_encrypted':
        return t('read.errors.read_encrypted');
      case 'read_empty':
        return t('read.errors.read_empty');
      case 'read_no_goods':
        return r.detail ? `${t('read.errors.read_no_goods')} — ${r.detail}` : t('read.errors.read_no_goods');
      case 'file_unavailable':
        return t('read.errors.file_unavailable');
      case 'ai_not_configured':
        return t('read.errors.ai_not_configured');
      case 'cooling':
        return t('read.errors.cooling');
      case 'ai_off':
        return t('read.errors.ai_off');
      case 'ai_limit':
        return t('read.errors.ai_limit');
      case 'failed':
        return t('read.errors.failed');
      case 'ai_refused':
        return t('read.errors.ai_refused');
      case 'ai_truncated':
        return t('read.errors.ai_truncated');
      case 'ai_timeout':
        return t('read.errors.ai_timeout');
      case 'ai_failed':
        return t('read.errors.ai_failed');
      case 'ai_rejected':
        return t('read.errors.ai_rejected');
      case 'read_deadline':
        return t('read.errors.read_deadline');
      case 'read_offline':
        return t('read.errors.read_offline');
      default:
        return t('errors.validation');
    }
  };
}

export function CompositionPanel({
  lot,
  receiptId,
  composition,
  stale,
  canWrite,
  documents,
  frozenTrucks,
  openOnLoad,
  from,
  canClearOnly = false,
  oneGood = null,
}: {
  lot: { id: string; label: string; nameZh: string; boxCount: number; kg: string; m3: string };
  receiptId: string;
  composition: PanelComposition | null;
  stale: boolean;
  canWrite: boolean;
  documents: PanelDocument[];
  frozenTrucks: string[];
  openOnLoad: boolean;
  from: { batchId: string; code: string } | null;
  /**
   * A writer on a VOIDED prixod: no editor, but the composition stays
   * clearable — or the document it cites is undeletable for ever.
   */
  canClearOnly?: boolean;
  oneGood?: PanelOneGood | null;
}) {
  const t = useTranslations('tarkib');
  const errorText = useRefusalText();
  const [open, setOpen] = useState(openOnLoad && canWrite);
  const [clearing, setClearing] = useState(false);
  const [clearRefusal, setClearRefusal] = useState<Refusal | null>(null);
  const [saved, setSaved] = useState<{ cleared: boolean; frozen: string[] } | null>(null);

  if (!composition && !canWrite) return null;

  const totals: LotTotals = { boxCount: lot.boxCount, kg: lot.kg, m3: lot.m3 };
  const statedKg = composition
    ? fromUnits(composition.lines.reduce((s, l) => s + storedUnits(l.kg, KG_SCALE), 0), KG_SCALE)
    : '';
  const statedM3 = composition
    ? fromUnits(composition.lines.reduce((s, l) => s + storedUnits(l.m3, M3_SCALE), 0), M3_SCALE)
    : '';

  return (
    <div className="mt-2 space-y-2 text-sm" data-testid="lot-tarkib" data-lot={lot.id}>
      {composition && (
        <details className="rounded-lg bg-surface-sunken p-2">
          <summary className="cursor-pointer font-semibold">
            🧩 {t('title')}: {composition.lines.map((l) => l.name).join(' · ')}
          </summary>
          <ul className="mt-2 space-y-1">
            {composition.lines.map((l) => (
              <li key={l.id} className="text-ink-700">
                <span className="font-semibold">{l.name}</span>
                {' — '}
                {[
                  l.cartons !== null ? `${l.cartons} ${t('cartonsShort')}` : t('mixedCartons'),
                  l.pieces !== null ? `${l.pieces} ${t('piecesShort')}` : null,
                  `${l.kg} kg`,
                  `${l.m3} m³`,
                  l.tnvedCode,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-500">
            {composition.attachment && (
              <>
                📎{' '}
                <a
                  href={`/api/attachments/${composition.attachment.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 underline"
                >
                  {composition.attachment.fileName}
                </a>{' '}
                ·{' '}
              </>
            )}
            {t('savedBy', { name: composition.savedBy ?? '—', date: composition.savedDay })}
          </p>
        </details>
      )}
      {composition && stale && (
        <p className="text-xs font-semibold text-warn" data-testid="tarkib-stale">
          ⚠{' '}
          {t('stale', {
            stated: `${composition.seenBoxCount} ${t('cartonsShort')} · ${statedKg} kg · ${statedM3} m³`,
            current: `${lot.boxCount} ${t('cartonsShort')} · ${lot.kg} kg · ${lot.m3} m³`,
          })}
        </p>
      )}
      {canWrite && frozenTrucks.length > 0 && (
        <p className="text-xs text-ink-500" data-testid="tarkib-frozen">
          {t('frozenInfo', { trucks: frozenTrucks.join(', ') })}
        </p>
      )}
      {saved && (
        <p className="text-xs font-semibold text-good" data-testid="tarkib-saved">
          ✅ {saved.cleared ? t('cleared') : t('saved')}
          {saved.frozen.length > 0 && ` · ${t('savedFrozen', { trucks: saved.frozen.join(', ') })}`}
          {from && (
            <>
              {' · '}
              <Link href={`/batches/${from.batchId}/tnved`} className="text-brand-700 underline">
                {t('backToTruck', { code: from.code })}
              </Link>
            </>
          )}
        </p>
      )}
      {canWrite && !open && (
        <button
          type="button"
          className="btn-secondary !min-h-9 whitespace-normal px-2 text-sm"
          data-testid="lot-tarkib-open"
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
        >
          🧩 {composition ? t('edit') : t('open')}
        </button>
      )}
      {canClearOnly && composition && !saved && (
        <button
          type="button"
          data-testid="tarkib-clear"
          className="btn-secondary !min-h-9 whitespace-normal px-2 text-sm text-bad disabled:opacity-50"
          disabled={clearing}
          onClick={async () => {
            if (!window.confirm(t('clearConfirm'))) return;
            setClearing(true);
            setClearRefusal(null);
            try {
              const res = await clearLotCompositionAction({ lotId: lot.id, seenRev: composition.rev });
              if (res.ok) setSaved({ cleared: true, frozen: res.frozen });
              else setClearRefusal(res);
            } finally {
              setClearing(false);
            }
          }}
        >
          {t('clear')}
        </button>
      )}
      {canClearOnly && clearRefusal && (
        <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="tarkib-error">
          {errorText(clearRefusal)}
        </p>
      )}
      {canWrite && open && (
        <CompositionEditor
          key={composition?.rev ?? 0}
          lotId={lot.id}
          lotZh={lot.nameZh}
          receiptId={receiptId}
          totals={totals}
          composition={composition}
          documents={documents}
          oneGood={oneGood}
          onDone={(result) => {
            setOpen(false);
            setSaved(result);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function CompositionEditor({
  lotId,
  lotZh,
  receiptId,
  totals,
  composition,
  documents,
  oneGood,
  onDone,
  onCancel,
}: {
  lotId: string;
  /** The lot's Chinese name: a ONE-line tarkib that only repeats it changes no list. */
  lotZh: string;
  receiptId: string;
  totals: LotTotals;
  composition: PanelComposition | null;
  documents: PanelDocument[];
  oneGood: PanelOneGood | null;
  onDone: (result: { cleared: boolean; frozen: string[] }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('tarkib');
  const tc = useTranslations('common');
  const router = useRouter();
  const rev = composition?.rev ?? 0;
  const oneCarton = totals.boxCount === 1;

  const fromComposition = (): { mode: Mode; lines: DraftLine[]; doc: string | null } => {
    if (!composition) {
      // ONE row: a tarkib of one good is the common case now (his
      // 2026-10-27), and «+ qator» adds the rest.
      return { mode: oneCarton ? 'mixed' : 'separate', lines: [{ ...EMPTY_LINE }], doc: null };
    }
    return {
      mode: composition.lines.every((l) => l.cartons !== null) ? 'separate' : 'mixed',
      lines: composition.lines.map((l) => ({
        name: l.name,
        pieces: l.pieces !== null ? String(l.pieces) : '',
        cartons: l.cartons !== null ? String(l.cartons) : '',
        kg: l.kg,
        m3: l.m3,
        tnved: l.tnvedCode ?? '',
      })),
      doc: composition.attachment?.id ?? null,
    };
  };

  const [initial] = useState(fromComposition);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [lines, setLines] = useState<DraftLine[]>(initial.lines);
  const [doc, setDoc] = useState<string | null>(initial.doc);
  const [uploads, setUploads] = useState<PanelDocument[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // «🤖 Fayldan to'ldirish» (docs/TARKIB-TAKLIFLAR.md §3): the reading in
  // flight, the proposal on screen, and whether the rows below came from one.
  const [reading, setReading] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const [read, setRead] = useState<StoredRead | null>(null);
  const [filled, setFilled] = useState<FilledFrom | null>(null);
  // A reading may outlive the editor (a minute is long; «Bekor qilish» is one
  // tap): its answer is still KEPT for the next press, but no state is set
  // on an editor that has gone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The per-lot draft: fetching the client's PDF on a phone means leaving for
  // Telegram, and iOS may reload the standalone app (the receive wizard's own
  // reason). Every read and write in try/catch — a private window throws.
  /* eslint-disable react-hooks/set-state-in-effect -- the draft lives in
     localStorage, which the server render cannot read: it is restored after
     mount or the hydration would disagree with the server's HTML. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(draftKey(lotId, rev));
      if (!raw) return;
      const saved = JSON.parse(raw) as { mode?: Mode; lines?: DraftLine[]; doc?: string | null; filled?: FilledFrom | null };
      if (saved.mode) setMode(oneCarton ? 'mixed' : saved.mode);
      if (Array.isArray(saved.lines) && saved.lines.length > 0) setLines(saved.lines.slice(0, MAX_LINES));
      if (saved.doc !== undefined) setDoc(saved.doc);
      if (saved.filled && typeof saved.filled.attachmentId === 'string' && Array.isArray(saved.filled.warnings)) {
        setFilled({
          attachmentId: saved.filled.attachmentId,
          single: saved.filled.single === true,
          // Only what this build can word — the draft may be an older build's.
          warnings: saved.filled.warnings.filter(isProposalWarning),
        });
      }
    } catch {
      /* no draft — the fresh editor */
    }
  }, [lotId, rev, oneCarton]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey(lotId, rev), JSON.stringify({ mode, lines, doc, filled }));
    } catch {
      /* storage refused — the draft simply is not kept */
    }
  }, [lotId, rev, mode, lines, doc, filled]);

  function forgetDraft() {
    try {
      window.localStorage.removeItem(draftKey(lotId, rev));
    } catch {
      /* nothing to forget */
    }
  }

  // Server files merged with this editor's own uploads, by id.
  const docs = useMemo(() => {
    const byId = new Map<string, PanelDocument>();
    for (const d of [...documents, ...uploads]) if (!removed.includes(d.id)) byId.set(d.id, d);
    return [...byId.values()];
  }, [documents, uploads, removed]);

  // ONE line is the whole lot: its cartons ARE the lot's, so there is no
  // alohida/aralash to choose (both print the same numbers on every paper) —
  // the toggle and the cartons cell go, and the posted line carries the
  // lot's own count (his 2026-10-27, docs/UCH-BAND.md §4).
  const single = lines.length === 1;
  const shownMode: Mode = single ? 'separate' : mode;
  // What is posted: aralash keeps the cartons in state but sends them empty.
  const posted = useMemo(
    () =>
      single
        ? lines.map((l) => ({ ...l, cartons: String(totals.boxCount) }))
        : lines.map((l) => (mode === 'mixed' ? { ...l, cartons: '' } : l)),
    [lines, mode, single, totals.boxCount],
  );
  // The pure twin of `lotRuShownSql`: rows a person has named, in screen order.
  const shownName = tarkibLabel(
    posted.map((l, i) => ({ seq: i + 1, name: l.name.trim() })).filter((l) => l.name !== ''),
    lotZh,
  );
  const remainder = remainderOf(posted, totals);
  const prefill = shownMode === 'separate' ? prefillByCartons(posted, totals) : null;
  const scaleKg = scaleToLot(posted, totals, 'kg');
  const scaleM3 = scaleToLot(posted, totals, 'm3');

  function setCell(index: number, field: keyof DraftLine, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
    setRefusal(null);
  }

  async function addDocument(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setUploading((n) => n + 1);
    setRefusal(null);
    try {
      for (const file of list) {
        const res = await uploadAttachmentFile(file, 'receipt', receiptId, DOCUMENT_PHOTO);
        if (res.ok) {
          setUploads((prev) => [...prev, { id: res.item.id, fileName: res.item.fileName, removable: true }]);
          setDoc(res.item.id);
        } else {
          setRefusal({ error: res.error === 'failed' ? 'upload_failed' : res.error });
        }
      }
      // The card's own «Hujjatlar» panel re-seeds from the server (no action
      // revalidated anything here, so this refresh is the only one, #1242).
      router.refresh();
    } catch {
      // A photo the browser cannot decode (an HEIC with no codec) or a phone
      // gone offline THROWS out of the uploader; called as `void
      // addDocument(…)`, that was a rejection nobody heard — no chip, no
      // sentence, and a save that then said nothing either.
      setRefusal({ error: 'upload_failed' });
    } finally {
      setUploading((n) => n - 1);
    }
  }

  async function removeDocument(id: string) {
    setRefusal(null);
    const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setRemoved((prev) => [...prev, id]);
      if (doc === id) setDoc(null);
      router.refresh();
      return;
    }
    // A refusal in words, as the card's own «Hujjatlar» panel says it — a
    // document a colleague's composition cites just stayed put, silently.
    let code: string | undefined;
    try {
      code = ((await res.json()) as { error?: string }).error;
    } catch {
      /* non-JSON reply — the generic sentence */
    }
    setRefusal({ error: code === 'in_use' ? 'in_use' : 'remove_failed' });
  }

  // The document the button reads: the CHOSEN chip, and only while it is drawn.
  const chosen = doc !== null ? (docs.find((d) => d.id === doc) ?? null) : null;

  /**
   * «🤖 Fayldan to'ldirish»: the model reads the chosen document and the rows
   * it found are offered in a dialog. Nothing is written — «Qo'llash» fills
   * this editor's lines and «Saqlash» is still the person's press.
   *
   * A document read in the last half hour is SHOWN again, not paid for again
   * (`again` is the dialog's own «Qayta o'qish», asked first): a reading takes
   * up to a minute and one of the day's fifty. The answer is kept even when
   * the editor has gone meanwhile — only the state is not touched then.
   */
  async function readDocument(target: { id: string; fileName: string }, again: boolean) {
    if (reading) return;
    setRefusal(null);
    if (!again) {
      const kept = cachedRead(target.id);
      if (kept) {
        setRead(kept);
        setReadOpen(true);
        return;
      }
    }
    setReading(true);
    try {
      const answer = await requestTarkibRead(lotId, target.id);
      if (answer.ok) {
        const stored: StoredRead = {
          attachmentId: target.id,
          fileName: target.fileName,
          at: Date.now(),
          proposal: answer.proposal,
          today: answer.today ?? null,
        };
        storeRead(stored);
        if (alive.current) {
          setRead(stored);
          setReadOpen(true);
        }
      } else if (alive.current) {
        setRefusal({ error: answer.error, detail: answer.detail, today: answer.today });
      }
    } finally {
      // Always: a refusal, a dead connection and a deadline all hand the button back.
      if (alive.current) setReading(false);
    }
  }

  /** The ticked rows become this editor's lines — and nothing is saved. */
  function applyRead(next: DraftLine[]) {
    if (!read) return;
    setLines(next);
    setRefusal(null);
    setReadOpen(false);
    // The file that was read is the file the tarkib cites — while its chip is still drawn.
    if (docs.some((d) => d.id === read.attachmentId)) setDoc(read.attachmentId);
    setFilled({
      attachmentId: read.attachmentId,
      single: read.proposal.lotsOnReceipt <= 1,
      warnings: read.proposal.warnings,
    });
  }

  async function save() {
    if (uploading > 0) {
      setRefusal({ error: 'uploading' });
      return;
    }
    // The same parse and sums the server runs — the sentence without a round trip.
    const parsed = parseDraft(posted);
    if (!parsed.ok) return setRefusal(refusalOfDraft(parsed.refusal));
    const sums = checkSums(parsed.lines, totals);
    if (sums) return setRefusal(refusalOfDraft(sums));
    setPending(true);
    setRefusal(null);
    try {
      const res: CompositionActionResult = await saveLotCompositionAction({
        lotId,
        seenRev: rev,
        seenBoxCount: totals.boxCount,
        seenKg: totals.kg,
        seenM3: totals.m3,
        // Optional since 0143 — and only an id that is among the DRAWN chips:
        // a draft restored from localStorage may name a file since deleted,
        // which answered «hujjat shu prixodga yuklangan bo'lishi kerak» about
        // a chip nobody could see, let alone un-tick.
        attachmentId: doc !== null && docs.some((d) => d.id === doc) ? doc : null,
        lines: posted,
      });
      if (res.ok) {
        forgetDraft();
        // The reading has done its work once its rows are saved — on a prixod
        // of ONE lot. With several, the next lot ticks its own rows from the
        // same reading (a packing list covers the shipment), so it is kept
        // for its half hour rather than paid for again.
        if (filled?.single) forgetRead(filled.attachmentId);
        onDone({ cleared: false, frozen: res.frozen });
      } else {
        setRefusal(res);
      }
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    if (!window.confirm(t('clearConfirm'))) return;
    setPending(true);
    try {
      const res = await clearLotCompositionAction({ lotId, seenRev: rev });
      if (res.ok) {
        forgetDraft();
        onDone({ cleared: true, frozen: res.frozen });
      } else {
        setRefusal(res);
      }
    } finally {
      setPending(false);
    }
  }

  const refusedField = (r: Refusal | null): string | null =>
    !r?.seq ? null : r.error === 'bad_number' ? (r.field ?? null) : r.error === 'bad_tnved' ? 'tnved' : 'name';
  // Ring and scroll to the cell a refusal names.
  useEffect(() => {
    const field = refusedField(refusal);
    if (!refusal?.seq || !field) return;
    const el = document.querySelector<HTMLElement>(`[data-tarkib-cell="${lotId}-${refusal.seq}-${field}"]`);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, [refusal, lotId]);

  const ringed = (index: number, field: string) =>
    refusal?.seq === index + 1 && refusedField(refusal) === field ? ' ring-2 ring-bad' : '';

  const errorText = useRefusalText();
  const proposalWords = useProposalWords();

  const measure = (label: string, units: number | null, scale: number) => {
    if (units === null) return null;
    if (units === 0) return { text: t('remainderDone', { label }), tone: 'text-good' };
    if (units < 0) return { text: t('remainderOver', { label, value: fromUnits(-units, scale) }), tone: 'text-bad' };
    return { text: t('remainderLeft', { label, value: fromUnits(units, scale) }), tone: 'text-warn' };
  };
  const remainderParts = [
    measure('kg', remainder.kgUnits, KG_SCALE),
    measure('m³', remainder.m3Units, M3_SCALE),
    shownMode === 'separate' && !single ? measure(t('cartonsShort'), remainder.cartons ?? totals.boxCount, 0) : null,
  ].filter((p): p is { text: string; tone: string } => p !== null);

  const perCarton = (l: DraftLine): string | null => {
    if (shownMode !== 'separate') return null;
    const pieces = toCount(l.pieces);
    const cartons = toCount(l.cartons);
    if (pieces === null || cartons === null) return null;
    const n = pieces / cartons;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };

  return (
    <div className="space-y-3 rounded-lg border border-line p-2" data-testid="tarkib-editor">
      <p className="text-xs text-ink-500">{t('hint')}</p>

      {/* 1. The mode — only once there is more than one good to divide. */}
      {!single && (
        <div className="flex flex-wrap gap-2">
          {!oneCarton && (
            <button
              type="button"
              data-testid="tarkib-mode-separate"
              aria-pressed={mode === 'separate'}
              className={`chip !min-h-10 border ${mode === 'separate' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line'}`}
              onClick={() => setMode('separate')}
            >
              {t('modeSeparate')}
            </button>
          )}
          <button
            type="button"
            data-testid="tarkib-mode-mixed"
            aria-pressed={mode === 'mixed'}
            className={`chip !min-h-10 border ${mode === 'mixed' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line'}`}
            onClick={() => setMode('mixed')}
          >
            {t('modeMixed')}
          </button>
        </div>
      )}
      {shownMode === 'mixed' && (
        <p className="text-xs text-ink-500">{oneCarton ? t('oneCartonMixed') : t('modeMixedHint')}</p>
      )}

      {/* The rows below were read from the client's file by the model and
          nobody has saved them yet: said above them until «Saqlash», with
          whatever the reading itself warned about. */}
      {filled && (
        <div className="space-y-0.5 rounded-lg bg-warn/10 p-2 text-xs text-warn" data-testid="tarkib-filled">
          <p className="font-semibold">🤖 {t('read.filled')}</p>
          {filled.warnings.map((w, i) => (
            <p key={i} className="break-words">
              ⚠ {proposalWords.warning(w)}
            </p>
          ))}
        </div>
      )}

      {/* 2. The lines. One header row of labels from xl up. */}
      <div className="hidden text-xs font-semibold text-ink-700 xl:grid xl:grid-cols-[minmax(9rem,1fr)_minmax(4.5rem,6rem)_minmax(4.5rem,6rem)_minmax(5.5rem,7rem)_minmax(5.5rem,7rem)_minmax(7rem,9rem)_2.75rem] xl:items-end xl:gap-2">
        <span>{t('name')}</span>
        <span>{t('pieces')}</span>
        <span className={shownMode === 'mixed' || single ? 'invisible' : ''}>{t('cartons')}</span>
        <span>{t('kg')}</span>
        <span>{t('m3')}</span>
        <span>{t('tnved')}</span>
        <span />
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const cell = (field: string) => `${lotId}-${i + 1}-${field}`;
          const removable = lines.length > MIN_LINES;
          const per = perCarton(posted[i]!);
          const restKg = fillRest(posted, i, 'kg', totals);
          const restM3 = fillRest(posted, i, 'm3', totals);
          return (
            <div
              key={i}
              data-testid="tarkib-line"
              className="rounded-lg border border-line p-2 xl:grid xl:grid-cols-[minmax(9rem,1fr)_minmax(4.5rem,6rem)_minmax(4.5rem,6rem)_minmax(5.5rem,7rem)_minmax(5.5rem,7rem)_minmax(7rem,9rem)_2.75rem] xl:items-end xl:gap-2 xl:border-0 xl:p-0"
            >
              <div className="mb-1 flex items-center justify-between xl:hidden">
                <span className="text-xs font-bold text-ink-500">{t('line', { n: i + 1 })}</span>
                {removable && (
                  <button
                    type="button"
                    aria-label={t('removeLine')}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-bad"
                    onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
              <label className="block">
                <span className="label xl:sr-only">{t('name')}</span>
                <input
                  data-testid="tarkib-name"
                  data-tarkib-cell={cell('name')}
                  className={`input !min-h-10${ringed(i, 'name')}`}
                  value={l.name}
                  maxLength={200}
                  placeholder={i === 0 ? t('nameHint') : undefined}
                  onChange={(e) => setCell(i, 'name', e.target.value)}
                />
              </label>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5 xl:contents">
                <label className="block">
                  <span className="label xl:sr-only">{t('pieces')}</span>
                  <input
                    data-testid="tarkib-pieces"
                    data-tarkib-cell={cell('pieces')}
                    type="text"
                    inputMode="numeric"
                    className={`input !min-h-10${ringed(i, 'pieces')}`}
                    value={l.pieces}
                    onChange={(e) => setCell(i, 'pieces', e.target.value)}
                  />
                </label>
                <label className={`block${shownMode === 'mixed' || single ? ' invisible' : ''}`}>
                  <span className="label xl:sr-only">{t('cartons')}</span>
                  <input
                    data-testid="tarkib-cartons"
                    data-tarkib-cell={cell('cartons')}
                    type="text"
                    inputMode="numeric"
                    className={`input !min-h-10${ringed(i, 'cartons')}`}
                    value={l.cartons}
                    tabIndex={shownMode === 'mixed' || single ? -1 : undefined}
                    onChange={(e) => setCell(i, 'cartons', e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="label xl:sr-only">{t('kg')}</span>
                  <input
                    data-testid="tarkib-kg"
                    data-tarkib-cell={cell('kg')}
                    type="text"
                    inputMode="decimal"
                    className={`input !min-h-10${ringed(i, 'kg')}`}
                    value={l.kg}
                    onChange={(e) => setCell(i, 'kg', e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="label xl:sr-only">{t('m3')}</span>
                  <input
                    data-testid="tarkib-m3"
                    data-tarkib-cell={cell('m3')}
                    type="text"
                    inputMode="decimal"
                    className={`input !min-h-10${ringed(i, 'm3')}`}
                    value={l.m3}
                    onChange={(e) => setCell(i, 'm3', e.target.value)}
                  />
                </label>
              </div>
              <label className="mt-1.5 block xl:mt-0">
                <span className="label xl:sr-only">{t('tnved')}</span>
                <input
                  data-testid="tarkib-tnved"
                  data-tarkib-cell={cell('tnved')}
                  type="text"
                  inputMode="numeric"
                  className={`input !min-h-10 font-mono${ringed(i, 'tnved')}`}
                  value={l.tnved}
                  onChange={(e) => setCell(i, 'tnved', e.target.value)}
                />
              </label>
              <div className="hidden xl:block">
                {removable && (
                  <button
                    type="button"
                    aria-label={t('removeLine')}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-bad"
                    onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs xl:col-span-full xl:mt-0">
                <button
                  type="button"
                  data-testid="tarkib-fill-kg"
                  className="btn-secondary !min-h-9 whitespace-normal px-2 text-xs disabled:opacity-40"
                  disabled={restKg === null}
                  title={t('fillRest')}
                  onClick={() => restKg !== null && setCell(i, 'kg', restKg)}
                >
                  = kg
                </button>
                <button
                  type="button"
                  data-testid="tarkib-fill-m3"
                  className="btn-secondary !min-h-9 whitespace-normal px-2 text-xs disabled:opacity-40"
                  disabled={restM3 === null}
                  title={t('fillRest')}
                  onClick={() => restM3 !== null && setCell(i, 'm3', restM3)}
                >
                  = m³
                </button>
                {per !== null && (
                  <span data-testid="tarkib-per-carton" className="text-ink-500">
                    {t('perCarton', { n: per })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {lines.length < MAX_LINES && (
          <button
            type="button"
            data-testid="tarkib-add-line"
            className="btn-secondary !min-h-10 px-3 text-sm"
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          >
            {t('addLine')}
          </button>
        )}
        {oneGood && lines.length === 1 && (
          // Fills the one row with the WHOLE lot — a person pressed it and
          // sees every value before saving; nothing is filled by itself.
          <button
            type="button"
            data-testid="tarkib-one-good"
            className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm"
            onClick={() => {
              setLines([
                {
                  name: oneGood.name,
                  pieces: oneGood.pieces !== null ? String(oneGood.pieces) : '',
                  cartons: String(totals.boxCount),
                  kg: totals.kg,
                  m3: totals.m3,
                  tnved: oneGood.tnved ?? '',
                },
              ]);
              setRefusal(null);
            }}
          >
            {t('oneGood')}
          </button>
        )}
      </div>

      {/* 3. What the lists will call the lot (items 3-4): the tarkib's name
          stands where the lot's Russian name is shown — said here, live,
          before the save, because the name typed for the INVOICE is also
          what the stock, the plan and the truck card print from now on. */}
      {shownName !== null && (
        <p className="text-xs text-ink-500" data-testid="tarkib-shown-name">
          {t('shownName', { name: shownName })}
        </p>
      )}

      {/* 4. The person-pressed helpers. */}
      {(prefill || scaleKg || scaleM3) && (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            {prefill && (
              <button
                type="button"
                data-testid="tarkib-prefill"
                className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm"
                onClick={() => setLines((prev) => prev.map((l, i) => ({ ...l, kg: prefill[i]!.kg, m3: prefill[i]!.m3 })))}
              >
                {t('prefill')}
              </button>
            )}
            {scaleKg && (
              <button
                type="button"
                data-testid="tarkib-scale-kg"
                className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm"
                onClick={() => setLines((prev) => prev.map((l, i) => ({ ...l, kg: scaleKg[i]! })))}
              >
                {t('scaleKg')}
              </button>
            )}
            {scaleM3 && (
              <button
                type="button"
                data-testid="tarkib-scale-m3"
                className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm"
                onClick={() => setLines((prev) => prev.map((l, i) => ({ ...l, m3: scaleM3[i]! })))}
              >
                {t('scaleM3')}
              </button>
            )}
          </div>
          {(scaleKg || scaleM3) && <p className="text-xs text-ink-500">{t('scaleHint')}</p>}
        </div>
      )}

      {/* 5. The client's document — OPTIONAL since 0143 (the owner,
          2026-11-10): it stood first and was demanded last, after every
          line was typed and balanced. Below the lines now, and «none» is a
          real choice: a chosen chip un-chooses on a second press. */}
      <div className="space-y-1">
        <p className="label">{t('document')}</p>
        <div className="flex flex-wrap gap-2">
          {docs.length === 0 && <span className="text-xs text-ink-500">{t('documentNone')}</span>}
          {docs.map((d) => (
            <span key={d.id} className="inline-flex max-w-full items-center gap-1">
              <button
                type="button"
                data-testid="tarkib-doc"
                data-id={d.id}
                aria-pressed={doc === d.id}
                className={`chip !min-h-10 max-w-[14rem] border ${doc === d.id ? 'border-brand-600 bg-brand-50 text-brand-800 ring-2 ring-brand-500' : 'border-line bg-surface'}`}
                onClick={() => setDoc(doc === d.id ? null : d.id)}
              >
                <span className="truncate">📄 {d.fileName}</span>
              </button>
              <a
                href={`/api/attachments/${d.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-brand-700 underline"
                aria-label={d.fileName}
              >
                ↗
              </a>
              {d.removable && d.id !== composition?.attachment?.id && (
                <button
                  type="button"
                  aria-label="✕"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-xs text-bad"
                  onClick={() => void removeDocument(d.id)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <label className="btn-secondary !min-h-10 cursor-pointer whitespace-normal px-3 text-sm">
            {uploading > 0 ? '⏳' : '📎'} {t('documentUpload')}
            <input
              type="file"
              className="hidden"
              data-testid="tarkib-upload"
              onChange={(e) => {
                void addDocument(e.target.files);
                e.currentTarget.value = '';
              }}
            />
          </label>
          {/* «🤖 Fayldan to'ldirish» (the owner, 2026-11-11): the model reads
              the CHOSEN document and offers its rows — the file read is the
              file the tarkib will cite, so there is no second upload. Nothing
              is saved by it. */}
          <button
            type="button"
            data-testid="tarkib-read"
            className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm disabled:opacity-50"
            disabled={chosen === null || reading || uploading > 0 || pending}
            onClick={() => {
              if (chosen) void readDocument(chosen, false);
            }}
          >
            {reading ? '⏳' : '🤖'} {reading ? t('read.reading') : t('read.button')}
          </button>
        </div>
        <p className="text-xs text-ink-500">{t('docWhere')}</p>
        {chosen === null && (
          <p className="text-xs text-ink-500" data-testid="tarkib-read-hint">
            🤖 {t('read.hint')}
          </p>
        )}
      </div>

      {/* 6. The refusal, and the way out of the two that need a reload. */}
      {refusal && (
        <div className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="tarkib-error">
          <p>{errorText(refusal)}</p>
          {refusal.today && <ReadTodayLine today={refusal.today} />}
          {(refusal.error === 'lot_changed' ||
            refusal.error === 'composition_changed' ||
            refusal.error === 'composition_changed_self') && (
            <button
              type="button"
              className="btn-secondary mt-1 !min-h-9 whitespace-normal px-3 text-sm"
              onClick={() => {
                if (refusal.error !== 'lot_changed') forgetDraft();
                setRefusal(null);
                router.refresh();
              }}
            >
              🔄 {refusal.error === 'lot_changed' ? t('reload') : t('reloadLoses')}
            </button>
          )}
        </div>
      )}

      {/* 7. The sticky bar: the remainder on screen while the keyboard is up. */}
      <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2 shadow md:bottom-2">
        <p className="min-w-0 flex-1 text-xs font-semibold" data-testid="tarkib-remainder">
          {remainderParts.map((p, i) => (
            <span key={i} className={p.tone}>
              {i > 0 && <span className="text-ink-400"> · </span>}
              {p.text}
            </span>
          ))}
          {remainder.incomplete && <span className="block font-normal text-ink-500">{t('remainderIncomplete')}</span>}
        </p>
        <button
          type="button"
          data-testid="tarkib-save"
          className="btn-primary !min-h-10 whitespace-normal px-4 disabled:opacity-50"
          disabled={pending}
          onClick={() => void save()}
        >
          {pending ? tc('loading') : t('save')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary !min-h-10 px-3 text-sm" disabled={pending} onClick={onCancel}>
          {tc('cancel')}
        </button>
        {composition && (
          <button
            type="button"
            data-testid="tarkib-clear"
            className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm text-bad disabled:opacity-50"
            disabled={pending}
            onClick={() => void clear()}
          >
            {t('clear')}
          </button>
        )}
      </div>

      {/* The reading's rows, ticked by the person. Kept MOUNTED and toggled
          (an Overlay mounted already open closes itself); a portal, so it is
          no child of this box's layout. */}
      <TarkibReadDialog
        open={readOpen}
        read={read}
        lot={{ zh: lotZh, ru: oneGood?.ru ?? null }}
        totals={totals}
        existing={lines}
        busy={reading}
        error={readOpen && refusal ? errorText(refusal) : null}
        onApply={applyRead}
        onAgain={() => {
          if (read) void readDocument({ id: read.attachmentId, fileName: read.fileName }, true);
        }}
        onClose={() => setReadOpen(false)}
      />
    </div>
  );
}
