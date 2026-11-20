# Reference check B — STAGE-3A, STAGE-3B, STAGE-4-6, STAGE-7-9

Verifier pass over the four later-stage build plans. Checked at HEAD `bf37150c` (journal tail `0150_batches_view`,
151 SQL files). No code was run and nothing outside `docs/ai-toliq/qurish/` was touched. Each plan file now ends with
a section «## Verified references» that repeats its own list.

## Method

For every plan: every `file:line` was opened and the named line read; every named function, constant, type, union,
table, column, CHECK, setting home, callback prefix, test file, e2e spec, script, docs section and DECISIONS number
was grepped and read. Counts the plans state as «counted» were re-counted (gate codes, policy codes, corpus rows,
the 303, file lengths). Names the plans mark ⟨1a⟩ ⟨1b⟩ ⟨1c⟩ ⟨2⟩ … are PLANNED, so they were checked against the
plan file that defines them, never against code.

| File | `file:line` refs opened | other named things checked | corrections | UNVERIFIED marks removed |
|---|---|---|---|---|
| STAGE-3A.md | 83 | ≈ 75 | 9 | 1 |
| STAGE-3B.md | 120 | ≈ 110 | 5 | 1 |
| STAGE-4-6.md | 119 | ≈ 95 | 17 | 3 |
| STAGE-7-9.md | 86 | ≈ 85 | 5 | 0 |

Overall the plans were accurate: almost every line number was exact. The corrections below are the exceptions.

## What changed, per file

### STAGE-3A.md
1. K6 — `parseCallback`'s range and prefix list were incomplete: `staff-bot.ts:749-822` → `:744-831`; the list now
   also names `e:s`, `e:c`, `jy`, the eight `TASK_PREFIXES`, `ca`, `cg`, `cf`. `aq` is still free.
2. K7 — `assignedNoteLine` prints the note for `hand` AND a NULL origin (not «`hand` only»).
3. §4.4 — `tools.ts:181-192` are tool SPECS, not handlers; dispatch `:444-447`, handlers `:535` / `:630`.
4. **§4.5, a claim the code contradicts, step re-thought.** The plan said one branch in `replyAccountFor` lets the
   pair write from the seat in the CRM. `replyAccountFor(clientId, actorId)` is keyed by a CLIENT and
   `tg_outbox.client_id` is NOT NULL, so no CRM composer exists for a LEAD-owned chat — and most of the seat's chats
   are leads until a code is opened. The step now says: the branch covers coded clients only; for a lead chat the
   pair write from the seat's phone or by ✏️ on a card; `tg_outbox` is not widened in 3a; whether a lead composer is
   wanted is a NEW question for him (it is not in the plan's §11 list — the builder should add it).
5. §4.5 / §6.4 — the test that pins «own account only» is `tests/integration/outbox.integration.test.ts:118,146`;
   `tests/unit/chat-controls.test.ts:45` only pins that the ⋯ menu is gated by `replyAccountFor` and stays green.
6. §4.6 — `#463` → `#466` (the compose box keeping its text).
7. §5 — `offerSightFor` is `calc/upsale-scope.ts:100`, not `:99`.
8. §7 — e2e name `m9zzzi-ai-quti`: prefixes `m9zzzh-` and `m9zzzi-` are taken at HEAD; the tail is
   `m9zzzj-sotuvchi-yuk.spec.ts`. A note says to name the spec so it sorts last.
9. §9 — UNVERIFIED removed: the command menu IS set per chat (`offerStaffCommands`, `commands.ts:28`, scope `chat`,
   called at `/start`, `/hodim` and the staff link), so each designated person sends /start once for `/aiquti` to
   show in the menu.

### STAGE-3B.md
1. §3.1 — «Seven of the nine [tables] carry (manager, peer) or an FK to `agent_drafts`»: by the plan's own table
   FIVE do; `agent_fact_checks` cascades from `agent_outbox` and the fence does not see it. Annotated with the
   re-count; §7.4's «all seven chat-keyed tables» → «every chat-keyed table».
2. §4.3 — `offerStandsFor` is `settle-hooks.ts:42` (called at `outbox-store.ts:371`, read at `send-step.ts:219-222`).
3. §6.2 note — the `Ineligible` union is `eligibility.ts:47-62` and holds seven more members than were listed.
4. §7.4 — e2e name `m9zzzh-ai-huquqlar`: same naming note as above.
5. **§10, UNVERIFIED removed, step re-thought.** `cargoMessages` / `balanceMessages` given a locale outside
   uz / ru / en fall back to the DEFAULT locale `ru` (`client-labels.ts:754`, `:790-795`). The plan's intended
   «uz-cyrl → uz, fa / zh → en» therefore has to be a mapping made by the block's renderer; passing the turn's
   locale through would print Russian.

Counted and found right: 47 + 24 codes and the order of §6.2's rows; every corpus number; the 303 and its file sizes.

### STAGE-4-6.md
1. Header — `STAGE-3B.md` exists now; the four key-name differences between the two plans are listed there (below).
2. **§4.3, a wrong reference and an UNVERIFIED resolved, step re-thought.** `platform/db/schema/platform.ts:727` is
   the `staff_group_media` TABLE, not an attachment type list. `attachments.entity_type` is plain text with no CHECK;
   the only list of types is the browser upload route's `ATTACHABLE` (`src/app/api/files/upload/route.ts:24`). So:
   the migration widens nothing, the PDF bytes are stored by the worker (`saveAttachment`), the new type is NOT put
   on `ATTACHABLE`, and only the `decide()` branch (with its own test) is needed.
3. §4.3 — the UNVERIFIED on ⟨1b⟩'s body CHECK kept, with HEAD's definition (0138:210) and where 1b plans to change it.
4. §4.4 P1 — `reprice` is `estimate.ts:138`; its `truckEstimate` call is `:148`.
5. §4.4 P3 — `loadOutboxFile` is `crm/outbox.ts:587` and reads by attachment id with no type in the question
   (resolves §4.10's second UNVERIFIED).
6. §4.4 P6, §4.6 — «the leak-11 literal moves with the tool's description» is wrong: that fence pins tool NAMES,
   `strict` and property names (`agent-fences.test.ts:41-52`). Both sentences corrected.
7. §4.4 P7 — «ten readers» of the avia days → the five files, with lines.
8. §4.4 — `expectedPartFor` `:205`, `prefillFor` `:320` (the pair was in the other order).
9. §4.7, §5.7 — e2e names `m9zzzi-ai-narx`, `m9zzzj-ai-yopish`: naming note.
10. §4.10 — two of three UNVERIFIED items resolved, the third kept.
11. §5.4 P2 — `client_code_next` is DECISIONS `#877` (not `#874`); `rekeyLeadChats` is defined at
    `crm/chat-lead.ts:703` (`crm/service.ts:1170` is its call).
12. §5.4 P4 — `mayRefileReceipt` has FOUR call sites, not two (all named); `mayGrantDebt` has eight — the
    substitution is limited to the promise door (`debt/promises.ts:92`, `:254`) and the others are named as untouched.
13. **§5.5, UNVERIFIED removed, step re-thought.** `chatIdentity` never reads `clients.active`: a retired client
    still IS the chat's identity today. P2's retirement must also retire the chat's binding, with
    `agent-retired-identity` as its red proof.
14. §6.3 — `PREPARERS` is `arrival-jobs.ts:204` (`:214` is `SWEPT_NOTICE_KINDS`); a new notice kind needs a
    `PREPARERS` entry; the «reserved `reminder`» draft kind is ⟨1b⟩'s plan, not HEAD.
15. §6.3 — rights row `concede` noted as ⟨3b⟩'s `give_discount`.
16. §6.6 — «the permit `concede`» → the permit CLASS is `discount` (⟨3b⟩), minted by the `concede` tool.
17. §6.10 — the UNVERIFIED on ⟨3b⟩'s permit API kept, with where it is planned.

### STAGE-7-9.md
1. Header — `STAGE-4-6.md` exists now (`COVERAGE.md` still does not). The header names what 4-6 plans for the three
   contracts ⟨4⟩ ⟨5⟩ ⟨6⟩ and the three re-fits (below).
2. §A4.1 — `sendTyping` is `send.ts:564`.
3. §A4.1 — `'channel_ai'` is a NEW member of the closed `OnceEffect` union (`once.ts:31`); `readyKey` is `:64`.
4. §C4.0 — `agent/seat-counting.ts` carries a re-fit note: ⟨5⟩'s plan already puts that home at
   `staff/seat-mode.ts`.
5. §C4.3 — `payKpi`'s refusal: `machine_seat` here, `not_payable` in ⟨5⟩'s plan — a note says ONE code.

## Could not resolve (needs the lead or the owner)

1. **Four keys named twice by two plans** (3B was absent when 4-6 was written): the discount right
   (`give_discount` / `concede`); his 22 a (`agent_low_quote_keep_usd` + right `correction` / `agent_honour_max_usd`
   + act `honour_quote`); where `open_code` sits at stage 5 (`ozi` ≤ 10 a day / `nazoratda`); where `tell_balance`
   sits at stage 6 (`ozi` / `nazoratda`). Noted in both files; not decided — the positions are a design choice.
2. **7-9 against 4-6**: (a) the bot tells a balance «only at `ozi`», but 4-6 plans `nazoratda` — as planned the bot
   never would; (b) stage 9's `agent/seat-counting.ts` and its pay/rating table repeat what stage 5's
   `staff/seat-mode.ts` already builds; (c) `agent_quotes` has no carrier column, which a bot-told quote needs.
3. **3A, lead chats**: whether the pair should get a CRM composer for lead-owned chats on the seat is a question
   for the owner that the plan does not ask.
4. **e2e names in the other plans too**: `STAGE-1B-1C.md` (`m9zzzh-ai-suhbat`) and `STAGE-2.md`
   (`m9zzzi-ai-koradi`) reuse prefixes that are taken at HEAD; those files are not mine to edit.
5. **3B's table count** — I annotated rather than rewrote «seven of the nine»; the author may have meant columns
   the table does not show.
6. **Planned names can drift.** ⟨1a⟩ / ⟨1b⟩ / ⟨1c⟩ / ⟨2⟩ names were checked against plan files that another
   verifier was editing during this pass (`STAGE-1B-1C.md` changed under me once). All names matched when read.
7. **UNVERIFIED marks kept** (cannot be checked without the server, Telegram or code that does not exist yet):
   3A — ⟨1b⟩'s `agent_cases` kind CHECK, how ⟨1b⟩ draws an unknown case kind, which policy code holds a batch or
   prixod code in a colleague's answer. 4-6 — ⟨1b⟩'s body CHECK and `parked` release for a file part, whether every
   listener-opened lead with a visible number carries `peer_phone` or a peer-index row, `MessageMediaContact` field
   names, ⟨3b⟩'s permit API, ⟨2⟩'s reading store, which door posts a truck price after arrival. 7-9 — which error a
   spam-limited account gets on a reply, whether a listening-only session counts as activity.

## Flags asked for

- **Model identifiers:** none in the four files. 3B names only the two tier constants (`STAFF_MODEL`,
  `ANALYST_MODEL`, `platform/ai/model.ts:90-91`), which is the right way to say it.
- **A person's name or id as something code would hold:** none in the four files. One thing for the builder of 1a:
  the CODE at HEAD still holds the owner's first name in three strings the model reads (`agent/prompt.ts:85`, `:87`,
  `agent/tools.ts:394`).
- **Role keys for «who»:** none. `super_admin` appears only as the existing door predicate (`mayRunAgent`'s rule).
- **Literal migration numbers for new migrations:** none — every new migration is «the next after the journal's
  tail» with a tag. Existing migrations are cited by their real numbers (all checked).
