-- VED module, phase A (docs/VED.md): the calc request stops being «please
-- price this card» and becomes a JOB — a consignment with its own section,
-- route, weight, volume, goods and materials, standing in one queue with a
-- clock on it.
--
-- Round 28 built the clock (0052) and rounds 46/84 deleted its doors; the
-- TABLE survived with real rows. Everything below is additive except two
-- relaxations and one dropped index, each with its reason.

-- (1) The queue owns assignment now, not the seller. A request is auto-
--     assigned to whichever VED person is carrying the fewest open ones, and
--     the task is minted for THAT person — but when nobody holds `ved.docs`
--     there is no assignee and no task to point at, and a request that
--     cannot be assigned must still be recorded. Both columns become
--     nullable so «nobody has taken it» is a state the schema can hold.
ALTER TABLE calc_requests ALTER COLUMN assignee_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE calc_requests ALTER COLUMN task_id DROP NOT NULL;

-- (2) One open request per CARD was right when a request meant «price this
--     deal» and is wrong now that it carries a consignment. The live landing
--     rule sends every repeat client to their newest OPEN deal, so keeping
--     the index would merge Monday's monitors with Thursday's chairs into
--     one row — and the freight band is computed from TOTAL kg ÷ TOTAL m³,
--     so the merge would silently misprice both (the design review's first
--     finding). A card may now carry several open requests; each is a job.
DROP INDEX IF EXISTS calc_requests_open_entity_idx;

-- (3) What the seller is actually asking for. Nullable on purpose: rows
--     written before this release never said, and a DEFAULT would make
--     every one of them claim to be a «podklyuch» job in next month's
--     breakdown (0084's rule — NULL reads «nobody has said»).
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS section text;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS from_city text;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS to_city text;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS weight_kg numeric(12,3);
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS volume_m3 numeric(12,3);
--> statement-breakpoint
-- Where the request came in: the card form or the Telegram bot. Nullable for
-- the same reason as `section`.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint

-- (4) The materials, as the seller sent them. ONE `crm_activity` note holds
--     the text and every file (the bot's #180 pre-binding, reused by the
--     card form), so the VED person and the card's lenta look at the same
--     artifact. A real FK, because a dangling uuid would render as a hole
--     nothing could catch; ON DELETE SET NULL rather than CASCADE — losing
--     the note must never delete the request that priced it.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS note_id uuid
  REFERENCES crm_activities(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Read by the attachment gate on every file render: a `ved.docs` holder may
-- open the materials of a request even when the note sits on a LEAD, which
-- their grants otherwise refuse. Without the index that is a seq scan per
-- photo.
CREATE INDEX IF NOT EXISTS calc_requests_note_idx ON calc_requests (note_id);
--> statement-breakpoint

-- (5) When the queue took it, and — when it comes back — why. A bounce-back
--     ENDS the request (the seller fixes and sends again), so it stamps
--     `completed_at` like any other ending; `completed_via = 'returned'` is
--     what tells the two apart. EVERY speed figure must therefore read
--     `completed_via <> 'returned'`, or a person who bounces everything back
--     in ninety seconds becomes the fastest calculator in the company.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS taken_at timestamptz;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS return_reason text;
--> statement-breakpoint

-- (6) The ANSWER. Phase B seals a full breakdown; phase A records the one
--     number the seller is waiting for, so a finished request is a record of
--     a question AND its answer rather than a database of questions.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS answer_amount numeric(14,2);
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS answer_currency text;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS answer_note text;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

-- (7) The owner's range is «1 dan 1000 tagacha tovar», and a request whose
--     goods live only in a PDF is an everyday case — so zero is legal and
--     the checklist flags it instead of the door refusing it.
ALTER TABLE calc_requests DROP CONSTRAINT IF EXISTS calc_requests_items_check;
--> statement-breakpoint
ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_items_check
  CHECK (item_count BETWEEN 0 AND 1000);
--> statement-breakpoint
ALTER TABLE calc_requests DROP CONSTRAINT IF EXISTS calc_requests_via_check;
--> statement-breakpoint
ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_via_check
  CHECK (completed_via IS NULL OR completed_via IN ('lines', 'task', 'returned'));
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_requests_section_check') THEN
    ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_section_check
      CHECK (section IS NULL OR section IN ('yolkira', 'rastamojka', 'podklyuch'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_requests_source_check') THEN
    ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_source_check
      CHECK (source IS NULL OR source IN ('card', 'bot'));
  END IF;
END $$;
--> statement-breakpoint

-- (8) The overdue sweep comes back to life in this release. Every request
--     still open from before round 46 is years past its deadline, so five
--     minutes after the deploy the owner and the sellers would be told about
--     year-old work. Stamping the flag says «already announced» and leaves
--     the rows themselves untouched for whoever wants to close them.
UPDATE calc_requests SET overdue_notified_at = now()
WHERE completed_at IS NULL AND overdue_notified_at IS NULL;
--> statement-breakpoint

-- (9) The goods, as the seller submitted them — the grain the client's own
--     invoice comes in. Phase B groups these by TNVED code; groups are a
--     layer over items and are born there, because making the AI's grouping
--     load-bearing at submit time would break law 1 (AI advises, never
--     decides). weight/volume/amount are here from day one because the
--     seller's spreadsheet already carries them (`goods-import.ts` parses
--     all three) and a column added in phase B is empty for every request
--     the owner reviews between now and then.
CREATE TABLE IF NOT EXISTS calc_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES calc_requests(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  name text NOT NULL,
  quantity numeric(12,3),
  unit text,
  weight_kg numeric(12,3),
  volume_m3 numeric(12,3),
  amount numeric(14,2),
  currency text,
  /** Filled from the TNVED memory at intake, before any model is asked. */
  tnved_code text,
  note text
);
--> statement-breakpoint
-- `seq` is the seller's own ordering and is stable for the life of the
-- request: phase B's grouping refers to items by position.
CREATE UNIQUE INDEX IF NOT EXISTS calc_request_items_seq_idx
  ON calc_request_items (request_id, seq);
