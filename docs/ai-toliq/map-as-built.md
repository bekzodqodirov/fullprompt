# AI sotuvchi — the map AS BUILT (read 2026-11-19, tree at ledger 151)

Read-only research. Paths are relative to `/home/user/fullprompt`; `agent/` = `src/modules/wms/agent/`.
Where a doc and the code disagree the code is quoted. Production facts are quoted from DECISIONS (#1789, #1800),
never re-measured here.

**The one-paragraph answer to «nega salomlashadigan bot?».** The product is a *draft writer with a machine finger on
the ✅*, not an agent. One customer burst → one model run (≤ 6 tool rounds, 1 500 output tokens each) → ONE text
message ≤ 700 chars → a deterministic policy (24 block/warning codes) → a card to the owner → optionally an auto-press
that must pass a 47-code AND-gate. The model is told, in its first sentence, that it writes a *qoralama* Bekzod will
read (`agent/prompt.ts:71`) and to under-rate its confidence («Oshirib yuborma: shubha bo'lsa past qo'y»,
`agent/tools.ts:224`); the gate then demands ≥ 0.80 of that same number. Anything with money, media, an action, a
question to him, a warning, a note, an unclear language, or a second auto reply in a row is refused. What is left after
47 refusals is a greeting and a qualifying question — which is exactly what he saw.

---

## 1. THE RUN

### 1.1 Triggers (who starts a run)

| Trigger (`agent_runs.trigger`) | Started by | Entry | Key |
|---|---|---|---|
| `inbound` | the listener, on a LIVE (or pulled) inbound message stored on a client/lead of the agent owner's account — `shouldStartAgentRun` (`agent/queues.ts:161`), enqueued `agent.inbound` with `startAfter` 12 s, `retryLimit` 0 (`scripts/tg-listen.ts:670-696`) | `handleInbound` (`agent/run.ts:447`) | UNIQUE (anchor, attempt): 0 first look, 1 sweep retry, 50+ his press «redraft», 100+ an edit of the anchor |
| `inbound` (origin `sweep`) | minute sweep's deploy-gap pass: newest inbound ≤ 30 min with no run (`agent/jobs.ts` step 3) | same | same |
| `hand_back` | the VED pressed «Qaytarish» on a job the AI submitted → `agent.hand_back` | `handleHandBack` (`agent/calc-loop.ts:343`) → `runOwnerTriggered` | `source_key` |
| `calc_answer` | the VED pressed «Готово»/sealed a job the AI submitted and whose submitting reply went → `agent.calc_answer` | `handleCalcAnswer` (`calc-loop.ts:519`) → `runOwnerTriggered` | `calc:<requestId>:<versionId|answer>` |
| `owner_edit` | his «✍️ Savolga javob» text (`agent.owner_answer`), or a confirmed «📝 Tuzatish» lesson on a pending card | `owner-answer-job.ts`, `lesson-job.ts` → `runOwnerTriggered` (`run.ts:1809`) | `answer:<draft>:<msg>` / `lesson:<id>` |
| `style` | `scripts/agent-style.ts` (manual, ANALYST_MODEL) | — | — |

**There is no trigger that is not a reaction**: no timer, no follow-up, no «customer went quiet», no «cargo arrived», no
«debt is due». Every owner-triggered run still needs `ctx.anchor` = the customer's newest inbound, ≤ 24 h old (≤ 7 days
for `calc_answer`) — `run.ts:1853-1856` → `skipped: no_fresh_inbound`.

Not runs, but listener events the run depends on: OUT row with no `agent_outbox` row → `agent.human_reply`
(retires the live draft as `taken_over`); `UpdateUserTyping` → `stampPeerTyping`; edit of the newest inbound →
re-enqueue (origin `edit`); delete → `tg_message_flags.deleted_at`; Business auto-reply → `auto_sent`.

### 1.2 Order inside `handleInbound` (each step's refusal is the cheap one)

1. `agentTablesReady`, `agentRunning(config)` and `config.ownerUserId === job.managerUserId`, `aiConfigured()`.
2. `loadContext`; stand down unless the anchor is still the newest inbound (`stood_down: not_newest`).
3. Peer typing within 6 s and anchor younger than 90 s → reschedule +8 s (`typingExtendMs`, `typingWaitCapMs`).
4. `draftWorthy(burst, lastOutAsked)` (`agent/worthy.ts:91`) — BEFORE anything is reserved:
   `empty` / `media_only` / `closing` → **skipped, no card at all**; `voice_only` / `pashto` / `bot_question` →
   an `AgentNotice` to the owner («o'zingiz javob bering»), no draft.
5. Greeting-only burst younger than 60 s → reschedule (`greetingWaitMs`).
6. `eligibleForRun` (§3 table, layer E).
7. `reserve` under `pg_advisory_xact_lock('agent_run_cap')`: `capReached` (`agent/today.ts:74`) —
   `daily_draft_cap` (150), `chat_runs` (12 per chat per Tashkent day), `daily_token_cap` (3 000 000). Fails closed;
   the first cap of the day sends ONE `AgentCapReached` notice.
8. `runLoop` → `withRailRule` → `withAviaRule` → (no reply and no question → `no_reply`) → `memoryFor` → `policyFor`
   → `withAviaGuard` → `validateActions` → `settleCalcPrices` → notes → `autoPlanFor` → `writeDraft` (draft + auto
   verdict + card, one tx) → remember the chat's locale.

### 1.3 What one run reads

| Thing | Source | Limit |
|---|---|---|
| **history** (what the MODEL reads) | `chatMessages` → `chatWindows` (`agent/context.ts:432-500`), THIS chat only, deleted rows never | ≤ 100 messages, ≤ 24 000 chars (`historyMessages`, `historyTotalChars`); each body clipped at 1 000 chars |
| **recent** = `ctx.messages` (what EVERY RULE counts: measures, number sources, road/rail/avia guards, checklist, burst, script) | tail of history, same objects | ≤ 30 messages, ≤ 8 000 chars |
| the older part | printed under `OLDER_CHAT_HEADING` («faqat tushunish uchun …») | no code guard reads it; only the prompt's words keep it from steering |
| **media** | `mediaOf(contentType, fileName)` → `photo / voice / audio / document / other`; printed as `[rasm]`, `[ovozli xabar (eshitilmagan)]`, `[audio (eshitilmagan)]`, `[fayl: <name ≤ 80 chars>]`, `[media]` (`agent/prompt.ts:134-140, 177-184`) | **the bytes are never read**: no image block, no PDF block, no transcription anywhere in `agent/` |
| **identity** | `chatIdentity` (`context.ts:279`): client codes incl. phone siblings, customer name, the customer's own manager's name, `cargoAllowed` (phone on the card / peer-index hash / linked cabinet — never a hand bind), or the lead + its stage name and kind (`leadStageWords`) | the model passes no id; tools read the server's identity |
| per-chat state | `agent_conversations`: `locale`, `human_until`, `muted_at`, `peer_typing_at` | — |
| measure refs | `measureCandidates` = `parseManualFacts` over recent inbound → `w1…`, `v1…`; `cargo_volume` adds `d1…` | the estimate tools take REFS, never numbers |
| open calculations | `chatCalcChains(…, 5)` → section + `open / answered / returned` (words, never the amount) | 5 chains |
| last quote | `lastQuoteFor`: newest APPROVED draft of the last 7 days whose memory names `quotedRoad` | 1 |
| knowledge (cached head) | `generalFacts(60)` — every approved general `kb_facts` row, oldest first | 60 facts |
| knowledge (tool) | `kbSearch(scope, q, 8)` — general + this client's (+ siblings, only when `cargoAllowed`) + this lead's; `word_similarity > 0.2` | 8 hits |
| lessons (cached head) | `promptLessons()` → `fitLessons` (`agent/lesson-rules.ts`) newest first | ≤ 40 lessons, ≤ 6 000 chars, each ≤ 500 |
| style guide (cached head) | `agent_config.style_guide`, only when `style_approved_at` is set | ≤ 1 500 chars |
| rules | 16 numbered rules in `stableHead` (`agent/prompt.ts:71-95`) | static |

**Not read by any run**: other chats (same customer's chat with a colleague, any other customer), CRM lenta/notes,
deal lines, deal quotes, past offers, payments ledger (only via `own_balance` text), call recordings, the customer's
Telegram profile, the company's tariff except through the two estimate tools, the VED's answer amount (only through
`calc_price`), warehouse stock in general, truck schedules except inside `cargo_status`' ETA window.

### 1.4 Model, calls, caps

- **Model**: `STAFF_MODEL = 'the fast-tier model'` (`src/modules/platform/ai/model.ts:91`) for every run; `ANALYST_MODEL`
  (`the heavy-tier model`) only for the style proposal script. No extended thinking, no effort setting.
- **Calls per run**: 1…6 (`AGENT_LIMITS.maxToolRounds = 6`); the loop ends on the terminal strict tool `compose_reply`
  (`run.ts:253-297`). `maxTokens: 1_500` per call. Wall clock `LOOP_WALL_MS = 90_000`; SDK call timeout 60 s,
  `maxRetries: 1` (`model.ts:160-167`). Failures: `wall_clock`, `max_tokens`, `no_compose`, `too_many_rounds` →
  `outcome='error'`, the sweep retries ONCE (attempt 1); a run that died with its process is marked `interrupted`
  after `INTERRUPTED_RUN_MS` (5 min) and retried the same way.
- **Caching**: the stable head (rules + lessons + style + general facts) behind one breakpoint; the chat block behind a
  second (`cache: true`, `run.ts:232`) — rounds 2-6 re-read it at 0.1×. The per-run tail (day + canary) is uncached.
- **Caps** (`agent_config`, editable on `/suhbatlar/ai` → Sozlamalar, `setAgentNumbers`): `daily_draft_cap` 150
  (0…1 000), `daily_token_cap` 3 000 000 (counted as input + output + cache-WRITE tokens; cache reads are free of it),
  `human_pause_min` 120; plus the constants `runsPerChatPerDay` 12 and `maxToolRounds` 6. Owner-triggered runs obey the
  token cap only.
- **Cost estimate in the doc** (§18.1): ≈ $5-7 a day at 150 runs. List prices in `MODEL_USD_PER_MTOK`: $2 in / $10 out
  / $0.2 cache read / $2.5 cache write per MTok.

### 1.5 What a run can output

`compose_reply` (strict schema, `agent/tools.ts:217-249`): `reply_needed`, `reply_text`, `language`
(uz|uz_cyrl|ru|en|fa|zh), `gloss_uz`, `category` (greeting|status|faq|qualification|price|complaint|other),
`confidence` 0-1, `needs_owner`, `owner_question`, `next_step` (qualify|quote|calc|address|close|wait),
`actions[]`, `used_fact_ids`, `cited_message_refs`.

- **One text message.** `agent_outbox.body` is text; the adapter invokes only `messages.GetHistory`, `ReadHistory`,
  `SetTyping`, `MarkDialogUnread`, `SendMessage` (`agent/gramjs-adapter.ts:101-151`). No photo, file, location,
  voice, edit, delete, reaction, forward, second message.
- **Three actions**, run only after the approval (`runDraftActions`, `agent/decide.ts:1370`):
  `calc_submit` (lands a VED job through `landIntake`; only with a COMPLETE checklist of the same section from this
  run and no open linked job — `validateActions`, `run.ts:1654`), `set_followup` (writes a DATE on the lead/client via
  crm `setFollowUp` — it puts the card on a seller's call list; **the AI itself never acts on that date**), `mute`
  (switches the AI off in this chat).
- **A question to the owner** (`needs_owner` + `owner_question`) — a card with «✍️ Savolga javob» (unless forced).
- **`next_step` is stored and read by nobody** (grep: written in `drafts.ts:343,472`, `calc-loop.ts:1045`; no reader).
- Kinds of draft row: `reply`, `price` (his typed 💵, rendered by code — `price-reply.ts`), `hand_back`.

### 1.6 Where cost is recorded

`agent_runs`: `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `tool_calls`
(name, ok, text ≤ 500, estimate), `duration_ms`, `outcome` (reserved|draft|no_reply|notice|stood_down|refused|capped|
error), `error` — written in the run's `finally` (`run.ts:588-594`). Read by `dayRunCounts` (the caps and the page's
«today»), by `wms/reports/ai-spend.ts` (the 20:00 summary's «AI» line, dollars via `approxMicroUsd`), and by
`scripts/agent-calibration.ts`. Runs that never reached the model (refused/notice/capped) write a zero-token row.

---

## 2. THE TOOLSET (closed literal list, `agent/tools.ts` `TOOL_SPECS`; fenced by the leak-11 test)

| Tool | Input | What it does / reads | Limits and refusals |
|---|---|---|---|
| `cargo_status` | none | cabinet `cargoOverview` per code (the chat's client + phone siblings) rendered by `cargoMessages(…, 'uz')` — where each lot stands, cartons, kg, m³, ETA window | refused when the chat has no client («hali mijoz kodiga bog'lanmagan») or `!cargoAllowed` («raqami mijoz kartasida yo'q — Bekzodning o'zi aytadi»). Its figures are non-money sources. The ONLY tool that backs a `status` reply (`STATUS_TOOL`) |
| `own_balance` | none | `debtSummary` per code → `balanceMessages` | same identity refusals. Money source `role: 'balance'`. **Calling it makes the reply `money` for the auto gate, always** |
| `kb_search` | `query` | `kbSearch` (8 hits, general + this chat's own) | miss → «Bilimlarda topilmadi — o'zingdan aytma, needs_owner». A fact is never a money source; its phones/urls/Han become quotable |
| `cargo_volume` | `count, length_cm, width_cm, height_cm` | n×l×w×h → m³, mints ref `dN` | every input must be a figure the customer wrote in the RECENT window (`stated`) |
| `yolkira_estimate` | `weight_ref, volume_ref` | `truckEstimate` (`agent/estimate.ts`): the website's China→Tashkent truck table (`SITE_TARIFF`, valid through **2026-12-31**), cross-checked against `/admin/tarif` zone `cn`; after that date `freightFor(...).listUsd` and 15-25 days | refuses: no ref; stale ref (`staleRefs`); `below_minimum` (< 1 m³ AND < 100 kg — no figure); origin `western` (Kashgar/Urumqi/Horgos) or `unknown`; `size` (> 100 m³, > 20 t, density < 1); `min_total` (< $50); `tariff_mismatch`; `tariff_refused`. A refusal says «hisoblatishga yuborish kerak» |
| `avia_estimate` | `weight_ref` | kg × `agent_config.avia_usd_per_kg` (17), 2-5 days | rate NULL → no quote, needs_owner; min 1 kg; no ceiling; volume never enters. Never states an address |
| `calc_checklist` | `section` ('' or yolkira/rastamojka/podklyuch), `goods[]{name, quantity, unit, weight_kg}` | `missingFields` over facts parsed from recent inbound; returns «To'liq … calc_submit taklif qil» or the missing fields as «•» lines | `section=''` → «so'ra, o'zing tanlama»; every goods figure must be `stated`; truck sections below the minimum → refused; with `calcArmed` each line is coded (`codeRows`) and the book's law units are asked. Never asks the certificate |
| `calc_price` | none | `calcPriceFor` (`agent/calc-price.ts`): the CLIENT price of this chat's answered VED chains = VED figure + his markup, ⌈whole $⌉ | offered only when `calcPricingFor(ctx)` is true (`toolSpecsFor`). 11 refusals (`CALC_PRICE_REFUSALS`): `markup_unreadable, not_linked, owner_words, owner_priced, person_offer, card_moved, not_standing, expired, not_usd, discounted, answer_noted` |
| `compose_reply` | see §1.5 | terminal | strict |

**Money leaves a tool three ways only**: balance, truck/avia estimate, VED price. Everything else a reply says in
money is `number_unsourced`. **Tools the model does NOT have**: any search of other clients, any CRM read/write (lead
fields, notes, tasks), client-code minting, a stage move, a payment read beyond the balance text, a tariff read
(only a priced answer), TNVED/customs anything (the «AI VED» pass is a different module, run by the landing), a file or
photo reader, a «ask a colleague» channel, a scheduler, a second-message sender.

---

## 3. EVERY REASON A REPLY WAITS FOR THE OWNER (or never gets written)

Class: **A** = money / factual-safety rule · **B** = Telegram-ban or account protection · **C** = conservative default
that could be an owner setting, or would be unnecessary if the AI had better senses/judgement.
«Layer»: **W** worthiness (no draft), **E** eligibility (no draft), **CAP**, **P-block** (policy block: the ✅ is
removed even for HIM — he must ✏️), **P-warn** (✅ stays for him, the machine refuses), **Q** forced owner question,
**N** card note (machine refuses `notes`), **G** auto-gate (`AUTO_REFUSAL_WORDS`, `agent/auto-gate.ts`), **PRESS**
(machine press / ✅ refusal, `DecideRefusal`), **SEND** (send step, after approval).

### 3.1 No draft is written at all

| Code | Plain meaning | Layer | Class | What would make it unnecessary (C) |
|---|---|---|---|---|
| `media_only` | the burst is only a photo/file/sticker with no text → silently skipped, **no card, no notice** | W `draftWorthy` | C | the AI reading images/PDF/Excel (model input blocks; the bytes are already stored as `attachments`) |
| `voice_only` | only voice notes → notice «AI eshitmaydi» | W | C | speech-to-text before the run |
| `closing` | «ok / rahmat / 👍» after a message of ours that asked nothing | W | C (sound default) | — |
| `empty` | nothing in the burst | W | — | — |
| `pashto` | Pashto letters → notice, no draft | W | C | owner decision (⭐ Q3); the model can write Pashto |
| `bot_question` | «botmisiz?» → notice, no draft; after an auto reply also chat-off 30 d | W | A/B (honesty: `ai_denial` is a block) | an owner decision on the persona («AI yordamchiman» said openly, §18.7 Q6 b/c) |
| `agent_off`, `session_not_confirmed` | agent is off / «eski serverda sessiya yo'q» not confirmed | E | B | — |
| `listener_behind` | no pump stamp within 2 min (`pumpFreshMs`) | E | B (it could not be sent) | — |
| `account_paused` | Telegram restricted the account | E | B | — |
| `not_private_user` | group / channel / bot | E | B | — |
| `no_owner` | chat bound to neither a client nor a lead (on a non-work number: a stranger card waits for his 🆕/👤/🚫) | E | C | mark the number «Ish raqami» (then the listener opens a lead by itself, incl. hidden numbers — `phonelessLeadForChat`); or let the AI open the lead |
| `excluded`, `muted` | tray «Shaxsiy» / AI muted in the chat | E | B/A | — |
| `staff_peer` | the peer's phone is a staff member's | E | A (leak-1) | — |
| `human_active` | a person's own message in the chat within `human_pause_min` (120), a queued CRM reply, or 🙋 within 24 h | E | C (setting exists: 1…10 080 min) | on a dedicated AI seat nobody types by hand; keep only 🙋 |
| `not_newest` | a newer inbound exists (debounce) | E | B | — |
| `too_old` | anchor older than 24 h (7 d for a VED answer) | E | B (`anchorMaxAgeMs`) | owner decision for clients who wrote first ever; today a 25-hour-old question is never answered by the AI |
| `auto_sent` | the anchor is the customer's own auto-reply | E | B | — |
| `echo` | inbound < 5 s after our message (robot ↔ robot) | E | B | — |
| `repeat` | the anchor repeats one of the peer's previous 3 messages verbatim | E | B/C | better judgement (an impatient customer repeating «narxi qancha?» gets silence) |
| `daily_draft_cap` | 150 inbound runs today | CAP | C (setting) | raise it |
| `chat_runs` | 12 runs in this chat today | CAP | C (constant `runsPerChatPerDay`) | make it a setting; a real negotiation is > 12 turns |
| `daily_token_cap` | 3 000 000 tokens today | CAP | C (setting) | raise it |
| `wall_clock`, `max_tokens`, `no_compose`, `too_many_rounds` | the loop failed (90 s / 1 500 tokens / 6 rounds) → one sweep retry, else nothing | run | C | a bigger budget per turn |
| `no_reply` | the model said `reply_needed=false` and asked nothing | run | — | — |

### 3.2 Policy blocks — `checkAgentReply` (`agent/policy.ts:2769`). The ✅ is REMOVED for him too.

| Code (rule) | Plain meaning | Class | What would make it unnecessary (C) |
|---|---|---|---|
| `empty` (G4) | no text | — | — |
| `too_long` (G4) | > 700 chars (`maxReplyChars`) | B/C | let a long answer go as 2-3 messages |
| `wrong_script` (G5) | reply's dominant script ≠ the customer's last-5 script, or ≠ its own `language` | C | trust the model's language sense; today a Russian customer who once pasted Latin blocks |
| `gloss_missing` (G5) | fa/zh reply without an Uzbek gloss he can read | C (exists for HIS review) | no human review → no gloss needed |
| `number_unsourced` (G1) | a figure in the reply no tool / customer line / kb fact / company rule vouches for | **A** | — (this is the one rule a money agent must keep) |
| `number_unverifiable` (G1) | a numeral no reader can read (spelled, Chinese, «bir necha kunda») | A | — |
| `promise` (G2) | 8 categories (`PROMISE_CATEGORIES`): `discount`, `guarantee`, `credit_release`, `refund`, `free_extras`, `dispatch_promise`, `customs_included`, `no_duty` | A (but `discount` and `dispatch_promise` are where a seller sells) | owner-set negotiation room (a floor/percent the AI may give); real departure dates from the truck board |
| `other_client_code` (G6) | names a code that is in the book and not this chat's | A | — |
| `system_code` (G6) | batch/box/crate/receipt/deal code shapes | A | — |
| `foreign_phone` (G6) | a phone not carried by a fact the run read | A | — |
| `staff_name` (G6, full name) | a colleague's full name (not the customer's own manager) | A | — |
| `avia_address` (G6) | the chat's road is avia and the reply states one of our China receiving addresses | A (his fourth set «2»: the flight's address is his) | him typing the avia receiving address into Bilimlar |
| `canary`, `ai_denial`, `mention`, `url` (G6) | prompt leak / «men bot emasman» / @mention / a link no fact carries | A/B | — |
| `map_unasked` (G10) | the Tashkent map link when «qayerda/manzil» was not asked | C | — |
| `fingerprint` (G10) | same text (`textFingerprint`: case, digits, spacing folded, the customer's names/codes cut) to > 3 other peers in 24 h, and the reply is > 160 chars or carries a figure/phone/link | B | varied wording; today an identically worded warehouse-address reply to a 5th customer in a day BLOCKS (an address carries phones and figures, so it never falls to the warning) |
| `url_cap` (G10) | a link already sent to this chat in 7 days, or 10 links today | B | — |
| `estimate_unhedged` (G11) | a tool price without «taxminan» in its own clause, or without the exact «boj va QQS alohida» sentence | A | — |
| `warehouse_condition` (G11) | a price from our China warehouses without both dictated sentences | A | — |

### 3.3 Policy warnings, forced questions, card notes — his ✅ stays, the machine never presses

| Code | Plain meaning | Layer | Class | What would make it unnecessary |
|---|---|---|---|---|
| `questions` | more than one «?» | P-warn → G `warnings` | C | drop it for the machine: «Qanday yuk? Necha kub?» is the commonest opener and can never go by itself |
| `fingerprint` (short) | same short text to > 3 peers | P-warn | B | — |
| `avia_maybe` | avia was spoken of anywhere in the window and the reply gives a China address | P-warn | A | the avia address in Bilimlar |
| `staff_name` (one word) | one word of a colleague's name | P-warn | A/C | — |
| rail (`withRailRule`, `RAIL_OWNER_QUESTION`) | burst mentions rail → `needs_owner`, every machine money figure dropped (`memory.rail`) | Q | A (his «Temir yo'l mendan so'rasin») | a rail tariff in settings |
| avia address (`withAviaRule` / `withAviaGuard`) | a quoted flight (price act OFF: every one; ON: only when the address / hand-over is spoken of) → `needs_owner` «Avia: N kg … manzilni bering» | Q | A | the address in Bilimlar |
| model's own `needs_owner` | rules 12 (GS code), 13 (complaint, anger, money demand, «menejer kerak»), 14 (does not know), kb miss, tool failure, avia rate unset | Q | A for 13; **C** for 14 | a wider knowledge base; today 14 seeded facts (`seed-kb.ts`) are the whole company knowledge |
| late note (`lateNote`) | the card was written > 3 min after the customer's line (`LATE_CARD_MS`) | N | C | pure information for him — it should not refuse a machine press |
| dropped action notes (`validateActions`) | «ma'lumot to'liq emas», «ochiq hisoblatish bor», below minimum, bad follow-up date | N | A | — |
| `railNote`, tariff mismatch | rail figure dropped; site ≠ /admin/tarif | N | A | — |
| `CALC_PRICE_UNSAID`, `CALC_PRICE_MANY`, `ANSWER_STILL_HIS` | VED-answer reply stated no tool price / several jobs' prices / his ✍️ answer hit a forced rule | N | A | — |
| calc card notes | «14 kun ichida … hisoblatish bor», a customer file not stored | N | A | — |

### 3.4 The auto-gate — all 47 codes of `AUTO_REFUSALS` (`agent/auto-gate.ts:37-91`), every one collected

| Code | His words (`AUTO_REFUSAL_WORDS`) | Class | What would make it unnecessary (C) |
|---|---|---|---|
| `not_armed` | o'zi yuborish yoqilmagan | B (his switch) | — |
| `agent_off` | AI sotuvchi o'chirilgan | B | — |
| `not_reply` | bu oddiy javob emas (narx yoki VED savoli) — kind `price` / `hand_back` | C | hand-back questions to the customer are the AI's own follow-up; no reason for a press |
| `not_pending` | tahrirlangan yoki hal qilingan | A | — |
| `blocked` | qoida buzilgan | A | — |
| `needs_owner` | AI sizdan so'ragan savol bor | A/C | a holding line + continuing the rest of the conversation (dropped in §18.8 because any newer out message cancels the reply — a send-step design limit) |
| `warnings` | kartada ogohlantirish bor | C mostly | split warnings into «his eye» vs «machine stop» |
| `notes` | kartada izoh bor | C mostly | same (the late note alone refuses) |
| `actions` | hisoblatish yoki AI o'chirish — any action but `set_followup`, unless `calc` ticked | C | tick «Hisoblatish» (ships unticked) |
| `calc_identity` | chat telefon bilan tasdiqlanmagan | A | — |
| `calc_foreign` | boshqa sotuvchining mijozi yoki lidi (`machineMayTouch`) | A/C | an owner rule for whose clients the AI serves |
| `calc_refused` | VED navbati olmaydi (lead closed / open-calc cap: 100 seat, 20 people) | A | — |
| `calc_recent` | 14 kun ichida shu yuk uchun hisoblatish bor (`CALC_RECENT_MS`) | C | judgement «is this the same cargo?» |
| `calc_file_missing` | mijoz yuborgan fayl saqlanmagan | A | — |
| `money` | javobda pul bor — any `own_balance` call, a refused estimate, a money line no estimate tool vouched for, `price` / `calc_price` unticked, estimates not stored, a rail chat | A core; C in that the BALANCE and a refused estimate are always his | tick «Narx» / «VED narxi»; an owner decision on telling a customer his own debt |
| `money_unread` | pul so'zi bor, raqami o'qilmadi | A | — |
| `numeral_unread` | ieroglif bilan yozilgan son | A | — |
| `estimate_unnamed` | narx qaysi yuk uchunligi (kub, kg) aytilmagan | A | — |
| `estimate_moved` | narx jadvali o'zgargan | A | — |
| `tariff_unconfirmed` | Xitoy tarifi o'zgargan — birinchi narxni o'zingiz tasdiqlang (`agent_send_caps.tariff_confirmed_at` NULL after 0148) | A/C | one press «✅ Tarif to'g'ri» |
| `foreign_destination` | mijoz Toshkentdan boshqa shaharni aytgan (`destination.ts`, a curated list) | A | a tariff per destination |
| `destination_unsaid` | javobda «Toshkentgacha» deyilmagan | A | — |
| `markup_unconfirmed` | ustama o'zgargan | A | — |
| `calc_price_moved`, `calc_owner_priced`, `calc_person_offer` | VED javobi/ustama o'zgardi · siz 💵 bergansiz · sotuvchining yangiroq narxi | A | — |
| `owner_figure` | javobda sizning raqamingiz bor | C (his Q2 ⭐) | he answers ✍️ precisely SO THAT it goes; today any digit in his answer brings it back to him |
| `owner_personal` | javobingizda boshqa mijoz ma'lumoti bor | A | — |
| `answer_stale` | savolingizdan keyin mijoz yana yozdi | C | judgement whether the new line changes the answer |
| `category` | bu turdagi javob o'zi ketmaydi — label not in the ticked set; **`complaint` and `other` never**, whatever is ticked | C | categories as HIS setting are fine; the weak point is that the model's own LABEL decides (a reply the model files under `other` can never go, and nothing checks the label except `status`) |
| `status_unbacked` | yuk holati tekshirilmagan (label `status` with no ok `cargo_status`) | A | — |
| `language` | mijoz tili aniq emas yoki javob boshqa tilda (`languageAdmits`: en/fa/zh only on a confident read; uz/ru on a confident or leaning read; a FIRST message that says no language — «GS777», «5 куб 800 кг», «👍» — is held) | C | trust the model's reading; costs one press per new chat today (#1788) |
| `media` | mijoz rasm, ovozli xabar yoki fayl yuborgan (`burstHadMedia`) | **C** | the AI seeing the image/file |
| `too_long` | > `max_chars` 400 (CHECK 50…1 000) | C (setting exists in the column, **no box on the page**) | expose it |
| `low_confidence` | AI o'ziga yetarlicha ishonmaydi — `confidence` NULL or < `min_confidence` (0.80; page box 50-100 % since #1800) | **C** | an uncalibrated self-report told to be low (§0); replace by deterministic facts or drop |
| `stranger` | chat mijoz yoki lidga bog'lanmagan | A/C | — |
| `prospect` | lidni mijoz topuvchi agent topgan | B (cold outreach window) | — |
| `chat_off` | bu chatda vaqtincha o'chirilgan (30 d after a 👎 or «botmisiz?») | B/A | — |
| `human_active` | 🙋 bilan o'zingiz oldingiz (24 h) | A | — |
| `chat_muted` | bu suhbatda AI o'chirilgan | A | — |
| `not_work_account` | raqam «Ish raqami» emas | B | — |
| `night` | tun (22:00-08:00) — both the send moment and the card's own arrival; also a card copy that did not RING | B + C | on a seat nobody reviews, the card's «ring» is irrelevant; the pump's own night rule already allows a reply to a customer who wrote < 2 h ago |
| `streak` | ketma-ket 2 ta javob o'zi ketdi (`AUTO_STREAK_MAX = 2`; reset only by a PERSON's decision or message) | **C/B** | on a seat nobody types on, **the third reply of every conversation waits for a press** — this alone makes a multi-turn sale impossible |
| `daily_cap` | bugungi o'zi yuborish chegarasi (`per_day`; NULL = none since 0148) | B (setting) | — |
| `budget_spent` | bugungi AI yuborish chegarasi (day cap 80 / ramp) | B | — |
| `sending_disabled` | CRM'dan Telegramga yuborish o'chirilgan (`tg_sending_enabled`) | B | — |
| `listener_behind` | tinglovchi yangilanmagan | B | — |

Press-time additions (`pressOne`, `decideDraft(auto)`): `auto_warning` (any warning on the FRESH policy re-run),
card too long to draw its ✅ → `too_long`, a card copy that did not ring → `night`, `unseen` (the card has not reached
his Telegram — deferred 60 s, never pressed), the digest of the scheduled card, `auto_stopped` / `auto_disarmed` /
`taken_over`, and every ordinary ✅ refusal (`DecideRefusal`, `agent/decide.ts:79`): `policy_block`,
`listener_behind`, `sending_disabled`, `superseded`, `taken_over`, `budget_spent`, `calc_not_queued`,
`calc_in_flight`, `identity_changed`, `window_closed`, `estimate_moved`, `offer_gone`, `calc_price_moved`.
**The hold itself**: `hold_sec` 120 (CHECK 30…600, no box on the page) counted from the card REACHING his Telegram
with a sound — «no card, no press»: if the staff bot is down, muted or unlinked for the holder, nothing ever goes.

### 3.5 After approval — the send step can still cancel (`agentSendVerdict`, `agent/send-step.ts:185`)

FINAL (cancels, card says why): `agent_off`, `owner_changed`, `sending_disabled`, `account_paused`, `anchor_gone`,
`anchor_edited`, `anchor_superseded` (a newer non-nudge inbound **or any media line** — `asksAnew`), `human_replied`
(any newer out message that is not this row's — **the AI's own second message included**, except for owner-started
drafts, K1), `anchor_too_old` (24 h / 7 d), `approval_too_old` (6 h), `never_wrote`, `muted`, `excluded`,
`identity_changed`, `offer_gone`, `estimate_moved`, `calc_price_moved`, `calc_owner_priced`, `calc_person_offer`.
WAIT: `flood_wait`, `night`, `agent_window`, `not_caught_up`, `chat_gap`, `account_gap`, `hour_cap`, `day_cap`,
`chat_day_cap`, `slot_held`. All class B except the money ones (A).

---

## 4. PACING AND ACCOUNT PROTECTION (numbers)

`AGENT_LIMITS` (`agent/limits.ts:38-161`) — «fuses, not Telegram thresholds»:

| What | Value | Editable? |
|---|---|---|
| Debounce before a run | 12 s (`debounceMs`, `INBOUND_START_AFTER_S`) | no |
| Wait while the customer types | +8 s steps, cap 90 s | no |
| Greeting-only burst waits | 60 s | no |
| Echo window (robot ↔ robot) | 5 s | no |
| Runs per chat per day | 12 | no |
| Anchor max age (run AND send) | 24 h; a VED answer / his 💵: 7 days | no |
| Approval max age | 6 h | no |
| Draft TTL | 24 h (the anchor clock) | no |
| Gap between two AI messages in one chat | ≥ 20 s (`perChatGapMs`) | no |
| Gap between any two AI sends on the account | random 10-25 s (`sendJitterMs`); counts the account's CRM replies too | no |
| AI sends per chat per day | 12 (`perChatPerDay`) | no |
| AI sends per hour | 20 default; `agent_send_caps.hour_cap` 1…100 | yes (page, holder or super_admin) |
| AI sends per day | 80 default; `agent_send_caps.day_cap` 1…200 (= the human queue's `DEFAULT_LIMITS.perDay`) | yes |
| Ramp | first 14 days after `agent_config.started_at` (set ONCE, at the first switch-on; an owner change does not reset it): ceiling = `max(1, min(dayCap, floor(holder's own out messages in the 30 days before start / 30)))` — **a holder with no history gets ONE send a day** (#1790). On his server the first «on» was 2026-10-29, so the ramp ended ~11-12 (derived from #1789, not measured) | no |
| Night | 22:00-08:00 Tashkent; a ✅ is held to 08:30 unless the customer wrote < 2 h ago (`nightFreshMs`); a reply past its read may finish within 2 min (`nightFinishMs`). **Auto-send: never at night** (gate `night`) | no |
| Agent-found prospects | Mon-Sat 10:00-17:00, not Fri 12-14, never Sunday (`agentLeadWindow`); never auto | no |
| Read + typing simulation | verify (stored facts + live head `GetHistory(3)`) → `ReadHistory(maxId = anchor)` → read pause 1-3 s random → `SetTyping` ≤ 3 calls, total `clamp(2 s + chars/30 per s, 3 s, 12 s)` → verify head again → `SendMessage{randomId, noWebpage}`. Abort after the read → `MarkDialogUnread`. An ambiguous send → `unknown`, never re-sent | no |
| Same text | > 3 other peers in 24 h (`fingerprintPeers`): block, or a warning when ≤ 160 chars and figure-free | no |
| Links | ≤ 1 per chat per 7 days, ≤ 10 a day | no |
| Reply length | ≤ 700 chars (policy); auto ≤ 400 (`max_chars`) | column only |
| Human pause | `human_pause_min` 120: a person's own message in the chat (not an AI send, not the Business robot) or a queued CRM reply stands the AI down; 🙋 = `HUMAN_TAKEOVER_HOURS` 24 | 120 is editable |
| Auto hold | `hold_sec` 120 from the card ringing in his Telegram, ⏸ any time before | column only |
| Auto streak | 2 machine replies in a row per chat until a person acts (`AUTO_STREAK_MAX`) | no |
| Auto per day | `per_day` NULL (no count) since 0148; bounded by the day cap | yes (1…1 000 or none) |
| Auto press batch | 20 per minute sweep (`AUTO_PRESS_BATCH`) | no |
| Listener freshness | pump stamp ≤ 2 min (`pumpFreshMs`) and catch-up done | no |

**Step-downs of the auto layer** (`AUTO_STEP_DOWN`, `agent/auto-send.ts:1243`): 2 × 👎 within 7 days → disarm (each 👎
= that chat off 30 days); a block by a customer the machine answered within 7 days → disarm; «botmisiz?» after a
machine reply → chat off 30 days, the second such chat in 7 days → disarm. The AI keeps drafting; re-arming is his.

**Forced OFF of the whole agent** (`FORCED_OFF_REASONS`, `agent/forced-off.ts`; `crm/account-alarm.ts`):
`account_paused` (PEER_FLOOD / USER_RESTRICTED / FROZEN_* → the ACCOUNT is paused for human sends too, cleared only
by «Tekshirdim, qayta yoqish»), `flood_repeat` (2 send-method FLOOD_WAITs in 24 h — `floodRepeatWindowMs`),
`blocks` (2 customers who blocked within 7 days of an AI message — `blockWindowDays`), `telegram_notice` (any message
from Telegram's 777000 that is not login traffic). Each: queued agent rows cancelled, pending drafts expired, auto
disarmed in the same tx, an unmutable alarm to the holder and every super_admin through the BOT.
`flood_until` is persisted uncapped and moved only by SEND methods (`recordFlood`, `crm/account-guard.ts`); a
per-recipient final (blocked, privacy) mutes that conversation.

**Who may arm** (#1800): `mayArmAuto` = the holder, or a super_admin while the holder IS the AI seat; needs the agent
running and the number marked «Ish raqami». `mayTuneAuto` (kinds, per-day, min confidence) = holder or super_admin.

---

## 5. WHAT THE AI CANNOT DO TODAY THAT A HUMAN SELLER DOES (each verified in code)

| # | A seller does | The AI today | Where it is prevented |
|---|---|---|---|
| 1 | looks at the photo of the goods / the invoice / the packing list | sees the word `[rasm]` / `[fayl: name]`; a media-only burst gets NO draft and NO notice; any reply to a burst with media never goes by itself; an approved reply is cancelled by a later media line | `prompt.ts` `MEDIA_WORD`; `worthy.ts` `media_only`; `auto-send.ts` `burstHadMedia` → gate `media`; `send-step.ts` `asksAnew` |
| 2 | listens to a voice note | notice «AI eshitmaydi», no draft | `worthy.ts` `voice_only`; `prompt.ts` «(eshitilmagan)» |
| 3 | writes first, follows up «yukingiz nima bo'ldi?», revives a quiet lead | never. No trigger without a fresh inbound; `set_followup` only writes a date for a HUMAN's call list; send step refuses `never_wrote`, `anchor_too_old` (24 h) | `queues.ts` `shouldStartAgentRun`; `run.ts:1854`; `decide.ts:1380-1385`; `send-step.ts:210-215`. Roadmap 3(e) / part 3 «Friday greeting» — not built |
| 4 | sends two or three messages, answers a second question while the first waits | ONE message per burst, one live draft per chat; its own newer message cancels a waiting reply (`human_replied`), which is why the «holding line» was dropped | `agent_drafts` partial UNIQUE (one live per chat); `send-step.ts` `liveHeadVerdict` |
| 5 | carries a long conversation | 12 runs and 12 sends per chat per day; auto: the 3rd reply in a row waits for a person (`streak`) | `limits.ts` `runsPerChatPerDay`, `perChatPerDay`; `auto-gate.ts` `AUTO_STREAK_MAX` |
| 6 | opens a GS client code for a new customer | forbidden: rule 12 → `needs_owner` «kod ochib bering»; no tool; the bot's «👤 Mijoz — kod» only ATTACHES an existing code and is the owner's press | `prompt.ts:85`; `tools.ts` (no `createClient` anywhere in `agent/`); §18.5 |
| 7 | gives the avia receiving address | forbidden: tool states none, `withAviaRule` asks him, policy blocks `avia_address`, warns `avia_maybe` | `tools.ts` `avia`; `run.ts:923`; `policy.ts:2835-2840` |
| 8 | quotes rail | forbidden: `withRailRule`, `memory.rail` drops every machine money figure | `run.ts:1569`, `:687-689`; `worthy.ts` `RAIL` |
| 9 | quotes customs / turnkey (rastamojka, podklyuch) | never by itself: rule 11 «narx AYTMA»; it can only collect and submit to the VED, then relay the VED's figure + markup through `calc_price`. The model must not choose the section («o'zing tanlama — so'ra») — so a customer who just asks «narxi qancha?» with kub+kg gets the WEBSITE truck table, not a VED job (the first-day finding of #1800 is this design) | `prompt.ts:81,84`; `tools.ts` `checklist` `section === ''` |
| 10 | quotes Kashgar/Urumqi/Horgos origin, delivery to Andijan/Almaty…, cargo > 100 m³ / > 20 t, < $50 | tool refuses (→ hisoblatish) or the gate holds (`foreign_destination`) | `tools.ts:557`; `estimate.ts` `YOLKIRA_GUARDS`; `destination.ts` |
| 11 | negotiates: discount, «yaxshi narx qilamiz», matches a competitor | forbidden: G2 `promise:discount` blocks even «qulay narx»; the floor is never in context (law 4); a discounted VED job is `discounted` (no machine price) | `policy.ts` `PROMISE_TABLE`; `prompt.ts:75`; `calc-price.ts` |
| 12 | promises a date («juma kuni jo'natamiz») | forbidden: `dispatch_promise`, `number_unverifiable` for vague days; only the tool's «15-25 kun, va'da emas» | `policy.ts:2764`, `vagueTravelTime` |
| 13 | closes the deal: wins the lead, opens the deal, takes the order | cannot: no tool; `moveLeadByMachine` moves FORWARD only to two optional stages «AI birinchi javob berdi» / «AI narx aytdi», open stages only, never won/lost | `after-sent.ts` `stageAskOf`; `crm/service.ts` `moveLeadByMachine`; §18.5 |
| 14 | reminds about payment, tells the debt | never first (see 3); when ASKED, `own_balance` answers only a phone-proven chat and the reply is `money` → always his ✅ | `tools.ts:391-407`; `auto-gate.ts` `MONEY_TOOLS` |
| 15 | handles a complaint | rule 13 → calm short reply + `needs_owner`; category `complaint` never auto | `prompt.ts:86`; `auto-categories.ts` |
| 16 | answers «botmisiz?» | no draft, a notice; may never deny being an AI (`ai_denial`) | `worthy.ts` `BOT_QUESTION`; `policy.ts:2843` |
| 17 | asks a colleague (VED, logist, warehouse) and comes back | only ONE person can be asked — the account holder, through the bot card (✍️). On the AI seat the holder IS the machine user; cards go to whoever holds that staff-bot link. No routing to the VED/logist except a full `calc_submit` | `drafts.ts` `writeNotice` / card `userIds: [ctx.managerUserId]`; `jobs.ts` `remindOwnerQuestions` |
| 18 | learns the customer: remembers what he ships, his prices, his habits | per-chat memory = `locale` + the 100-message window; nothing is written about the customer unless HE presses «👤 Faqat shu mijoz» on a fact | `agent_conversations` columns; `kb.ts` scopes |
| 19 | reads the CRM card: notes, deal lines, earlier quotes by a seller, calls | reads the name, codes, manager's name, the lead's stage name — nothing else | `context.ts` `chatIdentity`, `leadStageOf` |
| 20 | updates the card: phone, goods, quote, note | writes only: a follow-up date, a calc job (its lenta note + cited lines + files), the machine's offer after a sent VED price (seat only), the two AI stages | `decide.ts` `runDraftActions`; `after-sent.ts` |
| 21 | sends the price list, a photo of the warehouse, a location pin, a PDF offer | text only; the Tashkent map LINK once per 7 days when asked | `gramjs-adapter.ts`; `policy.ts` `map_unasked`, `url_cap` |
| 22 | answers in a group, a channel comment, a bot | private one-to-one only | `eligibility.ts` `not_private_user` |
| 23 | answers a message older than a day (Monday morning for a Saturday question) | no: `too_old` at the run, `anchor_too_old` at the send | `limits.ts` `anchorMaxAgeMs` |
| 24 | answers at night | drafts yes; sends only if the customer wrote < 2 h ago; auto never | `send-step.ts` `releaseAt`; gate `night` |
| 25 | serves a colleague's client | drafts and his ✅ work; the MACHINE never touches a card whose owner/seller is someone else (`calc_foreign`, offer, stage) | `machine-owner.ts` `machineMayTouch` |
| 26 | speaks as himself | writes as BEKZOD in the first person («men») in «his style» — while the account is «BEKZOD AI sotuvchisi». The prompt's identity sentence still says «rahbari Bekzodning shaxsiy Telegram akkauntidagi … qoralamasini yozasan» | `prompt.ts:71`; §18.7 Q6 a |
| 27 | has a goal (bring the lead to an order) | no objective, no funnel plan in the prompt; `next_step` is written and never read; success is measured only as «his ✅ unchanged» | `prompt.ts` (16 rules, all prohibitions/procedures); `stats.ts` |

---

## 6. MEMORY AND LEARNING

| Layer | What exists | Written by | Limits | Measured? |
|---|---|---|---|---|
| Conversation | `tg_messages` of THIS (account, peer); windows 100/24 000 and 30/8 000 | the listener | deleted lines never; no summary of older history; nothing across chats | — |
| Per-chat state | `agent_conversations`: `locale` (remembered language; `localeToRemember`, and his ✅ teaches it — `approvedLocale`), `human_until`, `muted_at/mute_reason`, `peer_typing_at`, `stranger_card_at`, `identity_*`, `peer_contact` | runs, his presses | **no free-text memory of the customer** | — |
| Per-draft memory | `agent_drafts.policy.memory` (`PolicyMemory`): number sources, estimates, calcPrices, quotedRoad/quotedAir, customerLocale… — so the ✅ re-runs the policy on the same evidence; `lastQuoteFor` reads the newest approved one (7 days) | the run | one fact survives to the next run: the road last quoted | — |
| Knowledge base | `kb_facts` scope `general` / `client` / `lead`; 14 seeded keys (`seed-kb.ts`: `china_points@4`, `china_address_yiwu/guangzhou/horgos@1`, `tashkent_warehouse@1`, `tashkent_map@1`, `transit@1`, `gs_code@1`, `payment@1`, `prohibited@1`, `min_shipment@1`, `avia@1`, `certificate@1`, `china_warehouse_price@1`); page «Bilimlar» (add / edit / retire); «📌 Umumiy / 👤 Faqat shu mijoz» after his ✏️ or ✍️ answer | the owner only (approved_at), seed | **a money figure is refused at the write** (`moneyIn`) — a price can never be knowledge; personal bits refused in a general fact; general facts capped at 60 in the head | `uses_count`, `last_used_at` (shown on the page) |
| Lessons | `agent_lessons` («📝 Tuzatish», page tab «Saboqlar»): an INSTRUCTION in the cached head for every chat, newest first | holder or super_admin, echoed + «✅ Saqlash» (one-time token) in the bot | ≤ 500 chars each, ≤ 40 and ≤ 6 000 chars in the prompt; refused: money, personal bits; **a lesson never lifts a rule** («zid kelsa — qoida ustun; 10, 12, 13-qoidalarda doim needs_owner») and is never a number source | each draft stores `policy.lessons` (digest, newest id, count) so before/after rates CAN be read — no screen reads them |
| Style | `agent_config.style_guide` ≤ 1 500 chars, proposed by `scripts/agent-style.ts` from his own masked out messages, copied only by his «Uslubni tasdiqlash» | manual script + his press | not refreshed from his edits (§18.4 phase 4: «the style refreshed from his edits» — not built) | — |
| Stats | `agentStats` (`agent/stats.ts`): `rate = sentUnchanged ÷ (sentUnchanged + sentEdited + rejected + answeredHimself)`; apart: superseded, expired, live, onTheWay, approvedNotSent, price, `autoSent`, `ownerTriggered`; per category | — | machine presses are never in the rate («the gate never grades itself») | page «Sozlamalar» |
| Calibration | `agent/calibration.ts` + `scripts/agent-calibration.ts` (read-only): per category × confidence band × clean; one-sided 95 % Wilson lower bound; `AUTO_PROOF = {minDecided 50, minLower 0.8}`; categories measured: greeting/status/faq/qualification only | — | **gates nothing** (his «50 talik test bolmasin», #1683) | script only |
| Auto record | `agent_auto_verdicts`: every reply draft's verdict, ALL refusal reasons, state, 👎 feedback | the run / the press | — | page panel «🤖 O'zi yuborish» (today's counts, last 20) |
| Outcome of a sale | — | — | **nothing links an AI conversation to a won deal, money received or a lost lead**; the only quality signal is his press | no |

What «learning» is, exactly: (1) he adds a fact; (2) he writes a lesson; (3) his ✅ teaches a chat's language. The
model's weights, the rules and the gate never change from outcomes. His ✏️ rewrites are NOT fed back (no diff → lesson).

---

## 7. STATED-NOT-BUILT, OWED, «PART 3»

**Part 3 of the full seller (§18.8 intro, task list) — not started:** the Friday greeting to quiet customers (the
first «writes first» act); the AI as its own seat in the CRM (a `users` row owning leads, in /crm/tahlil, out of the
rating and KPI pay, its own KPI page). Only the kernel exists: `agent_seat_user_id` setting (`setAgentSeat`), the open
calc cap 100 for the seat, `holderIsSeat`, the two optional AI stages.

**Roadmap §18.4 not built:** 3(c) the holding line — DROPPED (it cancels the reply it promises); 3(e) follow-ups that
ACT on the date («chats that wrote within 30 days, an open lead, a small daily cap»); phase 4 — payment reminders
from `own_balance` with his template, a weekly self-report, the style refreshed from his edits, more accounts,
**an OFFICIAL channel** (Telegram Business bot / WhatsApp Cloud API) «so a ban never costs a person's account»;
phase 5 — WhatsApp, Instagram. Original spec §3.3-3.5, §8, §11: WhatsApp, Gmail, calls, campaigns («buyruq rejimi»).

**§18.3 stated, not built (#1695):** the 20:00 line «🤖 AI bugun …»; an alarm when cards never reach him (the layer
fails closed and only says so on the card/page); the page refreshing itself during a countdown; a taken-back press
still counts toward cap and streak; an `unknown` outbox answers a late press «yuborildi»; «3 failure signals in 24 h».

**§18.5 «stays the owner's forever» (a design decision the new product must re-ask):** the price of a calculation and
the floor; discounts, guarantees, credit, refunds, any promise; complaints and disputes; opening a GS code; winning or
losing a lead; the avia address and the rail price; arming and the kill switch.

**§17.13 not in phase 1 and still absent:** copying files onto the intake note was later built (`calc-files.ts`);
`random_id` for HUMAN sends; the relay of 777000 service notices' text; deletes learned while the listener is down.

**Owed from the reader work (#1788):** rare wrong-language sends (English words ending like Uzbek; a Russian sentence
with one Uzbek interjection; Latin-typed Russian; a forwarded Uzbek message counted as the customer's language);
«Yuk ertaga uchadi» (a day through the flight verb), time-of-day answers, spelled lesson prices with no price word,
«Order berdim» read as English. 22 ordinary cases held on the corpus ratchet.

**Owed from part 2 (#1797-#1798):** a ↩️ task opened before 0149 is never looped; a VED who habitually writes a note
(even «👍») turns the machine price off (`answer_noted`); the markup ships EMPTY (= the VED's own figure).

**Open with him (#1800):** why the AI quoted from the table instead of submitting to the VED — «the chats' words
decide»; from the code the answer is structural (§5 row 9): rule 8 sends every truck-freight question to
`yolkira_estimate`, and rule 11 lets a VED job start only when the customer himself names customs/turnkey AND the
checklist is complete.

**Not provable in this container (every round says so):** all gramjs calls against a real account; the real model's
behaviour; the first armed day was to be «watched in the tg-listen logs».

**Settings that exist in the schema with no control on the page:** `agent_auto_config.hold_sec` (30…600),
`max_chars` (50…1 000). Constants a designer would expect as settings: `runsPerChatPerDay`, `perChatPerDay`,
`AUTO_STREAK_MAX`, `anchorMaxAgeMs`, `approvalMaxAgeMs`, `maxReplyChars`, `maxToolRounds`, `LOOP_WALL_MS`,
`maxTokens`, `fingerprintPeers`, the night hours, `rampDays`, `CALC_RECENT_MS`.

---

## 8. Reading guide for the designer — what must change, by class

- **Senses (class C, biggest win):** media never reaches the model (`media_only` skip, `[rasm]`, gate `media`,
  `asksAnew`). Attachments are already stored per message (`attachments`, entity `tg_message`).
- **Judgement replaced by a self-report:** `low_confidence` (0.80 on a number the prompt tells the model to keep low),
  `category` by the model's own label, `language` by regex readers, `warnings`/`notes` lumped together.
- **Conversation shape:** one message per burst, `streak` 2, 12 runs/sends per chat per day, own second message
  cancels the first, 24-hour anchor, no timer trigger. These make a multi-turn sale structurally impossible without a
  person in the loop.
- **Role:** the prompt opens with «qoralama … Bekzod o'qiydi», persona = Bekzod in the first person; there is no
  objective, plan or pipeline state the model works toward (`next_step` unread), and no outcome feedback.
- **Keep (class A):** G1 number sourcing with tool-vouched money, the re-price at every press/send, law 4 (floor
  never in context), identity proof before cargo/balance, other-client leak fences, `machineMayTouch`.
- **Keep (class B):** the send choreography, caps, night, flood/restriction/blocks forced-off, `never_wrote`,
  the step-downs — these are what «ban havfini minimum qilsin» was built as; on a personal session they are the only
  protection there is, and §18.4 names an official channel as the precondition of full autonomy.
