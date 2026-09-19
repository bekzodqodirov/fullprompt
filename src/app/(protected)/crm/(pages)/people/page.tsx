import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { peopleWithCodes, suggestGroups } from '@/modules/wms/crm/people';
import { GroupButton } from './group-button';
import { PageHeader } from '@/components/ui/page';

/**
 * One human being, several client codes.
 *
 * The suggestions come first on purpose: with hundreds of cards nobody will
 * group them by hand, so the screen offers the pairs that share a phone and
 * the owner just confirms.
 */
export default async function PeoplePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');
  const tc = await getTranslations('common');

  // One query for the codes, not one per person (#432) — `peopleWithCodes`.
  const [people, suggestions] = await Promise.all([peopleWithCodes(), suggestGroups(25)]);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="users" title={t('people')} />
      <p className="text-xs text-ink-500">ℹ️ {t('personNote')}</p>

      {suggestions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase text-ink-500">🔍 {t('suggestions')}</h2>
          {suggestions.map((group) => (
            <div
              key={`${group.kind}:${group.phone}:${group.members[0]!.id}`}
              className="card flex flex-wrap items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm">{group.phone}</div>
                {/* A JOIN says whose group it is, because pressing it adds a
                    code to a person who already exists — which is also the
                    only way a code taken OUT of a group can be put back. */}
                {group.kind === 'join' && (
                  <div className="text-xs font-semibold text-ink-700">
                    → 👤 {group.personName}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 text-sm">
                  {group.members.map((member) => (
                    <span key={member.id} className="rounded bg-surface-sunken px-1.5 py-0.5">
                      <span className="font-mono font-bold text-brand-700">{member.code}</span>{' '}
                      {member.name}
                    </span>
                  ))}
                </div>
              </div>
              <GroupButton
                clientIds={group.members.map((member) => member.id)}
                defaultName={group.members[0]!.name}
                personId={group.kind === 'join' ? group.personId : undefined}
                personName={group.kind === 'join' ? group.personName : undefined}
              />
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-ink-500">👤 {t('people')}</h2>
        {people.map((person) => (
          <div key={person.id} className="card">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{person.name}</span>
              <span className="text-xs text-ink-500">
                {person.codes} {t('codes')}
              </span>
            </div>
            {Array.isArray(person.phones) && (person.phones as string[]).length > 0 && (
              <div className="font-mono text-xs text-ink-700">
                {(person.phones as string[]).join(' · ')}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-1.5 text-sm">
              {person.codeList.map((code) => (
                <Link
                  key={code.id}
                  href={`/admin/clients/${code.id}`}
                  className="rounded bg-brand-50 px-1.5 py-0.5 font-mono font-bold text-brand-700"
                >
                  {code.code}
                </Link>
              ))}
            </div>
          </div>
        ))}
        {people.length === 0 && <p className="card text-sm text-ink-500">{tc('empty')}</p>}
      </section>
    </div>
  );
}
