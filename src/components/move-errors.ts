'use client';

import { useTranslations } from 'next-intl';

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
 *
 * It lives in its own module rather than in `kanban.tsx` because the LEAD
 * CARD's stage fold needs the same six strings (round 76), and importing
 * them from the board would pull `DragBoard`, the move sheet and every
 * pointer handler into that card's client bundle to render a sentence.
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
