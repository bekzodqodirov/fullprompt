'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  agentAddFactAction,
  agentApproveStyleAction,
  agentDecideAction,
  agentModeAction,
  agentNumbersAction,
  agentOwnTextAction,
  agentOwnerAction,
  agentRememberAction,
  agentRetireFactAction,
  agentSessionAction,
  type AgentActionResult,
} from '@/modules/wms/agent/web-actions';
import { errorKey } from './labels';

/**
 * The page's buttons. Each calls ONE server action — the same function the
 * staff bot's press calls — and says a refusal in words (`labels.ts` maps the
 * code; nothing here prints a code). Inputs are CONTROLLED and survive a
 * refusal: React resets an uncontrolled form after its action, and a typed
 * reply that vanished on «policy_block» is the round-49 complaint (#463).
 * No `router.refresh()`: every action revalidates the page itself (#1242).
 */

function useAction() {
  const t = useTranslations('agentAi');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = (work: () => Promise<AgentActionResult>, onOk?: (res: AgentActionResult) => void) =>
    start(async () => {
      const res = await work();
      if (res.ok) {
        setError(null);
        setNote(res.message ?? null);
        onOk?.(res);
      } else {
        setNote(null);
        setError(t(errorKey(res.error) as 'errors.unknown'));
      }
    });
  return { pending, error, note, run };
}

function Feedback({ error, note }: { error: string | null; note: string | null }) {
  return (
    <>
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="agent-error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="whitespace-pre-wrap text-sm text-ink-700" data-testid="agent-note">
          {note}
        </p>
      )}
    </>
  );
}

/**
 * ✅ ✏️ ❌ 🙋 on one draft. Drawn for its ACCOUNT HOLDER only — a message
 * leaves a personal account only by its holder (leak-5); everyone else who
 * may open the page reads the card and is told whose decision it is. No ✅ on
 * a blocked draft (leak-3): ✏️ is the way through.
 */
export function DraftActions({
  draftId,
  digest,
  body,
  holder,
  holderName,
  canSend,
}: {
  draftId: string;
  digest: string;
  body: string;
  holder: boolean;
  holderName: string;
  canSend: boolean;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, note, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  if (!holder) {
    return (
      <p className="text-xs text-ink-500" data-testid="agent-not-holder">
        {t('notHolder', { name: holderName })}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canSend && (
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            data-testid="agent-send"
            onClick={() => run(() => agentDecideAction(draftId, 'send', digest))}
          >
            ✅ {t('send')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-edit"
          onClick={() => setEditing((was) => !was)}
        >
          ✏️ {t('edit')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-reject"
          onClick={() => run(() => agentDecideAction(draftId, 'reject', null))}
        >
          ❌ {t('reject')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-human"
          onClick={() => run(() => agentDecideAction(draftId, 'human', null))}
        >
          🙋 {t('human')}
        </button>
      </div>
      {editing && (
        <div className="space-y-2" data-testid="agent-edit-box">
          <label className="label" htmlFor={`own-${draftId}`}>
            {t('ownTextLabel')}
          </label>
          <textarea
            id={`own-${draftId}`}
            className="input h-28"
            value={text}
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
            data-testid="agent-own-text"
          />
          <p className="text-xs text-ink-500">{t('ownTextHint')}</p>
          <button
            type="button"
            className="btn-primary"
            disabled={pending || text.trim() === ''}
            data-testid="agent-own-save"
            onClick={() => run(() => agentOwnTextAction(draftId, text), () => setEditing(false))}
          >
            {t('ownTextSave')}
          </button>
        </div>
      )}
      <Feedback error={error} note={note} />
    </div>
  );
}

/** «Bilimga yozaymi?» after he answered the question himself — the bot's 📌 / 👤 / ✖, one press each. */
export function RememberButtons({ draftId, armed }: { draftId: string; armed: boolean }) {
  const t = useTranslations('agentAi');
  const { pending, error, note, run } = useAction();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-remember-general"
          onClick={() => run(() => agentRememberAction(draftId, 'g'))}
        >
          📌 {armed ? t('rememberGeneralConfirm') : t('rememberGeneral')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-remember-client"
          onClick={() => run(() => agentRememberAction(draftId, 'u'))}
        >
          👤 {t('rememberClient')}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          data-testid="agent-remember-skip"
          onClick={() => run(() => agentRememberAction(draftId, 'z'))}
        >
          ✖ {t('rememberSkip')}
        </button>
      </div>
      <Feedback error={error} note={note} />
    </div>
  );
}

/** A general fact — the exact words the agent may state to every customer. */
export function FactForm() {
  const t = useTranslations('agentAi');
  const { pending, error, note, run } = useAction();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  return (
    <div className="card space-y-2" data-testid="agent-fact-form">
      <h3 className="text-sm font-bold">{t('factAdd')}</h3>
      <label className="label" htmlFor="fact-question">
        {t('factQuestion')}
      </label>
      <input
        id="fact-question"
        className="input"
        value={question}
        maxLength={300}
        onChange={(event) => setQuestion(event.target.value)}
        data-testid="agent-fact-question"
      />
      <label className="label" htmlFor="fact-answer">
        {t('factAnswer')}
      </label>
      <textarea
        id="fact-answer"
        className="input h-28"
        value={answer}
        maxLength={2000}
        onChange={(event) => setAnswer(event.target.value)}
        data-testid="agent-fact-answer"
      />
      <p className="text-xs text-ink-500">{t('factHint')}</p>
      <button
        type="button"
        className="btn-primary"
        disabled={pending || answer.trim() === ''}
        data-testid="agent-fact-save"
        onClick={() =>
          run(
            () => agentAddFactAction(question, answer),
            () => {
              setQuestion('');
              setAnswer('');
            },
          )
        }
      >
        {t('factSave')}
      </button>
      <Feedback error={error} note={note} />
    </div>
  );
}

export function RetireButton({ factId }: { factId: string }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-ghost !min-h-8 !px-2 text-xs"
        disabled={pending}
        data-testid="agent-fact-retire"
        onClick={() => {
          if (!window.confirm(t('factRetireConfirm'))) return;
          run(() => agentRetireFactAction(factId));
        }}
      >
        {t('factRetire')}
      </button>
      {error && <span className="text-xs font-semibold text-bad">{error}</span>}
    </span>
  );
}

/** On (shadow — he approves every reply) or off (the kill switch: nothing left to send). */
export function ModeSwitch({ running }: { running: boolean }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      {running ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-mode-off"
          onClick={() => {
            if (!window.confirm(t('modeOffConfirm'))) return;
            run(() => agentModeAction('off'));
          }}
        >
          ⏹ {t('modeOff')}
        </button>
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          data-testid="agent-mode-on"
          onClick={() => run(() => agentModeAction('shadow'))}
        >
          🤖 {t('modeOn')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/** Whose account the agent speaks from — the super_admin's choice, while it is off. */
export function OwnerPicker({
  options,
  current,
}: {
  options: { id: string; label: string }[];
  current: string | null;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const [value, setValue] = useState(current ?? '');
  return (
    <div className="space-y-2" data-testid="agent-owner-picker">
      <label className="label" htmlFor="agent-owner">
        {t('ownerPick')}
      </label>
      <div className="flex flex-wrap gap-2">
        <select
          id="agent-owner"
          className="input min-w-0 flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          data-testid="agent-owner-select"
        >
          <option value="">{t('ownerNone')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || value === (current ?? '')}
          data-testid="agent-owner-save"
          onClick={() => run(() => agentOwnerAction(value || null))}
        >
          {t('save')}
        </button>
      </div>
      <Feedback error={error} note={null} />
    </div>
  );
}

/** «Eski serverda Telegram sessiyasi yo'q qilindi» — the agent cannot leave «off» until somebody says so (ban-9). */
export function SessionConfirm() {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        data-testid="agent-session-confirm"
        onClick={() => {
          if (!window.confirm(t('sessionConfirmAsk'))) return;
          run(() => agentSessionAction());
        }}
      >
        {t('sessionConfirm')}
      </button>
      <Feedback error={error} note={null} />
    </div>
  );
}

export function NumbersForm({
  humanPauseMin,
  dailyDraftCap,
  dailyTokenCap,
}: {
  humanPauseMin: number;
  dailyDraftCap: number;
  dailyTokenCap: number;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, note, run } = useAction();
  const [values, setValues] = useState({
    humanPauseMin: String(humanPauseMin),
    dailyDraftCap: String(dailyDraftCap),
    dailyTokenCap: String(dailyTokenCap),
  });
  const field = (key: keyof typeof values, label: string, hint: string) => (
    <div className="space-y-1">
      <label className="label" htmlFor={`agent-${key}`}>
        {label}
      </label>
      <input
        id={`agent-${key}`}
        className="input"
        inputMode="numeric"
        value={values[key]}
        onChange={(event) => setValues((was) => ({ ...was, [key]: event.target.value }))}
        data-testid={`agent-number-${key}`}
      />
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
  return (
    <div className="space-y-2" data-testid="agent-numbers">
      {field('humanPauseMin', t('numPause'), t('numPauseHint'))}
      {field('dailyDraftCap', t('numDrafts'), t('numDraftsHint'))}
      {field('dailyTokenCap', t('numTokens'), t('numTokensHint'))}
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        data-testid="agent-numbers-save"
        onClick={() => run(() => agentNumbersAction(values), () => undefined)}
      >
        {t('save')}
      </button>
      <Feedback error={error} note={note} />
    </div>
  );
}

export function StyleApprove() {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        data-testid="agent-style-approve"
        onClick={() => run(() => agentApproveStyleAction())}
      >
        {t('styleApprove')}
      </button>
      <Feedback error={error} note={null} />
    </div>
  );
}
