-- The owner's Q3b (2026-09-25): «olib ketishga ruxsat berilishi kerak va agar
-- ruxsat berilmasa olib ketolmasin, taqiq tursin» — cargo with no price is
-- handed over only with a permission, in the debt approval's shape.
--
-- ONE approval row answers both questions the counter can ask (a debt, and
-- cartons with no price), because the operator presses one button and the
-- decider reads one message. The price half is a SNAPSHOT of CARTONS, like the
-- debt's ceiling: the boxes the decider was shown. A carton that lands later —
-- even of the same prixod — is a different question (#376's rule, one column
-- over). '[]' is «this request asked nothing about price», which is what every
-- row written before this migration means.
ALTER TABLE issue_approvals
  ADD COLUMN unpriced_box_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE issue_approvals
  ADD CONSTRAINT issue_approvals_unpriced_check CHECK (jsonb_typeof(unpriced_box_ids) = 'array');

-- The direct override at the counter, recorded on the handover beside
-- debt_ok — «narxsiz berishga ruxsat» by a holder standing there.
ALTER TABLE handovers ADD COLUMN price_ok boolean NOT NULL DEFAULT false;

-- The ban starts at THIS MOMENT — the deploy — and only for cargo that one of
-- our trucks brings into Uzbekistan from now on. Cargo already standing in
-- Tashkent and Andijan (including a truck unloaded this morning, before the
-- evening deploy) was never priced through the system by construction, and
-- gating it would stop the counter the next morning. It stays on the list
-- (his Q4 c). Written as a Tashkent-local instant with its offset, so an admin
-- reads it; /admin/settings refuses anything that is not a day or an instant,
-- and an empty value switches the ban off. `now()` inside drizzle's one
-- transaction is that transaction's start, i.e. the deploy.
INSERT INTO settings (key, value)
  VALUES ('unpriced_gate_since',
          to_jsonb(to_char(now() AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:00'))
  ON CONFLICT (key) DO NOTHING;
