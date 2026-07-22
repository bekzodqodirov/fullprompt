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
  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 800 },
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
