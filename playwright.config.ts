import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Some dev environments pre-install a Chromium at a fixed path; use it when
// present instead of downloading a version-pinned browser.
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath =
  !process.env.CI && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

// Mobile-first verification (spec §0): 360×800 viewport is the primary target.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // Specs share one DB, one letter sequencer, and the same seeded logins —
  // parallel workers cross-talk (rate limiter, interleaved letters).
  workers: 1,
  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  },
  projects: [
    {
      name: 'mobile-chromium',
      testIgnore: /\.desktop\.spec\.ts$/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 800 },
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
    {
      // The funnel has two shapes — one stage at a time on a phone, all the
      // columns with drag-and-drop from `md` up — so the second one needs a
      // viewport where it exists. Only *.desktop.spec.ts runs here.
      name: 'desktop-chromium',
      testMatch: /\.desktop\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        isMobile: false,
        hasTouch: false,
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    // Must be the standalone server: `next start` + output:'standalone' can
    // serve a broken client manifest for route-group pages (CI failure mode).
    command: 'pnpm start',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
