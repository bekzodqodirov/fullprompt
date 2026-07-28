'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import { stageClass } from '@/app/(protected)/crm/stage-color';

/**
 * The board, in the two shapes it is actually used in.
 *
 * A phone gets ONE stage at a time (owner: "mobileda kanban view'ni ishlashga
 * qulay qilib ber"). Eight columns side by side on a 360 px screen means ~76 px
 * of the next stage is visible, and dragging a card to a column you cannot see
 * is a several-second edge-scroll that misses as often as it lands. So the
 * phone gets a stage strip, the stage's cards full width, and a button that
 * moves a card on ONE tap — which is what the gesture was for.
 *
 * A desktop, where all the columns fit, keeps the drag board.
 *
 * Both are rendered and toggled by CSS rather than by measuring the window: a
 * breakpoint read in JavaScript renders the wrong shape for the first frame,
 * and this board is the first screen the sales side opens.
 *
 * Generic over the CARD, not over the board, because the two boards this app
 * has — leads and deals — differ only in what a card says. The labels arrive
 * already translated: a client component cannot resolve a namespace the caller
 * chose, and a missing next-intl key throws at RENDER time in every locale.
 */

export interface KanbanStage {
  id: string;
  name: string;
  kind: string;
  color: string;
}

export interface KanbanItem {
  id: string;
  stageId: string;
}

export interface KanbanLabels {
  /** Prompt shown before a card may enter a `lost` column. */
  lostReason: string;
  moveTo: string;
  cancelMove: string;
  prevStage: string;
  nextStage: string;
  dragHint: string;
  empty: string;
  error: string;
  /** Plural noun for the "· 4 leads" counter under the stage strip. */
  itemsWord: string;
}

/** Below this the gesture is a scroll or a tap, not a drag. */
const MOVE_THRESHOLD = 8;
/** A touch has to be held this long before the card comes off the board. */
const HOLD_MS = 250;
/** Auto-scroll the board when the pointer nears an edge. */
const EDGE = 48;
const EDGE_STEP = 12;

interface BoardProps<T extends KanbanItem> {
  stages: KanbanStage[];
  items: T[];
  labels: KanbanLabels;
  renderCard: (item: T) => ReactNode;
  hrefOf: (item: T) => string;
  onMove: (id: string, stageId: string, reason: string) => Promise<{ ok: boolean }>;
  /** Distinguishes the two boards in the e2e without a second selector scheme. */
  cardTestId?: string;
}

export function KanbanBoard<T extends KanbanItem>({
  stages,
  items,
  labels,
  renderCard,
  hrefOf,
  onMove,
  cardTestId = 'kanban-card',
}: BoardProps<T>) {
  const [placement, setPlacement] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);

  // The server is the truth; `placement` only holds a card in its new column
  // between the move and the revalidation, so the card never jumps back for
  // half a second. Cleared the moment fresh rows arrive — adjusted during
  // render rather than in an effect, so there is no frame where the optimistic
  // position and the server's disagree.
  const [rendered, setRendered] = useState(items);
  if (rendered !== items) {
    setRendered(items);
    setPlacement({});
  }
  const stageOf = useCallback((item: T) => placement[item.id] ?? item.stageId, [placement]);

  /**
   * Move a card, optimistically. Shared by the drag board and the phone's move
   * buttons so the two can never disagree about what a move means — a lost job
   * has to say why, and refusing the prompt leaves the card alone.
   */
  const move = useCallback(
    async (item: T, stageId: string) => {
      const stage = stages.find((row) => row.id === stageId);
      if (!stage || stage.id === (placement[item.id] ?? item.stageId)) return;

      let reason = '';
      if (stage.kind === 'lost') {
        reason = window.prompt(labels.lostReason) ?? '';
        if (reason.trim().length < 2) return;
      }

      setPlacement((current) => ({ ...current, [item.id]: stageId }));
      setError(false);
      const result = await onMove(item.id, stageId, reason);
      if (!result.ok) {
        setPlacement((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        setError(true);
      }
    },
    [placement, stages, labels.lostReason, onMove],
  );

  const counts = Object.fromEntries(
    stages.map((stage) => [stage.id, items.filter((item) => stageOf(item) === stage.id).length]),
  );
  const view = { stages, items, counts, stageOf, move, labels, renderCard, hrefOf, cardTestId };

  return (
    <>
      {error && <p className="text-sm font-semibold text-bad">{labels.error}</p>}

      <div data-testid="funnel-mobile" className="md:hidden">
        <StageView {...view} />
      </div>
      <div data-testid="funnel-desktop" className="hidden md:block">
        <DragBoard {...view} />
      </div>
    </>
  );
}

interface ViewProps<T extends KanbanItem> {
  stages: KanbanStage[];
  items: T[];
  counts: Record<string, number>;
  stageOf: (item: T) => string;
  move: (item: T, stageId: string) => void | Promise<void>;
  labels: KanbanLabels;
  renderCard: (item: T) => ReactNode;
  hrefOf: (item: T) => string;
  cardTestId: string;
}

/**
 * The phone's board: one stage, full width.
 *
 * The strip along the top IS the funnel — every stage and its count at a
 * glance, which is the thing a board is opened for, and a tap to switch
 * instead of a long sideways drag.
 */
function StageView<T extends KanbanItem>({
  stages,
  items,
  counts,
  stageOf,
  move,
  labels,
  renderCard,
  hrefOf,
  cardTestId,
}: ViewProps<T>) {
  // Open on the first stage that has anything in it: an empty "new" column is
  // a wasted first screen when the work is three stages along.
  const [activeId, setActiveId] = useState(
    () => stages.find((stage) => counts[stage.id])?.id ?? stages[0]?.id ?? '',
  );
  const [sheetFor, setSheetFor] = useState<T | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // A stage deleted or reordered under us must not leave the screen blank.
  const active = stages.find((stage) => stage.id === activeId) ?? stages[0];
  const activeIndex = active ? stages.indexOf(active) : -1;
  const inStage = active ? items.filter((item) => stageOf(item) === active.id) : [];

  // Keep the chosen stage on screen — with eight stages the one you are
  // looking at is often off the end of the strip.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeId]);

  const step = (delta: number) => {
    const next = stages[activeIndex + delta];
    if (next) setActiveId(next.id);
  };

  return (
    <div className="space-y-2">
      <div ref={stripRef} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {stages.map((stage) => {
          const on = stage.id === active?.id;
          return (
            <button
              key={stage.id}
              type="button"
              data-testid="stage-tab"
              data-active={on}
              onClick={() => setActiveId(stage.id)}
              className={`shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold ${
                on ? `${stageClass(stage.color)} ring-2 ring-brand-500` : 'border-line text-ink-700'
              }`}
            >
              {stage.name}
              <span className="ml-1.5 opacity-70">{counts[stage.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Stepping through the funnel without hunting in the strip. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={labels.prevStage}
          disabled={activeIndex <= 0}
          onClick={() => step(-1)}
          className="btn-secondary btn-icon disabled:opacity-30"
        >
          <Icon name="chevronLeft" className="h-5 w-5" />
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-sm font-bold">
          {active?.name}{' '}
          <span className="text-ink-500">
            · {inStage.length} {labels.itemsWord.toLowerCase()}
          </span>
        </p>
        <button
          type="button"
          aria-label={labels.nextStage}
          disabled={activeIndex < 0 || activeIndex >= stages.length - 1}
          onClick={() => step(1)}
          className="btn-secondary btn-icon disabled:opacity-30"
        >
          <Icon name="chevronRight" className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-2">
        {inStage.map((item) => {
          const next = stages[stages.indexOf(active!) + 1];
          return (
            <div key={item.id} data-testid={cardTestId} className="card !p-3">
              <Link href={hrefOf(item)} className="block">
                {renderCard(item)}
              </Link>
              <div className="mt-2 flex gap-2 border-t border-line pt-2">
                {/* One tap for the move that happens ten times a day; the
                    sheet for everything else. */}
                {next && (
                  <button
                    type="button"
                    data-testid="move-next"
                    onClick={() => void move(item, next.id)}
                    className="btn-secondary min-w-0 flex-1 !justify-start"
                  >
                    <Icon name="chevronRight" className="h-4 w-4 shrink-0" />
                    <span className="truncate">{next.name}</span>
                  </button>
                )}
                <button
                  type="button"
                  data-testid="move-other"
                  aria-label={labels.moveTo}
                  onClick={() => setSheetFor(item)}
                  className="btn-secondary btn-icon shrink-0"
                >
                  ⋯
                </button>
              </div>
            </div>
          );
        })}
        {inStage.length === 0 && (
          <p className="card text-center text-sm text-ink-500">{labels.empty}</p>
        )}
      </div>

      {sheetFor && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40"
          onClick={() => setSheetFor(null)}
        >
          <div
            className="pb-safe max-h-[80vh] w-full space-y-1.5 overflow-y-auto rounded-t-2xl bg-surface-raised p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="section-title">{labels.moveTo}</p>
            {stages
              .filter((stage) => stage.id !== stageOf(sheetFor))
              .map((stage) => (
                <button
                  key={stage.id}
                  type="button"
                  data-testid={`move-to-${stage.kind}`}
                  onClick={() => {
                    const item = sheetFor;
                    setSheetFor(null);
                    void move(item, stage.id);
                  }}
                  className={`w-full rounded-xl border px-3 py-3 text-left font-semibold ${stageClass(
                    stage.color,
                  )}`}
                >
                  {stage.name}
                </button>
              ))}
            <button type="button" onClick={() => setSheetFor(null)} className="btn-secondary w-full">
              {labels.cancelMove}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The desktop board: every column at once, drag a card between them.
 *
 * Written against Pointer Events rather than HTML5 drag-and-drop, which does
 * not fire on touch — a trackpad reports as touch on some machines. No
 * library: a drag-and-drop package would be a bigger dependency than the code
 * it replaces.
 */
function DragBoard<T extends KanbanItem>({
  stages,
  items,
  counts,
  stageOf,
  move,
  labels,
  renderCard,
  hrefOf,
  cardTestId,
}: ViewProps<T>) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopScrolling = () => {
    if (scrollTimer.current) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };

  const cleanup = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    stopScrolling();
    setDragId(null);
    setOverStage(null);
    setGhost(null);
    start.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** Which column is under the pointer right now. */
  const stageUnder = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    return element?.closest<HTMLElement>('[data-stage-id]')?.dataset.stageId ?? null;
  };

  const edgeScroll = (x: number) => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const direction = x < rect.left + EDGE ? -1 : x > rect.right - EDGE ? 1 : 0;
    if (direction === 0) return stopScrolling();
    if (scrollTimer.current) return;
    scrollTimer.current = setInterval(() => {
      board.scrollLeft += direction * EDGE_STEP;
    }, 16);
  };

  const onPointerDown = (event: React.PointerEvent, item: T) => {
    // Only the primary button; a right-click must not pick a card up.
    if (event.button !== 0) return;
    dragged.current = false;
    start.current = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget as HTMLElement;

    const begin = () => {
      dragged.current = true;
      setDragId(item.id);
      setGhost({ x: event.clientX, y: event.clientY });
      setOverStage(stageOf(item));
      target.setPointerCapture?.(event.pointerId);
      navigator.vibrate?.(15);
    };

    if (event.pointerType === 'mouse') return; // starts on movement instead
    holdTimer.current = setTimeout(begin, HOLD_MS);
  };

  const onPointerMove = (event: React.PointerEvent, item: T) => {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    const moved = Math.hypot(dx, dy);

    if (dragId !== item.id) {
      if (moved < MOVE_THRESHOLD) return;
      if (event.pointerType === 'mouse') {
        dragged.current = true;
        setDragId(item.id);
        setOverStage(stageOf(item));
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      } else {
        // The pointer moved before the hold completed — that is a scroll.
        if (holdTimer.current) clearTimeout(holdTimer.current);
        holdTimer.current = null;
        start.current = null;
        return;
      }
    }

    event.preventDefault();
    setGhost({ x: event.clientX, y: event.clientY });
    setOverStage(stageUnder(event.clientX, event.clientY));
    edgeScroll(event.clientX);
  };

  const onPointerUp = (item: T) => {
    const target = overStage;
    const wasDragging = dragId === item.id;
    cleanup();
    if (wasDragging && target) void move(item, target);
  };

  const dragItem = items.find((item) => item.id === dragId) ?? null;

  return (
    <>
      <p className="text-xs text-ink-500">✋ {labels.dragHint}</p>
      <div
        ref={boardRef}
        // The board owns the rest of the viewport and the COLUMNS scroll,
        // not the page (owner: "har bir kanban column pastgacha davom etardi,
        // pastidan scroll chiqib qolmasdi" — the amoCRM shape). The page
        // never grows below the board, so its scrollbar disappears; a long
        // column scrolls inside itself with the header staying put.
        className="-mx-4 h-[calc(100dvh-17.5rem)] min-h-[20rem] overflow-x-auto px-4"
        // While a card is in the air the board must not pan under it: the
        // pointer is already down, so the browser would otherwise treat the
        // same gesture as a scroll.
        style={{ touchAction: dragId ? 'none' : undefined }}
      >
        <div className="flex h-full gap-3">
          {stages.map((stage) => {
            const inStage = items.filter((item) => stageOf(item) === stage.id);
            const isTarget = dragId !== null && overStage === stage.id;
            return (
              <section
                key={stage.id}
                data-stage-id={stage.id}
                data-testid={`column-${stage.kind}`}
                className={`flex h-full w-64 shrink-0 flex-col rounded-lg bg-surface-sunken ${
                  isTarget ? '!bg-brand-50 ring-2 ring-brand-500' : ''
                }`}
              >
                <header
                  className={`rounded-lg border px-3 py-2 text-sm font-bold ${stageClass(
                    stage.color,
                  )}`}
                >
                  {stage.name}
                  <span className="ml-2 opacity-70">{counts[stage.id]}</span>
                </header>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {inStage.map((item) => (
                    <Link
                      key={item.id}
                      href={hrefOf(item)}
                      data-testid={cardTestId}
                      // An anchor is natively draggable, and that native drag
                      // fires pointercancel — which killed the gesture the
                      // moment the card started to move.
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                      onPointerDown={(event) => onPointerDown(event, item)}
                      onPointerMove={(event) => onPointerMove(event, item)}
                      onPointerUp={() => onPointerUp(item)}
                      onPointerCancel={cleanup}
                      onClick={(event) => {
                        // A drag must not also open the card underneath it.
                        if (dragged.current) event.preventDefault();
                      }}
                      className={`card block !p-2.5 select-none hover:bg-surface-sunken ${
                        dragId === item.id ? 'opacity-30' : ''
                      }`}
                      style={{ touchAction: dragId === item.id ? 'none' : undefined }}
                    >
                      {renderCard(item)}
                    </Link>
                  ))}
                  {inStage.length === 0 && (
                    <p className="px-1 text-xs text-ink-400">{labels.empty}</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {dragItem && ghost && (
        <div
          className="card pointer-events-none fixed z-50 w-56 !p-2.5 shadow-xl ring-2 ring-brand-500"
          style={{ left: ghost.x - 112, top: ghost.y - 28 }}
        >
          {renderCard(dragItem)}
        </div>
      )}
    </>
  );
}
