'use client';

import { compressPhoto } from '@/components/compress-photo';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { computeLotTotals } from '@/modules/wms/receipts/math';
import { DensityBadge } from '@/components/density-badge';
import { LightboxImg } from '@/components/lightbox-img';
import { PrintLabels } from '@/components/print-labels';
import { submitReceiptAction, type SubmitReceiptResult } from './actions';

/**
 * Single-window receiving (owner's request): client on top, product LINES in
 * the middle — a real spreadsheet-style table on desktop (tab through
 * cells like Excel), the original stacked-card layout on mobile — then
 * receipt-level attachments + costs + notes together (not collapsed), and a
 * sticky totals/confirm bar. Draft autosaves to localStorage after every
 * change.
 */

interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  country: string;
}
interface CostTypeOption {
  id: string;
  code: string;
  name: string;
}
interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
  managerName: string | null;
}

interface LotDraft {
  id: string;
  zh: string;
  ru: string;
  boxCount: string;
  dimsMode: 'uniform' | 'mixed';
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  boxWeightKg: string;
  totalWeightKg: string;
  totalVolumeM3: string;
  photoIds: string[];
}

interface CostDraft {
  costTypeId: string;
  amount: string;
  currency: string;
}

interface Draft {
  receiptId: string;
  warehouseId: string;
  clientId: string | null;
  clientLabel: string;
  /**
   * The job this cargo was quoted under, when there is one. Optional for ever
   * — plenty of cargo arrives with no quote behind it, and that case is
   * exactly what the price-control alert shouts about (docs/DEALS.md).
   */
  dealId: string | null;
  unclaimed: boolean;
  unclaimedMarking: string;
  sourceNote: string;
  lots: LotDraft[];
  costs: CostDraft[];
  files: { id: string; fileName: string; contentType: string; kind: string }[];
  /** Receipt-level photos of the overall boxes (owner's request). */
  generalPhotoIds: string[];
  /** The promise this receipt answers, when it was opened from one. */
  expectedArrivalId: string | null;
}

/** Everything a tapped promise already knows — the operator types the rest. */
export interface ArrivalPrefill {
  arrivalId: string;
  warehouseId: string;
  clientId: string | null;
  clientLabel: string;
  marking: string;
  boxCount: number | null;
  weightKg: number | null;
  volumeM3: number | null;
}

const DRAFT_KEY = 'gsr-receipt-draft';

/**
 * The busy slot the two RECEIPT-level uploaders share (round 97).
 *
 * A lot's spinner is keyed by its own id; the general box photos and the
 * receipt's files belong to no lot and sit on the same card, so one key for
 * both is what the eye expects — and a uuid cannot collide with it.
 */
const RECEIPT_SLOT = 'receipt';

function newLot(): LotDraft {
  return {
    id: uuidv4(),
    zh: '',
    ru: '',
    boxCount: '',
    dimsMode: 'uniform',
    lengthCm: '',
    widthCm: '',
    heightCm: '',
    boxWeightKg: '',
    totalWeightKg: '',
    totalVolumeM3: '',
    photoIds: [],
  };
}

function newDraft(warehouseId: string): Draft {
  return {
    receiptId: uuidv4(),
    warehouseId,
    clientId: null,
    clientLabel: '',
    dealId: null,
    unclaimed: false,
    unclaimedMarking: '',
    sourceNote: '',
    lots: [newLot()],
    costs: [],
    files: [],
    generalPhotoIds: [],
    expectedArrivalId: null,
  };
}

function lotTotals(lot: LotDraft) {
  const boxCount = Number(lot.boxCount) || 0;
  if (!boxCount) return null;
  if (lot.dimsMode === 'uniform') {
    const [l, w, h, kg] = [
      Number(lot.lengthCm),
      Number(lot.widthCm),
      Number(lot.heightCm),
      Number(lot.boxWeightKg),
    ];
    if (!l || !w || !h || !kg) return null;
    return computeLotTotals(
      { dimsMode: 'uniform', boxCount, boxLengthCm: l, boxWidthCm: w, boxHeightCm: h, boxWeightKg: kg },
      167,
    );
  }
  const totalKg = Number(lot.totalWeightKg);
  const totalM3 = Number(lot.totalVolumeM3);
  if (!totalKg || !totalM3) return null;
  return computeLotTotals(
    { dimsMode: 'mixed', boxCount, totalWeightKg: totalKg, totalVolumeM3: totalM3 },
    167,
  );
}

export function ReceiveWizard({
  warehouses,
  costTypes,
  currencies,
  densityThresholds,
  prefill = null,
  canPickDeal = false,
}: {
  warehouses: WarehouseOption[];
  costTypes: CostTypeOption[];
  currencies: string[];
  /** From admin settings — the owner's numbers, not a constant of ours. */
  densityThresholds: { light: number; medium: number; heavy: number };
  /** Set when opened from a promise's «Qabul qilish» button. */
  prefill?: ArrivalPrefill | null;
  /** Whoever may write a deal. The warehouse may not, and must not be asked. */
  canPickDeal?: boolean;
}) {
  const t = useTranslations('receive');
  const tc = useTranslations('common');
  const td = useTranslations('deals');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [openDeals, setOpenDeals] = useState<
    { id: string; code: string; title: string | null; quotedAmount: string | null; quotedCurrency: string | null }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [letterPreview, setLetterPreview] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /**
   * How many photographs are being shrunk and sent RIGHT NOW, per lot.
   *
   * The screen used to say nothing at all between «I chose a photo» and «a
   * thumbnail appeared», and that gap is where the owner's report lives: on a
   * warehouse phone it was thirteen seconds and more, so the operator saw a
   * dead screen, a confirm button that stayed grey, and no reason for either.
   * A counter rather than a boolean because the 📷 takes several files at
   * once, and the last one to land must be the one that clears it.
   */
  const [busyLots, setBusyLots] = useState<Record<string, number>>({});
  const photoBusy = (lotId: string) => (busyLots[lotId] ?? 0) > 0;
  const anyPhotoBusy = Object.values(busyLots).some((n) => n > 0);
  const markBusy = (lotId: string, delta: 1 | -1) =>
    setBusyLots((current) => ({ ...current, [lotId]: Math.max(0, (current[lotId] ?? 0) + delta) }));
  const [result, setResult] = useState<SubmitReceiptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draft restore — localStorage is client-only, hence the mount effect.
  useEffect(() => {
    // Opened from a promise's «Qabul qilish»: the tap IS the intent, so the
    // promise wins over whatever half-draft the browser was holding. Client,
    // count and measures arrive filled; the totals land as a 'mixed' lot the
    // operator corrects against the real boxes.
    if (prefill) {
      const lot = newLot();
      if (prefill.boxCount) lot.boxCount = String(prefill.boxCount);
      if (prefill.weightKg !== null || prefill.volumeM3 !== null) {
        lot.dimsMode = 'mixed';
        lot.totalWeightKg = prefill.weightKg !== null ? String(prefill.weightKg) : '';
        lot.totalVolumeM3 = prefill.volumeM3 !== null ? String(prefill.volumeM3) : '';
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft({
        ...newDraft(prefill.warehouseId),
        clientId: prefill.clientId,
        clientLabel: prefill.clientLabel,
        unclaimed: !prefill.clientId,
        unclaimedMarking: prefill.clientId ? '' : prefill.marking,
        lots: [lot],
        expectedArrivalId: prefill.arrivalId,
      });
      return;
    }
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<Draft>;
        if (parsed.receiptId && Array.isArray(parsed.lots)) {
          // Backfill fields added after this draft was saved (schema grows
          // over time; a stale localStorage draft must never crash the page).
          // The saved warehouse may no longer be allowed for THIS user (same
          // browser, different account) — snap it back to an allowed one so
          // confirm can't hit "Warehouse out of scope".
          const allowedWh = warehouses.some((wh) => wh.id === parsed.warehouseId)
            ? parsed.warehouseId!
            : (warehouses[0]?.id ?? '');
          const backfilled: Draft = {
            ...parsed,
            warehouseId: allowedWh,
            costs: parsed.costs ?? [],
            files: parsed.files ?? [],
            generalPhotoIds: parsed.generalPhotoIds ?? [],
            expectedArrivalId: parsed.expectedArrivalId ?? null,
            lots: parsed.lots.map((lot) => ({ ...newLot(), ...lot })),
          } as Draft;
          setDraft(backfilled);
          return;
        }
      } catch {
        /* corrupt draft — start fresh */
      }
    }
     
    setDraft(newDraft(warehouses[0]?.id ?? ''));
  }, [warehouses, prefill]);

  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);

  /**
   * The client's open jobs.
   *
   * Loaded only once a client is chosen, and silent when it fails: linking the
   * cargo to its job is valuable, but a receipt of real boxes must never be
   * held up because a lookup did not answer.
   */
  useEffect(() => {
    const clientId = draft?.clientId;
    if (!clientId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenDeals([]);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/deals/open?client=${clientId}`);
        if (res.ok && live) setOpenDeals((await res.json()).results ?? []);
      } catch {
        // no deals offered; the receipt still saves
      }
    })();
    return () => {
      live = false;
    };
  }, [draft?.clientId]);

  const updateLot = useCallback((lotId: string, patch: Partial<LotDraft>) => {
    setDraft((d) =>
      d ? { ...d, lots: d.lots.map((l) => (l.id === lotId ? { ...l, ...patch } : l)) } : d,
    );
  }, []);

  // Client autocomplete. `searching` gates the "unknown cargo" offer: until
  // the lookup has actually answered we must not claim the code is unknown —
  // for an existing code that button flashed up for a moment and a fast tap
  // filed the receipt as unclaimed.
  useEffect(() => {
    if (!clientQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClientHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/clients/search?q=${encodeURIComponent(clientQuery)}`);
        if (res.ok) setClientHits(((await res.json()) as { results: ClientHit[] }).results);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [clientQuery]);

  // Letter preview
  useEffect(() => {
    if (!draft?.warehouseId || draft.lots.length === 0) return;
    const timer = setTimeout(async () => {
      const res = await fetch(
        `/api/receive/preview?warehouseId=${draft.warehouseId}&count=${draft.lots.length}`,
      );
      if (res.ok) setLetterPreview(((await res.json()) as { letters: string[] }).letters);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft?.warehouseId, draft?.lots.length]);

  if (!draft) return null;

  const warehouse = warehouses.find((w) => w.id === draft.warehouseId);
  const defaultCurrency = warehouse?.country === 'CN' ? 'CNY' : 'USD';

  /**
   * Server rejection → human message (file type / size), not just "failed".
   *
   * The fall-through used to be «check the connection» for EVERY answer the
   * route gave, which sends the operator — and whoever they telephone — in the
   * wrong direction. The one that matters is 401: on a deploy morning a
   * session can expire while the page still looks signed in, and the screen
   * was telling a warehouse with perfect wifi that its wifi was broken
   * (round 97). A 5xx is ours, and saying so is what gets it reported.
   */
  async function uploadErrorText(res: Response): Promise<string> {
    if (res.status === 401 || res.status === 403) return t('photoUploadSignedOut');
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'unsupported_type') return t('fileTypeUnsupported');
      if (body.error === 'too_large') return t('fileTooLarge');
    } catch {
      /* non-JSON reply — fall through */
    }
    if (res.status >= 500) return t('photoUploadServer');
    return t('photoUploadFailed');
  }

  /**
   * The upload, with an end to it.
   *
   * Nothing between the browser and MinIO imposes a deadline — not `fetch`,
   * not the route, not the S3 client — so a wedged object store used to leave
   * the request hanging for as long as the operator was willing to stare at
   * it. That was survivable while the screen said nothing; now that it shows
   * ⏳ it would show ⏳ for ever, and a spinner that never stops is a worse lie
   * than no spinner at all.
   *
   * Two minutes: long enough for a large photograph over a bad warehouse
   * connection, short enough that the operator gets a sentence and a retry
   * rather than a shift.
   */
  async function uploadWithDeadline(formData: FormData): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
      return await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function removeAttachment(id: string, apply: () => void) {
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
      // 404 = already gone server-side; still drop it from the draft.
      if (res.ok || res.status === 404) apply();
      else setError(tc('error'));
    } catch {
      setError(tc('error')); // offline — the ✕ visibly did nothing otherwise
    }
  }

  async function translateLot(lot: LotDraft) {
    if (!lot.zh.trim() || lot.ru) return;
    const res = await fetch(`/api/translate?zh=${encodeURIComponent(lot.zh)}`);
    if (res.ok) {
      const hit = (await res.json()) as { ru: string | null };
      if (hit.ru) updateLot(lot.id, { ru: hit.ru });
    }
  }

  async function addPhotos(lot: LotDraft, files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      markBusy(lot.id, 1);
      try {
        const compressed = await compressPhoto(file);
        const formData = new FormData();
        formData.set('file', compressed);
        formData.set('entityType', 'receipt_lot');
        formData.set('entityId', lot.id);
        const res = await uploadWithDeadline(formData);
        if (res.ok) {
          const { id } = (await res.json()) as { id: string };
          setDraft((d) =>
            d
              ? {
                  ...d,
                  lots: d.lots.map((l) =>
                    l.id === lot.id ? { ...l, photoIds: [...l.photoIds, id] } : l,
                  ),
                }
              : d,
          );
        } else {
          setError(await uploadErrorText(res));
        }
      } catch {
        setError(t('photoUploadFailed'));
      } finally {
        // In `finally`, not after the write: a refusal or a dropped connection
        // must clear the spinner too, or the screen is stuck on «working» and
        // the operator is back where this round started.
        markBusy(lot.id, -1);
      }
    }
  }

  async function addReceiptFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      markBusy(RECEIPT_SLOT, 1);
      try {
        const isImage = file.type.startsWith('image/');
        const body = isImage ? await compressPhoto(file) : file;
        const formData = new FormData();
        formData.set('file', body);
        formData.set('entityType', 'receipt');
        formData.set('entityId', draft!.receiptId);
        const res = await uploadWithDeadline(formData);
        if (res.ok) {
          const { id } = (await res.json()) as { id: string };
          const item = {
            id,
            fileName: file.name,
            contentType: file.type,
            kind: isImage ? 'photo' : 'file',
          };
          setDraft((d) => (d ? { ...d, files: [...(d.files ?? []), item] } : d));
        } else {
          setError(await uploadErrorText(res));
        }
      } catch {
        setError(t('photoUploadFailed'));
      } finally {
        markBusy(RECEIPT_SLOT, -1);
      }
    }
  }

  async function addGeneralPhotos(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      markBusy(RECEIPT_SLOT, 1);
      try {
        const compressed = await compressPhoto(file);
        const formData = new FormData();
        formData.set('file', compressed);
        formData.set('entityType', 'receipt');
        formData.set('entityId', draft!.receiptId);
        const res = await uploadWithDeadline(formData);
        if (res.ok) {
          const { id } = (await res.json()) as { id: string };
          setDraft((d) => (d ? { ...d, generalPhotoIds: [...d.generalPhotoIds, id] } : d));
        } else {
          setError(await uploadErrorText(res));
        }
      } catch {
        setError(t('photoUploadFailed'));
      } finally {
        markBusy(RECEIPT_SLOT, -1);
      }
    }
  }

  const clientChosen = draft.clientId !== null || (draft.unclaimed && draft.unclaimedMarking.trim());

  /** First missing thing per lot — shown next to the disabled confirm so the operator knows WHAT is wrong. */
  function firstProblem(): string | null {
    if (!clientChosen) return t('problems.client');
    for (let i = 0; i < draft!.lots.length; i += 1) {
      const lot = draft!.lots[i]!;
      const line = letterPreview[i] ?? `#${i + 1}`;
      if (!lot.zh.trim()) return `${line}: ${t('problems.name')}`;
      if (!(Number(lot.boxCount) >= 1)) return `${line}: ${t('problems.count')}`;
      if (!lotTotals(lot)) return `${line}: ${t('problems.dims')}`;
      if (lot.photoIds.length === 0) return `${line}: ${t('problems.photo')}`;
    }
    return null;
  }

  function lotsValid(): boolean {
    return draft!.lots.every(
      (lot) => lot.zh.trim() && Number(lot.boxCount) && lot.photoIds.length > 0 && lotTotals(lot),
    );
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        receiptId: draft!.receiptId,
        warehouseId: draft!.warehouseId,
        clientId: draft!.unclaimed ? null : draft!.clientId,
        dealId: draft!.unclaimed ? null : draft!.dealId,
        sourceNote: draft!.sourceNote,
        unclaimedMarking: draft!.unclaimedMarking,
        expectedArrivalId: draft!.expectedArrivalId ?? null,
        lots: draft!.lots.map((lot) => ({
          id: lot.id,
          productNameZh: lot.zh.trim(),
          productNameRu: lot.ru.trim(),
          boxCount: Number(lot.boxCount),
          dimsMode: lot.dimsMode,
          ...(lot.dimsMode === 'uniform'
            ? {
                boxLengthCm: Number(lot.lengthCm),
                boxWidthCm: Number(lot.widthCm),
                boxHeightCm: Number(lot.heightCm),
                boxWeightKg: Number(lot.boxWeightKg),
              }
            : {
                totalWeightKg: Number(lot.totalWeightKg),
                totalVolumeM3: Number(lot.totalVolumeM3),
              }),
        })),
        extraCosts: draft!.costs
          .filter((c) => c.costTypeId && Number(c.amount) > 0)
          .map((c) => ({
            costTypeId: c.costTypeId,
            amount: Number(c.amount),
            currency: c.currency,
          })),
      };
      const res = await submitReceiptAction(payload);
      if (res.ok) {
        localStorage.removeItem(DRAFT_KEY);
        setResult(res);
      } else if (res.error === 'warehouse_forbidden') {
        setError(t('warehouseForbidden'));
      } else {
        setError(res.detail ? `${res.error}: ${res.detail}` : (res.error ?? 'error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="card space-y-4 text-center">
        <p className="text-3xl">✅</p>
        <h2 className="text-lg font-bold">{result.number}</h2>
        <ul className="space-y-1 text-left">
          {result.lots?.map((lot) => (
            <li key={lot.letter} className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-extrabold text-brand-700">{lot.letter}</span>
              <span>{lot.productNameZh}</span>
              <span className="ml-auto text-sm text-ink-700">{lot.boxCount} 📦</span>
            </li>
          ))}
        </ul>
        <PrintLabels href={`/print/receipts/${result.receiptId}`} label={t('printLabels')} />
        {(result.lots?.length ?? 0) > 1 && (
          <div className="grid grid-cols-3 gap-2">
            {result.lots?.map((lot) => (
              <PrintLabels
                key={lot.lotId}
                variant="secondary"
                href={`/print/receipts/${result.receiptId}?lotId=${lot.lotId}`}
                label={lot.letter}
              />
            ))}
          </div>
        )}
        <a href={`/receipts/${result.receiptId}`} className="btn-secondary w-full">
          {t('openReceipt')}
        </a>
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => {
            setResult(null);
            setDraft(newDraft(draft.warehouseId));
          }}
        >
          {t('newReceipt')}
        </button>
      </div>
    );
  }

  const allTotals = draft.lots.map(lotTotals);
  const sumBoxes = draft.lots.reduce((acc, lot) => acc + (Number(lot.boxCount) || 0), 0);
  const sumKg = allTotals.reduce((acc, totals) => acc + (totals?.totalWeightKg ?? 0), 0);
  const sumM3 = allTotals.reduce((acc, totals) => acc + (totals?.totalVolumeM3 ?? 0), 0);

  // --- Shared helpers (desktop table + mobile cards render the same state) ---

  const cellNum = (
    lot: LotDraft,
    field: 'lengthCm' | 'widthCm' | 'heightCm' | 'boxWeightKg' | 'totalWeightKg' | 'totalVolumeM3',
    placeholder: string,
    testId?: string,
  ) => (
    <input
      data-testid={testId}
      aria-label={placeholder}
      className="input-cell text-center"
      inputMode="decimal"
      value={lot[field]}
      onChange={(e) => updateLot(lot.id, { [field]: e.target.value.replace(',', '.') })}
      placeholder={placeholder}
    />
  );

  function photosField(lot: LotDraft) {
    const busy = photoBusy(lot.id);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {/* While a photo is on its way the tile says so and stops taking
            another. Silence here was the whole defect: a photograph off a
            warehouse phone takes seconds to shrink and send, and a tile that
            looks exactly the same before and during reads as «my tap did
            nothing» — so the operator taps again, and again. */}
        <label
          data-testid="lot-photo-tile"
          aria-busy={busy}
          className={`flex h-9 w-9 items-center justify-center rounded-md border border-dashed text-base ${
            busy
              ? 'animate-pulse cursor-wait border-brand-500 bg-brand-50'
              : 'cursor-pointer border-line-strong hover:bg-surface-sunken'
          }`}
        >
          {busy ? '⏳' : '📷'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={busy}
            className="hidden"
            onChange={(e) => addPhotos(lot, e.target.files)}
          />
        </label>
        {lot.photoIds.map((photoId) => (
          <LightboxImg
            key={photoId}
            attachmentId={photoId}
            className="h-9 w-9 rounded-md object-cover"
            // Read the list at the moment the DELETE lands, not at render:
            // `lot.photoIds` is this render's snapshot, so a photo that
            // finished uploading while the ✕ was in flight was written back
            // out of existence — the operator deletes one picture and loses
            // two, with nothing to say so (round 97).
            onDelete={() =>
              removeAttachment(photoId, () =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        lots: d.lots.map((l) =>
                          l.id === lot.id
                            ? { ...l, photoIds: l.photoIds.filter((id) => id !== photoId) }
                            : l,
                        ),
                      }
                    : d,
                ),
              )
            }
          />
        ))}
      </div>
    );
  }

  function totalsBadge(lot: LotDraft) {
    const totals = lotTotals(lot);
    if (!totals) return <span className="text-xs text-gray-300">—</span>;
    return (
      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap font-mono text-xs">
        <b>{totals.totalWeightKg}kg</b>
        <b>{totals.totalVolumeM3}m³</b>
        <DensityBadge density={totals.densityKgM3} thresholds={densityThresholds} />
      </span>
    );
  }

  const modeToggle = (lot: LotDraft, compact: boolean) => (
    <button
      type="button"
      className={
        compact
          ? 'h-9 rounded-md bg-surface-sunken px-1.5 text-xs font-semibold text-ink-700 hover:bg-surface-sunken'
          : 'rounded-lg bg-surface-sunken px-2 py-1.5 text-xs font-semibold'
      }
      title={lot.dimsMode === 'uniform' ? t('uniform') : t('mixed')}
      onClick={() =>
        updateLot(lot.id, { dimsMode: lot.dimsMode === 'uniform' ? 'mixed' : 'uniform' })
      }
    >
      {compact ? '⇄' : `${lot.dimsMode === 'uniform' ? t('uniform') : t('mixed')} ⇄`}
    </button>
  );

  const clientBlock = (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          aria-label={t('warehouse')}
          className="input !w-24 shrink-0 font-mono font-bold"
          value={draft.warehouseId}
          onChange={(e) => update({ warehouseId: e.target.value })}
        >
          {warehouses.map((wh) => (
            <option key={wh.id} value={wh.id}>
              {wh.code}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          {draft.clientId ? (
            <div className="flex min-h-12 items-center gap-2 rounded-lg border border-good/30 bg-good/10 px-3">
              <span className="truncate font-mono font-extrabold text-good">
                {draft.clientLabel}
              </span>
              <button
                type="button"
                aria-label={tc('cancel')}
                className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center text-lg"
                onClick={() => update({ clientId: null, clientLabel: '', dealId: null })}
              >
                ✕
              </button>
            </div>
          ) : (
            <input
              id="clientQuery"
              className="input font-mono uppercase"
              value={clientQuery}
              onChange={(e) => {
                setClientQuery(e.target.value);
                if (draft.unclaimed) update({ unclaimed: false });
              }}
              placeholder={t('clientCode')}
              autoComplete="off"
            />
          )}
          {clientHits.length > 0 && !draft.clientId && (
            <ul className="absolute z-20 mt-1 w-72 divide-y divide-line rounded-lg border border-line bg-surface-raised shadow-lg">
              {clientHits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-surface-sunken"
                    onClick={() => {
                      update({
                        clientId: hit.id,
                        clientLabel: `${hit.clientCode} — ${hit.name}`,
                        dealId: null,
                        unclaimed: false,
                      });
                      setClientHits([]);
                      setClientQuery('');
                    }}
                  >
                    <span className="font-mono font-extrabold text-brand-700">{hit.clientCode}</span>
                    <span className="truncate">{hit.name}</span>
                    {hit.managerName && (
                      <span className="ml-auto whitespace-nowrap text-xs text-ink-500">
                        {hit.managerName}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {/* Last row, after the real matches: the dropdown overlays the
                  standalone button below, so without this a fuzzy hit left
                  no way to accept an unknown code (owner's GS500 → GS300).
                  Deliberately NOT labelled with the typed code — it must not
                  read like one of the matches above. */}
              <li>
                <button
                  type="button"
                  data-testid="accept-unclaimed-inline"
                  className="w-full bg-orange-50 p-3 text-left text-sm font-semibold text-orange-800 hover:bg-orange-100"
                  onClick={() => {
                    update({ unclaimed: true, unclaimedMarking: clientQuery.toUpperCase() });
                    setClientHits([]);
                  }}
                >
                  ❓ {t('acceptUnclaimed')}
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
      {/* The moment that decides whether the price-control alert can do its
          job: cargo linked to the job it was quoted under compares against
          that quote, cargo linked to nothing shouts "unpriced".
          NOT for the warehouse (owner: «skladchi tanlamasin»): the operator
          weighing boxes has no way of knowing which job they belong to, and a
          guess here is worse than the honest blank. Whoever may write a deal
          links it afterwards on the prixod card, which is where they can see
          the job (round 38). Shown only when the client HAS an open job too —
          a select with one "—" in it is furniture. */}
      {canPickDeal && draft.clientId && openDeals.length > 0 && (
        <label className="block">
          <span className="label">{td('pickDeal')}</span>
          <select
            className="input"
            data-testid="receive-deal"
            value={draft.dealId ?? ''}
            onChange={(e) => update({ dealId: e.target.value || null })}
          >
            <option value="">{td('noDeal')}</option>
            {openDeals.map((deal) => (
              <option key={deal.id} value={deal.id}>
                {deal.code}
                {deal.title ? ` · ${deal.title}` : ''}
                {deal.quotedAmount ? ` · ${deal.quotedAmount} ${deal.quotedCurrency ?? ''}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Only when the dropdown is closed — while it is open the unclaimed
          choice is its last row, so the code-labelled button below can never
          be mistaken for (or overlay) one of the real matches. */}
      {!draft.clientId &&
        !searching &&
        clientHits.length === 0 &&
        (clientQuery.trim() || draft.unclaimed) && (
        <button
          type="button"
          data-testid="accept-unclaimed"
          className={`w-full rounded-lg border-2 border-dashed p-2.5 text-sm font-semibold ${
            draft.unclaimed
              ? 'border-orange-500 bg-orange-50 text-orange-800'
              : 'border-line-strong text-ink-700'
          }`}
          onClick={() =>
            update({ unclaimed: !draft.unclaimed, unclaimedMarking: clientQuery.toUpperCase() })
          }
        >
          ❓{' '}
          {clientQuery.trim()
            ? t('acceptUnclaimedAs', { code: clientQuery.toUpperCase() })
            : t('acceptUnclaimed')}
        </button>
      )}
      {draft.unclaimed && (
        <div>
          <label className="label" htmlFor="marking">
            {t('unclaimedMarking')}
          </label>
          <input
            id="marking"
            className="input font-mono uppercase"
            value={draft.unclaimedMarking}
            onChange={(e) => update({ unclaimedMarking: e.target.value.toUpperCase() })}
            placeholder="444"
          />
          <p className="mt-1 text-xs text-ink-500">{t('unclaimedMarkingHint')}</p>
        </div>
      )}
    </div>
  );

  // Single total-cost entry (owner's request: no per-type cost rows) — stored
  // as one cost line under the "other" cost type.
  const cost = draft.costs[0] ?? { costTypeId: '', amount: '', currency: defaultCurrency };
  const otherCostTypeId =
    costTypes.find((type) => type.code === 'other')?.id ?? costTypes[0]?.id ?? '';
  const setCost = (patch: Partial<CostDraft>) =>
    update({ costs: [{ ...cost, costTypeId: otherCostTypeId, ...patch }] });

  // Owner: a note and an extra cost belong to a minority of receipts, while
  // photos and files are used on every one — so these two fold away and the
  // attachment row below stays open. A draft that already carries either one
  // comes back open, so nothing hides from the person who typed it.
  const extrasFilled = Boolean(draft.sourceNote || cost.amount);
  const bottomBlock = (
    <div className="space-y-2">
      <details
        className="rounded-lg border border-line bg-surface-sunken"
        open={extrasFilled}
        data-testid="receipt-extras"
      >
        <summary
          data-testid="receipt-extras-toggle"
          className="cursor-pointer p-2 text-sm font-semibold text-ink-700 marker:text-ink-400"
        >
          📝 {t('noteAndCost')}
          {extrasFilled && <span className="ml-2 text-xs text-good">●</span>}
        </summary>
        <div className="flex flex-col gap-2 p-2 pt-0 md:flex-row">
          <input
            aria-label={t('sourceNote')}
            className="input md:flex-1"
            placeholder={`📝 ${t('sourceNote')}`}
            value={draft.sourceNote}
            onChange={(e) => update({ sourceNote: e.target.value })}
          />
          <div className="flex gap-2">
            <input
              data-testid="receipt-cost-amount"
              aria-label={t('stepCosts')}
              className="input !w-40 md:!w-36"
              inputMode="decimal"
              placeholder={`💰 ${t('stepCosts')}`}
              value={cost.amount}
              onChange={(e) => setCost({ amount: e.target.value })}
            />
            <select
              aria-label="currency"
              className="input !w-24 shrink-0"
              value={cost.currency}
              onChange={(e) => setCost({ currency: e.target.value })}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      </details>
      {/* The same busy rule as a lot's 📷: these two live on the receipt rather
          than on a line, so they share one slot. Half a fix here would be the
          original defect wearing the other two tiles. */}
      <div data-testid="receipt-files-row" className="flex flex-wrap items-center gap-1.5">
        <label
          aria-busy={photoBusy(RECEIPT_SLOT)}
          className={`btn-secondary !min-h-10 gap-1.5 px-3 text-sm ${
            photoBusy(RECEIPT_SLOT) ? 'animate-pulse cursor-wait' : 'cursor-pointer'
          }`}
        >
          {photoBusy(RECEIPT_SLOT) ? '⏳' : '📷'} {t('generalPhotos')}
          <input
            data-testid="general-photo-input"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={photoBusy(RECEIPT_SLOT)}
            className="hidden"
            onChange={(e) => addGeneralPhotos(e.target.files)}
          />
        </label>
        <label
          aria-busy={photoBusy(RECEIPT_SLOT)}
          className={`btn-secondary !min-h-10 gap-1.5 px-3 text-sm ${
            photoBusy(RECEIPT_SLOT) ? 'animate-pulse cursor-wait' : 'cursor-pointer'
          }`}
        >
          {photoBusy(RECEIPT_SLOT) ? '⏳' : '📎'} {t('attachments')}
          <input
            disabled={photoBusy(RECEIPT_SLOT)}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addReceiptFiles(e.target.files)}
          />
        </label>
        {draft.generalPhotoIds.map((photoId) => (
          <LightboxImg
            key={photoId}
            attachmentId={photoId}
            className="h-10 w-10 rounded-md object-cover"
            onDelete={() =>
              removeAttachment(photoId, () =>
                update({ generalPhotoIds: draft.generalPhotoIds.filter((id) => id !== photoId) }),
              )
            }
          />
        ))}
        {draft.files.map((file) =>
          file.kind === 'photo' ? (
            <LightboxImg
              key={file.id}
              attachmentId={file.id}
              alt={file.fileName}
              className="h-10 w-10 rounded-md object-cover"
              onDelete={() =>
                removeAttachment(file.id, () =>
                  update({ files: draft.files.filter((f) => f.id !== file.id) }),
                )
              }
            />
          ) : (
            <span
              key={file.id}
              className="flex h-10 max-w-40 items-center gap-1 rounded-md bg-surface-sunken pl-2 text-xs text-ink-700"
              title={file.fileName}
            >
              <a
                href={`/api/attachments/${file.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1"
              >
                📄 <span className="truncate">{file.fileName}</span>
              </a>
              <button
                type="button"
                aria-label="✕"
                className="px-1.5 text-sm font-bold text-bad"
                onClick={() =>
                  removeAttachment(file.id, () =>
                    update({ files: draft.files.filter((f) => f.id !== file.id) }),
                  )
                }
              >
                ✕
              </button>
            </span>
          ),
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 pb-24">
      {/* ===== One place for everything about the receipt (owner's request):
           warehouse + client, general box photos, note, files, costs ===== */}
      <div className="card space-y-3 !p-3 md:!p-4">
        {clientBlock}
        {bottomBlock}
      </div>

      {/* ===== Desktop: spreadsheet-style product lines ===== */}
      <div className="hidden md:block">
        <div className="card !p-0">
          <div className="overflow-x-auto rounded-xl">
            <table className="w-full min-w-[860px] table-fixed text-sm">
              <colgroup>
                <col className="w-10" />
                <col />
                <col className="w-16" />
                <col className="w-8" />
                <col className="w-14" />
                <col className="w-14" />
                <col className="w-14" />
                <col className="w-16" />
                <col className="w-44" />
                <col className="w-32" />
                <col className="w-9" />
              </colgroup>
              <thead>
                <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="p-2">#</th>
                  <th className="p-2">{t('productZh')}</th>
                  <th className="p-2 text-center">📦</th>
                  <th className="p-2" />
                  <th className="p-2 text-center">L</th>
                  <th className="p-2 text-center">W</th>
                  <th className="p-2 text-center">H</th>
                  <th className="p-2 text-center">kg/📦</th>
                  <th className="p-2">{t('photos')}</th>
                  <th className="p-2 text-right">Σ</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {draft.lots.map((lot, i) => (
                  <tr key={lot.id} className="border-b border-line last:border-0">
                    <td className="p-1.5 text-center font-mono font-bold text-brand-700">
                      {letterPreview[i] ?? `·`}
                    </td>
                    <td className="p-1.5">
                      <input
                        aria-label={t('productZh')}
                        className="input-cell"
                        value={lot.zh}
                        onChange={(e) => updateLot(lot.id, { zh: e.target.value, ru: '' })}
                        onBlur={() => translateLot(lot)}
                        placeholder="化妆品"
                      />
                      {lot.ru && (
                        <p className="mt-0.5 truncate px-1 text-xs text-ink-500">({lot.ru})</p>
                      )}
                    </td>
                    <td className="p-1.5">
                      <input
                        aria-label={t('boxCount')}
                        className="input-cell text-center font-semibold"
                        inputMode="numeric"
                        value={lot.boxCount}
                        onChange={(e) => updateLot(lot.id, { boxCount: e.target.value.replace(/\D/g, '') })}
                      />
                    </td>
                    <td className="p-1.5 text-center">{modeToggle(lot, true)}</td>
                    {lot.dimsMode === 'uniform' ? (
                      <>
                        <td className="p-1.5">{cellNum(lot, 'lengthCm', 'L')}</td>
                        <td className="p-1.5">{cellNum(lot, 'widthCm', 'W')}</td>
                        <td className="p-1.5">{cellNum(lot, 'heightCm', 'H')}</td>
                        <td className="p-1.5">{cellNum(lot, 'boxWeightKg', 'kg')}</td>
                      </>
                    ) : (
                      <td className="p-1.5" colSpan={4}>
                        <div className="flex gap-1.5">
                          {cellNum(lot, 'totalVolumeM3', t('totalM3'))}
                          {cellNum(lot, 'totalWeightKg', t('totalKg'))}
                        </div>
                      </td>
                    )}
                    <td className="p-1.5">{photosField(lot)}</td>
                    <td className="p-1.5 text-right">{totalsBadge(lot)}</td>
                    <td className="p-1.5 text-center">
                      {draft.lots.length > 1 && (
                        <button
                          type="button"
                          aria-label={tc('delete')}
                          className="text-ink-400 hover:text-bad"
                          onClick={() => {
                            // A filled line dies with one mis-tap otherwise (UX audit).
                            const hasData = lot.zh.trim() || lot.photoIds.length > 0 || lot.boxCount;
                            if (hasData && !window.confirm(`${tc('delete')}? ${lot.zh}`)) return;
                            update({ lots: draft.lots.filter((l) => l.id !== lot.id) });
                          }}
                        >
                          🗑
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="w-full border-t border-line p-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
              onClick={() => update({ lots: [...draft.lots, newLot()] })}
            >
              ＋ {t('addLot')}
            </button>
          </div>
        </div>
      </div>

      {/* ===== Mobile: stacked cards ===== */}
      <div id="mobile-product-lines" className="space-y-3 md:hidden">
        {draft.lots.map((lot, i) => (
          <div key={lot.id} className="card space-y-2 !p-3">
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-center font-mono text-lg font-extrabold text-brand-700">
                {letterPreview[i] ?? '·'}
              </span>
              <input
                data-testid="lot-zh"
                aria-label={t('productZh')}
                className="input flex-1"
                value={lot.zh}
                onChange={(e) => updateLot(lot.id, { zh: e.target.value, ru: '' })}
                onBlur={() => translateLot(lot)}
                placeholder={t('productZh')}
              />
              {draft.lots.length > 1 && (
                <button
                  type="button"
                  aria-label={tc('delete')}
                  className="shrink-0 text-lg"
                  onClick={() => {
                            // A filled line dies with one mis-tap otherwise (UX audit).
                            const hasData = lot.zh.trim() || lot.photoIds.length > 0 || lot.boxCount;
                            if (hasData && !window.confirm(`${tc('delete')}? ${lot.zh}`)) return;
                            update({ lots: draft.lots.filter((l) => l.id !== lot.id) });
                          }}
                >
                  🗑
                </button>
              )}
            </div>
            {lot.ru && <p className="px-10 text-sm text-ink-500">({lot.ru})</p>}
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <p className="mb-0.5 text-[11px] font-semibold text-ink-500">{t('boxCount')}</p>
                <input
                  data-testid="lot-count"
                  aria-label={t('boxCount')}
                  className="input-cell !h-10 text-center font-semibold"
                  inputMode="numeric"
                  value={lot.boxCount}
                  onChange={(e) => updateLot(lot.id, { boxCount: e.target.value.replace(/\D/g, '') })}
                />
              </div>
              <div className="pt-4">{modeToggle(lot, false)}</div>
            </div>
            {lot.dimsMode === 'uniform' ? (
              <div className="grid grid-cols-4 gap-1.5">
                {(
                  [
                    ['lengthCm', 'L', 'lot-L'],
                    ['widthCm', 'W', 'lot-W'],
                    ['heightCm', 'H', 'lot-H'],
                    ['boxWeightKg', 'kg/📦', 'lot-kg'],
                  ] as const
                ).map(([field, label, testId]) => (
                  <div key={field}>
                    <p className="mb-0.5 text-center text-[11px] font-semibold text-ink-500">
                      {label}
                    </p>
                    {cellNum(lot, field, label, testId)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <p className="mb-0.5 text-center text-[11px] font-semibold text-ink-500">
                    {t('totalM3')}
                  </p>
                  {cellNum(lot, 'totalVolumeM3', t('totalM3'))}
                </div>
                <div>
                  <p className="mb-0.5 text-center text-[11px] font-semibold text-ink-500">
                    {t('totalKg')}
                  </p>
                  {cellNum(lot, 'totalWeightKg', t('totalKg'))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              {photosField(lot)}
              <span className="ml-auto">{totalsBadge(lot)}</span>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => update({ lots: [...draft.lots, newLot()] })}
        >
          ＋ {t('addLot')}
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {error === 'photo_required' ? t('photoRequired') : tc('error')} ({error})
        </p>
      )}

      {/* ===== Sticky totals + confirm ===== */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
        {/* «A photo is still going up» beats «you have not added a photo»:
            both leave the button grey, and only one of them is the operator's
            to do something about. */}
        {anyPhotoBusy ? (
          <p
            data-testid="photo-uploading"
            className="mx-auto max-w-4xl animate-pulse px-4 pt-1.5 text-xs font-semibold text-brand-700"
          >
            ⏳ {t('photoUploading')}
          </p>
        ) : (
          (!clientChosen || !lotsValid()) && (
            <p className="mx-auto max-w-4xl px-4 pt-1.5 text-xs font-semibold text-warn">
              ⚠️ {firstProblem()}
            </p>
          )
        )}
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-2.5">
          <div className="whitespace-nowrap text-sm leading-tight">
            <span className="font-bold">Σ {sumBoxes} 📦</span>
            <span className="ml-2 text-ink-700">
              {Math.round(sumKg * 1000) / 1000} kg · {Math.round(sumM3 * 10000) / 10000} m³
            </span>
          </div>
          <button
            type="button"
            data-testid="confirm-receipt"
            className="btn-primary flex-1 disabled:opacity-50"
            // …and never while a photograph is still on its way: confirming
            // now would file the receipt without the picture that is seconds
            // from landing on it.
            disabled={submitting || anyPhotoBusy || !clientChosen || !lotsValid()}
            onClick={confirm}
          >
            {submitting ? tc('loading') : `✅ ${t('confirm')}`}
          </button>
        </div>
      </div>
    </div>
  );
}
