import { describe, expect, it } from 'vitest';
import { editBazaPair } from '@/modules/wms/calc/baza-draft';

/**
 * The owner, 2026-10-06: «edinitsa izmereniyani o'zgartirib bo'lmayabti» —
 * a unit picked on its own snapped back, because the grid drafted the pair as
 * two updates and each cleaned itself away. These are the four rows the
 * investigation simulated against the old code; each one lost the pick there.
 */
const priced = { bazaValue: '20', bazaBasis: 'unit' };

describe('the baza pair drafts as ONE edit', () => {
  it('a unit picked alone on a priced row is kept, with the amount beside it', () => {
    expect(editBazaPair({}, 'bazaBasis', 'kg', priced)).toEqual({ bazaValue: '20', bazaBasis: 'kg' });
  });

  it('a unit picked before any baza is typed is kept', () => {
    expect(editBazaPair({}, 'bazaBasis', 'kg', { bazaValue: '', bazaBasis: 'unit' })).toEqual({
      bazaValue: '',
      bazaBasis: 'kg',
    });
  });

  it('a kg-law row switched to dona is kept', () => {
    expect(editBazaPair({}, 'bazaBasis', 'unit', { bazaValue: '0.7', bazaBasis: 'kg' })).toEqual({
      bazaValue: '0.7',
      bazaBasis: 'unit',
    });
  });

  it('typing the price after the pick keeps both halves', () => {
    const picked = editBazaPair({}, 'bazaBasis', 'kg', { bazaValue: '', bazaBasis: 'unit' });
    expect(editBazaPair(picked, 'bazaValue', '25', { bazaValue: '', bazaBasis: 'unit' })).toEqual({
      bazaValue: '25',
      bazaBasis: 'kg',
    });
  });

  it('the pair cleans only when BOTH halves equal what the server holds', () => {
    // Picking the stored unit back is no draft at all…
    const picked = editBazaPair({}, 'bazaBasis', 'kg', priced);
    expect(editBazaPair(picked, 'bazaBasis', 'unit', priced)).toEqual({});
    // …an amount typed back to the stored one is not either…
    expect(editBazaPair({ bazaValue: '21' }, 'bazaValue', '20', priced)).toEqual({});
    // …but a new amount with the stored unit is a draft of the amount alone.
    expect(editBazaPair({}, 'bazaValue', '21', priced)).toEqual({ bazaValue: '21' });
  });
});
