import { expect, type Locator } from '@playwright/test';

/**
 * Open a `<details>` fold and make sure it IS open.
 *
 * A press that lands while React is still hydrating the page is swallowed —
 * React holds a discrete event aimed at not-yet-hydrated content and replays
 * it to its own handlers only, so the browser's native toggle never happens.
 * Measured on /hodimlar: a press ~50 ms after hydration left the fold shut 18
 * times in 20. A person does not press that early; a test does, and more so
 * inside the full suite on a busy machine (m2 and m9zb retry for the same
 * reason). Pressing again blindly would CLOSE a fold the first press opened,
 * so the retry presses only while the fold is still shut.
 */
export async function openFold(fold: Locator) {
  const isOpen = () => fold.evaluate((el) => (el as HTMLDetailsElement).open);
  await expect(async () => {
    if (!(await isOpen())) await fold.locator(':scope > summary').click();
    expect(await isOpen()).toBe(true);
  }).toPass({ timeout: 15_000 });
}
