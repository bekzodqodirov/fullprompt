/**
 * A short-lived signed address for one of this app's file routes
 * (`platform/auth/download-link.ts`), or the plain path when the server cannot
 * mint one (no key, offline, signed out) — which is what every download was
 * before links existed. For a file opened outside the page's own fetch: the
 * phone's download manager or a webview's new window carries no login cookie.
 */
export async function signedDownloadUrl(path: string): Promise<string> {
  try {
    const res = await fetch('/api/dl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return path;
    const body = (await res.json()) as { url?: unknown };
    return typeof body.url === 'string' ? body.url : path;
  } catch {
    return path;
  }
}

/**
 * Follow an address as a press would: a one-off anchor, marked so the layout's
 * download listener (`download-links.tsx`) lets its click through.
 * `downloadName` carries an original link's `download` attribute.
 */
export function followAddress(target: string, downloadName?: string | null): void {
  const link = document.createElement('a');
  link.href = target;
  link.setAttribute('data-dl-done', '');
  if (downloadName !== undefined && downloadName !== null) link.setAttribute('download', downloadName);
  link.rel = 'noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Download one of this app's files from a BUTTON (a file whose address is
 * decided at the press — the invoice with its merge answers): the signed
 * address first, then follow it. A link with an `href` needs none of this —
 * the layout's listener already takes its press.
 */
export async function followDownload(path: string): Promise<void> {
  followAddress(await signedDownloadUrl(path));
}
