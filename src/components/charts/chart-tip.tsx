'use client';

import { useEffect, useRef } from 'react';

/**
 * The dashboard's ONE hover layer: a single fixed tooltip that any element
 * carrying `data-tip` can raise. Every chart is a server component; this is
 * the only client code on the page, so 12 months × 4 charts cost no
 * hydration roots (round 95's lesson — 500 bubbles, one delegated listener).
 *
 * `data-tip` is plain text: the first line is the heading (the month, the
 * truck), each further line is «value<TAB>label». It is inserted with
 * `textContent`, never as HTML, because client, partner and category names
 * are data typed by people (dataviz rule: labels are untrusted).
 *
 * Mouse and keyboard open it on hover/focus; a TOUCH opens it on click, so a
 * scroll gesture that starts on a chart band never flashes a tip. It closes on
 * scroll, on Escape and on a tap outside. The tooltip only ENHANCES — every
 * value is also in the chart's table twin.
 */
export function ChartTip() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let current: HTMLElement | null = null;

    const hide = () => {
      current = null;
      el.style.display = 'none';
    };

    const show = (target: HTMLElement) => {
      const text = target.dataset.tip;
      if (!text) return;
      current = target;
      el.replaceChildren();
      const [heading, ...rows] = text.split('\n');
      if (heading) {
        const h = document.createElement('div');
        h.className = 'mb-1 text-2xs font-semibold text-ink-500';
        h.textContent = heading;
        el.appendChild(h);
      }
      for (const row of rows) {
        const [value, label] = row.split('\t');
        const line = document.createElement('div');
        line.className = 'flex items-baseline justify-between gap-3 whitespace-nowrap';
        const l = document.createElement('span');
        l.className = 'text-ink-500';
        l.textContent = label ?? '';
        const v = document.createElement('span');
        v.className = 'font-mono font-semibold tabular-nums text-ink-900';
        v.textContent = value ?? '';
        line.append(l, v);
        el.appendChild(line);
      }
      el.style.display = 'block';
      const rect = target.getBoundingClientRect();
      const tip = el.getBoundingClientRect();
      const margin = 8;
      let left = rect.left + rect.width / 2 - tip.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
      let top = rect.top - tip.height - margin;
      if (top < margin) top = Math.min(rect.bottom + margin, window.innerHeight - tip.height - margin);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    };

    const tipOf = (node: EventTarget | null) =>
      node instanceof Element ? (node.closest('[data-tip]') as HTMLElement | null) : null;

    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const target = tipOf(event.target);
      if (target && target !== current) show(target);
    };
    const onOut = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !current) return;
      const to = tipOf(event.relatedTarget);
      if (to !== current) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tipOf(event.target);
      if (target) show(target);
    };
    const onFocusOut = () => hide();
    const onClick = (event: MouseEvent) => {
      const target = tipOf(event.target);
      if (!target) {
        hide();
        return;
      }
      if (target === current) hide();
      else show(target);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, { capture: true });
    };
  }, []);

  return (
    <div
      ref={box}
      role="tooltip"
      aria-hidden
      style={{ display: 'none' }}
      className="pointer-events-none fixed z-50 min-w-40 max-w-[calc(100vw-16px)] rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs shadow-pop"
    />
  );
}
