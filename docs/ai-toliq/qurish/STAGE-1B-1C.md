# STAGE 1b «Suhbatni yuritish» + STAGE 1c «Kod va manzil — bir tugma» — build plan

## 0. Header

| | 1b «Suhbatni yuritish» | 1c «Kod va manzil — bir tugma» |
|---|---|---|
| What the owner stops doing | reading a card for every question the AI could not answer while the customer hears nothing; pressing because «the third reply waits»; being the only person who can press | opening the «+» form, copying the code into Telegram, pasting the China address by hand |
| Size | **L** (2-4 weeks; five packages + a kernel) | **M-L** (1-2 weeks; no migration of its own) |
| Depends on | stage 1a deployed and confirmed (the designation table, typed warnings/notes, the loop detector, persona, «talk at once / price after 2 min») | 1b deployed and confirmed |
| One branch / PR / deploy each | yes (contract §3) | yes |

Read at HEAD **`bdd81f51`** (journal tail `0150_batches_view`, ledger 151); every reference re-checked at `bf37150c` (docs only
between the two — «Verified references» at the end). `agent/` = `src/modules/wms/agent/`. Every `file:line`
below was opened at that HEAD. **Stage 1a is not built yet**: where this plan leans on something 1a ships it says **⟨1a⟩** — re-read
what 1a actually built (`qurish/STAGE-0-1A.md` and its «As built» blocks) and use ITS names. `UNVERIFIED:` marks what I could not check.
House rules that bind every line: `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` §4-§5 and CLAUDE.md («Verification ritual», «Footguns»).

## 1. Behaviour, before → after

| Who | Today (as read) | After 1b | After 1c |
|---|---|---|---|
| Customer | One message per burst (`agent_outbox.draft_id UNIQUE`, 0138:186). A question the AI cannot answer = silence until his ✅. His ✍️ answer that comes more than 24 h after the customer's line is never sent (`run.ts:1853-1856`, `no_fresh_inbound`). | 1-3 short messages a turn. When the AI must ask a person: ONE system sentence with no time in it («…javobini shu yerga yozaman»), and the AI keeps answering the customer's other questions. The person's answer arrives in the same chat, up to a week later. | Says «jo'nataman» → hears the system line → after one tap by the supervisor receives: the code + the marking rule, then the China address verbatim (never for avia). |
| Owner | Every card goes to the HOLDER's bot chat (`drafts.ts:391`); only the holder may press (`decide.ts:960`). The machine's press waits for the minute sweep (`jobs.ts:543-550`). One reminder after 30 min (`jobs.ts:229`). | Cards go to the person designated «rahbar» (rank 1 of ⟨1a⟩'s topic `supervisor`, «Rahbar va o'rinbosar»); a card unanswered 15 working minutes also reaches the «o'rinbosar» (rank 2); either may press. Talk leaves in seconds (inline press). Questions are their own cards («❓ AI so'rayapti»), answered by reply or «✍️». A «Sinov» tab shows what the new engine WOULD have said on real chats. | One card «🆕 Kod ochishga tayyor» with the exact messages that will go; one tap opens the code (lead won + deal) and sends them. |
| Staff | Nobody but the holder is involved. | Unchanged, except the deputy (3a adds the colleagues). | «Prixod keldi» and every other seller message for an AI-won client reaches the supervisor, not the seat's mailbox. |

## 2. His answers that bind these stages — and what stays forbidden

**Quoted from §11.1** (design `docs/AI-SOTUVCHI-TOLIQ.md`):
- **5 b** — cards to him; unanswered **15 minutes in 09:00-19:00** → the deputy too; **only the two of them write from the AI number**. The deputy is a person chosen in settings. ⚠ reverses «answer 15: drafts are for me only» — he saw the ⚠.
- **11 a** — talk at once; a price waits 2 minutes with ⏸ (⚠ seen). 1b's inline press serves the first half; the 2-minute hold is unchanged.
- **4 a** — at night it answers a customer who writes, never first; **cards to colleagues wait for the morning** (so the 15-minute clock does not run at night). ⚠ reverses 11-11's «tunda yo'q» — he saw the ⚠.
- **1 b** — the persona never says it is a person; the holding line and every block are system text and must not say «menejer» of itself. ⚠ reverses 11-11's «botmisiz → to me» — he saw the ⚠.
- **16 b** — the code alone (≤ 10 a day, shown to him two weeks) is STAGE 5. «The road still ships the one-tap version first (stage 1c)». ⚠ reverses «kodni o'zim ochaman».
- **17 c** — the avia address: he gives it each time. Nothing changes. **19 c** — another delivery city: his.
- **31 c** — AI-won customers are counted like a seller's, as today, and this is a setting; the seat STAYS in KPI, rating and congratulations.
- **10 c** — nothing stops on dollars. **12 a** — the session only. **§11.2** — nobody is named in code: every «who» is read from ⟨1a⟩'s designation table.
- **8 b**, **14 b** (colleagues' customers, topic routing) are 3a's; 1b only leaves the seam (`agent_cases.topic`).

**Forbidden in 1b and 1c:** deleting or loosening ANY word rule (`policy.ts`, `numbers.ts`, `digits.ts`, `locale.ts`, `destination.ts`, `auto-money.ts`, the avia rules) — parts are checked MORE, never less · a first message to anyone · a model-written sentence promising a time («bir daqiqa», «tez orada», «30 daqiqada» are refused today by G1/G2 and stay refused) · the machine opening a code without a person's tap (stage 5) · a price, discount or date inside a case card or an act card · any card text that shows a VED figure to a seller-sight person or a client price to a VED-sight person (law 4) · a role key, user id or name in source, seed or migration · a migration that changes a stored choice of his (kind ticks, markup, confidence floor) · Telegram Business · a dollar ceiling.

## 3. Data — ONE migration, in 1b (1c has none)

`NNNN_agent_engine.sql` — **the next index and the next `when` after the journal's tail on the day you cut the kernel** (#1040; fetch main first). Additive. Header states, as 0138/0145/0148/0149 do: `gsr_ai_reader` is granted nothing on the new tables; every `users` FK has no ON DELETE.

**3.1 New tables** (all read behind the probe; names grepped free at HEAD)

| Table | Columns that matter | Notes |
|---|---|---|
| `agent_cases` | `id`, `manager_user_id`, `peer_id`, `client_id`, `lead_id`, `kind` CHECK IN (`question`,`act`; *reserved* `complaint`,`handover` — first writer 3a, `STAGE-3A.md` §3.1; born here so 3a re-makes nothing), `topic` text (a ⟨1a⟩ designation topic; 1b writes the supervisor's), `status` CHECK IN (`open`,`answered`,`relayed`,`closed`,`expired`,`cancelled`), `question` text ≤ 500, `anchor_tg_message_id` bigint NOT NULL, `burst_seen_at`, `run_id`, `holding_draft_id` uuid NULL, `asked_at`, `escalated_at`, `answered_at`, `answered_by`, `answer` text, `answer_message_id` bigint, `relayed_draft_id`, `closed_at`, `dedupe_key` text | UNIQUE (`manager_user_id`,`peer_id`,`dedupe_key`) WHERE `status`='open'. The question's record outlives the reply draft (§4 P2). Purged with its chat. |
| `agent_conversation_record` | PK (`manager_user_id`,`peer_id`); `goal` text ≤ 300; `claims` jsonb array of `{kind, text, tgMessageId, at}`; `next_step` text; `next_step_at` timestamptz; `rev` int; `updated_run_id`; `updated_at` | The «mijoz pasporti» seed. A side table — `agent_conversations` gains no column (the standing rule of 0138 / 0145 / 0148 / 0149: nothing existing gains a declared column). Promises and the sale stage are DERIVED (§4 P2), never stored. |
| `agent_acts` | `id`, `manager_user_id`, `peer_id`, `act` text (NO CHECK on purpose — the closed list is `ACTS` in code, so a later stage's act needs no migration; a unit test holds every stored name to a registry key), `position` text, `status` CHECK IN (`asked`,`approved`,`done`,`refused`,`cancelled`,`failed`), `idem_key` text UNIQUE, `input` jsonb, `result` jsonb, `run_id`, `case_id`, `decided_by`, `decided_at`, `done_at`, `error` | The act ledger; `idem_key` is what makes a double tap one act. |
| `agent_action_rights` | `action` text PK, `position` CHECK IN (`ozi`,`nazoratda`,`sorab`,`odam`), `limits` jsonb, `updated_by`, `updated_at` | **THE rights table of every stage** — 3b's page is built ON it, never beside it. A row's key is the ACT's key as registered in `ACTS` (`open_code` 1c · `hear_voice` 2b · `relay_answer` 3a · `honour_quote` 4 …) or, for a right that is no act, the key 3b's `RIGHTS` names (`tell_table_price`, `tell_balance`, `give_discount` …); a stored key is never renamed by a later stage. The migration inserts NO row (a missing row reads `odam` = today's behaviour — from 3b on, `derivedDefault`, `STAGE-3B.md` §6.3a); 1c's screen writes `open_code`. `limits` holds only limits that have no other home (a day's count of codes, a share of the markup); a limit that already lives in a settings key or a column stays there and the page LINKS it. |
| `agent_replays` | `id`, `batch` text, `manager_user_id`, `peer_id`, `anchor_tg_message_id`, `run_id`, `turn` jsonb (parts), `policy` jsonb, `verdict` jsonb, `was` jsonb (what really happened to that line), `created_at` | Dry replay results. Holds model text about a customer → purged with its chat. |

**3.2 Existing constraints — every CHECK a later stage hits, re-made ONCE here.** Each re-made list carries every value it holds today (a unit test derives that from the previous migration's text). A value marked *reserved* is admitted by the database and has NO writer until its stage: `tests/unit/agent-engine-reserved.test.ts` (§7) keeps `src/` from writing it early.

| Constraint | Today (as read) | After this migration | First writer |
|---|---|---|---|
| `agent_runs_trigger_check` | IN (`inbound`,`owner_edit`,`calc_answer`,`hand_back`,`style`) — 0138:103 | + `case_answer`, `replay` (1b); reserved: `reading` (2), `act_result`, `staff_event` (5), `channel` (7 — the company bot's runs, `STAGE-7-9.md` §A3), `timer`, `followup`, `campaign` (8) | as marked |
| `tasks_origin_check` (a PLATFORM table) | `"origin" IS NULL OR "origin" IN ('hand','calc','calc_return','promise','automation')` — `0124_task_origin_calc_note.sql:18-19`, restated in the drizzle check `platform/db/schema/platform.ts:1094` | + reserved `agent` (and the drizzle check with it; `TASK_ORIGINS`, `platform/tasks/service.ts:146`, is NOT widened — the code cannot write it until 3a). `tasks_bound_check` (`0124:23-24`) untouched. Another round may re-make this CHECK in between: derive the list from the LAST migration that did | 3a (call-back and hand-over tasks) |
| `agent_runs_anchor_check` | `trigger <> 'inbound' OR anchor IS NOT NULL` — 0138:111 | unchanged | — |
| `agent_drafts_kind_check` | IN (`reply`,`price`,`hand_back`) — 0138:159 | + reserved `followup`, `reminder`, `greeting` | 6, 8 |
| `agent_drafts.anchor_tg_message_id` | NOT NULL — 0138:132 | DROP NOT NULL + new `agent_drafts_anchor_check`: `anchor IS NOT NULL OR kind IN ('followup','reminder','greeting')`. The drizzle declaration stays `.notNull()` until stage 8 (no reader changes now). | 8 |
| `agent_drafts_live_unique` | one `pending`/`editing` draft per chat — 0138:179 | unchanged (questions leave the draft instead — P2) | — |
| `agent_drafts_category_check`, `agent_auto_config_categories_check` | 7 labels (0138:165, never re-made: `greeting`, `status`, `faq`, `qualification`, `price`, `complaint`, `other`) / 7 kinds (last re-made 0149:22, after 0145 and 0148) | unchanged: a new ACT's position lives in `agent_action_rights`, never in a label | — |
| `agent_outbox` inline UNIQUE on `draft_id` | 0138:186 (drizzle `schema/agent.ts:253` `.unique()`). UNVERIFIED: its database name — the default is `agent_outbox_draft_id_key`; read `\d agent_outbox` on gsr_ci and DROP IF EXISTS both spellings | → UNIQUE (`draft_id`,`part_no`) | 1b |
| `agent_outbox` new columns, **SQL-only this release** | — | `part_no smallint NOT NULL DEFAULT 1`; `part_kind text NOT NULL DEFAULT 'prose'` CHECK IN (`prose`,`block`,`holding`; reserved `file`,`first`); `block_ref jsonb` | 1b / 1c; `file` 4, `first` 8 |
| `agent_outbox_status_check` | IN (`agent`,`sending`,`sent`,`failed`,`cancelled`,`unknown`,`expired`) — 0138:211 | + `parked`: a later part waiting for the part before it. An old listener never selects it. | 1b |
| `agent_outbox.answers_tg_message_id` | NOT NULL — 0138:194 | DROP NOT NULL + CHECK `answers IS NOT NULL OR part_kind = 'first'` | 8 |
| `agent_outbox_body_check` | `length(btrim(body)) > 0 AND length(body) <= 4000` — 0138:210 | `(length(btrim(body)) > 0 OR part_kind = 'file') AND length(body) <= 4000` | 4 |
| `telegram_chat_waits_kind_check` | 11 kinds, last re-made 0148:98 (born 0130; re-made 0138, 0141, 0146, 0148) | + `agent_case`. Other modules re-make this CHECK too, so it cannot be frozen here: any later stage that needs a one-text wait re-makes it with every kind then present. | 1b |
| `agent_auto_verdicts` feedback CHECKs | `'bad'` only, on a `pressed` row (0145:74-77) | unchanged — the daily 👍/👎 sample (9 a) is a ledger of its own: ⟨1a⟩'s `agent_samples` (`qurish/STAGE-0-1A.md` §3.1, §4.5 — that plan builds its smallest form, 3a the full screen; `qurish/COVERAGE.md` row 9 traces it) | — |
| `ai_calc_passes_kind_check` | 7 kinds (0144:70); `tests/unit/ai-press.test.ts` fences the LAST migration re-making it | **not touched by any agent stage**: the replay (1b) bills to `agent_runs`; the readings (2) bill to their OWN table — `qurish/STAGE-2.md` §3 revises what this cell first said («to `agent_runs`»), because `today.ts:44` sums every `agent_runs` row into the token fuse. The reserved trigger value `reading` above therefore gets no writer | — |

Not added: a `carrier` column (12 a — the session only).

**3.3 The probe.** `agentEngineReady()` in `agent/config.ts` beside `agentFullP2Ready` (`config.ts:172`): `to_regclass('agent_cases')` AND `agent_outbox.part_no` in `pg_attribute`; memoised and with the `__forget…` / `__pretend…Behind` test hooks its siblings have. **Behind:** the tools `ask_owner`/`open_code` are not offered and the prompt keeps today's rules 12-14 (`toolSpecsFor`, `tools.ts:256`, gains `engine: boolean`); one part per turn; cards to the holder; no holding line; every writer answers `server_behind` in words. The listener reads the two SQL-only columns only through `to_jsonb(x)->>'part_no'` inside its raw statement (`outbox-store.ts:209`), so a tg-listen ahead of the database reads NULL → part 1, prose.

**3.4 Settings** (`platform/settings/service.ts SETTING_DEFAULTS`, a description in all four bundles — the settings tripwire): `agent_escalate_minutes` 15 (5…240) · `agent_work_hours` `09:00-19:00` and `agent_work_days` `1-6` (use ⟨1a⟩'s keys if 1a already has working hours for night/signal — ONE home) · `agent_turn_max_parts` 3 (1…3) · `agent_holding_on` true · 1c: `agent_won_ownership` `seller` (the only value honoured until stage 5 builds the other two and their screen) · 1c: one row of `agent_action_rights`.

## 4. Code

### 4.0 Kernel K (one commit, before any package)

| File | Change |
|---|---|
| the migration + `platform/db/schema/agent.ts` | the five new tables declared; `agentOutbox.draftId` loses `.unique()`; NO declaration for `part_no`/`part_kind`/`block_ref` |
| `agent/config.ts` | `agentEngineReady()` |
| `agent/turn.ts` (new) | Pure. `TurnPart = {kind: 'prose' \| 'block' \| 'holding', body, blockRef?}`; `joinParts`, `partsOf(draft)` (reads `policy.parts`, else one prose part = the body), `PART_SEPARATOR`. The ONE home of «what a turn is». |
| `agent/last-out.ts` (new) | Pure. `lastAnswerOut(messages)` — our newest OUT line that is NOT a holding line. The ONE home of «a holding line is not an answer». |
| `agent/speakers.ts` (new) | `maySpeakForSeat(actor, managerUserId)` and `cardRecipients(managerUserId, {escalated})` (§5). The ONE home of «who may press / who is shown a card». |
| `agent/acts.ts` (new) | The act registry `ACTS: Record<ActType, ActSpec>` (`precheck` = facts as data, `execute`, `idemKey`, `blocks`) and the ONE executor `performAct` / `decideAct`; `positionOf(action)` reads `agent_action_rights` (missing = `odam`). K ships the skeleton and `ask_owner`. |
| `agent/queues.ts` | `JOB_AGENT_EVENT = 'agent.event'` with a discriminated `AgentEventJob` (1b: `case_answer` only — later stages add members, never a new queue); `JOB_AGENT_PRESS = 'agent.press'` (`{draftId, digest}`). Both `retryLimit: 0` like every model job (a redelivery is a second bill). Zero imports stays true (the listener reads this file). |
| `agent/purge.ts` | names the four chat-keyed tables (`agent_cases`, `agent_acts`, `agent_conversation_record`, `agent_replays`) — `tests/unit/agent-fences.test.ts` derives the list from the schema and is red until it does |
| `platform/telegram/staff-bot.ts:423` `AGENT_OPS` | new letters (free today: `d i m o q w`): `i` answer a case, `m` take the case's chat, `o` approve an act, `q` refuse it, `w` attach to the named code (carries the client's eight-hex tail, as the echo buttons do), `d` resend a closing turn. The `agent` kind stays `cas` in `PRESS_REPEAT` (`:445`, its `agent:` line `:482`): each new press is refused the second time by its own service (the case's status, the act's `idem_key`). The derived fences («every button a card DRAWS is one the parser takes», `tests/unit/agent-fences.test.ts:300-308`) must see every new card. **As read, `q` is not simply free:** two tests use it as their «unknown letter» example — `agent-fences.test.ts:233` and `agent-owner-answer.test.ts:439` both assert `parseCallback('ag:q:<id>')` is null, and the `AGENT_OPS` comment says «`q` stays unparsed». Taking `q` rewrites both assertions with the reason in their titles; with all six taken no letter is left, so the «unknown op» example becomes a non-letter (the grammar is `[a-z]`, `:806`). |
| `tests/unit/agent-engine-reserved.test.ts`, `agent-engine-migration.test.ts` | §7 |

### 4.1 P1 «Qismlar» — several parts per turn

| Where (as read) | Today | Change |
|---|---|---|
| `tools.ts:218-249` `compose_reply` | one `reply_text` | + `reply_parts: string[]` (1…`agent_turn_max_parts`); `reply_text` stays the joined text, so every reader and every corpus eval sees what it saw |
| `run.ts:167` `parseCompose`, `drafts.ts:455` `draftFromRun` | body = one text | `policy.parts` stored in the draft's existing jsonb; `proposed_body` = `joinParts(parts)` |
| `policy-input.ts policyFor` → `policy.ts:2769` | one check of one text | `checkTurn(parts, memory)`: (a) `checkAgentReply` on the JOINED text exactly as today, `too_long` excepted; (b) `checkAgentReply` on EACH part (700 chars each, `policy.ts:2776`); blocks = the union. So a split can only ADD blocks: a price in part 1 and its «boj va QQS alohida» in part 2 fails G11 on part 1 — «each money part is self-sufficient». |
| `card.ts:263` `cardDigest` | body + actions | the body it hashes is the joined text WITH `PART_SEPARATOR` — a press approves the split he saw. His ✏️ words (`finalBody`) are always ONE part. |
| `decide.ts:1253-1267` | ONE `agent_outbox` row | one row per part in the same transaction; part 1 as today; parts 2… are born `status 'parked'`. NOT `'agent'` with a far clock: `dueAgentRow` treats any `agent` row at step `typing`/`send` as the account's one reply in flight (`outbox-store.ts:73-88`) and would stall every other chat behind it. Raw SQL for the three SQL-only columns. |
| `outbox-store.ts:512` `applyAgentOutcome` | settles one row | on `sent` of part k: release part k+1 — `parked` → `agent`, `step 'typing'`, `read_done true` (no second read), `next_step_at = now() + 1-2 s` — by compare-and-set; on a FINAL cancel/fail of part k: cancel the later parts `part_cancelled`. One statement each, inside the function's own write. |
| `outbox-store.ts:234-238,397-399` `own_sent` / `forgivenOut` | forgiven only for owner-started drafts (K1) | `forgivenOut` = K1's set ∪ **this draft's own earlier parts** ∪ **the chat's holding rows** newer than the anchor. Nothing else: two inbound replies for one burst still cannot both go. |
| `send-step.ts:240` `chat_gap` | ≥ 20 s between two AI messages in a chat | not asked between parts of ONE draft (`lastChatSendAt` of the same draft is exempt); the account gap, the hour and day caps count every MESSAGE; `perChatPerDay` (`limits.ts`) counts TURNS (distinct `draft_id`) |
| `send-step.ts:209`, `:368-384` | a newer substantive inbound cancels the row | unchanged — later parts die as `anchor_superseded` and the next run reads the parts that went as our last lines. Never re-sent. |
| `after-sent.ts:251`, listener `sent` branch | one job per outbox row = per draft | still one job per row; the offer step acts on the part whose body STATES the marks (`statedCalcMarks`), the stage step once per draft; `policy.afterSent` becomes per-step |
| every door that cancels a waiting row by `status = 'agent'` — `drafts.ts:716-720`, `:787-793`, `decide.ts:1280-1285` and `takeChatInTx` (`:801`), `afterMachinePress` (`:852`), `config.ts disarmAutoInTx` (`:262`) / `setAgentMode` off (`:411`) / the markup change (`:732`) / `forceAgentOff` (`:837`), `calc-loop.ts:259` (`offer_gone`) and `:965` (his 💵), `web-thread.ts` (the list as grepped: `status: 'cancelled'` under `agent/` — re-grep on your tree) | cancels one row | cancels the draft's `parked` rows with it (one helper, `cancelDraftRows`); `today.ts OUTBOX_GOING` gains `parked`, so the ✅ door budgets a whole turn; a sweep net expires a `parked` row whose predecessor ended unsent |
| every `agentOutbox.draftId` reader that takes ONE row — `card-io.ts:617`, `context.ts:663-664`, `auto-send.ts:1049` (`machinePressedReply`, feeding `afterPressOf` `:1062`), `web-thread.ts:94`, `decide.ts afterMachinePress` (`:835`) | `[o] = …` | each classified «first / last / all parts» in one fence (§7 `agent-outbox-parts-wire`); the card prints «2/3 yuborildi» |
| every JOIN on the outbox by draft — today one row per draft, after this a row per PART (as grepped): drizzle joins of `agentOutbox` and `agentDrafts` on `draftId` at `decide.ts:410`, `web-page.ts:232`, `:490`, `:668`, `:675`, `policy-input.ts:166` (the fingerprint count, read from the outbox side); raw joins on `o.draft_id` at `calc-loop.ts:811`, `calc-price.ts:162`, `after-sent.ts:289` | each draft appears once | a list or a count that silently multiplies by the number of parts (the page's lists, the stats, the «priced reply» reads). The same fence classifies them — it must read raw SQL (`o.draft_id`) as well as the drizzle column — and each takes part 1, the last part, or an aggregate on purpose |

`AgentOutboxRow.status` (`send-step.ts:32`) gains `parked`. Untouched: `runAgentStep`'s choreography and slot (`send-step.ts:467-580`), `dueAgentRow` (`outbox-store.ts:73` — it selects `agent` rows only, so a parked part is invisible), the 6-hour approval age, every cap's value.

### 4.2 P2 «Savollar» — the case, the holding line, acts before speech, the record

- **`ask_owner` is a TOOL the model calls inside the run** (`ACTS.ask_owner`, position fixed `ozi`): input `{question, cited_message_refs}`; refused in words when the question holds a numeral beside a currency (`digits.ts holdsNumeral`/`namesCurrency` — the lesson door's precedent, `lessons.ts:129 lessonShapeRefusal`): a case card carries no money, the supervisor reads figures in the thread behind his own Telegram sight. It writes the `agent_cases` row (idempotent on `dedupe_key` = run id + folded question) and answers «Savol yuborildi. Mijozga o'zing "so'rab beraman", vaqt yoki va'da YOZMA — kutish xabarini tizim yuboradi». `compose_reply.needs_owner` / `owner_question` (`tools.ts:233`) are removed from the schema for model-raised questions. **This is «acts before speech»**: the act ran, its result is a tool result, and the reply that follows may rely on it. `calc_submit` already satisfies the rule and is NOT moved: it lands at the press, before the reply is queued (`decide.ts:1175-1199`) — and with P4 that press is seconds after the run.
- **Forced questions stay exactly as built**: `withRailRule` (`run.ts:1569`), `withAviaRule` (`:923`), `withAviaGuard` (`:1395`) still set `needsOwner` + `forcedQuestion` on the draft and he answers through ✏️. Not one avia or rail reader changes (the reader corpus's avia rows are their fence — 183 dangerous and 94 ordinary at this HEAD). The only addition: such a draft also gets a holding line.
- **The holding line** (`agent/holding.ts`, new; the ONE writer `queueHoldingLine(caseOrDraft)`): a fixed sentence per language (§6.3), never model text. With a reply in the same turn it is that draft's LAST part (`part_kind 'holding'`); alone, it is a draft of its own born `approved` with one outbox row in one transaction (`decided_by` = the holder, audit `via: 'system'`). It goes only while «o'zi yuborish» is armed on a work number (`autoPressStandsInTx`, `auto-send.ts:972`) — in shadow the case card says «mijozga kutish xabari ketmadi». One per case; fuse `holdingPerChatPerDay` 3 in `limits.ts`. It rides the ordinary send step (night rule, caps, live head).
- **A holding line never ends a burst**: `context.ts:692-694` computes `lastOut`/`burst` from «our last out»; `chatMessages` tags a row `holding` (a join on `agent_outbox` through `to_jsonb`), and `loadContext`, `lastOutAsked` (`run.ts:445`), the echo window (`run.ts:388`) and `chatMoved` (`decide.ts:227`) all ask `lastAnswerOut`. Without this the answering run's `burst` is empty: the card shows no customer line and `localeToRemember` reads no language.
- **The case's card** (`agent/case-card.ts`, new; notification type `AgentCase` added to the unmutable list `mutes.ts:331-342` and to `NIGHT_SILENT_TYPES`, `night.ts:28-39` — and, because it quotes a chat, to `purge.ts` `chatCardsWhere`: `tests/unit/agent-fences.test.ts:157` refuses an unmutable type that is neither blanked there nor in the test's `NO_CHAT` map): quoted customer lines, the question, buttons «✍️ Javob yozish» (arms wait `agent_case`), «🙋 Suhbat meniki» (today's `takeChatInTx`), «🔗 Suhbat». A swipe-reply to the card is the answer too (`platform/telegram/reply-door.ts` precedent).
- **The answer** (`agent/case-answer.ts`, new — today's `owner-answer.ts`/`owner-answer-job.ts` re-keyed from «question draft» to «case»): stored on the case (`answered`), `JOB_AGENT_EVENT {case_answer}` → `runOwnerTriggered` (`run.ts:1809`) with `trigger: 'case_answer'`, source key `case:<id>:<messageId>`. `AnswerMark` (`types.ts:136`) gains `caseId`; `owner_figure` (`auto-gate.ts:415`), `owner_personal`, `answer_stale` are computed as today from the CASE's anchor and `burst_seen_at`. Inside `createDraft`'s transaction the case moves `answered` → `relayed` by compare-and-set, else `question_gone` (`drafts.ts:244-275` is the model). A figure-free answer may go by itself; one with a figure comes back as a card with ✅ — unchanged rule.
- **The clock**: a draft carrying `policy.caseId` of a case whose holding line was SENT keeps the week (`anchor-clock.ts anchorMaxAgeMsFor` + its SQL twin `anchorMaxAgeMsSqlText`, which a unit test already holds to one grid). After the week the sweep closes the case `expired` and tells the supervisor «javob mijozga ketmadi — o'zingiz yozing».
- **A newer customer line no longer loses the question**: `createDraft` supersedes the live DRAFT as today (`drafts.ts:312-325`); the case is not a draft and stands. The next run reads it.
- **The record** (`agent/record.ts`, new): `loadRecord` adds to the chat block (`prompt.ts chatBlock`) a section «SUHBAT YOZUVI»: goal, the customer's claims marked «mijoz aytgan», open cases («javob kutilmoqda — qayta so'rama»), open calculations (already printed), the derived sale stage. `saleStageOf(facts)` is PURE and derived from facts only — a lead/client, an open calc chain (`chatCalcChains`, `context.ts:575`), a sent quote (`lastQuoteFor`), a code, cargo — never from the model. `compose_reply` gains `record: {goal, claims[]}`; `next_step` (written `drafts.ts:343`, read by nobody today) is stored on the record and shown on the page. **A claim is never a source and never a tool input**: tools still take refs from the recent window only (`context.ts:503`, #1622) — an old measure is asked again (stated, §10).
- `jobs.ts:229 remindOwnerQuestions` is replaced by P3's escalation; `jobs.ts:387-399` (step 2) is safe as written — it forgives every `agent_outbox` id.

**Event triggers after 1b — what starts a run, and the constraint each one meets:**

| Trigger | Started by | State | What it hits |
|---|---|---|---|
| `inbound` | the listener's live hook, the sweep's gap pass (`jobs.ts:445`) | as built | `agent_runs_inbound_unique` (anchor, attempt); `agent_runs_anchor_check` |
| `calc_answer` — a VED answer | `announceAgentCalc` → `agent.calc_answer` → `handleCalcAnswer` (`calc-loop.ts:519`) | as built, untouched | source key `calc:<request>:<anchor>`; needs the customer's newest inbound ≤ 7 days (`run.ts:1853`); draft kind `reply` + `policy.calcAnswer`; the outbox row answers that inbound, K1 forgives our own «yubordim» |
| `hand_back` | the VED's «Qaytarish» (`calc-loop.ts:343`) | as built | draft kind `hand_back`; gate `not_reply` |
| `case_answer` — the supervisor's (3a: a colleague's) answer | P2, `JOB_AGENT_EVENT` | NEW | the widened trigger CHECK; `agent_runs_source_unique` (`case:<id>:<message>`); the anchor is still the customer's newest inbound, so both NOT NULLs hold; the week clock by `policy.caseId`; the live head must forgive the holding row |
| `replay` | P5's script | NEW | the widened trigger CHECK; writes no draft and no outbox row |
| `timer` | — | **reserved, no consumer here**: 1b's clocks (the deputy's 15 minutes, a case's week, an undelivered code) are sweep STEPS that card a person. A timer that makes the AI SPEAK is a follow-up — stage 8, which is why the nullable anchors and the `followup` kind are laid in §3.2 now. | — |

### 4.3 P3 «Rahbar va o'rinbosar» — the supervisor pair

- **Recipients.** Every `userIds: [managerUserId]` of an agent card — `drafts.ts:391,542,557`, `calc-loop.ts:181,404,675,688`, `jobs.ts:253,672`, `lessons.ts:561`, `owner-answer-job.ts:82`, `tariff-watch.ts:200`, `bot-door.ts:978,1193` (every `userIds: [` under `agent/` as grepped, but ONE: `auto-send.ts:1268`, the step-down alarm to the holder and every super_admin — the fence must classify it, and it stays as it is) — becomes `cardRecipients(managerUserId)`: the holder when the holder is a person's own account; the designated supervisor (⟨1a⟩ `designated('supervisor')`, rank 1 — the screen's «Rahbar va o'rinbosar») when the holder IS the AI seat (`holderIsSeat`, `platform/settings/agent-seat.ts`); plus the deputy once escalated. A derived fence lists the sites.
- **Two rows per card.** `createDraft` re-points ONE notification row (`drafts.ts:55-63,375-390`) — it must re-point each recipient's; `refreshAgentCard` already loops over rows (`card-io.ts:651-657`) but writes ONE text for all — render per recipient (law 4, §5). `cardOnScreen` (`auto-send.ts:788`) asks the SUPERVISOR's copy for the 2-minute hold.
- **Who may press.** The holder is compared by hand in nineteen lines (grep `!== actor.id` / `!== staffId` / `!== holderId` under `agent/` — re-grep on your tree). They split three ways:
  - **the pair** (`maySpeakForSeat`): `decide.ts:960` (✅ ❌ 🙋 ✏️), `:1421` (his own words), `:1496` (✍️ — which also demands `config.ownerUserId === actor.id`, `:1498`), `auto-send.ts:1155` (⏸), `:1229`, `:1329` (👎), `web-thread.ts:151` (cancel), `calc-loop.ts:877` (💵), `bot-door.ts:1020`, `:1162` (the stranger card and its code echo), `:1350`;
  - **the supervisor only, never the deputy** (new `mayApproveKnowledge`, same file): `bot-door.ts:662` (📌 / 👤), `lessons.ts:365` and `:367` (`lessonFromBot`), `:381` (`confirmLesson` — «✅ Saqlash»), `:508` (`queueLessonRedraft`) — «only he approves knowledge» stands, and after P3 his cards are no longer in the seat's own Telegram, so the holder-only test would lock HIM out;
  - **unchanged**: `bot-door.ts:461` («✅ Tarif to'g'ri», a money vouch), `config.ts:393` (the mode), arming (`mayArmAuto`, `auto-send.ts:1444`).
- **Every act runs as the HOLDER, the audit names the presser.** `landCalc(d, calc, actor, …)` (`decide.ts:1186`) passes `collectedBy: actor.id` to `landIntake`: with the deputy pressing, the VED job would be the deputy's (open-calc cap 20 instead of the seat's 100, «Готово» pushed to the deputy, `agent_calc_links` off the seat). So `decideDraft` splits `actor` (authorisation, `decided_by`, `queued_by`, the audit row) from `actActor = holderActor(d.managerUserId)` (`auto-send.ts:734` — module-private today: export it, never restate it) used by `landCalc` (which writes `collectedBy: actor.id` at `decide.ts:617`), `runDraftActions` (`decide.ts:1370`) and the sweep's stuck-action step (`jobs.ts:529-541`, which today takes `decidedBy`'s grants).
- **Escalation** (`agent/escalate.ts`, new; a sweep step in `jobs.ts agentSweep` in place of step 2a): a case, or a draft that waits for a person, older than `agent_escalate_minutes` of WORKING time (`workMinutesBetween`, pure, Tashkent clock from `platform/time/tashkent`) and not escalated → the same card to the deputy, claimed by `agent_cases.escalated_at` / `agent_drafts.owner_reminded_at` (the existing once-only column, 0138:156). The clock does not run outside working hours (4 a). First press wins (the existing compare-and-set); the other copy is closed by `refreshAgentCard`.

### 4.4 P4 «Darhol» — the inline press

`auto-send.ts:851 pressOne` is reached only from the minute sweep (`:922`), so «at once» is up to 60 s late. New `pressNow(draftId, digest)` — the same claim (`waiting` → `pressing`, restricted to one row), the same fresh gate, the same `decideDraft(…, {auto: true})` — called by `handleInbound` after `writeDraft` (`run.ts:569`) and by `runOwnerTriggered` (`:2006`) when the plan is eligible and its hold is zero (⟨1a⟩'s per-kind hold; if 1a already presses inline this package is a re-check — and `qurish/STAGE-0-1A.md` §4.2 does plan a `pressNow(draftId, now)` called after `writeDraft` in 1a's P1: then what is left for THIS package is the second caller in `runOwnerTriggered`, the `JOB_AGENT_PRESS` below for held replies, and ONE signature for both stages). A reply with a hold (a price) gets `JOB_AGENT_PRESS` with `startAfter` = the hold, so it leaves on its second and not on the next minute; the sweep stays the net. Both doors meet at the one claim — pressed once. For a zero hold the «card must have rung» rule (`auto-send.ts:875-895`) is not asked; for a held reply it is unchanged. The press still runs in the app's worker, never on the bot's poller (#706).

### 4.5 P5 «Sinov» — the dry replay

`scripts/agent-replay.ts`, run through `migrate` like `scripts/agent-census.ts` (never a package.json command, #1228): `--days N` (default 14) `--max-turns N` (default 150, a COUNT, never dollars) `--peer <id>`. For each customer burst on the holder's account it builds the context AS OF that line (`chatMessages` gains an optional `upTo` tg id — `context.ts:449`; identity and tools read TODAY's data, stated), calls `runLoop` (`run.ts:193`) on the fast tier with `dry: true` (act tools answer their words and write nothing), then `checkTurn` and `autoVerdict`. It writes ONLY `agent_replays` and an `agent_runs` row with `trigger 'replay'`. **The bill**: those rows are in the 20:00 «AI» line (`reports/ai-spend.ts:172 agentPart` sums every `agent_runs` row) and are EXCLUDED from the token fuse — `today.ts:44` sums every trigger today (a `style` run counts on purpose), add `FILTER (WHERE trigger <> 'replay')`, or a replay would stop real customers. **What it proves**: how many turns would go by themselves and each refusal's count, against what really happened to the same line (`was`: sent unchanged / edited / rejected / waited); every turn the policy blocks that he had sent unchanged (the regression list); measured tokens per turn. **What it does not**: that a reply is RIGHT — he reads twenty side by side on the page's «Sinov» tab (`web-page.ts`). Fence: the script imports no `writeDraft`, `createDraft`, `decideDraft`, `notifyStaffTelegram`, `enqueue`.

### 4.6 1c — P6 «Kod» and P7 «Pochta»

**P6.** `ACTS.open_code` in `agent/acts.ts` + `agent/closing.ts` (new, pure: the blocks).
- **Offered** only when the probe is ready and `positionOf('open_code') !== 'odam'`; then prompt rule 12 (`prompt.ts:85`, «GS kodni … o'zi ochadi» — the owner's name stands there today, ⟨1a⟩ makes it «rahbar») reads «mijoz jo'natishga qaror qilsa — open_code; kod va manzilni o'zing YOZMA». Position `odam` = today's rule 12, byte for byte.
- **Input**: `{commit_ref, city_ref}` — two message refs of the customer's own lines. Nothing numeric, no name, no code.
- **`precheck` (data, never the model's reading)**: a LEAD chat (`identity.leadId`, no client — `context.ts:279`); the lead open and the holder's or nobody's (`machine-owner.ts:21`); no «lead about a colleague's client» (`winLead` throws `lead_about_client`, `crm/service.ts:1114-1121`); `commit_ref` an inbound line of the recent window; the city named in `city_ref` (`origin.ts:120 namedOrigins`) resolves to exactly ONE live receiving-address fact (`kb.ts:110 warehouseAddressTexts` — the `china_address_*` seeds or `isReceivingAddressFact`), else the tool answers rule 12's own «qaysi shahardan jo'natishini so'ra» — **the AI asks, never picks**; the road: when the chat's road is air or the flight was spoken of (`run.ts:885 chatRoadOf`, `run.ts:807 aviaSpokenOf` — export it, never restate it), **no address block** (17 c) — the code still opens and today's forced avia question asks him; duplicates: `activeClientsByPhone(lead.phone)` (`client-cabinet/service.ts:94`, the «+» door's own check) — a match is never minted over, it is NAMED on the card.
- **Position `sorab`**: act row `asked` + a case `kind 'act'` + card «🆕 Kod ochishga tayyor» (§6.3) that prints the exact blocks; the tool answers «So'rov yuborildi. Kod hali OCHILMAGAN — kod ham, manzil ham AYTMA»; holding line «…kod va manzilni shu yerga yuboraman».
- **The tap** → `decideAct(actor, actId, 'approve')`: `maySpeakForSeat`; prechecks again; then **`winLead(leadId, {token: uuidv5(actId), salesManagerId: wonOwnerFor(lead)}, {actorId: holder})`** (`crm/service.ts:1063`; `wonOwnerFor` is NEW — the one reader of `agent_won_ownership`; the token must be uuid-shaped or `winLead` mints a random one and the double tap is no longer one act, `:1089`) — the one ceremony (`tests/unit/won-law.test.ts`), run as the HOLDER: the client's seller is `input.salesManagerId || lead.ownerId || ctx.actorId` (`:1129`), i.e. the seat, as today (31 c); `celebrateLeadWon` praises the lead's owner through the event drain (`staff/celebrate.ts:81`); the prixod stamp follows the client's seller (`staff/stamp.ts:31`). `winLead` owns its transactions — **never wrap it in one** (#714, `tests/unit/tx-pool.test.ts`). The token makes a second tap `wonAlready`. «🔗 GS… ga biriktirish» = the same call with `attachCode`. `decided_by` = the presser; the act's audit row says `via: 'ai_act'`.
- **The closing turn is ALL SYSTEM** (no model run, so nothing unseen goes after one tap): a draft born `approved` with parts ① code + marking (`part_kind 'block'`, template by the chat's language), ② the address fact's `answer` verbatim — it already ends with `GS_REMINDER` (`seed-kb.ts:39`), ③ optional: the company bot's link (`platform/telegram/bot.ts:57 getBotUsername`), only when the card has a phone and the link fuse allows it (`policy.ts:2873`: one link per chat per 7 days, ten a day) — omitted silently otherwise, never a block. `block_ref` = `{factId, md5}`; the send step re-checks the fact still stands as quoted (one read beside `draftOfferStands`, `outbox-store.ts:371`) — a fact he edited meanwhile cancels the part and tells him.
- **Identity**: the turn carries `client_id` = the new client. As read, `bindMoved` (`context.ts:401`) keeps a WON lead the same person (K25), so a reply drafted for the lead before the tap is NOT cancelled `identity_changed` (`send-step.ts:218`) — `critic-feasibility.md` §C stage 5 says otherwise; pin it with a test, do not «fix» it. A hidden-number lead mints `phones: []` (`crm/service.ts:1126`): no cargo or balance tool until the customer links the cabinet (`chatProof`, `context.ts:211`) — the card says «📵».
- **A code opened and not told is an alarm**: if the closing turn's code part ends cancelled/failed/expired, a sweep step cards the supervisor «⚠️ Kod ochildi (GS…), lekin xabar mijozga yetmadi» with «🔁 Qayta yuborish» (a fresh turn on the newest inbound; the city re-checked).
- The record gains «kod ochildi: GS…; manzil yuborildi: …», so the next model run knows; the fresh code is in `identity.codes` at once (`other_client_code`, `policy.ts:2826`, reads them).

**Surfaces of both stages.** Page `src/app/(protected)/suhbatlar/ai/` (`page.tsx`, `agent-ui.tsx`, `labels.ts`): tabs «Savollar» (the cases, in place of the question drafts) and «Sinov», and a small section **«Huquqlar»** — a LIST of rights rows read from the act registry, one row today («Kod ochish», a select of the positions that row allows). Build it as a list, not as one hard-wired select: 2b adds the row `hear_voice`, 3a `relay_answer`, part 4 `honour_quote` — each a ROW of the same `agent_action_rights` table under the act's own key — and 3b's page («Huquqlar» in full, `STAGE-3B.md` §4.5) REPLACES this section and adopts every stored row unchanged (§6.3a there). The position words are the four of §9. Every new refusal code a key in `labels.ts` and in all four bundles (`tests/unit/agent-web-labels.test.ts`, `i18n-keys.test.ts`). The morning line of ⟨1a⟩ gains «Ochiq savollar: N · Ochilgan kodlar: N». Bot: the cards of §6.3 through `agent/bot-door.ts agentPress` (`:258`).

**P7.** From the first AI-won client, «the client's seller» is the seat, so every message the system writes «to the client's seller» must reach the designated supervisor instead — for every type EXCEPT the agent's own cards and the calc loop's answers (those are the machine's inbox). **ONE home, built here once: `platform/notifications/seat-mail.ts` (new) `readdress(userIds, type)`** — a recipient that is the AI seat (`agentSeatUserId`, `platform/settings/agent-seat.ts:23`) becomes `designated('supervisor')`; the designation is read by dynamic import (platform never imports wms). **As read, there are TWO writers of a staff notification and BOTH must call it** — the first version of this step named one and would have left «Prixod keldi» in the seat's mailbox: (1) `queueStaffTelegram` (`platform/notifications/staff.ts:46`), the body of `notifyStaffTelegram`; (2) the EVENT DRAIN, which never passes through it — `buildRecipients` (`platform/notifications/service.ts:342`) names `client.salesManagerId` for `ReceiptConfirmed` (the «Prixod keldi» message), `ReadyForPickup`, `BoxIssued`, and the drain inserts its own rows (`service.ts:1003`, `:1019`): `readdress` is applied to `buildRecipients`' result before those inserts. `reachOf` (`staff.ts:141`) answers for the person it will really reach. A derived fence (`seat-mail-wire.test.ts`): every insert into `notifications` under `platform/notifications` passes `readdress`. What 1c does NOT do, and stage 5 does on the same home (`STAGE-4-6.md` §5.4 P4): make the BUTTONS of that mail work for the pair (`actsForSeat` in the refile and promise doors) — until then each button of such a message answers by the presser's OWN existing rights (a refusal is in words, never silence); say so in the deploy note.

## 5. Doors and sight

| Door | Predicate (existing unless marked NEW) |
|---|---|
| Press ✅ / ✏️ / ❌ / 🙋 / ✍️ / ⏸ / 👎 on an agent card; answer a case; tap an act | NEW `maySpeakForSeat`: the actor is the holder, OR the holder is the AI seat (`holderIsSeat`) and the actor is the designated supervisor or deputy (⟨1a⟩ table, each `canLogIn`). Never a role key. A personal account's cards stay its holder's alone (answer 15 holds there). |
| Approve knowledge (📌 / 👤, a lesson) | NEW `mayApproveKnowledge`: the holder, or the designated SUPERVISOR while the holder is the seat — never the deputy |
| Arm / disarm, the mode, the caps, «✅ Tarif to'g'ri» | unchanged: `mayArmAuto`, `mayTuneAuto` (`auto-send.ts:1435-1449`), `mayRunAgent`, `bot-door.ts:461` |
| Page `/suhbatlar/ai` (tabs «Savollar», «Sinov», the rights select) | `agentDoorsFor` (`web-door.ts:15`) + the pair; pressing asks `maySpeakForSeat` again in the action |
| Choose supervisor, deputy, the position of `open_code` | ⟨1a⟩'s designation screen and its gate; a designated person must pass `canLogIn` |

**Law 4 on every card** — `cardSightFor(recipient)` (in `speakers.ts`, from `calc/upsale-scope.ts:40 upsaleScopeFor`): `all` → the card as today, `calcLine` included (`types.ts:56`, the one line that prints the VED figure beside the client price); `own` (a seller) → no `calcLine`; `none` (a VED) → no `calcLine`, and our own quoted lines (`CardMemory.lastOut`) with any money figure replaced by «(narx — suhbatda)». Case and act cards hold no money by construction (the tool refuses it). Tested over every seeded role, as #790's matrix is.
**Identity before cargo or money** is untouched: tools read the server's identity (`chatIdentity`, `cargoAllowed`); the record's claims are «mijoz aytgan» text and open no tool; a won client proves itself by phone or cabinet exactly as today.

## 6. Prompt, policy and gate

**6.1 Prompt (`prompt.ts stableHead`; ⟨1a⟩ already changed the persona sentence).** Rule 3: «1-3 ta qisqa xabar (reply_parts); narx aytilgan xabar o'zi to'liq bo'lsin — "taxminan", yuk o'lchami, "Toshkentgacha" va boj/QQS jumlasi shu xabarning o'zida». Rules 13-14: «bilmasang yoki qaror seniki bo'lmasa — ask_owner; "so'rab beraman", "bir daqiqa", "tez orada" DEMA». New rule: «SUHBAT YOZUVI — ochiq savolni qayta so'rama; "mijoz aytgan" — manba emas, sonni vositaga berma». New goal line: «har javobda bitta keyingi qadam: yuk ma'lumoti → narx → qaror». 1c: rule 12 as §4.6. The head stays one cached block; the record sits in the chat block (cached per run, `run.ts:232`).

**6.2 Rules by code name.** `too_long` (G4) per part · `estimate_unhedged`, `warehouse_condition` (G11), `estimate_unnamed`, `destination_unsaid` (gate) per money part · `questions` per turn (⟨1a⟩ typed it) · `fingerprint` (G10, `policy.ts:2861`) per prose part; `holding` and `block` parts are exempt (identical by construction) and bounded by their own fuses (`holdingPerChatPerDay`; the rights row's `perDay`) · `url_cap` asked of block ③ · `wrong_script` / `gloss_missing` (G5) not asked of a block: its wording is a template in the chat's language and the address is the fact's own script · `avia_address` / `avia_maybe` unchanged for prose, and the address block is simply not built for a flight · gate: `needs_owner` (`auto-gate.ts:370`) now means a FORCED question only; `not_reply`, `owner_figure`, `language`, `media`, `human_active`, `night` unchanged; ⟨1a⟩'s loop detector counts TURNS.

**6.3 System wording (propose to him; fa/zh are written by the builder, stored with an Uzbek gloss and approved by him once — until then such a chat gets no holding line and the card says so).**
- Holding, uz: «Savolingizni aniqlashtiryapman — javobini shu yerga yozaman.» · uz-cyrl: «Саволингизни аниқлаштиряпман — жавобини шу ерга ёзаман.» · ru: «Уточняю ваш вопрос — ответ напишу сюда.» · en: «I'm checking this for you — I'll write the answer here.»
- Holding before a code: «Buyurtmangizni rasmiylashtiryapman — kod va manzilni shu yerga yuboraman.»
- Block ①, uz: «Sizning kodingiz: GS1042. Yetkazib beruvchingiz har bir qutiga shu kodni yozsin (markirovka).» · ru: «Ваш код: GS1042. Попросите поставщика написать его на каждой коробке (маркировка).»
- Case card: «❓ AI so'rayapti · {mijoz}» / the question / «│ {mijoz satrlari}» · deputy line: «⏰ {N} daqiqadan beri javobsiz (ish vaqti) — siz ham javob bera olasiz.»
- Act card: «🆕 Kod ochishga tayyor · {lid}» / «📞 {telefon}» or «📵 raqam yashirin — kod telefonsiz ochiladi» / «Mijoz: «{iqtibos}»» / «Ombor: {Ivu (YW)}» / «Mijozga ketadi:» + the blocks / buttons «✅ Kod ochish», «✖ Yo'q»; with a duplicate: «⚠️ Bu raqamda mijoz bor: GS323 — {ism}», «🔗 GS323 ga biriktirish», «🆕 Baribir yangi kod». Avia: «✈️ Avia — manzil yuborilmaydi, o'zingiz yozasiz». Toast: «✅ Kod ochildi: GS1042 — xabar mijozga ketyapti».

**6.4 Corpora and fences that stay green.** `tests/unit/agent-reader-corpus.test.ts` with `fixtures/agent-reader-corpus.ts`, `-eval.ts`, `-known.ts` — no reader changes, so the ratchet must not move in EITHER direction; run it before and after every package. `tests/unit/agent-policy-first-reply.test.ts` — unchanged verdicts, proven by the equivalence test (§7). `docs/ai-toliq/corpora/customer-safety/*.json` — every dangerous reply still stopped, whole AND split. `tests/unit/agent-fences.test.ts` (closed toolset — add `ask_owner`, `open_code`; the `ag:` grammar; the purge lists), `tests/unit/ai-press.test.ts`, `migration-journal.test.ts`, `tx-pool.test.ts`, `won-law.test.ts`, `tg-listen-agent-wire.test.ts`, `i18n-keys.test.ts`, `notification-mutes.test.ts`.
**Known cases EXPECTED to change, each with its reason written in the test:** `agent-send-step.test.ts` «forgiven is empty for every non-owner-started draft» → «…except the draft's own earlier parts and the chat's holding rows» · `agent-auto-gate.test.ts` / `agent-auto.integration.test.ts` rows where a MODEL-raised question refused `needs_owner` → the question is a case and the reply is judged alone · `agent-owner-answer.integration.test.ts`, `agent-card-flow.integration.test.ts`, `agent-answers*.test.ts` → re-keyed to cases · `agent-decide-send.integration.test.ts` «one outbox row per draft» → per part · the leak-11 toolset literal. No corpus case changes its label.

## 7. Tests to write

**Unit** (each names what it proves):
- `agent-engine-migration.test.ts` — each re-made CHECK list ⊇ the previous migration's list (derived from the SQL text, never restated); no `ai_calc_passes` statement; no INSERT into `agent_action_rights`.
- `agent-engine-reserved.test.ts` — no file under `src/` or `scripts/` writes a reserved trigger (`reading`, `act_result`, `staff_event`, `channel`, `timer`, `followup`, `campaign`), draft kind, `part_kind`, case kind (`complaint`, `handover`) or the task origin `agent`; a stage removes its own value from the list. This list is the whole of «what later stages were promised»: `qurish/COVERAGE.md` §C.5 names the stage that takes each value.
- `agent-turn-parts.test.ts` — `checkTurn([body])` ≡ `checkAgentReply(body)` for every case of the first-reply corpora and the customer-safety sets; every dangerous case split at EACH sentence boundary into 2 and into 3 parts is still blocked.
- `agent-holding-lines.test.ts` — every holding sentence and block template, in its locale: 0 blocks and 0 warnings from `checkAgentReply`, no numeral (`holdsNumeral`), no time or day promise (`timePromise`, `dayPromise` — `policy.ts:1614,1788`), reads as its own locale (`detectLocale`).
- `agent-last-out.test.ts` — a holding row never ends a burst, never answers «did our last message ask».
- `agent-speakers.test.ts` (pure) and `agent-speakers-wire.test.ts` (derived: every holder comparison and every agent `userIds:` site under `agent/` is on one of §4.3's three lists).
- `agent-work-clock.test.ts` — 18:50 → due 09:05 the next working day; a night never counts. LITERAL Tashkent dates (CLAUDE.md: a test's clock is the app's; the 19:00-24:00 UTC window).
- `agent-acts.test.ts` — every registered act has a precheck, an idem key and a default position; `open_code`'s prechecks, pure over fixtures.
- `agent-closing-blocks.test.ts` — block ② is byte-equal to the fact's answer; no address block for air; block ③ only with a phone and a free link fuse.
- `agent-outbox-parts-wire.test.ts` — every `agentOutbox.draftId` read in `src/` is classified first / last / all parts.
- `agent-replay-wire.test.ts` — the script's import fence.

**Integration** (each mints its own chats and users; settings, designations and `agent_action_rights` snapshotted in `beforeAll` and restored — #183, #716; a seeded row is never rewritten, #1682):
- `agent-engine-kernel` — the probe both ways; every CHECK accepts its new values and refuses a stranger; a REAL insert of the wait kind `agent_case` (a refused wait is swallowed with one warning in production).
- `agent-parts` — N rows per approval; part 2 invisible to `dueAgentRow` until part 1 is `sent`; a cancelled part cancels the later ones; the customer's line between two parts kills the rest and nothing is re-sent; turns vs messages in the caps.
- `agent-cases` — the tool writes the case and the holding line; a newer customer line supersedes the DRAFT and not the case; answer → relay; an answer with a figure comes back as a card; a stale answer; the week clock; expiry tells the supervisor.
- `agent-supervisors` — the deputy's ✅ sends; the VED job's requester is the SEAT; a person outside the pair is refused; on a personal account the pair is refused; 📌 refused to the deputy.
- `agent-escalation` — once, after 15 working minutes, never at night; the first press closes the other copy.
- `agent-card-sight` — over every seeded role: no VED figure to `own`, no client price to `none`.
- `agent-inline-press` — talk is pressed in the run; a held price is not; the job and the sweep together press once.
- `agent-replay` — no draft, outbox or notification row appears; the token fuse does not move; the spend line does.
- 1c `agent-open-code` — tap → one client, one deal, the lead won; a second tap → `wonAlready`; a duplicate phone is named and «biriktirish» attaches; avia → no address part; an unnamed city → asked; **a lead reply waiting before the tap still goes** (K25, the critic's claim pinned as false); a fact edited before the send → that part cancelled + a card; a code never delivered → the alarm.
- 1c `agent-seat-mail` — a prixod of a seat-owned client reaches the supervisor **through the event drain** (`ReceiptConfirmed` emitted, `processPendingEvents` run — never a direct call of `queueStaffTelegram`, which would prove the half that already worked); a `notifyStaffTelegram` to the seat is re-addressed too; an agent card is not redirected twice. Unit `seat-mail-wire.test.ts` (derived): every insert into `notifications` under `platform/notifications` passes `readdress`.

**E2E** — `m9zzzh-ai-suhbat.spec.ts` (new; sorts after `m9zzzg-ai-sotuvchi` and BEFORE the specs that already wear the prefix — `m9zzzh-tarkib-ai`, `m9zzzh-yoldagi-yuk`, then `m9zzzi-prixod-*`, `m9zzzj-sotuvchi-yuk` — so whatever it leaves behind is their input, #154): the «Savollar» tab answers a case; the rights select saves; the «Sinov» tab renders at 360 and 1280 in `ru` (`documentElement.clientWidth`, never `innerWidth`); the cleanup is a final TEST (#183).

**Red proofs — by paired string edit, never `git checkout` (#430):**

| Strip | Must go red |
|---|---|
| the joined-text check out of `checkTurn` | the split half of `agent-turn-parts` |
| the per-part `too_long` exception | the equivalence half of `agent-turn-parts` |
| «bir daqiqa» into a holding sentence | `agent-holding-lines` |
| the same-draft set out of `forgivenOut` | `agent-parts` (part 2 cancelled `human_replied`) |
| the holding skip out of `lastAnswerOut` | `agent-cases` (empty burst on the answer's card) |
| `actActor` → `actor` in `landCalc` | `agent-supervisors` (the requester) |
| `holderIsSeat` out of `maySpeakForSeat` | `agent-supervisors` (the personal account) |
| the `trigger <> 'replay'` filter | `agent-replay` (the fuse moved) |
| the card-rang rule asked on a zero hold | `agent-inline-press` |
| the duplicate precheck | `agent-open-code` |
| the air test out of the address block | `agent-closing-blocks` |
| `readdress` out of the event drain (kept in `queueStaffTelegram`) | `agent-seat-mail` (the prixod message is the seat's) |
| a reserved value written early (`kind: 'complaint'` in a 1b file) | `agent-engine-reserved` |

A red proof that stays green is evidence about the fixture (#166): re-anchor it before believing the test.

**Provable only on the live server** (no Telegram and no model key in the build environment): that the model calls `ask_owner` instead of promising; the order and spacing of parts on a real phone; the Chinese address as the supplier reads it; the deputy's phone ringing. He checks: one day on staff phones (three colleagues write as customers), then `docker compose --profile telegram logs tg-listen`, the «Savollar» and «Sinov» tabs, and the morning line.

## 8. Order of work

1. **Start gate**: 1a confirmed live; `git fetch origin main`; re-read §4's references on that tree; judge this plan (four lenses + refuters, contract §5.2); ask him §11.
2. **K** (§4.0) — alone, reviewed, green by itself with the probe forced behind AND ready.
3. **1b packages in worktrees off K** (name K's hash to each agent; 4 CPUs = two agents at a time): P1 «Qismlar», P2 «Savollar», P3 «Rahbar va o'rinbosar», P4 «Darhol», P5 «Sinov». **Ownership of the shared file `decide.ts`**: P1 owns the outbox insert (`:1253-1267`); P3 owns the actor checks (`:960`, `:1421`, `:1186`, `:1370`); P2 and P4 only CALL it. `run.ts`: P2 owns the tool loop and the context, P4 the two lines after `writeDraft`. `outbox-store.ts`/`send-step.ts`: P1 alone.
4. **Merge order** P1 → P3 → P2 → P4 → P5 (P2 needs P1's parts for the holding line and P3's recipients for its card). Review AS MERGED, then review the fixes.
5. **Ritual** (CLAUDE.md): postgres up; fresh `gsr_ci`; migrate, seed once, vitest, `NODE_OPTIONS=--max-old-space-size=3072 pnpm build`, `fuser -k 3000/tcp`, Playwright without re-seeding and without `CI=1`; `pnpm typecheck && pnpm lint` (each gate's own failure marker); the reader corpus before and after.
6. **1b PR → merge → deploy → his confirmation → the dry replay read with him.** Only then 1c: P6 «Kod», then P7 «Pochta» (no migration; `agent_engine` already carries `agent_acts` and `agent_action_rights`).

## 9. Deploy

- **1b**: the ledger grows by one — the count to give him is the journal's length that day. **tg-listen MUST be rebuilt** (`send-step.ts`, `outbox-store.ts`, `queues.ts` change): `docker compose build migrate app` then the telegram profile's build; backup first. End by the count AND `curl -s https://gsrwms.uz/api/version`.
- He must: on ⟨1a⟩'s screen «Kim javob beradi» fill «Rahbar va o'rinbosar» — himself first, his deputy second (until then cards go to the holder, as today); send /start to the staff bot from each person's own Telegram once (new button rows); read §6.3's sentences and approve them.
- Scripts through `migrate`: `scripts/agent-replay.ts --days 14 --max-turns 150` — tell him first it is a paid run (about 150 fast-tier turns; the 20:00 line will show it).
- **First morning**: a held reply names its reason; an open question is a «❓» card; a customer who got «…javobini shu yerga yozaman» is listed under «Savollar».
- **Rollback 1b**: `/agent off` FIRST (it cancels every queued row) — the old listener never releases a `parked` part (it selects `agent` rows only), so a half-sent turn would stay half-sent. Then the old images; the migration stays (it only relaxed).
- **1c**: no migration — checked by `/api/version` alone. He sets «Kod ochish: So'rab» on the page; until then rule 12 is today's. Rollback = set it back to «Faqat odam». (The four positions are spelled the same on every screen of every stage: «O'zi» · «Nazoratda» · «So'rab» · «Faqat odam» — `STAGE-3B.md` §6.5; in 1c the select offers only the last two for this row.)

## 10. Risks, traps, and what is STATED-not-built

- **Account risk rises**: 2-3 messages a turn and a system sentence sent by itself are more messages from a user session. Bounded by the same caps (hour, day, per-chat turns) and by `holdingPerChatPerDay`; tell him in the deploy message.
- **Identical text to many chats**: holding lines and address blocks are the same bytes by construction — the opposite of what `fingerprint` exists for. Mitigation: three rotating wordings per language, the code line differs per customer, the daily number of codes. Stated to him as a risk, not solved.
- **A split must never launder a block** — the joined check is the floor; if the equivalence test is ever «fixed» by loosening it, stop.
- **The burst**: every reader of «our last out» must skip holding rows — one missed reader re-creates the empty card.
- **Presser ≠ actor** (P3): the single most likely silent defect; its test asserts the VED job's requester.
- **Stats**: `agentStats` (`stats.ts:34-38,111`) keeps a machine press out of the rate by its verdict row (`agent_auto_verdicts.state = 'pressed'`). A system-born draft (holding, closing) has NO verdict row and the holder as `decided_by`, so it would count as «he sent it unchanged» — mark it (`policy.system`) and keep it out, or the rate grades the machine.
- **Raw-SQL footguns**: a `Date` into a `sql` fragment (#156), a JS array (use `sql.join`), `${table.col}` in a correlated subquery (#128), a lock over a JOIN (#1585) — every one is live in `outbox-store.ts`'s style of statement.
- **A model run is never awaited on the bot's poller** (#706): the tap enqueues; `decideAct` itself calls no model.
- **System drafts and the after-sent job**: `AFTER_SENT_STAGE_KINDS` (`after-sent.ts:42`) admits every `reply`, so a holding line's `sent` asks the stage step — harmless on a won lead (`moveLeadByMachine` answers `current_closed`), but decide on purpose whether a holding line is «AI birinchi javob berdi»; the offer step must read no quote off a system draft (`quotedBy`, `after-sent.ts:53`).
- **i18n**: every new key in `ru`, `uz`, `zh-CN`, `en`, or the page throws at render. Bot words stay Uzbek like the existing cards.
- **Stated, not built**: a claim older than the recent window is asked again (tools take recent refs only) · the `timer` trigger has no consumer until stage 8 (1b's clocks are sweep steps) · colleagues other than the pair are not asked (3a) · the model's own words in the closing turn (stage 5, when the act runs inside the run) · code alone, its daily count and the two-week «shown to him» list (5) · the ownership setting's other two values and its screen (5) · fa/zh holding lines until he approves the glossed text · a hidden-number client cannot link the cabinet until a phone is on the card · the daily 👍/👎 sample (9 a) is ⟨1a⟩'s (`agent_samples`), nothing of it is built or widened here · the replay reads today's tariff and cargo, not that day's.
- UNVERIFIED: the database name of the inline UNIQUE on `agent_outbox.draft_id` (no database was up for the reference check; Postgres names an unnamed column UNIQUE `<table>_<column>_key`); everything ⟨1a⟩. Looked for and NOT found at this HEAD: a schema-vs-migration drift test for `schema/agent.ts` (the only schema test under `tests/unit` is `ai-schema-card.test.ts`, about the analyst's GRANT list) — the integration suite running against the migrated database is the only check that the declaration and the SQL agree.

## 11. Questions for the owner (Uzbek, numbered, ⭐ = built on «sen aytgandek»)

1. **15 daqiqalik soat qaysi kunlari yuradi?** (a) ⭐ dushanba-shanba 09:00-19:00, yakshanba kuni yurmaydi · (b) har kuni 09:00-19:00.
2. **Mijozga ketadigan kutish gapi** — §6.3 dagi matn ma'qulmi? (a) ⭐ ha, shu · (b) o'zim yozib beraman. (Vaqt aytilmaydi: «bir daqiqa», «tez orada» degan gap va'da hisoblanadi.)
3. **Bir javobda eng ko'pi nechta xabar?** (a) ⭐ 3 ta · (b) 2 ta · (c) hozircha 1 ta. ⚠ Xabar soni oshsa, akkaunt xavfi ham oshadi.
4. **Sinov (eski suhbatlarni qayta o'ynatish)** — necha kunlik? (a) ⭐ oxirgi 14 kun, 150 tagacha javob (pullik: taxminan 150 ta AI so'rovi) · (b) 7 kun, 60 ta · (c) kerak emas.
5. **Kod xabarida kompaniya boti havolasi ham bo'lsinmi?** (a) ⭐ ha, mijoz kartasida telefon bo'lsa · (b) yo'q, faqat kod va manzil.
6. **Raqami yashirin mijozga kod ochilsinmi (1c, siz tugmani bosasiz)?** (a) ⭐ ha, kartada «📵» deb ko'rsatiladi · (b) yo'q — avval telefonini so'rasin.
7. **O'rinbosar AI raqamidan narx yozilgan javobni ham tasdiqlay oladimi?** (a) ⭐ ha, lekin u kartada faqat o'z huquqi ko'rsatadigan narxni ko'radi (VED narxi va mijoz narxi birga — faqat sizda) · (b) narxli javoblar faqat sizga.

## Verified references

Checked at HEAD `bf37150c` (the plan was read at `bdd81f51`; only `docs/` differs between the two). About 190
things this file names as EXISTING were grepped and their lines opened: ~125 `file:line` references (`agent/`,
`crm/service.ts`, `client-cabinet/service.ts`, `staff/`, `platform/notifications`, `platform/telegram`,
`platform/settings`, `reports/ai-spend.ts`, `calc/upsale-scope.ts`), the 14 constraints and indexes of §3.2 against
0138 / 0144 / 0145 / 0148 / 0149, the `AGENT_OPS` letters, 17 test files and fences, the contract's sections, 9
DECISIONS numbers. Every NEW name of §3-§4 (five tables, five settings keys, two queues, the files marked new) was
grepped free at this HEAD. No model identifier and no literal number for the new migration is in this file; the one
person's name it carried (a quote of today's prompt rule 12) was replaced. Everything not listed below stood as written.

Corrections made (old → new):

1. Header: re-checked at `bf37150c`; the contract `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` this file leans on now exists (§3, §4, §5 as cited).
2. §3.2: «`agent_drafts_category_check` … 7 labels / 7 kinds (0149)» → the label CHECK is 0138:165 and was never re-made; only `agent_auto_config_categories_check` was (0145, 0148, 0149:22).
3. §3.2: `telegram_chat_waits_kind_check` «last re-made 0148 (after 0141, 0146)» → born 0130, re-made 0138, 0141, 0146, 0148:98.
4. §3.2 and §10 — **a claim rewritten**: «the daily 👍/👎 sample is a ledger of its own in the stage `COVERAGE.md` gives it» / «stated, not built» → it is ⟨1a⟩'s `agent_samples` (`STAGE-0-1A.md` §3.1, §4.5); `qurish/COVERAGE.md` is not in the tree at this HEAD.
5. K (`AGENT_OPS`): the six letters are unused, but `q` is pinned UNPARSED by two tests (`agent-fences.test.ts:233`, `agent-owner-answer.test.ts:439`) and by the constant's own comment — the step now says to rewrite both assertions; `PRESS_REPEAT`'s agent line is `:482`; the derived button fence is `agent-fences.test.ts:300-308`.
6. P1 — **two lists completed from the code** (the step leaned on them being whole): the doors that cancel a waiting outbox row (added `decide.ts:852`, `config.ts:411`, `:732`, `calc-loop.ts:259`, `:965`; line numbers for the rest), and the readers of the outbox by draft — a new table row for the nine JOINs that today return one row per draft and after 1b return one per PART (`decide.ts:410`, `web-page.ts:232/490/668/675`, `policy-input.ts:166`, `calc-loop.ts:811`, `calc-price.ts:162`, `after-sent.ts:289`), with the fence told to read raw SQL too. `auto-send.ts afterPressOf` → the read is `machinePressedReply` `:1049`.
7. P2: «the corpus's 183 avia rows» → 183 dangerous + 94 ordinary; the `AgentCase` type also needs `chatCardsWhere` (fence `agent-fences.test.ts:157`); `mutes.ts:332-341` → `:331-342`, `night.ts:30-33` → `:28-39`.
8. P3 recipients: `auto-send.ts:1268` is the one `userIds: [` site under `agent/` the list did not carry (the step-down alarm) — named as unchanged.
9. P3 — «compared by hand in fifteen places» → nineteen lines; `lessons.ts:365` and `:381` (the lesson's save) were missing from the supervisor-only group; ✍️'s second check is `decide.ts:1498`.
10. P3: `holderActor` (`auto-send.ts:734`) is module-private — «export it»; `landCalc`'s `collectedBy` is `decide.ts:617`.
11. P6: the quote of prompt rule 12 no longer carries the owner's name (`prompt.ts:85`); `wonOwnerFor` marked NEW; the token's shape rule (`crm/service.ts:1089`) and the real seller expression (`:1129`) written out.
12. §7: `m9zzzh-ai-suhbat` — the prefix is already worn by two specs, and `m9zzzi-*`, `m9zzzj-*` follow: its leftovers are their input.
13. §10: the schema-drift question is answered «none found»; the inline UNIQUE's name stays UNVERIFIED (no database was up).
14. Cross-plan, two cells: §3.2's `ai_calc_passes` row now points at `STAGE-2.md` §3 (readings bill to their own table, the reserved trigger `reading` gets no writer); P4 «Darhol» names what `STAGE-0-1A.md` §4.2 already plans (`pressNow` after `writeDraft`), so the two plans do not build the inline press twice under two signatures.

Not resolved here: everything marked ⟨1a⟩ (not built); the database name of the `agent_outbox.draft_id` UNIQUE.

## Conformance

Checked against design §11, the contract's §4 and the other six plans (`qurish/COVERAGE.md` holds the trace).
No answer of his was contradicted. What was changed, and why:

1. **1c P7 «Pochta» — a piece moved here from stage 5 (the one real gap).** The step re-addressed the seat's mail
   inside `queueStaffTelegram` only. Read against the code (`platform/notifications/service.ts:342`, `:1003`,
   `:1019`) the EVENT DRAIN writes its own rows and never passes through that function — and «Prixod keldi»
   (`ReceiptConfirmed`) is a drain message. So 1c, the stage that first makes the seat a client's seller, would have
   shipped with the prixod message going to a mailbox nobody reads, while §1 of this plan promised the opposite and
   stage 5 planned the fix. The home `platform/notifications/seat-mail.ts` (`readdress`) is now built in 1c and
   called by BOTH writers; stage 5 keeps only what is new there (the buttons working for the pair). Its test must
   drive the drain, and a red proof was added.
2. **§3.1 / §3.2 — CHECKs widened ONCE.** `agent_cases.kind` is born with 3a's `complaint` and `handover`;
   `agent_runs_trigger_check` reserves stage 7's `channel`; `tasks_origin_check` reserves 3a's `agent`. Three later
   re-makes disappear (`STAGE-3A.md` §3.1, `STAGE-7-9.md` §A3 now say «verify, do not re-make»). The reserved-values
   test names every one, so nothing can write a value before its stage.
3. **§3.1 — one rights table.** `agent_action_rights` was called «the seed of 3b's page»; it IS the table of every
   stage. The cell now says what a key is (the act's own), that a stored key is never renamed, and what `limits`
   may hold. 1c's «select» became a small LIST («Huquqlar») so 2b, 3a and 4 add a row, not a screen.
4. **Words.** «nazoratchi» → «rahbar» / «Rahbar va o'rinbosar» (§1, §4.3, §9 — the key is `supervisor`);
   «Faqat o'zim» → «Faqat odam» (§9): the four positions are spelled the same in every plan.
5. **§3.2 — a stale sentence**: «`COVERAGE.md` … is not in the tree» → it is; row 9 traces the sample.

Confirmed, unchanged: acts before speech (`ask_owner` runs inside the run; the code opens before the closing turn
is built; `calc_submit` lands before its reply is queued); no word rule is loosened (a split can only ADD blocks);
law 4 on every card (`cardSightFor`, case and act cards money-free by construction); the avia address is never
built (17 c) and the AI asks the city, never picks; the seat stays the seller of an AI-won client (`seller`, 31 c);
no dollar ceiling, no Telegram Business, no `carrier` column; one migration with its probe, numbered «next after
the journal's tail», inserting no row and flipping no stored choice.
