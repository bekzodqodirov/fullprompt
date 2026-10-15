'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Clear a thread composer once per SUCCESSFUL send — keyed on the action's
 * fresh `sent` value, so a re-render never clears twice and a refusal never
 * clears at all (#463: «a form that can be refused must hold its inputs»).
 * One effect for both boxes (the calculation's and the cargo thread's).
 */
export function useClearOnSent(
  state: { ok?: boolean; sent?: number },
  formRef: RefObject<HTMLFormElement | null>,
): void {
  const cleared = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state.ok || state.sent === undefined || state.sent === cleared.current) return;
    cleared.current = state.sent;
    const box = formRef.current?.querySelector('textarea');
    if (box) {
      box.value = '';
      box.style.height = '';
    }
  }, [state, formRef]);
}
