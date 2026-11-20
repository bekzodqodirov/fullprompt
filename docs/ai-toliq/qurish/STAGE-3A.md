# STAGE 3a «Hamkasblardan so'raydi» — build plan (the exception inbox and the people beside the AI)

## 0. Header

| | |
|---|---|
| Stage | **3a** «Hamkasblardan so'raydi» |
| The owner stops | being the only person every AI question climbs to; forwarding «mashina qayerda?», «pul tushdimi?», «bu tovarni kiritsa bo'ladimi?» to the right colleague by hand and typing the answer back; taking call-back numbers, factory addresses and «sotib olib bering» details himself; guessing what the AI is waiting on and for whom |
| Size | **M-L** (2-3 weeks with the reviews: a kernel + six packages) |
| Depends on | **1a** deployed (designation table, `agent_signals`, `agent_samples`, the morning line, the complaint tripwire) · **1b** deployed (`agent_cases`, `agent_acts`, `agent_action_rights`, parts and the holding line, `speakers.ts`, the escalation step, the conversation record, `agent.event`) · **1c** deployed (P7 «Pochta»: the seat's own mail re-addressed to the supervisor). Stage 2 is NOT a compile dependency: where a cited customer line is a file, the card prints ⟨2⟩'s stored reading when one exists, else `[fayl]` |
| Read at | HEAD **`bf37150c`**, ledger 151 (journal tail `0150_batches_view`). `agent/` = `src/modules/wms/agent/`. Every `file:line` was opened at that HEAD. **Stages 1a, 1b, 1c are plans, not code**: what they ship is marked **⟨1a⟩ ⟨1b⟩ ⟨1c⟩** — re-read what was actually built (the «As built» blocks of `qurish/STAGE-0-1A.md`, `STAGE-1B-1C.md`) and use ITS names. `UNVERIFIED:` marks what I could not check |
| Contract | `docs/AI-SOTUVCHI-TOLIQ.md` §11 binds; `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` §4-§5 is the process. One branch, one PR, one deploy, his confirmation |

## 1. Behaviour, before → after (before = after 1c)

| Who | Before | After 3a |
|---|---|---|
| Customer | a question the AI cannot answer gets ⟨1b⟩'s holding line and waits for the supervisor; «telefon qiling», «zavoddan olib keling», «sotib olib bering», «karta raqami» all end as his question; a complaint is a held draft | the same holding line, but the answer comes from whoever knows (VED, logist, accountant, warehouse) — usually inside working minutes; «telefon qiling» → the AI takes number and hour and says a manager will call; pickup / buying → details collected once, handed over; a complaint gets one fixed sentence at once and a person |
| Owner (and deputy) | every case is his; nobody else is asked | only price, discount, complaint and «everything else» start at him; a colleague's case reaches him and the deputy only after 15 working minutes; ONE list «Istisnolar» (Savol · Ruxsat · Shikoyat · Tekshiruv · Signal) on the page and `/aiquti` in the bot; «🤖 AI davom etsin» gives a taken chat back; the morning report says who is waiting on whom; the evening sample shows why each reply was allowed |
| Staff | hear nothing from the AI | a designated colleague gets a money-free question card, answers by swipe-reply or «✍️», and the AI writes the customer; a seller gets a card when HIS customer asks the AI number about money; call-backs and hand-overs arrive as ordinary tasks. Nobody but the pair writes from the AI number or presses ✅ |

## 2. His answers that bind this stage — and what stays FORBIDDEN

Quoted from `docs/AI-SOTUVCHI-TOLIQ.md` §11.1:
- **14 b** — «customs → the VED on duty · "where is the truck / why late" → logist · "pul tushdimi" → accountant · pickup → warehouse manager · price, discount, complaint → him. 15 minutes in working hours, then him and the deputy. **The VED's card never carries a client price.**» §11.1 marks no ⚠ on this row, but it WIDENS the reversal of row 5 (`critic-feasibility.md` §A row 25, «faqat meniki»): colleagues now receive cards about the seat's chats — which is why a colleague's card is a QUESTION with cited lines, never the conversation.
- **5 b ⚠** (reverses «drafts are for me only», he saw it) — «a card unanswered for 15 minutes in working hours (09:00-19:00) goes to his deputy too. **Only the two of them write from the AI number.**» **4 a ⚠** — «cards to colleagues wait for the morning»: no clock runs and nothing climbs at night.
- **15 a** — «the AI takes the number and a convenient hour, opens a task for a person and says "menejerimiz qo'ng'iroq qiladi". Who — a setting.»
- **20 a + note** — «for factory pickup and "sotib olib berish" it collects the details and hands over. To whom — chosen in the system.» **21 a** — «it names the ways to pay and that payment is in Tashkent before pickup; the card number comes from a person (who — a setting).»
- **8 b** — «a colleague's customer on the AI number: status, addresses, table prices alone; money, discount and a new deal go to that seller as a card and the answer returns through the AI; the seller's price outranks the table.»
- **9 a** — «ten of its messages with 👍/👎 every evening for the first month, then weekly» (the full screen is built here).
- **§11.2** — one designation table, «topic → people, with the supervisor pair as the fallback … No person's name, id or role key appears in code or in a migration.»
- §8 «decided without a question»: ANY figure in his or a colleague's answer still comes to him as a card · only he approves knowledge · his own typing on the seat still pauses the AI · complaints: never silent, he decides, the AI relays.
- **10 c**, **12 a**, **17 c**, **19 c**, **31 c** hold unchanged (no dollar stop; the session only; the avia address and another city stay his forced questions; the seat stays in KPI and rating).

**FORBIDDEN in 3a:** a colleague writing from the AI number or pressing ✅ / ✏️ on any reply · relaying a VED's figure («it is the floor → the markup door or him») · a client price on any card whose reader is not sight `all` · the floor or a VED figure on a seller's card · a discount, credit, refund or compensation decided by the AI or by a colleague's answer without his ✅ (the discount tool is stage 6) · the AI creating a pickup, a deal, a code, a payment or the counter's 24-hour debt request (`issue/approvals` — `critic-owner-fit.md` §B.2) · a minute, an hour or a day promised in any system line · a relay later than the case's week (⟨1b⟩ clock) or to a customer who has not written · deleting or loosening any word rule or reader · a name, user id or role key in new source · a dollar ceiling · changing who reads Telegram (`seesAllTg`) without his answer (§11 Q2).

## 3. Data

### 3.1 One migration, additive — «the next after the journal's tail», tag `agent_inbox`

`when` = the tail's + 1 on the day the kernel is cut (#1040). Header as 0138 / 0145 / 0148 / 0149: `gsr_ai_reader` granted nothing on the new tables; `users` FKs carry no ON DELETE.

```
agent_case_routes   id uuid PK, case_id uuid NOT NULL REFERENCES agent_cases(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id),
                    step text NOT NULL CHECK (step IN ('first','climb','seller')), notify_after timestamptz NOT NULL, notified_at timestamptz,
                    notification_id uuid, answered_at timestamptz, released_at timestamptz, closed_at timestamptz, task_id uuid, created_at
                    UNIQUE (case_id, user_id); partial index (user_id) WHERE closed_at IS NULL
agent_takeovers     id uuid PK, manager_user_id uuid NOT NULL, peer_id bigint NOT NULL, case_id uuid, taken_by uuid NOT NULL REFERENCES users(id),
                    taken_at timestamptz NOT NULL, until timestamptz NOT NULL, asked_at timestamptz, returned_by uuid REFERENCES users(id),
                    returned_at timestamptz, return_note text CHECK (return_note IS NULL OR length(return_note) <= 300)
                    CHECK ((returned_at IS NULL) = (returned_by IS NULL)); index (manager_user_id, peer_id, taken_at DESC)
agent_signal_acks   signal_id uuid PK REFERENCES agent_signals(id) ON DELETE CASCADE, acked_by uuid NOT NULL REFERENCES users(id), acked_at timestamptz NOT NULL
```

One row of `agent_case_routes` per (case, person shown the card): it is the delivery ledger (who was asked, when the card may go, who answered first), the per-person cap, the colleague's own list and the morning report's «who waits on whom». `agent_takeovers` is the ledger of 🙋 and its return (today a take-over is only `agent_conversations.human_until`, written by `takeChatInTx`, `decide.ts:771-798`, and nothing records who gave a chat back). `agent_takeovers` is keyed (manager, peer) → add it to `PURGED_TABLES` and `purgeAgentChat` (`agent/purge.ts`), or `tests/unit/agent-fences.test.ts` goes red; the other two cascade from rows the purge already deletes (⟨1a⟩ `agent_signals`, ⟨1b⟩ `agent_cases`).

**Constraints — NONE is re-made here if ⟨1b⟩ shipped as planned.** `STAGE-1B-1C.md` §3.1-§3.2 widens every CHECK a later stage hits ONCE and RESERVES this stage's values there (its `agent-engine-reserved.test.ts` keeps `src/` from writing them early). So the first job of K1 is to READ the two constraints on the migrated database; take each value off ⟨1b⟩'s reserved list in the same commit that first writes it; and re-make a constraint (list ⊇ the one it replaces, derived from the LAST migration that re-made it, never restated) ONLY where 1b as built did not reserve the value:

| Constraint | As ⟨1b⟩ plans it | 3a |
|---|---|---|
| `agent_cases` kind CHECK ⟨1b⟩ | `kind IN ('question','act','complaint','handover')`, the last two reserved for 3a — UNVERIFIED name and list: read the migration 1b really wrote | first writer of `complaint`, `handover`; re-make only if absent |
| `tasks_origin_check` | at HEAD `"origin" IS NULL OR "origin" IN ('hand','calc','calc_return','promise','automation')` (`0124_task_origin_calc_note.sql:18-19`, restated in `platform/db/schema/platform.ts:1094`); ⟨1b⟩ adds reserved `'agent'` to the CHECK and the drizzle check | first writer of `'agent'` (`TASK_ORIGINS`, K7); re-make only if absent. `tasks_bound_check` (`0124:23-24`) is NOT touched: a hand-over task carries no `bound_id`; its case finds it through `agent_case_routes.task_id` |
| `telegram_chat_waits_kind_check` | 11 kinds, last re-made by `0148_agent_full_p1.sql:98-101`; ⟨1b⟩ adds `agent_case` | **not touched** — a colleague's «✍️ Javob yozish» arms ⟨1b⟩'s `agent_case` wait; the give-back note is a swipe-reply (§4.5), no wait |
| `agent_cases` status CHECK ⟨1b⟩, `agent_runs_trigger_check`, `agent_drafts_kind_check`, the outbox CHECKs | as ⟨1b⟩ left them (`case_answer` is the trigger of every relay) | untouched |

**No column is added to any existing table** — not to `tasks`, `notifications`, `users`, `agent_conversations`, nor to ⟨1a⟩/⟨1b⟩'s tables — so nothing here needs a SQL-only column or `to_jsonb`. If the builder finds one unavoidable, it stays undeclared in drizzle this release and is read through `to_jsonb(row)->>'col'` behind the probe (the 0142 / 0144 precedent).

**Probe** `agentInboxReady()` in `agent/config.ts` beside `agentFullP2Ready` (`config.ts:172`) and ⟨1b⟩'s `agentEngineReady`: `to_regclass` of the three tables, cached TRUE only, with the `__forget…` / `__pretend…Behind` twins. **Behind:** `routeFor` answers the supervisor pair for every topic (⟨1b⟩ behaviour, no route rows written), `hand_over` is not offered (`toolSpecsFor`, `tools.ts:256`, the `calcPricing` precedent), 🙋 writes no ledger row and the page draws ⟨1b⟩'s «Savollar». A writer asks the probe ITSELF before its transaction (a statement on a missing table aborts it — the `agentAutoReady` rule, `decide.ts:877`, `:990`).

### 3.2 Settings (`platform/settings/service.ts` `SETTING_DEFAULTS`; each with a validator, an own-door entry and `settings.descriptions.<key>` in all four bundles — `tests/unit/locales.test.ts`)

| Key | Default | Meaning |
|---|---|---|
| `agent_routing` | `'pair'` | `pair` \| `topics`. Ships **`pair`** = ⟨1b⟩'s behaviour exactly: every case a `question` to the supervisor pair, `hand_over` not offered, no route / complaint / hand-over rows written. He flips it after filling the screen — and back, as the rollback |
| `agent_case_open_cap` | `5` | open AI questions one colleague may hold; over it he is skipped (1-20) |
| `agent_complaint_remind_minutes` | `30` | an open Shikoyat is re-shown to the pair this often, working time only; 0 = never |
| `agent_takeover_ask` | `true` | when 🙋's 24 hours end, ask the taker once before the AI resumes (§11 Q6) |
| `agent_silent_chat_minutes` | `10` | a customer line with no reply, no draft and no case for this many WORKING minutes → one Signal; 0 = off |
| `agent_seller_price_days` | `30` | 8 b: how long a seller's price on the card outranks the table (1-365) |

Reused, not re-made: ⟨1b⟩ `agent_escalate_minutes` (15), `agent_work_hours` (`09:00-19:00`), `agent_work_days`. A key read inside a transaction is read with `tx.execute` on it (#714, `tests/unit/tx-pool.test.ts`).

### 3.3 What 3a adds to the designation table of ⟨1a⟩ (`agent_designations`, `agent/designations.ts`)

No schema change: ⟨1a⟩'s `topic` is a SHAPE check, so a topic is a key in the code registry plus four i18n strings. 3a (a) adds eight keys, (b) gives every registry entry three fields that say HOW it is routed — never WHO, (c) builds the full screen (§4.6).

| Key | Label he reads (`agentAi.topic.*`) | `route` | `mode` | Needs proof | His rule |
|---|---|---|---|---|---|
| `supervisor` ⟨1a⟩ | «Rahbar va o'rinbosar» | `pair` | `rewrite` | — | 5 b; also the last fallback of every topic |
| `big_cargo` ⟨1a⟩ | «Katta yuk signali» | `signal` | — | — | 3 b (unchanged) |
| `customs` | «Bojxona savoli (VED)» | `rota` | `rewrite` | — | 14 b «the VED on duty» |
| `logistics` | «Mashina qayerda, nega kechikdi (logist)» | `all` | `rewrite` | `cargoAllowed` | 14 b |
| `money` | «Pul tushdimi, to'lov (buxgalter)» | `all` | `rewrite` | `cargoAllowed` | 14 b |
| `warehouse` | «Olib ketish, sklad (sklad mudiri)» | `all`, the standing warehouse's people first | `rewrite` | `cargoAllowed` | 14 b |
| `card_number` | «Karta raqamini kim beradi» | `all` | `verbatim` | — | 21 a |
| `callback` | «Qo'ng'iroq qiladigan odam» | `one` | `handover` | a phone | 15 a |
| `pickup` | «Zavoddan olib kelish» | `one` | `handover` | a phone | 20 a |
| `buying` | «Sotib olib berish» | `one` | `handover` | a phone | 20 a |

«A colleague's customer → that seller» (8 b) is **not a topic**: the person is a fact of the card (§4.4), so nothing is designated. `designated(topic)` keeps ⟨1a⟩'s chain — the topic's rows → `supervisor`'s rows → the holder plus the `super_admin` role holders — with ONE step inserted for `customs` only, BEFORE the supervisor pair: when he designated nobody, the existing rota pool (`vedRotaPool()`, `wms/calc/service.ts:151` — the code that already knows who calculates; no new role literal is written).

## 4. Code

### 4.0 Kernel K (the lead, one commit)

| # | File | Today (as read) | Change |
|---|---|---|---|
| K1 | the migration, `platform/db/schema/agent.ts`, `agent/config.ts`, `agent/purge.ts` | — | §3.1; the probe |
| K2 | `agent/designations.ts` ⟨1a⟩ | registry = key + label key | `TopicSpec` gains `route: 'pair'\|'rota'\|'all'\|'one'\|'signal'`, `mode: 'rewrite'\|'verbatim'\|'handover'`, `proof: 'none'\|'cargo'\|'phone'`; the eight keys of §3.3 |
| K3 | `agent/routing.ts` (new) | — | **The ONE home of «who gets this case».** Pure `routePlan(facts)` → `{first: userId[], step, climbTo: userId[], notifyAfter}` and its reader `routeFacts(case)`. Nothing else may read `agent_designations` to address a case (source-shape fence, §7) |
| K4 | `agent/case-sight.ts` (new; or inside ⟨1b⟩ `speakers.ts` if `cardSightFor` lives there) | ⟨1b⟩ `cardSightFor(recipient)` from `upsaleScopeFor` (`calc/upsale-scope.ts:40`) | **The ONE home of «what a case card may show»**: `caseTextFor(case, recipient, role)` + pure `maskMoney(text)` built on `extractNumbers` (`agent/numbers.ts:1148`, kind `money`, `index` + `raw`) — every money figure in a quoted line becomes «(summa)» |
| K5 | `agent/inbox.ts` (new) | — | **The ONE read of the inbox** (#513): `inboxFor(viewer, filter)` / `inboxCounts(viewer)` over cases, waiting drafts, unmarked samples and un-acked signals; pure `inboxKindOf(row)`. The page, the bot's `/aiquti`, the colleague's page and the morning report all call it |
| K6 | `platform/telegram/staff-bot.ts` | `ag:<op>:<uuid>[:<8hex>]` takes ONE letter (`:806` `/^ag:([a-z]):…/`); 20 letters are used (`AGENT_OPS`, `:423`) and ⟨1b⟩ takes the last six (`d i m o q w`) — **the alphabet is spent** | a second grammar **`aq:<op2>:<uuid>[:<8hex>]`** (two letters; `aq` is free at HEAD — `parseCallback`, `staff-bot.ts:744-831`, takes `e:s` `e:c` `jy` `c` `n` `t` `tb`, the two-letter task buttons of `TASK_PREFIXES` (`:510` — `tk tw tq tr tn te tc tf`), `tp` `d` `dk` `fb` `lc` `cl` `ca` `cg` `cf` `cu` `ag` `pf` `a`; a grep of `src/` for `aq:` finds nothing; grep `parseCallback` again on your tree), `BotCallback` kind `agent_inbox`, classified `'cas'` in `PRESS_REPEAT` (`:445`, a compile error until it is). Ops: `nm` not mine · `gb` give back · `ex` 24 h more · `sc` the seller calls himself · `cx` close a complaint · `ak` «Tekshirdim» |
| K7 | `platform/tasks/service.ts` | `TASK_ORIGINS` (`:146`); `assignedNoteLine` prints the note for `hand` and a NULL origin only (`:349-350`); `authorHearsPresses` false for `automation` (`:377`); the bot's buttons switch on origin (`staff-bot.ts:1046-1054`) | origin **`agent`**: the note IS printed (it carries the number and the hour), 👀 and ⏰ offered, «💬 Savol» not offered, the author (the seat) hears no press (its mailbox is nobody's; the case card tells the pair). `tests/unit/topshiriq-buttons.test.ts`, `topshiriq-wire.test.ts` learn the fifth row |
| K8 | `agent/queues.ts` | ⟨1b⟩ `AgentEventJob` = `case_answer` | + `case_route` (deliver / climb one case), `case_closed`. Zero imports stays true — **the listener reads this file, so tg-listen is rebuilt** (§9) |

### 4.1 P1 «Yo'naltirish» — the topic, the route, the clock (owns `routing.ts`, the `ask_owner` act in ⟨1b⟩ `acts.ts`, ⟨1b⟩ `escalate.ts`)

- **The tool.** ⟨1b⟩'s `ask_owner {question, cited_message_refs}` gains `topic` (enum `customs | logistics | money | warehouse | card_number | other`; absent = `other`). The name stays — one tool, the prompt's «ask_owner» rules keep working. `hand_over` is P3's.
- **Code outranks the model's label**, in this order (pure, `routePlan`): (1) ⟨1a⟩ `complaintIn(burst)` → kind `complaint`, the pair, whatever was asked; (2) the question names money (`namesMoney`, `numbers.ts:1137`) or the topic is `other` → `supervisor`; (3) the chat is a colleague's customer and the topic is `supervisor`- or `money`-bound → `step 'seller'`, that seller (§4.4); (4) `proof: 'cargo'` and `identity.cargoAllowed` false (`context.ts:61`) → **no case**: the tool answers «mijoz kimligi tasdiqlanmagan — yuk va pul haqida so'rov yuborilmaydi; kabinet havolasini taklif qil», exactly today's identity rule; (5) an OPEN case of the same topic in this chat → «bu savol yuborilgan, javob kutilmoqda» (the record already shows it — ⟨1b⟩ `record.ts`); Before all of it: `agent_routing = 'pair'` or the probe behind → ⟨1b⟩'s case to the pair, none of the above asked.
- **Who, per `route`:** `rota` (customs) — the chat's open calculation first: when `chatCalcChains` (`context.ts:575`) holds an open request with an assignee, THAT VED gets the question (it is about his job) and the card names the request's code; else ONE person from `designated('customs')` picked by `nextCaseAssigneeInTx(tx, pool)` — fewest open routes, then fewest handed today, then longest wait, then id, under `pg_advisory_xact_lock(hashtext('agent-case-rota'))`. It restates the VED rota's rule (`nextVedAssigneeInTx`, `calc/service.ts:200`) and does not share it: that one counts `calc_requests`; the pool is computed BEFORE the transaction (#714). `all` — every designated person of the lowest rank present; the first answer wins, the other copies are closed in words («{Ism} javob berdi»). For `warehouse`: people whose assigned warehouses (`user_warehouses`, `rbac/scope.ts:55 inScope`) include where the client's ready cargo stands (`standOf`, `inventory/stands.ts:104`) come first; none → all. `one` — rank order, the first who can log in and is under the cap.
- **The cap and the unreachable.** A person holding `agent_case_open_cap` open routes is skipped; so is one `reachOf([id], 'AgentCase')` calls `no_chat` (`platform/notifications/staff.ts:141`) — the silent failure of `critic-feasibility.md` §C stage 3. Everybody skipped → the pair at once, and a Signal «{mavzu}: belgilangan hodimga xabar yetmayapti» (one per topic per day, `agent_signals` dedupe ⟨1a⟩).
- **The clock** — ONE pure function, ⟨1b⟩'s `workMinutesBetween`, plus `nextWorkMoment(now)`. `notify_after` of a route to anybody but the pair = now in working time, else the next working minute (**his 4 a: colleagues' cards wait for the morning**); the pair's own copies keep ⟨1b⟩'s behaviour (sent, night-silent). ⟨1b⟩'s sweep step delivers due routes (`notified_at` by compare-and-set), then: a `first` or `seller` route unanswered `agent_escalate_minutes` WORKING minutes after `notified_at` → `climb` routes for the supervisor AND the deputy together (14 b), claimed by ⟨1b⟩'s `agent_cases.escalated_at`; a case that STARTS at the pair keeps ⟨1b⟩'s rule (supervisor, +15 → deputy). After the climb nothing rings again except a complaint (P5). The week's expiry is ⟨1b⟩'s, untouched.
- `jobs.ts:229 remindOwnerQuestions` / `OWNER_QUESTION_WAIT_MS` (`:206`) are already replaced by ⟨1b⟩; if they still stand, they go here.

### 4.2 P2 «Javob» — a colleague answers, the AI relays (owns ⟨1b⟩ `case-answer.ts`, `case-card.ts`; today's `owner-answer.ts`, `owner-answer-job.ts`)

- **Three doors, one service** `answerCase(actor, caseId, text, via)`: a swipe-reply to the card — resolved from the replier's OWN notification row (`agentCardFor`, `bot-door.ts:614`, reached from `agentTextSlot`, `platform/telegram/agent-bot.ts:251`, which sits ABOVE the thread reply door, `staff-handlers.ts:1129` vs `:1154`); «✍️ Javob yozish» (⟨1b⟩ `ag:i`, wait `agent_case`); the web form (§4.6). The service, never the door, decides: the actor holds an un-closed route of this case (or is the pair), the case is `open`, first answer wins by compare-and-set on `status`.
- **Refused before anything is stored, the wait stays armed** (pure, beside `answerTextRefusal`, `owner-answer.ts:47`, which keeps refusing a link, a phone and Chinese text for `rewrite` topics):
  - **a money figure from a reader whose sight is not `all`** (`upsaleScopeFor(actor) !== 'all'` — a VED, and a seller on a case that is not his own customer's): `extractNumbers(text).some(kind === 'money')` or `namesMoney` with a numeral. Words: «Javobingizda narx bor: «{o'qilgani}». Narxni bu yerda yozmang — hisoblashda «Готово» orqali bering (AI sotuvchi ustama bilan o'zi aytadi). Javobni narxsiz qayta yozing.» This is law 4's third leak closed at the door: a VED figure never enters a case, so it can never be relayed «as given»; its only road to the customer stays the existing `calc_price` door with his markup (`agent/calc-price.ts`, migration 0149).
  - an empty or over-long text (600 characters).
- **`rewrite` topics**: stored on the case → `JOB_AGENT_EVENT {case_answer}` → ⟨1b⟩'s run (`runOwnerTriggered`, `run.ts:1809`, trigger `case_answer`). The instruction is today's `ownerAnswerInstruction` (`owner-answer.ts:92`) with the answerer named by ROLE WORD from the topic's label («hamkasbning javobi»), never by name. `AnswerMark` (`types.ts:136`) gains `answeredBy` and `sight`. Unchanged rules, now for any answerer: `owner_figure` (`auto-gate.ts:415`; `answerHoldsFigure`, `owner-answer.ts:133`) — **any figure → the redraft is a card for the pair's ✅**; `owner_personal` (`ownerPersonalOf`, `:105`); `answer_stale` (`:154`, measured from the CASE's anchor and `burst_seen_at`).
- **A figure-free colleague answer** is an act of its own in ⟨1b⟩'s registry: `ACTS.relay_answer`, default position **`nazoratda`** («Nazoratda») — it goes by itself and is ALWAYS in that evening's sample (§4.6); `sorab` («So'rab») makes every one a card (§11 Q1). Its position is a ROW of ⟨1b⟩'s `agent_action_rights` under the key `relay_answer`, drawn on ⟨1c⟩'s «Huquqlar» list; 3b's page adopts that stored row and key unchanged (`STAGE-3B.md` §6.3a) — no second store, no rename. The supervisor's own answers keep ⟨1b⟩'s rule.
- **`verbatim` topic (`card_number`)**: the answer is never shown to the model — a retyped card number is a wrong card number. It becomes a turn of two parts made by CODE: a `block` «To'lov uchun karta:» + the answer as typed (trimmed; digits, spaces and a holder's name only — anything else is refused in words). It is ALWAYS a card for the pair's ✅ (it is a figure), checked by `ownerPolicyFor` (`policy-input.ts`) like his ✏️ text.
- **The redraft's card** goes to the pair, never to the colleague. The colleague hears one line: «✅ Javobingiz qabul qilindi — AI mijozga yozadi.» / «…javobda raqam bor — avval rahbar tasdiqlaydi.»; when the run made no reply, ⟨1b⟩'s `tellNoAnswerDraft` words go to the pair, not to him.
- **«Shu savol yana kelsa?»** — under the relayed case, on the SUPERVISOR's copy only: «📌 Umumiy qoida · 👤 Faqat shu mijoz · ✖ Saqlamaslik» (today's `kbPress`, `bot-door.ts:660`, re-keyed to cases by ⟨1b⟩). Door: ⟨1b⟩ `mayApproveKnowledge` — never the deputy, never the answering colleague. `writeKbFact` (`kb.ts:380`) stores `approvedBy` = him (`:426`), `sourceRef: {caseId, answeredBy}`, and still refuses money (`KbRefusal 'money'`, `:352`) — so a colleague's price can never become knowledge.
- **Mirror**: for a `customs` case tied to a calculation, the question and the answer are also written as two internal notes of that job's thread (`addThreadMessage`, `crm/thread.ts:199`, ref `{kind: 'calc', id}`), authored by the holder actor — whoever opens the job later reads them. No ping (the card already rang).

### 4.3 P3 «Topshirish» — call-back, pickup, buying (new `agent/handover.ts`; `ACTS.hand_over`)

- **One tool** `hand_over {kind: 'callback' | 'pickup' | 'buying', refs: {…message refs}}`, position `ozi` (internal, reversible), offered only when the probe is ready. Like `calc_checklist` (`tools.ts:193`, handled at `:448`) it answers WHAT IS MISSING until the checklist is whole; refs are the customer's own lines of the recent window — the model passes no text and no number.

| Kind | Collected (each a cited customer line, or a card fact) | Goes to |
|---|---|---|
| `callback` | the number — the card's phone confirmed by the customer, or a line that `phonesIn` reads as one (`numbers.ts:587`); the convenient hour (optional — absent = «istalgan vaqt») | `designated('callback')` |
| `pickup` | factory name and address (text or a map point; Chinese is copied, never retyped); the contact person and phone there; the goods and a rough size; when it is ready; the customer's own phone | `designated('pickup')` |
| `buying` | what to buy (name, link or photo line); how many; the customer's own budget if said («mijoz aytgan», never a price of ours); where / which seller if known; the customer's phone | `designated('buying')` |

- **The act**: a case `kind 'handover'` + ONE task through `createTask(input, {actorId: holder}, {origin: 'agent'})` (`platform/tasks/service.ts:574` — it refuses an assignee who cannot log in, `:597`; that refusal is the route's «skip to the next person»), pointed at the lead or client card, due = today 19:00 Tashkent (the next working day after 17:00). Title «📞 Qo'ng'iroq: {mijoz}» / «🏭 Zavoddan olib kelish: {mijoz}» / «🛒 Sotib olib berish: {mijoz}»; the note is built by CODE from the cited lines copied verbatim (≤ 10 lines, ≤ 600 chars — `ASSIGNED_NOTE_CAP`) plus «AI raqamidagi suhbatdan». Idempotent: `idem_key` = chat + kind + Tashkent day (a second «telefon qiling» the same day adds a line to the same task's note). `route.task_id` links them; `completeTask`'s wms crossing (the `completeCalcForTask` dynamic import, `tasks/service.ts:760`) closes the case and writes «qo'ng'iroq qilindi» into the record. No customer message on completion.
- **The AI's sentence is the system's** (a `holding`-kind part ⟨1b⟩, §6.3): the model writes nothing about a call, and no hour is promised even when the customer named one.
- **21 a**: the ways to pay and «to'lov Toshkentda, yukni olishdan oldin» are a knowledge FACT he types once in «Bilimlar» (a deploy chore — no code holds it); only the card NUMBER is a case (`card_number`, §4.2).

### 4.4 P4 «Hamkasb mijozi» — his 8 b (new `agent/colleague.ts`; touches `context.ts`, `tools.ts`)

- **ONE resolver** `colleagueOf(identity, holderId)` → the seller's user id or null: the chat's client seller / lead owner / open deal owner that is neither nobody nor the holder — `machineMayTouch` (`machine-owner.ts:21`) asked the other way round. The three existing callers (`calc-submit.ts:96-111`, `calc-price.ts:568-573`, `after-sent.ts:177-179`) keep their own calls: `calc_foreign` and «the machine writes no offer on a colleague's card» stand untouched.
- **Alone, as today**: status (identity-proven), addresses, table prices. **To the seller** (`step 'seller'`): a balance or payment question, a discount, a new calculation (the machine still refuses to land one — `calc_foreign`; the card gives the seller the collected checklist and he submits it through his own doors), credit. The seller's card: «👤 Mijozingiz AI raqamiga yozdi — {GS… · Ism}» / the question / the customer's cited lines **unmasked** (his own customer; never OUR lines) / «✍️ Javob yozish» · «📞 O'zim bog'lanaman» (`aq:sc`: the case closes and the customer gets the system line naming the manager — `identity.managerName`, the one staff name a reply may carry, `context.ts:55`). No answer in 15 working minutes → the pair, as every route (§11 Q3). His answer returns through §4.2: a figure → the pair's ✅ (only the pair write from the number).
- **«The seller's price outranks the table»** — pure `sellerPriceStands(card, now)` + its reader: on a colleague's card, a quote on the lead or on an open deal (`quoted_amount`, `schema/wms.ts:1910`, `:2250`) or a person's released offer on any of its calculations (the reading `personOfferOn` already makes, `calc-price.ts:400`), newer than `agent_seller_price_days`. Then the `yolkira_estimate` and `avia_estimate` handlers (specs at `tools.ts:181-191`, dispatched at `:444-447` to `yolkira` `:535` and `avia` `:630`; the truck handler's refusals at `:548-570`) refuse — «bu mijozga menejeri narx bergan — jadval narxini aytma; savolni ask_owner bilan yubor» — and the question goes to the seller. This is `critic-guard.md` §E row 8. With no such price the table figure goes as today, and its turn ends with one system sentence «Aniq shartlarni menejeringiz {ism} aytadi.»
- The price the AI relays for a seller is NOT written on his card (29 b is the seat's own cards; `machineMayTouch` forbids the rest) — stated.

### 4.5 P5 «Shikoyat va navbat» — complaints, take-over, give-back (new `agent/takeover.ts`; touches `decide.ts`, `run.ts`, `crm/outbox.ts`)

- **Complaint** — never silent, never money. A hit of ⟨1a⟩'s tripwire or the model's `complaint` label: (a) the system sentence goes at once (while «o'zi yuborish» is armed; in shadow the card says it did not go), once per open complaint; (b) a case `kind 'complaint'` to the pair — and, on a colleague's customer, a copy to that seller if he answers §11 Q5 that way; (c) the model's own draft stays a card (gate `complaint` ⟨1a⟩); (d) while the case is open every reply of that chat that is not class `talk` is held, and no `hand_over`, discount or price act runs. The case never expires (the week's sweep skips the kind); it is re-shown every `agent_complaint_remind_minutes` of working time and closed only by the pair («✅ Yopildi», `aq:cx`, with one typed line of what was decided — kept on the case, never sent).
- **🙋 take-over** stays ⟨1b⟩'s door (`maySpeakForSeat`; `takeChatInTx`, `decide.ts:771`) and now also writes one `agent_takeovers` row in the same transaction. The taker's toast becomes a card that STAYS: «🙋 Suhbat sizniki — AI bu chatga yozmaydi. Qaytarish uchun: "🤖 AI davom etsin".»
- **Where the pair write.** Today a reply leaves only one's OWN account (`replyAccountFor`, `crm/outbox.ts:81`: «replying "as" a colleague is … impersonating them»). 5 b makes the seat the exception for two people: `replyAccountFor` gains ONE branch — the chat's account is the AI seat (`holderIsSeat`, `platform/settings/agent-seat.ts:52`) and `maySpeakForSeat(actor, holder)` → `{managerUserId: seat, peerId}`. Their text rides the human path (`tg_outbox`), so the listener's `agent.human_reply` retires a live draft and the pause starts exactly as when he types on the seat's phone. A colleague stays refused (`tests/integration/outbox.integration.test.ts:146` pins it today + a new red proof). **Read at HEAD — this branch covers CODED clients only:** `replyAccountFor(clientId, actorId)` is keyed by a CLIENT (it finds the peer through `peerForClient`, `crm/outbox.ts:81-88`) and `tg_outbox.client_id` is NOT NULL (`schema/wms.ts:2801-2803`), so the CRM has no composer for a LEAD-owned chat at all (lead chats are read-only on every chat surface; «lead-chat replies from the CRM need `tg_outbox.lead_id`» is still an open question of his). Most of the seat's chats are leads until a code is opened — for those the pair write from the seat's own phone (which already pauses the AI), or by ✏️ on a draft card. Do NOT widen `tg_outbox` here; say on the lead card's thread that writing is from the phone, and ask him (§11 Q7 covers who; whether a lead composer is wanted is a new question for him).
- **«🤖 AI davom etsin»** (`aq:gb`, the pair): one transaction — `human_until = NULL` on `agent_conversations`, `returned_at / returned_by` on the ledger row. `eligibilityFacts` (`run.ts:301`) must then ignore the person's earlier lines: its `lastHuman` read (`:317-333`) takes `sent_at > max(returned_at)`; the gate and the send step read `human_until` alone (`auto-gate.ts:450`, `auto-send.ts:1012`, `send-step.ts:206`) and need nothing — so the LISTENER's code does not change. The AI does not write first: it answers the customer's next line. A swipe-reply to the take-over card is the optional note («5 % berdim, davom et»): stored as `return_note`, shown to the model in the record as «RAHBAR ESLATMASI», its figures sources of origin `owner` (`ownerAnswerSources`, `numbers.ts:1582`) — so a reply that states them is `owner_figure` and comes back as a card.
- **When the 24 hours end** (`agent_takeover_ask`): the next customer line does not start a run at once — the taker is asked once («🙋 {mijoz} suhbatini olganingizga 24 soat bo'ldi. AI davom ettirsinmi?» · «🤖 Ha, davom etsin» · «🙋 Yana 24 soat» `aq:ex`), claimed by `asked_at`; ten working minutes with no press → the AI continues and says so on the card. Off = today's silent resume.

### 4.6 P6 «Quti» — the inbox, the screens, the reports (owns `suhbatlar/ai/*`, a new colleague page, `morning.ts` and `sample.ts` of ⟨1a⟩)

- **The five kinds are a VIEW, not five tables** (`inboxKindOf`): **Savol** = cases `question` + `handover` · **Ruxsat** = cases `act` (⟨1c⟩ the code) + reply drafts a rule holds for a person (`pending` / `editing` with no live countdown — relayed answers with a figure among them) · **Shikoyat** = cases `complaint` · **Tekshiruv** = today's unmarked `agent_samples` · **Signal** = `agent_signals` with no `agent_signal_acks` row (big cargo, loop, an unreachable designee, a silent chat, ⟨1a⟩'s cap notices). Each row: the kind, the chat's label, who it waits on, for how many WORKING minutes, its buttons.
- **Web, the pair**: `/suhbatlar/ai` section `quti` «Istisnolar» (`labels.ts:24 AGENT_SECTIONS`; `savollar` stays a valid `?bolim=` and opens `quti` filtered to Savol), five chips with counts, oldest first. Door: `agentDoorsFor` (`web-door.ts:15`) ∪ the pair; every action asks its own predicate again.
- **Web, a colleague**: `/ai-savollar` — any login; rows are the viewer's OWN routes (`user_id = actor.id`), open first, the last twenty closed under a fold; a controlled answer box (a refusal keeps the text — #466), «↪️ Meniki emas». The pair are redirected to the section above. No menu entry (the nav fences count menus): reached from the card's «↗️ Ochish» and from one row on `/bugun` when the viewer has open routes (`src/app/(protected)/bugun/page.tsx` — a count beside `myDay`, from `inboxCounts`).
- **Bot**: the cards themselves, plus the command **`/aiquti`** (`platform/telegram/commands.ts:36-53`) — «🤖 AI qutisi: 2 savol · 1 topshiriq» and the five oldest lines; for the pair all five counts and the page link. A command, not a keyboard row: reply-keyboard labels are routers and a new row needs every person's /start.
- **«Kim javob beradi» in full** (⟨1a⟩'s section): the master switch «Hamkasblardan so'rash: o'chiq / yoqilgan» (`agent_routing`); topics grouped «Rahbar va o'rinbosar · Mavzular · Topshirish · Signal»; per topic the chosen people in rank order, beside each what `reachOf` says («Telegram ulanmagan», «tizimga kira olmaydi») and how many open questions he holds; an empty topic prints «belgilanmagan — hozir sizga keladi» (customs: «belgilanmagan — hisoblash navbatidagi VEDga boradi»); one resolved line per topic from `routePlan` itself («Hozir: {kim} → 15 daqiqadan keyin siz va o'rinbosar»); «Sinov kartasi» sends that person one harmless card so the link is proven before a customer depends on it.
- **The morning report in full** (⟨1a⟩ `morningFacts` / `morningLine`, 08:40, to the pair): yesterday — cases asked, answered, climbed, expired, hand-overs, the median answer time per topic in working minutes; NOW — open rows per kind with the oldest's age and whom it waits on; unreachable designees; unmarked samples older than 48 h; one health line from facts («oxirgi mijoz xabari 08:31, oxirgi javob 08:33»). Counts and staff names only — never a customer's words. Shape: «🌅 AI sotuvchi, kecha: 31 javobdan 27 tasi o'zi ketdi. Hamkasblarga 6 savol: 5 tasiga javob keldi (o'rtacha 9 daqiqa), 1 tasi sizga chiqdi. Hozir ochiq: 1 savol (Logist, 40 daqiqa), 1 shikoyat. Tekshirilmagan: 0.»
- **The silent-chat Signal** (design-operations §4.2 d): a sweep step asks `unansweredChats` (`crm/unanswered.ts`, the «javob kutmoqda» rule — never restated) for the seat's chats with no draft, no case and no take-over after `agent_silent_chat_minutes` working minutes → ONE signal per hour naming the count.
- **The daily sample in full (9 a)** — ⟨1a⟩'s `agent_samples`, no new table. Pick order: every `nazoratda` act of the day FIRST (relayed colleague answers), then money replies, then system-made turns, then lowest stored `confidence`; ten in all, more only when the forced ones exceed ten. Each row on «Kunlik tekshiruv»: the customer's lines, the reply as sent (its parts), **«nima asosida»** — the gate class, the tools that vouched (names only), and for a relay «{mavzu}: {kim} javobi» with the answer; «👍 To'g'ri» · «👎 Xato edi» (⟨1a⟩: calls `autoFeedback`, `auto-send.ts:1318`) · «📝 Tuzatish» (`openLesson`, `agent/lessons.ts`). Marks by the pair (`maySpeakForSeat`). Chips «pul aytilgan · hamkasb javobi · 👎»; thirty days of history; daily while the first sample is under thirty days old, then Fridays (⟨1a⟩'s derivation). Nobody marked for 48 h → the page and the morning line say «tekshirilmagan — AI xatosi ko'rinmay qoladi».

**Untouched by every package:** `policy.ts` and the five readers beside it; `send-step.ts`, `outbox-store.ts`, `gramjs-adapter.ts` (nothing the listener executes changes); `winLead` and every sale door; `calc-loop.ts`'s VED-answer run and `calc-price.ts`'s arithmetic; `staff/**`, `kpi-*`, the rating (31 c); `seesAllTg`; the `ag:` grammar and its twenty-six letters; ⟨1a⟩'s fallback chain; ⟨1b⟩'s week clock, parts and holding-line rules.

## 5. Doors and sight

| Thing | Who | Predicate |
|---|---|---|
| ✅ ✏️ ❌ ⏸ 👎 on any reply; 🙋; writing from the seat in the CRM; «🤖 AI davom etsin»; closing a complaint; marking the sample | the supervisor pair, and only while the holder IS the AI seat | ⟨1b⟩ `maySpeakForSeat` (never a role key) |
| Answering a case | a person holding an open route of it, or the pair | `answerCase` — the route row; the id in a button or a form is never trusted |
| 📌 / 👤 knowledge, a lesson | the supervisor alone | ⟨1b⟩ `mayApproveKnowledge` |
| The designation screen, the switch, the caps | the `super_admin` role (⟨1a⟩ `setDesignations`, the `setAgentSeat` precedent) | read: `mayRunAgent` (`config.ts:314`) |
| `/suhbatlar/ai?bolim=quti` | holder / super_admin / the pair | `agentDoorsFor` ∪ pair |
| `/ai-savollar`, `/aiquti` | any login — own routes only | SQL `user_id = actor.id` |
| «Tekshirdim» on a Signal | whoever was sent it | the ack row |

**Law 4 on every card** — sight is a property of the RECIPIENT (`upsaleScopeFor`), never of being designated: a deputy who is a seller reads as a seller.

| Card | Sight `all` (owner, accountant) | Sight `own` (a seller) | Sight `none` (a VED) and everyone else |
|---|---|---|---|
| Case card (question, complaint) | question + cited customer lines, raw | lines raw only on HIS own customer's case; otherwise masked | lines with every money figure «(summa)»; never our own lines |
| The question itself | holds no numeral beside a currency for anybody — the tool refuses it (⟨1b⟩) | | |
| Draft card `calcLine` — `cardLineOf` (`calc-markup.ts:106`, printed at `card-io.ts:523`): VED figure + rule + client price | shown | **absent** | **absent** (⟨1b⟩ `cardSightFor`; 3a re-proves it for a climbed card) |
| `AgentCalcAnswered` — «…{section}: {amountText}», the VED's own figure (`calc-loop.ts:165-168`) | shown | no amount | no amount |
| A relay redraft's card | the pair only | — | — |
| Hand-over task | phone, hour, cited lines; never a price | same | same |
| The redraft for the customer | a VED's money never reaches it (refused at the door, §4.2); any figure → `owner_figure` | | |

**The fifth leak of `critic-feasibility.md` §A row 32** is not a card: `seesAllTg` (`crm/conversations.ts:41`) lets every holder of `ved.docs` read every account's chats — the seat's too, with the client price the AI told. It is his own rule of 2026-07-31 and his 16 a (`offerSightFor`, `calc/upsale-scope.ts:100`). 3a changes NOTHING there and asks him (§11 Q2). **Identity before cargo or money**: a `proof: 'cargo'` topic opens no case in an unproven chat; the redraft is still judged by `chatIdentity` / `cargoAllowed` and `owner_personal`; a colleague's answer never widens what a chat may hear.

## 6. Prompt, policy and gate

**6.1 Prompt** (`agent/prompt.ts stableHead`, rule numbers at HEAD — ⟨1a⟩/⟨1b⟩ re-word 12-14; ONE cache write on deploy day):
- rule 13 (`:86`) → «Shikoyat, jahl, pul talabi, huquqiy gap, "menejer kerak" — o'zing hal qilma, va'da berma, kechirim so'rashni ham tizimga qoldir: ask_owner(topic="other").»
- rule 14 (`:87`) → + «Mavzuni tanla: bojxona, sertifikat, "kiritsa bo'ladimi" → customs · mashina qayerda, nega kechikdi → logistics · "pul tushdimi", to'lov → money · olib ketish, sklad, "yukim kodsiz kelibdi" → warehouse · karta raqami → card_number · narx, chegirma va qolgan hammasi → other. Bilmasang — other.»
- new «"Telefon qiling" desa: raqamini (kartadagi raqam bo'lsa — shuni tasdiqlat) va qulay vaqtini so'ra, keyin hand_over(kind="callback"). "Zavoddan olib keling" → hand_over(kind="pickup"); "sotib olib bering" → hand_over(kind="buying"): nima yetishmasligini vosita aytadi, hammasini bitta xabarda so'ra. Bu xizmatlarning narxini AYTMA. "Yubordim", "qo'ng'iroq qilishadi" deb o'zing yozma — tizim yozadi.»
- new «To'lov usullari — bilimlardan. Karta raqamini HECH QACHON o'zing yozma: ask_owner(topic="card_number").»
- chat block (per run, not the head), only when `colleagueOf` answers: «HAMKASB MIJOZI: bu mijozning o'z menejeri bor. Yuk holati, manzil va jadval narxini ayt; pul, chegirma, qarz, yangi hisoblatish — ask_owner (tizim menejeriga yuboradi).» + «Menejeri narx bergan — jadval narxini AYTMA.» when it stands.

**6.2 Rules by code name.** `policy.ts`, `numbers.ts`, `digits.ts`, `locale.ts`, `destination.ts`, `auto-money.ts`: **no check changes.** Gate (`auto-gate.ts`): `owner_figure` (`:415`), `owner_personal`, `answer_stale` — unchanged, now asked of any answerer's redraft; `complaint` ⟨1a⟩ — also TRUE for every non-`talk` reply while a complaint case is open in the chat; NEW `colleague_relay` — a relay whose act position is `sorab`; `human_active` (`:450`), `not_reply`, `calc_foreign`, `language`, `media`, every money code — untouched. New refusals of the answer door (`colleague_money`, `verbatim_shape`) and of the tools (`seller_price`, `unproven`, `case_open`) are words for a person or the model, never gate codes; each gets a key in `suhbatlar/ai/labels.ts` and four bundles (`tests/unit/agent-web-labels.test.ts`).

**6.3 System wording** (propose to him; code constants beside ⟨1b⟩'s holding lines; uz / uz-cyrl / ru / en written by the builder, fa / zh stored with an Uzbek gloss and sent only after he approved them once — until then that chat gets the card and no line):
- call-back, uz: «Raqamingizni menejerimizga berdim — sizga qo'ng'iroq qiladi.» · ru: «Передал ваш номер менеджеру — он вам позвонит.» (+ when an hour was named: «Qulay vaqtingizni ham yozib qo'ydim.» — never «soat …da»)
- hand-over: «Ma'lumotlaringizni mutaxassisimizga berdim — u siz bilan bog'lanadi.» · ru: «Передал ваши данные нашему специалисту — он свяжется с вами.»
- complaint: «Noqulaylik uchun uzr so'raymiz. Murojaatingizni rahbarimizga yetkazdim — javobini shu yerga yozaman.» · ru: «Приносим извинения за неудобство. Передал ваше обращение руководителю — ответ напишу сюда.»
- the seller calls: «Menejeringiz {ism} siz bilan o'zi bog'lanadi.» · after a table price on a colleague's customer: «Aniq shartlarni menejeringiz {ism} aytadi.»
- a colleague's card: «❓ AI sotuvchi so'rayapti — {mavzu}» / «{GS777 · Ism}» / «Savol: …» / «│ {mijoz satri}» / «Javobni shu xabarga reply qilib yozing. Narx yozmang — narx hisoblash orqali beriladi.» · the climb line (⟨1b⟩): «⏰ {N} daqiqadan beri javobsiz ({kim}) — siz ham javob bera olasiz.»

**6.4 Corpora and fences that stay green.** `tests/unit/agent-reader-corpus.test.ts` (`fixtures/agent-reader-corpus.ts`, `-eval.ts`, ratchet `-known.ts`): **no existing case changes its label** — in particular every `OWNER_DANGEROUS` row («his figure relayed without his ✅») must hold when the same text is a COLLEAGUE's answer: the eval's owner-answer reader is run a second time with `answeredBy` a non-pair fixture, same labels. ADD two readers, labels written by hand: `colleague_answer` (dangerous: «boji 300 dollar bo'ladi» from VED sight must be refused at the door; «3 kunda keladi», «500 $ tushgan» must never go by themselves · ordinary: «ha, kiritsa bo'ladi, sertifikat kerak emas» goes) and `card_mask` (a customer line with a price in each of six languages, in words and in digits, is masked for `none` and raw for `all`). The ratchet may only shrink. `tests/unit/agent-policy-first-reply.test.ts` — untouched and green; if it moves, a check moved. `docs/ai-toliq/corpora/customer-safety/*.json` (⟨1a⟩ copies them to `tests/unit/fixtures/agent-customer-safety/`): every case still held, also when the dangerous text arrives as a colleague's answer redraft. Fences: `agent-fences.test.ts` (closed toolset + `hand_over`; the purge lists; the `ag:` grammar unchanged), `notification-mutes.test.ts`, `redelivery-wire.test.ts` (`PRESS_REPEAT`), `tx-pool.test.ts`, `login-person-fence.test.ts`, `upsale-scope.test.ts`, `chat-controls.test.ts`, `tg-listen-agent-wire.test.ts`, `migration-journal.test.ts`, `i18n-keys.test.ts`, `locales.test.ts`.
**EXPECTED to change, the reason written in each test's title:** ⟨1b⟩'s `agent-cases` / `agent-escalation` rows «a case goes to the supervisor» → «…to its topic's route when routing is on» · ⟨1b⟩ `agent-speakers` «only the pair answer a case» → «…or a route holder» (PRESSING a reply stays the pair's) · `tests/integration/outbox.integration.test.ts` where it pins `replyAccountFor` «own account only» (`:118`, `:146`) → «…or the pair on the AI seat» (`tests/unit/chat-controls.test.ts:45` only pins that the ⋯ menu is gated by `replyAccountFor` — it stays green unedited) · `topshiriq-buttons` / `topshiriq-wire` (the fifth origin) · `agent-web-labels` (the new section) · `agent-morning` / `agent-sample` ⟨1a⟩ (new lines, new pick order). No corpus label changes.

## 7. Tests to write (each shown RED by a paired string edit — never `git checkout`, #430)

**Unit**
- `agent-routing.test.ts` — `routePlan` as a matrix: every topic × routing on/off × probe behind × night × cap reached × unreachable × colleague's customer × unproven chat × complaint hit; the fallback never answers «nobody».
- `agent-topics-registry.test.ts` — every topic has route / mode / proof and a label in four bundles; **source-shape**: no role-key literal and no uuid literal in `routing.ts`, `handover.ts`, `colleague.ts`, `takeover.ts`, `inbox.ts`, `case-sight.ts` (TypeScript's parser, comments stripped — #725).
- `agent-case-sight.test.ts` — `maskMoney` in six languages (digits, words, a currency before and after); `caseTextFor` × three sights × own / foreign customer.
- `agent-colleague-answer.test.ts` — the door: VED money refused with the read figure named; an accountant's money accepted; `verbatim` takes a card number and refuses a sentence; the wait stays armed.
- `agent-handover.test.ts` — the three checklists (pure); the note is the cited lines byte for byte; the idem key.
- `agent-seller-price.test.ts` — `sellerPriceStands` over quote / offer / age; `colleagueOf` agrees with `machineMayTouch` on every card shape.
- `agent-inbox.test.ts` — `inboxKindOf` is total over the union; `agent-inbox-callbacks.test.ts` — every `aq:` button a card DRAWS parses, and `PRESS_REPEAT` classes the kind.
- extend ⟨1b⟩ `agent-holding-lines.test.ts` with §6.3's sentences (0 blocks, 0 warnings, no numeral, no `timePromise` / `dayPromise`, its own locale) and ⟨1b⟩ `agent-work-clock.test.ts` with `nextWorkMoment` (LITERAL Tashkent dates).

**Integration** (own chats and users; designations, settings and rights snapshotted in `beforeAll` and restored — #183, #716; a seeded row never rewritten — #1682; fixture users deactivated, never deleted)
- `agent-inbox-kernel` — the probe both ways; each CHECK takes its new value and refuses a stranger; a real `tasks` insert with origin `agent`.
- `agent-routing` — rota fairness (three questions → three people); the open-calculation VED wins over the rota; the cap; `notify_after` at 23:00 = the next working morning and NO climb before it; the climb reaches supervisor AND deputy once; the first answer closes the other copies.
- `agent-colleague-relay` — answer → run → a figure-free reply goes (position `nazoratda`) and is in the sample; a figure → a pair card; `sorab` → a card; stale answer; `verbatim` → two parts, always a card, the model never called (a stand-in `deps.callModel`, `run.ts:69`, that throws).
- `agent-card-sight-3a` — over EVERY seeded role (the #790 matrix): no money figure on a case card for `none`; no `calcLine` / amount on a climbed card for `own` and `none`.
- `agent-handover` — a task with origin `agent` for the designated person; a no-login designee → the next; completion closes the case and writes the record; the system line is queued; the second request the same day is one task.
- `agent-colleague-client` — the table price goes with no seller price and is refused with one; a money question → the seller's card; «O'zim bog'lanaman»; the climb.
- `agent-complaint` — the system line once; the case survives the week's sweep; reminders in working time only; non-`talk` replies held while open; close by the pair only.
- `agent-takeover` — 🙋 writes the ledger; give-back clears `human_until` and the next customer line is eligible although the person wrote a minute before; the ask before resume, once; the pair may queue from the seat, a colleague and a personal account's stranger may not.
- `agent-knowledge-offer` — 📌 only on the supervisor's copy; the deputy and the answerer refused; money refused.
- `agent-inbox` — the counts equal the lists; a colleague sees only his own; the pair see all.

**E2E** — `m9zzzi-ai-quti.spec.ts` (sorts after ⟨1b⟩'s `m9zzzh-ai-suhbat`; NOTE: at HEAD the prefixes `m9zzzh-` and `m9zzzi-` are already taken by other specs — `m9zzzh-tarkib-ai`, `m9zzzh-yoldagi-yuk`, `m9zzzi-prixod-karta`, `m9zzzi-prixod-xabari` — and the tail of `tests/e2e` is `m9zzzj-sotuvchi-yuk.spec.ts`; file names carry the run order, so read the tail on your tree and name the spec so that it sorts LAST): the section with five chips; the designation screen saved and put back as a final TEST (#183); `/ai-savollar` as a non-pair demo person answers a seeded case; `/bugun` shows the row; 360 px in `ru`, `documentElement.clientWidth` (never `innerWidth`).

**Red proofs**

| Strip | Must go red |
|---|---|
| the sight test out of the answer door's money refusal | `agent-colleague-answer` (the VED figure is stored) |
| `maskMoney` from `caseTextFor` for sight `none` | `agent-card-sight-3a` |
| the «raw for his own customer only» clause | `agent-case-sight` (a seller reads a stranger's price line) |
| `answeredBy` out of the `owner_figure` input | `agent-colleague-relay` (a figure goes by itself) and the corpus's second pass |
| the night branch of `notify_after` | `agent-routing` (a card at 23:00) |
| the working-time clock → wall clock in the climb | `agent-routing` (a climb at 09:01 for a 18:55 question) |
| the cap skip | `agent-routing` |
| the `returned_at` clause in `eligibilityFacts` | `agent-takeover` (`human_active` after give-back) |
| the pair test in `replyAccountFor`'s seat branch | `agent-takeover` (a colleague queues from the seat) |
| the `sellerPriceStands` refusal | `agent-colleague-client` |
| `mayApproveKnowledge` → `maySpeakForSeat` on the 📌 | `agent-knowledge-offer` (the deputy saves a fact) |
| the complaint kind out of the expiry sweep's skip | `agent-complaint` |
| the model call guard of `verbatim` | `agent-colleague-relay` (the stand-in throws) |

A red proof that stays green is evidence about the fixture (#166) — re-anchor it first.

**Provable only on the live server** (no Telegram and no model key here): that the model picks the right topic and calls `hand_over` instead of promising; that a colleague's swipe-reply on a real phone lands on its case; the order and timing of card → answer → customer. He checks with one day on staff phones: three colleagues write the seat as customers («mashina qayerda», «pul tushdimi», «telefon qiling», a complaint), then `docker compose logs app | grep '\[agent\]'`, the «Istisnolar» section, each designated person's `/aiquti`, and the next morning's report.

## 8. Order of work

1. **Start gate**: 1c confirmed live; `git fetch origin main`; read the journal's and DECISIONS' tails; re-read every ⟨1a⟩/⟨1b⟩ name on that tree and re-fit §3-§4; judge this plan (send / leak / regression / the owner's eye, a refuter per finding — the leak lens gets §5's table and the six card builders); ask him §11.
2. **K** (§4.0), alone and reviewed, green with the probe forced behind AND ready and `agent_routing = 'pair'` — at that point nothing the customer or the owner sees has changed.
3. **Worktrees off K** (name K's hash to each agent; two at a time on 4 CPUs): **P1** «Yo'naltirish» · **P2** «Javob» · **P3** «Topshirish» · **P4** «Hamkasb mijozi» · **P5** «Shikoyat va navbat» · **P6** «Quti». Shared files: `run.ts` — P4 owns the chat-block line, P5 the `eligibilityFacts` read; `tools.ts` — P1 the `ask_owner` schema, P3 `hand_over`, P4 the two estimate refusals; `decide.ts` — P5 only; `prompt.ts` — the lead merges §6.1 once, after the packages.
4. **Merge** P1 → P2 → P4 → P3 → P5 → P6 (P6 reads everything). Review AS MERGED, then review the fixes.
5. **Ritual** (CLAUDE.md): postgres up; a fresh database; migrate, seed once, vitest, `NODE_OPTIONS=--max-old-space-size=3072 pnpm build`, `fuser -k 3000/tcp`, Playwright without re-seeding and without `CI=1`; `pnpm typecheck && pnpm lint`, each gate's own failure marker read; the reader corpus BEFORE and after any touch of the owner-answer readers or `auto-gate.ts`; `DATABASE_URL` set for every local vitest run.
6. PR → green → merge → his deploy → one day on staff phones with routing ON for one topic → the rest.

## 9. Deploy

- **Ledger**: the journal's length that day (one more than before — read it, never carry a number), and `curl -s https://gsrwms.uz/api/version` must read today. Backup first.
- **tg-listen MUST be rebuilt** (`agent/queues.ts` changes and the listener imports it — `tests/unit/tg-listen-agent-wire.test.ts`): `docker compose build migrate app`, then the telegram profile's build. No listener BEHAVIOUR changes (§4.5).
- **Scripts through `migrate`**: none is required. (If a count is wanted before the flip: `agent-stage0.ts volume` of ⟨1a⟩.)
- **He touches, in order**: (1) «Kim javob beradi» — people for the eight new topics; «Sinov kartasi» to each; whoever shows «Telegram ulanmagan» links the staff bot first; (2) «Bilimlar» — one fact with the ways to pay and «to'lov Toshkentda, yukni olishdan oldin»; (3) reads and approves §6.3's sentences (fa / zh by their gloss); (4) flips «Hamkasblardan so'rash» to «yoqilgan». Nothing is flipped for him: the deploy alone changes only the inbox's look, `/aiquti`, the take-over ledger and the reports. The command menu IS set per chat (verified: `offerStaffCommands`, `platform/telegram/commands.ts:28`, `setMyCommands` with `scope: {type: 'chat'}`; called from `bot.ts:348,354,439,478` and `staff-handlers.ts:733` — at `/start`, `/hodim` and a staff link) — so each designated person sends /start (or /hodim) once for `/aiquti` to SHOW in the menu; the typed command and the cards work without it.
- **First morning**: at 08:40 the full report; during the day colleagues' cards with «reply qilib yozing»; in «Istisnolar» every open row with whom it waits on; at 20:10 the sample with «nima asosida».
- **Rollback**: flip `agent_routing` to `pair` FIRST (no new route, complaint or hand-over rows are written; open ones are closed on the page), then the old images. The migration stays (it only widened and added). Tasks of origin `agent` read as hand-given tasks to the old code (it tests `origin !== 'automation'`), minus their note line. UNVERIFIED: how ⟨1b⟩'s code draws a case of a kind it does not know — read its switch before promising this.

## 10. Risks, traps, stated-not-built

- **Colleagues' words were written for a colleague.** A logist types a truck's name, a warehouse manager a carton count, an accountant another customer's payment. Behind the relay stand the unchanged policy (rule 5's fences, `owner_personal`), `owner_figure` and the sample's forced rows. UNVERIFIED: which policy code holds a batch or prixod code typed into an answer — run one through `checkAgentReply` in a scratch test before the relay is allowed to go by itself.
- **The topic is the model's label.** A wrong topic costs fifteen working minutes, never a leak: every non-pair card is money-free by construction and no topic widens identity. Do not «fix» misrouting by trusting the label more.
- **Law 4 lives in six card builders** (case, climb, draft, calc-answered, relay, task). One builder that prints `policy.card` raw re-opens leak (d). The role matrix test is the fence; a new card type must join it.
- **A designated person with no linked chat or one who left** is silence. The screen shows reach, `routePlan` skips, a Signal says so — keep all three.
- **More people = more identical system lines** (call-back, hand-over, complaint) — `fingerprint` warns; three rotating wordings per line as ⟨1a⟩/⟨1b⟩ do; stated to him as an account risk, not solved.
- **The pair typing from the CRM as the seat** is hand-typed text from the AI number: it pauses the AI in that chat (`human_pause_min`) like his phone does — say so on the composer.
- Traps: a model run awaited on the bot's poller (#706 — `answerCase` stores and enqueues, nothing more); a pooled read inside the route's transaction (#714); `values([])` on an empty route list; a `Date` in a raw `sql` fragment (#156); `FOR SHARE` over a join (#1585); a durable wait whose kind the CHECK refuses is swallowed with one warning; a Suspense boundary around the new action buttons (#1242); a missing i18n key throws at render in all four locales; the answer form must hold its text on a refusal; e2e designations left behind are CONFIGURATION for every later spec (#183).
- **Stated, not built:** the accountant's payment-claim queue and the cheque photo (stage 6) · the logist's «📣 AI ga» note ahead of the question · the AI's private suggested reply while a person holds the chat · a designation scoped to a warehouse on the screen (3a prefers people by their existing warehouse assignment) · the rights page (3b — 3a adds one row, `relay_answer`, to ⟨1b⟩'s select) · per-action step-down · the discount card (6), the code alone (5), the company bot (7) · «questions asked most often → next week's Bilimlar» (stage 9's weekly report) · a seller's relayed price on his own card · anything about `seesAllTg` until he answers.

## 11. Questions the builder must still ask him (Uzbek; ⭐ = what «sen aytgandek» builds)

1. **Hamkasbning javobi (raqamsiz).** VED, logist yoki buxgalter javob yozdi, ichida raqam yo'q: ⭐ a) AI mijozga o'zi yozib yuboradi, kechqurungi tekshiruvda albatta ko'rasiz · b) birinchi oy har biri sizning ✅ingizni kutadi. (Raqam bo'lsa — har doim sizga karta, bu o'zgarmaydi.)
2. **VED va AI raqamidagi suhbatlar.** Bugun VED hamma akkauntning suhbatini o'qiy oladi (2026-07-31 dagi qaroringiz) — AI raqamida AI aytgan mijoz narxi ham ko'rinadi: ⭐ a) bugungidek qolsin · b) AI raqami suhbatlarida VED uchun narx satrlari yopilsin (⚠ bu o'sha qaroringizni toraytiradi).
3. **Hamkasbning mijozi.** Mijozning o'z sotuvchisi 15 daqiqada javob bermasa: ⭐ a) savol sizga va o'rinbosarga chiqadi · b) faqat sotuvchini kutadi.
4. **Tungi savollar.** Tunda yoki dam olish kuni tushgan savol hamkasbga: ⭐ a) ish vaqti boshlanganda boradi · b) darhol, ovozsiz boradi. ⚠ 4-javobingiz «hamkasblarga kartalar ertalabni kutadi» edi — a) aynan shu; b) uni o'zgartiradi (xabar tunda ham boradi, faqat ovozsiz). Bu savol faqat SHU farq uchun so'raladi; so'ralmasa — a) quriladi.
5. **Shikoyat kimga.** ⭐ a) faqat sizga va o'rinbosarga · b) mijozning o'z sotuvchisi bo'lsa, unga ham nusxa.
6. **🙋 dan keyin.** Suhbatni olganingizga 24 soat bo'lganda: ⭐ a) AI «davom ettiraymi?» deb so'raydi, 10 daqiqa javob bo'lmasa davom etadi · b) so'ramasdan davom etadi (bugungidek) · c) «AI davom etsin» demaguningizcha jim turadi.
7. **O'rinbosar AI raqamidan yozishi.** 🙋 dan keyin o'rinbosar CRM orqali AI raqamidan mijozga o'zi yoza oladimi: ⭐ a) ha (5-javobingiz: faqat ikkovingiz) · b) yo'q, yozish faqat sizda, u faqat ✅ bosadi (⚠ bu 5-javobingizni toraytiradi). **Javob berilgan (5 b) — so'ralmaydi, a) quriladi**; bu yerda faqat hujjat uchun turibdi.
8. **Karta raqami.** ⭐ a) har safar belgilangan odam yozadi, siz ✅ bosasiz, AI raqamni o'zgartirmay yuboradi · b) raqamni bir marta kiritasiz, AI o'zi yuboradi (⚠ 21-javobingizda «odamdan keladi» degansiz). **Javob berilgan (21 a) — so'ralmaydi, a) quriladi.**
   *(For the builder: `qurish/COVERAGE.md` «Still to ask him» is the ONE list to send; it leaves 7 and 8 out, folds the weekend half of 4 into the working-days question, and adds one this plan raised in §4.5 and never numbered — whether the pair want a CRM composer for LEAD chats of the AI number.)*
9. **Bir hamkasbda nechta ochiq savol.** ⭐ 5 tadan oshsa keyingi odamga yoki sizga o'tadi — boshqa son aytasizmi?
10. **Zavoddan olib kelish va «sotib olib berish» uchun AI nimalarni yig'sin** (§4.3 dagi ro'yxat): ⭐ a) shu ro'yxat · b) o'zingiz qo'shasiz / qisqartirasiz.

## Verified references

Checked at HEAD **`bf37150c`** (journal tail `0150_batches_view`, 151 SQL files) by a reference verifier, no code run. **83 `file:line` references, each opened, and about 75 named things** (functions, constants, types, constraints, settings homes, test files, docs sections, DECISIONS numbers, callback prefixes, screen names in `messages/uz.json`) grepped and read. Names marked ⟨1a⟩ ⟨1b⟩ ⟨1c⟩ were checked against `STAGE-0-1A.md` / `STAGE-1B-1C.md` only (they are plans, not code) — all found there. Everything not listed below was found as written.

Corrections made (old → new):
- K6: the parser's range `staff-bot.ts:749-822` and prefix list `c n t tb tp d dk fb lc cl cu ag pf a` → `parseCallback` is `:744-831`; the list also holds `e:s` `e:c` `jy`, the eight `TASK_PREFIXES` (`tk tw tq tr tn te tc tf`) and `ca cg cf`. `aq` is still free (grep of `src/`).
- K7: «`assignedNoteLine` prints the note for `hand` only» → for `hand` AND a NULL origin (`tasks/service.ts:349-350`).
- §4.4: «handlers (`tools.ts:181-192`)» → those lines are the tool SPECS (`:181-191`); the dispatch is `:444-447`, the handlers `yolkira` `:535` and `avia` `:630`.
- §4.5 «Where the pair write»: the claim that ONE branch in `replyAccountFor` lets the pair write from the seat was incomplete — `replyAccountFor(clientId, actorId)` is keyed by a CLIENT and `tg_outbox.client_id` is NOT NULL, so at HEAD no CRM composer exists for a LEAD-owned chat (most of the seat's chats before a code). **Step re-thought:** the branch covers coded clients only; for lead chats the pair write from the seat's phone or by ✏️ on a card; `tg_outbox` is not widened here; a lead composer is a new question for him. The test that pins «own account only» is `tests/integration/outbox.integration.test.ts:118,146`, not `chat-controls.test.ts` (that one pins only that the ⋯ menu is gated by `replyAccountFor`, `:45`, and stays green).
- §4.6: `#463` → `#466` (the decision about the compose box keeping its text on a refusal).
- §5: `offerSightFor`, `calc/upsale-scope.ts:99` → `:100`.
- §7 E2E: `m9zzzi-ai-quti` «sorts after ⟨1b⟩'s `m9zzzh`» → noted that `m9zzzh-` / `m9zzzi-` are taken prefixes at HEAD and the tail is `m9zzzj-sotuvchi-yuk.spec.ts`; the spec must be named to sort last on the builder's tree.
- §9: `UNVERIFIED: whether the command menu is set per chat at /start` → VERIFIED and the mark removed: `offerStaffCommands` (`platform/telegram/commands.ts:28`) sets it per chat (`scope: chat`), called at `/start`, `/hodim` and the staff link (`bot.ts:348,354,439,478`, `staff-handlers.ts:733`).

Flags (nothing to fix in this file): no model identifier, no person's name, no user id, no role key written as code content, no literal migration number. For the builder's eye: at HEAD the CODE itself still holds the owner's first name in three strings the model reads (`agent/prompt.ts:85`, `:87`; `agent/tools.ts:394`) — ⟨1a⟩'s persona work must take them out; this plan's own proposed prompt lines hold none.

Still `UNVERIFIED` (kept): the name and list of ⟨1b⟩'s `agent_cases` kind CHECK; how ⟨1b⟩'s code draws a case kind it does not know; which policy code holds a batch or prixod code typed into a colleague's answer.

## Conformance

Checked against design §11, the contract's §4 and the other six plans (`qurish/COVERAGE.md` holds the trace).
No answer of his was contradicted. What was changed, and why:

1. **§3.1 — no CHECK is re-made twice.** This plan re-made `agent_cases`' kind CHECK and `tasks_origin_check`.
   ⟨1b⟩'s one migration now reserves `complaint`, `handover` and the task origin `agent` (`STAGE-1B-1C.md`
   §3.1-§3.2), so 3a is their FIRST WRITER and re-makes a constraint only where 1b as built left the value out.
2. **§3.3, §4.6 — one word for the pair.** «Nazoratchi va o'rinbosar» and the group «Nazorat» → «Rahbar va
   o'rinbosar» (the key stays `supervisor`); the card words already said «rahbar».
3. **§4.2 — the position of `relay_answer` has one store**: a row of ⟨1b⟩'s `agent_action_rights` under the act's
   own key, drawn on ⟨1c⟩'s list, adopted unchanged by 3b.
4. **§11 — three questions were already answered.** Q7 (the deputy writes from the number) is his 5 b and Q8 (the
   card number) is his 21 a: both are marked «so'ralmaydi» — their ⭐ is what he chose and option b would reverse
   it. Q4's option b reverses his 4 a («cards to colleagues wait for the morning») and now carries the ⚠ the
   contract demands. The one list to send him is COVERAGE's.

Confirmed, unchanged: every «who» is `designated(topic)` with the pair as fallback and `vedRotaPool()` for customs
— no name, id or role key (the source-shape test of §7 holds six files to it); a VED's figure is refused at the
answer door, so it can never be relayed «as given» (law 4) and every card is drawn per recipient sight; ANY figure
in a colleague's answer comes back to the pair as a card (`owner_figure`); only the supervisor approves
knowledge; the complaint label and the tripwire hold, and a complaint is never answered by model prose first; the
pair's typing still pauses the AI; nothing climbs at night (4 a); no word rule or reader changes; no dollar
ceiling; `staff/**`, KPI and the rating are untouched (31 c); one additive migration with its probe
(`agentInboxReady`), numbered «next after the journal's tail», and `agent_routing` ships `pair` — nothing is
flipped for him.
