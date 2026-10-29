import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer a «Hisoblatish» lands for (round-2 review of docs/SAKKIZ-BAND.md,
 * C8/C9 and the typed package's prefix contract): the lead's NAME is one line,
 * and both readers of «who is the customer» are given the company's client-code
 * prefix. The landing itself is replaced — what is under test is what the
 * crossing HANDS it; the readers are the real ones, watched.
 */
const land = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-land', () => ({
  landIntake: land.fn,
  resolveIntakeClient: async () => null,
}));

const setting = vi.hoisted(() => ({ prefix: vi.fn<() => Promise<string>>() }));
vi.mock('@/modules/platform/settings/service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/settings/service')>();
  return {
    ...real,
    getSetting: async (key: string) =>
      key === 'client_code_prefix' ? setting.prefix() : real.SETTING_DEFAULTS[key as keyof typeof real.SETTING_DEFAULTS],
  };
});

const readers = vi.hoisted(() => ({ hint: vi.fn(), material: vi.fn() }));
vi.mock('@/modules/wms/calc/intake', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/intake')>();
  return {
    ...real,
    parseClientHint: (...args: Parameters<typeof real.parseClientHint>) => {
      readers.hint(...args);
      return real.parseClientHint(...args);
    },
  };
});
vi.mock('@/modules/wms/calc/intake-manual', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/intake-manual')>();
  return {
    ...real,
    looksLikeMaterial: (...args: Parameters<typeof real.looksLikeMaterial>) => {
      readers.material(...args);
      return real.looksLikeMaterial(...args);
    },
  };
});

import { endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { clientCodePrefix, landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import { readCustomerText } from '@/modules/platform/telegram/staff-handlers';

const chats: bigint[] = [];
let seq = 0;
function collected(clientHintRaw: string): bigint {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka');
  updateIntake(chatId, { clientHintRaw, stage: 'review' });
  return chatId;
}

beforeEach(() => {
  land.fn.mockReset();
  land.fn.mockResolvedValue({ kind: 'lead', id: 'L', label: 'L', leadOwnerId: null });
  readers.hint.mockReset();
  readers.material.mockReset();
  setting.prefix.mockReset();
  setting.prefix.mockResolvedValue('ZX');
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the lead is named on ONE line (round-2 review, C8)', () => {
  it('«Ali aka» over the phone: the name is «Ali aka», the phone goes to its own column', async () => {
    await landCollectedIntake(collected('Ali aka\n+998 90 123 45 67'), 'u1', 'Sotuvchi');
    const landed = land.fn.mock.calls[0]![0];
    expect(landed.leadName).toBe('Ali aka');
    expect(landed.leadName).not.toMatch(/\n|\d/);
    expect(landed.leadPhone).toBe('+998 90 123 45 67');
  });

  it('nothing typed is still «Hisoblatish (nomsiz)»', async () => {
    await landCollectedIntake(collected(''), 'u1', 'Sotuvchi');
    expect(land.fn.mock.calls[0]![0].leadName).toBe('Hisoblatish (nomsiz)');
  });
});

describe('both readers of «who is the customer» get the company’s code prefix (the typed package’s contract)', () => {
  it('the landing reads the hint with the setting’s prefix', async () => {
    await landCollectedIntake(collected('ZX777'), 'u1', 'Sotuvchi');
    expect(readers.hint).toHaveBeenCalledWith('ZX777', { prefix: 'ZX' });
  });

  it('the customer question asks both readers with the prefix it was given', async () => {
    await readCustomerText('Ali aka\n+998 90 123 45 67', 'ZX');
    expect(readers.material).toHaveBeenCalledWith('Ali aka\n+998 90 123 45 67', { prefix: 'ZX' });
    expect(readers.hint).toHaveBeenCalledWith('Ali aka\n+998 90 123 45 67', { prefix: 'ZX' });
  });

  it('the bot’s customer stage reads the setting once and hands it on', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/modules/platform/telegram/staff-handlers.ts'), 'utf8');
    expect(src).toContain('const read = await readCustomerText(ctx.message.text, await clientCodePrefix());');
    expect(src).toContain('const answer = clientAnswer(intake, ctx.message.text, read);');
  });

  it('an unreadable setting answers the shipped default, never an empty prefix', async () => {
    setting.prefix.mockRejectedValueOnce(new Error('connection refused'));
    expect(await clientCodePrefix()).toBe('GS');
    expect(await clientCodePrefix()).toBe('ZX');
  });
});
