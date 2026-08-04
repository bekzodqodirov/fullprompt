/**
 * Which build is the SERVER on.
 *
 * The phone compares this with the build stamped into its own bundle. They
 * disagree exactly when the page in front of somebody is older than the code
 * on the server — which, with the app installed to a home screen, happens on
 * every deploy and is invisible: the operator taps a button that was fixed an
 * hour ago and nothing happens, and nobody can tell whether the deploy landed
 * or the phone is showing yesterday.
 *
 * Deliberately uncached and deliberately tiny: it is polled from every open
 * screen, and it must answer with the server's truth rather than with
 * whatever a proxy or a service worker kept.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(JSON.stringify({ build: process.env.NEXT_PUBLIC_BUILD_AT ?? '' }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}
