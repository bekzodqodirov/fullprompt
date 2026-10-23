# AI sotuvchi — the code map (before the review)

Written 2026-10-23 from nine code readers, one external-research reader and a
completeness critic who re-checked the load-bearing claims against the tree.
It is the companion to `docs/AI-SOTUVCHI.md` (the owner's spec) and the input to
`docs/AI-SOTUVCHI-REVIEW.md` (not yet written — it waits on his answers to the
first report). Paths are repo-relative. Where this file and the code disagree,
the code wins: re-read before relying on a line number.

## 0. The owner's override changes the channel, and the channel changes §4

His words, 2026-10-23: «Telegram businessdagi bot emas mening shaxsiy account
seansimdan ishlatsin ai va ban havfini minimum qilsin». So the agent replies
from **his personal Telegram account through the session the listener already
holds**, not from a Business-connected bot on a separate number. Consequences
the readers agree on:

- **One process may hold the session.** Only `scripts/tg-listen.ts:204` opens
  `account.session`; every other gramjs client logs in fresh. A second
  connection on the same auth key is `AUTH_KEY_DUPLICATED` and Telegram kills
  the key (the owner was told this in round 47, `CHANGELOG.md` «bitta shaxsiy
  akkauntga ikkita ulanish …»). So every Telegram call the agent needs — send,
  typing, read — is executed **by the listener**, requested through the queue.
  The model never runs inside the listener (its per-peer chain is sequential,
  `tg-listen.ts:335-371`, #706's rule one process over).
- **The conversation already exists.** On this channel the dialog is
  `tg_messages` keyed `(manager_user_id, peer_id)` (`wms.ts:2375`). Spec §4's
  `agent_messages` would be a second copy of one fact (#513) — the agent reads
  `tg_messages` and keeps only its own state (drafts, escalations, runs, facts).
- **`tg_outbox` must change, additively** (spec §4 said it would not):
  `client_id` and `queued_by` are NOT NULL (`wms.ts:2637-2649`), so a LEAD chat
  cannot be answered at all (the owed `tg_outbox.lead_id`, DECISIONS #1199), and
  nothing marks a row as the agent's — so `/agent off` cannot pull queued agent
  rows, the 🤖 marker has nothing to read, the style corpus would absorb AI text,
  and the advert first-contact clock (`first-contact.ts:120-124`) would count an
  AI reply as a person's contact.
- **Spec §3.1's 24-hour window does not exist on MTProto.** The only fence today
  is `never_wrote_first` («ever wrote on this account», `telegram-send.ts:96-103`).
  The 24-hour reply-only rule must be self-imposed in code and red-proven.
- **Campaigns (§8) cannot run from this account.** They exceed
  `DEFAULT_LIMITS` (12/min, 200/day, 4/chat/min — `telegram-send.ts:42-46`) and
  contradict `docs/TELEGRAM-CRM.md:313` («Ommaviy tarqatma — yo'q va bo'lmaydi»).
  They go through the company Bot-API bot, or not at all.

## 1. Where an agent run starts

- Hook: `handleMessage`'s `if (written)` block (`tg-listen.ts:445-462`) — after
  the verdict, after `storeIncoming` returned a NEW row id (a replay returns
  null), inside `serialised(peer)`. Only `direction === 'in'`, only for the
  agent owner's account. Enqueue AFTER `saveMediaFor` (451-461) or the worker
  sees a row without its photo.
- The listener is a pg-boss SENDER only: `enqueue` → `ensureListening`
  (`boss.ts:191-213`, fenced by `boss-registration.test.ts:69-82`). The comment
  at `tg-listen.ts:154-157` saying enqueue boots the fleet is stale.
  `EnqueueOptions` carries only `expireInSeconds`/`retryLimit`; debounce needs
  `startAfter`/`singletonKey`, and a model job must override the default
  `retryLimit` 5 (five re-billed refusals).
- NOT through `handleMessage`: catch-up after a gap (899-954) and the 7-day
  backfill (1001-1051) — the agent is blind to deploy-gap messages unless a
  freshness sweep is added. `siteTagSweep` (967-982) REPLAYS up to 24 h old
  messages through `handleMessage` — a naive hook answers stale text.
- Edits arrive via `applyEdit` (472-491); there is NO delete handler. A pending
  draft must be superseded on edit; deletes need a Raw `UpdateDeleteMessages`.

## 2. Who the chat belongs to (identity on this channel)

`decideIncoming` (`telegram-live.ts:149-200`) is the chain: a hand-attached lead
rule → `classifyWithRules` (self → exclude → include+client → phone match in
`classifyDialog`) → `unknownChatAction`. Then `tg_messages.client_id/lead_id`,
`threadClientFor`'s sibling walk, `phoneSiblingClients`. `tg_peer_index` is a
phone-hash LOOKBACK index, not peer → client (spec §4 step 1 is wrong).

**The coverage fact the product depends on** (critic-confirmed):

- On a PERSONAL account (`work_account` default false, `wms.ts:2453`) a
  stranger's text is never stored — `{ask}` writes a tray candidate only
  (`tg-listen.ts:403-411`); «Yangi lid» is future-only, the first message is lost
  (`chat-rules.ts:245-248`).
- A hidden-number chat is skipped outright, on any account (`classifyDialog`
  refuses `no_phone`, `telegram-import.ts:139-150`), and Telegram shows a phone
  only to CONTACTS — so an existing client the owner never saved as a phone
  contact is invisible too, unless an include rule exists.
- The only machine path that lands a personal-account stranger through
  `landInboundLead` is `landSiteTag` (`site-assign.ts:382-520`) — the template
  for any agent-minted lead (owner = receiver, include rule upserted with
  `decision='pending'` so an exclude always wins, audit actor null).
- Spec «every new lead enters only via `landInboundLead`» is false today:
  `leadForChat` (`chat-lead.ts:48-74`), `landIntake`, the CRM forms all call
  `createLead`.
- The website's every no-JS click and every `/api/lead/assign` miss lands on
  `@bekzodkodirov556` (`gsrlogistics.uz src/data/site.ts:31-57`) — if that is the
  account the listener holds, website visitors are the agent's first strangers,
  and their first line is the `GSR-…` tag (strip it with `findLeadTag` before any
  code lookup — it matches `isCodeCandidate`).

## 3. Sending: what exists and what is missing

- `queueReply` (`outbox.ts:191-294`) needs no session; refuses `no_actor`; checks
  `canQueue` (too_long, never_wrote_first, sending_disabled, bridge_down, caps);
  NOTIFYs the listener. It re-derives the peer from `client_id` via
  `peerForClient` (newest row) — with shared phones (#407) a reply can reach the
  wrong person. **Agent rows must pin `peer_id`.**
- The pump (`tg-listen.ts:662-836`): one claim per tick, 3 s interval + NOTIFY
  wake. Facts the critic confirmed:
  - `claimNext` is strict FIFO and increments `attempts`; a rate-limited head
    row blocks every chat on the account and burns its retry budget
    (`outbox.ts:410-430, 469-506`, `MAX_ATTEMPTS` 3).
  - `MIN_SEND_GAP_MS` gates only the NOTIFY knock; the interval ignores it.
  - FLOOD_WAIT is held in memory only (552, 826-831); `sendContextFor` always
    says `floodWaitUntil: null` while its comment claims a column that does not
    exist (`outbox.ts:164-166`).
  - gramjs sleeps silently through any FLOOD_WAIT ≤ 60 s inside `invoke`
    (`floodSleepThreshold` default 60) — the pump never learns the account is
    being throttled. (Re-check in an installed tree; this checkout has no
    `node_modules`.)
  - `PEER_FLOOD` is a per-message permanent error (`telegram-send.ts:160-173`,
    pinned by `telegram-send.test.ts:174-182`): one row fails and the next is
    tried 3 s later — no account-wide stop, no alarm.
  - `FROZEN_METHOD_INVALID` (code 420, no seconds) is retried as transient.
  - `MAX_FLOOD_WAIT_S` 3600 SHORTENS a mandated wait.
  - `recoverInFlight` fails every `sending` row on start (`outbox.ts:456-466`).
  - The only kill switch the pump reads is the company-wide
    `tg_sending_enabled` (default false, `settings/service.ts:40`) — it also
    stops every human reply.
- Nothing in `src/` or `scripts/` issues `messages.SetTyping` or
  `messages.ReadHistory`. Both are new listener code (gramjs:
  `Api.messages.SetTyping`, `Api.messages.ReadHistory` — NOT `client.markAsRead`
  with params, which also fires `ReadMentions`). Typing expires after ~6 s
  (refresh every ~4.5 s). The choreography must be a state machine across pump
  ticks (`not_before`), never a sleep inside `pump()`.
- Human pause: the listener stores the owner's phone-typed messages as
  `direction='out'` (NewMessage has no in/out filter). Its own sends are written
  by `recordSent`, but an echo is POSSIBLE (`outbox.ts:609-611`,
  `tg-listen.ts:451-455`), so «typed on the phone» = an out row with no matching
  `tg_outbox` row on `(manager, peer, tg_message_id)` — which has no index today.
- Any queued/sending/sent `tg_outbox` row makes the chat «answered»
  (`conversations.ts:1207-1233`, per client not per peer) and silences the
  30-minute nudge and the 💬! badge. **Shadow drafts must never be outbox rows**,
  and an auto-sent holding message masks the alarm (#649's shape).
- There is no test seam for gramjs sends (`__setTelegramTransport` covers only
  the Bot API). The send-time decision must be extracted to a pure function
  under `src/` to be red-provable (#166).
- Version skew: `tg-listen` is its own image behind `--profile telegram`. An OLD
  pump's `claimNext` would claim agent rows and send them instantly. Agent rows
  need a state old pumps cannot see, and the app must refuse to queue them until
  a new-listener readiness stamp exists.

## 4. Ban-risk policy draft (research + code)

Telegram publishes no per-user message rates; every number below is an
engineering fuse, not a Telegram threshold. Documented facts: spam REPORTS
drive limits and freezes; a limited account can still reply to people who wrote
first; accounts on unofficial API clients are «under observation»; parallel
connections on one key invalidate it. Telegram's API terms (archived copy of the
~Feb 2026 text, §1.5) restrict using data obtained through the API to deploy AI
except with explicit per-user consent — a literal reading covers an LLM replying
to DMs fetched by gramjs and mining the owner's messages for style; the
enforcement path is per APP (notice → 10 days → API access cut), and one api_id
serves every manager's bridge. That is the owner's call, stated to him.

Policy (P) — to be hardened in the review:

1. Eligibility: private one-to-one chat with a real user; chat decided as
   business (client / lead / include rule); not excluded, not muted, not in a
   human pause.
2. Reply window: the newest stored message from the peer is INBOUND, unanswered,
   ≤ 24 h old. After that: owner-only draft.
3. AI first messages / new chats per day = 0. Red-proven.
4. Debounce 12-15 s after the last inbound; a new inbound supersedes the draft.
5. Human pacing, at send time only: ReadHistory once, a short read delay,
   typing for a time proportional to the reply length (refreshed), then send.
   NEVER read or type in shadow mode (it clears the owner's unread badge and
   flips the CRM's «new» to «seen», `waiting.ts:57-71`).
6. Per chat: ≥ 20 s between AI messages; ≤ 2 per inbound burst; ≤ 12 per day.
7. Loop guard: replies arriving < 5 s after ours, or repeated inbound text →
   hand off (a customer's own auto-replier).
8. Account level: ≥ 10-25 s between any two AI sends; ≤ 20/hour; ≤ 80/day;
   AI + human together stay under `DEFAULT_LIMITS`; agent rows never starve
   human rows.
9. Content: one message ≤ 700 chars, never split; no links, mentions, forwards
   or media in v1; the same normalised text to ≤ 3 peers per 24 h.
10. Night (22:00-08:00 Tashkent): auto-send only to an inbound ≤ 15 min old,
    silently; otherwise hold.
11. Signals → reactions: FLOOD_WAIT on a send → stop AI sends for max(2X, 15
    min), two in 24 h → shadow + bot alert; PEER_FLOOD / USER_RESTRICTED /
    FROZEN_* → a PERSISTED account pause that a human clears, agent off,
    alarm through the BOT and the web (never through the account itself);
    per-recipient finals (blocked, privacy) → mute the conversation; ambiguous
    timeouts after a send are never re-sent with a new random id.
12. Kill switch: an agent-only mode the pump reads every tick + cancel of queued
    agent rows + expiry of pending drafts + retirement of their bot copies.
13. Block budget: ≥ 2 blocks within 7 days of an AI message → shadow + alert.
14. Session hygiene: one auth key, one process; no `tg-listen` on the rollback
    VPS or any restored copy (the advisory lock is per DATABASE); confirm the
    server session on the phone; 2FA on; stable IP; explicit device fields;
    `tg-import`/`tg-scan` leave logins open (no `auth.LogOut`).

## 5. The brain

- Two model constants exist and no third may be added (`ai/model.ts:51-52`,
  #933): `STAFF_MODEL` (conversation) and `ANALYST_MODEL` (interpretation,
  style review). `aiConfigured()` only checks the key.
- `askAssistant` (`ai/assistant.ts:131-232`) is the TEMPLATE, not a callee: it
  is staff-scoped, writes `ai_questions` (user_id NOT NULL, no token columns),
  ends on any non-`tool_use` stop reason (never checks `max_tokens`/`refusal`),
  and its wall clock is 120 s checked only between rounds (each call 60 s ×
  `maxRetries` 1).
- The shared seam (`ModelRequest`/`ModelResponse`, model.ts:27-38) carries no
  usage, no `tool_choice`/`strict`, and drops thinking blocks. `compose_reply`
  as a terminal `strict` tool with `tool_choice: auto` is the upgrade-safe shape
  (a forced tool choice errors on the successor models).
- House anti-hallucination shape = **pick by index** (`prefill-ai.ts:154-171`,
  `similar-ai.ts:68-79`): the model answers with indexes into real candidates,
  code reads the number itself. That IS G1.
- Caps: the only race-proven cap is `reserveQuestion` (advisory lock as its own
  statement, then INSERT … WHERE count < limit, #707). `aiCalcBudgetLeft` fails
  OPEN (≤ 0 / NaN → Infinity); the agent's budget must fail CLOSED.
- The one prompt-injection defence that mattered — customer text never reaches a
  model — is exactly what this round removes. G1-G6 must be enforced in code
  after the model, never trusted to the prompt.

## 6. Tools: what is customer-safe

- **`botLookup` is NOT a customer tool** (spec §5.1/§5.3 is wrong): it is the
  STAFF read, tries box → crate → batch → client on free text, looks up ANY code
  with no ownership check (`bot/lookup.ts:96-124, 311-316`) and prints batch
  codes, receipt numbers, plate and driver, phones and balance. Under the
  owner's actor «GS555 qayerda?» would answer about another client.
- The customer-safe reads are the cabinet's, keyed by a client id the SERVER
  resolved from the chat: `cargoOverview` (`client-cabinet/service.ts:534`,
  its `CabinetLot` already ships to the Mini App), `debtSummary` (773),
  `managersFor`/`officeContact` (1088, 1137), the renderers `cargoMessages` /
  `cargoSummaryLine` / `lotBlock` (`bot-text.ts:116-187`). ETA only through
  `placeDated`/`etaWindow`. The issued history shows batch codes by the owner's
  explicit ask — the agent must decide whether to repeat them.
- Never to a customer: sealed totals and floors (`lastQuotesByCode` takes no
  viewer), `answer_amount`/`answer_internal_note`, `leads/deals.quoted_amount`
  between seal and release (it holds the FLOOR), pending below-floor offers,
  landed cost and margin, other clients, the handover note/receiver phone, CRM
  notes. The outbound scrub `makeScrubber`/`codeCandidates`/`markingCandidates`
  (`channel-post.ts:603, 726, 756`) is reusable as part of G6.
- Price: the website publishes the CN truck column (110…320 $/m³ by density,
  0.55 $/kg from 1000 kg/m³, 0.1 m³ minimum) — the same as
  `OWNER_TARIFF_BANDS`' CN column; the Kashgar column is NOT published. On a
  yo'lkira-only job with no discount the list price IS the floor (law 4). The
  selling price book is keyed by TNVED code, has no route/section, and is never
  seeded.
- The site contradicts itself on «customs inside the m³ price» (Ha in three
  service FAQs, «alohida» in the main FAQ) — a kb seed cannot answer it until he
  decides.
- Addresses: `warehouses.address` was NULL on all nine rows (2026-09-05);
  `company_address` is '—'. The site publishes the three China receiving points
  (never «omborimiz»), not the Tashkent warehouse, and says the GS code and the
  China address come AFTER a contract. Codes are drawn inside `createClient`'s
  locked tx — no code can be promised before the mint, and the minter becomes
  the KPI owner.

## 7. Actors

No «agent» actor exists. `queueReply` refuses a null actor; `setFollowUp` has no
system branch; `openCalcRequest`, `createTask`, `createClient`, `recordOffer`
need a user. `createLead`/`addActivity` accept `{actorId: null, system: true}`;
`audit_log.actor_id` is nullable. Proposal for the review: sends queued under the
APPROVER (shadow) or the agent owner (auto) plus a provenance column; machine
writes with `actorId: null` where a system branch exists.

## 8. Approvals in the staff bot (recipe)

- Pre-rendered road: `queueStaffTelegram(tx, {type: 'AgentDraft', text, extra:
  {draftId}})` inside the draft's tx, `kickTelegramDrain()` after commit.
  Buttons from `buttonsFor` at send time; callback prefix `ag:` (not starting
  with `t` — the task-copy fence), anchored regexes in `parseCallback`, a
  `PRESS_REPEAT` class, dispatched ABOVE the approval guard that returns without
  answering (`staff-handlers.ts:544`). The derived callback fence scans only
  three files.
- A new mute group `agent` with its own FOUNDERS (putting the type into `alerts`
  makes it born muted for the owner); profile checkbox + i18n; the literal
  `Record<MuteGroup, boolean>` objects in tests fail only `pnpm typecheck`.
- ✏️ «O'zim yozaman»: `telegram_chat_waits` has PK `(chat_id, kind)` and a CHECK
  of four kinds — reusing `'task'` means an edit wait and a Bajarildi/💬 wait
  cannot coexist; a new kind needs a migration. Six things in the text ladder
  can take the owner's text before the wait. Recommendation: his typed text
  only becomes the draft's body and re-presents ✅/❌ — it is never sent
  directly, and the model never rewrites it into an unapproved message (spec
  §7.1.4 contradicts shadow mode as written).
- `/agent`: `bot.command('agent')` beside `/hodim`, after the channel/group
  swallows, before `registerStaffBot`. The staff bot most likely lives on the
  account at risk — a WEB kill switch is mandatory.
- Settle the pressed copy like `settlePressedApproval`, retire the rest like
  `retireApprovalCopies` + the task path's after-send re-check.
- A muted or unlinked owner settles drafts `muted` (terminal, invisible) — the
  /agent page must warn.

## 9. Platform rules the round must satisfy

- New PERMISSION codes do not reach customised roles (#170); the house idiom for
  owner powers is a ROLE predicate (`mayBroadcast`, `isAnalyst`).
- Every `SETTING_DEFAULTS` key appears as an editable one-line input on
  /admin/settings and needs a description in four bundles — agent mode and the
  style guide probably do not belong there (a second, unreviewed door).
- No new `package.json` scripts (the deps layer would need npm, #1228); one-off
  scripts run as `pnpm exec tsx scripts/x.ts` through `migrate`.
- Migrations: next is **0136** (journal `when` …115, ledger 137) and the next
  decision is **#1455** — valid only for this checkout; re-read both tails after
  every pull (23 collisions so far).
- `gsr_ai_reader` already reads `tg_messages` table-wide (0080); the schema-card
  fence parses only 0080's GRANT.
- The «platform never imports wms» rule is already broken twice
  (`telegram/bot.ts:6`, `telegram/client-cabinet.ts:15-22`) and unenforced; a
  boundary fence would be red on day one.
- tx-pool, i18n-keys, locales, mutes, callback, press, redelivery, login-person,
  attachment-allowlist, isUuidShaped, workspaces/nav, style-cascade,
  sibling-keys, e2e-width-oracle, migration-journal, dockerfile-offline fences
  all apply (see the platform reader's list in the review).

## 10. Production facts nobody here can read

The owner's `tg_accounts` row (status, `work_account`, heartbeat; is
`@bekzodkodirov556` that account?), the live `tg_sending_enabled`, whether his
staff chat is linked and which mute groups he holds, whether he is on the
website roster, whether the rollback VPS still holds the session, 2FA,
`warehouses.address`, `calc_price_book` rows. They are asked in the first
report.
