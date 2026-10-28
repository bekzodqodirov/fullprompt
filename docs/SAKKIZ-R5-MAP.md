# Sakkiz band ROUND 5 — the code map (companion to `SAKKIZ-R5.md`)

Every file and function round 5 touches: where it is, what it does today (one line), what
changes, and which package owns the change (K = the lead's kernel, P1-P6, M = the merge
step). The contract — signatures, rules, words, tests — is `SAKKIZ-R5.md`; this file is
where to look. Both are committed at handoff as `docs/SAKKIZ-R5.md` and
`docs/SAKKIZ-R5-MAP.md`; the building session (the lead) updates them with K's hash.

**Line numbers.** `(R2)` = read on `r2-on-tip` @ `52171ca` (the branch head `62a23bf` +
round 2 as built); `(head)` = `62a23bf` where R2 did not touch the file; `(R3 spec)` = a
line of round 3's spec (`docs/SAKKIZ-R3.md` once merged; not built when this was written).
**R5 starts from `main` after R2 AND R3 are merged (the spec's header gives the observable
check) — re-find every line there before editing**; a function R3 moves (the collector's
reading, the store) is named by its R3 home. Three references were corrected after the
judge (`hub-doors.ts:78-84`, the similar route `:147`, `review.ts:29-42`).

**No model identifier appears in this file.** The two id constants are named by their
source names (`ANALYST_MODEL`, `STAFF_MODEL`); the family words are not written either.

SDK facts the design rests on (verified in `node_modules/@anthropic-ai/sdk`, version
**0.114.0**, `package.json` `^0.114.0`):
- `output_config.effort` is typed (`resources/messages/messages.d.ts:858`,
  `low|medium|high|xhigh|max`); `StopReason` (`:1046`) includes `refusal` and
  `model_context_window_exceeded`; `Message.stop_details` carries the refusal `category`;
  `Usage` has `output_tokens_details.thinking_tokens` (`:865-877`) and
  `cache_creation.ephemeral_1h_input_tokens` (`:170`).
- **The stream accumulator** (`lib/MessageStream.js:448-468`) updates `output_tokens` only
  on `message_delta` (the END of the stream — an aborted stream keeps `message_start`'s ~1
  output token) and copies `output_tokens`, `input_tokens`, the two cache totals and
  `server_tool_use` — it DROPS `output_tokens_details` (measured: `thinking_tokens` reads
  null on every streamed call unless the runner keeps the last `message_delta` itself).
  Non-API errors are wrapped as a bare `AnthropicError` (`:37-55`); «stream ended without
  producing a Message» (`:340-350`).
- `client.models.list()` returns `ModelInfo` with `capabilities: ModelCapabilities | null`
  (`resources/models.d.ts:131`; field paths `:54-150`) and `max_tokens`, and NO price.
- The server-side `fallbacks` parameter exists only on the beta namespace (its simplest
  form untyped).
- The client `timeout` stops bounding a STREAM once headers arrive (`client.js:654-665`) —
  a stream needs its own `AbortSignal`; a mid-stream SSE `error` throws a bare `APIError`
  with `status === undefined` (type at `err.error.error.type`).
- The SDK's own retry reads `retry-after-ms` / `retry-after` (`client.js:736-745`); the
  runner turns SDK retries off, so `retryPauseMs` takes that rule over.
- `MessageStream` exposes `response` / `withResponse()` (`lib/MessageStream.d.ts:30-45`) —
  the rate-limit headers are read from there.
- A parsing output format (`'parse' in output_config.format`) is parsed inside the stream at
  `message_stop` and THROWS on a refusal or cut JSON (`lib/parser.js:9-27`, `:54-63`) — the
  runner's `format` is typed so no such object can be passed.

Other installed facts: Node 22's `AbortSignal.timeout` throws `ERR_OUT_OF_RANGE` for a
non-integer or negative delay; pg-boss **10.4.2** enforces `singletonKey` only on the
short / singleton / stately queue policies (`node_modules/pg-boss/src/plans.js:336-348`),
inserts with `options.id` `ON CONFLICT DO NOTHING`, and fails an orphaned active job only on
its maintenance tick (default 120 s, `src/attorney.js:301-305`; `plans.js:566-567`);
postgres.js sends a JS number untyped (`node_modules/postgres/src/types.js:220-229`), so an
untyped `VALUES` column resolves to `text`.

---

## 1. New files

| File | Package | What it holds |
|---|---|---|
| `src/modules/platform/numbers/number-cell.ts` | K (K0) | `readNumberCell`, `NumberCell`, `numberOrNull` — MOVED whole from `wms/calc/number-cell.ts` (zero-import), which re-exports it |
| `src/modules/platform/numbers/fit-numeric.ts` | K (K0) | `fitNumeric` — MOVED from `wms/customs/import-parse.ts:264`, which re-exports it |
| `src/modules/platform/ai/tiers.ts` | K | `AI_TIERS`, `AiTier`, `AiEffort`, `EFFORT_ORDER`, `AiNeed` (the vocabulary's one home), `ModelSnapshot`, `ModelChoice`, `TierPlan` (+ `borrowed`), `tierPlan` (pool, 60 s cache on `globalThis`, TOTAL, fast borrows heavy), `forgetTierPlans`, pure `clampEffort` / `clampMaxTokens` / `canServe` |
| `src/modules/platform/ai/profiles.ts` | K | `AiJob`, `AiJobProfile`, `AI_JOBS` (the §4 table, whole), `FALLBACK_FLOOR_MS`, `AI_STREAM_OUT_TOK_PER_S` — imports the vocabulary type-only |
| `src/modules/platform/ai/failure.ts` | K | `AiCallFailure` (incl. `off`); `aiFailureOf` + `retryAfterPause` + `AI_ATTEMPTS` / `AI_RETRY_PAUSE_MS` MOVED from `intake-ai.ts`; `retryPauseMs`; the 404 and mid-stream branches |
| `src/modules/platform/ai/run.ts` | K | `runModel` (total; stream + abort leash + caller signal; the month gate before each request; ≤ 1 retry honouring `retry-after`, ≤ 1 hop, ≤ 3 requests; clamps; started streams billed with an estimate; attempts returned; one log line with rate-limit headers), `AiRunOptions`, `countTokens` |
| `src/modules/platform/ai/ledger.ts` | K | `AI_CALL_KINDS`, `AiCallUsage` (+ `requestedModel`), `usageOf` (merges the last `message_delta`, clamps), `AiCallAnchor`, `recordAiCall` (casts, ledger-failure alarm), `attachIntakeCalls` (R3's body moved), `fillUnpriced`, `fillUnpricedAll`, `repriceMonth`, `aiCostSql` / `aiCostUsd` (BigInt), `CALC_BUDGET_KINDS`, `aiMonthSpendSql`, `aiMonthSpend`, `spendGateMonth` |
| `src/modules/platform/ai/ready.ts` | K | `aiReady` (key → tier → month → day cap; total; `'off'`), `dayBudgetLeft` (the day cap's body MOVED from `ai-cost.ts`) |
| `src/modules/platform/ai/door.ts` | K | `mayManageAi`, `aiManagers` |
| `src/modules/platform/ai/alarms.ts` | K (inert) → P1 | `checkSpendLevel`, `noteModelUnavailable(tier, report)`, `noteKeyRefused`, `noteLedgerFailure`, (P1) `noteUnpriced`; pure `nextSpendLevel` (K) |
| `src/modules/platform/ai/models-list.ts` | P1 | `ListedModel`, `ModelList`, `ListState`, pure `toListedModel`, `liveModels` (one 10 s signal over all pages), `cachedModels` |
| `src/modules/platform/ai/tier-save.ts` | P1 | `saveTierChoice` (list rules, parse, projection/confirm, fill, re-price) |
| `src/modules/platform/ai/prices.ts` | P1 | `setModelPrice` (same price half; no list for a model already in tiers/ledger) |
| `src/modules/platform/ai/spend-report.ts` | P1 | `aiMonthBreakdown` (screen-only: by kind/job, by model, refusals, fallbacks, unpriced, estimated, the ledger-failure count) |
| `src/app/(protected)/admin/ai/{page.tsx, actions.ts, errors.ts, tier-form.tsx, price-form.tsx, state-class.ts}` | P1 | the screen «AI: modellar va xarajat»; `state-class.ts` = the literal badge class map |
| `src/modules/wms/calc/thread-read.ts` | K (skeleton) → P4 | `JOB_CALC_THREAD_READ`, `JOB_CALC_THREAD_SWEEP`, `ThreadReadJob` (+ `selectionKey`), the THREAD_* constants (+ `THREAD_PROMISE_MS`), `runThreadRead`, `sweepThreadReads`, `threadReadsPending`, `tellPresser`, `registerCalcThreadReadWorker` (includeMetadata, batchSize 1, the 10-min schedule), `threadActorFor` |
| `src/modules/wms/calc/compare/{select,inputs,score,budget,report,note-material,results}.ts` | P6 | the comparison's reads, input builders, pure scoring/budget/report, `materialOfNote`, the JSON-lines results file |
| `scripts/ai-solishtirish.ts` | P6 | the comparison's glue (read-only URL, dry run, `--run --max-usd`, `--requests`, `--resume`, `--report-from`, `--models`) |
| `src/modules/platform/db/migrations/0137_ai_spend.sql` + journal entry | K | §12 of the spec (number = the journal tail's next, after R3's `calc_intake_durable`) |
| `tests/unit/helpers/anthropic-stand-in.ts` | K | ONE stand-in HTTP server, built whole in K: `json-error`, `sse-message` (text / thinking / tool_use, thinking tokens only in `message_delta`), `sse-refusal`, `sse-stall`, `sse-error`, `hang`, `models-pages`; a script queue and a request log |

---

## 2. `src/modules/platform/ai/` (existing)

| Where | Today | Change | Pkg |
|---|---|---|---|
| `model.ts:17-20` `ModelBlock` | text, tool_use, tool_result | + `thinking` {thinking, signature}, + `redacted_thinking` {data} | P5 |
| `model.ts:27-33` `ModelRequest` | `{ model, system, messages, tools, maxTokens }` | − `model`, − `maxTokens`; + `job`, `plan?`, `startOn?`, `leashMs` | P5 |
| `model.ts:35-38` `ModelResponse` | `{ stopReason, content }` — no usage, no model | + optional `attempts?`, `failure?`, `servedBy?`; a `truncated` failure carries its content | P5 |
| `model.ts:42-44` `aiConfigured()` | `Boolean(process.env.ANTHROPIC_API_KEY)`, synchronous | UNCHANGED (sync menu/button gates depend on it; «no model» is a call-time word) | — |
| `model.ts:51-52` `ANALYST_MODEL`, `STAFF_MODEL` | the only two model-id literals in `src/` | DELETED after every package stopped importing them | M |
| `model.ts:61` `CALL_TIMEOUT_MS = 60_000` | the assistant's per-call deadline | deleted (the profile's leash) | P5 |
| `model.ts:63-102` `realCallModel` | `new Anthropic({ timeout: 60 s, maxRetries: 1 })`, non-streaming, drops thinking blocks, usage and model | `runModel({ job, …, read: m => m })`; maps thinking both ways; returns attempts/failure/servedBy | P5 |
| `assistant.ts:45-50` `AskOutcome` | ok · gave_up · not_configured · limit · error | + ceiling · off · refused · model_not_chosen · model_unavailable · server_behind · truncated (carries `answer`) | K |
| `assistant.ts:60-64` `MAX_ROUNDS`, `WALL_CLOCK_MS` 120 s | wall checked only BETWEEN rounds | wall per job and surface (staff 120 s; admin 180 s bot / 240 s web); round leash = min(profile, wall − elapsed) | P5 |
| `assistant.ts:109-129` `reserveQuestion` | per-person advisory lock + insert under the day cap | unchanged; the tier plan is resolved AFTER its transaction | — |
| `assistant.ts:131-232` `askAssistant` | key → day slot → ≤ 6 rounds; `model: isAnalyst ? ANALYST_MODEL : STAFF_MODEL` (`:167`); `maxTokens: 2048` (`:171`); `if (text) lastText = text` before the stop check (`:179`); a `max_tokens` round's text returned as `ok` (`:181-190`) | `deps.ready` / `deps.plan` seams; `aiReady` between the key and the slot; `assistantTier`; plan once per question; bill every attempt (`kind 'assistant'`, question anchor); sticky fallback; failures → statuses; refused text never returned; truncated text kept | P5 |
| `tools.ts:30-32` `isAnalyst` | ROLE super_admin/admin | unchanged; `assistantTier(actor)` added beside it | P5 |
| `tools.ts:44-46` `hasMoneyTier` | analyst ∧ money sight → `run_sql` etc. | unchanged (deliberately NOT the tier predicate) | — |

---

## 3. `src/modules/wms/calc/`

| Where | Today | Change | Pkg |
|---|---|---|---|
| `number-cell.ts` (whole) | the typed-number reader (zero-import) | `export * from '@/modules/platform/numbers/number-cell'` (K0) | K |
| `ai-cost.ts:25` `AiPassKind` | intake · grouping · pick · invoice · similar | = `AiCallKind` (+ assistant, tnved, deal_import) | K |
| `ai-cost.ts:34-36` `AiPassAnchor` (R3 widens with `intakeNoteId`) | similar → null; others → request | = `AiCallAnchor` (+ question / lot / deal anchors) | K |
| `ai-cost.ts:42-62` `recordAiPass` | the ledger's one writer; flat input `{model, inputTokens?, outputTokens?}`; never throws | EXACT new type `AiPassAnchor & { staffId? } & AiCallUsage`, forwarding every field to `recordAiCall`; callers spread the usage | K |
| (R3 K15) `ai-cost.ts` `attachIntakePasses` | `UPDATE … SET request_id WHERE intake_note_id AND request_id IS NULL` | wrapper over `attachIntakeCalls` (body moved to platform) | K |
| `ai-cost.ts:72-98` `aiCalcBudgetLeft` | day count, `kind <> 'similar'` for calc (`:90`) — every new kind would eat the VED's day | delegates to `dayBudgetLeft` with the POSITIVE `CALC_BUDGET_KINDS`; the module re-exports `aiReady` | K |
| `intake-ai.ts:4` | imports `ANALYST_MODEL` | gone | P2 |
| `intake-ai.ts:119` | a comment naming the model family | the tier word | M |
| `intake-ai.ts:151` `AiIntakeOutcome` | `AiIntakeRead & { answered?: AiUsage[] }` | + `servedBy?` | K |
| `intake-ai.ts:162` `INTAKE_MAX_TOKENS = 16_000` | R1's thinking room | retired (the profile's 32 000) | P2 |
| `intake-ai.ts:169` `INTAKE_TIMEOUT_MS = 150_000` | the reading's leash — files 30 s + this = his three minutes | **UNCHANGED** (the fallback lives inside it; the profile carries the same 150 000) | — |
| `intake-ai.ts:178-213` `aiFailureOf`, `retryAfterPause`, `INTAKE_ATTEMPTS`, `INTAKE_RETRY_PAUSE_MS` | the SDK-error words and the one retry rule (fixed 2 s) | MOVED to `platform/ai/failure.ts` (+ the `retry-after` pause); re-exported here under the old names | K |
| `intake-ai.ts:438-561` `analyzeIntake` | own client per attempt (`:524`), `model: ANALYST_MODEL` (`:526`), non-streaming, own retry loop | K: `input.job?` + trailing `run?` (inert); P2: content built as today → `runModel({ job, …, format, leashMs, ...run })`; `answered = attempts`; `servedBy` | K + P2 |
| `intake-ai.ts:565-602` `readIntakeResponse` | pure; usage `model: ANALYST_MODEL` (`:571`) | input gains OPTIONAL `model?`; usage = the message's model; stays the second fence | P2 |
| `intake-ai.ts:659` | the prompt's yo‘lkira line (the bot reads yo‘lkira) | unchanged — the reason the chat door reads yo‘lkira too | — |
| `intake-ai.ts:705` | typed material `slice(0, 20000)` — silent cut | unchanged, stated (round 6) | — |
| `intake.ts:132-145` `AiReadFailure` | 12 members | `= AiCallFailure \| 'nothing_to_read' \| 'budget'` (6 new incl. `off`) | K |
| `intake.ts:147-178` `AI_READ_FAILURE` | words + retry per failure | + model_not_chosen, model_unavailable, server_behind, ceiling, off, refused_fallback | K |
| `intake.ts:728-790` `intakeNoteText` (markers `:778-779`) | the landing note: heading, AI steps, material | + optional `aiFailure` line, `fallbackServed` line; the two markers exported as constants | K |
| `from-thread.ts:22` | imports `analyzeIntake` (the sync preview) | the import moves to `thread-read.ts` | P4 |
| `from-thread.ts:43-46` `ThreadCalcEntity` | client · lead · deal | unchanged | — |
| `from-thread.ts:62-140` `threadMaterial` | re-loads the posted ids under the viewer's fence | actor type → `ThreadCalcActor` | P4 |
| `from-thread.ts:143-160` `ThreadCalcPreview` | the preview's shape | DELETED | P4 |
| `from-thread.ts:167-173` `threadAiAdvice` | retry / smaller / admin from the `retry` flag | unchanged (the new members are non-retry → admin) | — |
| `from-thread.ts:180-226` `threadCalcAnalyze` | synchronous `analyzeIntake` for EVERY section (`:180-192`) with a 20 s leash, unbilled, ungated | DELETED; its merge (`:184-212`) MOVED verbatim into `threadReadFacts`; the call moves into the job | P4 |
| (new) `from-thread.ts` `threadCalcRefusal`, `ThreadCalcActor`, `ThreadPressFailure`, `threadCalcAccept`, `threadSelectionKey`, `threadReadFacts` | — | the gate (moved from actions), the press (prechecks, yo‘lkira rule, already-reading, enqueue), the pure merge | P4 |
| `from-thread.ts:293-377` `threadCalcSend` | rebuilds the material, the target (`dealFor` `:330` — round 4's), `openCalcRequest` `:351`, `queueCalcPrefill` `:372`; returns `{ …target, queued }` | actor narrowed; `aiFailure?`, `fallbackServed?` → the note; returns `requestId` too; round 4's block untouched | P4 |
| `service.ts:308-321` | `too_many_open` / `not_found` counted before the landing's tx | the same reads asked at the chat press (precheck) | P4 |
| `prefill-ai.ts:4` | imports `ANALYST_MODEL` | gone | P2 |
| `prefill-ai.ts:41-45` `PickUsage`; `:64-69` `PickOutcome` | `{ answers; usage }` (R2) | `PickUsage = AiCallUsage`; `{ answers; usages[]; refused? }` | K |
| `prefill-ai.ts:94-203` `pickImportRows` | own client 60 s, `maxRetries 1`, `max_tokens 4096`, listing `slice(0, 40_000)` (`:158`) | `runModel({ job: 'pick', …, format, ...run })`; `{ answers, usages, refused? }` | K (shape, inert `run?`) + P2 |
| `prefill.ts:74` `PASS_DEADLINE_MS` | 10 min; checked before the pick and the medians, NOT the grouping | passed into `proposeGroups` (step 1); + `PASS_TAIL_SLACK_MS = 300_000` | P2 |
| `prefill.ts:255-267` the flag + `deps.configured` | `hasKey && aiCalcBudgetLeft() > 0`; the seam short-circuits «no key» | two-sided seam (`true` = 'ok' without the gate) + `deps.ready`; else `aiReady({ tier: 'heavy', dayCap: 'calc' })` | P2 |
| `prefill.ts:331-346` (catch → log), `:377-392` (pick refused → log) | the mid-pass outcomes logged only | they reach the reply as `aiStood` (`refused` / `month_mid` / `off` / `model`) | P2 |
| `prefill.ts:449` `budgetSpent` | the reply's day sentence | `aiStood` | P2 |
| `prefill-steps.ts` `pickBazas` (R2 K5) | the pick + `await recordAiPass({ kind: 'pick' })` | records each of `usages` by spread; its «empty bazas → PickRequest[]» half extracted VERBATIM to `pickRequestsFor` (K9) | K + P2 |
| `ai-reply.ts:171` `budgetSpent?: boolean`; `:432-437`, `:500-502` | one day sentence; a refused group reads «⚠️ Kod topilmadi» | `aiStood?: AiStood \| null`; six sentences | P2 |
| `jobs.ts:18-30` `PASS_EXPIRE_S = 1800`, `TARIFF_EXPIRE_S` | the comment's arithmetic «2 × 60 s per step», untested | value kept; comment cites the new SUM pin | P2 |
| `jobs.ts:215-221` `registerCalcPrefillWorker` | the customs pass and the tariff reply; `includeMetadata` | unchanged — the precedent K8 copies | — |
| `workspace.ts:809` `aiConfigured` flag | draws the ✨ button | unchanged | — |
| `workspace.ts:2841` `AI_CLAIM_STALE_MS = 10 min` | the claim window = the lock's heal window | kept; pinned ≥ grouping leash + 60 s and ≥ `ACTION_AI_WALL_MS` + 60 s | P2 |
| `workspace.ts:2853` `aiClaimLive` | live when younger than the window | unchanged | — |
| `workspace.ts:2896-3071` `proposeGroups` | claim (`:2911-2934`), uncoded count / model skip (`:2938-2956`), batches SEQUENTIAL (`:2959-3022`), `recordAiPass` per answered batch (`:2981`, `:3007`), release before the tail (`:3064`) and in `finally` (`:3068`) | uncoded count FIRST, `aiReady` only when the model has work; claim TOKEN; heartbeat per batch (0 rows → `ai_claim_lost`); `deadline` + per-batch leash; month gate between batches; answered batches applied on a stop; `ai_refused` / `ai_ceiling` / `ai_off` when all failed; records `usages` by spread; returns `skippedByDeadline` / `stoppedByCeiling` / `refusedBatches`; + `ACTION_AI_WALL_MS = 180_000` | K (shapes) + P2 |
| `workspace.ts:3073-3078` `releaseAiClaim` | UNCONDITIONAL `SET ai_proposal_started_at = NULL` | `WHERE ai_claim_id = $mine`, clears both columns | P2 |
| `grouping.ts:42-45` `AI_BATCH_SIZE`, `planBatches` | ≤ 200 per call | reused by the deal import route | P3 |
| `service.ts:74-80` `CalcError(code, seq?)` | free-string code | new codes `ai_ceiling`, `ai_off`, `ai_refused`, `ai_model`, `ai_claim_lost`, `bad_note`, `already_reading` (words K) | K/P2/P4 |
| `intake-land.ts:221`, `:315-317` (R2) — R3 replaces with `attachIntakePasses` in `landRequestHalf` | the landing records `usages` | (R3) attaches; R5 passes `fallbackServed` AND `aiFailure` to `intakeNoteText` | P2 |
| `prefill-queue.ts` `queueCalcPrefill` (R3 ticket) | one pass per landing | relied on by the thread job | — |
| `version-set.ts:17` `currentVersionSql`, `:25` `notSupersededSql` | the sealed-and-standing predicate | read by the comparison's selection | P6 |
| `memory.ts` (confirmed groups of sealed requests) | the memory's own predicate | the comparison's answer key uses the same | P6 |
| `review.ts:29-42` `claimReviewMonth` | the once-a-month claim shape | the precedent for the spend claim | — |

---

## 4. `src/modules/wms/tnved/service.ts` (P2 owns the file)

| Where | Today | Change | Pkg |
|---|---|---|---|
| `:7` | imports `ANALYST_MODEL` | gone | P2 |
| `:97-111` `TnvedError(code, usage?)` | codes invalid_code · ai_not_configured · ai_failed | `usages: AiUsage[] = []`; + ai_ceiling · ai_off · ai_refused · ai_model | K |
| `:171-235` `suggestTnved` | own client 60 s, `max_tokens 2048`, refusal → `ai_failed`, usage never read | `runModel({ job: 'tnved', …, format, ...run })`; returns `{ …suggestion, usages }`; every failure carries its usages | K (shape, inert `run?`) + P2 |
| `:260-264` `AiUsage` | `{ model, inputTokens, outputTokens }` | = `AiCallUsage` | K |
| `:296` `groupingListing` (R2) | the richer listing | unchanged (the comparison reuses it) | — |
| `:319-409` `proposeGoodsGrouping` | `> 200` refused (`:323`), own client 60 s (`:327`), `max_tokens 8192` (`:338`), usage = the constant (`:378`) | `runModel({ job: 'grouping', …, format, ...run })`; `{ groups, usages }`; failure codes | K (shape, inert `run?`) + P2 |

---

## 5. `src/modules/wms/finance/` and the similar route (P3)

| Where | Today | Change |
|---|---|---|
| `similar-ai.ts:5` | imports `ANALYST_MODEL` | gone |
| `similar-ai.ts:36-40` `SimilarUsage` | 3-field shape | = `AiCallUsage` (K) |
| `similar-ai.ts:85-140` `pickSimilarLots` | own client 60 s (`:96`), `max_tokens 1024` (`:99`), `ask.slice(0, 20_000)` (`:125`), `onUsage` callback with the constant (`:127-131`), refusal → null (`:132`) | `runModel({ job: 'similar', …, format, ...run })`; returns `{ picks, usages, failure? }` (K froze it); `onUsage` deleted (K's shape) |
| `price-history.ts:663` `SIMILAR_CLAIM_STALE_MS` (10 min) | the «📈» claim window, unpinned | pinned ≥ `AI_JOBS.similar.leashMs + 60_000` (unit) |
| `app/api/pricing/similar/[lotId]/route.ts:78-79` | `aiConfigured` + `aiCalcBudgetLeft('similar')` | ONE `aiReady({ tier: 'heavy', dayCap: 'similar' })` → not_configured / budget / ceiling / off / model |
| same `:116-128` | `void recordAiPass` inside `onUsage` | each of `usages` recorded with `await`, by spread |
| same `:147` | `model: model \|\| 'unknown'` on `lot_similar_picks` | the model of the attempt that answered |
| `components/similar-ai-button.tsx:16-25`, `:48` | ERRORS map, unknown code → `failed` | + ceiling · off · refused · model (K) |

---

## 6. `src/app/` routes, actions, components

| Where | Today | Change | Pkg |
|---|---|---|---|
| `(protected)/batches/[id]/tnved/actions.ts:38-39` (comment) | «the AI budget paid for it» — false | becomes true | P3 |
| same `:45-108` `suggestTnvedForLotAction` | door checks (`:49-65`), photo read (`:67-95`), `suggestTnved` (`:97-103`), nothing billed; a non-TnvedError rethrown (`:105-106`) | `aiReady` after the door, before the photo; bill `kind 'tnved'` (lot anchor) on success and on EVERY `TnvedError` | P3 |
| `(protected)/batches/[id]/tnved/tnved-editor.tsx:96-100` | error words by ternary | exhaustive map incl. the four new codes | K |
| same `:108-116` `suggestAllMissing`, `:344` (⏳) | one press per lot, sequential, no stop, no count | stops at the first `ai_ceiling` / `ai_off` / `ai_model`; `{i} / {n}`; at most 30 per press («yana N ta qoldi») | P3 |
| `api/deals/[id]/lines/import/route.ts:26-86` | ONE `proposeGoodsGrouping` over up to 500 goods (refuses > 200 → silent `ai_failed`); usage discarded; no gate; no `request.signal` | `aiReady`; `planBatches`, sequential, offsets; month gate between batches; `DEAL_IMPORT_AI_WALL_MS = 180_000` incl. the call in flight; `run: { signal: request.signal }`; bill `kind 'deal_import'` (deal anchor); `aiError` codes + `aiPartial` | P3 |
| `(protected)/bitimlar/import-lines.tsx:38`, `:142`, `:225` | prints `importNoAi` for EVERY `aiError`; a bare `fetch` | one key per code; `importAiPartial` | K |
| `(protected)/hisoblash/actions.ts:805` `proposeAction` | `run('ved.docs', proposeGroups)`; CalcError → `calc.errors.<code>`; returns only ok/error | passes `deadline = now + ACTION_AI_WALL_MS`; returns `{ ok, skipped? }` (`ProposeFormState`) | P2 |
| same `:932-946` `threadCalcGate` | the chat door's gate | MOVED verbatim to `from-thread.ts` `threadCalcRefusal` | P4 |
| same `:947-965` `threadCalcAnalyzeAction` | runs the model on the request path | DELETED | P4 |
| same `:967-990` `threadCalcSendAction` | lands the browser's preview facts; revalidates `/hisoblash` (`:983`) | calls `threadCalcAccept`; posts no facts/steps; also revalidates the card | P4 |
| `(protected)/hisoblash/[id]/items-table.tsx:1869-1876` (`calc-propose`) | `disabled={busy}`, no text | `calc.proposeBusy` while busy; `calc.proposeSkipped` after | P2 |
| `components/thread-calc.tsx:7-8`, `:37`, `:39-45`, `:98-107`, `:131-157`, `:139-184`, `:186-211` | two presses; the preview; `noteId` per session; `done` in state | ONE press; queued / landed (+ the reason) / already-reading words; the `pending` line | P4 |
| `components/telegram-thread.tsx:180`; `(protected)/suhbatlar/[clientId]/page.tsx` | render `<ThreadCalc entity>` | pass `pending={await threadReadsPending(entity.id)}` | P4 |
| `(protected)/ai/actions.ts:18-37` `askAiAction` | → `askAssistant(…, surface 'web')` | unchanged | — |
| `(protected)/ai/chat.tsx:33-42` | ternary ending in `t('error')` | exhaustive map over `AskOutcome` (truncated prints the answer + its line) | K |
| `(protected)/ai/page.tsx:24`, `:31` | key gate; intro by `isAnalyst` | unchanged | — |
| `(protected)/admin/hub-doors.ts:33-86` (precedent `:78-84` `/admin/xatolar` with `roles`) | ONE list of doors | + `/admin/ai` (allow `admin.settings.manage`, roles `super_admin`) | P1 |
| `(protected)/admin/settings/page.tsx:35-51` (inputs `setting-${key}`), `:57-62` (`t('badValue')` for every key), `:50-55` | one date sentence for every refusal; object defaults as raw JSON | prints `badValueFor.<key>` when it exists, else `badValue` | K |
| `(protected)/admin/settings/actions.ts:18-62` `updateSettingAction` (`:28-29` refusal, `:33-35` `Number()`) | a non-number silently dropped, `Number('') = 0` | the new setting's validator; `checkSpendLevel()` after saving `ai_monthly_ceiling_usd` | K |
| `(protected)/profile/page.tsx:319-355` (the `owner` / `debt` boxes) | groups drawn for their receivers, hidden re-post (#171) | + the `mute_ai` box for `mayManageAi` | P1 |
| `api/calls/audio/route.ts:34` | a comment about the Ogg voice codec | NOT touched by M (the codec, not a model) | — |

---

## 7. `src/modules/platform/` (outside `ai/`)

| Where | Today | Change | Pkg |
|---|---|---|---|
| `telegram/staff-handlers.ts:1208-1218` | `void answerWithAssistant(…)` (off the sequential poller, #706), «🤖 O‘ylayapman…» | unchanged | — |
| `telegram/staff-handlers.ts:1910-1949` `settleAnalysis` (R3 moves it to `calc-read.ts`) | copies an explicit field list from `analysed` | + `readByFallback` in that list | P2 |
| `telegram/staff-handlers.ts:1960-1990` `answerWithAssistant` | `replies: Record<string, string>` + `?? replies.error` — a new status silently reads «AI javob berolmadi» | exhaustive `Record<Exclude<status, 'ok'\|'gave_up'>, string>` with §2.3's words | K |
| `telegram/staff-handlers.ts:2736` (R3's notice), `:2741` | «⏳ AI o‘qiyapti… (3 daqiqagacha)»; a comment naming the model family | the notice unchanged (true); the comment → the tier word | —, M |
| `telegram/calc-intake.ts:261` `IntakeState.usages` (R3 retires); `:263`, `:1429` `aiFailure` | per-analysis usage; the reading's failure on the state | (R3); R5 adds `readByFallback?` and passes `aiFailure` to the note | P2 |
| `telegram/calc-intake.ts:1346-1372` `analyzeCollected` (R3: `(state, files, { timeoutMs })`) | day budget `aiCalcBudgetLeft` (`:1360-1366`, `.catch(() => Infinity)`) → `failure: 'budget'` | `aiReady({ tier: 'heavy', dayCap: 'calc' })` imported from `wms/calc/ai-cost` → budget / ceiling / off / model_not_chosen / not_configured / server_behind; sets `readByFallback` | P2 |
| `telegram/calc-intake.ts:1357` | a comment naming the model family | the tier word | M |
| (R3 spec K8, §7.2) `telegram/calc-read.ts` `INTAKE_READ_EXPIRE_S = 300`, the SUM pin, `ANALYSIS_STALE_MS` | the reading's one wall clock, 290 ≤ 290 | **UNCHANGED** | — |
| (R3 spec) `telegram/calc-read.ts` `runIntakeRead` step 5 | bills `recordAiPass({ kind: 'intake', intakeNoteId, … })` per answered | passes the WHOLE usage by spread | P2 |
| (R3 spec K5) `telegram/calc-files.ts` `reduceForModel` | the model-sized photo | exported for P6 (K9) | K |
| (R3 spec) `telegram/staff-bot.ts` `landCollectedIntake` / `landRequestHalf` | the bot's landing input | passes `fallbackServed` and `aiFailure` | P2 |
| `settings/service.ts:115` `ai_calc_daily_limit` 200, `:122` `price_history_ai_daily_limit` 50, `:285` `ai_daily_limit` 40 | the three day caps | kept (⭐ Q10); + `ai_monthly_ceiling_usd: 100` beside `:115` | K |
| `settings/service.ts:317` `SETTING_VALIDATORS` | `unpriced_gate_since`, `lead_assign_origins` | + `ai_monthly_ceiling_usd` | K |
| `settings/service.ts:322-326` `getSetting` | uncached pool read | read by `dayBudgetLeft` (outside any tx); the month reads the setting row inside `aiMonthSpendSql` | — |
| `settings/service.ts:346` `SETTINGS_AUDIT_ID` | one history for settings | the tier/price saves audit under it | P1 |
| `http/origins.ts:10-35` `isOrigin` / `originsSettingValid` | https origins only | gets its own refusal sentence (`badValueFor.lead_assign_origins`) | K |
| `notifications/mutes.ts:7-250` `MUTE_GROUPS`; `:233-241` (the `debt` argument); `:275-302` `FOUNDERS`; `:309` `isTelegramMuted` | groups incl. `system` (born whole), `owner`, `debt`, `chat` | + group `ai: ['AiSpendLevel', 'AiModelMissing', 'AiUnpriced', 'AiKeyRefused', 'AiLedgerFailed']`, founders the same | P1 |
| `notifications/service.ts:55` `usersWithRoles`, `:77` `usersWithPermission` | recipient lists (pool) | `aiManagers()` = their intersection | K |
| `notifications/staff.ts:37` `queueStaffTelegram(dbOrTx, input)`; `:70` `kickTelegramDrain`; `:91` `notifyStaffTelegram` | tx-capable queue; the drain kick | the spend claim queues inside its own tx; the day alarms; the thread job's words via `notifyStaffTelegram` (`CalcPrefilled`) | P1, P4 |
| `notifications/staff-html.ts:15`, `:55-60` `LINK_LINE` | an own-origin LAST line becomes «↗️ Ochish» | every AI alarm ends with `${APP_URL}/admin/ai` | P1 |
| `diagnostics/signals.ts:6` (the table's ONE writer), `:83-95` `setDiskLevel` | bot and disk rows | + `claimAiSpendLevel(tx)` (level computed in the statement), the day claims `ai:unpriced` / `ai:model:<tier>` / `ai:key`, `noteLedgerFailure`'s `ai:ledger` upsert | P1 |
| `jobs/boss.ts:65-95` `WORKER_REGISTRATIONS` | incl. `calc-prefill` | + `calc-thread-read` (worker + the 10-min sweep schedule) | K |
| `jobs/boss.ts:198` `enqueue` (R3: `options.id`, `startAfter`, returns the id) | — | used with `id: noteId` | P4 |
| `rbac/authorize.ts:114` `actorGrants` | an actor without a session | used by `threadActorFor` | P4 |
| `users/login.ts` `canLogIn` | the one login rule | asked by the thread job | P4 |
| `files/service.ts:41`, `:82` | `'audio/<codec>'` in the upload allowlist (the Ogg codec) | NOT touched by M | — |
| `nav/usage.ts:56` | hides `/ai` without a key | unchanged | — |
| `db/schema/wms.ts:3823-3850` `aiCalcPasses` | 0096 + 0119 columns and CHECKs; `staffId` FK with no ON DELETE | + 16 columns (incl. `requestedModel`), the rewritten CHECKs, `staffId` `onDelete: 'set null'` (mirror of the migration) | K |
| `db/schema/wms.ts` `calcRequests` | `aiProposalStartedAt` (0086) | + `aiClaimId` | K |
| `db/schema/platform.ts:716` `systemSignals` | key · since · level (int) · detail · updated_at | unchanged (rows `ai:spend`, `ai:unpriced`, `ai:model:<tier>`, `ai:key`, `ai:ledger`) | — |
| `db/schema/platform.ts` | — | + `aiTiers`, `aiModelPrices` | K |
| `db/migrations/0096_ai_ved_memory.sql:103-119` (`:106` `staff_id` FK inline, `:119` `ai_calc_passes_day_idx`); `0119_price_icons.sql:34-44`; (R3) `*_calc_intake_durable.sql` | the ledger, its kind/tokens/anchor CHECKs, the day index | R5's migration drops and re-adds the CHECKs BY NAME and re-creates the staff FK as SET NULL (read its real name first) | K |
| `db/migrations/0080_ai_assistant.sql:8-21` `ai_questions` | one row per question, no tokens, no model | unchanged; the ledger's `question_id` points at it (no FK) | — |

---

## 8. `src/modules/wms/` elsewhere

| Where | Today | Change | Pkg |
|---|---|---|---|
| `customs/import-parse.ts:264` `fitNumeric` | rounds to the column's scale before `> 0` | MOVED to `platform/numbers/fit-numeric.ts`, re-exported here (K0) | K |
| `crm/telegram-import.ts:381`, `:440`, `:453`, `:546` | the Ogg voice codec in code and comments | NOT touched by M | — |
| `crm/service.ts:1278` `addActivity` | the lenta note writer (`SystemOpts`) | the thread job's failure note goes through the writer that accepts a pre-minted id (find it on the merged tree) | P4 |
| `reports/owner-summary-text.ts:1-2`, `:77` | `createTranslator` over the imported `messages/uz.json` | the precedent for the thread job's uz `calc.errors.*` sentence | — |

---

## 9. `messages/{uz,ru,en,zh-CN}.json`

| Namespace / key | Today | Change | Pkg |
|---|---|---|---|
| `settings.descriptions` (uz `:744`, `:756` for the two calc caps) | every setting described ×4 | + `ai_monthly_ceiling_usd` | K |
| `settings.badValue` (uz `:759`) | ONE date sentence for every refusal | kept; + `settings.badValueFor.ai_monthly_ceiling_usd`, `settings.badValueFor.lead_assign_origins` | K |
| `assistant.*` (`notConfigured`, `limit`, `gaveUp`, `error`, …) | the web chat's words | + ceiling · off · refused · modelNotChosen · modelUnavailable · serverBehind · truncated | K |
| `calc.errors.*` (uz `:3574-3576` ai_running / ai_failed / ai_not_configured; `too_many_open`, `not_found` exist) | CalcError words | + ai_ceiling · ai_off · ai_refused · ai_model · ai_claim_lost | K |
| `calc.proposeBusy`, `calc.proposeSkipped` | — | new (✨'s busy text and partial notice) | K |
| `calc.thread*` (17 keys; uz `:3887-3889` threadAiFailed + advice) | the two-press island | + threadQueued, threadQueuedClient, threadPending, `threadAiReason.*` (7), `threadErrors.bad_note`, `threadErrors.already_reading` (K); − threadAnalyze, threadReading, threadRead, threadMissing (P4, after their uses) | K, P4 |
| `tnved.aiFailed` (uz `:1842`) | the Bojxona 🤖's one failure | + aiCeiling · aiOff · aiRefused · aiModel · suggestProgress · suggestCapped | K |
| `finance.priceHistoryAiError.*` (uz `:2046-2053`) | not_configured · budget · found_free · failed · forbidden · already | + ceiling · off · refused · model | K |
| `deals.importNoAi` (uz `:3275`) | printed for EVERY `aiError` | shown only for `ai_not_configured`; + importAiFailed · importAiCeiling · importAiOff · importAiRefused · importAiModel · importAiPartial | K |
| `aiModels.*` (new namespace) | — | the screen (§13.3 of the spec) — no cache-read key; three whole «lacks» sentences via `error.lacks_*` | P1 |

---

## 10. Tests

### 10.1 Existing — re-run / re-anchor (reason recorded; never deleted, #166)
| File:line | Pins today | R5 |
|---|---|---|
| `tests/unit/intake-round1.test.ts:43-95` | `readIntakeResponse` outcomes + usage on failed reads; `aiFailureOf` over SDK classes | model = the message's (optional input); moved-and-re-exported |
| `tests/unit/intake-round1.test.ts:97-105` | «every failure has a sentence», union listed by hand | read the union from the source (or list the 6 new) |
| `tests/unit/intake-weight-basis.test.ts:91`; `tests/unit/intake-corpus.test.ts:1185` | `readIntakeResponse` with today's shape | compile unchanged (`model?`) |
| `tests/unit/intake-ai-wire.test.ts:26-57`, `:175-205` | JSON-error stand-in; retry/pause timings | mock `tierPlan` + `spendGateMonth`; extended with SSE cases (P2) |
| `tests/unit/intake-answered.test.ts:40-56`, `:80-110`, `:112-120` (R2) | JSON 200 bodies; `toEqual` on `answered`; `sent.at(-1)` | SSE frames; the two mocks; `toMatchObject` (P2) |
| `tests/unit/intake-corpus.test.ts:35`, `:687-718`, `:1113-1132`, `:1519-1542`; `intake-collector-r3.test.ts:16`; `intake-collector-r4.test.ts:18`; `intake-collected-goods.test.ts:12`; `totals-question.test.ts:14-33` | `ai-cost` factory-mocked with `aiCalcBudgetLeft`; the real reader against error stand-ins (c0790, c0794 timing) | + `aiReady: async () => 'ok'` in every factory (K); mock `@/modules/platform/ai/tiers` and `spendGateMonth` where the real reader runs (P2) |
| `tests/integration/intake-usage.integration.test.ts:21-35` | spreads the real `ai-cost`, overrides two | + `aiReady` override in the spread (K) |
| `tests/unit/bot-ai-dispatch.test.ts:65-72`, `:78` (a family-word comment), `:104-109`; `tests/unit/similar-ai.test.ts:86-88` | `new Anthropic({…timeout` per file | re-anchored on `run.ts` (`AbortSignal.timeout(`, `maxRetries: 0`); the comment → tier word (M) |
| `tests/unit/similar-ai.test.ts:99-115` | no paid step before the claim; the day budget named | `aiReady(` before the claim; `await` record; + the claim pin |
| `tests/unit/ai-advisory.test.ts:95-124` | the pick's schema slice in `prefill-ai.ts` | follows the schema into `runModel`'s `format:` |
| `tests/unit/batch-door-wire.test.ts:214-230` | `suggestTnved({` after the door | + `aiReady(` before the photo read; the bill in both branches |
| `tests/integration/ai-cost.integration.test.ts:109-183` (literal ids `:115`, `:151`; oracles `:141-150`, `:156-176`) | row per call; day budgets apart | neutral `'test-model-a'`; oracles on the positive list (K) |
| `tests/integration/price-icons-matrix.integration.test.ts:134-155` | the anchor CHECK by raw INSERT | + assistant / tnved / deal_import |
| `tests/integration/ai-assistant.integration.test.ts` (afterAll `:75-81`) | scripted `CallModel`; the atomic daily cap | + tier, `deps.ready`/`deps.plan`, ceiling-before-slot, per-attempt rows, sticky fallback, truncated text; afterAll deletes ledger rows first |
| `tests/integration/calc-regroup.integration.test.ts:35-58`, `:188-192`; `tests/integration/batch-door.integration.test.ts:35-41`, `:408-415` | mocks of `proposeGoodsGrouping` / `suggestTnved`; the regroup fence; «answers for a lot on the truck» | return `usages: []`; `asked.length > 0` first; the `ready` seam |
| `tests/integration/calc-prefill.integration.test.ts` (`:205-208`, `:290`, `:454-458`, `:480` family-word comment, `:587-588`) | the AI half with `configured: true` | green through the two-sided seam; + `deps.ready` cases; the comment → tier word (M) |
| `tests/integration/customs-estimate.integration.test.ts:300`, `:441-452` | «no pick past the deadline» | fails for the deadline (P2) |
| `tests/integration/calc-table.integration.test.ts:436-457` | the claim heals on the lock's clock | the gate seam + a positive claim assertion (P2) |
| `tests/integration/grouping-count.integration.test.ts:11-21`, `:146-176`, `:202-221` (R2) | `messages.create` mocked; `ai_failed`; pick usage literals | the SSE stand-in; `ai_refused`; arrays (P2) |
| `tests/unit/calc-row-draft.test.ts:525-535`; `tests/integration/calc-phone.integration.test.ts:227-240` | 10/11-minute claim literals | on `AI_CLAIM_STALE_MS` |
| `tests/unit/proposal-wire.test.ts:53-69` | release before the tail | + the token |
| `tests/unit/calc-clock.test.ts:77` | `proposeGroups` exempt from the rev clock | unchanged |
| `tests/unit/calc-error-words.test.ts:20-66` | every `new CalcError('…')` worded ×4 | `bad_note`, `already_reading`, `ai_off` keys (K) |
| `tests/unit/locales.test.ts:176-210` | every setting described ×4 | the new setting; the `badValueFor` rule |
| `tests/unit/i18n-keys.test.ts` | literal keys exist | P4 deletes uses before keys |
| `tests/unit/notification-mutes.test.ts:29-90`; `tests/unit/kuzatuv.test.ts:350-360` | literal group records; `system` born whole | `ai:` (five types); `system` untouched |
| `tests/unit/migration-journal.test.ts` | order, holes, placeholders | the new file |
| `tests/unit/tx-pool.test.ts` | no pool read in a tx (derived) | must stay green |
| `tests/unit/admin-chrome.test.ts:91-132`; `tests/unit/workspaces.test.ts:360-365` | hub doors under `/admin/`; the `/admin` union | the new door |
| `tests/unit/tg-media-plan.test.ts:45`, `:64` | the Ogg codec in comments | NOT touched by M |
| `tests/unit/thread-calc-wire.test.ts:59-76`; `tests/unit/deal-terms-wire.test.ts:89-93`; `tests/integration/deal-ved.integration.test.ts:626-638`; `tests/integration/thread-calc.integration.test.ts` (`:265-284` note_taken) | the gate in actions; two presses; the VED refused by the analyze action | gate in `from-thread.ts`; one press; refused by the send action; note_taken unchanged |
| `tests/unit/intake-corpus.test.ts` c0268 (`:1196-1205`), c0764 (`:1300-1304`), c0766 (`:1305-1310`), advice cases (`:383-386`, `:1138`, `:1160`); `tests/unit/intake-typed.test.ts:163-168`, `:248-262`; `tests/unit/intake-typed-r2.test.ts:326-340` | the thread merge's lines verbatim; the preview's advice flag | moved by PATH to `threadReadFacts`; the flag on the press result |
| R3 `calc-read-press.test.ts`, `calc-read-job.integration.test.ts`, `intake-billing.integration.test.ts`, `tests/unit/helpers/calc-read-drive.ts` | the reading's clock, leash, bill; the drive helper | the clock UNCHANGED; the fallback row and the whole usage; the helper's `ai-cost` mock + `aiReady` |
| e2e `m9u-deal-money.spec.ts`, `m9zz-ish-joylari.desktop.spec.ts`, `m9g-access.spec.ts` | keyless import; every drawn link 200; the operator bounced | green |

### 10.2 New (owner package; the red proof of each is in the spec)
| File | Pkg |
|---|---|
| `tests/unit/helpers/anthropic-stand-in.ts`, `tests/unit/ai-run.test.ts`, `ai-failure.test.ts`, `ai-tiers.test.ts`, `ai-profiles.test.ts`, `ai-ledger-writer.test.ts`, `ai-bill-spread.test.ts`, `ai-run-callers.test.ts` (staged), `ai-cost-mocks.test.ts`, `tests/integration/ai-ledger.integration.test.ts` | K |
| `tests/unit/models-list.test.ts`, `models-list-wire.test.ts`, `ai-models-i18n.test.ts`, `tests/integration/ai-tier-save.integration.test.ts`, `ai-spend-alarm.integration.test.ts`, e2e `m9zzzg-ai-sahifa.spec.ts` (the next free name) | P1 |
| `tests/unit/calc-ai-claim.test.ts`, `tests/integration/calc-ai-claim.integration.test.ts`, the pass pin (beside R2's), the extended `intake-ai-wire` / `intake-answered` / `intake-billing` / `calc-prefill` / `calc-regroup` / `customs-estimate` / `calc-table` / `grouping-count` cases | P2 |
| `tests/integration/deal-import-ai.integration.test.ts`, the extended `batch-door*` / `similar-ai` / `price-icons-matrix` cases | P3 |
| `tests/integration/thread-read-job.integration.test.ts`, `tests/unit/thread-read-sum.test.ts`, the `ThreadPressFailure` words fence | P4 |
| `tests/unit/ai-assistant-wire.test.ts`, the extended `ai-assistant.integration` cases, the outcome-map fence | P5 |
| `tests/unit/ai-compare.test.ts`, `tests/unit/ai-compare-fence.test.ts` | P6 |
| `tests/unit/no-model-id.test.ts`; `ai-run-callers.test.ts` tightened to its exact form | M |

---

## 11. Docs and other tracked files (M)

| File | Today | Change |
|---|---|---|
| `src/modules/platform/ai/model.ts:51-52` | the two id literals | deleted |
| comments naming a model FAMILY (exact list, re-found on the merged tree with `git grep -n -i -w` of the constants' middle words): `platform/telegram/calc-intake.ts:1357`, `platform/telegram/staff-handlers.ts:2741`, `wms/calc/intake-ai.ts:119`, `tests/integration/calc-prefill.integration.test.ts:480`, `tests/unit/bot-ai-dispatch.test.ts:78` | family word | the tier word |
| the SAME grep's codec hits — `platform/files/service.ts:41`, `:82`; `wms/crm/telegram-import.ts:381`, `:440`, `:453`, `:546`; `app/api/calls/audio/route.ts:34`; `tests/unit/tg-media-plan.test.ts:45`, `:64` | the Ogg voice codec (code and comments about it) | **NOT touched** — never `sed` the word |
| `tests/integration/ai-cost.integration.test.ts:115`, `:151` | literal id | neutral string (K) |
| `docs/AI-VED-RASTAMOJKA-MAP.md` (≈25 matching lines, e.g. `:99`, `:1062`, `:1365`, `:1488`, `:1547`, `:2047`, `:2233`; some are false positives; QUOTED commit trailers at `:2157`, `:2241`) | ids quoted | replaced by tier words; the trailers → «the attribution trailers used throughout the history» |
| `docs/AI-VED-RASTAMOJKA.md:187`, `:250` | ids quoted | tier words; «What differed» gains the R5 changes |
| `docs/RASTAMOJKA-TUZATISH.md:53` | a quoted commit trailer | «the attribution trailers used throughout the history» |
| `CLAUDE.md:525`, `:3449`, `:3824` | ids in the round-100 and calc paragraphs | tier words; + the R5 state paragraph and a «Where the truth lives» row |
| `DECISIONS.md:211`, `:1115`, `:1577` (#933 quotes an id) | ids in records | the literal replaced, the sentence kept; + `#R5-*` renumbered |
| `docs/SAKKIZ-BAND.md` §4, §10, §11 | «R5 … Migration» open | status + «R5 SHIPPED»; §11 his answers to 3.9-3.18 |
| `docs/SAKKIZ-R5.md`, `docs/SAKKIZ-R5-MAP.md` | committed at handoff | updated with K's hash and any re-fit |
| `docs/UPDATE.md` (§1 = the backup commands; per-round check sections) | — | + «AI modellar va xarajat — tekshiruv tartibi», in Uzbek (§18 of the spec) |
| `CHANGELOG.md` | — | the round in Uzbek |

Find-everything command (case-insensitive, the shape of an id; run before and after M):
`git grep -n -i -E "claude[- ][a-z]+[- ][0-9]" -- . ':!pnpm-lock.yaml'`
