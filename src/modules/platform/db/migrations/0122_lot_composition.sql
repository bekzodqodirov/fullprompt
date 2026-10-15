-- Lot tarkibi (the owner's 1c/2c/3b/4c/5a/6/7a/8a, 2026-10-01): a lot may
-- carry a paper composition — the goods its cartons hold, as the client's
-- packing list states them. The lot, its cartons, letter and stickers do not
-- change (nobody knows which carton is which, 2c); only the customs papers
-- and the agent file read these rows. One header per lot (the document, the
-- count it was stated against, the revision token), lines beneath it, and a
-- frozen copy per truck whose papers went to the agent (7a).
-- Not granted to gsr_ai_reader — 0080's allowlist denies a table no
-- migration names (0088's, 0106's precedent).

-- The revision TOKEN. A sequence and not a per-row counter: a clear deletes
-- the header, and a counter that restarts at 1 lets an editor still holding
-- the OLD composition's «1» overwrite a colleague's NEW «1» (ABA). A value
-- drawn from a sequence is never drawn twice.
CREATE SEQUENCE "lot_composition_rev_seq";
--> statement-breakpoint
CREATE TABLE "lot_compositions" (
  "lot_id" uuid PRIMARY KEY REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "attachment_id" uuid NOT NULL REFERENCES "attachments"("id"),
  "seen_box_count" integer NOT NULL,
  "rev" bigint NOT NULL DEFAULT nextval('lot_composition_rev_seq'),
  "saved_by" uuid NOT NULL REFERENCES "users"("id"),
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lot_compositions_seen_box_count_check" CHECK ("seen_box_count" > 0)
);
--> statement-breakpoint
ALTER SEQUENCE "lot_composition_rev_seq" OWNED BY "lot_compositions"."rev";
--> statement-breakpoint
-- deleteAttachment's FK check (and its `in_use` answer) reads by this column.
CREATE INDEX "lot_compositions_attachment_idx" ON "lot_compositions" ("attachment_id");
--> statement-breakpoint
CREATE TABLE "lot_composition_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lot_id" uuid NOT NULL REFERENCES "lot_compositions"("lot_id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "name" text NOT NULL,
  "pieces" integer,
  "cartons" integer,
  "weight_kg" numeric(12,3) NOT NULL,
  "volume_m3" numeric(12,4) NOT NULL,
  "tnved_code" text,
  CONSTRAINT "lot_composition_lines_seq_check" CHECK ("seq" BETWEEN 1 AND 20),
  CONSTRAINT "lot_composition_lines_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 200),
  CONSTRAINT "lot_composition_lines_pieces_check" CHECK ("pieces" IS NULL OR "pieces" > 0),
  CONSTRAINT "lot_composition_lines_cartons_check" CHECK ("cartons" IS NULL OR "cartons" > 0),
  CONSTRAINT "lot_composition_lines_kg_check" CHECK ("weight_kg" > 0 AND "weight_kg" <> 'NaN'::numeric),
  CONSTRAINT "lot_composition_lines_m3_check" CHECK ("volume_m3" > 0 AND "volume_m3" <> 'NaN'::numeric),
  CONSTRAINT "lot_composition_lines_tnved_check" CHECK ("tnved_code" IS NULL OR "tnved_code" ~ '^[0-9]{4,10}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lot_composition_lines_lot_seq_unique" ON "lot_composition_lines" ("lot_id", "seq");
--> statement-breakpoint
-- The papers a truck SENT (7a): written by the «hujjat yuborildi» tick for
-- every lot on the truck — `lines` NULL = the lot had no composition then, so
-- a composition stated later never rewrites a sent truck's invoice — and
-- deleted by the un-tick. `lines` is a copy, not a reference: the live lines
-- are replaced on every save. `segments` = the POSITIONS the truck's cartons
-- of the lot held in the lot's order at the tick ([[start, end), …]): a
-- split lot's lines are allocated cumulatively over its trucks, so without
-- them another truck of the lot departing first moved a sent truck's paper.
CREATE TABLE "batch_sent_compositions" (
  "batch_id" uuid NOT NULL REFERENCES "batches"("id") ON DELETE CASCADE,
  "lot_id" uuid NOT NULL REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "rev" bigint,
  "seen_box_count" integer,
  "lines" jsonb,
  "segments" jsonb,
  "frozen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "batch_sent_compositions_pk" PRIMARY KEY ("batch_id", "lot_id"),
  CONSTRAINT "batch_sent_compositions_shape_check" CHECK (
    ("rev" IS NULL) = ("lines" IS NULL) AND ("rev" IS NULL) = ("seen_box_count" IS NULL)
    AND ("lines" IS NULL OR jsonb_typeof("lines") = 'array')
  ),
  CONSTRAINT "batch_sent_compositions_segments_check" CHECK (
    "segments" IS NULL OR jsonb_typeof("segments") = 'array'
  )
);
--> statement-breakpoint
CREATE INDEX "batch_sent_compositions_lot_idx" ON "batch_sent_compositions" ("lot_id");
--> statement-breakpoint
-- The trucks already ticked «hujjat yuborildi» when this deploys: their
-- papers went to the agent with every lot as ONE row, so they are frozen as
-- exactly that — a row per lot with `lines` NULL — or the first composition
-- saved after the deploy would rewrite a sent truck's invoice while the
-- receipt card said it stays as sent (the review of the freeze). The tick is
-- routinely pressed on the road (the VED's queue is in_transit/arrived trucks
-- with no tick), which is his 3b's moment exactly. Membership is
-- `batchMemberFilter`'s two halves, as the tick's own copy reads it; no
-- positions (NULL), so these trucks keep their place in the order.
INSERT INTO "batch_sent_compositions" ("batch_id", "lot_id")
SELECT DISTINCT t.id, b.lot_id
  FROM "batches" t
  JOIN "boxes" b ON b.current_batch_id = t.id
 WHERE t.sent_to_agent_at IS NOT NULL AND t.status <> 'cancelled'
UNION
SELECT DISTINCT t.id, b.lot_id
  FROM "batches" t
  JOIN "box_movements" m ON m.ref_type = 'batch' AND m.cause = 'batch_departed' AND m.ref_id = t.id
  JOIN "boxes" b ON b.id = m.box_id
 WHERE t.sent_to_agent_at IS NOT NULL AND t.status <> 'cancelled'
ON CONFLICT DO NOTHING;
