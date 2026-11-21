'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  agentBigCargoAction,
  agentDesignationsAction,
  agentLivenessAction,
  agentSampleMarkAction,
} from '@/modules/wms/agent/signal-actions';
import { Feedback, useAction } from './agent-ui';

/**
 * Stage 1a's buttons on /suhbatlar/ai (§4.5): «Kim javob beradi» (one list per topic) with the big-cargo and the
 * liveness boxes under their topics, and «Kunlik tekshiruv»'s 👍 / 👎. Each calls ONE server action of its own
 * (`signal-actions.ts`) and says a refusal in words (`labels.ts`). Inputs are CONTROLLED and survive a refusal; no
 * `router.refresh()` — every action revalidates the page itself (#1242).
 */

export interface Person {
  id: string;
  name: string;
}

/**
 * One topic's people, in order (the first is rank 1): ↑ moves a person up, ✕ takes one off, the picker adds one;
 * «Saqlash» appears only once the list differs from what is stored. An empty list clears the topic (the fallback
 * then answers, and the page says to whom).
 */
export function DesignationEditor({
  topic,
  stored,
  candidates,
  max,
}: {
  topic: string;
  stored: Person[];
  candidates: Person[];
  max: number;
}) {
  const t = useTranslations('agentAi');
  const { pending, error, note, run } = useAction({ max });
  const [list, setList] = useState<Person[]>(stored);
  const [pick, setPick] = useState('');
  const changed = list.map((p) => p.id).join(',') !== stored.map((p) => p.id).join(',');
  const free = candidates.filter((c) => !list.some((p) => p.id === c.id));
  const move = (i: number) => setList((l) => (i <= 0 ? l : [...l.slice(0, i - 1), l[i]!, l[i - 1]!, ...l.slice(i + 1)]));
  return (
    <div className="space-y-2" data-testid={`agent-kimga-editor-${topic}`}>
      {list.length > 0 && (
        <ol className="space-y-1">
          {list.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="agent-kimga-draft-row">
              <span className="text-xs text-ink-500">{t('kimgaRank', { n: i + 1 })}</span>
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{p.name}</span>
              <span className="ml-auto flex gap-1">
                {i > 0 && (
                  <button type="button" className="btn-secondary min-h-9 px-2" disabled={pending} onClick={() => move(i)} aria-label={t('kimgaUp')}>
                    ↑
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary min-h-9 px-2"
                  disabled={pending}
                  onClick={() => setList((l) => l.filter((x) => x.id !== p.id))}
                  aria-label={t('kimgaRemove')}
                  data-testid="agent-kimga-remove"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {list.length < max && free.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input min-w-0 flex-1"
            value={pick}
            disabled={pending}
            onChange={(event) => setPick(event.target.value)}
            aria-label={t('kimgaPick')}
            data-testid={`agent-kimga-pick-${topic}`}
          >
            <option value="">{t('kimgaPick')}</option>
            {free.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary"
            disabled={pending || pick === ''}
            onClick={() => {
              const person = free.find((c) => c.id === pick);
              if (person) setList((l) => [...l, person]);
              setPick('');
            }}
            data-testid={`agent-kimga-add-${topic}`}
          >
            +
          </button>
        </div>
      )}
      {changed && (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() => run(() => agentDesignationsAction(topic, list.map((p) => p.id)))}
          data-testid={`agent-kimga-save-${topic}`}
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={note} />
    </div>
  );
}

/** «Katta yuk — shuncha kubdan» and «"Fura" so‘zi ham signal bersin» — a super_admin's (the service asks). */
export function BigCargoForm({ m3, words, editable, max }: { m3: number; words: boolean; editable: boolean; max: number }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction({ max });
  const [value, setValue] = useState(String(m3));
  const [byWords, setByWords] = useState(words);
  const changed = value.trim() !== String(m3) || byWords !== words;
  return (
    <div className="space-y-1" data-testid="agent-big-cargo">
      <label className="label" htmlFor="agent-big-cargo-m3">
        {t('bigCargoM3Label')}
      </label>
      <input
        id="agent-big-cargo-m3"
        className="input"
        inputMode="numeric"
        value={value}
        disabled={!editable || pending}
        onChange={(event) => setValue(event.target.value)}
        data-testid="agent-big-cargo-m3"
      />
      <p className="text-xs text-ink-500">{t('bigCargoM3Hint', { max })}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={byWords}
          disabled={!editable || pending}
          onChange={(event) => setByWords(event.target.checked)}
          data-testid="agent-big-cargo-words"
        />
        {t('bigCargoWordsLabel')}
      </label>
      {editable && (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !changed}
          onClick={() => run(() => agentBigCargoAction({ m3: value, words: byWords }))}
          data-testid="agent-big-cargo-save"
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/** «Mijoz javobsiz qolsa ogohlantirish (daqiqa)» — the holder's or a super_admin's (the service asks). */
export function LivenessForm({ minutes, editable, min, max }: { minutes: number; editable: boolean; min: number; max: number }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction({ min, max });
  const [value, setValue] = useState(String(minutes));
  return (
    <div className="space-y-1" data-testid="agent-liveness">
      <label className="label" htmlFor="agent-liveness-minutes">
        {t('livenessLabel')}
      </label>
      <input
        id="agent-liveness-minutes"
        className="input"
        inputMode="numeric"
        value={value}
        disabled={!editable || pending}
        onChange={(event) => setValue(event.target.value)}
        data-testid="agent-liveness-minutes"
      />
      <p className="text-xs text-ink-500">{t('livenessHint', { min, max })}</p>
      {editable && (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || value.trim() === String(minutes)}
          onClick={() => run(() => agentLivenessAction(value))}
          data-testid="agent-liveness-save"
        >
          {t('save')}
        </button>
      )}
      <Feedback error={error} note={null} />
    </div>
  );
}

/** 👍 / 👎 on one sampled reply. */
export function SampleMarkButtons({ day, draftId }: { day: string; draftId: string }) {
  const t = useTranslations('agentAi');
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        onClick={() => run(() => agentSampleMarkAction(day, draftId, 'good'))}
        data-testid="agent-sample-good"
      >
        👍 {t('sampleGood')}
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        onClick={() => {
          // The card's own 👎 and its confirm (the P4 review's 3): a second 👎 in seven days switches «o‘zi yuborish»
          // off, and the confirm is where he is told so.
          if (!window.confirm(t('autoBadConfirm'))) return;
          run(() => agentSampleMarkAction(day, draftId, 'bad'));
        }}
        data-testid="agent-sample-bad"
      >
        👎 {t('sampleBad')}
      </button>
      <Feedback error={error} note={null} />
    </div>
  );
}
