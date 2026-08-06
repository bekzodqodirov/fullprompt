'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import type { Selection as SelectionStore } from '@/components/list/selection';
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
  dragHint: string;
  empty: string;
  error: string;
  /**
   * A refusal, in words. Keyed by the code the service returned, with
   * `error` as the fallback — so a code nobody has translated yet degrades to
   * today's generic line instead of throwing at render (#163).
   */
  moveErrors: Record<string, string>;
  /** Footer of a column that is holding cards back: «+N · show all». */
  showAll: string;
}

/**
 * The refusal codes a move can come back with, in words.
 *
 * A literal map, exported and built by the caller, because the key handed to
 * `t()` here would be built at runtime and `tests/unit/i18n-keys.test.ts` says
 * outright that it cannot see those. `useMoveErrors` is the one place the six
 * codes are written down, so the two boards cannot drift — and both services
 * are included, since `moveLead` spells it `reason_required` and `moveDeal`
 * spells the same refusal `lost_reason_required`.
 *
 * This replaces a deliberate earlier decision (the bulk bar's «the service's
 * code is deliberately NOT rendered»), and that comment has been updated: a
 * bulk press answers with counts and the cards are still on screen to try
 * again, while a single dragged card jumps back with nothing said.
 */
export function useMoveErrors(): Record<string, string> {
  const t = useTranslations('common');
  return {
    forbidden: t('moveErrors.forbidden'),
    unauthenticated: t('moveErrors.forbidden'),
    not_found: t('moveErrors.notFound'),
    stage_not_found: t('moveErrors.stageNotFound'),
    reason_required: t('moveErrors.reasonRequired'),
    lost_reason_required: t('moveErrors.reasonRequired'),
  };
}

/** Below this the gesture is a scroll or a tap, not a drag. */
const MOVE_THRESHOLD = 8;
/** Auto-scroll the board when the pointer nears an edge. */
const EDGE = 48;
const EDGE_STEP = 12;

interface BoardProps<T extends KanbanItem> {
  stages: KanbanStage[];
  items: T[];
  labels: KanbanLabels;
  renderCard: (item: T) => ReactNode;
  hrefOf: (item: T) => string;
  onMove: (id: string, stageId: string, reason: string) => Promise<{ ok: boolean; error?: string }>;
  /** Distinguishes the two boards in the e2e without a second selector scheme. */
  cardTestId?: string;
  /**
   * Cards this column holds that were not sent to the browser, per stage
   * (round 47). The header count stays the TRUE total — a funnel that lies
   * about how many jobs were won is worse than a long column — and the
   * column grows a footer link to the rest.
   */
  hidden?: Record<string, number>;
  /** Where that footer link goes. Required only when `hidden` has entries. */
  archiveHref?: string;
  /**
   * Multi-select, when the board offers it (round 59).
   *
   * A prop rather than internal state: the ACTIONS live with the caller —
   * only the leads board knows what «assign to» means — so the selection has
   * to be owned there too. Absent means no checkboxes at all, which is what
   * every other caller of this component gets.
   */
  selection?: {
    /**
     * The store from `useSelection()`, NOT a Set (round 70).
     *
     * A Set here meant a new object on every tick, which re-rendered this
     * whole board — 596 live card subtrees on the owner's funnel — to change
     * one checkbox. The store's identity never changes, so a tick does not
     * reach this component at all.
     */
    store: SelectionStore;
    /** Already translated: a client component cannot resolve a namespace. */
    label: string;
  };
}

export function KanbanBoard<T extends KanbanItem>({
  stages,
  items,
  labels,
  renderCard,
  hrefOf,
  onMove,
  cardTestId = 'kanban-card',
  selection,
  hidden = {},
  archiveHref,
}: BoardProps<T>) {
  const [placement, setPlacement] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // ONE move sheet for both shapes. It used to live inside the phone view,
  // which was fine while the desktop board's only way to move a card was a
  // drag — and a drag is now a mouse's alone.
  const [sheetFor, setSheetFor] = useState<T | null>(null);

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
      setError(null);
      const result = await onMove(item.id, stageId, reason);
      if (!result.ok) {
        setPlacement((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        // The CODE, not a boolean. «Xatolik» over a card that jumped back is
        // the screen telling somebody to guess: a stage deleted under an open
        // board, a permission taken away, a lost move with no reason — three
        // different situations and three different next actions.
        setError(result.error ?? 'failed');
      }
    },
    [placement, stages, labels.lostReason, onMove],
  );

  const counts = Object.fromEntries(
    stages.map((stage) => [
      stage.id,
      items.filter((item) => stageOf(item) === stage.id).length + (hidden[stage.id] ?? 0),
    ]),
  );
  const view = {
    stages,
    items,
    counts,
    hidden,
    archiveHref,
    stageOf,
    move,
    labels,
    renderCard,
    hrefOf,
    cardTestId,
    selection,
    setSheetFor,
  };

  return (
    <>
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="kanban-error">
          {labels.moveErrors[error] ?? labels.error}
        </p>
      )}

      <div data-testid="funnel-mobile" className="md:hidden">
        <StageView {...view} />
      </div>
      <div data-testid="funnel-desktop" className="hidden md:block">
        <DragBoard {...view} />
      </div>

      {/* The move sheet, owned by the board rather than by either shape: the
          phone opens it from a card's ⋯, and so does the desktop board, which
          since the drag became a mouse's alone is the only way a tablet can
          move anything. */}
      {sheetFor && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40"
          onClick={() => setSheetFor(null)}
        >
          <div
            className="pb-safe max-h-[80vh] w-full space-y-1.5 overflow-y-auto rounded-t-2xl bg-surface-raised p-4 md:mx-auto md:mb-auto md:mt-24 md:max-w-sm md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="section-title">{labels.moveTo}</p>
            {stages
              .filter((stage) => stage.id !== (placement[sheetFor.id] ?? sheetFor.stageId))
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
    </>
  );
}

interface ViewProps<T extends KanbanItem> {
  stages: KanbanStage[];
  items: T[];
  counts: Record<string, number>;
  hidden: Record<string, number>;
  archiveHref?: string;
  stageOf: (item: T) => string;
  move: (item: T, stageId: string) => void | Promise<void>;
  labels: KanbanLabels;
  renderCard: (item: T) => ReactNode;
  hrefOf: (item: T) => string;
  cardTestId: string;
  selection?: BoardProps<T>['selection'];
  /** Both shapes open the ONE sheet the board owns. */
  setSheetFor: (item: T | null) => void;
}

/**
 * The tick in the corner of a card.
 *
 * `stopPropagation` AND `preventDefault`, because on the desktop board the
 * card itself IS the anchor and also carries the drag's pointer handlers: a
 * bare checkbox there would navigate to the card and start a drag on the way.
 */
function SelectBox({
  id,
  selection,
}: {
  id: string;
  selection: NonNullable<BoardProps<KanbanItem>['selection']>;
}) {
  // This checkbox subscribes to its OWN id and to nothing else, which is what
  // keeps a tick from costing the board a full re-render.
  const checked = selection.store.useIsSelected(id);
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={selection.label}
      data-testid="card-select"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        selection.store.toggle(id);
      }}
      onChange={() => {}}
      className="h-5 w-5 shrink-0 accent-brand-600"
    />
  );
}

/**
 * The phone's board: one full-width column per screen, swiped sideways.
 *
 * The strip along the top IS the funnel — every stage and its count at a
 * glance, which is the thing a board is opened for. A swipe moves between
 * columns the way the thumb expects (owner's ask: the amoCRM feel), a chip
 * tap jumps straight to a far stage, and each column keeps the desktop
 * board's sunken full-height shape: the CARDS scroll inside the column, the
 * strip never leaves the top of the screen.
 */
function StageView<T extends KanbanItem>({
  stages,
  items,
  counts,
  hidden,
  archiveHref,
  stageOf,
  move,
  labels,
  renderCard,
  hrefOf,
  cardTestId,
  selection,
  setSheetFor,
}: ViewProps<T>) {
  // Open on the first stage that has anything in it: an empty "new" column is
  // a wasted first screen when the work is three stages along.
  const [activeId, setActiveId] = useState(
    () => stages.find((stage) => counts[stage.id])?.id ?? stages[0]?.id ?? '',
  );
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // A chip tap starts a smooth scroll that fires the same onScroll the thumb
  // does; without this guard the mid-flight positions would fight the tap for
  // ownership of the active chip.
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A stage deleted or reordered under us must not leave the screen blank.
  const active = stages.find((stage) => stage.id === activeId) ?? stages[0];

  // Keep the chosen stage on screen — with eight stages the one you are
  // looking at is often off the end of the strip.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeId]);

  // Land on the opening stage without an animation on the first frame.
  useEffect(() => {
    const track = trackRef.current;
    const index = stages.findIndex((stage) => stage.id === activeId);
    const column = track?.children[index] as HTMLElement | undefined;
    if (track && column && index > 0) track.scrollLeft = column.offsetLeft - track.offsetLeft;
    // Mount only: afterwards the scroll position is the truth, not the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = (stageId: string) => {
    const track = trackRef.current;
    const index = stages.findIndex((stage) => stage.id === stageId);
    const column = track?.children[index] as HTMLElement | undefined;
    if (!track || !column) return;
    setActiveId(stageId);
    if (settling.current) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = null;
    }, 600);
    track.scrollTo({ left: column.offsetLeft - track.offsetLeft, behavior: 'smooth' });
  };

  // The scroll position is the truth for which stage is active: whichever
  // column's centre sits nearest the viewport centre owns the chip.
  const onTrackScroll = () => {
    if (settling.current) return;
    const track = trackRef.current;
    if (!track) return;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = -1;
    let bestDistance = Infinity;
    Array.from(track.children).forEach((child, index) => {
      const el = child as HTMLElement;
      const distance = Math.abs(el.offsetLeft - track.offsetLeft + el.offsetWidth / 2 - mid);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    const stage = stages[best];
    if (stage && stage.id !== activeId) setActiveId(stage.id);
  };

  return (
    <div className="space-y-2">
      {/* Sticky under the app bar (h-14), so the funnel survives a long
          column: the cards scroll, the map of the stages does not. */}
      <div
        ref={stripRef}
        className="sticky top-14 z-10 -mx-4 flex gap-1.5 overflow-x-auto bg-surface px-4 py-1.5"
      >
        {stages.map((stage) => {
          const on = stage.id === active?.id;
          return (
            <button
              key={stage.id}
              type="button"
              data-testid="stage-tab"
              data-active={on}
              onClick={() => goTo(stage.id)}
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

      <div
        ref={trackRef}
        onScroll={onTrackScroll}
        data-testid="stage-track"
        className="-mx-4 flex h-[calc(100dvh-12rem-var(--board-extra,0px))] min-h-[18rem] snap-x snap-mandatory gap-3 overflow-x-auto px-4"
      >
        {stages.map((stage) => {
          const inStage = items.filter((item) => stageOf(item) === stage.id);
          const nextStage = stages[stages.indexOf(stage) + 1];
          return (
            <section
              key={stage.id}
              data-stage-id={stage.id}
              className="flex h-full w-full shrink-0 snap-center flex-col rounded-lg bg-surface-sunken"
            >
              <header
                className={`rounded-lg border px-3 py-2 text-sm font-bold ${stageClass(
                  stage.color,
                )}`}
              >
                {stage.name}
                <span className="ml-2 opacity-70">{counts[stage.id]}</span>
              </header>
              {/* pb-24: the bulk bar is a FIXED overlay over the column's
                  bottom edge, so without spare scroll the LAST card's
                  checkbox sits under it permanently — unreachable for a
                  thumb, intercepted for Playwright. Unconditional because
                  ticks deliberately never re-render the board (#543). */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 pb-24">
                {inStage.map((item) => (
                  <div key={item.id} data-testid={cardTestId} className="card !p-3">
                    <Link href={hrefOf(item)} className="block">
                      {renderCard(item)}
                    </Link>
                    <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                      {selection && <SelectBox id={item.id} selection={selection} />}
                      {/* One tap for the move that happens ten times a day;
                          the sheet for everything else. */}
                      {nextStage && (
                        <button
                          type="button"
                          data-testid="move-next"
                          onClick={() => void move(item, nextStage.id)}
                          className="btn-secondary min-w-0 flex-1 !justify-start"
                        >
                          <Icon name="chevronRight" className="h-4 w-4 shrink-0" />
                          <span className="truncate">{nextStage.name}</span>
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
                ))}
                {inStage.length === 0 && (hidden[stage.id] ?? 0) === 0 && (
                  <p className="px-1 pt-1 text-center text-sm text-ink-500">{labels.empty}</p>
                )}
                {(hidden[stage.id] ?? 0) > 0 && archiveHref && (
                  <Link
                    href={archiveHref}
                    data-testid="stage-archive-link"
                    className="block rounded-lg border border-dashed border-line px-2 py-1.5 text-center text-xs font-semibold text-ink-500 hover:bg-surface-raised"
                  >
                    +{hidden[stage.id]} · {labels.showAll}
                  </Link>
                )}
              </div>
            </section>
          );
        })}
      </div>
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
  hidden,
  archiveHref,
  stageOf,
  move,
  labels,
  renderCard,
  hrefOf,
  cardTestId,
  selection,
  setSheetFor,
}: ViewProps<T>) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopScrolling = () => {
    if (scrollTimer.current) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };

  const cleanup = useCallback(() => {
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

  const onPointerDown = (event: React.PointerEvent) => {
    // A MOUSE, and nothing else. Which board a viewer gets is decided by width
    // alone (`md`, 768 px), so before this guard a tablet held a card for
    // 250 ms and dragged it — the touch drag the owner refused twice.
    //
    // The guard comes FIRST for a reason. Arming `start` and then returning
    // for a finger leaves the move handler holding a live origin, and the drag
    // then starts on the next 8 px with no hold at all: worse than what it
    // fixes.
    if (event.pointerType !== 'mouse') return;
    // Only the primary button; a right-click must not pick a card up.
    if (event.button !== 0) return;
    dragged.current = false;
    start.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent, item: T) => {
    if (event.pointerType !== 'mouse') return;
    
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    const moved = Math.hypot(dx, dy);

    if (dragId !== item.id) {
      if (moved < MOVE_THRESHOLD) return;
      dragged.current = true;
      setDragId(item.id);
      setOverStage(stageOf(item));
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
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
      <p className="text-xs text-ink-500">🖱 {labels.dragHint}</p>
      <div
        ref={boardRef}
        // The board owns the rest of the viewport and the COLUMNS scroll,
        // not the page (owner: "har bir kanban column pastgacha davom etardi,
        // pastidan scroll chiqib qolmasdi" — the amoCRM shape). The page
        // never grows below the board, so its scrollbar disappears; a long
        // column scrolls inside itself with the header staying put.
        className="-mx-4 h-[calc(100dvh-10rem-var(--board-extra,0px))] min-h-[20rem] overflow-x-auto px-4"
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
                {/* pb-24: same spare scroll as the phone board — the bulk
                    bar floats over the column bottom on desktop too. */}
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 pb-24">
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
                      onPointerDown={onPointerDown}
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
                      {/* The way to move a card that is NOT a drag. Load-bearing
                          rather than a convenience: which board a viewer gets is
                          decided by width alone, so a tablet lands here — and
                          since the drag became a mouse's alone, without this
                          there would be no way to move anything at all.
                          Not gated on a pointer query: this file's own comment
                          says a trackpad can report as touch, and a machine that
                          answered «fine» to the query and «not a mouse» to the
                          event would get a board with neither door. */}
                      <span className="float-right ml-1 flex items-center gap-1">
                        {selection && <SelectBox id={item.id} selection={selection} />}
                        <button
                          type="button"
                          data-testid="move-other"
                          aria-label={labels.moveTo}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            // The card IS the anchor and carries the drag —
                            // SelectBox's lesson, one element over.
                            event.stopPropagation();
                            event.preventDefault();
                            setSheetFor(item);
                          }}
                          className="btn-secondary btn-icon !min-h-7 !w-7 shrink-0 !p-0 text-xs"
                        >
                          ⋯
                        </button>
                      </span>
                      {renderCard(item)}
                    </Link>
                  ))}
                  {inStage.length === 0 && (hidden[stage.id] ?? 0) === 0 && (
                    <p className="px-1 text-xs text-ink-400">{labels.empty}</p>
                  )}
                  {(hidden[stage.id] ?? 0) > 0 && archiveHref && (
                    <Link
                      href={archiveHref}
                      data-testid="stage-archive-link"
                      className="block rounded-lg border border-dashed border-line px-2 py-1.5 text-center text-xs font-semibold text-ink-500 hover:bg-surface-raised"
                    >
                      +{hidden[stage.id]} · {labels.showAll}
                    </Link>
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
