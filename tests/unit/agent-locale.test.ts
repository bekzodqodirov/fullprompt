import { describe, expect, it } from 'vitest';
import { detectLocale, dominantScript, scriptOf } from '@/modules/wms/agent/locale';

describe('detectLocale', () => {
  it('reads the six languages he answered for (his 13)', () => {
    expect(detectLocale('Assalomu alaykum, yukim qachon keladi?').locale).toBe('uz');
    expect(detectLocale("Bu yuk necha kub bo'ladi aka").locale).toBe('uz');
    expect(detectLocale('Ассалому алайкум, юким қачон келади?').locale).toBe('uz_cyrl');
    expect(detectLocale('Здравствуйте, сколько стоит доставка?').locale).toBe('ru');
    expect(detectLocale('Hello, how much is shipping from Yiwu?').locale).toBe('en');
    expect(detectLocale('سلام، قیمت حمل بار از چین چند است؟').locale).toBe('fa');
    expect(detectLocale('你好，运费多少钱？').locale).toBe('zh');
  });

  it('a Chinese line with a product code in Latin is still Chinese', () => {
    expect(detectLocale('GS777 的货什么时候到？').locale).toBe('zh');
  });

  it('a message that settles nothing keeps the conversation language and says it is unsure', () => {
    expect(detectLocale('ok', 'ru')).toEqual({ locale: 'ru', confident: false, script: 'latin' });
    expect(detectLocale('👍', 'fa')).toEqual({ locale: 'fa', confident: false, script: 'none' });
    expect(detectLocale('GS777', null)).toEqual({ locale: null, confident: false, script: 'latin' });
  });

  it('short Cyrillic in an Uzbek-Cyrillic conversation stays Uzbek', () => {
    expect(detectLocale('ок рахмат', 'uz_cyrl').locale).toBe('uz_cyrl');
    expect(detectLocale('ок', 'uz_cyrl').locale).toBe('uz_cyrl');
    expect(detectLocale('ок', 'ru').locale).toBe('ru');
  });

  it('every locale names the script its reply must be written in', () => {
    expect(scriptOf('fa')).toBe('arabic');
    expect(scriptOf('zh')).toBe('han');
    expect(scriptOf('uz_cyrl')).toBe('cyrillic');
    expect(scriptOf('en')).toBe('latin');
    expect(dominantScript('سلام GS777')).toBe('arabic');
  });
});
