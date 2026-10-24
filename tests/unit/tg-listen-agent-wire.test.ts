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

  it('a restriction pauses the account and gives the claim back, never failing it', () => {
    const branch = pump.slice(
      pump.indexOf("kind.kind === 'restricted'"),
      pump.indexOf("typeof seconds === 'number'", pump.indexOf("kind.kind === 'restricted'")),
    );
    expect(branch).toContain('accountRestricted(');
    // K4: the claim's own attempt is taken back with it — the account's trouble spends none of the reply's retries.
    expect(branch).toContain('giveClaimBack(job.id)');
    expect(branch, 'releaseClaim keeps the claim counted').not.toContain('releaseClaim(');
    expect(branch, 'no attempt is counted').not.toContain('markAttemptFailed');
    // The pause is committed FIRST: released before it, the row would be claimed again.
    expect(branch.indexOf('accountRestricted(')).toBeLessThan(branch.indexOf('giveClaimBack(job.id)'));
  });

  it('K22: a turn the slot would hold is not claimed at all — asked after the gate, before claimNext', () => {
    const between = pump.slice(pump.indexOf('if (!gate.ok) {'), pump.indexOf('claimNext('));
    const held = between.slice(between.indexOf('slotHold('));
    expect(between.indexOf('slotHold('), 'the slot’s own question, from the slot’s own memory').toBeGreaterThan(0);
    expect(held).toContain('restrictedAt: slotRestrictedAt');
    expect(held).toContain('floodUntil: floodWaitUntil');
    expect(held.slice(0, held.indexOf('return;') + 'return;'.length)).toMatch(/\)\s*\{\s*return;$/);
  });

  it('K22: the slot remembers a restriction only where 0136 can hold the pause that retires it', () => {
    const note = body('const noteSlotRestricted = () => {', 'const noteSlotFailure =');
    expect(note).toContain('if (tablesKnownReady) slotRestrictedAt = new Date();');
    // The one writer of the note: a person's send's failure and the agent's own both go through it.
    expect(source.match(/slotRestrictedAt = new Date\(\)/g)).toHaveLength(1);
    expect(body('const noteSlotFailure = (err: unknown) => {', 'const sendSlot = <T>')).toContain('noteSlotRestricted()');
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
    expect(noJob).toContain('startAgentTick(');
    // …and never once a human reply is on its way out.
    expect(afterClaim.slice(afterClaim.indexOf('try {'))).not.toMatch(/[aA]gentTick\(/);
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
    expect(held).toContain('agentUnsettled = { row, outcome, at: opts.at }');
  });

  it('caughtUp turns true only when the start-up catch-up has run', () => {
    const at = source.indexOf('caughtUp = true');
    expect(at).toBeGreaterThan(source.indexOf('await catchUp()'));
  });
});

/** One closure's body, from its declaration to the next one named. */
const body = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

describe('the send path’s review fixes, as wired', () => {
  it('S1: the gate reads the guard row on EVERY tick — a «Tekshirdim» takes effect at the next one', () => {
    const before = pump.slice(0, pump.indexOf('pumpGate('));
    expect(before).toContain('await readGuard(account.id)');
    // No memo between the row and the gate: the guard is read fresh each time the pump runs.
    expect(source).not.toMatch(/let\s+\w*[gG]uard\w*\s*[:=]/);
  });

  it('S7: a held outcome is replayed with the instant Telegram first gave it', () => {
    const settle = body('const settleAgentOutcome = async', 'const pullTick = async');
    expect(settle).toContain('applyAgentOutcome(row, outcome, alarmAccount, opts.at)');
    const tick = body('const agentTickBody = async', 'const crmReplied = async');
    expect(tick).toContain('at: agentUnsettled.at');
    // The pull's own flood is recorded at the instant it was seen, like every other.
    const pull = body('const pullTick = async', 'const agentTick = async');
    expect(pull).toMatch(/accountFlooded\(\s*alarmAccount,[\s\S]*?\bat,\s*\)/);
  });

  it('S8: while paused the tick calls Telegram for nothing; switched off, it takes no step', () => {
    const refused = pump.slice(pump.indexOf('if (!gate.ok) {'), pump.indexOf('claimNext('));
    // Telegram is withheld for the PAUSE — whatever the gate's first reason — and a step for any refusal.
    expect(refused).toContain('const paused = guard?.pausedAt != null;');
    expect(refused).toContain('startAgentTick({ pulls: !paused, telegram: !paused, steps: false })');
    const tick = body('const agentTickBody = async', 'const crmReplied = async');
    // The badge only when Telegram may be called.
    expect(tick.slice(0, tick.indexOf('badgesToRestore('))).toContain('if (telegram) {');
    // The verdict-only branch asks the verdict alone and returns before any step.
    const offline = tick.slice(tick.indexOf('if (!opts.steps || !opts.telegram) {'), tick.indexOf('runAgentStep('));
    expect(offline).toContain('agentSendVerdict(');
    expect(offline).toContain('return;');
    expect(offline).not.toContain('restoreBadge(');
    expect(offline).not.toContain('startPull(');
    expect(tick).toContain('if (opts.pulls && telegram) startPull()');
    // An outcome's owed badge waits for the clear rather than calling now.
    const settle = body('const settleAgentOutcome = async', 'const pullTick = async');
    expect(settle).toContain('if (report.markUnread && opts.telegram && !agentHeld())');
  });

  it('S9: a wait on the agent’s own read or cosmetic call holds the agent — the store’s clock, the pulls, the badges', () => {
    const settle = body('const settleAgentOutcome = async', 'const pullTick = async');
    expect(settle).toContain("outcome.kind === 'flooded' && !isSendFloodMethod(outcome.method)");
    expect(settle.indexOf('agentHoldUntil = laterOf(')).toBeLessThan(settle.indexOf('applyAgentOutcome('));
    expect(source).toContain('memoryFloodUntil: () => laterOf(floodWaitUntil, agentHoldUntil)');
    const start = body('const startPull = () => {', 'const pullTick = async');
    expect(start).toContain('agentHeld()');
    const pull = body('const pullTick = async', 'const agentTick = async');
    expect(pull).toContain('agentHoldUntil = laterOf(');
  });

  it('S10: every send to a chat goes through one slot that keeps the gap from the last SEND', () => {
    const slot = body('const sendSlot = <T>', 'const agentTg =');
    expect(slot).toContain('lastSendAt + MIN_SEND_GAP_MS - Date.now()');
    // Stamped after the call, thrown or not — a refused send was a call too.
    expect(slot.indexOf('finally {')).toBeLessThan(slot.indexOf('lastSendAt = Date.now()'));
    expect(slot).toContain('sendTail.then(run, run)');
    // The agent's reply, through its turn of the slot…
    const turn = body('const agentTurn: SendTurn = async', 'const restoreBadge = async');
    expect(turn).toContain('await sendSlot(turn, async () => {');
    const tick = body('const agentTickBody = async', 'const crmReplied = async');
    expect(tick).toContain('sendTurn: agentTurn');
    // …and both of the human queue's sends, each naming its chat.
    expect(pump).toContain('sendSlot({ peerId: job.peerId, headAt: null }, () =>\n          client.sendFile(');
    expect(pump).toContain('sendSlot({ peerId: job.peerId, headAt: null }, () =>\n          client.sendMessage(target');
    expect(pump.match(/client\.send(?:Message|File)\(/g)).toHaveLength(2);
    expect(tick).toContain('tg: agentTg');
  });

  it('S12 follow-up: a send that queued for the slot is asked again when its turn comes, before the call', () => {
    const slot = body('const sendSlot = <T>', 'const agentTg =');
    // After the gap's sleep, before the work — a hold makes no call at all.
    expect(slot.indexOf('setTimeout(resolve, wait)')).toBeLessThan(slot.indexOf('slotHold('));
    expect(slot.indexOf('slotHold(')).toBeLessThan(slot.indexOf('if (hold) throw new SlotHeld('));
    expect(slot.indexOf('if (hold) throw new SlotHeld(')).toBeLessThan(slot.indexOf('return await work()'));
    // From what the sends ahead wrote: the send wait, the restriction, this chat's last send.
    expect(slot).toContain('floodUntil: floodWaitUntil');
    expect(slot).toContain('restrictedAt: slotRestrictedAt');
    expect(slot).toContain('peerSentAt.get(turn.peerId.toString())');
    // A failed send's meaning for the account is written INSIDE the slot, before the next turn is let through.
    expect(slot).toMatch(/catch \(err\) \{\s*noteSlotFailure\(err\);\s*throw err;\s*\} finally \{/);
    expect(slot.slice(slot.indexOf('finally {'))).toContain('peerSentAt.set(turn.peerId.toString(), lastSendAt)');
    const note = body('const noteSlotFailure = (err: unknown) => {', 'const sendSlot = <T>');
    expect(note).toContain("kind.kind === 'flood'");
    expect(note).toContain("kind.kind === 'restricted'");
  });

  it('S12 follow-up: the agent’s turn notes its own send’s answer inside the slot, and a held turn is a wait', () => {
    const turn = body('const agentTurn: SendTurn = async', 'const restoreBadge = async');
    const inside = turn.slice(turn.indexOf('await sendSlot(turn,'), turn.indexOf('} catch (err) {'));
    expect(inside).toContain("if (outcome.kind === 'flooded') noteSlotFlood(outcome.seconds)");
    expect(inside).toContain("outcome.error.kind === 'restricted') noteSlotRestricted()");
    expect(turn).toContain("if (err instanceof SlotHeld) return { kind: 'wait', nextStepAt: err.until, reason: err.reason }");
  });

  it('S12 follow-up: a person’s reply the slot held goes back to the queue — no attempt counted, nothing called', () => {
    const failed = pump.slice(pump.indexOf('} catch (err) {', pump.indexOf('sent += 1;')));
    const held = failed.slice(0, failed.indexOf('const message ='));
    expect(held).toContain('if (err instanceof SlotHeld) {');
    // K4: «no attempt counted» is made TRUE — claimNext counted one, and it is taken back.
    expect(held).toContain('giveClaimBack(job.id)');
    expect(held).not.toContain('releaseClaim(');
    expect(held).not.toContain('markAttemptFailed');
    // The guard row holding the pause retires the slot's own note of it, so «Tekshirdim» takes effect.
    const before = pump.slice(0, pump.indexOf('pumpGate('));
    expect(before).toContain('if (guard?.pausedAt) slotRestrictedAt = null;');
  });

  it('S11: a failed catch-up is tried again, a bounded number of times, and stop() cancels the retry', () => {
    const run = body('const runCatchUp = async', 'await runCatchUp();');
    expect(run).toContain('await catchUp();');
    expect(run.indexOf('await catchUp();')).toBeLessThan(run.indexOf('caughtUp = true'));
    expect(run).toContain('catchUpAttempts < CATCHUP_ATTEMPTS');
    expect(run).toContain('setTimeout(');
    expect(run).toContain('void runCatchUp()');
    const stop = body('const stop = async (', 'return stop;');
    expect(stop).toContain('clearTimeout(catchUpRetry)');
  });

  it('S12: the agent’s tick runs beside the human pump, single-flight, never awaited inside it', () => {
    expect(pump).not.toContain('await agentTick(');
    expect(pump).not.toContain('await startAgentTick(');
    const start = body('const startAgentTick = (', 'const crmReplied = async');
    expect(start).toContain('if (agentTicking) return;');
    expect(start).toContain('void agentTick(opts)');
    expect(start).toContain('agentTicking = false');
  });

  it('S13: a stranger is noted only on the agent owner’s account, only for their own line, never with its text', () => {
    const seen = body('const strangerSeen = async', 'const handleMessage = async');
    expect(seen).toContain('if (out || !peer.user) return;');
    expect(seen.indexOf('agentHere()')).toBeLessThan(seen.indexOf('noteStranger('));
    expect(seen).not.toMatch(/msg\.|message:|body:/);
    const handle = body('const handleMessage = async', 'const rethinkOnEdit = async');
    expect(handle).toContain("strangerSeen(peer, msg.out === true, 'ask')");
    expect(handle).toContain("if (verdict.reason === 'no_phone') await strangerSeen(peer, msg.out === true, 'no_phone')");
    // The live line, a pull and the site sweep all carry the user's flags; nothing else reads them.
    expect(source.match(/listenPeer\(await msg\.getChat\?\.\(\)\)/g)).toHaveLength(3);
  });
});

describe('Telegram’s own notice (his ⭐2, final review K33)', () => {
  it('the live handler asks it of every line, before the line is decided or stored', () => {
    const live = source.slice(source.indexOf('client.addEventHandler(async (event: { message?: unknown }) => {'), source.indexOf('new NewMessage({})'));
    const ask = live.indexOf('if (isTelegramServiceNotice(peer, msg.out === true)) await telegramNoticeSeen();');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(live.indexOf("handleMessage(peer, msg, 'live')"));
  });

  it('switches the agent off through the alarm’s one door, from fresh settings, and keeps nothing of the message', () => {
    // The closure alone: from its declaration to its own closing brace.
    const seen = body('const telegramNoticeSeen = async () => {', '\n  };\n');
    expect(seen.indexOf('tablesReady()'), 'one migration behind, there is no agent to switch off').toBeGreaterThan(0);
    expect(seen.indexOf('tablesReady()')).toBeLessThan(seen.indexOf('agentTelegramNotice(alarmAccount)'));
    // Not the half-minute cache: a notice just after the switch was flipped on must not slip through.
    expect(seen).not.toContain('agentConfigSoon');
    expect(seen).not.toContain('agentHere');
    // Nothing of the line: no text, no row, no tray candidate.
    expect(seen).not.toMatch(/msg\.|message:|body:|storeIncoming|recordCandidates/);
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
