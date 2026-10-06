# Telegramdan topshiriq berish — the staff bot assigns work

Agreed 2026-10-06. His request, verbatim: «telegramda shunday imkoniyat kerakki
hodimlar biriga ish buyura olishi kerak telegram orqali va bu juda qulay
bolishi kerak». His answers to the six questions: **1b 2a 3a 4a 5a 6b**.
Revised the same day after the code review (§9); the VED round of the same
message is `docs/VED-TARIX.md`, and the two share migration **0124**.

## 1. The answers, as rules

| # | Question | Answer | Rule |
|---|---|---|---|
| 1 | How is a task given | **b** — the «➕ Topshiriq» button AND any forwarded message | Two doors, ONE draft collector. The typed one-line command («Siroj ertaga …») is NOT built. |
| 2 | Who may give to whom | **a** — every active person to every active person | The existing rule: being signed in is the gate (`tasks/actions.ts`), the assignee must pass `canLogIn`. No new permission. Self is allowed («🙋 O'zimga»). People who never sign in (0120) cannot be assigned, exactly as on the web — stated. |
| 3 | Voice / photo / file | **a** — yes, travels with the task and shows on the site | Telegram: the author's own messages are FORWARDED to the assignee before the task text. Web: the bytes are stored as `attachments` of entity type `task` and drawn in the task list. |
| 4 | Assignee buttons | **a** — 👀 Qabul qildim · ✅ Bajarildi · ⏰ Muddatni surish · 💬 Savol | Every press tells the author. NOT on a task bound to another record's clock (§4). |
| 5 | Author's view | **a** — «📤 Men bergan» in the bot | Open tasks the person gave BY HAND, late ones marked 🔴, one-tap «🔔 Eslatish». |
| 6 | Auto-link a GS777 / batch code in the text | **b** — no | The text is stored as typed; no entity pointer is guessed. |

## 2. Where a task came from — `tasks.origin` (0124)

A task today does not say who made it: the seller's calc job, the VED's
hand-back, a payment promise's call and an automation rule all carry a
`created_by` and look given by hand (gsr_verify: 4 of the 7 open «given to
someone else» tasks are «Hisoblash: …»). `tasks.origin` says it, with
`bound_id` for the record whose clock the task carries:

| origin | made by | `bound_id` | buttons (§4) | in «Men bergan» |
|---|---|---|---|---|
| `hand` | the web form, the bot (this round) | — | 👀 ✅ ⏰ 💬 | yes |
| NULL | before 0124, unknown | — | 👀 ✅ ⏰ 💬 | yes |
| `calc` | `requestCalc`, `takeCalcRequest`, a recalc | the calc request | ONE URL button «🧮 Ochish» | no |
| `calc_return` | the VED's hand-back | — | 👀 ✅ 💬 | no |
| `promise` | `openPromiseTask` | the payment promise | 👀 ✅ 💬 (no ⏰: the due IS the client's promise) | no |
| `automation` | a rule | — | 👀 ✅ ⏰ 💬 | no |

`createTask(input, ctx, opts)` takes `origin` as a REQUIRED option — never
from the form schema — so every caller is a compile error that names itself;
a repeat's next occurrence copies `origin`/`bound_id`. The backfill in 0124 is
deterministic (pointers from `calc_requests.task_id` and
`payment_promises.task_id`, then the fixed machine titles).

## 3. The draft — ONE collector, two doors

`src/modules/platform/telegram/task-draft.ts` (new), the shape of
`note-capture.ts`: an in-memory map keyed by chat, 30-minute TTL, lost on a
deploy (stated, the same trade as the calc intake and the zametka capture).

```
TaskDraft {
  stage       — 'who' | 'what' | 'when' | 'date'   ('date' = «📅 Sana yozish» pressed)
  assigneeId  — null until picked
  texts[]     — typed lines, joined into the note
  sources[]   — {chatId, messageId} of the author's own messages (forwards,
                photos, voice, documents), ≤ 10, forwarded to the assignee
  files[]     — {fileId, kind, name, size} to download for the web (≤ 20 MB each)
  albums      — media_group_id → last-seen time (the debounce below)
  promptMessageId — the bot message whose keyboard the draft edits
}
```

One collector at a time per chat: starting a draft is refused in words while
a calc intake or a zametka capture is live, and vice versa. Starting a draft
DISCARDS a pending one-text wait (a «Bajarildi» result, a question, an
answer) for that chat; pressing ✅/💬 while a draft is live is refused in
words «Avval topshiriqni tugating yoki 🗑 bekor qiling». So `takeTaskPending`
can never eat the draft's text and the draft never files a result.

**Door A — «➕ Topshiriq»** (and `/topshiriq`): a new reply-keyboard label.
Labels are routers and are never renamed; positions may move. It joins
`escapesIntake` (the derived fence in `owner-summary-wire.test.ts`).

1. **Kimga?** — an inline list of colleagues (`canLogInSql`), the author's
   recent assignees first (their own hand-given tasks in the last 90 days),
   then everybody else alphabetically, two per row, «🙋 O'zimga» last. Anyone
   the bot cannot reach (no linked chat, or `TaskAssigned` muted) carries
   «📵». A typed name in this stage filters the list.
2. **Nima qilish kerak?** — text, voice, photo, video, file or a forwarded
   message; several messages are allowed. The due keyboard appears after the
   first one — and for an ALBUM only once it has settled (no new part of that
   `media_group_id` for 1.5 s), because Telegram delivers an album as N
   updates and a due pressed mid-album would create the task without the rest.
3. **Muddat** — [Bugun] [Ertaga] / [Indinga] [Muddatsiz] / [📅 Sana yozish],
   computed from `tashkentDay()`. «Sana yozish» reads `12.10`, `12.10 15:00`
   or `15:00` on the Tashkent clock (`parseDue` with `tzOffsetMin = -300`); a
   bare time already past today means TOMORROW, said in the confirmation
   («ertaga 15:00»). Text typed in stage `when` (not `date`) is added to the
   note. Pressing a due CREATES the task at once — no extra confirm tap — and
   the bot answers with the task card and [🗑 Bekor qilish].

Minimum: ➕ → person → type → due = four touches.

**Door B — a forwarded message** from a staff chat (`staffForChat`), arriving
while no collector is live: the bot answers as a REPLY to that message
«📌 Topshiriq qilamizmi?» with [📌 Topshiriq qilish] [🔍 Qidirish] — once per
`media_group_id`, never per photo of an album. «Topshiriq qilish» starts a
draft whose first sources ARE that message (and its album) and jumps to
«Kimga?»; after the person the due keyboard is shown at once. «🔍 Qidirish»
reads the forwarded text from the callback's `reply_to_message` (no in-memory
state — it survives a deploy) and replays TODAY's whole tail on it: lookup,
then `codeCandidates`, then the notes answer, then the AI — so nobody loses
the old behaviour. While a calc intake or a zametka capture is live, forwards
keep going to them exactly as today (forwarding is the intake's core). A
forward never satisfies a one-text wait.

## 4. What gets created, and what the assignee gets

Through the ONE writer `createTask`, under the chat's honest actor
(`staffForChat` + `botActorFor`), `origin: 'hand'`:

- `title` = the first typed line cut at ≤ 120 characters on a word, or
  «🎤 Ovozli topshiriq», «📎 Fayl», «🖼 Rasm», «↪️ Yo'naltirilgan xabar» when
  the draft has no text;
- `note` = every typed line joined (≤ 4000);
- `assigneeId`, `dueAt` as chosen, priority 2, no entity pointer (6b);
- `tasks.source_messages` = the forward pointers (so a reassign can forward
  them again);
- audit `after` carries `via: 'telegram'`.

The files are downloaded AFTER the task exists, off the poller (#706,
`void`), into `attachments` with `entity_type = 'task'` — so nothing is
pre-bound and an abandoned draft leaves no orphan.

**The push.** `TaskAssigned` now carries the NOTE for a `hand`/NULL task,
capped at ~600 characters + «… saytda» (a 4 000-character wall under four
buttons reads badly and feeds `closeTaskMessage`'s rebuild); never for a
`calc_return` task, whose reason `CalcReturned` already printed. The sources
go as `payload.forwards[]` through ONE Bot API `forwardMessages` call (grammy
1.45.1: one call, albums stay grouped, an unforwardable source is skipped),
and `payload.forwarded` is set only after that call returns — the existing
single-pointer `forwardOriginal` would re-send everything on a retry after a
partial failure.

**Buttons** (`buttonsFor`, by origin, §2):
```
[👀 Qabul qildim] [✅ Bajarildi]
[⏰ Muddatni surish] [💬 Savol]
```
- **Qabul qildim** — `tasks.accepted_at`, a CAS UPDATE
  (`WHERE accepted_at IS NULL AND status = 'open'`); the message is edited to
  drop the button and say «👀 Qabul qilindi»; the author gets `TaskAccepted`.
- **Bajarildi** — the existing two-step (result text, «-» = none), plus a
  «✅ Natijasiz» button so nobody has to type a dash. The author already gets
  `TaskDone` with the result. `completeTask`/`cancelTask` gain
  `WHERE status = 'open'` CAS (today check-then-UPDATE; one tap removes the
  natural debounce the text step was).
- **Muddatni surish** — [Ertaga] [Indinga] [1 haftaga] [📅 Sana yozish]; a
  NARROW writer `rescheduleTask(id, due, ctx)` (never `updateTask`'s full
  replace), `canActOnTask`, refused on a `bound_id` task, audited; the author
  gets `TaskRescheduled`.
- **Savol** — «Savolingizni yozing»; the next text goes to the author as
  `TaskQuestion` with [💬 Javob berish]; the author's next text goes back to
  the assignee as `TaskAnswer` carrying the task's buttons again. Both are
  audit rows on the task (action `comment`, the union widened, labels ×4).
  When the other side cannot be reached (no linked chat, or the type muted)
  the sender is told so in words — the same reachability helper as the 📵.

A calc task (`origin = 'calc'`) gets ONE URL button «🧮 Ochish» →
`/hisoblash/<bound_id>` and none of the above: ⏰ would move `tasks.due_at`
while the SLA sweep reads `calc_requests.due_at`, 👀 duplicates «Olaman», and
✅ would close the job with no price — the VED round makes every task door
refuse an open calc job (VED-TARIX §8). Already-delivered messages keep their
old `t:` ✅; it still parses, and the press gets the refusal in words.

All the one-text waits (result, question, answer) live in the SAME pending
map behind the ONE `takeTaskPending(chatId)` (the zametka fence pins exactly
one), routed by kind.

**Retiring copies.** A task closed, cancelled or reassigned from ANY door
retires its Telegram copies — `retireTaskCopies(taskIds, outcome)` exported
from platform, the shape of `retireApprovalCopies`: every notification that
carries this task's buttons (`TaskAssigned`, `TaskReminder`, `TaskAnswer`,
and the `TasksDue` rows by `payload.tasks[].id`), bounded by
`user_id` + `created_at >= task.created_at` (no index on the payload), is
edited to «✅ Bajarildi» / «🗑 Bekor qilindi» / «👤 Boshqaga berildi» without
buttons. Called AFTER the transaction by `completeTask`, `cancelTask`,
`reassignTask` and the wms writers that close tasks directly
(`closePromiseTasks`, `cancelTasksFor`, the stale-task script) — never inside
a transaction (#714). A calc task carries only a URL, so the calc writers need
no call. «📋 Bugun» replies are sent with `sendText` and have no notification
row, so they cannot be retired: a press on a closed task answers «Bu vazifa
yopilgan» — stated. Cancel tells the assignee (`TaskCancelled`); reassign
tells the author (`TaskReassigned`) and forwards the sources to the new
assignee.

The author is told in the same reply when the assignee cannot be reached:
«⚠ Siroj Telegramga ulanmagan — topshiriqni faqat saytda ko'radi» or
«⚠ … topshiriq xabarlarini o'chirgan».

## 5. The web

The task list on `/bugun`, `/kalendar` and every TasksPanel draws a task's
files: image thumbnails, an `<audio>` player for voice, a link for documents —
ONE grouped attachments query per list (#432), keys ×4. The read gate gets
`case 'task'` in `wms/attachments/access.ts`: the assignee, the author, or a
`canActOnTask` holder; anybody else is refused. `task` is NOT added to
`ATTACHABLE` (that would open the bare-login upload route to any task id);
because the allowlist fence derives from `ATTACHABLE` and cannot see a
bot-only type, a new fence reads every `saveAttachment` entity-type literal in
`src/` and demands a `case` for it (an unmapped type is log-only and SERVES
the bytes).

## 6. The author's «📤 Men bergan»

A new reply-keyboard label «📤 Men bergan» (and `/berganlarim`, offered in
`commands.ts` and answered — the command-menu fence): the open tasks this
person gave to somebody else with `origin` `hand` or NULL, newest first,
capped at 20 with the total said: «🔴» late, «👀» accepted, «⏳» not yet seen,
then person · due · title. Under it up to 8 buttons «🔔 <short title>» — a
press sends the assignee `TaskReminder` («🔔 Eslatma: …», with the task's
buttons), at most once per task per 30 minutes by a CAS on
`tasks.reminded_at` (refused in words otherwise). Index 0124:
`tasks (created_by, status)`. On deploy day every open task reads «⏳»
(`accepted_at` is NULL) — true, nobody has pressed 👀 yet.

The staff keyboard: [📋 Bugun] [➕ Topshiriq] / [📤 Men bergan] [🧮 Hisoblatish]
/ [🤖 AI rastamojka] [📌 Zametkalar] / [Holat] — positions move, labels never.

## 7. Notifications

New types `TaskAccepted`, `TaskRescheduled`, `TaskQuestion`, `TaskAnswer`,
`TaskReminder`, `TaskCancelled`, `TaskReassigned` join `MUTE_GROUPS.tasks`
and are NEVER added to `FOUNDERS` (round C: a grown group must not un-mute
anybody). Every new callback kind is handled ABOVE the approval guard in
`staff-handlers.ts`, or the button spins with no error (#939); the prefixes
are uuid-anchored like `t:`/`tb:` (an unanchored `^c:(\w+)$` swallows
look-alikes), and ONE derived fence reads every `callback_data` the staff
keyboards build and demands the parser accept it.

«📋 Bugun» / the 08:00 digest list overdue and today only, so a person whose
tasks are all «Muddatsiz» was told «✅ Bugunga ochiq vazifa yo'q»: the reply
gains «+ N ta muddatsiz». A «Bugun» task chosen between 00:00 and 05:00
Tashkent stays outside the digest's UTC «today» until 05:00 — stated, not
moved (digest.ts: move every reader or none).

## 8. Data — migration 0124 (shared with docs/VED-TARIX.md)

```
tasks.origin           text NULL  CHECK (origin IN ('hand','calc','calc_return','promise','automation'))
tasks.bound_id         uuid NULL  CHECK (bound_id IS NULL OR origin IN ('calc','promise'))
tasks.accepted_at      timestamptz NULL
tasks.reminded_at      timestamptz NULL
tasks.source_messages  jsonb NULL  CHECK (source_messages IS NULL OR jsonb_typeof(source_messages) = 'array')
CREATE INDEX tasks_author_idx ON tasks (created_by, status)
```
plus the VED round's `calc_requests.answer_internal_note` and its partial
index (VED-TARIX §9). `when` 1785190000103; the ledger must reach **125**.

## 9. What the code review changed (2026-10-06)

- The calc and promise tasks would have received all four buttons — ⏰ on a
  task whose deadline belongs to the calc queue or to the client's promise,
  and a one-tap price-less close on a calc job → `origin`/`bound_id` (§2).
- «Men bergan» would have been full of machine tasks → `origin`.
- `forwardOriginal` extended to a list would re-send on a partial failure →
  `forwardMessages`.
- Albums, Door B's search replay, the pending-wait/draft collision, the
  muted author, `TaskReassigned`, the CAS writers, the bot-only attachment
  type, the «Muddatsiz» digest hole, the note cap — each absorbed above.

## 10. Never

- A forwarded message during a live calc intake or zametka capture is never
  taken for a task.
- No guessed entity link (6b).
- Nothing here sends anything to a CUSTOMER.
- No new permission: the gate stays «signed in»; `canLogIn` decides who can
  receive.
- A calc task never carries a button that changes the task.

## 11. The review before code

`docs/TOPSHIRIQ-VED-REVIEW.md` holds the five-lens review of this spec and
VED-TARIX; its fixes are BINDING where they and the text above disagree. The
two blockers: an old `t:` ✅ on a calc task asked for a typed result and then
answered with silence (the press now loads the task first and refuses at
once, and the bot's answer map names every TaskError code); and retiring a
copy edited the 08:00 digest to «✅ Bajarildi», wiping the buttons of up to
seven OTHER open tasks (a TasksDue copy keeps its text and only its keyboard is
redrawn from the tasks still open). Also binding: the task-button payload
contract `{taskId, origin, bound, accepted}`; the per-origin press → author
table (no 👀 / 💬 / pushes to an automation rule's author); `takeTaskPendingFor`
as the named second door for «✅ Natijasiz»; the per-button remover for 👀; the
assignee check in every CAS; reassign clearing `accepted_at`/`reminded_at`
and forwarding sources only when the AUTHOR reassigns; no ⏰ on a repeating
task; `retireTaskCopies({taskIds, outcome, since, exceptUserIds})`, void-
dispatched, after commit, with `RETURNING id` added to the three bulk closers
and pending copies muted at send time; the full list of accepted message
kinds and the staff media handler registered before the cabinet; the album
settle timer and the 60-second linger after creation; Door B's album map; the
ladder slots fenced in order; the closed callback vocabularies; file downloads
as a pg-boss job; the task-file delete rule (the author only); «📵» only for
«no linked chat»; `/topshiriq` in the command menu and a deploy note that
every staff member sends /start once; the mute-group fence for every new type;
and `PressedMessage` replacing staff-bot's own `TaskOrigin`.
