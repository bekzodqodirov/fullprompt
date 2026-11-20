# Reference check A — STAGE-0-1A, STAGE-1B-1C, STAGE-2

Checked at HEAD `bf37150c` (code identical to `bdd81f51`, the HEAD two of the plans were read at: the delta is
`docs/AI-SOTUVCHI-TOLIQ-QURISH.md` and one line of the page source). Method: every thing a plan names as EXISTING —
path, function, constant, type, table, column, CHECK, settings key, callback letter, test, fence, screen word,
script, document section, DECISIONS number — was grepped and its lines opened; every NEW name was grepped free.
Nothing under `src/`, `tests/`, `scripts/`, `messages/` or the migrations was touched; no suite and no build was
run; postgres was not started. Each plan now ends with «## Verified references» (the HEAD, the count, old → new).

About 580 references in all (≈ 230 + ≈ 190 + ≈ 160). The plans were accurate to an unusual degree: of roughly 375
`file:line` references, fewer than ten were off, each by one to three lines. What was wrong was of another kind —
lists that were shorter than the code, and three claims about today's behaviour.

## Claims the code contradicted — rewritten, and the step re-thought

| Plan | The claim | What the code says | What changed in the plan |
|---|---|---|---|
| 0-1A §9, 2 §9 | «`tg-listen-agent-wire.test.ts` names the listener's import closure» | The test pins the ORDER of the pump's calls in `scripts/tg-listen.ts`; it lists no closure. The closure is that script's own `agent/` imports (`:104-153`) — and it holds `config.ts`, `worthy.ts`, `limits.ts`, all edited by 1a | 1a's deploy step went from «rebuild tg-listen IF the diff touches its closure» to «rebuild it»; stage 2's reason was corrected (its step already said rebuild) |
| 0-1A §6.3, 2 §6.4 | «`agent-policy-first-reply.test.ts`: untouched» | The file builds two literal `AutoGateInput`s (`:1979`, `:2075`); K6 of 1a (and K of stage 2, `burstMedia`) changes that type, so `pnpm typecheck` stops there. Same for `agent-full-p2-price.test.ts:162/187` and the corpus eval's `eligibleInput()` | Its VERDICTS stay untouched; the fixtures are listed as mechanical edits in both plans |
| 1B §3.2, §10 | «the daily 👍/👎 sample (9 a) is a ledger of its own in the stage `COVERAGE.md` gives it … stated, not built» | `STAGE-0-1A.md` builds it in 1a (`agent_samples`, §3.1 / §4.5); `qurish/COVERAGE.md` is not in the tree | Both sentences now point at ⟨1a⟩ |
| 1B K | the six free `ag:` letters include `q` | Unused, yes — but two tests assert `ag:q:<id>` is UNPARSED (`agent-fences.test.ts:233`, `agent-owner-answer.test.ts:439`) and the constant's comment says so | The step now says to rewrite both assertions; with all six taken the «unknown op» example must be a non-letter |
| 2 §4.4 | UNVERIFIED: «how the calc door treats a `tnvedSource: 'row'` code» | Traced: `'row'` lands unmarked as the row's own code; `'model'` lands with the «AI taklifi — tekshiring» note (`calc/row-coding.ts`, `calc/service.ts:473-494`, `calc/code-source.ts:10`) | The mark was removed (verified). The plan sent every read code as `'row'`; a code a MODEL read off a photo or PDF now travels as `'model'` |

## Lists that were shorter than the code — completed

- **0-1A K5** — one note writer had no code in the new `noteCodes` list: the truck-minimum note (`run.ts:1673`).
  By the plan's own fail-closed rule it would have been a machine stop. `calc_below_minimum` added.
- **0-1A P3** — «16 runtime strings hold the owner's name» is 18: `prompt.ts:91` and `lesson-rules.ts:30` were missing.
- **0-1A P3 — a trap the plan did not see, added as a step:** a persona that carries a real colleague's first name
  trips `staff_name` (one word of a colleague's name WARNS, `policy.ts:2462-2480`; the colleague list excludes only
  the account's own user, `policy-input.ts:133`). With the seat as holder, the owner is a colleague, and 1a keeps
  `staff_name` a machine stop — so the AI's own «men …man» would wait for a ✅ every time. A persona-word exemption
  and its test both ways were added. This is the one place I added a step rather than corrected a reference; it
  changes no rule and no answer of his.
- **0-1A K4, 1B P2, 2 §4.5** — every new UNMUTABLE notification type meets a derived fence the plans did not name
  (`agent-fences.test.ts:157`: blank it in `purge.ts chatCardsWhere` or list it in the test's `NO_CHAT`); a new
  `AgentNotice` writer meets `:174` (`extra.peerId`).
- **0-1A §6.2** — the STAY row now names every `AUTO_REFUSALS` member it covers.
- **1B P1** — the doors that cancel a waiting outbox row: five were missing (`decide.ts:852`, `config.ts:411`,
  `:732`, `calc-loop.ts:259`, `:965`). And a whole class of reader was missing: nine JOINs of the outbox by draft
  that return one row per draft today and one per PART after 1b (the page's lists, the stats, the priced-reply
  reads). A table row was added and the planned fence told to read raw SQL too.
- **1B P3** — «fifteen places compare the holder by hand» is nineteen lines; `lessons.ts:365` and `:381` were
  missing from the supervisor-only group; `auto-send.ts:1268` is the one `userIds:` site not on the recipients list.

## Names and numbers corrected

- 0-1A: the contract file «ABSENT» → present from `bf37150c`; `worthy.ts:91` / `run.ts:475` → `:96-99` / `:474-493`;
  eval `eligibleInput()` `:117` → `:116`, `destination()` `:233` → `:235`; the reader list gains `han_g1`; the
  corpus fields gain `chatLang`; `mediaWord` located (`census.ts:96`); the confidence box's real names written out;
  «a KEPT photo or file» put in the code's terms; e2e «owner tunes the boxes» (no such title) → the two real tests.
- 1B: `agent_drafts_category_check` «(0149)» → 0138:165, never re-made; the waits CHECK's history; `mutes.ts` /
  `night.ts` line ranges; `afterPressOf` → the read at `auto-send.ts:1049`; «183 avia rows» → 183 dangerous + 94
  ordinary; `wonOwnerFor` marked NEW; `m9zzzh` is a prefix two specs already wear.
- 2: «Design §3.1» → §3 rule 1; `context.ts:66-77` → `:64-76`; `namesForeignPlace` is in `destination.ts`, not
  `run.ts`; `ai-spend.ts:228-241` → `:226-242`; `m9zzzi` is a prefix already worn; `differsFromTotal`,
  `aviaSpokenOf`, `holderActor`, `pressedReasons`, `mayTuneAuto`, `mayArmAuto` are module-private
  (said where a step leans on calling them).
- Settings (0-1A §3.3): `OWN_DOOR_KEYS` admits two page values only — `lead_assign_ai` on `/admin/taqsimot` needs a third.

## Flagged by the three standing checks

- **Model identifiers:** none in the three files. Stage 2 names the tiers by constant (`STAFF_MODEL`,
  `ANALYST_MODEL`); its three speech providers are his own list from answer 13 a, not something code holds.
- **A person's name or id as code would hold it:** one — STAGE-1B-1C quoted today's prompt rule 12 with the
  owner's name in it; replaced. The Uzbek card examples use an illustrative GS code only.
- **Literal migration numbers:** none for a NEW migration (the three plans say «the next after the journal's
  tail» / `NNNN_…`). Existing migrations are cited by their real numbers, all checked.

## Cross-plan seams found while checking (fixed in place, two cells)

- 1B said the stage-2 readings bill to `agent_runs`; stage 2 deviates on purpose (they would spend the token
  fuse, `today.ts:44`). 1B's cell now points at stage 2.
- 1B's package «Darhol» and 1a's P1 both plan the inline press (`pressNow`) with different signatures. 1B now says
  what is left for it if 1a ships first.

## Could not resolve

- The database name of the inline UNIQUE on `agent_outbox.draft_id` — no database was up (the plan keeps its
  `UNVERIFIED:` and its «drop both spellings»).
- Whether a schema-vs-migration drift test exists: looked for, none found; said so in 1B §10.
- `qurish/COVERAGE.md` — named by the contract and by 1B, not in the tree.
- Everything the plans themselves mark `UNVERIFIED:` and that needs a server, a key or a database: a fact with
  clock times through G1; the 303 cases under the corpus harness; the fast tier's `output_config`; Ogg duration on
  real notes; how the 0115 watch reports a dead staff bot; outbound reach to the speech providers.
- Not checked: STAGE-3A, STAGE-3B, STAGE-4-6, STAGE-7-9 (outside this pass).
- One process note: the «Verified references» section of STAGE-0-1A was appended with a shell `cat >>` and the
  other two with the Edit tool; the content is the same kind.
