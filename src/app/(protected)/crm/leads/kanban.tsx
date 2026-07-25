'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { moveLeadAction } from '../actions';
import { stageClass } from '../stage-color';

export interface KanbanStage {
  id: string;
  name: string;
  kind: string;
  color: string;
}

export interface KanbanLead {
  id: string;
  stageId: string;
  name: string;
  company: string | null;
  phone: string | null;
  sourceName: string | null;
  ownerName: string | null;
  clientCode: string | null;
  nextActionAt: string | null;
}

/** Below this the gesture is a scroll or a tap, not a drag. */
const MOVE_THRESHOLD = 8;
/** A touch has to be held this long before the card comes off the board. */
const HOLD_MS = 250;
/** Auto-scroll the board when the finger nears an edge. */
const EDGE = 48;
const EDGE_STEP = 12;

/**
 * Drag a lead from one stage to the next (owner: "ushlab statusdan statusga
 * o'tkazish").
 *
 * Written against Pointer Events rather than HTML5 drag-and-drop, which does
 * not fire on touch at all — and this board is used on a phone first. No
 * library: a drag-and-drop package would be a bigger dependency than the
 * 150 lines it replaces, and it would still need the touch handling below.
 *
 * Touch starts the drag on a long press, so a normal swipe still scrolls the
 * board and a normal tap still opens the card. A mouse skips the wait and
 * starts as soon as the pointer has actually moved.
 */
export function KanbanBoard({
  stages,
  leads,
}: {
  stages: KanbanStage[];
  leads: KanbanLead[];
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [placement, setPlacement] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState(false);

  const boardRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // The server is the truth; `placement` only holds a card in its new column
  // between the drop and the revalidation, so the card never jumps back for
  // half a second. Cleared the moment fresh rows arrive — adjusted during
  // render rather than in an effect, so there is no frame where the optimistic
  // position and the server's disagree.
  const [renderedLeads, setRenderedLeads] = useState(leads);
  if (renderedLeads !== leads) {
    setRenderedLeads(leads);
    setPlacement({});
  }
  const stageOf = (lead: KanbanLead) => placement[lead.id] ?? lead.stageId;

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

  /** Which column is under the finger right now. */
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

  const drop = async (lead: KanbanLead, stageId: string) => {
    const stage = stages.find((row) => row.id === stageId);
    if (!stage || stage.id === stageOf(lead)) return;

    let reason = '';
    if (stage.kind === 'lost') {
      // Same rule as the lead card: a lost deal has to say why, and a
      // cancelled prompt leaves the card where it was.
      reason = window.prompt(t('lostReason')) ?? '';
      if (reason.trim().length < 2) return;
    }

    setPlacement((current) => ({ ...current, [lead.id]: stageId }));
    setError(false);
    const result = await moveLeadAction(lead.id, stageId, reason);
    if (!result.ok) {
      setPlacement((current) => {
        const next = { ...current };
        delete next[lead.id];
        return next;
      });
      setError(true);
    }
  };

  const onPointerDown = (event: React.PointerEvent, lead: KanbanLead) => {
    // Only the primary button; a right-click must not pick a card up.
    if (event.button !== 0) return;
    dragged.current = false;
    start.current = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget as HTMLElement;

    const begin = () => {
      dragged.current = true;
      setDragId(lead.id);
      setGhost({ x: event.clientX, y: event.clientY });
      setOverStage(stageOf(lead));
      target.setPointerCapture?.(event.pointerId);
      navigator.vibrate?.(15);
    };

    if (event.pointerType === 'mouse') return; // starts on movement instead
    holdTimer.current = setTimeout(begin, HOLD_MS);
  };

  const onPointerMove = (event: React.PointerEvent, lead: KanbanLead) => {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    const moved = Math.hypot(dx, dy);

    if (dragId !== lead.id) {
      if (moved < MOVE_THRESHOLD) return;
      if (event.pointerType === 'mouse') {
        dragged.current = true;
        setDragId(lead.id);
        setOverStage(stageOf(lead));
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      } else {
        // The finger moved before the hold completed — that is a scroll.
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

  const onPointerUp = (lead: KanbanLead) => {
    const target = overStage;
    const wasDragging = dragId === lead.id;
    cleanup();
    if (wasDragging && target) void drop(lead, target);
  };

  const counts = Object.fromEntries(
    stages.map((stage) => [stage.id, leads.filter((lead) => stageOf(lead) === stage.id).length]),
  );
  const dragLead = leads.find((lead) => lead.id === dragId) ?? null;

  return (
    <>
      <p className="text-xs text-gray-500">✋ {t('dragHint')}</p>
      {error && <p className="text-sm font-semibold text-red-700">{tc('error')}</p>}

      <div
        ref={boardRef}
        className="-mx-4 overflow-x-auto px-4 pb-2"
        // While a card is in the air the board must not pan under it: the
        // finger is already down, so the browser would otherwise treat the
        // same gesture as a scroll.
        style={{ touchAction: dragId ? 'none' : undefined }}
      >
        <div className="flex gap-3">
          {stages.map((stage) => {
            const inStage = leads.filter((lead) => stageOf(lead) === stage.id);
            const isTarget = dragId !== null && overStage === stage.id;
            return (
              <section
                key={stage.id}
                data-stage-id={stage.id}
                data-testid={`column-${stage.kind}`}
                className={`w-64 shrink-0 rounded-lg ${
                  isTarget ? 'bg-blue-50 ring-2 ring-blue-500' : ''
                }`}
              >
                <header
                  className={`sticky top-0 rounded-lg border px-3 py-2 text-sm font-bold ${stageClass(
                    stage.color,
                  )}`}
                >
                  {stage.name}
                  <span className="ml-2 opacity-70">{counts[stage.id]}</span>
                </header>
                <div className="mt-2 min-h-16 space-y-2">
                  {inStage.map((lead) => (
                    <Link
                      key={lead.id}
                      href={`/crm/leads/${lead.id}`}
                      data-testid="lead-card"
                      // An anchor is natively draggable, and that native drag
                      // fires pointercancel — which killed the gesture the
                      // moment the card started to move.
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                      onPointerDown={(event) => onPointerDown(event, lead)}
                      onPointerMove={(event) => onPointerMove(event, lead)}
                      onPointerUp={() => onPointerUp(lead)}
                      onPointerCancel={cleanup}
                      onClick={(event) => {
                        // A drag must not also open the card underneath it.
                        if (dragged.current) event.preventDefault();
                      }}
                      className={`card block !p-2.5 select-none hover:bg-gray-50 ${
                        dragId === lead.id ? 'opacity-30' : ''
                      }`}
                      style={{ touchAction: dragId === lead.id ? 'none' : undefined }}
                    >
                      <LeadCardBody lead={lead} />
                    </Link>
                  ))}
                  {inStage.length === 0 && (
                    <p className="px-1 text-xs text-gray-400">{t('empty')}</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {dragLead && ghost && (
        <div
          className="card pointer-events-none fixed z-50 w-56 !p-2.5 shadow-xl ring-2 ring-blue-600"
          style={{ left: ghost.x - 112, top: ghost.y - 28 }}
        >
          <LeadCardBody lead={dragLead} />
        </div>
      )}
    </>
  );
}

function LeadCardBody({ lead }: { lead: KanbanLead }) {
  return (
    <>
      <div className="font-semibold [overflow-wrap:anywhere]">{lead.name}</div>
      {lead.company && <div className="text-xs text-gray-600">{lead.company}</div>}
      {lead.phone && <div className="font-mono text-xs">{lead.phone}</div>}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
        {lead.sourceName && <span className="rounded bg-gray-100 px-1.5">{lead.sourceName}</span>}
        {lead.ownerName && <span>{lead.ownerName}</span>}
        {lead.clientCode && (
          <span className="font-mono font-bold text-green-700">{lead.clientCode}</span>
        )}
      </div>
      {lead.nextActionAt && (
        <div className="mt-1 text-[11px] font-semibold text-amber-700">📅 {lead.nextActionAt}</div>
      )}
    </>
  );
}
