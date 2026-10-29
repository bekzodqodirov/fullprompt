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
