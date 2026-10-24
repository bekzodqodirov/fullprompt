import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * How the listener is wired for the AI sotuvchi and for every account's ban
 * protection (spec §17.8-§17.9). The listener is a gramjs shell around pure
 * functions tested elsewhere, and its pump is a closure no test can import
 * (review build-3), so the ORDER of its calls is pinned here in the
 * outbox-settle-order tradition: each assertion names the defect it stops.
 */

const source = readFileSync('scripts/tg-listen.ts', 'utf8');
/** The pump's own body — from its declaration to the interval that drives it. */
const pump = source.slice(source.indexOf('const pump = async () => {'), source.indexOf('// One message per tick, deliberately.'));

describe('the pump asks the gate before every claim (ban-1)', () => {
  it('pumpGate, fed the guard row, comes before claimNext', () => {
    const gate = pump.indexOf('pumpGate(');
    const claim = pump.indexOf('claimNext(');
    expect(gate, 'the gate is asked').toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(0);
    expect(gate, 'before a human row is claimed').toBeLessThan(claim);
    expect(pump.slice(0, gate), 'the pause and the flood come from the guard row').toContain('readGuard(account.id)');
  });

  it('a refused gate returns before anything is claimed', () => {
    const refused = pump.slice(pump.indexOf('if (!gate.ok) {'), pump.indexOf('claimNext('));
    expect(refused).toContain('return;');
    // Only a switch or a pause lets the agent's verdict cancel; a flood wait stops everything.
    expect(refused).toContain("gate.reason !== 'flood_wait'");
  });

  it('a restriction pauses the account and releases the row, never failing it', () => {
    const branch = pump.slice(
      pump.indexOf("kind.kind === 'restricted'"),
      pump.indexOf("typeof seconds === 'number'", pump.indexOf("kind.kind === 'restricted'")),
    );
    expect(branch).toContain('accountRestricted(');
    expect(branch).toContain('releaseClaim(job.id)');
    expect(branch, 'no attempt is counted').not.toContain('markAttemptFailed');
    // The pause is committed FIRST: released before it, the row would be claimed again.
    expect(branch.indexOf('accountRestricted(')).toBeLessThan(branch.indexOf('releaseClaim(job.id)'));
  });

  it('a raised flood is persisted, uncapped, beside the in-memory clock', () => {
    const branch = pump.slice(pump.indexOf("typeof seconds === 'number'"), pump.indexOf('isPermanentSendError(message)'));
    expect(branch).toContain('accountFlooded(');
    expect(branch).toContain("source: 'raise'");
  });
});

describe('the agent pump runs after the human rows (§17.8)', () => {
  it('only when no human row was claimed this tick', () => {
    const afterClaim = pump.slice(pump.indexOf('claimNext('));
    const noJob = afterClaim.slice(afterClaim.indexOf('if (!job) {'), afterClaim.indexOf('try {'));
    expect(noJob).toContain('agentTick(');
    // …and never once a human reply is on its way out.
    expect(afterClaim.slice(afterClaim.indexOf('try {'))).not.toContain('agentTick(');
  });

  it('steps a row only through the pure step machine and the store', () => {
    const tick = source.slice(source.indexOf('const agentTick = async'), source.indexOf('const stampTick = async'));
    // A database one migration behind runs none of it (regression-3 b).
    expect(tick.indexOf('tablesReady()')).toBeLessThan(tick.indexOf('dueAgentRow('));
    expect(tick).toContain('dueAgentRow(');
    expect(tick).toContain('runAgentStep(');
    expect(tick).toContain('settleAgentOutcome(');
    // A held outcome is written before another row is touched.
    expect(tick.indexOf('agentUnsettled')).toBeLessThan(tick.indexOf('dueAgentRow('));
    // A chat left read with nothing sent gets its badge back before the next reply starts (regression-12).
    expect(tick.indexOf('badgesToRestore(')).toBeGreaterThan(0);
    expect(tick.indexOf('badgesToRestore(')).toBeLessThan(tick.indexOf('dueAgentRow('));
  });

  it('a one-peer pull never holds a person’s reply: it runs off the pump’s flight, one at a time', () => {
    const tick = source.slice(source.indexOf('const agentTickBody = async'), source.indexOf('const crmReplied = async'));
    expect(tick).toContain('startPull()');
    expect(tick).not.toContain('await pullTick()');
    const start = source.slice(source.indexOf('const startPull = () => {'), source.indexOf('const pullTick = async'));
    expect(start).toContain('if (pulling ||');
    expect(start).toContain('void pullTick()');
  });

  it('stamps the pump so the app can refuse ✅ into a listener that will never send (regression-3)', () => {
    expect(pump).toContain('stampTick()');
    expect(source).toContain('stampAgentPump(account.id, caughtUp)');
  });

  it('a CRM reply tells the worker he answered — after the send is booked, never inside its failure path', () => {
    const success = pump.slice(pump.indexOf('sent += 1;'), pump.indexOf('} catch (err) {', pump.indexOf('sent += 1;')));
    expect(success).toContain('void crmReplied(');
    expect(pump.slice(pump.indexOf('} catch (err) {', pump.indexOf('sent += 1;')))).not.toContain('crmReplied(');
  });

  it('a held agent outcome is only a database that is not there', () => {
    const settle = source.slice(source.indexOf('const settleAgentOutcome = async'), source.indexOf('const pullTick = async'));
    const held = settle.slice(settle.indexOf('catch (err)'));
    expect(held).toContain('isDbUnreachable(message)');
    expect(held).toContain('agentUnsettled = { row, outcome }');
  });

  it('caughtUp turns true only when the start-up catch-up has run', () => {
    const at = source.indexOf('caughtUp = true');
    expect(at).toBeGreaterThan(source.indexOf('await catchUp()'));
  });
});

describe('handleMessage knows how each message arrived (§17.3.1)', () => {
  const ORIGINS = ['live', 'catch_up', 'backfill', 'site_sweep', 'pull'];

  it('every call site passes an origin', () => {
    const calls = [...source.matchAll(/handleMessage\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]!);
    expect(calls.length, 'the live handler, the site sweep and the pull').toBeGreaterThanOrEqual(3);
    for (const args of calls) {
      const origin = /,\s*'([a-z_]+)'\s*$/.exec(args)?.[1];
      expect(origin, `handleMessage(${args})`).toBeDefined();
      expect(ORIGINS).toContain(origin);
    }
  });

  it('the live handler says live, the sweep says site_sweep — only a live line starts a run', () => {
    expect(source).toContain("handleMessage(peer, msg, 'live')");
    expect(source).toContain("handleMessage(peer, msg as never, 'site_sweep')");
    const hook = source.slice(source.indexOf('const afterStored = async'), source.indexOf('const handleMessage = async'));
    expect(hook).toContain('shouldStartAgentRun(');
    // The customer's robot is flagged before the job that reads the flag exists.
    expect(hook.indexOf('markAutoSent(')).toBeLessThan(hook.indexOf('enqueue<AgentInboundJob>('));
  });
});

describe('the client is built to be seen (ban-2, ban-12)', () => {
  it('the listener’s client records gramjs’s own flood sleeps', () => {
    const ctor = source.slice(source.indexOf('const client = new TelegramClient('), source.indexOf('const connected = await client.connect()'));
    expect(ctor).toContain('baseLogger: new FloodRecordingLogger(');
    expect(ctor).toContain('...TELEGRAM_DEVICE');
    // gramjs's own 60 s sleep stays (the DEVIATION): no threshold is set.
    expect(ctor).not.toContain('floodSleepThreshold');
  });

  it('deletes and typing are listened for', () => {
    expect(source).toContain('new Raw({ types: [Api.UpdateDeleteMessages] })');
    expect(source).toContain('new Raw({ types: [Api.UpdateUserTyping] })');
  });
});
