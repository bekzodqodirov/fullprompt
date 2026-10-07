'use client';

import { useTranslations } from 'next-intl';
import type { ChangeField } from '@/modules/wms/calc/row-draft';

/**
 * The words a field is NAMED by in «boshqa kishi hozirgina o'zgartirdi:
 * Soni 40 → 42» and in the restore's «tiklanmadi» list — ONE literal map, so
 * the i18n fence sees every key (a key built at runtime is the shape #163
 * keeps finding). Deliberately NOT `calc.measure` («Soni / kg / m³», the
 * quantity column's header) nor `calc.basis` («Nimaga»): both name something
 * else on this screen.
 */
export function useFieldWord(): (field: ChangeField) => string {
  const t = useTranslations('calc');
  return (field) => {
    switch (field) {
      case 'name':
        return t('phone.name');
      case 'code':
        return t('phone.code');
      case 'qty':
        return t('phone.qty');
      case 'kg':
        return t('phone.kg');
      case 'm3':
        return t('phone.m3');
      case 'measure':
        return t('phone.measure');
      case 'baza':
        return t('phone.baza');
      case 'basis':
        return t('phone.basis');
      case 'note':
        return t('table.note');
    }
  };
}
