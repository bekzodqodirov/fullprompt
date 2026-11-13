import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { parseConfirmCallback } from '@/modules/platform/telegram/confirm-callback';
import { SETTING_DEFAULTS } from '@/modules/platform/settings/service';

/**
 * His answers of 2026-11-11 to the eight questions sent with the tarkib
 * suggestions — «4 ha … 8 ha … qolgan savollaringa javob o'zing bergan
 * taklifing bo'yicha» (docs/PRIXOD-XABARI.md, R1-R7).
 *
 * Two of them CHANGED the system (4 and 8) and are pinned where they were
 * built. The other six were the ⭐ already shipped — and «he agreed with the
 * default» is only true of the code that is on the server, so each was
 * checked against it first (#1229) and is named here: a default that drifts,
 * or a test that pinned it and was deleted, turns this file red with the
 * answer's own number.
 */
const read = (file: string) => readFileSync(file, 'utf8');
const hasTest = (file: string, title: string) => read(file).includes(title);

describe('the two answers that changed something', () => {
  it('4 = «ha»: the client confirms the name, the box count, the WEIGHT and the VOLUME — and the question says so', () => {
    for (const locale of ['uz', 'ru', 'en']) {
      const t = clientLabels(locale);
      expect(t.confirmAskLineFull).toMatch(/kg|кг/);
      expect(t.confirmAskLineFull).toMatch(/m³|м³/);
      expect(t.confirmThanksFull.length).toBeGreaterThan(t.confirmThanks.length);
    }
    expect(clientLabels('uz').confirmAskLineFull).toBe(
      '❓ Tovar nomi, quti soni, og‘irligi (kg) va hajmi (m³) to‘g‘rimi? Tekshirib, tasdiqlang.',
    );
    // Every question sent from now on, once the columns that remember the answer exist…
    expect(read('src/modules/wms/receipts/client-confirm.ts')).toContain(
      "const scope: AskScope = (await clientMeasuresReady()) ? 'full' : 'basic';",
    );
    // …and «urg'u»: the line is bold on the push.
    expect(read('src/modules/wms/notices/client-text.ts')).toContain("opts.ask === 'full' ? [b(h(t.confirmAskLineFull))]");
  });

  it('8 = «ha»: the machine’s bill is a line of the evening summary', () => {
    expect(read('src/modules/wms/reports/owner-summary-text.ts')).toContain('const ai = aiLine(f.ai, f.weekly);');
    expect(read('src/modules/wms/reports/owner-summary.ts')).toContain('aiSpend(aiWindow.from, aiWindow.to)');
  });
});

describe('the six ⭐ he left as they are', () => {
  it('1: the ✅ / ❌ row rides the «qabul qilindi» push by itself — the switch ships ON', () => {
    expect(SETTING_DEFAULTS.client_confirm_on_receipt).toBe(true);
  });

  it('2: the client’s ❌ outranks a colleague’s ✅', () => {
    expect(
      hasTest(
        'tests/integration/client-confirm.integration.test.ts',
        "it('❌ is a VETO: it takes the ✅ off a lot a colleague ticked AND off a lot whose tarkib stands",
      ),
    ).toBe(true);
  });

  it('3: a ❌ is told to the client’s seller and the planners (the logists and the admins)', () => {
    expect(
      hasTest(
        'tests/integration/client-confirm.integration.test.ts',
        "it('❌ to a question a person sent: the seller, the planners and the asker — each told once'",
      ),
    ).toBe(true);
    expect(read('src/modules/wms/receipts/client-confirm.ts')).toContain("await usersWithPermission('plans.manage')");
  });

  it('5: one ❌ is written on every lot of the message — the client is not asked «which lot?»', () => {
    const writer = read('src/modules/wms/receipts/client-confirm.ts');
    // The upsert runs over the lots the answer is written for, in ONE statement…
    expect(writer).toMatch(/\.values\(\s*writes\.map\(/);
    // …and the press names the PRIXOD and its tag — never a lot: there is no
    // «which lot?» step for a button to carry.
    expect(parseConfirmCallback('yt:0:0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d:5a0ae98c')).toEqual({
      verdict: 'no',
      receiptId: '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      tag: '5a0ae98c',
    });
  });

  it('6: a Chinese name on the paper gets the AI’s Russian name', () => {
    expect(
      hasTest('tests/unit/tarkib-proposal.test.ts', "it('2. another good takes the Russian wording when the model gave one, 3. else the paper’s own words'"),
    ).toBe(true);
  });

  it('7: 300 Bojxona 🤖 presses and 50 file readings a day', () => {
    expect(SETTING_DEFAULTS.tnved_ai_daily_limit).toBe(300);
    expect(SETTING_DEFAULTS.tarkib_ai_daily_limit).toBe(50);
  });
});
