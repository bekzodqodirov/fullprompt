# Ikki eshik — «🧮 Hisoblatish» and «🤖 AI rastamojka» made two doors (2026-11-08)

His report the day after round 3 reached production (ledger 140), verbatim:

> «1 chi muammo har bir fayl uchun sorayabti va tushunarsz holatga olib kelyabti men sendan soragan
> narsam shu ediki, AI rastamojkada hsoblatganda hamma malumotlarni bergandan keyin boldini bosganida
> ai tahlil qilib chiqib hamma malumot toliq bolsa tasdiq, agar toliq bolmasa nima malumotlar kerak
> ekanini sorashi kerak edi shularni kirgazib tasdiqni bosganda ai hsoblab berishi kerak. oddiy
> hsoblatishdan kirib borganida hamma malumotlarni kirgazib tasdiqni bosganida shunday turishicha ved
> hodimiga tushsin ai bergan komentariya bilan birga.»

The six questions as sent, and his answer «sen aytgandek bolsin» = every ⭐:

1. **Several files** — a) ⭐ the bot does not ask; the AI compares itself: the same goods are taken
   once, new goods are added, a packing list is read for weight/cube only; what it did is written on
   the card for the VED.
2. **Plain «🧮»** — a) ⭐ «Bo‘ldi» → a short summary with no questions → «✅ Tasdiqlash» → lands at
   the VED with the AI's commentary; a missing brutto/cube is the VED's to ask.
3. **Plain «🧮»'s AI estimate** — a) ⭐ it does not reach the seller; the AI only prepares the card
   for the VED (codes, rates, commentary).
4. **«🤖 AI rastamojka»** — a) ⭐ «Bo‘ldi» → the AI analyses → ONE table: complete → «Ma’lumot
   to‘liq — tasdiqlang»; incomplete → what is needed. An answer sends no message of its own; the
   table updates. «Tasdiqlash» → the AI computes.
5. **«🤖»'s law unit (dona/juft)** — a) ⭐ the AI codes the rows while reading, so the unit is asked
   in the table once; the AI answer after «Tasdiqlash» asks nothing; what is still missing goes to
   the VED.
6. **Files sent with no collection open** — a) ⭐ the offers stay, but files sent in a row get ONE
   question.

The diagnosis is the reproduction of 2026-11-08 (scratchpad r4fix/diag: ord.json, aidoor.json,
perfile.json, doors.json): both doors were ONE collector — `IntakeState.ai` was read only by the
certificate control — and both asked per file while collecting, refused «Bo‘ldi» once per open
file question, drew the asking table, sent an echo per answer, and after the landing sent the
seller the AI-VED answer carrying a second ask. None of those asks was his per-door choice: every
question behind them (1.10, 1.11, 1.13, 2.7, 2.8) named no door and was taken as ⭐, and
RASTAMOJKA-TUZATISH P1.3 had made the plain door ask by design. **This file supersedes those for
the bot's two doors.** The card form, the thread door and the VED's screens are untouched.

Numbering: DECISIONS #1582+, migration **0140** (`when` …119), ledger **141**.

---

## §1 Shared: no question per file (his 1a)

1.1 **No file asks anything.** Gone on both doors and in the ➕ add collection: the second-Excel
question («Oldingi faylda N ta tovar bor. Nima qilamiz?», `c:inv_add`/`c:inv_replace`), the
other-files question («AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?», `c:other_add`/
`c:other_same`) and «Bo‘ldi»'s refusals for them («Avval ikkinchi fayl haqida javob bering», «Avval
javob bering: …»). «Bo‘ldi» is never refused because of a file.

1.2 **The rule that replaces the seller's choice** — decided by the bot, said in its own notes:
- The first mapped Excel is the goods list.
- A further mapped Excel is compared row by row with the goods held (`sameGoodsLine`):
  - every row the same goods → **the same goods file** (a packing list): only its TOTALS are taken
    (brutto kg, cube; its per-line kilos are never written as line weights, its «мест» never a
    count); note «📄 «packing.xlsx» — o‘sha tovarlar: faqat og‘irlik va kub olindi»;
  - no row the same → **other goods**: its rows are added; note «📄 «X» — N ta yangi tovar
    qo‘shildi»;
  - some the same → only the new rows are added, nothing is taken from the matching ones; the note
    names both counts.
- A model-read file (PDF, image, header-less sheet) beside an Excel is read with the Excel's list
  as `knownGoods` (the model is told to list only goods NOT on it), then `pickGoods`' same-line
  dedup drops repeats; note «PDF dan N ta yangi tovar qo‘shildi» or «PDF dagi tovarlar Excel
  ro‘yxatida bor». This is today's `aiGoods: 'add'` path, now the only one.
- Every decision is a line of the card note's «AI izohi» (`intakeNoteText`), so the VED sees what
  was merged and can correct it. The model never decides a price; nothing here touches money.

1.3 **Collections already open when this deploys** (durable for 24 h) may hold `pendingInvoice`
or `aiGoods: 'ask'`. They are resolved by §1.2's rule at their next touch (any file, text, press
or «Bo‘ldi»), never left waiting on a button that is no longer drawn. The old buttons stay
PARSED (an unparsed callback spins ~15 s, #939): on a collection still pending, a press applies
its answer as before; otherwise «Bu tugma eskirgan.».

1.4 **One message per file only for a refusal** (HEIC, Word, video, archive, too big, the 4th
PDF, a broken sheet, a save failure). Everything informational («📄 … N ta tovar o‘qildi», «🖼 …
rasm sifatida o‘qiladi», «📄 … AI o‘qiydi», the §1.2 notes) folds into the ONE edited «Qabul
qilindi: …» prompt (`showIntakePrompt`).

1.5 **The customer is asked once per collection**, never once per file; a collection that already
holds material, once the customer is named, shows the «Qabul qilindi» prompt — never «Tovar
ro‘yxatini yuboring» about goods it already has.

1.6 **The AI-podklyuch zone question is asked once**, not once per file.

## §2 The plain door «🧮 Hisoblatish» (his 2a, 3a)

2.1 After «Bo‘ldi» and the reading: a **SUMMARY**, not a questionnaire — the rows and totals as
read, ✅ where complete; where something is missing, the row says what, once, as information
(«VED to‘ldiradi»); no «↳» asks, no «✍️ Bir xabarda istalgan qatorni to‘ldiring», no «Bilmagan
qatoringizni VED to‘ldiradi …» closing. Buttons: «✅ Tasdiqlash», «➕ Yana ma’lumot», «✖️ Bekor
qilish». No certificate control (it never had one).

2.2 **A typed text after the summary is more material**, never a table answer: the collection goes
back to the material stage and «Bo‘ldi» reads again. The summary says so: «Yana ma’lumot bo‘lsa —
yuboring va «Bo‘ldi» ni bosing.»

2.3 «✅ Tasdiqlash» lands the job **as is**: the card note carries the AI's commentary and what is
missing (unchanged machinery). The ✅ says: «✅ Saqlandi … 🧮 VED navbatiga tushdi — AI izohi
kartada.»

2.4 **The door reaches the request**: migration 0140 adds `calc_requests.intake_door text NULL`
CHECK `IN ('plain','ai')` — NULL = not a bot collection (card form, thread, older rows). Written in
the landing's INSERT by `landIntake` (new REQUIRED input); `intakeNoteText`'s `via` prints the door.
A seeded collection (a returned request's «➕») inherits its source's door; an add collection is
judged by its request's door.

2.5 **The landing pass still runs** — it pre-fills the VED's workspace (memory codes, PP-3818
rates, bazas) and writes the lenta note, which is the commentary he asked to keep — but on a plain
request it sends the seller **nothing** for rastamojka and podklyuch (3a). The yo‘lkira tariff
answer (his own 2.5 b, no model) stays, without its ask: «⚠️ umumiy hajm (m³) yo‘q — VED so‘raydi».
The lenta note on a plain request is the variant without «❓ Sotuvchidan so‘raldi».

2.6 **The ➕ door on a plain request**: «➕ Shu so‘rovga qo‘shish» stays under the plain ✅; the add
collection on a plain request is plain too (a summary, no asks); its re-run pass sends no estimate
to the chat. The add outcome's one line («qo‘shimcha yozildi» / «VED ga yuborildi») stays.

2.7 **No law-unit ask on a plain request**, ever (2.8 b / 1.14 a do not apply): the units are the
VED's; the lenta note names them.

## §3 The AI door «🤖 AI rastamojka» (his 4a, 5a)

3.1 **The reading codes the rows**: the sealed memory first, then the exact-key book, then the
model's own `tnvedCode` — kept even when an Excel answers the goods (merged onto the matching
invoice row by `sameGoodsLine`; today `pickGoods` drops them). So the table knows each row's law
and asks its unit (juft/dona/kg/m²/litr) ONCE, before «Tasdiqlash». A row the reading could not
code says «kodni AI hisobda qo‘yadi» — not ✅, not a question.

3.2 **Unit words are read as written**: «120 пар» is 120 juft, never «120 dona» with a ⚠️ juft
(reproduced in aidoor S2).

3.3 **The table**: complete → «✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing.»; incomplete → each
⚠️ row/total/route with what it needs, one «✍️» line with the example (`answerHow`). Complete
means the SELLER's part is complete; the customs value comes after, from the sealed memory or his
quarterly import (stated to him).

3.4 **An answer edits the table and sends no message** (4a): the echo per answer and its «↩️» go
(1.11 c superseded); a retyped row overrides. The seller's message gets a 👍 reaction
(`setMessageReaction`, best-effort — a failure changes nothing) so he sees it was taken. A refused
or unclear answer still gets its one-line reply (the refusal words of §8 of R3 stay).

3.5 «✅ Tasdiqlash» → lands → «✅ Saqlandi … 🤖 AI hisoblayapti — natija shu yerga keladi. Rasmiy
narxni VED beradi.» → the pass computes and replies with the figure and **no ❓ block** (5a):
whatever it still finds missing goes into the lenta note for the VED («⚠️ VED uchun: …»). The
2.8 b / 1.14 a seller ask is gone from the landing pass.

3.6 **The AI door's answer reaches him past the «✅ Mening vazifalarim» mute** — he pressed the door
for it (his 1.20 ⭐ logic) — through the drain as one claim row, never a second sender.

3.7 The certificate control stays on the AI door's table keyboard (and leaves the echo, which is
gone).

3.8 The ➕ add collection on an AI request asks the same way (one table, no echo, no ❓ after).

## §4 Outside a collection (his 6a)

4.1 **One question per burst**: files or forwards sent in a row — same chat, each within 2 minutes
of the previous, nothing typed between — get ONE offer message, edited to count them («➕ 3 ta
faylni so‘rovga qo‘shamizmi?» / «📌 3 ta xabar — topshiriq qilamizmi?»); its buttons act on the
whole burst (the topshiriq takes every forward as a source, the ➕ takes every file).

4.2 **Beside a PARKED collection the pause line wins** over the ➕ offer, once per burst; «▶️ Davom
etamiz» under it takes the burst's files into the collection (the press is his consent — 1.8 c's
«a parked collection takes nothing by itself» holds).

4.3 **A just-landed request is offered at once**: the offer list's cache is cleared by the landing.

## §5 Not changed

Money (prices, rates, upsale, the seal), the VED's four doors and `amended_since`, the durable
store and its flush, the card form, the thread door, the corpus ratchet (142 known; any change to
`intake.ts`, `intake-manual.ts`, `calc-intake.ts`, `staff-handlers.ts`' collector runs the WHOLE
corpus first, and a known case that starts passing leaves the list).

## §6 Tests that pin the old behaviour

Re-anchored on his 2026-11-08 words, each named in the commit: `intake-collector*.test.ts`,
`intake-corpus.test.ts` (+ fixtures' scenario cases), `calc-read-press.test.ts`,
`bot-redelivery.integration.test.ts`, `totals-question.test.ts:212`, `calc-dialog.test.ts` (its
collections open `ai:false` — table/echo tests move to `ai:true`), `calc-undo.test.ts`,
`intake-table.test.ts`, `intake-questions.test.ts`, `calc-stated-presses.test.ts`,
`calc-r3-kernel.test.ts`, the bot integrations that drive «🧮 → rastamojka» through the table,
`ai-reply.test.ts`, `law-asks.test.ts`, `calc-pass-settle.integration.test.ts`,
`intake-confirm.test.ts`, `intake-reply-link.test.ts`. A test that pinned a question he has now
refused is rewritten to pin its absence, never deleted silently.

## §7 Stated to him, not built

- On the plain door a missing brutto/cube is the VED's to get; the seller's upsale is measured on
  the confirmed cargo, so nothing pays on a guess.
- «Ma’lumot to‘liq» on the AI door means the seller's part is complete; whether the AI can put a
  figure on it depends on the customs value (memory / quarterly import).
- His 2.8 b (asking after the AI answer) is superseded on both doors by 5a.
- The yo‘lkira tariff answer on the plain door stays (his 2.5 b), without its question.
