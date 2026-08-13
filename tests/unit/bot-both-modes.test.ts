import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCabinetText, startMenuFor } from '@/modules/platform/telegram/staff-bot';
import { CLIENT_LOCALES, allLabelVariants, clientLabels } from '@/modules/platform/telegram/client-labels';

/**
 * Round 100 (13A): one person, both staff and client.
 *
 * The cabinet's button labels ARE its router (#264), so the staff catch-all's
 * pass-through must derive from the same dictionary — a language added to the
 * keyboard joins the router in the same edit, or a Russian-speaking staff
 * member's cabinet breaks silently.
 */
describe('isCabinetText', () => {
  it('recognises every cabinet button in every language', () => {
    for (const key of ['btnCargo', 'btnBalance', 'btnHistory', 'btnLanguage'] as const) {
      for (const variant of allLabelVariants(key)) {
        expect(isCabinetText(variant), variant).toBe(true);
      }
    }
    // With surrounding whitespace too — a phone pastes what it pastes.
    expect(isCabinetText(` ${clientLabels('uz').btnCargo} `)).toBe(true);
  });

  it('leaves staff vocabulary and lookups alone', () => {
    expect(isCabinetText('GS777')).toBe(false);
    expect(isCabinetText('📋 Bugun')).toBe(false);
    expect(isCabinetText('YW26-000123')).toBe(false);
    expect(isCabinetText('')).toBe(false);
  });

  it('covers every locale the dictionary has — not a hardcoded three', () => {
    // The derivation is the safety: this counts, so a fifth locale cannot
    // silently ship buttons the router does not know.
    expect(allLabelVariants('btnCargo')).toHaveLength(CLIENT_LOCALES.length);
  });
});

describe('startMenuFor', () => {
  const staff = { id: 'u1', fullName: 'Hodim', locale: null };

  it('one answer per chat shape', () => {
    expect(startMenuFor(staff, 2)).toBe('both');
    expect(startMenuFor(staff, 0)).toBe('staff');
    expect(startMenuFor(null, 1)).toBe('cabinet');
    expect(startMenuFor(null, 0)).toBe('entry');
  });
});

describe('the wiring the shell cannot prove any other way (source shape)', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('the staff catch-all lets cabinet texts through BEFORE the task capture', () => {
    const s = read('src/modules/platform/telegram/staff-handlers.ts');
    const pass = s.indexOf('isCabinetText(ctx.message.text)');
    const capture = s.indexOf('takeTaskPending(chatId)');
    expect(pass).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    // Order is the guarantee: after the capture, a cabinet button pressed
    // while a «Bajarildi» answer is awaited would be eaten as the result.
    expect(pass).toBeLessThan(capture);
  });

  it('the /start deep link goes through linkStaffChat, never a raw UPDATE', () => {
    const s = read('src/modules/platform/telegram/bot.ts');
    expect(s).toContain('linkStaffChat(link.userId');
  });

  it('the three keyboard-bearing replies re-derive instead of naming a keyboard', () => {
    // Naming staffKeyboard()/cabinetKeyboard() in a reply REPLACES whatever
    // is on the phone — the both-chat's merged keyboard died on the first
    // language switch until these three asked the resolver.
    expect(read('src/modules/platform/telegram/staff-handlers.ts')).toContain(
      'await replyKeyboardFor(chatId)',
    );
    expect(read('src/modules/platform/telegram/client-cabinet.ts')).toContain(
      'replyKeyboardFor(BigInt(ctx.chat!.id), picked)',
    );
  });
});
