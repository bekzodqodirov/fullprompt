import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The halves of 0126 (the owner's D2-D7) that live in a page, a client
 * screen or an action calling `authorize()`, and so cannot be pressed from an
 * integration test (#531 — a service-level test of a form-fed path proves the
 * service, not the system). The services' own refusals are proven in
 * debt-control.integration.test.ts. Comments stripped first (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? undefined : end);
};

const SCREEN = 'src/app/(protected)/issue/issue-screen.tsx';

describe('the counter screen asks why and posts it', () => {
  it('the confirm posts the reason and only a tick the screen still draws', () => {
    const call = between(read(SCREEN), 'await issueBoxesAction({', '});');
    expect(call).toMatch(/\bdebtNote,/);
    expect(call).toMatch(/debtOk: debtTicked\b/);
  });

  it('the tick and the reason live in the PAGE FLOW, before the fixed bar — a 360 px bar would hide the words', () => {
    const screen = read(SCREEN);
    expect(screen).toContain('data-testid="issue-debt-ok"');
    expect(screen).toContain('data-testid="issue-debt-note"');
    const bar = screen.indexOf('pb-safe fixed inset-x-0 bottom-0');
    expect(bar).toBeGreaterThan(0);
    expect(screen.indexOf('data-testid="issue-debt-ok"')).toBeLessThan(bar);
    expect(screen.indexOf('data-testid="issue-debt-note"')).toBeLessThan(bar);
  });

  it('the fixed bar says when it is the DEBT that keeps «Topshirish» grey, and pays for the line below the last lot (DEBT-2)', () => {
    const screen = read(SCREEN);
    const bar = screen.indexOf('pb-safe fixed inset-x-0 bottom-0');
    const hint = screen.indexOf('data-testid="issue-debt-hint"');
    // In the bar, directly above the button it explains — and a BUTTON that takes the person there.
    expect(hint).toBeGreaterThan(bar);
    expect(hint).toBeLessThan(screen.indexOf('data-testid="confirm-issue"'));
    expect(between(screen, '{barHintShown && (', 'data-testid="issue-debt-hint"')).toContain('type="button"');
    expect(screen).toContain('onClick={goToDebt}');
    // Unticked with nothing recorded to answer the DEBT (never the whole press —
    // a price-only grey must not ask for a debt release), or ticked with no reason yet.
    expect(screen).toContain('const debtCovered = covers({ debtUsd: blockingDebt, boxIds: [] });');
    expect(screen).toContain(
      "debtTickShown && ((debtOk && debtNote.trim() === '') || (!debtOk && !debtCovered));",
    );
    // Every line the bar grows by is paid for: the refusal, the hint, or both.
    expect(screen).toContain('const barLines = (error !== null ? 1 : 0) + (barHintShown ? 1 : 0);');
    expect(screen).toContain("const barPad = barLines === 2 ? 'pb-52' : barLines === 1 ? 'pb-40' : 'pb-28';");
    expect(screen).toContain('className={`space-y-3 ${barPad}`}');
  });

  it('the tick is drawn exactly where the server honours it, and a USED tick waits for its reason', () => {
    const screen = read(SCREEN);
    expect(screen).toContain('const debtTickShown = canOverrideDebt && blockingDebt > 0.009;');
    expect(screen).toContain('const debtTicked = debtTickShown && debtOk;');
    expect(screen).toContain('const needDebt = blockingDebt > 0.009 && !debtTicked;');
    const disabled = between(screen, 'data-testid="confirm-issue"', 'onClick={submit}');
    expect(disabled).toContain("debtTickShown && debtOk && debtNote.trim() === ''");
  });

  it('«Ruxsat so‘rash» asks for its reason and posts it (D5a)', () => {
    const screen = read(SCREEN);
    expect(screen).toContain('data-testid="ask-approval-note"');
    expect(between(screen, 'requestIssueApprovalAction({', '})')).toContain('note: askNote');
    expect(screen).toContain("disabled={asking || askNote.trim() === ''}");
  });

  it('every new refusal is a sentence (#472)', () => {
    const screen = read(SCREEN);
    const words = between(screen, 'const words: Record<string, string> = {', '};');
    expect(words).toContain('debt_note_required:');
    expect(words).toContain('server_behind:');
    expect(screen).toContain("result.error === 'note_required'");
  });
});

describe('the action and the route', () => {
  it('the counter action hands the whole actor to the service and catches a schema a release behind', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function issueBoxesAction', '\n}');
    expect(action).toContain('issueBoxes(parsed.data, { actorId: actor.id, ...meta }, actor)');
    expect(action).toContain("if (isServerBehind(err)) return { ok: false, error: 'server_behind' };");
  });

  it('the request action passes the reason through to the service’s own refusal', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function requestIssueApprovalAction', '\n}');
    expect(between(action, 'requestIssueApproval(', ')')).toMatch(/note: parsed\.data\.note \?\? ''/);
  });

  it('the list route draws the tick from the counter’s own predicate, about THIS client at THIS counter', () => {
    const route = read('src/app/api/issue/list/route.ts');
    expect(route).toContain(
      'counterDebtRelease(actor, { salesManagerId: owner?.salesManagerId ?? null }, query.data.warehouseId) !== null',
    );
    expect(route).not.toContain("has('finance.debt_override')");
  });
});

describe('the service', () => {
  const service = read('src/modules/wms/issue/service.ts');

  it('takes the reason in its schema — at most 500, the column’s CHECK', () => {
    expect(service).toContain("debtNote: z.string().trim().max(500).optional().or(z.literal('')),");
  });

  it('refuses in order: never a replay, then the right, then the reason, then the price', () => {
    const replay = service.indexOf('if (existing) {');
    const right = service.indexOf("throw new IssueError('debt_override_forbidden')");
    const note = service.indexOf("throw new IssueError('debt_note_required')");
    const price = service.indexOf("throw new IssueError('price_override_forbidden')");
    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(right);
    expect(right).toBeLessThan(note);
    expect(note).toBeLessThan(price);
  });

  it('the audience asks the ONE predicate with exactly the grants it reads', () => {
    const audience = between(service, 'export async function debtReleasedAudience', '\n}');
    expect(audience).toContain('receivesDebtReleased(');
    expect(audience).toContain('DEBT_RELEASED_GRANT_CODES');
  });

  it('the message is never swallowed in silence — the control that replaced the request must leave a log line', () => {
    const tail = between(service, 'await notifyDebtReleased({', '\n  }');
    expect(tail).toContain(".catch((err) => console.error('[debt-released]', result.handover.id, err))");
    expect(tail).not.toContain('.catch(() => {})');
  });
});

describe('the reason is shown where its readers are', () => {
  it('/approvals prints the request’s reason as its own wrapping line', () => {
    const page = read('src/app/(protected)/approvals/page.tsx');
    expect(page).toContain('data-testid="approval-request-note"');
    expect(page).toMatch(/whitespace-pre-wrap break-words[^"]*"\s+data-testid="approval-request-note"/);
  });

  it('the register prints it under the money, wrapping', () => {
    const page = read('src/app/(protected)/finance/qarzga-berilgan/page.tsx');
    expect(page).toMatch(/whitespace-pre-wrap break-words text-xs" data-testid="release-note"/);
    expect(page).toContain("const sight = companyMoneySight(actor);");
  });

  it('the lenta prints it only from the money door’s field, wrapping', () => {
    const feed = read('src/components/client-feed.tsx');
    expect(feed).toMatch(/whitespace-pre-wrap break-words text-xs" data-testid="feed-debt-note"/);
  });

  it('the profile draws the switch for exactly the audience, and re-posts a choice it hides (#171)', () => {
    const page = read('src/app/(protected)/profile/page.tsx');
    expect(page).toContain('name="mute_debt"');
    expect(page).toContain('receivesDebtReleased(actor)');
    expect(page).toContain('<input type="hidden" name="mute_debt" value="on" />');
  });
});
