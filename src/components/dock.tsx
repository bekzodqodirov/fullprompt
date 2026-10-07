'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import { autogrow, sendOnEnter, useCoarsePointer } from '@/components/composer';
import { ReplyTemplates, type ReplyTemplate } from '@/components/reply-templates';
import { OutboxBubble } from '@/components/outbox-bubble';
import { TelegramBubble } from '@/components/telegram-bubble';
import { sendReplyAction } from '@/modules/wms/crm/reply-actions';
import { completeTaskAction } from '@/modules/platform/tasks/actions';
// A TYPE from the pure module the route builds its answer with: the JSON
// crossing has one shape on both ends (the design judge's eighth finding).
import type { DockConversation } from '@/modules/wms/crm/conversation-row';
import { OFFICE_TZ } from '@/modules/platform/time/tashkent';

/**
 * The dock — chat and tasks, reachable from ANY page (owner, items 5+7:
 * "hodimlar bilan gaplashish oynaning o'ng tarafida … chat butun sistemadan
 * kirsa bo'ladigan joyda, tasklar ixcham va har joydan reachable").
 *
 * One button in the app bar; a drawer from the right (from the bottom on a
 * phone, where "right" is not a direction the thumb has). Two tabs:
 *
 *  - 💬 conversations — the same list and thread as /suhbatlar, waiting-on-us
 *    marked, replies typed in place. On a client, deal or lead card the
 *    drawer opens straight into THAT card's conversation: the card declares
 *    it with a DOM marker (`data-dock-client`), which is how a client
 *    component learns what a server page was about without a second fetch.
 *  - ✅ my day — the same list as /bugun, one tap to finish.
 *  - 👥 ichki (0127, the owner's E answers) — the staff threads this person
 *    is in: a card's notes, a calculation's Q&A; new ones marked, each row a
 *    link to where that thread lives. No composer here — replying is on the
 *    card or in Telegram, two writers are enough.
 *
 * Everything here is fetched WHEN THE DRAWER OPENS, never on page load: the
 * dock rides on every page in the app, so its cost has to be zero until
 * somebody reaches for it. The chat tab exists only for people the
 * conversation gate lets in; everyone else gets a tasks-only dock.
 */

interface DockTask {
  id: string;
  title: string;
  dueAt: string | null;
  /** Where the title goes FOR THIS READER — the route's `readerTaskLinks`, never a card guessed here. */
  aboutHref: string | null;
  /** An open calc job (VED-TARIX §8): no ✓ — «🧮» to its screen for a VED, a chip for anybody else. */
  calc: { href: string; mayOpen: boolean } | null;
}
interface DockThread {
  client: { id: string; code: string; name: string };
  canReply: boolean;
  reason: string | null;
  managers: string[];
  /** Already filled for this client — `{ism}`/`{kod}` resolved server-side. */
  templates: ReplyTemplate[];
  messages: {
    id: string;
    direction: string;
    body: string | null;
    hasMedia: boolean;
    sentAt: string;
    manager: string;
    photos: { id: string }[];
    audios: { id: string; fileName: string }[];
    files: { id: string; fileName: string; sizeBytes: number }[];
    fwdFrom: string | null;
    quoted: { body: string | null; direction: string; hasMedia: boolean } | null;
  }[];
  /** Replies still in the queue — the drawer must not swallow them. */
  pending: {
    id: string;
    body: string;
    status: string;
    queuedAt: string;
    attachmentId: string | null;
    lastError: string | null;
  }[];
}

/** One «👥 Ichki» row — the route's `myThreads` answer (wms/crm/thread.ts `DockThreadRow`). */
interface DockThreadRow {
  kind: 'lead' | 'deal' | 'client' | 'calc';
  id: string;
  label: string;
  section: string | null;
  author: string | null;
  excerpt: string;
  at: string | null;
  unread: boolean;
  href: string;
}

export function Dock({
  canChat,
  canThreads,
}: {
  canChat: boolean;
  /**
   * May this person have a staff thread at all (the CRM grants, the VED's)?
   * REQUIRED: a warehouse role or the accountant can never have a row, so
   * the layout says so and the tab is neither drawn nor fetched.
   */
  canThreads: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations('crm');
  const tl = useTranslations('lidChat');
  const tt = useTranslations('tasks');
  const tn = useTranslations('navShort');
  const tc = useTranslations('common');
  const tth = useTranslations('threads');
  const tcalc = useTranslations('calc');

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'chat' | 'tasks' | 'threads'>(canChat ? 'chat' : 'tasks');
  const [threads, setThreads] = useState<DockThreadRow[] | null>(null);
  const [threadsState, setThreadsState] = useState<'ok' | 'failed' | 'behind'>('ok');
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<{
    overdue: DockTask[];
    today: DockTask[];
    undated: DockTask[];
    counts: { overdue: number; today: number; undated: number };
  } | null>(null);
  const [conversations, setConversations] = useState<DockConversation[] | null>(null);
  const [thread, setThread] = useState<DockThread | null>(null);
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const coarse = useCoarsePointer();

  // Navigating away closes the drawer — it lives in the layout, which
  // survives navigation (the ••• sheet's lesson).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  const loadTasks = useCallback(async () => {
    const res = await fetch('/api/dock/tasks');
    if (res.ok) setTasks((await res.json()) as typeof tasks);
  }, []);

  // «👥 Ichki» — one fetch per open, like the tasks. A database a release
  // behind says so (`behind`), never «you have no threads».
  const fetchThreadList = useCallback(async () => {
    try {
      const res = await fetch('/api/dock/threads', { cache: 'no-store' });
      if (!res.ok) {
        setThreadsState('failed');
        return;
      }
      const data = (await res.json()) as { rows: DockThreadRow[]; behind?: boolean };
      setThreads(data.rows);
      setThreadsState(data.behind ? 'behind' : 'ok');
    } catch {
      setThreadsState('failed');
    }
  }, []);

  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/dock/conversations');
    if (res.ok)
      setConversations(
        ((await res.json()) as { conversations: DockConversation[] }).conversations,
      );
  }, []);

  /**
   * Re-read a thread that is already on screen. Deliberately NOT `loadThread`:
   * that one blanks the panel first (right for opening a new conversation,
   * wrong for a tick — the messages would flicker away every ten seconds).
   */
  /**
   * The newest INCOMING message the open thread has shown. The mark used to
   * move once, on open — so a message that arrived while the drawer stood
   * open, drawn by the 10 s refresh in front of the manager's eyes, stayed
   * «new» and rang thirty minutes later (the design judge's seventh finding).
   * A refresh that draws a newer incoming message now marks it too.
   */
  const lastInbound = useRef<string | null>(null);

  const markRead = useCallback((clientId: string) => {
    void fetch('/api/chat/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const refreshThread = useCallback(
    async (clientId: string) => {
      const res = await fetch(`/api/dock/thread?client=${clientId}`);
      if (!res.ok) return;
      const next = (await res.json()) as DockThread;
      setThread(next);
      const newest = next.messages.find((m) => m.direction === 'in')?.id ?? null;
      if (newest && newest !== lastInbound.current) {
        lastInbound.current = newest;
        markRead(clientId);
      }
    },
    [markRead],
  );

  const loadThread = useCallback(
    async (clientId: string) => {
      setThreadFor(clientId);
      setThread(null);
      setSendError(null);
      // Opening the drawer's thread is opening the chat (round 88) — the same
      // mark the page sets, and the same server-side re-derivation of what it
      // means. Never on the LIST: a glance down a list is not reading.
      markRead(clientId);
      const res = await fetch(`/api/dock/thread?client=${clientId}`);
      if (res.ok) {
        const next = (await res.json()) as DockThread;
        lastInbound.current = next.messages.find((m) => m.direction === 'in')?.id ?? null;
        setThread(next);
      }
    },
    [markRead],
  );

  // The queue moves while the drawer is open — the listener sends within
  // seconds — so an open thread re-reads itself. Same 10 s as the two page
  // surfaces (round 25's AutoRefresh); only while OPEN, and only for the
  // thread being read, so a drawer nobody is looking at costs nothing.
  useEffect(() => {
    if (!open || tab !== 'chat' || !threadFor) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshThread(threadFor);
    }, 10_000);
    return () => clearInterval(timer);
  }, [open, tab, threadFor, refreshThread]);

  function openDock() {
    setOpen(true);
    void loadTasks();
    if (canThreads) void fetchThreadList();
    if (!canChat) {
      setTab('tasks');
      return;
    }
    // A card that is ABOUT a client opens straight into that conversation.
    const marker = document.querySelector<HTMLElement>('[data-dock-client]');
    const clientId = marker?.dataset.dockClient;
    if (clientId) {
      setTab('chat');
      void loadThread(clientId);
    } else {
      setThreadFor(null);
      setThread(null);
      void loadConversations();
    }
  }

  async function send() {
    // The id the SERVER resolved, not the marker the card put on the page:
    // one person often holds several GS codes on one phone and the chat
    // hangs off whichever one the import matched (round 32). Posting the
    // card's own code would be refused as «not your conversation» while the
    // thread above the box shows the very messages being answered.
    const target = thread?.client.id ?? threadFor;
    if (!target || (!body.trim() && !photo) || sending) return;
    setSending(true);
    setSendError(null);
    const form = new FormData();
    form.set('clientId', target);
    form.set('body', body);
    form.set('path', pathname);
    if (photo) form.set('attachmentId', photo.id);
    const result = await sendReplyAction({}, form);
    setSending(false);
    if (result.ok) {
      setBody('');
      setPhoto(null);
      // The queued bubble appears immediately — pressing send must never look
      // like nothing happened.
      void refreshThread(target);
    } else {
      setSendError(result.error ?? 'error');
    }
  }

  // Same pre-binding as the thread composer: uploaded against a minted
  // tg_outbox group id; queueReply claims it onto the queue row.
  async function attachPhoto(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUploading(true);
    const data = new FormData();
    data.set('file', file);
    data.set('entityType', 'tg_outbox');
    data.set('entityId', crypto.randomUUID());
    const res = await fetch('/api/files/upload', { method: 'POST', body: data });
    if (res.ok) {
      const { id } = (await res.json()) as { id: string };
      setPhoto({ id, name: file.name });
    }
    setUploading(false);
  }

  async function finishTask(id: string) {
    // The refusal is SHOWN (tests-completeness-7): the dock used to ignore
    // the action's answer, so a refused ✓ simply did nothing.
    const res = await completeTaskAction(id, pathname, {}, new FormData());
    if (res.error) {
      const key = `errors.${res.error}`;
      setTaskError(tt.has(key as 'errors.validation') ? tt(key as 'errors.validation') : tc('error'));
    } else {
      setTaskError(null);
    }
    void loadTasks();
  }

  const reasons: Record<string, string> = {
    no_chat: t('replyNoChat'),
    not_your_conversation: t('replyNotYours'),
    sending_disabled: t('replyDisabled'),
    never_wrote_first: t('replyNeverWrote'),
    bridge_down: t('replyBridgeDown'),
    rate_minute: t('replyRateLimited'),
    rate_day: t('replyRateLimited'),
    rate_chat: t('replyRateLimited'),
    flood_wait: t('replyRateLimited'),
  };

  // The COUNT, not the listed rows: `myDay` caps each bucket at 40, so the
  // badge used to stop climbing at 80 while /bugun printed the real total.
  const due = (tasks?.counts.overdue ?? 0) + (tasks?.counts.today ?? 0);
  const threadsUnread = threads?.filter((row) => row.unread).length ?? 0;
  // Three tabs and the 44 px ✕ in one row at 360 px: «💬 Переписки» and
  // «✅ Мой день N» already filled most of the sheet (the judge's 18), so
  // below `sm` each tab is its ICON — the word stays for a screen reader and
  // as the button's name — and from `sm` up the words return. From `md` the
  // dock is a 26rem DRAWER, not a full-width sheet, and three words do not fit
  // it either — measured at 1280: Russian ran 22 px past the drawer and took
  // the ✕ out of reach, English crushed the ✕ to 20 px — so there only the
  // ACTIVE tab carries its word.
  const tabClass = (active: boolean) =>
    `shrink-0 rounded-xl px-3 py-2 text-sm font-bold ${active ? 'bg-brand-50 text-brand-800' : 'text-ink-500'}`;
  const tabWord = (active: boolean) =>
    active ? 'sr-only sm:not-sr-only sm:ml-1' : 'sr-only sm:not-sr-only sm:ml-1 md:sr-only';

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openDock())}
        data-testid="dock-button"
        aria-label={`${t('conversations')} / ${tn('myDay')}`}
        className="btn-ghost btn-icon relative text-ink-700"
      >
        <Icon name="chat" />
      </button>

      {/* A portal, not a child: the app bar's backdrop-blur makes the header
          a containing block for fixed descendants, which pinned the "full
          screen" drawer inside a 56 px strip. The body has no such trap. */}
      {open &&
        createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={tc('back')}
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setOpen(false)}
          />
          <div
            data-testid="dock-panel"
            className="pb-safe absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised shadow-pop md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-[26rem] md:rounded-none"
          >
            {/* The same handle the ••• sheet wears, so the two bottom sheets
                read as one control. Phone only — the desktop drawer is not
                a sheet. */}
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
            <div className="flex items-center gap-1 border-b border-line p-2">
              {canChat && (
                <button
                  type="button"
                  data-testid="dock-tab-chat"
                  aria-label={t('conversations')}
                  onClick={() => {
                    setTab('chat');
                    if (!threadFor && !conversations) void loadConversations();
                  }}
                  className={tabClass(tab === 'chat')}
                >
                  <span aria-hidden="true">💬</span>
                  <span className={tabWord(tab === 'chat')}>{t('conversations')}</span>
                </button>
              )}
              <button
                type="button"
                data-testid="dock-tab-tasks"
                aria-label={tn('myDay')}
                onClick={() => setTab('tasks')}
                className={tabClass(tab === 'tasks')}
              >
                <span aria-hidden="true">✅</span>
                <span className={tabWord(tab === 'tasks')}>{tn('myDay')}</span>
                {due > 0 && (
                  <span className="num ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs text-warn">
                    {due}
                  </span>
                )}
              </button>
              {canThreads && (
                <button
                  type="button"
                  data-testid="dock-tab-threads"
                  aria-label={tth('dockTab')}
                  onClick={() => setTab('threads')}
                  className={tabClass(tab === 'threads')}
                >
                  <span aria-hidden="true">👥</span>
                  <span className={tabWord(tab === 'threads')}>{tth('dockTab')}</span>
                  {threadsUnread > 0 && (
                    <span
                      className="num ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs text-warn"
                      data-testid="dock-threads-unread-count"
                    >
                      {threadsUnread}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                aria-label={tc('back')}
                onClick={() => setOpen(false)}
                className="btn-ghost btn-icon ml-auto shrink-0 text-ink-500"
                data-testid="dock-close"
              >
                <Icon name="x" />
              </button>
            </div>

            {tab === 'chat' && canChat && (
              <div className="flex min-h-0 flex-1 flex-col">
                {threadFor && thread ? (
                  <>
                    <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
                      <button
                        type="button"
                        aria-label={tc('back')}
                        data-testid="dock-thread-back"
                        onClick={() => {
                          setThreadFor(null);
                          setThread(null);
                          void loadConversations();
                        }}
                        className="font-bold text-brand-700"
                      >
                        ←
                      </button>
                      <Link
                        href={`/admin/clients/${thread.client.id}`}
                        className="min-w-0 truncate text-sm font-bold"
                        data-testid="dock-thread-client"
                      >
                        <span className="font-mono text-brand-700">{thread.client.code}</span>{' '}
                        {thread.client.name}
                      </Link>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto p-3">
                      {thread.messages.map((m) => (
                        <TelegramBubble
                          key={m.id}
                          message={{ ...m, sentAt: new Date(m.sentAt) }}
                          clientLabel={thread.client.name}
                          mediaLabel={t('telegramMedia')}
                        />
                      ))}
                      {thread.pending.map((row) => (
                        <OutboxBubble
                          key={row.id}
                          row={{ ...row, queuedAt: new Date(row.queuedAt) }}
                          labels={{
                            queued: t('replyQueued'),
                            stuck: t('replyStuck'),
                            failed: t('replyFailed'),
                          }}
                        />
                      ))}
                      {thread.messages.length === 0 && thread.pending.length === 0 && (
                        <p className="text-center text-sm text-ink-500">
                          {t('conversationsEmpty')}
                        </p>
                      )}
                    </div>
                    <div className="border-t border-line p-2">
                      {thread.canReply ? (
                        <div className="space-y-1">
                          {photo && (
                            <div className="flex items-center gap-1.5">
                              <span className="max-w-48 truncate rounded-lg bg-surface-sunken px-2 py-1 text-xs font-semibold">
                                🖼 {photo.name}
                              </span>
                              <button
                                type="button"
                                aria-label="✕"
                                onClick={() => setPhoto(null)}
                                className="btn-ghost btn-icon !min-h-7 text-xs"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                          <div className="flex items-end gap-2">
                          <label
                            className={`btn-secondary btn-icon shrink-0 cursor-pointer ${
                              uploading || photo ? 'pointer-events-none opacity-50' : ''
                            }`}
                            aria-label={t('replyAttach')}
                            title={t('replyAttach')}
                            data-testid="dock-attach"
                          >
                            {uploading ? '…' : '📎'}
                            <input
                              type="file"
                              accept="image/*"
                              hidden
                              onChange={(event) => void attachPhoto(event.target.files)}
                            />
                          </label>
                          {/* Inserts, never replaces: half a typed sentence
                              plus a template means «and this too». */}
                          <ReplyTemplates
                            templates={thread.templates ?? []}
                            label={t('templates')}
                            onPick={(text) =>
                              setBody((was) => (was.trim() ? `${was.trimEnd()}\n${text}` : text))
                            }
                          />
                          <textarea
                            value={body}
                            onChange={(event) => {
                              setBody(event.target.value);
                              autogrow(event.target);
                            }}
                            onKeyDown={(event) => sendOnEnter(event, coarse, () => void send())}
                            placeholder={t('replyPlaceholder')}
                            rows={1}
                            data-testid="dock-reply"
                            className="input max-h-28 min-w-0 flex-1 resize-none"
                          />
                          <button
                            type="button"
                            onClick={() => void send()}
                            disabled={sending || uploading || (!body.trim() && !photo)}
                            data-testid="dock-send"
                            aria-label={t('replySend')}
                            title={t('replySend')}
                            className="btn-primary shrink-0 !px-3 disabled:opacity-50 sm:!px-4"
                          >
                            {sending ? (
                              '…'
                            ) : (
                              <>
                                <span className="sm:hidden">➤</span>
                                <span className="hidden sm:inline">{t('replySend')}</span>
                              </>
                            )}
                          </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-center text-xs text-ink-500">
                          {reasons[thread.reason ?? ''] ?? thread.reason}
                          {thread.reason === 'not_your_conversation' &&
                            thread.managers.length > 0 &&
                            ` · ${thread.managers.join(', ')}`}
                        </p>
                      )}
                      {sendError && (
                        <p className="mt-1 text-center text-xs font-semibold text-bad">
                          {reasons[sendError] ?? tc('error')}
                        </p>
                      )}
                    </div>
                  </>
                ) : threadFor ? (
                  <p className="p-4 text-center text-sm text-ink-500">{tc('loading')}</p>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {conversations === null && (
                      <p className="p-2 text-center text-sm text-ink-500">{tc('loading')}</p>
                    )}
                    {conversations?.length === 0 && (
                      <p className="p-2 text-center text-sm text-ink-500">
                        {t('conversationsEmpty')}
                      </p>
                    )}
                    {conversations?.map((row) => {
                      const body = (
                        <>
                          <span
                            className="shrink-0 font-mono text-sm font-extrabold text-brand-700"
                            title={row.kind === 'lead' ? tl('markTitle') : undefined}
                          >
                            {row.kind === 'lead' ? tl('mark') : row.code}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">
                              {row.name}
                            </span>
                            {row.kind === 'lead' && !row.href && (
                              <span className="block truncate text-xs text-ink-500">
                                {row.leadOwner
                                  ? tl('owner', { name: row.leadOwner })
                                  : tl('ownerNone')}
                              </span>
                            )}
                            <span className="block truncate text-xs text-ink-500">
                              {row.lastBody ?? `📎 ${t('telegramMedia')}`}
                            </span>
                          </span>
                          {/* The alarm only, and by the same rule the page uses
                              (round 88 `chatState`). The page also prints a
                              quiet «✓ o'qildi» for a chat that is read and
                              deliberately unanswered; this drawer is 3/4 the
                              width and drops it — showing less is not
                              disagreeing. */}
                          {row.waitingOnUs && (
                            <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-xs font-bold text-warn">
                              {t('waitingOnUs')}
                            </span>
                          )}
                        </>
                      );
                      const rowClass =
                        'flex w-full items-baseline gap-2 rounded-xl p-2.5 text-left hover:bg-surface-sunken';
                      // A CLIENT row opens in the drawer — its thread and its
                      // composer are client-keyed. A LEAD row goes to the lead
                      // card's chat (the only screen that draws one), and the
                      // navigation closes the drawer by itself; a lead this
                      // reader may not open is text, never a bouncing link.
                      if (row.kind === 'client' && row.clientId) {
                        const clientId = row.clientId;
                        return (
                          <button
                            key={`client:${clientId}`}
                            type="button"
                            data-testid="dock-conversation"
                            data-kind="client"
                            onClick={() => void loadThread(clientId)}
                            className={rowClass}
                          >
                            {body}
                          </button>
                        );
                      }
                      return row.href ? (
                        <Link
                          key={`lead:${row.leadId}`}
                          href={row.href}
                          // Closed by hand as well: from the lead's OWN card the
                          // path does not change (only the #anchor does), so the
                          // close-on-navigation effect would leave the drawer
                          // covering the very chat it just scrolled to.
                          onClick={() => setOpen(false)}
                          data-testid="dock-conversation"
                          data-kind="lead"
                          className={rowClass}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div
                          key={`lead:${row.leadId}`}
                          data-testid="dock-conversation"
                          data-kind="lead"
                          className={rowClass}
                        >
                          {body}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === 'threads' && canThreads && (
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" data-testid="dock-threads">
                {threadsState === 'failed' ? (
                  <p className="p-2 text-center text-sm text-bad" data-testid="dock-threads-error">
                    {tth('dockFailed')}
                  </p>
                ) : threadsState === 'behind' ? (
                  <p className="p-2 text-center text-sm text-ink-500" data-testid="dock-threads-error">
                    {tth('errors.server_behind')}
                  </p>
                ) : threads === null ? (
                  <p className="p-2 text-center text-sm text-ink-500">{tth('dockLoading')}</p>
                ) : threads.length === 0 ? (
                  <p className="p-2 text-center text-sm text-ink-500" data-testid="dock-threads-empty">
                    {tth('dockEmpty')}
                  </p>
                ) : (
                  threads.map((row) => (
                    <Link
                      key={`${row.kind}:${row.id}`}
                      href={row.href}
                      // Closed by hand as well: a row on the card already on
                      // screen changes only the #anchor, and the close-on-
                      // navigation effect would leave the drawer over it.
                      onClick={() => setOpen(false)}
                      data-testid="dock-thread"
                      data-kind={row.kind}
                      data-id={row.id}
                      data-unread={row.unread ? '1' : '0'}
                      className="flex w-full items-baseline gap-2 rounded-xl p-2.5 text-left hover:bg-surface-sunken"
                    >
                      <span className="w-2 shrink-0">
                        {row.unread ? (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-warn"
                            data-testid="dock-thread-unread"
                            aria-label={tth('unread')}
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">
                          {row.label}
                          {row.kind === 'calc' && row.section
                            ? ` · ${tcalc(`sections.${row.section}`)}`
                            : ''}
                        </span>
                        <span className="block truncate text-xs text-ink-500">
                          {row.author ? `${row.author}: ` : ''}
                          {row.excerpt}
                        </span>
                      </span>
                      {row.at && (
                        <span className="shrink-0 text-2xs text-ink-500">
                          {new Date(row.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: OFFICE_TZ })}
                        </span>
                      )}
                    </Link>
                  ))
                )}
              </div>
            )}

            {tab === 'tasks' && (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {tasks === null && (
                  <p className="text-center text-sm text-ink-500">{tc('loading')}</p>
                )}
                {tasks && due === 0 && tasks.undated.length === 0 && (
                  <p className="text-center text-sm text-ink-500">{tt('allClear')}</p>
                )}
                {taskError && (
                  <p role="alert" data-testid="dock-task-error" className="text-sm font-semibold text-bad">
                    {taskError}
                  </p>
                )}
                {tasks && tasks.overdue.length > 0 && (
                  <TaskGroup
                    title={`🔴 ${tt('overdue')}`}
                    rows={tasks.overdue}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                {tasks && tasks.today.length > 0 && (
                  <TaskGroup
                    title={`🟡 ${tt('dueToday')}`}
                    rows={tasks.today}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                {tasks && tasks.undated.length > 0 && (
                  <TaskGroup
                    title={tt('noDeadline')}
                    rows={tasks.undated}
                    finishLabel={tt('finish')}
                    onFinish={finishTask}
                  />
                )}
                <Link
                  href="/bugun"
                  className="block text-center text-sm font-semibold text-brand-700"
                >
                  {tt('title')} →
                </Link>
              </div>
            )}
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}

function TaskGroup({
  title,
  rows,
  finishLabel,
  onFinish,
}: {
  title: string;
  rows: DockTask[];
  finishLabel: string;
  onFinish: (id: string) => void;
}) {
  const tt = useTranslations('tasks');
  return (
    <div className="space-y-1.5">
      <p className="section-title">{title}</p>
      {rows.map((task) => {
        const href = task.aboutHref;
        return (
          <div key={task.id} data-testid="dock-task" className="flex items-center gap-2 rounded-xl bg-surface-sunken p-2.5">
            <span className="min-w-0 flex-1">
              {href ? (
                <Link href={href} className="block truncate text-sm font-semibold hover:underline">
                  {task.title}
                </Link>
              ) : (
                <span className="block truncate text-sm font-semibold">{task.title}</span>
              )}
              {task.dueAt && <span className="num text-xs text-ink-500">{task.dueAt}</span>}
            </span>
            {task.calc ? (
              task.calc.mayOpen ? (
                <Link
                  href={task.calc.href}
                  data-testid="dock-task-calc"
                  className="btn-secondary !min-h-9 shrink-0 px-2 text-sm"
                >
                  🧮 {tt('calcOpen')}
                </Link>
              ) : (
                <span data-testid="dock-task-calc-locked" className="chip shrink-0">
                  🧮 {tt('calcLocked')}
                </span>
              )
            ) : (
              <button
                type="button"
                onClick={() => onFinish(task.id)}
                className="btn-secondary !min-h-9 shrink-0 px-2 text-sm"
              >
                ✓ {finishLabel}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
