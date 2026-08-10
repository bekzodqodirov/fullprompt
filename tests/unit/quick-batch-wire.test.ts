import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The wire between «this warehouse may not start an unplanned truck» and the
 * three places that have to agree about it.
 *
 * A quick batch is a truck with NO plan — no agent verdict, no approved line
 * list, nothing for the customs paperwork to be built from. The owner asked
 * for it to be taken away from Kashgar, and the tempting way to do that is a
 * role grant: `batches.depart_close`, which is what the button reads. That
 * would have been wrong twice over — roles are shared, so Yiwu would lose it
 * too, and the same grant is what lets a warehouse DEPART and CLOSE a truck
 * at all.
 *
 * So it is a per-warehouse flag, and these are source-shape assertions in the
 * `payment-deal-wire` tradition: the FORM must post the field, the ACTION
 * must parse it, the SCREEN must filter on it, and the SERVICE must refuse it
 * anyway — a control that is only hidden is not a rule (#531).
 */
describe('quick loading can be taken away from one warehouse', () => {
  it('the warehouse form posts the flag, with the hidden off for an unticked box', () => {
    const form = readFileSync(
      'src/app/(protected)/admin/warehouses/warehouse-form.tsx',
      'utf8',
    );
    expect(form).toContain('name="allowsQuickBatch"');
    // #171, five appearances and counting: a browser sends nothing for an
    // unticked checkbox, so on a replace-all form the absence reads as "leave
    // it alone" unless something states the off.
    expect(form).toContain('<input type="hidden" name="allowsQuickBatch" value="off" />');
  });

  it('the warehouse action parses it', () => {
    const action = readFileSync('src/app/(protected)/admin/warehouses/actions.ts', 'utf8');
    expect(action).toContain("checkbox(formData, 'allowsQuickBatch'");
  });

  it('a warehouse created before the flag existed keeps quick loading', () => {
    // Default true in three places that must not disagree: the column, the
    // form's fallback for a warehouse row that predates it, and the action's
    // parse default.
    const sql = readFileSync(
      'src/modules/platform/db/migrations/0069_warehouse_quick_batch.sql',
      'utf8',
    );
    expect(sql).toContain('NOT NULL DEFAULT true');
    const action = readFileSync('src/app/(protected)/admin/warehouses/actions.ts', 'utf8');
    expect(action).toContain("checkbox(formData, 'allowsQuickBatch', true)");
    const form = readFileSync(
      'src/app/(protected)/admin/warehouses/warehouse-form.tsx',
      'utf8',
    );
    expect(form).toContain('initial ? initial.allowsQuickBatch : true');
  });

  it('the batches screen offers only origins that allow it', () => {
    const page = readFileSync('src/app/(protected)/batches/page.tsx', 'utf8');
    expect(page).toContain('wh.allowsQuickBatch');
  });

  it('the service refuses it too — a hidden button is not a rule', () => {
    const action = readFileSync('src/app/(protected)/batches/batch-actions-server.ts', 'utf8');
    expect(action).toContain('if (!origin.allowsQuickBatch) return;');
  });
});
