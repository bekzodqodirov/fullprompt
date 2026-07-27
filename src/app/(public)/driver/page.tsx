import { currentDriverApk } from '@/modules/wms/tracking/driver-apk';
import { qrSvg } from '@/modules/wms/labels/sheet';

/**
 * The page a driver actually lands on (owner: "1 link orqali skachat qilib
 * oladgan qilib ber").
 *
 * Opened with no login, in a warehouse yard, on a phone that is not ours. So:
 * one button, the install warning Android is about to show written out BEFORE
 * it appears, and a QR of this same page so the warehouse can put it on a
 * screen and the driver can point a camera at it instead of typing.
 *
 * Uzbek and Russian side by side rather than a language switcher — this is one
 * screen read once by somebody who will never come back to it, and a driver
 * hunting for a flag icon is a driver asking the warehouse for help.
 */
export const dynamic = 'force-dynamic';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function DriverDownloadPage() {
  const meta = await currentDriverApk();
  const qr = await qrSvg(`${process.env.APP_URL ?? ''}/driver`);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5">
      <header className="text-center">
        <h1 className="text-2xl font-bold">GSR Driver</h1>
        <p className="text-sm text-ink-500">Yuk kuzatuv ilovasi · Приложение отслеживания</p>
      </header>

      {meta ? (
        <>
          <a
            href="/driver/apk"
            className="btn btn-primary w-full justify-center py-4 text-base"
            data-testid="driver-download"
          >
            ⬇ Yuklab olish · Скачать
          </a>
          <p className="text-center text-xs text-ink-500" data-testid="driver-version">
            Versiya {meta.version} · {mb(meta.sizeBytes)} ·{' '}
            {new Date(meta.uploadedAt).toLocaleDateString('ru-RU')}
          </p>

          <section className="card space-y-2 text-sm">
            <h2 className="font-semibold">O&apos;rnatish · Установка</h2>
            <ol className="list-decimal space-y-1 pl-5 text-ink-500">
              <li>
                Yuklab olgach faylni oching.
                <br />
                Откройте загруженный файл.
              </li>
              <li>
                Android «noma&apos;lum manba» deb ogohlantiradi — bu normal, ilova do&apos;konda
                emas. «Baribir o&apos;rnatish»ni tanlang.
                <br />
                Android предупредит про «неизвестный источник» — это нормально. Выберите
                «Всё равно установить».
              </li>
              <li>
                Telefonda eski GSR Driver bo&apos;lsa — avval o&apos;chiring.
                <br />
                Если старый GSR Driver уже стоит — сначала удалите его.
              </li>
              <li>
                Ilovani oching va sklad xodimi bergan <b>6 belgili kodni</b> kiriting.
                <br />
                Откройте приложение и введите <b>6-значный код</b> от склада.
              </li>
            </ol>
          </section>

          {/* For the warehouse: put this page on a screen, let the driver's
              camera do the typing. */}
          <section className="card text-center">
            <p className="mb-2 text-xs text-ink-500">
              Telefon kamerasi bilan oching · Наведите камеру телефона
            </p>
            <div
              className="mx-auto w-40 [&>svg]:h-full [&>svg]:w-full"
              // Our own generated SVG from our own URL — no user input reaches it.
              dangerouslySetInnerHTML={{ __html: qr }}
            />
          </section>
        </>
      ) : (
        <p className="card text-center text-sm text-ink-500" data-testid="driver-none">
          Ilova hali yuklanmagan. Administrator <b>Admin → Haydovchi ilovasi</b> bo&apos;limidan
          yuklaydi.
          <br />
          Приложение ещё не загружено.
        </p>
      )}
    </main>
  );
}
