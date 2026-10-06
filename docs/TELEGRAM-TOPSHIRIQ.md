# Telegramdan topshiriq berish — the staff bot assigns work

Agreed 2026-10-06. His request, verbatim: «telegramda shunday imkoniyat kerakki
hodimlar biriga ish buyura olishi kerak telegram orqali va bu juda qulay
bolishi kerak». His answers to the six questions: **1b 2a 3a 4a 5a 6b**.

## 1. The answers, as rules

| # | Question | Answer | Rule |
|---|---|---|---|
| 1 | How is a task given | **b** — the «➕ Topshiriq» button AND any forwarded message | Two doors, ONE draft collector. The typed one-line command («Siroj ertaga …») is NOT built. |
| 2 | Who may give to whom | **a** — every active person to every active person | The existing rule: being signed in is the gate (`tasks/actions.ts`), the assignee must pass `canLogIn`. No new permission. Self is allowed («🙋 O'zimga»). |
| 3 | Voice / photo / file | **a** — yes, travels with the task and shows on the site | Telegram: the author's own messages are FORWARDED to the assignee before the task text. Web: the bytes are stored as `attachments` of entity type `task` and drawn in the task list. |
| 4 | Assignee buttons | **a** — 👀 Qabul qildim · ✅ Bajarildi · ⏰ Muddatni surish · 💬 Savol | Every press tells the author. |
| 5 | Author's view | **a** — «📤 Men bergan» in the bot | Open tasks the person gave, late ones marked 🔴, one-tap «🔔 Eslatish». |
| 6 | Auto-link a GS777 / batch code in the text | **b** — no | The text is stored as typed; no entity pointer is guessed. |

## 2. The draft — ONE collector, two doors

`src/modules/platform/telegram/task-draft.ts` (new), the shape of
`note-capture.ts`: an in-memory map keyed by chat, 30-minute TTL, lost on a
deploy (stated, the same trade as the calc intake and the zametka capture).

```
TaskDraft {
  taskId      — minted up front (uuidv7) so stored files pre-bind to it (#180)
  stage       — 'who' | 'what' | 'when'
  assigneeId  — null until picked
  texts[]     — typed lines, joined into the note
  sources[]   — {chatId, messageId} of the author's own messages (forwards,
                photos, voice, documents), ≤ 10, forwarded to the assignee
  files[]     — {fileId, kind, name, size} to download for the web (≤ 20 MB each)
  promptMessageId — the bot message whose keyboard the draft edits
}
```

One collector at a time per chat: starting a draft is refused in words while
a calc intake or a zametka capture is live, and vice versa. Starting a draft
DISCARDS a pending «Bajarildi» result for that chat, so `takeTaskPending` can
never eat the task's text.

**Door A — «➕ Topshiriq»** (and `/topshiriq`): a new reply-keyboard label.
Labels are routers and are never renamed; positions may move. It joins
`escapesIntake` (the derived fence in `owner-summary-wire.test.ts`).

1. **Kimga?** — an inline list of colleagues (`canLogInSql`), the author's
   recent assignees first (their own tasks given in the last 90 days), then
   everybody else alphabetically, two per row, «🙋 O'zimga» last. Anyone the
   bot cannot reach (no linked chat, or `TaskAssigned` muted) carries «📵».
   A typed name in this stage filters the list.
2. **Nima qilish kerak?** — text, voice, photo, video, file or a forwarded
   message; several messages are allowed. After the first one the bot shows
   the due keyboard.
3. **Muddat** — [Bugun] [Ertaga] / [Indinga] [Muddatsiz] / [📅 Sana yozish].
   «Sana yozish» reads `12.10`, `12.10 15:00` or `15:00` (today) on the
   Tashkent clock (`parseDue` with `tzOffsetMin = -300`). Pressing a due
   CREATES the task at once — no extra confirm tap — and the bot answers with
   the task card and [🗑 Bekor qilish].

Minimum: ➕ → person → type → due = four touches.

**Door B — a forwarded message.** A message with `forward_origin` arriving
while no collector is live gets the reply «📌 Topshiriq qilamizmi?» with
[📌 Topshiriq qilish] [🔍 Qidirish]. «Topshiriq qilish» starts a draft whose
first source IS that message and jumps to «Kimga?»; after the person the due
keyboard is shown at once (any text typed before a due is added as the
note). «🔍 Qidirish» runs today's lookup on the forwarded text, so nobody
loses the old behaviour. While a calc intake or a zametka capture is live,
forwards keep going to them exactly as today (forwarding is the intake's core).

## 3. What gets created

Through the ONE writer `createTask`, under the chat's honest actor
(`staffForChat` + `botActorFor`):

- `title` = the first typed line cut at ≤ 120 characters on a word, or
  «🎤 Ovozli topshiriq», «📎 Fayl», «🖼 Rasm», «↪️ Yo'naltirilgan xabar» when
  the draft has no text;
- `note` = every typed line joined (≤ 4000);
- `assigneeId`, `dueAt` as chosen, priority 2, no entity pointer (6b);
- `tasks.source_messages` = the forward pointers (so a reassign can forward
  them again);
- audit `after` carries `via: 'telegram'`.

The `TaskAssigned` push now carries the NOTE (today it carries only the title,
so a long instruction typed in the bot would arrive bare) and the sources
(the drain forwards `payload.forwards[]` before the sentence, the existing
`forwardOriginal` extended from one pointer to a list).

The web: the draft's files are downloaded off the poller (#706, `void`) into
`attachments` with `entity_type = 'task'`, `entity_id = taskId`; the task list
on `/bugun` (and every TasksPanel) draws image thumbnails, an `<audio>` player
for voice and a link for documents. The read gate gets a `case 'task'`:
the assignee, the author, or a `canActOnTask` holder; anybody else is refused
(an unmapped type is log-only and would SERVE the bytes — the derived
allowlist fence must name `task`).

If the assignee cannot be reached in Telegram the author is told in the same
reply: «⚠ Siroj Telegramga ulanmagan — topshiriqni faqat saytda ko'radi» or
«⚠ … topshiriq xabarlarini o'chirgan».

## 4. The assignee's message

`buttonsFor('TaskAssigned')`:
```
[👀 Qabul qildim] [✅ Bajarildi]
[⏰ Muddatni surish] [💬 Savol]
```
- **Qabul qildim** — `tasks.accepted_at` (0124), once; the message is edited
  to drop the button and say «👀 Qabul qilindi»; the author gets
  `TaskAccepted`.
- **Bajarildi** — the existing two-step (result text, «-» = none), plus a
  «✅ Natijasiz» button so nobody has to type a dash. The author already gets
  `TaskDone` with the result.
- **Muddatni surish** — [Ertaga] [Indinga] [1 haftaga] [📅 Sana yozish];
  a NARROW writer `rescheduleTask(id, due, ctx)` (never `updateTask`'s full
  replace), `canActOnTask`, audited; the author gets `TaskRescheduled`.
- **Savol** — «Savolingizni yozing»; the next text goes to the author as
  `TaskQuestion` with [💬 Javob berish]; the author's next text goes back to
  the assignee as `TaskAnswer` carrying the task's buttons again. Both are
  audit rows on the task (action `comment`).

All the one-text waits (result, question, answer) live in the SAME pending
map behind the ONE `takeTaskPending(chatId)` (the zametka fence pins exactly
one), routed by kind.

A task closed, cancelled or reassigned from ANY door retires its Telegram
copies (`retireTaskCopies`, the shape of `retireApprovalCopies`): the
`TaskAssigned` message is edited to «✅ Bajarildi» / «🗑 Bekor qilindi» /
«👤 Boshqaga berildi» and loses its buttons. Cancel tells the assignee;
reassign tells the author.

## 5. The author's «📤 Men bergan»

A new reply-keyboard label «📤 Men bergan» (and `/berganlarim`): the open
tasks this person gave to somebody else, newest first, capped at 20 with the
total said: «🔴» late, «👀» accepted, «⏳» not yet seen, then person · due ·
title. Under it up to 8 buttons «🔔 <short title>» — a press sends the
assignee `TaskReminder` («🔔 Eslatma: …», with the task's buttons), at most
once per task per 30 minutes (refused in words otherwise). Index 0124:
`tasks (created_by, status)`.

## 6. Notifications

New types `TaskAccepted`, `TaskRescheduled`, `TaskQuestion`, `TaskAnswer`,
`TaskReminder`, `TaskCancelled` join `MUTE_GROUPS.tasks` and are NEVER added
to `FOUNDERS` (round C: a grown group must not un-mute anybody). Every new
callback kind is handled ABOVE the approval guard in `staff-handlers.ts`, or
the button spins with no error (#939); one DERIVED fence reads every
`callback_data` the staff keyboards build and demands the parser accept it.

## 7. Data — migration 0124 (shared with docs/VED-TARIX.md)

```
tasks.accepted_at      timestamptz NULL
tasks.source_messages  jsonb NULL  CHECK (source_messages IS NULL OR jsonb_typeof(source_messages) = 'array')
CREATE INDEX tasks_author_idx ON tasks (created_by, status)
```

## 8. Never

- A forwarded message during a live calc intake or zametka capture is never
  taken for a task.
- No guessed entity link (6b).
- Nothing here sends anything to a CUSTOMER.
- No new permission: the gate stays «signed in»; `canLogIn` decides who can
  receive.
