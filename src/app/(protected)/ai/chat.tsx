'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { autogrow, sendOnEnter, useCoarsePointer } from '@/components/composer';
import { askAiAction, type AiTurn } from './actions';

/**
 * The /ai conversation. History lives HERE, in React state — the server
 * keeps nothing between questions, so closing the tab is forgetting, which
 * is the honest shape for v1 (the bot's messages stand alone the same way).
 * Only the last eight turns ride along with a question.
 */
export function AiChat() {
  const t = useTranslations('assistant');
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const coarse = useCoarsePointer();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const send = () => {
    const question = draft.trim();
    if (!question || pending) return;
    const history = turns.slice(-8);
    setTurns((prev) => [...prev, { role: 'user', text: question }]);
    setDraft('');
    startTransition(async () => {
      const outcome = await askAiAction({ question, history }).catch(
        () => ({ status: 'error' }) as const,
      );
      const text =
        outcome.status === 'ok'
          ? outcome.answer
          : outcome.status === 'gave_up'
            ? (outcome.answer ?? t('gaveUp'))
            : outcome.status === 'limit'
              ? t('limit')
              : outcome.status === 'not_configured'
                ? t('notConfigured')
                : t('error');
      setTurns((prev) => [...prev, { role: 'assistant', text }]);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }));
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2" data-testid="ai-turns">
        {turns.map((turn, i) => (
          <div
            key={i}
            data-testid={`ai-${turn.role}`}
            className={
              turn.role === 'user'
                ? 'ml-8 whitespace-pre-wrap rounded-xl bg-surface-sunken px-3 py-2 text-sm'
                : 'mr-8 whitespace-pre-wrap rounded-xl border border-line bg-surface-raised px-3 py-2 text-sm'
            }
          >
            {turn.text}
          </div>
        ))}
        {pending && (
          <p className="mr-8 text-sm text-ink-500" data-testid="ai-thinking">
            {t('thinking')}
          </p>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={boxRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autogrow(e.target);
          }}
          onKeyDown={(e) => sendOnEnter(e, coarse, send)}
          rows={2}
          maxLength={2000}
          placeholder={t('placeholder')}
          className="input h-auto max-h-40 min-w-0 flex-1 resize-none"
          data-testid="ai-question"
          disabled={pending}
        />
        <button
          type="button"
          className="btn btn-primary shrink-0"
          onClick={send}
          disabled={pending || !draft.trim()}
          data-testid="ai-send"
        >
          {t('send')}
        </button>
      </div>
    </div>
  );
}
