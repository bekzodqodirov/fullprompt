-- Phase 1.5: ТНВЭД memory (owner's rule: AI is asked ONCE per product; every
-- confirmed name→code assignment is remembered and reused without the AI).
CREATE TABLE "tnved_assignments" (
  "id" uuid PRIMARY KEY,
  "product_key" text NOT NULL UNIQUE,
  "product_name_zh" text NOT NULL,
  "product_name_ru" text,
  "tnved_code" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "ai_reasoning" text,
  "assigned_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tnved_assignments_source_check" CHECK ("source" IN ('manual', 'ai'))
);
