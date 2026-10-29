# Agent feed — the client-finding agent ↔ the ERP

The client-finding agent (a separate Python service, «clientScrapper») finds
Uzbek importers of Chinese goods on the open internet, scores them, lets the
owner approve them, and PUSHES the approved ones here as leads. Human sellers
take it from there; the agent never writes to a prospect. It reads two feeds
back: what it must never propose again (suppression), and what became of
every lead it pushed (outcomes).

Code: `src/modules/wms/crm/agent-source.ts` (the key), `inbound.ts` (the
landing and its belt), `agent-feed.ts` (the feeds), `agent-feed-door.ts` (the
GET door), `first-contact.ts` / `inbound-notify.ts` (the clock),
`platform/settings/reason-list.ts` (the setting's parser). Decisions #1545-#1549,
the first review's corrections #1550-#1556, and the second's #1557-#1562.

---

## 0. Egasi uchun — besh qadam

Deploydan keyin (migratsiya yo'q; `/api/version` dagi build vaqti yangilanganini
tekshiring):

1. **CRM → ⋯ → Kelgan arizalar → «Reklama havolalari» → «Agent (qidiruv)» →
   «Platformaning o'z formasi» → «Yoqish va kalit yaratish».** Chiqqan kalitni
   agent serveridagi `.env` ga `CRM_AGENT_KEY` qilib qo'ying (chatga yozmang).
   Kalitni qayta yaratsangiz eskisi darhol ishlamay qoladi va agent butun
   ro'yxatni qaytadan oladi.
2. **CRM → ⋯ → CRM sozlamalari → «Yo'qotish sabablari»**: «Qayta qilinmasin»
   sababini qo'shing. **Diqqat:** ro'yxat hozir bo'sh bo'lsa, birinchi sabab
   qo'shilgan zahoti lidni yo'qotishda faqat ro'yxatdagi sabablarni tanlash
   mumkin bo'ladi — jamoa hozir ishlatadigan sabablarni ham o'sha zahoti
   qo'shing. Ro'yxatdagi sababning nomini keyin o'zgartirmang: kerak bo'lsa
   eskisini o'chirib, yangisini qo'shing (yoki yangi yozuvni 5-qadamdagi
   sozlamaga ham qo'shing).
3. **Boshqaruv → Arizalar taqsimoti → «Oqim qoidalari»**: A qoida — manba
   `agent`, «Kub (dan)» = 1, kimga = yuk bo'yicha sotuvchilar; B qoida — manba
   `agent`, kubsiz, kimga = qolgan sotuvchilar (yoki umumiy navbatga
   qoldiring). A ni B dan yuqoriga, ikkalasini ham umumiy qoidalardan yuqoriga
   qo'ying.
4. Agent bitta sinov arizasini yuboradi. Keyin shu ekranning **«Forma
   savollari» → «Reklamadan kelgan yangi savollar»** ro'yxatida `kub` →
   **Kub (m³)** qiling; xohlasangiz `stir`, `imports`, `score` ni lidning
   maxsus maydonlariga (avval maydonni yarating) bog'lang; `firma`,
   `telegram`, `instagram`, `website`, `address`, `evidence`, `utm_source` →
   **«Izohda qolsin»** (firma nomi lidning «Kompaniya» maydoniga baribir
   yoziladi). `kub` bog'lanmaguncha kelgan arizalar kubsiz qoida (B)
   bo'yicha taqsimlanadi.
5. **Boshqaruv → Sozlamalar → `agent_no_contact_reasons`**: 2-qadamdagi sabab
   nomi bilan bir xil ekanini tekshiring (standart: `Qayta qilinmasin`; bir
   nechta bo'lsa `;` bilan).

Agent orqali kelgan lid sotuvchiga odatdagidek darhol Telegram xabari bilan
boradi, lekin **15 daqiqalik «⏰ tegilmagan» eslatmasi bu lidlar uchun
yuborilmaydi** (kuniga 25 tagacha bo'lishi mumkin). Birinchi aloqa vaqti
baribir o'lchanadi: /crm/tahlil va agentning o'zi shuni o'qiydi.

---

## 1. The door — `POST /api/leads/in/agent`

The ordinary webhook door (docs/ADS.md §5.3) on the `agent` source.

- Header **`X-GSR-Key: <kalit>`** — the `agent` source's own webhook secret,
  minted on the doors screen (§0 step 1). The agent may also send
  `X-ERP-Key` with the same value; it is not read. With no `X-GSR-Key`
  header the door also takes the key from a body field `key` or `google_key`
  (Google's lead form cannot set a header) — the agent sends the header.
  A failed key LOOKUP is told 503 only to a caller that sent the header; a
  failed LANDING is told 503 whichever way the key came (the table below).
- Body: JSON object, plain shape.

  | Key | Read as | Limit |
  |---|---|---|
  | `name` (or `ism`) | the lead's name | 120 UTF-16 units — what JavaScript's `.length` counts, so an emoji is two — whitespace collapsed first. A cut never halves an emoji: one that does not fit is left out whole. A sequence of several code points (a ZWJ family, a flag, a skin tone, a keycap, a letter + combining mark) can lose its tail at the cut |
  | `phone` (or `telefon`) | the phone; identity = its last 9 digits | 9+ digits, or the push is `dropped/no_phone` |
  | `note` (or `izoh`) | the first lenta note | see below |
  | `external_id` (or `id`) | the replay key | — |
  | `company` / `firma` | `leads.company` (the card's own column) on a CREATED lead — **and** a note line and a pair like any other key, so a joined push still shows it | 200 chars on the card |
  | any other key | a `key: value` line appended to the note, AND a question pair for the mapping screen | 30 pairs, key 80, value 300 UTF-16 units (the same rule) |

  `company`/`firma` reach the card's column through the agent's door only;
  every other webhook door keeps them as the note line and pair they always
  were (docs/ADS.md §5.3).

  The note is the agent's note, then one `key: value` line per extra key in
  the body's own order, then **all whitespace — line breaks included — is
  collapsed to single spaces and the whole is cut at 1000 characters** (every
  door does this). So the lenta shows one paragraph, and the seller's
  Telegram push shows its first 160 characters: keep the note ≤ 700 and its
  opening sentence self-sufficient; put keys the ERP must keep (e.g.
  `utm_source`) where a 1000-character cut cannot reach them, or rely on `ref`
  (below), which stores the whole body minus the key, uncut. A lone UTF-16
  surrogate or a NUL (U+0000) the body carries (`"\ud83d"` and `"\u0000"`
  are valid JSON) is stored as U+FFFD wherever it lands — the
  `external_id` included, so the outcomes feed hands such an id back with
  U+FFFD in its place, and two ids that differ only there (a NUL against a
  U+FFFD, one lone half against another) are ONE id: the second is a
  replay. In `ref`, two keys of one object that differ only there become one
  key and the last value is kept. A body nested too deep to serialise
  (thousands of levels) is kept in `ref` as `{"_truncated":true}`; the
  arrival still lands.
- `external_id = cs:<company_uuid>:<yyyymm>` (46 bytes). The outcomes feed
  only reports ids that start with `cs:`. An id the ledger's unique index
  cannot hold — only one over 2,048 UTF-8 bytes can be refused, and postgres
  takes about 2,680 bytes it cannot compress — is stored as `sha256:` and the
  hex SHA-256 of its UTF-8 bytes (after the U+FFFD rule): it lands, its retry
  is a replay, and the outcomes feed never shows it. Every id the index holds
  keeps its own spelling.
- Answer:

  | Code | Means | Do |
  |---|---|---|
  | `200 {"ok":true}` | the arrival was RECORDED — whatever became of it: created, joined, suppressed, capped, no_phone … — or it is a replay of one that was | done; the outcomes feed says which |
  | `503 {"error":"unavailable"}` | the landing failed (or, when `X-GSR-Key` was sent, the key lookup did): no ledger row — but a lead, and on a retry a joined lenta note, may already stand (the replay fence below) | retry, same `external_id` |
  | `500`, empty body | the database failed before the key could be checked and no `X-GSR-Key` header was sent | retry |
  | `404` | the door is off, the key is wrong or absent, or the body is not JSON | do not retry; tell the owner |

  The outcome itself never changes the answer: created and suppressed read
  the same 200. Only a FAILED landing differs, and only on this door — every
  advert door, the «Boshqa» fallback (§6) included, answers 200 even then.
- Replay fence: the same `(channel='webhook', external_id)` a second time is
  answered 200 and lands NOTHING — no second lead, no second ledger row —
  once the first delivery has FINISHED. A delivery that arrives while an
  earlier one of the same id is still running waits for it (the app is one
  process and chains them per id) and is then that replay: a re-send after a
  read timeout cannot make a second lead. A landing that failed AFTER its
  lead was written leaves that lead standing; the retry then JOINS it, so the
  outcome reads `joined` and the seller hears «🔁 Qayta yozdi» about a lead
  whose «🆕» never came (§5). Only a database failure half-way does that
  now: no text the body carries — an emoji at a cut, a lone surrogate, a NUL,
  a body nested too deep, an id too long for the index — makes a write refuse
  any more (#1557, #1563, #1566). A cause that repeated on every attempt
  would answer 503 to every retry and add one lenta note each; one is known,
  and no real body reaches it: a body of tens of megabytes (§5).
- Caps (counted over the arrivals ledger, dropped arrivals included):
  3 per phone per day, 200 per source per day → `dropped/capped`. The
  per-phone count is per FAMILY: an agent push through THIS door counts only
  the agent's arrivals on that phone, and those never count against a
  person's form, advert or bot enquiry on the same number. A push through the
  «Boshqa» fallback (§6) is an ordinary arrival: it counts in the people's
  family, so three of them on one phone do cap that person's own enquiry for
  a day.
- `agent` is accepted ONLY through this webhook: a person typing
  `/ariza?manba=agent` is recorded under «Sayt» (the form's answer to any
  word it does not offer, as before the key existed), and one opening
  `t.me/<bot>?start=ad_agent` — or posting the form by hand — under «Boshqa»,
  so a human never inherits the belt, the silent clock or a row in the
  outcomes feed.

## 2. What the ERP does with an `agent` arrival

In order (`landInboundLead`):

1. no phone and no name → `dropped/no_contact`;
2. replay → nothing (above);
3. no phone of nine digits or more → `dropped/no_phone` (the belt below could
   not check it, so it must not reach a seller);
4. caps (the agent's family, §1) → `dropped/capped`;
5. **the belt** → `dropped/suppressed`. Nothing is created, nobody is told —
   not the client's manager, not the office. Reaching this means the agent's
   copy of the feed was stale; the outcomes feed tells it so. The belt reads
   the suppression set (§3.1) by the app's OWN phone rule (`phonesMatch`):
   the arrival's last nine digits against every tail, and against a card or
   lead phone VALUE of only seven or eight digits by those last seven or
   eight — over inactive clients too. (A seven-digit PIECE of a longer value,
   «90/283-65-94» → «2836594», is no tail: matched by suffix it would answer a
   hundred strangers.) About 90 ms an arrival at 2,000 clients and 40,000
   leads — linear in the lead history. So it is never narrower than the advert path's
   «already a customer» step that follows it, and that step (`client`) cannot
   fire for an agent push;
6. the one open lead on the same phone (≤ 30 days) → `joined` (a note on that
   lead, its owner unchanged, the owner is pushed);
7. otherwise a **new lead**: routed by the taqsimot rules (`manba = agent`,
   the mapped `kub`, or a volume read from the text), booked for today, the
   seller pushed «🆕 Yangi lid · Agent (qidiruv)».

The **contact clock** starts for created and joined arrivals with
`contact_due_at = NULL`: the owner's «⏰ tegilmagan» reminder never claims an
agent arrival, while `stampFirstContacts` still writes `contacted_at` /
`contact_kind` from the first call, Telegram message, the seller's note, a
stage move, a cleared follow-up or the «📞 Bog'landim» button. An unstamped
agent arrival is looked at for **90 days** (an advert's for 7 — after that
nothing else ever asks about an agent lead). A `joined` push into a
conversation already live in the last 24 hours gets **no clock**: its
`contacted_at` stays null, and its `outcome` says what happened. /crm/tahlil's
«Birinchi aloqa» reads `contact_clock_at`/`contacted_at`, never the due time,
so agent leads ARE in a seller's late counts there — and in the median by
the rule every source has: a first contact within the week is a median
sample, a later one (stamped only for the agent's sake) is late and nothing
else.

Adverts, the form and the bot are unchanged: a client's phone through an
advert still lands on the client's card (`client`), only for ACTIVE clients.
The fixes of the second, third and fourth reviews reach every door, and
none changes what a landing that worked did (#1557-#1559, #1563, #1566): an
external id too long for the ledger's unique index is stored under its
SHA-256 (it used to fail the ledger row after the lead), text is cut in
the UTF-16 units it always was but never through an emoji, and a lone
surrogate or a NUL is stored as U+FFFD (an emoji at an edge, or a NUL
anywhere, used to throw after the lead was written — on the public form that
was a lead the daily caps never counted); a client card whose `phones` is not
a list is read as no phones (one such card failed every arrival with a
phone); and a delivery of an `external_id` already in flight waits for it.

## 3. The feeds

Both: `GET`, header `X-GSR-Key` (the same key as the door), never in the URL.

| Code | When |
|---|---|
| 200 | the body below |
| 304 | `If-None-Match` equals the ETag — in practice never, the body carries `generated_at` |
| 400 | `{"error":"bad_cursor"}` or `{"error":"bad_since"}` — a bug on the caller's side, do not retry |
| 404 | door off, key wrong or absent, unknown path — and any failure while no key was sent |
| 503 | `{"error":"unavailable"}` — the database is down; back off and retry. Only to a caller that sent `X-GSR-Key` |

Bodies of 1 KB or more are gzipped when `Accept-Encoding: gzip` is sent.
`Cache-Control: private, no-store`. Query parameters, all optional:
`limit` (default 1000, max 5000, garbage → default), `since` (a FULL ISO
8601 instant — date, time and `Z` or an offset, e.g. `2026-10-24T05:00:00Z`;
microseconds kept; anything else, `0` or `2026-02-30…` included, is 400
`bad_since`; rows that moved strictly after it), `cursor` (the previous page's
`next` or `resume`, **opaque** — three `|`-separated parts inside base64url;
hand it back verbatim). Follow `next` until it is `null`. Keep the same
`since` while following one walk. Every body also carries **`resume`**: the
cursor of this page's last row — on the last page too, where `next` is null —
or, on an empty page, the cursor that was sent, or `null` when none was
(keep the one you had).

- `resume` continues the OUTCOMES walk and a suppression DELTA. A FULL
  suppression pull always starts from nothing — neither `since` nor
  `cursor` — and only a walk that started that way may delete the rows it did
  not see: a walk started from a stored cursor without `since` is still
  labelled `mode: "full"`, but holds only the rows after the cursor.
- `limit`: absent, `0` or not a number → 1000; below 1 → 1; above 5000 → 5000.
- `since` with an offset: the `+` must be URL-encoded (`%2B05:00`), or it
  arrives as a space and is 400 `bad_since`. `Z` needs nothing.
- Every suppression page computes the whole set again (≈0.3 s at 17,000
  entries): pull with `limit=5000`, not in small pages.

### 3.1 `GET /api/agent/suppression`

```json
{
  "mode": "full",
  "generated_at": "2026-10-24T05:20:11.093Z",
  "salt_id": "8254c329",
  "rule": "hmac-sha256(secret, last9digits) hex[0:20]",
  "entries": [{ "h": "2ea6869e504cebca50f0", "kind": "client", "at": "2026-10-24T05:16:13.981Z" }],
  "next": null,
  "resume": "MjAyNi0xMC0yNFQwNToxNjoxMy45ODEyMzRafDAxOTI4YzNlLTdiMWEtN2NjMC05ZDJlLTFmMGEyYjNjNGQ1ZXwx"
}
```

- `mode`: `full` without `since`, `delta` with it.
- `h` = `hmac_sha256(key, tail9).hexdigest()[:20]`, `tail9` = the last nine
  digits of the phone. Test vector: key `k`, tail `901234567` →
  `2ea6869e504cebca50f0`.
- `salt_id` = `sha256(key).hexdigest()[:8]` (key `k` → `8254c329`). It changes
  when the owner re-mints the key: every stored hash is then stale — pull full.
- `kind`: `client` — any phone on any client card, **active or inactive** (a
  former client is still ours; wider than the advert path's client check on
  purpose), any phone on the PERSON record that ties a client's codes
  together (CRM → Odamlar; its list is edited apart from the cards), and the
  phone of any lead that BECAME a client (on a `won` stage,
  or attached to a client code — attaching does not copy the lead's phone onto
  the card); `lost` — a lead on a `lost` stage whose `lost_reason` equals one
  of the labels in the setting `agent_no_contact_reasons` (`;`-separated).
  Both are compared one way: every run of whitespace (as JavaScript's `\s`
  counts it — the no-break space included) one space, trimmed, lower case.
- What one phones value yields: its whole last nine digits; the last nine of
  each part when it holds several numbers (split at `, ; / | \`, a line
  break, two spaces, or a space before `+`); and, inside a part of more than
  fifteen digits (no single phone is that long — the client import keeps a
  multi-number cell as one run), every whole 12-digit `998…` number — or,
  only when the run is NOT made of those, every whole 9-digit number (three
  998 numbers are 36 digits, a multiple of nine too, and their 9-digit
  pieces are nobody's phone). A run that is neither is read by its last nine
  only. A part shorter than nine digits yields nothing of its own.
- `at`: when the row last moved — a client card's `max(created_at,
  updated_at)`, a lead's `max(closed_at, updated_at)`, a person's
  `max(created_at, updated_at)` and the newest `updated_at` of the cards
  that hold it (tying a code to a person writes the CARD, so that is the
  moment the person's numbers join the set).
- Not deduplicated: two cards on one phone are two entries with one `h`;
  upsert on `(kind, h)`.
- **A delta cannot express a deletion**, and a label ADDED to the setting brings
  its old leads in with their old `at` — the nightly full pull is the truth,
  the hourly delta an optimisation. A lead revived out of `lost`, a phone
  removed from a card or a label taken off the list simply stops appearing.
  Nor can a delta see a funnel stage whose KIND the owner changes
  (open ↔ won ↔ lost, CRM sozlamalari): every lead on it joins or leaves the
  set with no `at` moving. Only the full pull sees it.
- Tails shorter than nine digits never appear in the feed. A card or lead
  phone VALUE of seven or eight digits is still matched by the BELT (§2
  step 5), so
  a push on it comes back `dropped/suppressed` — the agent should then keep
  the phone it pushed in its own suppression; the nightly feed will never
  bring that number as a hash.

### 3.2 `GET /api/agent/outcomes`

```json
{
  "generated_at": "2026-10-24T05:20:11.093Z",
  "rows": [
    {
      "external_id": "cs:0b9…:202610", "intake_id": "…", "outcome": "created", "reason": null,
      "lead_id": "…", "client_id": null, "stage_kind": "open", "stage_name": "Yangi",
      "lost_reason": null, "no_contact": false, "closed_at": null,
      "contacted_at": "2026-10-24T06:02:00.000Z", "contact_kind": "call",
      "quoted_volume_m3": 2, "at": "2026-10-24T06:02:00.000Z"
    }
  ],
  "next": null,
  "resume": "…"
}
```

Exactly these 15 fields, nothing else:

| Field | Meaning |
|---|---|
| `external_id`, `intake_id` | the push and its ledger row |
| `outcome` | `created` / `joined` / `client` / `dropped` |
| `reason` | for `dropped`: `suppressed` / `capped` / `no_phone` / `no_contact` (null otherwise) |
| `lead_id` | the lead it became or joined (null when dropped or `client`) |
| `client_id` | the lead's client once won, or the client it was recognised as |
| `stage_kind`, `stage_name` | the lead's stage now: `open` / `won` / `lost`, and the owner's name for it |
| `lost_reason` | the TEXT chosen at the move (≤ 200 chars) **only when it is a label**: one of the owner's lost-reason dictionary rows (active or retired) or a label of `agent_no_contact_reasons`, compared as in §3.1. A seller's free text — what a lost lead carries before the dictionary exists, and where a name or a number gets written down — is `null` |
| `no_contact` | `true` when the lead is lost with a reason `agent_no_contact_reasons` lists — the ERP's own answer, so the agent needs no copy of the setting |
| `closed_at` | when the lead was decided |
| `contacted_at`, `contact_kind` | the FIRST contact after the arrival: `call` / `telegram` / `note` / `stage` / `followup` |
| `quoted_volume_m3` | the lead's kub (number) |
| `at` | when the row last moved: `max(arrival, first contact, any change on the lead, its decision)` |

- Rows: `channel = 'webhook'`, `external_id LIKE 'cs:%'`, arrived within the
  last **year**, from the `agent` source — **or** from «Boshqa» (`other`)
  with `ref.utm_source = 'clientscrapper'` (the fallback months, §6).
- Order and cursor: `(at, intake_id)`. A cursor read is NOT complete on its
  own: `contacted_at` is the EVIDENCE's time, and evidence surfaces late — a
  calls-app phone that was offline for a day, a Telegram account whose
  history is pulled a week back when it connects — so a contact stamped after
  a read can carry an `at` older than that read's last row; and a row whose
  transaction committed after a read can carry an `at` the read already
  passed. Read nightly **by cursor AND with `since = now − 8 days`** (no
  cursor), weekly with `since = now − 90 days` (the stamping horizon, §2),
  and monthly with **neither** `since` nor `cursor` (the whole year — below).
  Upsert by `external_id`; a re-read row is the same row.
- `outcome = joined` reports the stage of a lead somebody else was already
  working, even one that came from another source — its stage, its kub and its
  decision become visible to the agent for that lead (stated, not hidden: the
  agent proposed that same phone, and the join leaves a visible note on the
  lead). `client` appears only through the fallback door: the agent's own
  door suppresses every phone a client card answers to first (§2).
- The feed reads a stage's KIND live: when the owner changes a stage from
  open to lost (or back) every lead on it changes `stage_kind` with no `at`
  moving. A `since` read cannot see it for a row whose `at` is older than
  that `since`; only the monthly read with neither `since` nor `cursor`
  (every row of the year) catches it everywhere.
- Never: a name, a phone, a note, an owner, a price.

## 4. Privacy

What leaves the ERP is hashes of phone tails, ids, stage names, a lost
reason when it is a LABEL, timestamps and a kub figure. No name, phone, note,
owner, money or a seller's free text. The agent compares its own candidates' hashed tails against the
suppression list; it never receives the client book.

## 5. Honest limits

- Nine digits are a small space: whoever holds the key can enumerate it and
  recover every tail from the hashes. The hash keeps the list out of logs,
  backups and screenshots of the agent's database — it is not encryption
  against the key holder.
- Re-minting the key rotates `salt_id` and closes the door to the old key at
  once (pushes 404 until the agent's `.env` is updated).
- A lead revived out of `lost` leaves the suppression set — correct: somebody
  decided to work it again.
- The same company on a new phone number is a new phone here.
- A free-text lost reason (before the dictionary exists) never leaves:
  `lost_reason` is null and `no_contact` still answers.
- Suppression entries carry their card's `at`, so the key holder can tell
  which hashes share a card — one person's numbers, grouped. Combined with the
  enumeration above, that is the client book's phone groupings, not only its
  numbers.
- The last nine digits of a Chinese mobile (`+86 1xx …`) on a client card
  are a valid Uzbek mobile tail too, so they suppress the unrelated Uzbek
  number that ends the same way — fail-closed, and the same last-nine rule the
  whole app uses.
- A first contact counts only where the ERP sees it: a call through the calls
  app, a message from a CONNECTED Telegram account on a chat that belongs to
  the lead, a note, a stage move, a cleared follow-up, the «📞 Bog'landim»
  button. A seller writing from a personal account whose chat sits on the tray
  undecided is a contact the feed does not report.
- The fallback clause (§6) is permanent: anybody holding the «Boshqa» door's
  key can post an arrival with `utm_source: clientscrapper` and a `cs:` id,
  and it appears in the outcomes — ignore rows whose `external_id` you never
  pushed. The replay fence is per channel across every source, so a `cs:` id
  posted first through another door makes your push a replay; the ids carry
  your own company uuid, which nobody else knows.
- A landing that fails half-way (the database, after the lead's INSERT)
  leaves the lead; the agent's retry joins it (`joined`, «🔁 Qayta yozdi»
  for a lead never announced). No text the body carries causes one any more
  (#1557, #1563, #1566), and one SIZE still does: `ref` is the whole body,
  nothing caps a route handler's body, and postgres refuses a jsonb past its
  limits (measured in postgres, not through the route: an array of twenty
  million zeros, 40 MB of JSON, is refused; ten million is stored). Such a body lands its lead and then fails its ledger
  row on every attempt — on this door a 503 each time, on every other a 200
  with an orphan. Only a key holder can send it, and the agent's own bodies are
  a few kilobytes; the cure is to write the ledger row first, deferred
  (#1563, #1567). A narrower case stays: the ledger row COMMITS and its
  answer is lost on the way back (the connection dies in between). The agent
  is told 503, its retry is a replay answered 200, and nothing announces that
  arrival again: no «🆕», no contact clock, so the outcomes row reads
  `created` and never `contacted_at`. Reasoned, not reproduced; the same
  window has always existed on every door.
- After a half-way failure, the retry can still make a SECOND lead: when the
  seller moved the orphan to won or lost in between (the retry finds no open
  lead), or when three other agent pushes on that phone the same day cap it
  (`dropped/capped`, no lead id, the orphan stands). Reasoned, not probed.
- The in-flight fence (§1) is per app process — per copy of the landing's
  module, and every channel with an id lands through one caller, so each
  channel's deliveries meet in one copy. Production runs one app process;
  across processes the ledger's unique index still keeps one ledger row, not
  one lead. A first delivery that never settles (a statement on a dead
  connection) holds every later delivery of that id until a restart; each
  waiter holds only its HTTP request.
- The doors screen sends a door's key only to whoever holds
  `admin.settings.manage` — the page data of every other `crm.manage` holder
  carries none (it is the agent key that reads the feeds).

## 6. Before this door existed — the «Boshqa» fallback

The agent may push through `POST /api/leads/in/other` with the «Boshqa» door's
key and `utm_source: clientscrapper` in the body. Those arrivals are reported
by the outcomes feed (the `other` + `utm_source` clause) once this branch is
deployed, but they are ordinary arrivals: no belt, the owner's 15-minute
reminder DOES fire for them, they count in the people's per-phone cap, and a
landing that fails there is still answered 200 — reconcile a push that never
shows up in the outcomes. **Never re-push an `external_id` after switching
the source to `agent`:** the channel is the same (`webhook`), so the second
push is a replay and lands nothing.
