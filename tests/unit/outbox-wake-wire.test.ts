import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTBOX_CHANNEL } from '@/modules/wms/crm/outbox';

/**
 * The knock between the web app and the Telegram listener.
 *
 * They are two processes, so nothing type-checks across the gap: a typo in
 * either channel name would be silent on BOTH ends — the app would notify
 * nobody, the listener would wait for a knock that never comes, and every
 * reply would still be delivered, three seconds slower, for ever. The only
 * way that stays fixed is one exported constant and a test that both sides
 * really use it.
 *
 * The listener itself cannot be tested here (it needs a live Telegram
 * connection), so this is source-shape in the `payment-deal-wire` tradition.
 */
describe('a queued reply wakes the sender', () => {
  it('the app notifies the shared channel', () => {
    const outbox = readFileSync('src/modules/wms/crm/outbox.ts', 'utf8');
    expect(outbox).toContain('pgClient.notify(OUTBOX_CHANNEL');
  });

  it('the listener listens on the same constant, not a copy of the string', () => {
    const listener = readFileSync('scripts/tg-listen.ts', 'utf8');
    expect(listener).toContain('pgClient.listen(OUTBOX_CHANNEL');
    expect(listener).toContain('OUTBOX_CHANNEL');
    // A literal would compile and drift. There must be exactly one spelling.
    expect(listener).not.toContain(`'${OUTBOX_CHANNEL}'`);
  });

  it('the pacing survives the knock — a minimum gap between sends stays', () => {
    const listener = readFileSync('scripts/tg-listen.ts', 'utf8');
    expect(listener).toContain('MIN_SEND_GAP_MS');
    // The poll is the floor underneath, and it must not be removed with the
    // knock: a listener that only ever reacts to NOTIFY loses everything
    // queued while it was down.
    expect(listener).toContain('}, 3000);');
  });

  it('a database that refuses the NOTIFY does not fail the reply', () => {
    const outbox = readFileSync('src/modules/wms/crm/outbox.ts', 'utf8');
    const at = outbox.indexOf('pgClient.notify(OUTBOX_CHANNEL');
    expect(outbox.slice(at - 200, at)).toContain('try {');
  });
});
