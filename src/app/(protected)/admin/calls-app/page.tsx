import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { currentCallsApk } from '@/modules/wms/calls/apk';
import { PublishForm } from './publish-form';

/**
 * Where the owner puts a new build of the calls app. The APK is produced by
 * CI (Actions → calls-apk); staff then download it from their own /profile —
 * no public page, unlike the driver's.
 */
export const dynamic = 'force-dynamic';

export default async function CallsAppPage() {
  // Own gate, not just the layout's (#198).
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) redirect('/');
  const meta = await currentCallsApk();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Qo&apos;ng&apos;iroq ilovasi</h1>

      <div className="card space-y-2">
        <h2 className="font-semibold">Hodimlar qanday o&apos;rnatadi</h2>
        <p className="text-sm text-ink-500">
          Har bir hodim o&apos;z telefonida <b>Profil → Qo&apos;ng&apos;iroq yozuvi</b> bo&apos;limini
          ochadi: ilovani o&apos;sha yerdan yuklab oladi, «Telefon qo&apos;shish» bilan kod olib
          ilovaga kiritadi. Kod kimniki bo&apos;lsa, qo&apos;ng&apos;iroqlar o&apos;shaning nomidan
          yoziladi.
        </p>
      </div>

      <div className="card space-y-2">
        <h2 className="font-semibold">Hozir chiqarilgan versiya</h2>
        {meta ? (
          <p className="text-sm" data-testid="calls-app-current">
            <b>{meta.version}</b> · {(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB ·{' '}
            {new Date(meta.uploadedAt).toLocaleString('ru-RU')}
          </p>
        ) : (
          <p className="text-sm text-ink-500" data-testid="calls-app-current">
            Hali hech narsa chiqarilmagan.
          </p>
        )}
      </div>

      <PublishForm />
    </div>
  );
}
