import { describe, expect, it } from 'vitest';
import {
  markDuplicates,
  normalizeCode,
  normalizeName,
  normalizePhone,
  parseTsv,
} from '@/modules/platform/clients/import';

/**
 * The owner's real client sheet, with every awkward shape it actually
 * contains. This runs before the importer ever touches a database, because
 * an import that silently mangles 300 cards is far worse than one that
 * refuses a row and says why.
 */

describe('phone numbers as people actually type them', () => {
  it('turns every Uzbek spelling into the same number', () => {
    for (const raw of ['95 006 8212', '950068212', '95-006-82-12', ' 95 006 8212 ']) {
      expect(normalizePhone(raw).phone, raw).toBe('+998950068212');
    }
    // Already carrying the country code.
    expect(normalizePhone('998907267788').phone).toBe('+998907267788');
    expect(normalizePhone('998485035').phone).toBe('+998998485035');
  });

  it('keeps a Chinese mobile as a Chinese mobile', () => {
    expect(normalizePhone('13106263787').phone).toBe('+8613106263787');
  });

  it('refuses to invent the digits a spreadsheet cut off', () => {
    expect(normalizePhone('86 156...')).toEqual({ phone: null, warning: 'phone_truncated' });
  });

  it('treats the sheet’s placeholders as "no phone"', () => {
    for (const raw of ['', ' ', 'XXX', '-', 'x']) {
      expect(normalizePhone(raw).phone, JSON.stringify(raw)).toBeNull();
    }
  });

  it('flags a length nobody recognises instead of guessing a country', () => {
    // 8 digits — a real row in the sheet, one digit short of a UZ number.
    const short = normalizePhone('97669090');
    expect(short.phone).toBe('+97669090');
    expect(short.warning).toBe('phone_unusual');
  });
});

describe('codes that are not really codes', () => {
  it('accepts the markings the warehouse actually uses', () => {
    for (const [raw, expected] of [
      ['GS777', 'GS777'],
      ['gs232', 'GS232'],
      ['GSK17', 'GSK17'],
      ['85855', '85855'],
      ['kassa', 'KASSA'],
      ['erik odk', 'ERIKODK'],
      ['casato ', 'CASATO'],
    ] as const) {
      expect(normalizeCode(raw), raw).toEqual({ code: expected });
    }
  });

  it('refuses what the client_code constraint would refuse anyway', () => {
    // Cyrillic cannot survive `clients_code_upper_check` + the A-Z0-9 rule.
    expect(normalizeCode('аднаротка Б').error).toBe('code_format');
    expect(normalizeCode('').error).toBe('code_missing');
    expect(normalizeCode('THIS-IS-TOO-LONG').error).toBe('code_format');
  });
});

describe('rows the sheet left blank', () => {
  it('names a card after its code rather than leaving it blank', () => {
    expect(normalizeName('', 'GSK11')).toEqual({ name: 'GSK11', warning: 'name_missing' });
    expect(normalizeName('No Name', 'GS216')).toEqual({ name: 'GS216', warning: 'name_missing' });
    expect(normalizeName('-', 'GS254')).toEqual({ name: 'GS254', warning: 'name_missing' });
    expect(normalizeName('Baxodir', 'GS001')).toEqual({ name: 'Baxodir' });
  });
});

describe('the sheet as a whole', () => {
  const tsv = [
    'n\tname\tphone\tcode\tseller',
    "1\tBaxodir\t95 006 8212\tGS001\tхожакбар",
    '2\tShoxruz\t901242003\tGS3035\tхожакбар',
    '3\tbekhruz\t901242003\tGS3035\tхожакбар',
    '4\t\t\tаднаротка Б\tбекзод',
    '5\tkomil\t\tusmoon\tабдулбосит',
  ].join('\n');

  it('parses columns by header name, not by position', () => {
    const rows = parseTsv(tsv);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ code: 'GS001', name: 'Baxodir', phone: '+998950068212' });
    expect(rows[4]).toMatchObject({ code: 'USMOON', name: 'komil', phone: null });
  });

  it('keeps the first of a repeated code and reports the rest', () => {
    const rows = markDuplicates(parseTsv(tsv));
    expect(rows[1]!.error).toBeUndefined();
    expect(rows[2]!.error).toBe('duplicate_in_file');
    // The unimportable row is reported, not silently dropped.
    expect(rows[3]!.error).toBe('code_format');
  });

  it('reports the line number a human can find in the spreadsheet', () => {
    // Header is line 1, so the first data row is line 2.
    expect(parseTsv(tsv)[0]!.line).toBe(2);
  });
});
