'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  agentAddFactAction,
  agentApproveStyleAction,
  agentAutoArmAction,
  agentAutoCategoriesAction,
  agentAutoFeedbackAction,
  agentAutoPerDayAction,
  agentAutoStopAction,
  agentAviaRateAction,
  agentDecideAction,
  agentEditFactAction,
  agentEditOpenAction,
  agentModeAction,
  agentNumbersAction,
  agentOwnTextAction,
  agentOwnerAction,
  agentRememberAction,
  agentRetireFactAction,
  agentSendCapsAction,
  agentConfirmTariffAction,
  agentSessionAction,
  type AgentActionResult,
} from '@/modules/wms/agent/web-actions';
// The kinds' one home (a pure module): never the gate, which would pull the send step into this bundle.
import { AUTO_SEND_CATEGORIES } from '@/modules/wms/agent/auto-categories';
import { CATEGORY_KEYS, errorKey } from './labels';

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
        const words = t(errorKey(res.error) as 'errors.unknown');
        // A money refusal names the number it read as a price (F7) — never «a price» about a text with none.
        setError(res.detail ? `${words} ${t('errors.figureRead', { figure: res.detail })}` : words);
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
  waitingInChat,
  autoWaiting = false,
}: {
  draftId: string;
  digest: string;
  body: string;
  holder: boolean;
  holderName: string;
  canSend: boolean;
  /** The chat's approved replies still waiting — 🙋 takes them back too, so it asks first (F10). */
  waitingInChat: number;
  /** «O'zi yuborish» counts down on this card: ⏸ first, and ✅ is «send now» — the bot's keyboard. */
  autoWaiting?: boolean;
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
        {autoWaiting && (
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            data-testid="agent-auto-stop"
            onClick={() => run(() => agentAutoStopAction(draftId))}
          >
            ⏸ {t('autoStop')}
          </button>
        )}
        {canSend && (
          <button
            type="button"
            className={autoWaiting ? 'btn-secondary' : 'btn-primary'}
            disabled={pending}
            data-testid="agent-send"
            onClick={() => run(() => agentDecideAction(draftId, 'send', digest))}
          >
            ✅ {autoWaiting ? t('sendNow') : t('send')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-edit"
          onClick={() => {
            if (editing) {
              setEditing(false);
              return;
            }
            // The server FIRST (fix pass B, C1): a reply counting down to the machine's press stops before the box
            // opens — never his typing while the AI's own text goes. «Kech» when the press already went: no box.
            run(() => agentEditOpenAction(draftId), () => setEditing(true));
          }}
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
          onClick={() => {
            if (waitingInChat > 0 && !window.confirm(t('humanWithdrawConfirm', { count: waitingInChat }))) return;
            run(() => agentDecideAction(draftId, 'human', null));
          }}
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
export function RememberButtons({ draftId, armToken }: { draftId: string; armToken: string | null }) {
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
          onClick={() => run(() => agentRememberAction(draftId, 'g', armToken ?? undefined))}
        >
          📌 {armToken ? t('rememberGeneralConfirm') : t('rememberGeneral')}
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

/**
 * ✏️ on one fact: its words in the add form's boxes, saved as a NEW approved
 * fact while the old one is retired (web-kb `editKbFact`) — the same money
 * and «nothing personal» refusals as adding, said in words.
 */
export function FactEditor({ factId, question, answer }: { factId: string; question: string | null; answer: string }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(question ?? '');
  const [a, setA] = useState(answer);
  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost !min-h-8 !px-2 text-xs"
        data-testid="agent-fact-edit"
        onClick={() => setOpen(true)}
      >
        ✏️ {t('factEdit')}
      </button>
    );
  }
  return (
    <div className="w-full space-y-2" data-testid="agent-fact-edit-box">
      <label className="label" htmlFor={`fact-q-${factId}`}>
        {t('factQuestion')}
      </label>
      <input
        id={`fact-q-${factId}`}
        className="input"
        value={q}
        maxLength={300}
        onChange={(event) => setQ(event.target.value)}
        data-testid="agent-fact-edit-question"
      />
      <label className="label" htmlFor={`fact-a-${factId}`}>
        {t('factAnswer')}
      </label>
      <textarea
        id={`fact-a-${factId}`}
        className="input h-28"
        value={a}
        maxLength={2000}
        onChange={(event) => setA(event.target.value)}
        data-testid="agent-fact-edit-answer"
      />
      <p className="text-xs text-ink-500">{t('factEditHint')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={pending || a.trim() === ''}
          data-testid="agent-fact-edit-save"
          onClick={() => run(() => agentEditFactAction(factId, q, a), () => setOpen(false))}
        >
          {t('factEditSave')}
        </button>
        <button type="button" className="btn-secondary" disabled={pending} onClick={() => setOpen(false)}>
          {t('factEditCancel')}
        </button>
      </div>
      <Feedback error={error} note={null} />
    </div>
  );
}

/** His avia rate, $/kg — an empty box means avia is not quoted. Refused in words, never rounded. */
export function AviaRateForm({ current }: { current: number | null }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const initial = current === null ? '' : String(current);
  const [value, setValue] = useState(initial);
  return (
    <div className="space-y-1" data-testid="agent-avia-rate">
      <label className="label" htmlFor="agent-avia-rate-input">
        {t('ruleAviaRateLabel')}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="agent-avia-rate-input"
          className="input min-w-0 flex-1"
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          data-testid="agent-avia-rate-input"
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || value.trim() === initial}
          data-testid="agent-avia-rate-save"
          onClick={() => run(() => agentAviaRateAction(value))}
        >
          {t('save')}
        </button>
      </div>
      <Feedback error={error} note={null} />
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

/**
 * «O'zi yuborish» on or off. Arming is the account holder's alone, and asks
 * first — from then on a reply the rules admit leaves his account without his
 * press; switching off is the holder's or any super_admin's, and never asks.
 * What arming would refuse (the agent off, the number not «Ish raqami») is
 * said by the panel BEFORE the press (fix pass B, C9), and the button is then
 * not offered — never a confirm about a switch that cannot move. A refusal
 * the page could not know of is still said in words.
 */
export function AutoArmButtons({
  armed,
  canArm,
  canDisarm,
  armBlocked = false,
}: {
  armed: boolean;
  canArm: boolean;
  canDisarm: boolean;
  /** Arming would be refused for a reason the panel already says above the button. */
  armBlocked?: boolean;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  if (armed && !canDisarm) return null;
  if (!armed && !canArm) {
    return (
      <p className="text-xs text-ink-500" data-testid="agent-auto-holder-only">
        {t('autoArmHolderOnly')}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {armed ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-auto-disarm"
          onClick={() => run(() => agentAutoArmAction(false))}
        >
          ⏹ {t('autoDisarm')}
        </button>
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={pending || armBlocked}
          data-testid="agent-auto-arm"
          onClick={() => {
            if (armBlocked) return;
            if (!window.confirm(t('autoArmConfirm'))) return;
            run(() => agentAutoArmAction(true));
          }}
        >
          🤖 {t('autoArm')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/**
 * Which kinds go by themselves — a replace-all of the boxes (the five of `AUTO_SEND_CATEGORIES`; the page drops
 * «Narx» on a server one migration behind 0146, `kinds`). Controlled, posted as one list by the action (never a
 * form whose disabled box posts nothing, #171); a reader who may not change it sees the boxes and no save.
 */
export function AutoCategoriesForm({
  current,
  editable,
  kinds = AUTO_SEND_CATEGORIES,
}: {
  current: readonly string[];
  editable: boolean;
  kinds?: readonly (typeof AUTO_SEND_CATEGORIES)[number][];
}) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const [chosen, setChosen] = useState<string[]>([...current]);
  const changed = chosen.length !== current.length || chosen.some((c) => !current.includes(c));
  return (
    <div className="space-y-2" data-testid="agent-auto-categories">
      <p className="text-sm font-semibold">{t('autoCategoriesTitle')}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {kinds.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chosen.includes(c)}
              disabled={!editable || pending}
              onChange={(event) =>
                setChosen((was) => (event.target.checked ? [...was.filter((x) => x !== c), c] : was.filter((x) => x !== c)))
              }
              data-testid={`agent-auto-category-${c}`}
            />
            {t(CATEGORY_KEYS[c] as 'category.greeting')}
          </label>
        ))}
      </div>
      <p className="text-xs text-ink-500">{t('autoCategoriesHint')}</p>
      {editable && (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !changed || chosen.length === 0}
          data-testid="agent-auto-categories-save"
          onClick={() => run(() => agentAutoCategoriesAction(chosen))}
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/** A typed whole number, or null for an empty box — anything else is the action's own `bad_value`, said in words. */
function typedCap(raw: string): number | null | 'bad' {
  const s = raw.trim();
  if (s === '') return null;
  return /^\d+$/u.test(s) ? Number(s) : 'bad';
}

/**
 * The layer's daily count (0146, his «7 chegara qoyma»): an empty box is «no cap», a number is a cap. The
 * holder's alone, as the kinds are; a reader who may not change it sees the value and no save. Controlled — a
 * refusal keeps what he typed (#463).
 */
export function AutoPerDayForm({ current, editable, max }: { current: number | null; editable: boolean; max: number }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const [value, setValue] = useState(current === null ? '' : String(current));
  const typed = typedCap(value);
  const changed = typed !== current;
  return (
    <div className="space-y-1" data-testid="agent-auto-per-day">
      <label className="label" htmlFor="agent-auto-per-day-input">
        {t('autoPerDayLabel')}
      </label>
      <input
        id="agent-auto-per-day-input"
        className="input"
        inputMode="numeric"
        value={value}
        disabled={!editable || pending}
        placeholder="—"
        onChange={(event) => setValue(event.target.value)}
        data-testid="agent-auto-per-day-input"
      />
      <p className="text-xs text-ink-500">{t('autoPerDayHint', { max })}</p>
      {editable && (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !changed}
          data-testid="agent-auto-per-day-save"
          onClick={() => run(() => agentAutoPerDayAction(value))}
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/**
 * The account-protection limits (0146, his «4 hozircha qolsin … o'zgartirish imkoni»): the agent's day and hour
 * caps, empty = today's default. The holder's or a super_admin's (`setSendCaps`). Controlled.
 */
export function SendCapsForm({
  stored,
  editable,
}: {
  stored: { dayCap: number | null; hourCap: number | null };
  editable: boolean;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  const [values, setValues] = useState({
    dayCap: stored.dayCap === null ? '' : String(stored.dayCap),
    hourCap: stored.hourCap === null ? '' : String(stored.hourCap),
  });
  const field = (key: keyof typeof values, label: string) => (
    <div className="space-y-1">
      <label className="label" htmlFor={`agent-caps-${key}`}>
        {label}
      </label>
      <input
        id={`agent-caps-${key}`}
        className="input"
        inputMode="numeric"
        value={values[key]}
        disabled={!editable || pending}
        placeholder="—"
        onChange={(event) => setValues((was) => ({ ...was, [key]: event.target.value }))}
        data-testid={`agent-caps-${key}`}
      />
    </div>
  );
  return (
    <div className="space-y-2" data-testid="agent-caps-form">
      {field('dayCap', t('capsDay'))}
      {field('hourCap', t('capsHour'))}
      {editable && (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          data-testid="agent-caps-save"
          onClick={() => run(() => agentSendCapsAction(values))}
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/**
 * «✅ Tarif to'g'ri» (0146, spec §1.6) — vouches for the China column this page was drawn with (`seen`, its stamp):
 * a column written since is refused in words. The bot's 14-day notice carries the same press.
 */
export function TariffConfirmButton({ seen }: { seen: string }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-secondary"
        disabled={pending || seen === ''}
        data-testid="agent-tariff-confirm"
        onClick={() => run(() => agentConfirmTariffAction(seen))}
      >
        {t('tariffConfirm')}
      </button>
      <Feedback error={error} note={null} />
    </div>
  );
}

/** «👎 Xato edi» on a reply the machine sent — the bot's op `f`; asks first, because a second one in a week switches the layer off. */
export function AutoBadButton({ draftId }: { draftId: string }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-ghost !min-h-8 !px-2 text-xs"
        disabled={pending}
        data-testid="agent-auto-bad"
        onClick={() => {
          if (!window.confirm(t('autoBadConfirm'))) return;
          run(() => agentAutoFeedbackAction(draftId));
        }}
      >
        👎 {t('autoBad')}
      </button>
      {error && <span className="text-xs font-semibold text-bad">{error}</span>}
    </span>
  );
}
