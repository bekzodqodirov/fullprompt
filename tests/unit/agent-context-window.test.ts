import { describe, expect, it, vi } from 'vitest';
import { chatWindows, type AgentContext, type ChatMessage } from '@/modules/wms/agent/context';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { chatBlock, OLDER_CHAT_HEADING } from '@/modules/wms/agent/prompt';
import { validateActions, type ComposeReply } from '@/modules/wms/agent/run';

/**
 * The two windows of his «30 ta emas 100 tagacha» (2026-11-10, #1622): the
 * MODEL reads up to a hundred messages, every RULE counts the window the
 * policy corpora were measured on. The oracle for «the rules' window did not
 * move» is the context's own pre-#1622 loop, copied below VERBATIM — not
 * the code under test restated.
 */

const BASE = Date.UTC(2026, 10, 10, 6, 0, 0);

function msg(n: number, body: string, direction: 'in' | 'out' = n % 2 ? 'in' : 'out', at = new Date(BASE + n * 60_000)): ChatMessage {
  return {
    ref: '',
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tgMessageId: BigInt(n),
    direction,
    body,
    media: null,
    fileName: null,
    sentAt: at,
    autoSent: false,
    editedAt: null,
  };
}

/** Deterministic bodies of every size the context meets: a greeting, a question, a long quote, a clipped wall. */
function bodies(count: number, seed: number): string[] {
  const sizes = [4, 37, 180, 420, 700, 1001, 12, 260];
  return Array.from({ length: count }, (_, i) => {
    const size = sizes[(i * 7 + seed) % sizes.length]!;
    return `m${i}:${'x'.repeat(Math.max(0, size - String(i).length - 2))}`;
  });
}

/**
 * The context's window before #1622, verbatim from `chatMessages`: the query
 * took the newest `contextMessages` rows, then the loop below kept the newest
 * under `contextTotalChars`. `rowsOldestFirst` is what `rows.reverse()` held.
 */
function oldWindow(rowsOldestFirst: readonly ChatMessage[]): ChatMessage[] {
  const rows = rowsOldestFirst.slice(-AGENT_LIMITS.contextMessages);
  let total = 0;
  const out: ChatMessage[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const body = r.body;
    if (total + body.length > AGENT_LIMITS.contextTotalChars && out.length > 0) break;
    total += body.length;
    out.unshift({ ...r, ref: '' });
  }
  out.forEach((m, i) => (m.ref = `#${i + 1}`));
  return out;
}

const strip = (ms: readonly ChatMessage[]) => ms.map(({ ref: _ref, ...rest }) => rest);

describe('the two windows (#1622)', () => {
  for (const count of [1, 10, 29, 30, 31, 40, 99, 100, 150]) {
    for (const seed of [0, 3, 5]) {
      it(`${count} messages (bodies ${seed}): the rules' window is exactly the old one, and the tail of the model's`, () => {
        const all = bodies(count, seed).map((b, i) => msg(i + 1, b));
        const newestFirst = [...all].reverse().slice(0, AGENT_LIMITS.historyMessages).map((m) => ({ ...m }));
        const { history, recent } = chatWindows(newestFirst);

        expect(strip(recent)).toEqual(strip(oldWindow(all)));
        // The tail of the model's window, by identity: one object per message, one numbering.
        expect(recent.every((m, i) => m === history[history.length - recent.length + i])).toBe(true);
        expect(history.map((m) => m.ref)).toEqual(history.map((_, i) => `#${i + 1}`));
        // The model's own budget: at most a hundred, under the characters unless one message alone is over.
        expect(history.length).toBeLessThanOrEqual(AGENT_LIMITS.historyMessages);
        const chars = history.reduce((s, m) => s + m.body.length, 0);
        if (history.length > 1) expect(chars).toBeLessThanOrEqual(AGENT_LIMITS.historyTotalChars);
        // Newest kept: the history ends on the chat's newest message.
        expect(history.at(-1)?.id).toBe(all.at(-1)?.id);
      });
    }
  }

  it('a hundred short messages are all read by the model; the rules still count thirty', () => {
    const all = Array.from({ length: 120 }, (_, i) => msg(i + 1, `xabar ${i + 1}`));
    const { history, recent } = chatWindows([...all].reverse());
    expect(history).toHaveLength(100);
    expect(history[0]!.body).toBe('xabar 21');
    expect(recent).toHaveLength(30);
    expect(recent[0]!.body).toBe('xabar 91');
    expect(recent[0]!.ref).toBe('#71');
  });

  it('one message longer than every budget is still read — the newest always is (money-11)', () => {
    const { history, recent } = chatWindows([msg(1, 'y'.repeat(30_000))]);
    expect(history).toHaveLength(1);
    expect(recent).toHaveLength(1);
  });
});

const identity: AgentContext['identity'] = {
  clientId: null,
  leadId: 'l',
  strength: 'lead',
  codes: [],
  customerName: 'Aziz',
  managerName: null,
  cargoAllowed: false,
};

function ctxOf(history: ChatMessage[], recent: ChatMessage[]): AgentContext {
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages: recent,
    history,
    anchor: recent.at(-1) ?? null,
    burst: recent.slice(-1),
    lastOut: null,
    lastQuote: null,
    identity,
    storedLocale: null,
    customerScript: 'latin',
    measures: [{ ref: 'w1', kind: 'weight', value: 1000, messageRef: recent.at(-1)!.ref }],
    openCalcs: [],
    ruleDecision: null,
  };
}

describe('what the model is told (#1622)', () => {
  const all = [
    msg(1, "Temir yo'l bilan qancha bo'ladi?", 'in'),
    msg(2, "Aniqlab aytaman", 'out'),
    ...Array.from({ length: 36 }, (_, i) => msg(i + 3, i % 2 ? 'Arzimaydi' : 'Rahmat', i % 2 ? 'out' : 'in')),
    msg(39, 'Yiwudan 1000 kg yuk bor', 'in'),
  ];
  const { history, recent } = chatWindows([...all].reverse());

  it('the older part comes first, under the heading that says it is background; the rules’ part under «Suhbat»', () => {
    const text = chatBlock(ctxOf(history, recent));
    const heading = text.indexOf(OLDER_CHAT_HEADING);
    const suhbat = text.indexOf('Suhbat (eski → yangi):');
    expect(heading).toBeGreaterThan(-1);
    expect(suhbat).toBeGreaterThan(heading);
    const rail = text.indexOf("Temir yo'l bilan qancha bo'ladi?");
    expect(rail).toBeGreaterThan(heading);
    expect(rail).toBeLessThan(suhbat);
    // One numbering over the whole chat: the older part ends where «Suhbat» begins.
    const olderCount = history.length - recent.length;
    expect(text).toContain(`#${olderCount} `);
    expect(text.slice(suhbat)).toContain(`#${olderCount + 1} `);
    expect(text.slice(heading, suhbat)).not.toContain(`#${olderCount + 1} `);
    expect(text.slice(suhbat)).toContain('Yiwudan 1000 kg yuk bor');
    expect(text).toContain(`Javob kerak bo'lgan xabar: #${history.length}`);
    // The measures the tools take are the recent window's — the stated one, cited by its own ref.
    expect(text).toContain(`w1 = 1000 kg (#${history.length})`);
  });

  it('a chat that fits the rules’ window reads exactly as before — no heading', () => {
    const short = all.slice(-5);
    const w = chatWindows([...short].reverse().map((m) => ({ ...m })));
    expect(w.history).toEqual(w.recent);
    const text = chatBlock(ctxOf(w.history, w.recent));
    expect(text).not.toContain(OLDER_CHAT_HEADING);
    expect(text).toContain('#1 Mijoz');
  });

  it('a line from another year carries its year — a hundred messages can span one', () => {
    const old = msg(1, 'Oldingi yilgi savol', 'in', new Date(Date.UTC(2025, 11, 30, 6, 0)));
    const rest = Array.from({ length: 31 }, (_, i) => msg(i + 2, `x${i}`, i % 2 ? 'out' : 'in', new Date(Date.UTC(2026, 0, 2, 6, i))));
    const w = chatWindows([old, ...rest].reverse());
    const text = chatBlock(ctxOf(w.history, w.recent));
    expect(text).toContain('#1 Mijoz 30.12.2025 11:00: Oldingi yilgi savol');
    expect(text).toMatch(/#32 \S+ 02\.01 11:30: /u);
  });
});

describe('citations reach what the model read (#1622)', () => {
  it('a calc_submit may cite a line from the older part; its figures still come from the checklist', () => {
    const all = Array.from({ length: 45 }, (_, i) => msg(i + 1, i === 0 ? "Kiyim-kechak, 3 xil model" : `x${i}`, i % 2 ? 'out' : 'in'));
    const { history, recent } = chatWindows([...all].reverse());
    const ctx = ctxOf(history, recent);
    const compose = {
      replyNeeded: true,
      replyText: 'Hisoblatishga yubordim',
      language: 'uz',
      glossUz: '',
      category: 'qualification',
      confidence: 0.9,
      needsOwner: false,
      ownerQuestion: '',
      nextStep: 'calc',
      actions: [{ type: 'calc_submit', section: 'podklyuch', citedMessageRefs: ['#1'] }],
      usedFactIds: [],
      citedMessageRefs: ['#1'],
    } as unknown as ComposeReply;
    const checklist = {
      section: 'podklyuch',
      complete: true,
      facts: { weightKg: 1200, volumeM3: 6, goods: [], fromCity: 'Yiwu', toCity: 'Toshkent' },
      fromOurWarehouse: false,
    };
    const res = validateActions(compose, ctx, [{ ok: true, text: '', sources: [], checklist } as never], new Date(BASE));
    const calc = res.actions.find((a) => a.type === 'calc_submit') as { citedMessageIds?: string[] } | undefined;
    expect(calc).toBeDefined();
    expect(calc?.citedMessageIds).toContain(all[0]!.id);
  });
});

const captured = vi.hoisted(() => [] as unknown[]);
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (args: unknown) => {
        captured.push(args);
        return { stop_reason: 'end_turn', content: [], usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return { default: Anthropic };
});

describe('the chat is cached once per run (#1622)', () => {
  it('a text block marked `cache` carries the breakpoint; an unmarked one goes out as it always did', async () => {
    const { realCallModel } = await import('@/modules/platform/ai/model');
    await realCallModel({
      model: 'm',
      system: 'tail',
      systemCached: 'head',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'chat', cache: true }] },
        { role: 'user', content: [{ type: 'text', text: 'plain' }] },
      ],
      tools: [],
      maxTokens: 10,
    });
    const args = captured.at(-1) as { messages: { content: Record<string, unknown>[] }[] };
    expect(args.messages[0]!.content[0]).toEqual({ type: 'text', text: 'chat', cache_control: { type: 'ephemeral' } });
    expect(args.messages[1]!.content[0]).toEqual({ type: 'text', text: 'plain' });
  });
});
