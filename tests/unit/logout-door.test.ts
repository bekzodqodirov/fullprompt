import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Where a person signs out (owner: «logoutni profil ichiga kirgaz»).
 *
 * Source-shape, in the `card-facts` / `chat-controls` tradition: both
 * arrangements WORK, so nothing about behaviour can tell them apart, and the
 * app-bar button is the kind of control that comes back the next time somebody
 * wants it one tap closer.
 */
describe('the door out of the app', () => {
  const layout = readFileSync('src/app/(protected)/layout.tsx', 'utf8');
  const profile = readFileSync('src/app/(protected)/profile/page.tsx', 'utf8');

  it('is not in the app bar', () => {
    expect(layout).not.toContain('logoutAction');
  });

  it('is on the profile page', () => {
    expect(profile).toContain('logoutAction');
    expect(profile).toContain('data-testid="profile-logout"');
  });

  it('says it in words that already exist in every locale', () => {
    // `nav.logout` was the app bar's aria-label and is in all four bundles.
    // A second key for the same button is how one locale ends up without it
    // and every screen in that language throws at RENDER time (#163).
    expect(profile).toContain("tNav('logout')");
  });

  it('cannot be taken down by a panel further down the page', () => {
    // This page is now the ONLY way out, so the sections under the name are
    // loaded defensively — see the comment there.
    expect(profile).toContain('const panel = async');
    for (const load of [
      'listSessions(user.id)',
      'telegramLinkStatus(user.id)',
      'callDevicesFor(user.id)',
      'currentCallsApk()',
    ]) {
      expect(profile).toContain(`panel(${load}`);
    }
  });
});
