'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import {
  decideChatAction,
  openLeadAction,
  purgeChatAction,
  type ChatRuleState,
  type OpenLeadState,
} from './actions';

export interface ClientOption {
  id: string;
  clientCode: string;
  name: string;
}

/**
 * One chat, and the two answers it can be given.
 *
 * «Qo'shish» needs a client, so the picker only appears once that button is
 * pressed — offering a client dropdown on forty rows at once is a screen
 * nobody reads to the end, and this list is only useful if somebody gets to
 * the end of it.
 *
 * «Hech qachon» is one press and needs nothing, because it is the answer most
 * rows will get: a manager's list of unmatched chats is mostly their own life.
 *
 * «Lid» (round 82) is one press too, and it is the answer this screen was
 * missing: a person writing in for the first time is neither a client in the
 * book nor nobody. It sits between the two, because that is its frequency —
 * commoner than finding an existing code, rarer than «not my business».
 */
export function ChatDecision({
  row,
  clients,
  labels,
  showManager,
  leftovers = 0,
}: {
  row: {
    id: string;
    title: string | null;
    phone: string | null;
    decision: string;
    managerName: string;
    clientId: string | null;
    clientCode: string | null;
    clientName: string | null;
    leadId: string | null;
    leadName: string | null;
  };
  clients: ClientOption[];
  /**
   * Whose account the chat is in. Worth a line only for the owner, who is
   * looking at everybody's; a manager seeing only their own list would get
   * their own name repeated down the page, crowding out the phone number
   * that actually helps them decide.
   */
  showManager: boolean;
  /** Rows still stored for an EXCLUDED chat — 0 hides the purge button. */
  leftovers?: number;
  labels: {
    add: string;
    never: string;
    undo: string;
    cancel: string;
    pickClient: string;
    findClient: string;
    save: string;
    included: string;
    excluded: string;
    noName: string;
    purge: string;
    purgeConfirm: string;
    openLead: string;
    leadOpened: string;
  };
}) {
  const [state, submit, pending] = useActionState<ChatRuleState, FormData>(decideChatAction, {});
  const [leadState, openLead, opening] = useActionState<OpenLeadState, FormData>(
    openLeadAction,
    {},
  );
  const [purgeState, purge, purging] = useActionState<ChatRuleState, FormData>(
    purgeChatAction,
    {},
  );
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const shown = query.trim()
    ? clients
        .filter((c) =>
          `${c.clientCode} ${c.name}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .slice(0, 30)
    : clients.slice(0, 30);

  return (
    <div className="card space-y-2 !py-2.5" data-testid="chat-candidate">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{row.title ?? labels.noName}</span>
        {row.phone && <span className="font-mono text-sm text-ink-500">{row.phone}</span>}
        {showManager && (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-ink-500">
            {row.managerName}
          </span>
        )}
      </div>

      {row.decision === 'include' && row.clientId && (
        <p className="text-sm text-good" data-testid="chat-included">
          ✓ {labels.included}: <span className="font-mono font-bold">{row.clientCode}</span>{' '}
          {row.clientName}
        </p>
      )}
      {/* An included chat may belong to a LEAD instead (0065) — and the row
          says so as a LINK, because the press that opened it is a press
          somebody made in order to go and work that lead. */}
      {row.decision === 'include' && row.leadId && (
        <p className="text-sm text-good" data-testid="chat-lead">
          ✓ {labels.leadOpened}:{' '}
          <Link href={`/crm/leads/${row.leadId}`} className="link font-semibold">
            {row.leadName ?? row.title ?? labels.noName}
          </Link>
        </p>
      )}
      {row.decision === 'exclude' && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-ink-500" data-testid="chat-excluded">
            ✕ {labels.excluded}
          </p>
          {/* The SEPARATE second decision (#388): what was stored before the
              exclude does not vanish with it — deleting the past takes its
              own press, its own confirm, and leaves an audit row. */}
          {leftovers > 0 && (
            <form
              action={purge}
              onSubmit={(e) => {
                if (!window.confirm(labels.purgeConfirm)) e.preventDefault();
              }}
            >
              <input type="hidden" name="id" value={row.id} />
              <button
                type="submit"
                className="btn-ghost !min-h-8 text-xs text-bad"
                disabled={purging}
                data-testid="chat-purge"
              >
                🗑 {labels.purge} ({leftovers})
              </button>
            </form>
          )}
        </div>
      )}

      {picking ? (
        <form action={submit} className="space-y-2">
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="decision" value="include" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.findClient}
            className="input-sm"
            data-testid="client-search"
          />
          <select name="clientId" className="input-sm" required data-testid="client-select">
            <option value="">— {labels.pickClient} —</option>
            {shown.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientCode} · {c.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary !min-h-9 flex-1" disabled={pending}>
              {labels.save}
            </button>
            <button
              type="button"
              className="btn-secondary !min-h-9"
              onClick={() => setPicking(false)}
            >
              {labels.cancel}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {row.decision === 'pending' ? (
            <>
              <button
                type="button"
                className="btn-primary !min-h-9 flex-1"
                onClick={() => setPicking(true)}
                data-testid="chat-add"
              >
                {labels.add}
              </button>
              {/* Only where there IS a number: `leadForChat` refuses without
                  one, and a button that can only fail is worse than no
                  button. Same rule the listener's `no_phone` refusal keeps —
                  a lead nobody can ring is a row with a name in it. */}
              {row.phone && (
                <form action={openLead}>
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="btn-secondary !min-h-9"
                    disabled={opening}
                    data-testid="chat-open-lead"
                  >
                    {labels.openLead}
                  </button>
                </form>
              )}
              <form action={submit}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="decision" value="exclude" />
                <button
                  type="submit"
                  className="btn-secondary !min-h-9"
                  disabled={pending}
                  data-testid="chat-never"
                >
                  {labels.never}
                </button>
              </form>
            </>
          ) : (
            // Every answer is reversible: this is a judgement call made from a
            // display name, and the wrong one must cost one press to undo.
            <form action={submit}>
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="decision" value="pending" />
              <button
                type="submit"
                className="btn-ghost !min-h-9 text-sm"
                disabled={pending}
                data-testid="chat-undo"
              >
                ↩ {labels.undo}
              </button>
            </form>
          )}
        </div>
      )}

      {(state.error ?? purgeState.error ?? leadState.error) && (
        <p className="text-sm font-semibold text-bad">
          {state.error ?? purgeState.error ?? leadState.error}
        </p>
      )}
    </div>
  );
}
