'use client';

import { useTranslations } from 'next-intl';
import { InlineField } from '@/components/inline-field';
import { patchClientFieldAction } from '../actions';

/**
 * The three things about a client that change without the card changing.
 *
 * A number gets a second line, a manager hands the account on, somebody
 * writes down what was agreed — and until now each of those meant scrolling
 * a six-field form and saving the whole record, which is also how a code or
 * a name gets changed by accident on the way past.
 *
 * The code and the name stay in that form on purpose: the code is this
 * client's identity on every label, every act and every payment.
 */
export function ClientFacts({
  clientId,
  editable,
  phones,
  notes,
  managerId,
  managerName,
  managers,
}: {
  clientId: string;
  editable: boolean;
  phones: string;
  notes: string;
  managerId: string;
  managerName: string;
  managers: { id: string; fullName: string }[];
}) {
  const t = useTranslations('clients');
  const save = (field: string) => (next: string) => patchClientFieldAction(clientId, field, next);

  return (
    <div className="card" data-testid="client-facts">
      <InlineField
        label={t('phones')}
        value={phones}
        editable={editable}
        testId="fact-client-phones"
        onSave={save('phones')}
      />
      <InlineField
        label={t('salesManager')}
        value={managerId}
        display={managerName}
        // The empty option is «nobody», which is a real answer here: a client
        // can sit unassigned, and a picker with no way back to that would make
        // the first pick permanent.
        options={[{ value: '', label: t('noManager') }, ...managers.map((row) => ({
          value: row.id,
          label: row.fullName,
        }))]}
        editable={editable}
        testId="fact-client-manager"
        onSave={save('salesManagerId')}
      />
      <InlineField
        label={t('notes')}
        value={notes}
        multiline
        editable={editable}
        testId="fact-client-notes"
        onSave={save('notes')}
      />
    </div>
  );
}
