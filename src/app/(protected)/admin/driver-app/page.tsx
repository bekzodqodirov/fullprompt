import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { currentDriverApk } from '@/modules/wms/tracking/driver-apk';
import { publishDriverApkAction } from './actions';

/**
 * Where the owner puts a new build of the driver app.
 *
 * The APK is still produced by CI — nothing here builds Android. What changed
 * is the last mile: instead of every warehouse needing a GitHub account to
 * reach an artifact, one person downloads it once and publishes it, and from
 * then on `/driver` is a link anybody can send to anybody.
 */
export const dynamic = 'force-dynamic';

export default async function DriverAppPage() {
  // Own gate, not just the layout's (#198): admin is reachable by roles that
  // hold only FX or audit rights.
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) redirect('/');
  const meta = await currentDriverApk();
  const link = `${process.env.APP_URL ?? ''}/driver`;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Haydovchi ilovasi</h1>

      <div className="card space-y-2">
        <h2 className="font-semibold">Haydovchiga yuboriladigan havola</h2>
        <p className="break-all font-mono text-sm" data-testid="driver-link">
          {link || '— APP_URL sozlanmagan —'}
        </p>
        <p className="text-xs text-ink-500">
          Shu havolani haydovchiga Telegram orqali yuboring, yoki uni ekranda ochib QR kodini
          skanerlatib oling. Login talab qilinmaydi.
        </p>
      </div>

      <div className="card space-y-2">
        <h2 className="font-semibold">Hozir chiqarilgan versiya</h2>
        {meta ? (
          <p className="text-sm" data-testid="driver-current">
            <b>{meta.version}</b> · {(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB ·{' '}
            {new Date(meta.uploadedAt).toLocaleString('ru-RU')}
          </p>
        ) : (
          <p className="text-sm text-ink-500" data-testid="driver-current">
            Hali hech narsa chiqarilmagan.
          </p>
        )}
      </div>

      <form action={publishDriverApkAction} className="card space-y-3">
        <h2 className="font-semibold">Yangi versiya chiqarish</h2>
        <p className="text-xs text-ink-500">
          APK GitHub Actions → <b>driver-apk</b> ishidan yuklab olinadi, so&apos;ng shu yerga
          qo&apos;yiladi. Chiqarilgan zahoti havola yangi faylni beradi.
        </p>
        <div>
          <label className="label" htmlFor="driver-version">
            Versiya nomi
          </label>
          <input
            id="driver-version"
            name="version"
            className="input"
            placeholder="1.2"
            required
            maxLength={40}
          />
        </div>
        <div>
          <label className="label" htmlFor="driver-apk-file">
            APK fayl
          </label>
          <input
            id="driver-apk-file"
            name="apk"
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            className="input"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Chiqarish
        </button>
      </form>
    </div>
  );
}
