import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { aiConfigured } from '@/modules/platform/ai/model';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { PageHeader } from '@/components/ui/page';
import { AiChat } from './chat';

/**
 * The assistant's screen. Open to every signed-in member of staff — the
 * SERVER decides what the assistant may do for them: the toolset is built
 * from this request's actor inside the action, so this page carries no gate
 * beyond the login. Unconfigured (no server key) says so honestly and offers
 * nothing, the same sentence CI proves (m9x's precedent — CI has no key).
 */
export default async function AiPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('assistant');

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-2xl">
      <PageHeader icon="sparkle" title={t('title')} />
      {!aiConfigured() ? (
        <p className="card text-sm text-ink-500" data-testid="ai-not-configured">
          {t('notConfigured')}
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-500">
            {isAnalyst(actor) ? t('introAnalyst') : t('intro')}
          </p>
          <AiChat />
        </>
      )}
    </div>
  );
}
