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
`platform/settings/reason-list.ts` (the setting's parser). Decisions #1455-#1459.

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
   maxsus maydonlariga (avval maydonni yarating) bog'lang; `telegram`,
   `instagram`, `website`, `address`, `evidence`, `utm_source` →
   **«Izohda qolsin»**. `kub` bog'lanmaguncha kelgan arizalar kubsiz qoida (B)
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
  `X-ERP-Key` with the same value; only `X-GSR-Key` is read.
- Body: JSON object, plain shape.

  | Key | Read as | Limit |
  |---|---|---|
  | `name` (or `ism`) | the lead's name | 120 chars (cut, whitespace collapsed) |
  | `phone` (or `telefon`) | the phone; identity = its last 9 digits | 9+ digits or it is no phone |
  | `note` (or `izoh`) | the first lenta note | see below |
  | `external_id` (or `id`) | the replay key | — |
  | `company` / `firma` | `leads.company` (the card's own column) | 200 chars |
  | any other key | a `key: value` line appended to the note, AND a question pair for the mapping screen | 30 pairs, key 80, value 300 chars |

  The note is the agent's note, then one `key: value` line per extra key in
  the body's own order, then **all whitespace — line breaks included — is
  collapsed to single spaces and the whole is cut at 1000 characters** (every
  door does this). So the lenta shows one paragraph, and the seller's
  Telegram push shows its first 160 characters: keep the note ≤ 700 and its
  opening sentence self-sufficient; put keys the ERP must keep (e.g.
  `utm_source`) where a 1000-character cut cannot reach them, or rely on `ref`
  (below), which stores the whole body minus the key, uncut.
- `external_id = cs:<company_uuid>:<yyyymm>`. The outcomes feed only reports
  ids that start with `cs:`.
- Answer: **always `200 {"ok":true}`** — created, joined, recognised,
  suppressed, capped and a database failure all read the same. **404** when
  the door is off, the key is wrong or absent, or the body is not JSON.
- Replay fence: the same `(channel='webhook', external_id)` a second time is
  answered 200 and lands NOTHING — no second lead, no second ledger row. A
  re-send after a timeout is therefore safe.
- Caps (counted over the arrivals ledger, dropped arrivals included):
  3 per phone per day, 200 per source per day → `dropped/capped`.
- `agent` is accepted ONLY through this webhook: a person typing
  `/ariza?manba=agent` or opening `t.me/<bot>?start=ad_agent` is recorded
  under «Boshqa» like any unknown source, so a human never inherits the belt,
  the silent clock or a row in the outcomes feed.

## 2. What the ERP does with an `agent` arrival

In order (`landInboundLead`):

1. no phone and no name → `dropped/no_contact`;
2. replay → nothing (above);
3. caps → `dropped/capped`;
4. **the belt**: the phone's last 9 digits are in the suppression set (§3.1) →
   `dropped/suppressed`. Nothing is created, nobody is told — not the client's
   manager, not the office. Reaching this means the agent's copy of the feed
   was stale; the outcomes feed tells it so;
5. the one open lead on the same phone (≤ 30 days) → `joined` (a note on that
   lead, its owner unchanged, the owner is pushed);
6. otherwise a **new lead**: routed by the taqsimot rules (`manba = agent`,
   the mapped `kub`, or a volume read from the text), booked for today, the
   seller pushed «🆕 Yangi lid · Agent (qidiruv)».

The **contact clock** starts for created and joined arrivals with
`contact_due_at = NULL`: the owner's «⏰ tegilmagan» reminder never claims an
agent arrival, while `stampFirstContacts` still writes `contacted_at` /
`contact_kind` from the first call, Telegram message, the seller's note, a
stage move, a cleared follow-up or the «📞 Bog'landim» button. /crm/tahlil's
«Birinchi aloqa» reads `contact_clock_at`/`contacted_at`, never the due time,
so agent leads ARE in a seller's median and late counts there.

Adverts, the form and the bot are unchanged: a client's phone through an
advert still lands on the client's card (`client`), only for ACTIVE clients.

## 3. The feeds

Both: `GET`, header `X-GSR-Key` (the same key as the door), never in the URL.

| Code | When |
|---|---|
| 200 | the body below |
| 304 | `If-None-Match` equals the ETag — in practice never, the body carries `generated_at` |
| 400 | `{"error":"bad_cursor"}` or `{"error":"bad_since"}` — a bug on the caller's side, do not retry |
| 404 | door off, key wrong or absent, unknown path |
| 503 | `{"error":"unavailable"}` — the database is down; back off and retry |

Bodies of 1 KB or more are gzipped when `Accept-Encoding: gzip` is sent.
`Cache-Control: private, no-store`. Query parameters, all optional:
`limit` (default 1000, max 5000, garbage → default), `since` (any ISO
instant; rows that moved strictly after it), `cursor` (the previous page's
`next`, **opaque** — hand it back verbatim). Follow `next` until it is `null`.
Keep the same `since` while following one walk.

### 3.1 `GET /api/agent/suppression`

```json
{
  "mode": "full",
  "generated_at": "2026-10-24T05:20:11.093Z",
  "salt_id": "8254c329",
  "rule": "hmac-sha256(secret, last9digits) hex[0:20]",
  "entries": [{ "h": "2ea6869e504cebca50f0", "kind": "client", "at": "2026-10-24T05:16:13.981Z" }],
  "next": null
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
  purpose); `lost` — a lead on a `lost` stage whose `lost_reason`, trimmed,
  whitespace-collapsed and lower-cased, equals one of the labels in the setting
  `agent_no_contact_reasons` (`;`-separated, compared the same way).
- `at`: when the row last moved — a client card's `max(created_at,
  updated_at)`, a lead's `max(closed_at, updated_at)`.
- Not deduplicated: two cards on one phone are two entries with one `h`;
  upsert on `(kind, h)`.
- **A delta cannot express a deletion**, and a label ADDED to the setting brings
  its old leads in with their old `at` — the nightly full pull is the truth,
  the hourly delta an optimisation. A lead revived out of `lost`, a phone
  removed from a card or a label taken off the list simply stops appearing.
- Tails shorter than nine digits never appear and never match.

### 3.2 `GET /api/agent/outcomes`

```json
{
  "generated_at": "2026-10-24T05:20:11.093Z",
  "rows": [
    {
      "external_id": "cs:0b9…:202610", "intake_id": "…", "outcome": "created", "reason": null,
      "lead_id": "…", "client_id": null, "stage_kind": "open", "stage_name": "Yangi",
      "lost_reason": null, "closed_at": null, "contacted_at": "2026-10-24T06:02:00.000Z",
      "contact_kind": "call", "quoted_volume_m3": 2, "at": "2026-10-24T06:02:00.000Z"
    }
  ],
  "next": null
}
```

Exactly these 14 fields, nothing else:

| Field | Meaning |
|---|---|
| `external_id`, `intake_id` | the push and its ledger row |
| `outcome` | `created` / `joined` / `client` / `dropped` |
| `reason` | for `dropped`: `suppressed` / `capped` / `no_contact` (null otherwise) |
| `lead_id` | the lead it became or joined (null when dropped or `client`) |
| `client_id` | the lead's client once won, or the client it was recognised as |
| `stage_kind`, `stage_name` | the lead's stage now: `open` / `won` / `lost`, and the owner's name for it |
| `lost_reason` | the TEXT chosen at the move (≤ 200 chars) — the dictionary label once the owner keeps one, a seller's free text before that |
| `closed_at` | when the lead was decided |
| `contacted_at`, `contact_kind` | the FIRST contact after the arrival: `call` / `telegram` / `note` / `stage` / `followup` |
| `quoted_volume_m3` | the lead's kub (number) |
| `at` | when the row last moved: `max(arrival, first contact, any change on the lead, its decision)` |

- Rows: `channel = 'webhook'`, `external_id LIKE 'cs:%'`, arrived within the
  last **year**, from the `agent` source — **or** from «Boshqa» (`other`)
  with `ref.utm_source = 'clientscrapper'` (the fallback months, §6).
- Order and cursor: `(at, intake_id)`. Once a cursor is held the agent may
  read by cursor alone. One gap is known: `contacted_at` is the EVIDENCE's
  time, and a calls-app log uploads up to ~30 minutes late, so a contact
  stamped after a read can carry an `at` older than that read's last row.
  A weekly re-read with `since = now − 30 days` (and no cursor) closes it.
- `outcome = joined` reports the stage of a lead somebody else was already
  working; `client` appears only through the fallback door (the agent's own
  door suppresses client phones first).
- Never: a name, a phone, a note, an owner, a price.

## 4. Privacy

What leaves the ERP is hashes of phone tails, ids, stage names, the lost
reason's text, timestamps and a kub figure. No name, phone, note, owner or
money. The agent compares its own candidates' hashed tails against the
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
- A free-text lost reason (before the dictionary exists) may say anything a
  seller typed; it is clipped, not scrubbed.

## 6. Before this door existed — the «Boshqa» fallback

The agent may push through `POST /api/leads/in/other` with the «Boshqa» door's
key and `utm_source: clientscrapper` in the body. Those arrivals are reported
by the outcomes feed (the `other` + `utm_source` clause) once this branch is
deployed, but they are ordinary arrivals: no belt, and the owner's 15-minute
reminder DOES fire for them. **Never re-push an `external_id` after switching
the source to `agent`:** the channel is the same (`webhook`), so the second
push is a replay and lands nothing.
