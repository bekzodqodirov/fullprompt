import { expect, type Page } from '@playwright/test';

/**
 * ⚡ Tezkor partiya, as a person makes one: pick the two warehouses, press
 * «Yaratish», read the in-page question («YW → Toshkent: yangi partiya
 * ochilsinmi?»), press «Ha, ochish» — and land on the new truck's card
 * (docs/NARX-VA-RAQAM.md §3.2.9, his 6a). ONE helper for every spec that opens
 * a quick batch, so the confirm is pressed the same way everywhere and a spec
 * cannot post the form behind the question.
 *
 * The form is a client component now, so a press or a pick that lands while
 * React is still hydrating can be swallowed or taken back (fold.ts's lesson):
 * the whole pick-and-ask is retried until the question is on screen AND names
 * the codes asked for (`data-origin` / `data-dest` — what the form will post).
 * «Ha, ochish» is the form's real submit: the action redirects to
 * `/batches/<id>`, as it always did.
 *
 * `origin`/`dest` are the warehouse CODES the selects show (their option
 * text); leave `origin` out for the single-warehouse form, whose origin is
 * fixed, and both out to take the form's defaults. Returns the card's URL.
 */
export async function createQuickBatch(page: Page, opts: { origin?: string; dest?: string } = {}): Promise<string> {
  await page.goto('/batches');
  const confirm = page.getByTestId('quick-batch-confirm');
  await expect(async () => {
    if (await confirm.isVisible()) await page.getByTestId('quick-batch-no').click();
    if (opts.origin) await page.locator('select[name="originId"]').selectOption({ label: opts.origin });
    if (opts.dest) await page.locator('select[name="destId"]').selectOption({ label: opts.dest });
    await page.getByTestId('create-quick-batch').click();
    await expect(confirm).toBeVisible({ timeout: 1_000 });
    if (opts.origin) await expect(confirm).toHaveAttribute('data-origin', opts.origin, { timeout: 500 });
    if (opts.dest) await expect(confirm).toHaveAttribute('data-dest', opts.dest, { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('quick-batch-yes').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  return page.url();
}
